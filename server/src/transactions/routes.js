import { Router } from 'express';
import { and, or, eq, ne, isNull, isNotNull, inArray, notInArray, gte, lte, lt, gt, sql, asc, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, categories, subcategories, transactions, hashtags, transactionHashtags, keywords, users, budgetLines } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { recomputeUser } from '../engine/recompute.js';
import { buildConverter } from '../fx/converter.js';
import { groupKeyOf } from '../ai/grouping.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BUSINESS_VALUES = new Set(['business', 'personal', 'mixed']);
const DEFAULT_LIMIT = 100;

// Page size for the list. `limit=all` (or 0) returns every matching row — the
// user can ask for that deliberately from the settings page, which warns about
// what a few thousand rows do to rendering. Anything unparseable falls back to
// the default rather than silently loading everything.
function limitFor(v) {
  const raw = String(v ?? '').trim().toLowerCase();
  if (raw === 'all' || raw === '0') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
}

// Parse a comma-separated list of positive integer ids (e.g. "3,7,12").
function parseIntList(v) {
  if (!v) return [];
  return [...new Set(String(v).split(',').map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
}

// Free-text description search. Whitespace splits the query into terms and
// every term has to appear somewhere in the description ("zabka 2026" finds
// the Zabka rows of that year), which is what makes typing a second word
// narrow the list instead of widening it. LIKE's wildcards are escaped so a
// literal '%' in the box searches for a '%'. Matching is SQLite's NOCASE:
// ASCII-case-insensitive, but not diacritic-folding the way the classifier is —
// searching for "zabka" will not find "Żabka" (search "abka" for both).
function searchTerms(v) {
  return String(v ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => t.replace(/[\\%_]/g, (c) => '\\' + c));
}

// A hashtag name as stored: trimmed, without the leading '#' the user may type.
function normalizeHashtagName(raw) {
  return String(raw ?? '').trim().replace(/^#+/, '').trim();
}

// Look the user's hashtag up by name, creating it on first use.
function findOrCreateHashtag(userId, name) {
  const existing = db
    .select()
    .from(hashtags)
    .where(and(eq(hashtags.userId, userId), eq(hashtags.name, name)))
    .get();
  return existing ?? db.insert(hashtags).values({ userId, name }).returning().get();
}

// Parse a comma-separated month list ("2026-01,2026-03") into `YYYY-MM` keys.
// The explore page toggles months on and off individually, so the selection is
// a set of months rather than a range — the two can be combined and simply AND.
function parseMonthList(v) {
  if (!v) return [];
  return [...new Set(String(v).split(',').map((x) => x.trim()).filter((m) => /^\d{4}-\d{2}$/.test(m)))];
}

// Parse a comma-separated currency list ("PLN,EUR") into uppercase codes.
function parseCurrencyList(v) {
  if (!v) return [];
  return [...new Set(String(v).split(',').map((x) => x.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)))];
}

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

function ownedTransaction(id, userId) {
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
    .get();
}

// Category/subcategory lookup maps for name/icon resolution + validation.
function nameMaps(userId) {
  const cats = db.select().from(categories).where(eq(categories.userId, userId)).all();
  const subs = db.select().from(subcategories).where(eq(subcategories.userId, userId)).all();
  const kws = db.select().from(keywords).where(eq(keywords.userId, userId)).all();
  return {
    catById: new Map(cats.map((c) => [c.id, c])),
    subById: new Map(subs.map((s) => [s.id, s])),
    kwById: new Map(kws.map((k) => [k.id, k])),
    hiddenIds: cats.filter((c) => c.isHidden).map((c) => c.id),
  };
}

// Ids of transactions that are split containers (a parent of ≥1 child).
// A split parent is a container: its children carry the money, so every count
// and total in the app counts the children and skips the parent. Exported so
// the category and keyword pages count the same rows the list shows.
export function containerIds(userId) {
  return [
    ...new Set(
      db
        .select({ p: transactions.parentId })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), isNotNull(transactions.parentId)))
        .all()
        .map((r) => r.p),
    ),
  ];
}

function hashtagsFor(ids) {
  if (!ids.length) return new Map();
  const rows = db
    .select({ txId: transactionHashtags.transactionId, id: hashtags.id, name: hashtags.name })
    .from(transactionHashtags)
    .innerJoin(hashtags, eq(transactionHashtags.hashtagId, hashtags.id))
    .where(inArray(transactionHashtags.transactionId, ids))
    .all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.txId)) map.set(r.txId, []);
    map.get(r.txId).push({ id: r.id, name: r.name });
  }
  return map;
}

function publicTransaction(row, maps, htMap) {
  const cat = row.categoryId != null ? maps.catById.get(row.categoryId) : null;
  const sub = row.subcategoryId != null ? maps.subById.get(row.subcategoryId) : null;
  const kw = row.matchedKeywordId != null ? maps.kwById.get(row.matchedKeywordId) : null;
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: row.accountName ?? null,
    holder: row.accountHolder ?? null,
    date: row.date,
    description: row.description,
    amountCents: row.amountCents,
    currency: row.currency,
    foreignAmountCents: row.foreignAmountCents,
    foreignCurrency: row.foreignCurrency,
    categoryId: row.categoryId,
    category: cat ? { id: cat.id, name: cat.name, icon: cat.icon, isHidden: cat.isHidden } : null,
    subcategoryId: row.subcategoryId,
    subcategory: sub ? { id: sub.id, name: sub.name, icon: sub.icon } : null,
    businessFlag: row.businessFlag,
    isManual: row.isManual,
    isLocked: row.isLocked,
    matchedKeywordId: row.matchedKeywordId,
    matchedKeyword: kw ? { id: kw.id, text: kw.text } : null,
    parentId: row.parentId,
    isSplitChild: row.parentId != null,
    budgetLineId: row.budgetLineId ?? null,
    spreadMonths: row.spreadMonths ?? null,
    hashtags: htMap.get(row.id) ?? [],
  };
}

