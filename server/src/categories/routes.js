import { Router } from 'express';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { categories, subcategories, keywords, transactions, users } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { containerIds } from '../transactions/routes.js';
import { buildConverter } from '../fx/converter.js';

const MAX_NAME = 120;
const MAX_ICON = 64;
const BUSINESS_VALUES = new Set(['business', 'personal', 'mixed']);

// Normalizes an optional icon field: trimmed string, or null to clear it.
// Returns { icon } or { error }. The set of valid names lives on the client
// (unknown names simply render nothing), so we only bound the length here.
function parseIcon(raw) {
  if (raw === null) return { icon: null };
  const icon = String(raw).trim();
  if (icon.length > MAX_ICON) return { error: 'Icon name is too long.' };
  return { icon: icon || null };
}

function ownedCategory(id, userId) {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.userId, userId)))
    .get();
}

function ownedSubcategory(id, userId) {
  return db
    .select()
    .from(subcategories)
    .where(and(eq(subcategories.id, id), eq(subcategories.userId, userId)))
    .get();
}

function publicCategory(row) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    businessDefault: row.businessDefault,
    isHidden: row.isHidden,
    isCashWithdrawal: row.isCashWithdrawal,
    sortOrder: row.sortOrder,
  };
}

// Validates/normalizes category fields. `partial` allows omitting name (PATCH).
function parseCategory(body, partial) {
  const out = {};
  if (body?.name !== undefined || !partial) {
    const name = String(body?.name ?? '').trim();
    if (!name || name.length > MAX_NAME) return { error: 'Category name is required (max 120 chars).' };
    out.name = name;
  }
  if (body?.businessDefault !== undefined) {
    const bd = String(body.businessDefault);
    if (!BUSINESS_VALUES.has(bd)) return { error: 'businessDefault must be business, personal, or mixed.' };
    out.businessDefault = bd;
  }
  if (body?.isHidden !== undefined) out.isHidden = Boolean(body.isHidden);
  if (body?.isCashWithdrawal !== undefined) out.isCashWithdrawal = Boolean(body.isCashWithdrawal);
  if (body?.icon !== undefined) {
    const parsed = parseIcon(body.icon);
    if (parsed.error) return { error: parsed.error };
    out.icon = parsed.icon;
  }
  return { value: out };
}

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

// --- Export / import (registered before /:id so the literal paths win) ---

// Exports the user's categories in the seed JSON shape (round-trips import).
// Keyword distance overrides are intentionally omitted here — keywords round-trip
// with their distances via the CSV export (Phase 4); the category JSON mirrors
// the seed's plain string-array shape.
categoriesRouter.get('/export', (req, res) => {
  const cats = db
    .select()
    .from(categories)
    .where(eq(categories.userId, req.userId))
    .orderBy(categories.sortOrder, categories.name)
    .all();
  const subs = db
    .select()
    .from(subcategories)
    .where(eq(subcategories.userId, req.userId))
    .orderBy(subcategories.sortOrder, subcategories.name)
    .all();
  const kws = db.select().from(keywords).where(eq(keywords.userId, req.userId)).all();

  const kwBySub = new Map();
  const kwByCat = new Map(); // keywords on a category with no subcategory
  for (const k of kws) {
    if (k.subcategoryId == null) {
      if (!kwByCat.has(k.categoryId)) kwByCat.set(k.categoryId, []);
      kwByCat.get(k.categoryId).push(k.text);
      continue;
    }
    if (!kwBySub.has(k.subcategoryId)) kwBySub.set(k.subcategoryId, []);
    kwBySub.get(k.subcategoryId).push(k.text);
  }
  const subsByCat = new Map();
  for (const s of subs) {
    if (!subsByCat.has(s.categoryId)) subsByCat.set(s.categoryId, []);
    subsByCat.get(s.categoryId).push({ name: s.name, icon: s.icon, keywords: kwBySub.get(s.id) ?? [] });
  }

  res.json({
    categories: cats.map((c) => ({
      name: c.name,
      icon: c.icon,
      businessDefault: c.businessDefault,
      isHidden: c.isHidden,
      isCashWithdrawal: c.isCashWithdrawal,
      ...(kwByCat.has(c.id) ? { keywords: kwByCat.get(c.id) } : {}),
      subcategories: subsByCat.get(c.id) ?? [],
    })),
  });
});

