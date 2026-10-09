import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, categories, subcategories, transactions, hashtags, transactionHashtags, users } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { listConditions } from '../transactions/routes.js';
import { buildConverter } from '../fx/converter.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

// --- Shared row loading -------------------------------------------------
//
// Every report runs over the same row set as the transaction list — leaves
// only (split children, never their container), hidden categories excluded —
// with the same filter params, so a chart and the list always agree.
//
// Amounts are converted into one display currency (`?currency=`, default the
// user's own). `?convert=0` keeps the original amounts; rows that no rate can
// reach come back flagged and are counted in `unconverted` so the UI can say so
// rather than silently mixing currencies.

function loadRows(req) {
  const userId = req.userId;
  const q = req.query;
  const where = and(...listConditions(userId, q));

  const rows = db
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      foreignAmountCents: transactions.foreignAmountCents,
      foreignCurrency: transactions.foreignCurrency,
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
      businessFlag: transactions.businessFlag,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(where)
    .all();

  const convert = q.convert !== '0';
  const target = convert
    ? String(q.currency || db.select({ c: users.defaultCurrency }).from(users).where(eq(users.id, userId)).get().c).toUpperCase()
    : null;

  const converter = convert ? buildConverter(userId, target) : null;
  let unconverted = 0;
  const currencies = new Set();
  const out = rows.map((r) => {
    currencies.add(r.currency);
    if (!converter) return { ...r, cents: r.amountCents, ok: true };
    const c = converter.convert(r);
    if (!c.converted) unconverted++;
    return { ...r, cents: c.cents, ok: c.converted };
  });

  return { rows: out, currency: target, converted: convert, unconverted, currencies: [...currencies].sort() };
}

const ym = (date) => date.slice(0, 7);
const meta = (r) => ({ currency: r.currency, converted: r.converted, unconverted: r.unconverted, currencies: r.currencies });

// Fills the month gaps between the first and last month present, so a bar
// chart shows an empty January instead of skipping it.
function monthRange(keys) {
  if (keys.length === 0) return [];
  const sorted = [...keys].sort();
  const out = [];
  let [y, m] = sorted[0].split('-').map(Number);
  const last = sorted[sorted.length - 1];
  for (let guard = 0; guard < 1200; guard++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= last) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// --- Monthly income vs. expenses (also powers the single-category timeline,
// which is the same query with a categoryIds filter). ---
reportsRouter.get('/monthly', (req, res) => {
  const loaded = loadRows(req);
  const byMonth = new Map();
  for (const r of loaded.rows) {
    let e = byMonth.get(ym(r.date));
    if (!e) byMonth.set(ym(r.date), (e = { income: 0, expense: 0, count: 0 }));
    if (r.cents >= 0) e.income += r.cents;
    else e.expense += r.cents;
    e.count++;
  }
  const months = monthRange([...byMonth.keys()]).map((k) => {
    const e = byMonth.get(k) ?? { income: 0, expense: 0, count: 0 };
    return { ym: k, income: e.income, expense: e.expense, net: e.income + e.expense, count: e.count };
  });
  res.json({ months, ...meta(loaded) });
});

// --- Category breakdown for the selected period (donut/treemap). `level=sub`
// with `categoryId` drills into one category's subcategories. ---
reportsRouter.get('/by-category', (req, res) => {
  const loaded = loadRows(req);
  const drill = String(req.query.level) === 'sub';
  const cats = db.select().from(categories).where(eq(categories.userId, req.userId)).all();
  const subs = db.select().from(subcategories).where(eq(subcategories.userId, req.userId)).all();
  const catById = new Map(cats.map((c) => [c.id, c]));
  const subById = new Map(subs.map((s) => [s.id, s]));

  const buckets = new Map();
  for (const r of loaded.rows) {
    const key = drill ? r.subcategoryId : r.categoryId;
    let e = buckets.get(key);
    if (!e) buckets.set(key, (e = { income: 0, expense: 0, count: 0 }));
    if (r.cents >= 0) e.income += r.cents;
    else e.expense += r.cents;
    e.count++;
  }

  const rows = [...buckets.entries()].map(([key, e]) => {
    const entity = key == null ? null : drill ? subById.get(key) : catById.get(key);
    return {
      id: key,
      name: entity ? entity.name : drill ? 'No subcategory' : 'Uncategorized',
      icon: entity?.icon ?? null,
      categoryId: drill ? entity?.categoryId ?? null : key,
      income: e.income,
      expense: e.expense,
      net: e.income + e.expense,
      count: e.count,
    };
  });
  rows.sort((a, b) => a.expense - b.expense || b.income - a.income);
  res.json({ rows, level: drill ? 'sub' : 'category', ...meta(loaded) });
});

// --- Stacked monthly expenses by category. Only the `limit` biggest spenders
// get their own band; the rest fold into an "Other" series so the chart stays
// readable. ---
reportsRouter.get('/monthly-by-category', (req, res) => {
  const loaded = loadRows(req);
  const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20);
  const cats = db.select().from(categories).where(eq(categories.userId, req.userId)).all();
  const catById = new Map(cats.map((c) => [c.id, c]));

  const totals = new Map(); // categoryId -> expense magnitude
  const cells = new Map(); // `${ym}|${categoryId}` -> magnitude
  const monthKeys = new Set();
  for (const r of loaded.rows) {
    if (r.cents >= 0) continue; // expenses only
    const magnitude = -r.cents;
    const key = r.categoryId ?? 0;
    monthKeys.add(ym(r.date));
    totals.set(key, (totals.get(key) ?? 0) + magnitude);
    const cell = `${ym(r.date)}|${key}`;
    cells.set(cell, (cells.get(cell) ?? 0) + magnitude);
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, limit).map(([id]) => id);
  const topSet = new Set(top);
  const months = monthRange([...monthKeys]);

  const series = top.map((id) => ({
    categoryId: id === 0 ? null : id,
    name: id === 0 ? 'Uncategorized' : catById.get(id)?.name ?? 'Unknown',
    icon: id === 0 ? null : catById.get(id)?.icon ?? null,
    values: months.map((m) => cells.get(`${m}|${id}`) ?? 0),
  }));
  if (ranked.length > top.length) {
    series.push({
      categoryId: null,
      name: 'Other',
      icon: null,
      isOther: true,
      values: months.map((m) =>
        ranked.reduce((sum, [id]) => (topSet.has(id) ? sum : sum + (cells.get(`${m}|${id}`) ?? 0)), 0),
      ),
    });
  }
  res.json({ months, series, ...meta(loaded) });
});

