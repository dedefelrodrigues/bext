import { and, eq, gt, gte, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, budgetLines, categories, hashtags, subcategories, transactionHashtags, transactions, users } from '../db/schema.js';
import { listConditions } from '../transactions/routes.js';
import { buildConverter } from '../fx/converter.js';

// --- The Budget P&L ---------------------------------------------------------
//
// Every figure on the Budget page comes out of `computeEntries`: it loads the
// leaves in the window (split children, never their container), decides which
// P&L line each one lands on, converts it into the display currency and cuts a
// spread purchase into its monthly slices. The statement sums those entries and
// the drill-down lists them, so a cell and the rows behind it cannot disagree.
//
// Which line a row lands on — first match wins:
//   1. a pin on the transaction itself;
//   2. a hashtag that names a line (the lowest `budgetOrder` when it has two);
//   3. its subcategory's line;
//   4. its category's line;
//   5. a hidden category nobody mapped → the synthetic `hidden` line (excluded),
//      which is what "hidden" has always meant;
//   6. otherwise `unassigned` — uncategorized money and categories not yet
//      placed. It is counted in the normal month, visibly, rather than dropped:
//      the columns must add up to what really left the accounts.
//
// The mapping deliberately ignores `isHidden`: a hidden category the user maps
// (cash withdrawals parked under Transfers) counts wherever it was mapped. Every
// other page keeps hiding it.

export const KINDS = ['income', 'tax', 'committed', 'fixed', 'periodic', 'variable', 'extraordinary', 'excluded'];
export const MAX_SPREAD = 120;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ym = (date) => date.slice(0, 7);

export function addMonths(key, n) {
  let [y, m] = key.split('-').map(Number);
  m += n;
  y += Math.floor((m - 1) / 12);
  m = ((((m - 1) % 12) + 12) % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function lastDay(key) {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The columns of the statement, in three parts: complete past months, the month
// in progress, and months ahead. A month ahead holds only what is already
// committed to it — the slices of spread purchases, and any transaction dated in
// the future — so the page can show what next year already owes.
//
//   ?window=N  the last N complete months, plus the month in progress;
//   ?ahead=N   the month in progress plus the next N months;
//   ?year=YYYY that calendar year, whichever of the three its months fall in.
//
// Mean and Total run over the complete past months — half a month would drag
// every mean down, and a month ahead only holds commitments, so mixing either in
// would make "the average month" mean nothing. A window with no past months
// (all ahead) averages its months ahead instead: "committed per month".
// `asOf` pins "today" (tests, and looking back).
export function resolveWindow(q) {
  const today = DATE_RE.test(String(q.asOf ?? '')) ? String(q.asOf) : todayLocal();
  const current = ym(today);
  let keys;
  let window;
  const year = Number(q.year);
  const ahead = Number(q.ahead);
  if (Number.isInteger(year) && year >= 1900 && year <= 9999) {
    keys = [];
    for (let m = 1; m <= 12; m++) keys.push(`${year}-${String(m).padStart(2, '0')}`);
    window = { type: 'year', year };
  } else if (Number.isInteger(ahead) && ahead > 0) {
    const n = Math.min(ahead, 60);
    keys = [];
    for (let i = 0; i <= n; i++) keys.push(addMonths(current, i));
    window = { type: 'ahead', months: n };
  } else {
    const n = Math.min(Math.max(Number(q.window) || 12, 1), 60);
    keys = [];
    for (let i = n; i >= 0; i--) keys.push(addMonths(current, -i));
    window = { type: 'months', months: n };
  }
  const columns = keys.map((k) => ({ ym: k, current: k === current, future: k > current }));
  const complete = keys.filter((k) => k < current);
  const future = keys.filter((k) => k > current);
  const averaged = complete.length ? complete : future;
  const averagedOver = complete.length ? 'past' : future.length ? 'future' : 'none';
  return { window, today, current, complete, future, averaged, averagedOver, columns };
}

// The last month anything reaches: the end of the longest spread, or a
// transaction dated ahead. The page offers years up to it.
export function horizonOf(userId, today = todayLocal()) {
  let horizon = null;
  const rows = rowsReachingAhead(userId, today);
  for (const r of rows) {
    const end = r.spreadMonths > 1 ? addMonths(ym(r.date), r.spreadMonths - 1) : ym(r.date);
    if (!horizon || end > horizon) horizon = end;
  }
  return horizon;
}

// Spread rows (whatever their date) and rows dated after today.
function rowsReachingAhead(userId, today) {
  return db
    .select({ date: transactions.date, spreadMonths: transactions.spreadMonths })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), or(gt(transactions.spreadMonths, 1), gt(transactions.date, today))))
    .all();
}

