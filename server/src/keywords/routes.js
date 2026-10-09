import { Router } from 'express';
import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { categories, keywords, subcategories, transactions } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { containerIds } from '../transactions/routes.js';
import { recomputeUser } from '../engine/recompute.js';
import { keywordsToCsv, parseKeywordCsv } from './csv.js';

const MAX_TEXT = 200;

// Validates keyword text, category/subcategory ownership + parentage, and the
// optional distance override. `partial` allows PATCH to omit fields.
// Returns { value } (a column patch) or { error, status }.
function parseKeyword(body, userId, partial) {
  const out = {};

  if (body?.text !== undefined || !partial) {
    const text = String(body?.text ?? '').trim();
    if (!text || text.length > MAX_TEXT) return { error: 'Keyword text is required (max 200 chars).' };
    out.text = text;
  }

  if (body?.categoryId !== undefined || !partial) {
    const categoryId = Number(body?.categoryId);
    if (!Number.isInteger(categoryId)) return { error: 'A category is required.' };
    const cat = db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
      .get();
    if (!cat) return { error: 'Category not found.', status: 404 };
    out.categoryId = categoryId;
  }

  if (body?.subcategoryId !== undefined) {
    if (body.subcategoryId === null || body.subcategoryId === '') {
      out.subcategoryId = null;
    } else {
      const subcategoryId = Number(body.subcategoryId);
      if (!Number.isInteger(subcategoryId)) return { error: 'Invalid subcategory.' };
      const sub = db
        .select({ id: subcategories.id, categoryId: subcategories.categoryId })
        .from(subcategories)
        .where(and(eq(subcategories.id, subcategoryId), eq(subcategories.userId, userId)))
        .get();
      if (!sub) return { error: 'Subcategory not found.', status: 404 };
      // The subcategory must belong to the (possibly newly chosen) category.
      const catId = out.categoryId;
      if (catId !== undefined && sub.categoryId !== catId) {
        return { error: 'Subcategory does not belong to the chosen category.' };
      }
      out.subcategoryId = subcategoryId;
    }
  }

  if (body?.distance !== undefined) {
    if (body.distance === null || body.distance === '') {
      out.distance = null;
    } else {
      const distance = Number(body.distance);
      if (!Number.isInteger(distance) || distance < 0) return { error: 'Distance must be a non-negative integer or blank.' };
      out.distance = distance;
    }
  }

  return { value: out };
}

// When a keyword's category is edited but its subcategory is not, ensure the
// existing subcategory still belongs to the new category (else detach it).
function reconcileSubcategory(patch, existing, userId) {
  if (patch.categoryId === undefined || patch.subcategoryId !== undefined) return;
  if (existing.subcategoryId == null) return;
  const sub = db
    .select({ categoryId: subcategories.categoryId })
    .from(subcategories)
    .where(and(eq(subcategories.id, existing.subcategoryId), eq(subcategories.userId, userId)))
    .get();
  if (!sub || sub.categoryId !== patch.categoryId) patch.subcategoryId = null;
}

function ownedKeyword(id, userId) {
  return db
    .select()
    .from(keywords)
    .where(and(eq(keywords.id, id), eq(keywords.userId, userId)))
    .get();
}

function publicKeyword(row) {
  return {
    id: row.id,
    text: row.text,
    categoryId: row.categoryId,
    subcategoryId: row.subcategoryId,
    distance: row.distance,
  };
}

export const keywordsRouter = Router();
keywordsRouter.use(requireAuth);

// --- CSV export / import (registered before /:id so literal paths win) ---

// Exports all of the user's keywords as CSV (`keyword,category,subcategory,
// distance`), resolving the category/subcategory ids to names.
keywordsRouter.get('/export', (req, res) => {
  const cats = db.select().from(categories).where(eq(categories.userId, req.userId)).all();
  const subs = db.select().from(subcategories).where(eq(subcategories.userId, req.userId)).all();
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const subName = new Map(subs.map((s) => [s.id, s.name]));

  const kws = db
    .select()
    .from(keywords)
    .where(eq(keywords.userId, req.userId))
    .orderBy(keywords.text)
    .all();

  const rows = kws.map((k) => ({
    keyword: k.text,
    category: catName.get(k.categoryId) ?? '',
    subcategory: k.subcategoryId == null ? '' : subName.get(k.subcategoryId) ?? '',
    distance: k.distance == null ? '' : k.distance,
  }));
  res.json({ csv: keywordsToCsv(rows) });
});