// Builds the WHERE conditions shared by the list, count, and summary queries.
// Exported so the reports endpoints filter over exactly the same row set.
export function listConditions(userId, q) {
  const conds = [eq(transactions.userId, userId)];

  // Only leaves are listed/summed: exclude split containers (children are kept).
  const containers = containerIds(userId);
  if (containers.length) conds.push(notInArray(transactions.id, containers));

  // Hidden categories are excluded from the list/totals (uncategorized stays).
  if (q.includeHidden !== '1') {
    const { hiddenIds } = nameMaps(userId);
    if (hiddenIds.length) conds.push(or(isNull(transactions.categoryId), notInArray(transactions.categoryId, hiddenIds)));
  }

  if (q.accountId) conds.push(eq(transactions.accountId, Number(q.accountId)));
  // An account can hold several currencies (Revolut), so this filters the
  // transaction's own currency rather than the account's.
  const ccys = parseCurrencyList(q.currencies);
  if (ccys.length) conds.push(inArray(transactions.currency, ccys));
  if (q.holder) conds.push(eq(accounts.holder, String(q.holder)));
  for (const term of searchTerms(q.q)) {
    // SQLite's LIKE is already ASCII-case-insensitive by default, so no COLLATE
    // is needed (and it would bind to the ESCAPE operand, not the comparison).
    conds.push(sql`${transactions.description} like ${'%' + term + '%'} escape '\\'`);
  }
  // Which keyword actually categorized the row — the way to see everything one
  // rule caught (and whether it is catching too much). `keywordIds=0` asks for
  // the rows no keyword matched: manual work and the uncategorized tail.
  const kwIds = parseIntList(q.keywordIds);
  const wantsNoKeyword = String(q.keywordIds ?? '').split(',').includes('0');
  if (kwIds.length || wantsNoKeyword) {
    const sel = [];
    if (kwIds.length) sel.push(inArray(transactions.matchedKeywordId, kwIds));
    if (wantsNoKeyword) sel.push(isNull(transactions.matchedKeywordId));
    conds.push(sel.length === 1 ? sel[0] : or(...sel));
  }
  if (q.business && BUSINESS_VALUES.has(q.business)) conds.push(eq(transactions.businessFlag, q.business));
  // Categories dropped from the picture entirely — the graphs' "costs without
  // Company, without Travel" question. Unlike the category *selection* below
  // this subtracts rather than selects, and it AND-combines with everything
  // else, so it narrows a selection instead of widening it. Uncategorized rows
  // survive, exactly as they do for hidden categories.
  const excludeIds = parseIntList(q.excludeCategoryIds);
  if (excludeIds.length) {
    conds.push(or(isNull(transactions.categoryId), notInArray(transactions.categoryId, excludeIds)));
  }

  // Category selection. The left-panel tree can OR-combine whole categories,
  // specific subcategories, and "uncategorized". Legacy single-value params
  // (categoryId / subcategoryId, AND-combined) still work for other callers.
  const catIds = parseIntList(q.categoryIds);
  const subIds = parseIntList(q.subcategoryIds);
  if (catIds.length || subIds.length) {
    const catSel = [];
    if (catIds.length) catSel.push(inArray(transactions.categoryId, catIds));
    if (subIds.length) catSel.push(inArray(transactions.subcategoryId, subIds));
    if (q.uncategorized === '1') catSel.push(isNull(transactions.categoryId));
    conds.push(catSel.length === 1 ? catSel[0] : or(...catSel));
  } else {
    if (q.uncategorized === '1') conds.push(isNull(transactions.categoryId));
    else if (q.categoryId) conds.push(eq(transactions.categoryId, Number(q.categoryId)));
    if (q.subcategoryId) conds.push(eq(transactions.subcategoryId, Number(q.subcategoryId)));
  }
  if (q.from && DATE_RE.test(q.from)) conds.push(gte(transactions.date, q.from));
  if (q.to && DATE_RE.test(q.to)) conds.push(lte(transactions.date, q.to));
  const months = parseMonthList(q.months);
  if (months.length) conds.push(inArray(sql`substr(${transactions.date}, 1, 7)`, months));
  if (q.type === 'expense') conds.push(lt(transactions.amountCents, 0));
  else if (q.type === 'income') conds.push(gt(transactions.amountCents, 0));
  if (q.hashtagId) {
    conds.push(
      inArray(
        transactions.id,
        db.select({ id: transactionHashtags.transactionId }).from(transactionHashtags).where(eq(transactionHashtags.hashtagId, Number(q.hashtagId))),
      ),
    );
  }
  return conds;
}