// Spreads `cents` over `n` monthly slices from `startYm`; the rounding remainder
// rides on the first slice so the slices always sum to the transaction.
export function sliceAmount(cents, startYm, n) {
  const count = Number.isInteger(n) && n > 1 ? n : 1;
  if (count === 1) return [{ ym: startYm, cents, index: 0 }];
  const base = Math.trunc(cents / count);
  const remainder = cents - base * count;
  const out = [];
  for (let i = 0; i < count; i++) out.push({ ym: addMonths(startYm, i), cents: base + (i === 0 ? remainder : 0), index: i });
  return out;
}

export function loadMaps(userId) {
  const lines = db.select().from(budgetLines).where(eq(budgetLines.userId, userId)).all();
  const cats = db.select().from(categories).where(eq(categories.userId, userId)).all();
  const subs = db.select().from(subcategories).where(eq(subcategories.userId, userId)).all();
  const tags = db.select().from(hashtags).where(eq(hashtags.userId, userId)).all();
  return {
    lines,
    lineById: new Map(lines.map((l) => [l.id, l])),
    catById: new Map(cats.map((c) => [c.id, c])),
    subById: new Map(subs.map((s) => [s.id, s])),
    tagById: new Map(tags.map((t) => [t.id, t])),
    cats,
    subs,
    tags,
  };
}

// Which of a row's hashtags decides its line: txId -> hashtag row.
function routingTags(userId, maps, txIds) {
  const routing = maps.tags.filter((t) => t.budgetLineId != null && maps.lineById.has(t.budgetLineId));
  if (!routing.length || !txIds.length) return new Map();
  const links = [];
  // Chunked: SQLite caps the number of bound parameters.
  for (let i = 0; i < txIds.length; i += 800) {
    links.push(
      ...db
        .select({ txId: transactionHashtags.transactionId, tagId: transactionHashtags.hashtagId })
        .from(transactionHashtags)
        .where(and(inArray(transactionHashtags.transactionId, txIds.slice(i, i + 800)), inArray(transactionHashtags.hashtagId, routing.map((t) => t.id))))
        .all(),
    );
  }
  const rank = (t) => [t.budgetOrder, t.id];
  const best = new Map();
  for (const l of links) {
    const tag = maps.tagById.get(l.tagId);
    const cur = best.get(l.txId);
    if (!cur) best.set(l.txId, tag);
    else {
      const [a, b] = [rank(tag), rank(cur)];
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) best.set(l.txId, tag);
    }
  }
  return best;
}

export function assignLine(row, maps, tag) {
  if (row.budgetLineId != null && maps.lineById.has(row.budgetLineId)) return { lineKey: row.budgetLineId, via: 'pin' };
  if (tag) return { lineKey: tag.budgetLineId, via: 'hashtag', tagId: tag.id };
  const sub = row.subcategoryId != null ? maps.subById.get(row.subcategoryId) : null;
  if (sub?.budgetLineId != null && maps.lineById.has(sub.budgetLineId)) return { lineKey: sub.budgetLineId, via: 'subcategory' };
  const cat = row.categoryId != null ? maps.catById.get(row.categoryId) : null;
  if (cat?.budgetLineId != null && maps.lineById.has(cat.budgetLineId)) return { lineKey: cat.budgetLineId, via: 'category' };
  if (cat?.isHidden) return { lineKey: 'hidden', via: 'hidden' };
  return { lineKey: 'unassigned', via: cat ? 'unmapped' : 'uncategorized' };
}