// Replaces the user's entire keyword set from an uploaded CSV. Categories and
// subcategories are matched by name against the user's existing tree (import
// does not create categories — manage those via the categories JSON import).
// Any unresolved name rejects the whole import so it stays all-or-nothing.
keywordsRouter.post('/import', (req, res) => {
  if (typeof req.body?.csv !== 'string') return res.status(400).json({ error: 'Body must be { csv: "..." }.' });

  const parsed = parseKeywordCsv(req.body.csv);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const cats = db.select().from(categories).where(eq(categories.userId, req.userId)).all();
  const subs = db.select().from(subcategories).where(eq(subcategories.userId, req.userId)).all();
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c]));
  // Subcategory lookup is keyed by (categoryId, lowercased name).
  const subByKey = new Map(subs.map((s) => [`${s.categoryId}:${s.name.toLowerCase()}`, s]));

  const resolved = [];
  for (const row of parsed.rows) {
    const cat = catByName.get(row.category.toLowerCase());
    if (!cat) return res.status(400).json({ error: `Unknown category "${row.category}". Import categories first.` });
    let subcategoryId = null;
    if (row.subcategory) {
      const sub = subByKey.get(`${cat.id}:${row.subcategory.toLowerCase()}`);
      if (!sub) return res.status(400).json({ error: `Unknown subcategory "${row.subcategory}" under "${row.category}".` });
      subcategoryId = sub.id;
    }
    resolved.push({ text: row.keyword, categoryId: cat.id, subcategoryId, distance: row.distance });
  }

  db.transaction(() => {
    db.delete(keywords).where(eq(keywords.userId, req.userId)).run();
    for (const r of resolved) {
      db.insert(keywords).values({ userId: req.userId, ...r }).run();
    }
  });
  recomputeUser(req.userId);

  res.status(201).json({ imported: resolved.length });
});

// Re-run the classification engine over all of the user's non-locked imported
// transactions. Useful after engine improvements or bulk keyword edits.
keywordsRouter.post('/recompute', (req, res) => {
  const changed = recomputeUser(req.userId);
  res.json({ changed });
});

// --- Keyword CRUD ---

// How many transactions each rule currently owns — the number that separates a
// rule doing the work from one that has never matched anything. It counts rows
// *attributed* to the rule, which is not the same as rows it would match: a
// longer keyword that outranks it holds those instead. That is what "longest
// keyword wins" looks like from this page. Split containers are skipped, so
// this agrees with the list the side panel opens (`?keywordIds=`).
function matchCounts(userId) {
  const containers = containerIds(userId);
  const conds = [eq(transactions.userId, userId), isNotNull(transactions.matchedKeywordId)];
  if (containers.length) conds.push(notInArray(transactions.id, containers));

  const rows = db
    .select({ keywordId: transactions.matchedKeywordId, n: sql`count(*)`.mapWith(Number) })
    .from(transactions)
    .where(and(...conds))
    .groupBy(transactions.matchedKeywordId)
    .all();
  return new Map(rows.map((r) => [r.keywordId, r.n]));
}

keywordsRouter.get('/', (req, res) => {
  const rows = db
    .select()
    .from(keywords)
    .where(eq(keywords.userId, req.userId))
    .orderBy(keywords.text)
    .all();
  const counts = matchCounts(req.userId);
  res.json(rows.map((r) => ({ ...publicKeyword(r), matchCount: counts.get(r.id) ?? 0 })));
});

keywordsRouter.post('/', (req, res) => {
  const parsed = parseKeyword(req.body, req.userId, false);
  if (parsed.error) return res.status(parsed.status ?? 400).json({ error: parsed.error });

  const created = db.insert(keywords).values({ userId: req.userId, ...parsed.value }).returning().get();
  recomputeUser(req.userId);
  res.status(201).json(publicKeyword(created));
});

keywordsRouter.patch('/:id', (req, res) => {
  const existing = ownedKeyword(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Keyword not found.' });

  const parsed = parseKeyword(req.body, req.userId, true);
  if (parsed.error) return res.status(parsed.status ?? 400).json({ error: parsed.error });
  if (Object.keys(parsed.value).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  reconcileSubcategory(parsed.value, existing, req.userId);
  const updated = db.update(keywords).set(parsed.value).where(eq(keywords.id, existing.id)).returning().get();
  recomputeUser(req.userId);
  res.json(publicKeyword(updated));
});

keywordsRouter.delete('/:id', (req, res) => {
  const existing = ownedKeyword(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Keyword not found.' });

  db.delete(keywords).where(eq(keywords.id, existing.id)).run();
  recomputeUser(req.userId);
  res.status(204).end();
});
