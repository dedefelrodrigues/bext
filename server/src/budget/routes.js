import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { budgetLines, categories, hashtags, subcategories, transactions } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { KINDS, buildStatement, drillRows } from './engine.js';
import { proposeStartingSet, regularity } from './propose.js';

export const budgetRouter = Router();
budgetRouter.use(requireAuth);

const KIND_SET = new Set(KINDS);

export function ownedLine(id, userId) {
  if (!Number.isInteger(id)) return null;
  return db.select().from(budgetLines).where(and(eq(budgetLines.id, id), eq(budgetLines.userId, userId))).get() ?? null;
}

function listLines(userId) {
  return db
    .select()
    .from(budgetLines)
    .where(eq(budgetLines.userId, userId))
    .all()
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.sortOrder - b.sortOrder || a.id - b.id)
    .map(({ id, name, kind, sortOrder }) => ({ id, name, kind, sortOrder }));
}

// `lineId` in a request body: null clears, anything else must be one of the
// user's lines. Returns { value } or { error }.
function lineParam(raw, userId) {
  if (raw === null || raw === '' || raw === undefined) return { value: null };
  const line = ownedLine(Number(raw), userId);
  return line ? { value: line.id } : { error: 'Budget line not found.' };
}

// --- Lines ----------------------------------------------------------------

budgetRouter.get('/lines', (req, res) => res.json(listLines(req.userId)));

budgetRouter.post('/lines', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const kind = String(req.body?.kind ?? '');
  if (!name) return res.status(400).json({ error: 'Name the line.' });
  if (!KIND_SET.has(kind)) return res.status(400).json({ error: 'Unknown kind.' });
  const last = listLines(req.userId).filter((l) => l.kind === kind).pop();
  const line = db
    .insert(budgetLines)
    .values({ userId: req.userId, name, kind, sortOrder: (last?.sortOrder ?? 0) + 1 })
    .returning()
    .get();
  res.status(201).json({ id: line.id, name: line.name, kind: line.kind, sortOrder: line.sortOrder });
});

budgetRouter.patch('/lines/:id', (req, res) => {
  const line = ownedLine(Number(req.params.id), req.userId);
  if (!line) return res.status(404).json({ error: 'Budget line not found.' });
  const patch = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name the line.' });
    patch.name = name;
  }
  if (req.body?.kind !== undefined) {
    if (!KIND_SET.has(String(req.body.kind))) return res.status(400).json({ error: 'Unknown kind.' });
    patch.kind = String(req.body.kind);
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });
  const updated = db.update(budgetLines).set(patch).where(eq(budgetLines.id, line.id)).returning().get();
  res.json({ id: updated.id, name: updated.name, kind: updated.kind, sortOrder: updated.sortOrder });
});

// Order within a kind: the ids in their new order.
budgetRouter.post('/lines/order', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  const owned = new Set(listLines(req.userId).map((l) => l.id));
  if (!ids.length || ids.some((id) => !owned.has(id))) return res.status(400).json({ error: 'Unknown line in the order.' });
  db.transaction((tx) => {
    ids.forEach((id, i) => tx.update(budgetLines).set({ sortOrder: i }).where(eq(budgetLines.id, id)).run());
  });
  res.json(listLines(req.userId));
});

// Deleting a line un-maps what pointed at it (the FKs say so too); those rows
// fall back to the next rule — usually Unassigned — rather than vanishing.
budgetRouter.delete('/lines/:id', (req, res) => {
  const line = ownedLine(Number(req.params.id), req.userId);
  if (!line) return res.status(404).json({ error: 'Budget line not found.' });
  db.transaction((tx) => {
    tx.update(categories).set({ budgetLineId: null }).where(eq(categories.budgetLineId, line.id)).run();
    tx.update(subcategories).set({ budgetLineId: null }).where(eq(subcategories.budgetLineId, line.id)).run();
    tx.update(hashtags).set({ budgetLineId: null, budgetOrder: 0 }).where(eq(hashtags.budgetLineId, line.id)).run();
    tx.update(transactions).set({ budgetLineId: null }).where(eq(transactions.budgetLineId, line.id)).run();
    tx.delete(budgetLines).where(eq(budgetLines.id, line.id)).run();
  });
  res.status(204).end();
});

// --- Setup: the mapping, with each category's regularity beside it ---------