// The rows of the window as entries: one per (transaction, month) slice that
// falls on a column. Rows no rate can reach are left out of the money and
// returned in `unconverted`, never mixed in at face value.
export function computeEntries(userId, q) {
  const win = resolveWindow(q);
  const maps = loadMaps(userId);
  const target = String(q.currency || db.select({ c: users.defaultCurrency }).from(users).where(eq(users.id, userId)).get().c).toUpperCase();

  const first = win.columns[0]?.ym;
  const last = win.columns[win.columns.length - 1]?.ym;
  if (!first) return { win, maps, currency: target, entries: [], unconverted: [] };

  const scope = { accountId: q.accountId, holder: q.holder, business: q.business, includeHidden: '1' };
  const conds = listConditions(userId, scope);
  conds.push(lte(transactions.date, lastDay(last)));
  // A spread purchase paid before the window can still have slices inside it.
  conds.push(or(gte(transactions.date, `${first}-01`), and(isNotNull(transactions.spreadMonths), gt(transactions.spreadMonths, 1))));

  const rows = db
    .select({
      id: transactions.id,
      date: transactions.date,
      description: transactions.description,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      foreignAmountCents: transactions.foreignAmountCents,
      foreignCurrency: transactions.foreignCurrency,
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
      businessFlag: transactions.businessFlag,
      budgetLineId: transactions.budgetLineId,
      spreadMonths: transactions.spreadMonths,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...conds))
    .all();

  const columnSet = new Set(win.columns.map((c) => c.ym));
  const tags = routingTags(userId, maps, rows.map((r) => r.id));
  const converter = buildConverter(userId, target);
  const entries = [];
  const unconverted = [];

  for (const row of rows) {
    const spread = row.spreadMonths > 1 ? row.spreadMonths : 1;
    const slices = sliceAmount(0, ym(row.date), spread).filter((s) => columnSet.has(s.ym));
    if (!slices.length) continue;
    const conv = converter.convert(row);
    if (!conv.converted) {
      unconverted.push(row);
      continue;
    }
    const assigned = assignLine(row, maps, tags.get(row.id));
    for (const s of sliceAmount(conv.cents, ym(row.date), spread)) {
      if (!columnSet.has(s.ym)) continue;
      entries.push({ row, ym: s.ym, cents: s.cents, sliceIndex: s.index, spread, convertedTotal: conv.cents, ...assigned });
    }
  }
  return { win, maps, currency: target, entries, unconverted };
}

// A line's breakdown: rows a hashtag routed group under the tag, then the
// category; everything else under category, then subcategory.
export function nodePath(entry) {
  const cat = `cat:${entry.row.categoryId ?? 0}`;
  if (entry.via === 'hashtag') return [`tag:${entry.tagId}`, cat];
  return entry.row.subcategoryId != null ? [cat, `sub:${entry.row.subcategoryId}`] : [cat];
}

// --- The statement ------------------------------------------------------------

// A row's figures: its values per column, and the total and mean over the
// averaged columns (`idx`) — so total = mean × months, up to rounding.
function series(values, idx) {
  const done = idx.map((i) => values[i]);
  const total = done.reduce((a, b) => a + b, 0);
  return { values, total, mean: done.length ? Math.round(total / done.length) : 0 };
}

const SYNTHETIC = {
  unassigned: { key: 'unassigned', name: 'Unassigned', kind: 'unassigned' },
  hidden: { key: 'hidden', name: 'Hidden, not mapped', kind: 'excluded' },
};

// Group order on the page. `unassigned` sits with the living costs: it is real
// money, counted in the normal month until it is placed.
const GROUPS = ['income', 'tax', 'committed', 'fixed', 'periodic', 'variable', 'unassigned', 'extraordinary', 'excluded'];

function nodeName(key, maps) {
  const [type, raw] = key.split(':');
  const id = Number(raw);
  if (type === 'tag') return { type: 'hashtag', id, name: `#${maps.tagById.get(id)?.name ?? '?'}`, categoryId: null, icon: null };
  if (type === 'sub') {
    const s = maps.subById.get(id);
    return { type: 'subcategory', id, name: s?.name ?? '?', categoryId: s?.categoryId ?? null, icon: s?.icon ?? null };
  }
  if (id === 0) return { type: 'category', id: null, name: 'Uncategorized', categoryId: null, icon: null };
  const c = maps.catById.get(id);
  return { type: 'category', id, name: c?.name ?? '?', categoryId: id, icon: c?.icon ?? null };
}