// Replaces the user's entire category tree with the uploaded seed-shaped JSON.
// Explicit flags are honored when present; the first-run-only special-casing
// (drop Unknown, auto-append Cash Withdrawal) does NOT apply to imports.
categoriesRouter.post('/import', (req, res) => {
  const incoming = req.body?.categories;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Body must be { categories: [...] }.' });
  }
  for (const cat of incoming) {
    if (!cat || typeof cat.name !== 'string' || !cat.name.trim()) {
      return res.status(400).json({ error: 'Every category needs a non-empty name.' });
    }
    if (cat.businessDefault !== undefined && !BUSINESS_VALUES.has(String(cat.businessDefault))) {
      return res.status(400).json({ error: `Invalid businessDefault on "${cat.name}".` });
    }
  }

  db.transaction(() => {
    // Cascades delete subcategories + keywords for this user.
    db.delete(categories).where(eq(categories.userId, req.userId)).run();

    let catOrder = 0;
    for (const cat of incoming) {
      const category = db
        .insert(categories)
        .values({
          userId: req.userId,
          name: cat.name.trim(),
          icon: typeof cat.icon === 'string' && cat.icon.trim() ? cat.icon.trim().slice(0, MAX_ICON) : null,
          businessDefault: BUSINESS_VALUES.has(String(cat.businessDefault)) ? cat.businessDefault : 'personal',
          isHidden: Boolean(cat.isHidden),
          isCashWithdrawal: Boolean(cat.isCashWithdrawal),
          sortOrder: catOrder++,
        })
        .returning()
        .get();

      for (const text of cat.keywords ?? []) {
        if (typeof text === 'string' && text.trim()) {
          db.insert(keywords).values({ userId: req.userId, categoryId: category.id, subcategoryId: null, text: text.trim() }).run();
        }
      }

      let subOrder = 0;
      for (const sub of cat.subcategories ?? []) {
        if (!sub || typeof sub.name !== 'string' || !sub.name.trim()) continue;
        const subcategory = db
          .insert(subcategories)
          .values({
            userId: req.userId,
            categoryId: category.id,
            name: sub.name.trim(),
            icon: typeof sub.icon === 'string' && sub.icon.trim() ? sub.icon.trim().slice(0, MAX_ICON) : null,
            sortOrder: subOrder++,
          })
          .returning()
          .get();
        for (const text of sub.keywords ?? []) {
          if (typeof text === 'string' && text.trim()) {
            db.insert(keywords)
              .values({ userId: req.userId, categoryId: category.id, subcategoryId: subcategory.id, text: text.trim() })
              .run();
          }
        }
      }
    }
  });

  res.status(204).end();
});

// --- Category CRUD ---

// How much has actually landed in each category and subcategory: the figure
// that says which ones earn their place. Split containers are skipped so a
// split transaction counts once, through its children — the same row set the
// transaction list and the reports use. Hidden categories ARE counted here:
// this is the page where you decide whether to keep them, so their volume is
// exactly what you need to see.
function categoryVolume(userId) {
  const containers = containerIds(userId);
  const conds = [eq(transactions.userId, userId)];
  if (containers.length) conds.push(notInArray(transactions.id, containers));

  // Amounts are converted before they are summed. A category holding PLN, EUR
  // and BRL rows would otherwise report the sum of three different currencies,
  // which is not a number — the same reason every report converts first.
  const target = db.select({ c: users.defaultCurrency }).from(users).where(eq(users.id, userId)).get()?.c ?? '';
  const converter = target ? buildConverter(userId, target) : null;

  const rows = db
    .select({
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      foreignAmountCents: transactions.foreignAmountCents,
      foreignCurrency: transactions.foreignCurrency,
    })
    .from(transactions)
    .where(and(...conds))
    .all();

  const blank = () => ({ txCount: 0, amountCents: 0, unconvertedCount: 0 });
  const byCategory = new Map();
  const bySubcategory = new Map();

  for (const r of rows) {
    if (r.categoryId == null) continue;
    const c = converter ? converter.convert(r) : { cents: r.amountCents, converted: true };

    const cat = byCategory.get(r.categoryId) ?? blank();
    cat.txCount += 1;
    cat.amountCents += c.cents;
    if (!c.converted) cat.unconvertedCount += 1;
    byCategory.set(r.categoryId, cat);

    if (r.subcategoryId != null) {
      const sub = bySubcategory.get(r.subcategoryId) ?? blank();
      sub.txCount += 1;
      sub.amountCents += c.cents;
      if (!c.converted) sub.unconvertedCount += 1;
      bySubcategory.set(r.subcategoryId, sub);
    }
  }
  return { byCategory, bySubcategory, currency: target };
}

categoriesRouter.get('/', (req, res) => {
  const cats = db
    .select()
    .from(categories)
    .where(eq(categories.userId, req.userId))
    .orderBy(categories.sortOrder, categories.name)
    .all();
  const subs = db
    .select()
    .from(subcategories)
    .where(eq(subcategories.userId, req.userId))
    .orderBy(subcategories.sortOrder, subcategories.name)
    .all();
  const kwCounts = db
    .select({ categoryId: keywords.categoryId, subcategoryId: keywords.subcategoryId, n: sql`count(*)`.mapWith(Number) })
    .from(keywords)
    .where(eq(keywords.userId, req.userId))
    .groupBy(keywords.categoryId, keywords.subcategoryId)
    .all();

  const countBySub = new Map();
  const countByCat = new Map();
  for (const r of kwCounts) {
    if (r.subcategoryId != null) countBySub.set(r.subcategoryId, r.n);
    countByCat.set(r.categoryId, (countByCat.get(r.categoryId) ?? 0) + r.n);
  }

  const { byCategory, bySubcategory, currency } = categoryVolume(req.userId);
  const blank = { txCount: 0, amountCents: 0, unconvertedCount: 0 };

  const subsByCat = new Map();
  for (const s of subs) {
    if (!subsByCat.has(s.categoryId)) subsByCat.set(s.categoryId, []);
    subsByCat.get(s.categoryId).push({
      id: s.id,
      name: s.name,
      icon: s.icon,
      keywordCount: countBySub.get(s.id) ?? 0,
      ...(bySubcategory.get(s.id) ?? blank),
    });
  }

  res.json(
    cats.map((c) => ({
      ...publicCategory(c),
      keywordCount: countByCat.get(c.id) ?? 0,
      currency,
      ...(byCategory.get(c.id) ?? blank),
      subcategories: subsByCat.get(c.id) ?? [],
    })),
  );
});