// Sort orders offered by the list. Sorting by description groups repeats of the
// same merchant together, which is how a long uncategorized tail gets worked
// through — NOCASE so "Zabka" and "ZABKA" land side by side. Account and
// category sort by name (a category's subcategory breaks the tie); uncategorized
// rows have no name, so they lead A–Z and trail Z–A. Every order ends on `id`
// so paging can never repeat or skip a row.
const nocase = (col) => sql`${col} collate nocase`;
const SORTS = {
  date_desc: () => [desc(transactions.date), desc(transactions.id)],
  date_asc: () => [asc(transactions.date), asc(transactions.id)],
  description: () => [asc(nocase(transactions.description)), desc(transactions.date), desc(transactions.id)],
  description_desc: () => [desc(nocase(transactions.description)), desc(transactions.date), desc(transactions.id)],
  account_asc: () => [asc(nocase(accounts.name)), desc(transactions.date), desc(transactions.id)],
  account_desc: () => [desc(nocase(accounts.name)), desc(transactions.date), desc(transactions.id)],
  category_asc: () => [asc(nocase(categories.name)), asc(nocase(subcategories.name)), desc(transactions.date), desc(transactions.id)],
  category_desc: () => [desc(nocase(categories.name)), desc(nocase(subcategories.name)), desc(transactions.date), desc(transactions.id)],
  // By value = by size of the movement, ignoring its sign, so the biggest
  // spends (or the smallest) sit together whichever way the money went.
  amount_desc: () => [sql`abs(${transactions.amountCents}) desc`, desc(transactions.id)],
  amount_asc: () => [sql`abs(${transactions.amountCents}) asc`, desc(transactions.id)],
};
function orderFor(sort) {
  return (SORTS[String(sort ?? '')] ?? SORTS.date_desc)();
}

transactionsRouter.get('/', (req, res) => {
  const q = req.query;
  const conds = listConditions(req.userId, q);
  const where = and(...conds);

  const limit = limitFor(q.limit);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const base = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      accountHolder: accounts.holder,
      date: transactions.date,
      description: transactions.description,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      foreignAmountCents: transactions.foreignAmountCents,
      foreignCurrency: transactions.foreignCurrency,
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
      businessFlag: transactions.businessFlag,
      isManual: transactions.isManual,
      isLocked: transactions.isLocked,
      matchedKeywordId: transactions.matchedKeywordId,
      parentId: transactions.parentId,
      budgetLineId: transactions.budgetLineId,
      spreadMonths: transactions.spreadMonths,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    // Joined only so the category sort can order by name.
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(subcategories, eq(transactions.subcategoryId, subcategories.id))
    .where(where);

  const ordered = base.orderBy(...orderFor(q.sort));
  const rows = (limit == null ? ordered : ordered.limit(limit).offset(offset)).all();

  const total = db
    .select({ n: sql`count(*)` })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(where)
    .get().n;

  const agg = db
    .select({
      income: sql`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`,
      expense: sql`coalesce(sum(case when ${transactions.amountCents} < 0 then ${transactions.amountCents} else 0 end), 0)`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(where)
    .get();

  const maps = nameMaps(req.userId);
  const htMap = hashtagsFor(rows.map((r) => r.id));
  res.json({
    transactions: rows.map((r) => publicTransaction(r, maps, htMap)),
    total: Number(total),
    summary: { income: Number(agg.income), expense: Number(agg.expense), net: Number(agg.income) + Number(agg.expense) },
  });
});

// --- Grouped view -------------------------------------------------------
//
// The list folded into one line per description, each carrying how many rows
// it stands for and what they add up to — so the uncategorized tail can be
// worked through by what matters most: the merchant that owns the most money,
// or the most rows, comes first, and categorizing it clears all of them.
//
// Two ways to say "the same description":
//   description — the same text, ignoring case and runs of whitespace;
//   merchant    — the AI review's merchant key (numbers and single letters
//                 dropped), so "ZABKA Z7412 KRAKOW" and "ZABKA Z8155 KRAKOW"
//                 are one line.
// Filters are the list's own, so a group never holds a row the list would not.
//
// Totals are FX-converted into the user's currency before they are summed, as
// every other money figure is; rows no rate reaches are left out of the total
// and counted. A group none of whose rows convert, all in one currency, keeps
// its own sum in that currency (flagged) rather than showing a meaningless 0.
const GROUP_MODES = {
  description: (d) => String(d ?? '').trim().replace(/\s+/g, ' ').toLowerCase(),
  merchant: (d) => groupKeyOf(d),
};

// Ranked on |total| so the biggest movements lead whichever way the money went,
// like the list's own by-value sort. Every order ends on the key, so paging is
// stable.
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const byText = (a, b) => a.description.localeCompare(b.description, undefined, { sensitivity: 'base' });
const GROUP_SORTS = {
  total_desc: (a, b) => Math.abs(b.totalCents) - Math.abs(a.totalCents) || b.count - a.count || byKey(a, b),
  total_asc: (a, b) => Math.abs(a.totalCents) - Math.abs(b.totalCents) || b.count - a.count || byKey(a, b),
  count_desc: (a, b) => b.count - a.count || Math.abs(b.totalCents) - Math.abs(a.totalCents) || byKey(a, b),
  count_asc: (a, b) => a.count - b.count || Math.abs(b.totalCents) - Math.abs(a.totalCents) || byKey(a, b),
  description: (a, b) => byText(a, b) || byKey(a, b),
  description_desc: (a, b) => byText(b, a) || byKey(a, b),
  date_desc: (a, b) => b.lastDate.localeCompare(a.lastDate) || byKey(a, b),
  date_asc: (a, b) => a.firstDate.localeCompare(b.firstDate) || byKey(a, b),
};

function groupedRows(userId, q) {
  const keyOf = GROUP_MODES[q.groupBy] ?? GROUP_MODES.description;
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      accountHolder: accounts.holder,
      date: transactions.date,
      description: transactions.description,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      foreignAmountCents: transactions.foreignAmountCents,
      foreignCurrency: transactions.foreignCurrency,
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
      businessFlag: transactions.businessFlag,
      isManual: transactions.isManual,
      isLocked: transactions.isLocked,
      matchedKeywordId: transactions.matchedKeywordId,
      parentId: transactions.parentId,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...listConditions(userId, q)))
    .orderBy(desc(transactions.date), desc(transactions.id))
    .all();

  const target = db.select({ c: users.defaultCurrency }).from(users).where(eq(users.id, userId)).get()?.c;
  const converter = buildConverter(userId, target);

  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row.description);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, rows: [], variants: new Map() }));
    g.rows.push(row);
    g.variants.set(row.description, (g.variants.get(row.description) ?? 0) + 1);
  }
  return { rows, groups: [...groups.values()], converter };
}