budgetRouter.get('/setup', (req, res) => {
  const userId = req.userId;
  const { stats, months, currency } = regularity(userId, req.query.asOf);
  const cats = db.select().from(categories).where(eq(categories.userId, userId)).all();
  const subs = db.select().from(subcategories).where(eq(subcategories.userId, userId)).all();
  const tags = db.select().from(hashtags).where(eq(hashtags.userId, userId)).all();
  const byName = (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  res.json({
    lines: listLines(userId),
    statsMonths: months,
    currency,
    categories: cats.sort(byName).map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      isHidden: c.isHidden,
      lineId: c.budgetLineId,
      stats: stats.get(`cat:${c.id}`) ?? null,
      subcategories: subs
        .filter((s) => s.categoryId === c.id)
        .sort(byName)
        .map((s) => ({ id: s.id, name: s.name, icon: s.icon, lineId: s.budgetLineId, stats: stats.get(`sub:${s.id}`) ?? null })),
    })),
    hashtags: tags
      .map((t) => ({ id: t.id, name: t.name, lineId: t.budgetLineId, order: t.budgetOrder }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

// Map one category or subcategory to a line (null = unmapped; for a
// subcategory, null means "whatever its category says").
budgetRouter.put('/mapping', (req, res) => {
  const b = req.body ?? {};
  const line = lineParam(b.lineId, req.userId);
  if (line.error) return res.status(400).json({ error: line.error });
  if (b.subcategoryId != null) {
    const sub = db.select().from(subcategories).where(and(eq(subcategories.id, Number(b.subcategoryId)), eq(subcategories.userId, req.userId))).get();
    if (!sub) return res.status(404).json({ error: 'Subcategory not found.' });
    db.update(subcategories).set({ budgetLineId: line.value }).where(eq(subcategories.id, sub.id)).run();
  } else if (b.categoryId != null) {
    const cat = db.select().from(categories).where(and(eq(categories.id, Number(b.categoryId)), eq(categories.userId, req.userId))).get();
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    db.update(categories).set({ budgetLineId: line.value }).where(eq(categories.id, cat.id)).run();
  } else {
    return res.status(400).json({ error: 'Name a category or a subcategory.' });
  }
  res.json({ ok: true });
});

// The ordered list of hashtags that route their rows to a line. Replaces the
// whole list: the order is the tie-break when one row carries two of them.
budgetRouter.put('/hashtags', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'Send the list of hashtags.' });
  const owned = new Set(db.select({ id: hashtags.id }).from(hashtags).where(eq(hashtags.userId, req.userId)).all().map((t) => t.id));
  const parsed = [];
  for (const it of items) {
    const id = Number(it?.hashtagId);
    if (!owned.has(id)) return res.status(400).json({ error: 'Hashtag not found.' });
    const line = lineParam(it?.lineId, req.userId);
    if (line.error || line.value == null) return res.status(400).json({ error: 'Pick a line for every hashtag.' });
    parsed.push({ id, lineId: line.value });
  }
  if (new Set(parsed.map((p) => p.id)).size !== parsed.length) return res.status(400).json({ error: 'A hashtag is listed twice.' });
  db.transaction((tx) => {
    tx.update(hashtags).set({ budgetLineId: null, budgetOrder: 0 }).where(eq(hashtags.userId, req.userId)).run();
    parsed.forEach((p, i) => tx.update(hashtags).set({ budgetLineId: p.lineId, budgetOrder: i }).where(eq(hashtags.id, p.id)).run());
  });
  res.json({ ok: true });
});

// The proposed starting set. Without `reset` it only runs for a user with no
// lines yet (the page calls it on first open); `reset` throws the current
// lines, mappings, hashtag routes and pins away first.
budgetRouter.post('/propose', (req, res) => {
  const reset = req.body?.reset === true;
  if (!reset && listLines(req.userId).length > 0) return res.json({ created: 0, lines: listLines(req.userId) });
  const created = proposeStartingSet(req.userId, { reset, asOf: req.query.asOf });
  res.json({ created, lines: listLines(req.userId) });
});

// --- The statement and its drill-down ----------------------------------------

budgetRouter.get('/statement', (req, res) => {
  res.json({ ...buildStatement(req.userId, req.query), lineCount: listLines(req.userId).length });
});

budgetRouter.get('/rows', (req, res) => {
  if (!req.query.line) return res.status(400).json({ error: 'Name a line.' });
  res.json(drillRows(req.userId, req.query));
});

// For the Home tile: cheap counts only, no statement.
budgetRouter.get('/summary', (req, res) => {
  const userId = req.userId;
  const lines = listLines(userId);
  const cats = db.select({ id: categories.id, lineId: categories.budgetLineId, isHidden: categories.isHidden }).from(categories).where(eq(categories.userId, userId)).all();
  const open = cats.filter((c) => c.lineId == null && !c.isHidden).map((c) => c.id);
  // A category without a line is still placed if every subcategory has one.
  const subs = open.length
    ? db.select({ categoryId: subcategories.categoryId, lineId: subcategories.budgetLineId }).from(subcategories).where(inArray(subcategories.categoryId, open)).all()
    : [];
  const unmapped = open.filter((id) => {
    const own = subs.filter((s) => s.categoryId === id);
    return own.length === 0 || own.some((s) => s.lineId == null);
  }).length;
  res.json({ lineCount: lines.length, unmappedCategories: unmapped });
});