categoriesRouter.post('/', (req, res) => {
  const parsed = parseCategory(req.body, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const maxOrder = db
    .select({ m: sql`coalesce(max(${categories.sortOrder}), -1)` })
    .from(categories)
    .where(eq(categories.userId, req.userId))
    .get().m;

  const created = db
    .insert(categories)
    .values({ userId: req.userId, ...parsed.value, sortOrder: Number(maxOrder) + 1 })
    .returning()
    .get();
  res.status(201).json(publicCategory(created));
});

categoriesRouter.patch('/:id', (req, res) => {
  const existing = ownedCategory(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Category not found.' });

  const parsed = parseCategory(req.body, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (Object.keys(parsed.value).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  const updated = db.update(categories).set(parsed.value).where(eq(categories.id, existing.id)).returning().get();
  res.json(publicCategory(updated));
});

categoriesRouter.delete('/:id', (req, res) => {
  const existing = ownedCategory(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Category not found.' });
  db.delete(categories).where(eq(categories.id, existing.id)).run();
  res.status(204).end();
});

// --- Subcategory create (nested under a category) ---

categoriesRouter.post('/:id/subcategories', (req, res) => {
  const category = ownedCategory(Number(req.params.id), req.userId);
  if (!category) return res.status(404).json({ error: 'Category not found.' });

  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > MAX_NAME) return res.status(400).json({ error: 'Subcategory name is required (max 120 chars).' });
  const iconParsed = parseIcon(req.body?.icon ?? null);
  if (iconParsed.error) return res.status(400).json({ error: iconParsed.error });

  const maxOrder = db
    .select({ m: sql`coalesce(max(${subcategories.sortOrder}), -1)` })
    .from(subcategories)
    .where(eq(subcategories.categoryId, category.id))
    .get().m;

  const created = db
    .insert(subcategories)
    .values({ userId: req.userId, categoryId: category.id, name, icon: iconParsed.icon, sortOrder: Number(maxOrder) + 1 })
    .returning()
    .get();
  res.status(201).json({ id: created.id, categoryId: created.categoryId, name: created.name, icon: created.icon });
});

// --- Subcategory update / delete (own router mounted at /api/subcategories) ---

export const subcategoriesRouter = Router();
subcategoriesRouter.use(requireAuth);

subcategoriesRouter.patch('/:id', (req, res) => {
  const existing = ownedSubcategory(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Subcategory not found.' });

  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > MAX_NAME) return res.status(400).json({ error: 'Subcategory name is required (max 120 chars).' });

  const patch = { name };
  if (req.body?.icon !== undefined) {
    const iconParsed = parseIcon(req.body.icon);
    if (iconParsed.error) return res.status(400).json({ error: iconParsed.error });
    patch.icon = iconParsed.icon;
  }

  // Re-parenting: the subcategory moves to another of the user's categories,
  // and everything pointing at it has to follow, or a keyword/transaction would
  // be left claiming category A while its subcategory lives under B.
  let moveTo = null;
  if (req.body?.categoryId !== undefined && Number(req.body.categoryId) !== existing.categoryId) {
    const target = ownedCategory(Number(req.body.categoryId), req.userId);
    if (!target) return res.status(404).json({ error: 'Target category not found.' });
    moveTo = target;
    patch.categoryId = target.id;
    patch.sortOrder =
      Number(
        db
          .select({ m: sql`coalesce(max(${subcategories.sortOrder}), -1)` })
          .from(subcategories)
          .where(eq(subcategories.categoryId, target.id))
          .get().m,
      ) + 1;
  }

  const updated = db.transaction(() => {
    const row = db.update(subcategories).set(patch).where(eq(subcategories.id, existing.id)).returning().get();
    if (moveTo) {
      db.update(keywords).set({ categoryId: moveTo.id }).where(eq(keywords.subcategoryId, existing.id)).run();
      db.update(transactions)
        .set({ categoryId: moveTo.id })
        .where(and(eq(transactions.userId, req.userId), eq(transactions.subcategoryId, existing.id)))
        .run();
    }
    return row;
  });
  res.json({ id: updated.id, categoryId: updated.categoryId, name: updated.name, icon: updated.icon });
});

subcategoriesRouter.delete('/:id', (req, res) => {
  const existing = ownedSubcategory(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Subcategory not found.' });
  db.delete(subcategories).where(eq(subcategories.id, existing.id)).run();
  res.status(204).end();
});