function publicGroup(g, maps, converter) {
  let totalCents = 0;
  let rawCents = 0;
  let unconvertedCount = 0;
  let uncategorizedCount = 0;
  const currencies = new Set();
  const catKeys = new Set();
  const accountNames = new Set();
  for (const r of g.rows) {
    const c = converter.convert(r);
    if (c.converted) totalCents += c.cents;
    else unconvertedCount++;
    rawCents += r.amountCents;
    currencies.add(r.currency);
    catKeys.add(`${r.categoryId ?? ''}:${r.subcategoryId ?? ''}`);
    if (r.categoryId == null) uncategorizedCount++;
    accountNames.add(r.accountName);
  }
  const count = g.rows.length;
  const allUnconverted = unconvertedCount === count && currencies.size === 1;

  // One category (and subcategory) across the whole group is shown as such;
  // anything else is "mixed", with how many of its rows are still uncategorized.
  let category = null;
  let subcategory = null;
  if (catKeys.size === 1 && g.rows[0].categoryId != null) {
    const cat = maps.catById.get(g.rows[0].categoryId);
    const sub = g.rows[0].subcategoryId != null ? maps.subById.get(g.rows[0].subcategoryId) : null;
    category = cat ? { id: cat.id, name: cat.name, icon: cat.icon, isHidden: cat.isHidden } : null;
    subcategory = sub ? { id: sub.id, name: sub.name, icon: sub.icon } : null;
  }

  const variants = [...g.variants.entries()].sort((a, b) => b[1] - a[1]);
  return {
    key: g.key,
    description: variants[0][0],
    variantCount: variants.length,
    count,
    totalCents: allUnconverted ? rawCents : totalCents,
    currency: allUnconverted ? [...currencies][0] : converter.target,
    converted: !allUnconverted,
    unconvertedCount: allUnconverted ? 0 : unconvertedCount,
    firstDate: g.rows[g.rows.length - 1].date,
    lastDate: g.rows[0].date,
    category,
    subcategory,
    categoryCount: catKeys.size,
    uncategorizedCount,
    accountName: accountNames.size === 1 ? g.rows[0].accountName : null,
    accountCount: accountNames.size,
    ids: g.rows.map((r) => r.id),
  };
}

transactionsRouter.get('/groups', (req, res) => {
  const q = req.query;
  const { rows, groups, converter } = groupedRows(req.userId, q);
  const maps = nameMaps(req.userId);

  const all = groups.map((g) => publicGroup(g, maps, converter));
  all.sort(GROUP_SORTS[String(q.sort ?? '')] ?? GROUP_SORTS.total_desc);

  const limit = limitFor(q.limit);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const page = limit == null ? all : all.slice(offset, offset + limit);

  let income = 0;
  let expense = 0;
  for (const r of rows) {
    if (r.amountCents > 0) income += r.amountCents;
    else expense += r.amountCents;
  }
  res.json({
    groups: page,
    totalGroups: all.length,
    total: rows.length,
    currency: converter.target,
    summary: { income, expense, net: income + expense },
  });
});

// The rows behind one group, for expanding it in place. Re-derived from the
// same filters rather than passed as an id list, which a big group would
// stretch past what a URL can carry.
transactionsRouter.get('/groups/members', (req, res) => {
  const { groups } = groupedRows(req.userId, req.query);
  const group = groups.find((g) => g.key === String(req.query.key ?? ''));
  if (!group) return res.json({ transactions: [] });
  const maps = nameMaps(req.userId);
  const htMap = hashtagsFor(group.rows.map((r) => r.id));
  res.json({ transactions: group.rows.map((r) => publicTransaction(r, maps, htMap)) });
});

// --- Facets: which categories/subcategories/months actually appear in the
// user's (leaf) transactions, with counts. Powers the left-panel category tree
// and period picker so they only list values that exist in the data. ---
transactionsRouter.get('/facets', (req, res) => {
  const userId = req.userId;
  const conds = [eq(transactions.userId, userId)];
  const containers = containerIds(userId);
  if (containers.length) conds.push(notInArray(transactions.id, containers));
  const { hiddenIds, kwById } = nameMaps(userId);
  if (req.query.includeHidden !== '1' && hiddenIds.length) {
    conds.push(or(isNull(transactions.categoryId), notInArray(transactions.categoryId, hiddenIds)));
  }
  const where = and(...conds);

  const byCat = db
    .select({ categoryId: transactions.categoryId, n: sql`count(*)` })
    .from(transactions)
    .where(where)
    .groupBy(transactions.categoryId)
    .all();
  const bySub = db
    .select({ subcategoryId: transactions.subcategoryId, n: sql`count(*)` })
    .from(transactions)
    .where(where)
    .groupBy(transactions.subcategoryId)
    .all();
  const byMonth = db
    .select({ ym: sql`substr(${transactions.date}, 1, 7)`, n: sql`count(*)` })
    .from(transactions)
    .where(where)
    .groupBy(sql`substr(${transactions.date}, 1, 7)`)
    .all();

  const byKeyword = db
    .select({ keywordId: transactions.matchedKeywordId, n: sql`count(*)` })
    .from(transactions)
    .where(where)
    .groupBy(transactions.matchedKeywordId)
    .all();

  const byCurrency = db
    .select({ currency: transactions.currency, n: sql`count(*)` })
    .from(transactions)
    .where(where)
    .groupBy(transactions.currency)
    .all();

  res.json({
    uncategorized: Number(byCat.find((r) => r.categoryId == null)?.n ?? 0),
    currencies: byCurrency
      .filter((r) => r.currency)
      .map((r) => ({ currency: r.currency, count: Number(r.n) }))
      .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency)),
    categories: byCat.filter((r) => r.categoryId != null).map((r) => ({ categoryId: r.categoryId, count: Number(r.n) })),
    keywords: byKeyword
      .filter((r) => r.keywordId != null)
      .map((r) => ({ keywordId: r.keywordId, text: kwById.get(r.keywordId)?.text ?? '(deleted)', count: Number(r.n) }))
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)),
    noKeyword: Number(byKeyword.find((r) => r.keywordId == null)?.n ?? 0),
    subcategories: bySub.filter((r) => r.subcategoryId != null).map((r) => ({ subcategoryId: r.subcategoryId, count: Number(r.n) })),
    months: byMonth.map((r) => ({ ym: String(r.ym), count: Number(r.n) })).sort((a, b) => b.ym.localeCompare(a.ym)),
  });
});