// --- Business vs. personal over time (expense magnitudes per month). ---
reportsRouter.get('/business', (req, res) => {
  const loaded = loadRows(req);
  const monthKeys = new Set();
  const cells = new Map();
  for (const r of loaded.rows) {
    if (r.cents >= 0) continue;
    monthKeys.add(ym(r.date));
    const key = `${ym(r.date)}|${r.businessFlag}`;
    cells.set(key, (cells.get(key) ?? 0) + -r.cents);
  }
  const months = monthRange([...monthKeys]);
  const flags = ['business', 'personal', 'mixed'];
  res.json({
    months,
    series: flags.map((f) => ({ flag: f, values: months.map((m) => cells.get(`${m}|${f}`) ?? 0) })),
    ...meta(loaded),
  });
});

// --- Spend per hashtag. A transaction carrying two hashtags counts toward
// both, so the totals intentionally do not sum to the period total. ---
reportsRouter.get('/hashtags', (req, res) => {
  const loaded = loadRows(req);
  const byId = new Map(loaded.rows.map((r) => [r.id, r]));
  if (byId.size === 0) return res.json({ rows: [], ...meta(loaded) });

  const links = db
    .select({ txId: transactionHashtags.transactionId, id: hashtags.id, name: hashtags.name })
    .from(transactionHashtags)
    .innerJoin(hashtags, eq(transactionHashtags.hashtagId, hashtags.id))
    .where(and(eq(hashtags.userId, req.userId), inArray(transactionHashtags.transactionId, [...byId.keys()])))
    .all();

  const buckets = new Map();
  for (const l of links) {
    const r = byId.get(l.txId);
    if (!r) continue;
    let e = buckets.get(l.id);
    if (!e) buckets.set(l.id, (e = { id: l.id, name: l.name, income: 0, expense: 0, count: 0 }));
    if (r.cents >= 0) e.income += r.cents;
    else e.expense += r.cents;
    e.count++;
  }
  const rows = [...buckets.values()]
    .map((e) => ({ ...e, net: e.income + e.expense }))
    .sort((a, b) => a.expense - b.expense);
  res.json({ rows, ...meta(loaded) });
});

// --- Classification progress -------------------------------------------
//
// How much *value* is still uncategorized, in the display currency — the
// transactions page shows it as a progress bar. The category selection is
// deliberately stripped from the filters: asking "how much is left to
// classify" while the list is filtered to *uncategorized only* would always
// answer 0%. Every other filter (account, period, holder, type, hashtag,
// business, hidden) still applies, so the bar tracks the slice being worked on.
//
// Value is summed as |amount| — an income row is as much work to classify as an
// expense one. Rows no rate can reach are left out of the money totals and
// counted separately, so the UI can say the bar is incomplete rather than
// quietly under-reporting.
reportsRouter.get('/classification', (req, res) => {
  const q = { ...req.query };
  for (const k of ['categoryIds', 'subcategoryIds', 'uncategorized', 'categoryId', 'subcategoryId']) delete q[k];
  const loaded = loadRows({ userId: req.userId, query: q });

  let totalCents = 0;
  let pendingCents = 0;
  let totalCount = 0;
  let pendingCount = 0;
  let unconvertedCount = 0;
  let unconvertedPending = 0;

  for (const r of loaded.rows) {
    const pending = r.categoryId == null;
    totalCount++;
    if (pending) pendingCount++;
    if (!r.ok) {
      unconvertedCount++;
      if (pending) unconvertedPending++;
      continue;
    }
    const value = Math.abs(r.cents);
    totalCents += value;
    if (pending) pendingCents += value;
  }

  res.json({
    currency: loaded.currency,
    totalCents,
    classifiedCents: totalCents - pendingCents,
    pendingCents,
    totalCount,
    pendingCount,
    unconvertedCount,
    unconvertedPending,
    currencies: loaded.currencies,
  });
});