export function buildStatement(userId, q) {
  const { win, maps, currency, entries, unconverted } = computeEntries(userId, q);
  const width = win.columns.length;
  const col = new Map(win.columns.map((c, i) => [c.ym, i]));
  const avgIdx = win.averaged.map((k) => col.get(k));
  const avgSet = new Set(avgIdx);
  const zeros = () => new Array(width).fill(0);

  // lineKey -> { values, nodes: Map(key -> { values, children: Map }) }
  const acc = new Map();
  const bucket = (map, key) => {
    let b = map.get(key);
    if (!b) map.set(key, (b = { values: zeros(), children: new Map(), rows: new Set() }));
    return b;
  };
  for (const e of entries) {
    const i = col.get(e.ym);
    const line = bucket(acc, e.lineKey);
    line.values[i] += e.cents;
    if (avgSet.has(i)) line.rows.add(e.row.id);
    let level = line.children;
    for (const key of nodePath(e)) {
      const node = bucket(level, key);
      node.values[i] += e.cents;
      if (avgSet.has(i)) node.rows.add(e.row.id);
      level = node.children;
    }
  }

  const tree = (map) =>
    [...map.entries()]
      .map(([key, b]) => ({ key, ...nodeName(key, maps), ...series(b.values, avgIdx), count: b.rows.size, children: tree(b.children) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.name.localeCompare(b.name));

  const lineRow = (meta, key) => {
    const b = acc.get(key);
    const values = b ? b.values : zeros();
    return { ...meta, ...series(values, avgIdx), count: b ? b.rows.size : 0, children: b ? tree(b.children) : [] };
  };

  const ordered = [...maps.lines].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const groups = GROUPS.map((kind) => {
    const lines = ordered
      .filter((l) => l.kind === kind)
      .map((l) => lineRow({ key: l.id, id: l.id, name: l.name, kind: l.kind, synthetic: false }, l.id));
    for (const synth of Object.values(SYNTHETIC)) {
      if (synth.kind === kind && acc.has(synth.key)) lines.push(lineRow({ ...synth, id: null, synthetic: true }, synth.key));
    }
    const values = zeros();
    for (const l of lines) l.values.forEach((v, i) => (values[i] += v));
    return { kind, lines, ...series(values, avgIdx) };
  }).filter((g) => g.lines.length > 0);

  const kindValues = (kinds) => {
    const values = zeros();
    for (const g of groups) if (kinds.includes(g.kind)) g.values.forEach((v, i) => (values[i] += v));
    return series(values, avgIdx);
  };
  const subtotals = {
    netIncome: kindValues(['income', 'tax']),
    discretionary: kindValues(['income', 'tax', 'committed']),
    normalResult: kindValues(['income', 'tax', 'committed', 'fixed', 'periodic', 'variable', 'unassigned']),
    netResult: kindValues(['income', 'tax', 'committed', 'fixed', 'periodic', 'variable', 'unassigned', 'extraordinary']),
  };

  return {
    window: win.window,
    asOf: win.today,
    columns: win.columns,
    averagedCount: avgIdx.length,
    averagedOver: win.averagedOver,
    horizon: horizonOf(userId, win.today),
    currency,
    groups,
    subtotals,
    unconverted: { count: unconverted.length, currencies: [...new Set(unconverted.map((r) => r.currency))].sort() },
  };
}

// --- The drill-down -------------------------------------------------------------
//
// The rows behind one cell: a line (or the synthetic `unassigned`/`hidden`), an
// optional node path inside it (`cat:3`, `cat:3,sub:9`, `tag:4`), and a month —
// or none, meaning the months the averages run over (the Mean and Total cells). A
// spread purchase appears once, with the part of it that falls in the cell.
export function drillRows(userId, q) {
  const { win, maps, currency, entries } = computeEntries(userId, q);
  const lineKey = /^\d+$/.test(String(q.line)) ? Number(q.line) : String(q.line ?? '');
  const path = String(q.node ?? '').split(',').filter(Boolean);
  const month = /^\d{4}-\d{2}$/.test(String(q.month ?? '')) ? String(q.month) : null;
  const averaged = new Set(win.averaged);

  const byRow = new Map();
  for (const e of entries) {
    if (e.lineKey !== lineKey) continue;
    if (month ? e.ym !== month : !averaged.has(e.ym)) continue;
    const p = nodePath(e);
    if (path.some((k, i) => p[i] !== k)) continue;
    let r = byRow.get(e.row.id);
    if (!r) byRow.set(e.row.id, (r = { e, cents: 0, slices: [] }));
    r.cents += e.cents;
    r.slices.push(e.sliceIndex);
  }

  const rows = [...byRow.values()]
    .map(({ e, cents, slices }) => {
      const cat = e.row.categoryId != null ? maps.catById.get(e.row.categoryId) : null;
      const sub = e.row.subcategoryId != null ? maps.subById.get(e.row.subcategoryId) : null;
      return {
        id: e.row.id,
        date: e.row.date,
        description: e.row.description,
        accountName: e.row.accountName,
        amountCents: e.row.amountCents,
        currency: e.row.currency,
        cents,
        convertedTotal: e.convertedTotal,
        spreadMonths: e.spread > 1 ? e.spread : null,
        slices: slices.sort((a, b) => a - b),
        via: e.via,
        hashtag: e.via === 'hashtag' ? { id: e.tagId, name: maps.tagById.get(e.tagId)?.name } : null,
        budgetLineId: e.row.budgetLineId,
        category: cat ? { id: cat.id, name: cat.name, icon: cat.icon } : null,
        subcategory: sub ? { id: sub.id, name: sub.name } : null,
      };
    })
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents) || b.date.localeCompare(a.date));

  return { currency, month, total: rows.reduce((s, r) => s + r.cents, 0), rows };
}
