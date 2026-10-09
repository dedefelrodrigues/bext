import { Router } from 'express';
import { and, eq, desc, gte, lte, count, min, max } from 'drizzle-orm';
import { db } from '../db/index.js';
import { fxRates } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { parseCsv } from '../keywords/csv.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export const fxRouter = Router();
fxRouter.use(requireAuth);

// Validates one rate row (from the API or a CSV line) into insert shape.
function parseRate({ date, from, to, rate }, label) {
  const d = String(date ?? '').trim();
  if (!DATE_RE.test(d)) return { error: `${label}: date must be YYYY-MM-DD.` };
  const fromCcy = String(from ?? '').trim().toUpperCase();
  const toCcy = String(to ?? '').trim().toUpperCase();
  if (!CURRENCY_RE.test(fromCcy) || !CURRENCY_RE.test(toCcy)) {
    return { error: `${label}: currencies must be 3-letter codes (e.g. EUR).` };
  }
  if (fromCcy === toCcy) return { error: `${label}: from and to must differ.` };
  const value = Number(String(rate ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return { error: `${label}: rate must be a positive number.` };
  return { value: { date: d, fromCcy, toCcy, rate: value } };
}

// Insert-or-replace on (user, date, from, to) so re-uploading a table updates
// rather than duplicating.
function upsert(userId, row, source) {
  const existing = db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.userId, userId), eq(fxRates.date, row.date), eq(fxRates.fromCcy, row.fromCcy), eq(fxRates.toCcy, row.toCcy)))
    .get();
  return existing
    ? db.update(fxRates).set({ rate: row.rate, source }).where(eq(fxRates.id, existing.id)).returning().get()
    : db.insert(fxRates).values({ userId, ...row, source }).returning().get();
}

const publicRate = (r) => ({ id: r.id, date: r.date, from: r.fromCcy, to: r.toCcy, rate: r.rate, source: r.source });

// The rate table grows by a row per day per pair, so the list is filterable and
// pageable server-side — the Rates page never pulls years of history at once.
// `from`/`to` narrow the pair, `dateFrom`/`dateTo` the range; all are optional
// and a missing `limit` still returns everything (the export and older callers).
function filterOf(req) {
  const clauses = [eq(fxRates.userId, req.userId)];
  const from = String(req.query.from ?? '').trim().toUpperCase();
  const to = String(req.query.to ?? '').trim().toUpperCase();
  const dateFrom = String(req.query.dateFrom ?? '').trim();
  const dateTo = String(req.query.dateTo ?? '').trim();
  if (CURRENCY_RE.test(from)) clauses.push(eq(fxRates.fromCcy, from));
  if (CURRENCY_RE.test(to)) clauses.push(eq(fxRates.toCcy, to));
  if (DATE_RE.test(dateFrom)) clauses.push(gte(fxRates.date, dateFrom));
  if (DATE_RE.test(dateTo)) clauses.push(lte(fxRates.date, dateTo));
  return and(...clauses);
}

fxRouter.get('/rates', (req, res) => {
  const where = filterOf(req);
  const total = db.select({ n: count() }).from(fxRates).where(where).get().n;

  let q = db.select().from(fxRates).where(where).orderBy(desc(fxRates.date), fxRates.fromCcy, fxRates.toCcy);
  const limit = Number(req.query.limit);
  if (Number.isInteger(limit) && limit > 0) q = q.limit(limit).offset(Math.max(0, Number(req.query.offset) || 0));

  res.json({ rates: q.all().map(publicRate), total });
});

// Feeds the Settings summary card and the page's pair filter without shipping
// the rows themselves.
fxRouter.get('/rates/summary', (req, res) => {
  const pairs = db
    .select({
      from: fxRates.fromCcy,
      to: fxRates.toCcy,
      count: count(),
      earliest: min(fxRates.date),
      latest: max(fxRates.date),
    })
    .from(fxRates)
    .where(eq(fxRates.userId, req.userId))
    .groupBy(fxRates.fromCcy, fxRates.toCcy)
    .orderBy(fxRates.fromCcy, fxRates.toCcy)
    .all();

  res.json({
    total: pairs.reduce((n, p) => n + p.count, 0),
    latest: pairs.reduce((d, p) => (p.latest > d ? p.latest : d), ''),
    pairs,
  });
});

fxRouter.post('/rates', (req, res) => {
  const parsed = parseRate(req.body ?? {}, 'Rate');
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  res.status(201).json({ rate: publicRate(upsert(req.userId, parsed.value, 'manual')) });
});

// Bulk delete of everything matching the current filter (no filter = the whole
// table). A daily rate table is imported in bulk, so it has to be prunable in
// bulk too — the client confirms with the count from the list.
fxRouter.delete('/rates', (req, res) => {
  const { changes } = db.delete(fxRates).where(filterOf(req)).run();
  res.json({ deleted: changes });
});

fxRouter.delete('/rates/:id', (req, res) => {
  const row = db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.id, Number(req.params.id)), eq(fxRates.userId, req.userId)))
    .get();
  if (!row) return res.status(404).json({ error: 'Rate not found.' });
  db.delete(fxRates).where(eq(fxRates.id, row.id)).run();
  res.status(204).end();
});

fxRouter.get('/rates/export', (req, res) => {
  const rows = db.select().from(fxRates).where(eq(fxRates.userId, req.userId)).orderBy(fxRates.date).all();
  const lines = ['date,from,to,rate'];
  for (const r of rows) lines.push([r.date, r.fromCcy, r.toCcy, r.rate].join(','));
  res.json({ csv: lines.join('\n') + '\n' });
});

// Merges an uploaded `date,from,to,rate` table into the user's rates. Unlike
// the keyword import this is additive (existing dates are updated, others kept)
// — a rate table is usually built up month by month. Any bad row rejects the
// whole file so a typo can't half-import.
fxRouter.post('/rates/import', (req, res) => {
  if (typeof req.body?.csv !== 'string') return res.status(400).json({ error: 'Body must be { csv: "..." }.' });

  const cells = parseCsv(req.body.csv);
  let start = 0;
  const first = (cells[0] ?? []).map((c) => c.trim().toLowerCase());
  if (first[0] === 'date' && first[1] === 'from') start = 1;

  const rows = [];
  for (let i = start; i < cells.length; i++) {
    const [date = '', from = '', to = '', rate = ''] = cells[i];
    if (!date.trim() && !from.trim()) continue;
    const parsed = parseRate({ date, from, to, rate }, `Row ${i + 1}`);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    rows.push(parsed.value);
  }

  db.transaction(() => {
    for (const r of rows) upsert(req.userId, r, 'upload');
  });
  res.status(201).json({ imported: rows.length });
});