// --- Distinct holders (for the filter dropdown) ---
transactionsRouter.get('/holders', (req, res) => {
  const rows = db
    .selectDistinct({ holder: accounts.holder })
    .from(accounts)
    .where(eq(accounts.userId, req.userId))
    .all();
  res.json(rows.map((r) => r.holder).filter(Boolean).sort());
});

// Resolve + validate a category/subcategory pair from a body. Returns
// { categoryId, subcategoryId } or { error }.
function resolveCategory(body, userId, maps) {
  let categoryId = null;
  let subcategoryId = null;
  if (body.categoryId != null && body.categoryId !== '') {
    categoryId = Number(body.categoryId);
    if (!maps.catById.has(categoryId)) return { error: 'Category not found.' };
  }
  if (body.subcategoryId != null && body.subcategoryId !== '') {
    subcategoryId = Number(body.subcategoryId);
    const sub = maps.subById.get(subcategoryId);
    if (!sub) return { error: 'Subcategory not found.' };
    if (categoryId == null) categoryId = sub.categoryId;
    else if (sub.categoryId !== categoryId) return { error: 'Subcategory does not belong to the category.' };
  }
  return { categoryId, subcategoryId };
}

// --- Manual transaction create ---
transactionsRouter.post('/', (req, res) => {
  const b = req.body ?? {};
  const account = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, Number(b.accountId)), eq(accounts.userId, req.userId)))
    .get();
  if (!account) return res.status(400).json({ error: 'A valid account is required.' });

  const date = String(b.date ?? '');
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  const description = String(b.description ?? '').trim();
  if (!description) return res.status(400).json({ error: 'Description is required.' });
  const amountCents = Number(b.amountCents);
  if (!Number.isInteger(amountCents)) return res.status(400).json({ error: 'Amount (in cents) must be an integer.' });
  const currency = (String(b.currency ?? '').trim().toUpperCase() || account.currency).slice(0, 3);

  const maps = nameMaps(req.userId);
  const cat = resolveCategory(b, req.userId, maps);
  if (cat.error) return res.status(400).json({ error: cat.error });

  let businessFlag = BUSINESS_VALUES.has(b.businessFlag) ? b.businessFlag : null;
  if (!businessFlag) businessFlag = cat.categoryId != null ? maps.catById.get(cat.categoryId).businessDefault : 'personal';

  const dedupKey = `${date}|${description}|${amountCents}`;
  const occ = db
    .select({ n: sql`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.accountId, account.id), eq(transactions.dedupKey, dedupKey)))
    .get().n;

  const created = db
    .insert(transactions)
    .values({
      userId: req.userId,
      accountId: account.id,
      uploadId: null,
      date,
      description,
      amountCents,
      currency,
      categoryId: cat.categoryId,
      subcategoryId: cat.subcategoryId,
      businessFlag,
      isManual: true,
      isLocked: cat.categoryId != null,
      dedupKey,
      occurrenceIndex: Number(occ),
    })
    .returning()
    .get();

  const row = { ...created, accountName: account.name, accountHolder: account.holder };
  res.status(201).json(publicTransaction(row, maps, new Map()));
});

// --- Edit (category/business always; date/description/amount only if manual) ---
transactionsRouter.patch('/:id', (req, res) => {
  const existing = ownedTransaction(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Transaction not found.' });
  const b = req.body ?? {};
  const maps = nameMaps(req.userId);
  const patch = {};

  const wantsImmutable = b.date !== undefined || b.description !== undefined || b.amountCents !== undefined;
  if (wantsImmutable && !existing.isManual) {
    return res.status(400).json({ error: 'Imported transactions are immutable in date, description, and amount.' });
  }
  if (existing.isManual) {
    if (b.date !== undefined) {
      if (!DATE_RE.test(String(b.date))) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
      patch.date = String(b.date);
    }
    if (b.description !== undefined) {
      const d = String(b.description).trim();
      if (!d) return res.status(400).json({ error: 'Description is required.' });
      patch.description = d;
    }
    if (b.amountCents !== undefined) {
      const a = Number(b.amountCents);
      if (!Number.isInteger(a)) return res.status(400).json({ error: 'Amount must be an integer number of cents.' });
      const hasChildren = db.select({ n: sql`count(*)` }).from(transactions).where(eq(transactions.parentId, existing.id)).get().n;
      if (Number(hasChildren) > 0) return res.status(400).json({ error: 'Remove the split before changing the amount.' });
      patch.amountCents = a;
    }
    if (patch.date || patch.description || patch.amountCents !== undefined) {
      const nd = patch.date ?? existing.date;
      const ndesc = patch.description ?? existing.description;
      const na = patch.amountCents ?? existing.amountCents;
      patch.dedupKey = `${nd}|${ndesc}|${na}`;
    }
  }

  if (b.categoryId !== undefined || b.subcategoryId !== undefined) {
    const cat = resolveCategory(b, req.userId, maps);
    if (cat.error) return res.status(400).json({ error: cat.error });
    patch.categoryId = cat.categoryId;
    patch.subcategoryId = cat.subcategoryId;
    // A manual categorization locks the row so a recompute never overwrites it.
    if (!existing.isManual) {
      patch.isLocked = true;
      patch.matchedKeywordId = null;
    }
  }
  if (b.businessFlag !== undefined) {
    if (!BUSINESS_VALUES.has(b.businessFlag)) return res.status(400).json({ error: 'Invalid business flag.' });
    patch.businessFlag = b.businessFlag;
  }
  // Budget: pin the row to a P&L line (null = decided by hashtag/category), and
  // spread it over N months from the month it was paid (null or 1 = no spread).
  // A split container never reaches the P&L — its lines do — so neither applies.
  if (b.budgetLineId !== undefined || b.spreadMonths !== undefined) {
    if (containerIds(req.userId).includes(existing.id)) {
      return res.status(400).json({ error: 'Pin or spread the split lines, not the split transaction.' });
    }
  }
  if (b.budgetLineId !== undefined) {
    if (b.budgetLineId === null) patch.budgetLineId = null;
    else {
      const line = db.select({ id: budgetLines.id }).from(budgetLines).where(and(eq(budgetLines.id, Number(b.budgetLineId)), eq(budgetLines.userId, req.userId))).get();
      if (!line) return res.status(400).json({ error: 'Budget line not found.' });
      patch.budgetLineId = line.id;
    }
  }
  if (b.spreadMonths !== undefined) {
    const n = b.spreadMonths === null ? 1 : Number(b.spreadMonths);
    if (!Number.isInteger(n) || n < 1 || n > 120) return res.status(400).json({ error: 'Spread over 1 to 120 months.' });
    patch.spreadMonths = n > 1 ? n : null;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  const updated = db.update(transactions).set(patch).where(eq(transactions.id, existing.id)).returning().get();
  const account = db.select({ name: accounts.name, holder: accounts.holder }).from(accounts).where(eq(accounts.id, updated.accountId)).get();
  res.json(publicTransaction({ ...updated, accountName: account.name, accountHolder: account.holder }, maps, hashtagsFor([updated.id])));
});

// --- Bulk categorize -----------------------------------------------------
//
// "These forty rows are all the same shop, and no keyword is ever going to say
// so." Same semantics as editing one row by hand: the category (and optional
// business flag) is applied to every selected row and each imported row is
// locked, so the next recompute leaves the decision alone. A null category is a
// deliberate uncategorization and locks just the same — otherwise the engine
// would put the old category straight back.
//
// Ids that are not this user's are silently skipped, exactly as the bulk
// hashtag calls do, and the updated rows come back so the list can redraw them
// without a reload.
transactionsRouter.post('/bulk-categorize', (req, res) => {
  const ids = Array.isArray(req.body?.transactionIds)
    ? [...new Set(req.body.transactionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one transaction.' });

  const maps = nameMaps(req.userId);
  const cat = resolveCategory(req.body ?? {}, req.userId, maps);
  if (cat.error) return res.status(400).json({ error: cat.error });

  const businessFlag = req.body?.businessFlag;
  if (businessFlag !== undefined && businessFlag !== null && businessFlag !== '' && !BUSINESS_VALUES.has(businessFlag)) {
    return res.status(400).json({ error: 'Invalid business flag.' });
  }

  const owned = db
    .select({ id: transactions.id, isManual: transactions.isManual })
    .from(transactions)
    .where(and(eq(transactions.userId, req.userId), inArray(transactions.id, ids)))
    .all();
  if (!owned.length) return res.json({ updated: 0, transactions: [] });

  const base = { categoryId: cat.categoryId, subcategoryId: cat.subcategoryId };
  if (businessFlag) base.businessFlag = businessFlag;

  db.transaction(() => {
    const imported = owned.filter((t) => !t.isManual).map((t) => t.id);
    const manual = owned.filter((t) => t.isManual).map((t) => t.id);
    if (imported.length) {
      db.update(transactions)
        .set({ ...base, isLocked: true, matchedKeywordId: null })
        .where(inArray(transactions.id, imported))
        .run();
    }
    if (manual.length) {
      db.update(transactions).set(base).where(inArray(transactions.id, manual)).run();
    }
  });

  const ownedIds = owned.map((t) => t.id);
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      accountHolder: accounts.holder,
      date: transactions.date,
      description: transactions.description,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      foreignAmountCents: transactions.foreignAmountCents,
      foreignCurrency: transactions.foreignCurrency,
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
      businessFlag: transactions.businessFlag,
      isManual: transactions.isManual,
      isLocked: transactions.isLocked,
      matchedKeywordId: transactions.matchedKeywordId,
      parentId: transactions.parentId,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(inArray(transactions.id, ownedIds))
    .all();

  const htMap = hashtagsFor(ownedIds);
  res.json({ updated: rows.length, transactions: rows.map((r) => publicTransaction(r, maps, htMap)) });
});

// Revert an imported transaction to engine-driven classification.
transactionsRouter.post('/:id/reset-classification', (req, res) => {
  const existing = ownedTransaction(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Transaction not found.' });
  if (existing.isManual) return res.status(400).json({ error: 'Manual transactions are not auto-classified.' });

  db.update(transactions).set({ isLocked: false }).where(eq(transactions.id, existing.id)).run();
  recomputeUser(req.userId);

  const updated = ownedTransaction(existing.id, req.userId);
  const maps = nameMaps(req.userId);
  const account = db.select({ name: accounts.name, holder: accounts.holder }).from(accounts).where(eq(accounts.id, updated.accountId)).get();
  res.json(publicTransaction({ ...updated, accountName: account.name, accountHolder: account.holder }, maps, hashtagsFor([updated.id])));
});

// --- Delete (manual only; imported are removed via their upload) ---
transactionsRouter.delete('/:id', (req, res) => {
  const existing = ownedTransaction(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Transaction not found.' });
  if (!existing.isManual) return res.status(400).json({ error: 'Imported transactions are removed by deleting their upload.' });
  db.delete(transactions).where(eq(transactions.id, existing.id)).run();
  res.status(204).end();
});

// --- Hashtags ---
transactionsRouter.post('/:id/hashtags', (req, res) => {
  const existing = ownedTransaction(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Transaction not found.' });
  const name = normalizeHashtagName(req.body?.name);
  if (!name || name.length > 60) return res.status(400).json({ error: 'Hashtag is required (max 60 chars).' });

  const tag = findOrCreateHashtag(req.userId, name);
  const link = db
    .select()
    .from(transactionHashtags)
    .where(and(eq(transactionHashtags.transactionId, existing.id), eq(transactionHashtags.hashtagId, tag.id)))
    .get();
  if (!link) db.insert(transactionHashtags).values({ transactionId: existing.id, hashtagId: tag.id }).run();

  res.status(201).json({ hashtags: hashtagsFor([existing.id]).get(existing.id) ?? [] });
});

transactionsRouter.delete('/:id/hashtags/:hashtagId', (req, res) => {
  const existing = ownedTransaction(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Transaction not found.' });
  db.delete(transactionHashtags)
    .where(and(eq(transactionHashtags.transactionId, existing.id), eq(transactionHashtags.hashtagId, Number(req.params.hashtagId))))
    .run();
  res.json({ hashtags: hashtagsFor([existing.id]).get(existing.id) ?? [] });
});

// --- Splits ---
transactionsRouter.post('/:id/splits', (req, res) => {
  const parent = ownedTransaction(Number(req.params.id), req.userId);
  if (!parent) return res.status(404).json({ error: 'Transaction not found.' });
  if (parent.parentId != null) return res.status(400).json({ error: 'A split child cannot be split further.' });

  const existingChildren = db.select({ n: sql`count(*)` }).from(transactions).where(eq(transactions.parentId, parent.id)).get().n;
  if (Number(existingChildren) > 0) return res.status(400).json({ error: 'This transaction is already split — remove the split first.' });

  const splits = Array.isArray(req.body?.splits) ? req.body.splits : [];
  if (splits.length < 2) return res.status(400).json({ error: 'Provide at least two split lines.' });

  const maps = nameMaps(req.userId);
  const prepared = [];
  let sum = 0;
  for (const s of splits) {
    const amountCents = Number(s.amountCents);
    if (!Number.isInteger(amountCents)) return res.status(400).json({ error: 'Each split amount must be an integer number of cents.' });
    const cat = resolveCategory(s, req.userId, maps);
    if (cat.error) return res.status(400).json({ error: cat.error });
    let businessFlag = BUSINESS_VALUES.has(s.businessFlag) ? s.businessFlag : null;
    if (!businessFlag) businessFlag = cat.categoryId != null ? maps.catById.get(cat.categoryId).businessDefault : parent.businessFlag;
    sum += amountCents;
    prepared.push({ amountCents, ...cat, businessFlag });
  }
  if (sum !== parent.amountCents) {
    return res.status(400).json({ error: `Split lines must sum to the transaction amount (${parent.amountCents} cents), got ${sum}.` });
  }

  db.transaction(() => {
    prepared.forEach((p, i) => {
      db.insert(transactions)
        .values({
          userId: req.userId,
          accountId: parent.accountId,
          uploadId: parent.uploadId,
          date: parent.date,
          description: parent.description,
          amountCents: p.amountCents,
          currency: parent.currency,
          categoryId: p.categoryId,
          subcategoryId: p.subcategoryId,
          businessFlag: p.businessFlag,
          isManual: parent.isManual,
          isLocked: true,
          parentId: parent.id,
          dedupKey: `split:${parent.id}:${i}`,
          occurrenceIndex: 0,
        })
        .run();
    });
  });

  res.status(201).json(splitView(parent.id, req.userId));
});

transactionsRouter.delete('/:id/splits', (req, res) => {
  const parent = ownedTransaction(Number(req.params.id), req.userId);
  if (!parent) return res.status(404).json({ error: 'Transaction not found.' });
  db.delete(transactions).where(and(eq(transactions.parentId, parent.id), eq(transactions.userId, req.userId))).run();
  res.json(splitView(parent.id, req.userId));
});

// Returns { parent, children } for a split parent.
function splitView(parentId, userId) {
  const maps = nameMaps(userId);
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      accountHolder: accounts.holder,
      date: transactions.date,
      description: transactions.description,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      foreignAmountCents: transactions.foreignAmountCents,
      foreignCurrency: transactions.foreignCurrency,
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
      businessFlag: transactions.businessFlag,
      isManual: transactions.isManual,
      isLocked: transactions.isLocked,
      matchedKeywordId: transactions.matchedKeywordId,
      parentId: transactions.parentId,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(eq(transactions.userId, userId), or(eq(transactions.id, parentId), eq(transactions.parentId, parentId))))
    .all();
  const htMap = hashtagsFor(rows.map((r) => r.id));
  const parent = rows.find((r) => r.id === parentId);
  const children = rows.filter((r) => r.parentId === parentId);
  return {
    parent: parent ? publicTransaction(parent, maps, htMap) : null,
    children: children.map((c) => publicTransaction(c, maps, htMap)),
  };
}

// --- Hashtag list (for filters/autocomplete) ---
export const hashtagsRouter = Router();
hashtagsRouter.use(requireAuth);
hashtagsRouter.get('/', (req, res) => {
  const rows = db
    .select({ id: hashtags.id, name: hashtags.name, uses: sql`count(${transactionHashtags.id})` })
    .from(hashtags)
    .leftJoin(transactionHashtags, eq(transactionHashtags.hashtagId, hashtags.id))
    .where(eq(hashtags.userId, req.userId))
    .groupBy(hashtags.id)
    .orderBy(hashtags.name)
    .all();
  res.json(rows.map((r) => ({ id: r.id, name: r.name, uses: Number(r.uses) })));
});

// Create a hashtag on its own (the right-hand panel keeps a palette of tags to
// drag onto transactions, so a tag has to be able to exist before it is used).
hashtagsRouter.post('/', (req, res) => {
  const name = normalizeHashtagName(req.body?.name);
  if (!name || name.length > 60) return res.status(400).json({ error: 'Hashtag is required (max 60 chars).' });
  const tag = findOrCreateHashtag(req.userId, name);
  res.status(201).json({ id: tag.id, name: tag.name, uses: 0 });
});

hashtagsRouter.delete('/:id', (req, res) => {
  const tag = db
    .select()
    .from(hashtags)
    .where(and(eq(hashtags.id, Number(req.params.id)), eq(hashtags.userId, req.userId)))
    .get();
  if (!tag) return res.status(404).json({ error: 'Hashtag not found.' });
  db.delete(hashtags).where(eq(hashtags.id, tag.id)).run(); // links cascade
  res.status(204).end();
});

// Ids among `ids` that belong to this user, in no particular order.
function ownedTransactionIds(ids, userId) {
  if (!ids.length) return [];
  return db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, ids)))
    .all()
    .map((r) => r.id);
}

// Resolve the target tag of a bulk call: an existing `hashtagId`, or a `name`
// (created on the fly, so dropping a brand-new tag works in one call).
function resolveBulkTag(req, { create }) {
  if (req.body?.hashtagId != null) {
    const tag = db
      .select()
      .from(hashtags)
      .where(and(eq(hashtags.id, Number(req.body.hashtagId)), eq(hashtags.userId, req.userId)))
      .get();
    return tag ? { tag } : { error: 'Hashtag not found.', status: 404 };
  }
  const name = normalizeHashtagName(req.body?.name);
  if (!name || name.length > 60) return { error: 'Hashtag is required (max 60 chars).', status: 400 };
  if (!create) {
    const tag = db
      .select()
      .from(hashtags)
      .where(and(eq(hashtags.userId, req.userId), eq(hashtags.name, name)))
      .get();
    return tag ? { tag } : { error: 'Hashtag not found.', status: 404 };
  }
  return { tag: findOrCreateHashtag(req.userId, name) };
}

// Tag many transactions at once — the drag-and-drop drop target and the
// "tag selected" bulk action both land here. Ids that are not the user's are
// silently skipped; already-tagged rows are a no-op, so the call is idempotent.
hashtagsRouter.post('/assign', (req, res) => {
  const ids = Array.isArray(req.body?.transactionIds)
    ? [...new Set(req.body.transactionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one transaction.' });

  const resolved = resolveBulkTag(req, { create: true });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { tag } = resolved;

  const owned = ownedTransactionIds(ids, req.userId);
  const linked = new Set(
    owned.length
      ? db
          .select({ txId: transactionHashtags.transactionId })
          .from(transactionHashtags)
          .where(and(eq(transactionHashtags.hashtagId, tag.id), inArray(transactionHashtags.transactionId, owned)))
          .all()
          .map((r) => r.txId)
      : [],
  );
  const added = owned.filter((id) => !linked.has(id));
  if (added.length) {
    db.insert(transactionHashtags)
      .values(added.map((transactionId) => ({ transactionId, hashtagId: tag.id })))
      .run();
  }

  const htMap = hashtagsFor(owned);
  res.json({
    hashtag: { id: tag.id, name: tag.name },
    added: added.length,
    hashtags: Object.fromEntries(owned.map((id) => [id, htMap.get(id) ?? []])),
  });
});

hashtagsRouter.post('/unassign', (req, res) => {
  const ids = Array.isArray(req.body?.transactionIds)
    ? [...new Set(req.body.transactionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one transaction.' });

  const resolved = resolveBulkTag(req, { create: false });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { tag } = resolved;

  const owned = ownedTransactionIds(ids, req.userId);
  if (owned.length) {
    db.delete(transactionHashtags)
      .where(and(eq(transactionHashtags.hashtagId, tag.id), inArray(transactionHashtags.transactionId, owned)))
      .run();
  }

  const htMap = hashtagsFor(owned);
  res.json({
    hashtag: { id: tag.id, name: tag.name },
    hashtags: Object.fromEntries(owned.map((id) => [id, htMap.get(id) ?? []])),
  });
});
