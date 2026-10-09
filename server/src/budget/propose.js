import { and, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { budgetLines, categories, hashtags, subcategories, transactions, users } from '../db/schema.js';
import { listConditions } from '../transactions/routes.js';
import { buildConverter } from '../fx/converter.js';
import { loadMaps, resolveWindow } from './engine.js';

// --- How regular is each category? ------------------------------------------
//
// Over the last 12 complete months, per category and per subcategory: in how
// many months it moved money, its monthly mean, and how steady that was (the
// coefficient of variation of the 12 monthly totals, empty months included).
// From that, a suggested kind — a first guess for the Setup tab to show beside
// each mapping, never applied behind the user's back:
//
//   net positive                        → income
//   ≥ 10 of 12 months and steady (cv ≤ .35) → fixed
//   ≥ 6 of 12 months                     → variable
//   2–5 months                           → periodic
//   a single month                       → extraordinary

export function regularity(userId, asOf) {
  const { complete } = resolveWindow({ window: 12, asOf });
  const target = db.select({ c: users.defaultCurrency }).from(users).where(eq(users.id, userId)).get().c;
  const conds = listConditions(userId, { includeHidden: '1' });
  conds.push(gte(transactions.date, `${complete[0]}-01`), lte(transactions.date, `${complete[complete.length - 1]}-31`));
  const rows = db
    .select({
      date: transactions.date,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      foreignAmountCents: transactions.foreignAmountCents,
      foreignCurrency: transactions.foreignCurrency,
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
    })
    .from(transactions)
    .where(and(...conds))
    .all();

  const col = new Map(complete.map((k, i) => [k, i]));
  const converter = buildConverter(userId, target);
  const cells = new Map(); // 'cat:1' | 'sub:2' -> number[12]
  const add = (key, i, cents) => {
    let v = cells.get(key);
    if (!v) cells.set(key, (v = new Array(complete.length).fill(0)));
    v[i] += cents;
  };
  for (const r of rows) {
    if (r.categoryId == null) continue;
    const c = converter.convert(r);
    if (!c.converted) continue;
    const i = col.get(r.date.slice(0, 7));
    if (i == null) continue;
    add(`cat:${r.categoryId}`, i, c.cents);
    if (r.subcategoryId != null) add(`sub:${r.subcategoryId}`, i, c.cents);
  }

  const out = new Map();
  for (const [key, values] of cells) out.set(key, describe(values));
  return { months: complete.length, currency: target, stats: out };
}

function describe(values) {
  const n = values.length;
  const total = values.reduce((a, b) => a + b, 0);
  const activeMonths = values.filter((v) => v !== 0).length;
  const mean = total / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const cv = mean === 0 ? null : Math.abs(sd / mean);
  return { activeMonths, meanCents: Math.round(mean), totalCents: total, cv: cv == null ? null : Math.round(cv * 100) / 100, suggestion: suggestKind(total, activeMonths, cv) };
}

export function suggestKind(total, activeMonths, cv) {
  if (activeMonths === 0) return null;
  if (total > 0) return 'income';
  if (activeMonths >= 10 && cv != null && cv <= 0.35) return 'fixed';
  if (activeMonths >= 6) return 'variable';
  if (activeMonths >= 2) return 'periodic';
  return 'extraordinary';
}

// --- The starting set ---------------------------------------------------------
//
// On first open the page proposes lines instead of starting blank. Names come
// from what the categories are called (the seed list, and the usual renames of
// it); anything the names do not place falls back on its regularity into an
// "Other …" line of the suggested kind. Only lines that receive something are
// created — plus "One-offs", the natural target for a pinned row. Everything is
// editable afterwards; this is a draft.

const LINES = {
  salary: ['Salary', 'income'],
  otherIncome: ['Other income', 'income'],
  taxes: ['Taxes & social', 'tax'],
  housing: ['Housing', 'fixed'],
  services: ['Services & subscriptions', 'fixed'],
  otherFixed: ['Other fixed', 'fixed'],
  kids: ['Kids', 'periodic'],
  school: ['Education', 'periodic'],
  car: ['Car', 'periodic'],
  travel: ['Travel', 'periodic'],
  otherPeriodic: ['Other periodic', 'periodic'],
  everyday: ['Everyday', 'variable'],
  transport: ['Transport', 'variable'],
  health: ['Health', 'variable'],
  leisure: ['Leisure', 'variable'],
  otherVariable: ['Other variable', 'variable'],
  home: ['Home projects', 'extraordinary'],
  oneOffs: ['One-offs', 'extraordinary'],
  transfers: ['Transfers', 'excluded'],
};

// Subcategory rules run first and only override when they differ from the
// category's line. Order matters: car insurance is Car, before insurance is Services.
const SUB_RULES = [
  [/salary|wage|payroll|pensja|wynagrodz/i, 'salary'],
  [/\b(pit|zus|vat|cit)\b|\btax(es)?\b|social security/i, 'taxes'],
  [/\bcar\b.*(insurance|maintenance|service|repair)/i, 'car'],
  [/subscription|membership|accounting|insurance/i, 'services'],
  [/school|tuition/i, 'school'],
];

const CAT_RULES = [
  [/income|salary|revenue/i, 'otherIncome'],
  [/\bkids?\b|child|children|baby/i, 'kids'],
  [/rent|utilit|housing|mortgage/i, 'housing'],
  [/bank fee|services/i, 'services'],
  [/school|education/i, 'school'],
  [/travel|holiday|vacation/i, 'travel'],
  [/home improvement|renovat/i, 'home'],
  [/food|drink|grocer|merchandise|shopping|personal care|cash/i, 'everyday'],
  [/transport/i, 'transport'],
  [/medical|health/i, 'health'],
  [/entertain|leisure|hobby|sport/i, 'leisure'],
];

const FALLBACK = { income: 'otherIncome', fixed: 'otherFixed', periodic: 'otherPeriodic', variable: 'otherVariable', extraordinary: 'home' };

const firstMatch = (rules, name) => rules.find(([re]) => re.test(name))?.[1] ?? null;

export function proposeStartingSet(userId, { reset = false, asOf } = {}) {
  const { stats } = regularity(userId, asOf);
  return db.transaction((tx) => {
    if (reset) {
      tx.update(categories).set({ budgetLineId: null }).where(eq(categories.userId, userId)).run();
      tx.update(subcategories).set({ budgetLineId: null }).where(eq(subcategories.userId, userId)).run();
      tx.update(hashtags).set({ budgetLineId: null, budgetOrder: 0 }).where(eq(hashtags.userId, userId)).run();
      tx.update(transactions).set({ budgetLineId: null }).where(eq(transactions.userId, userId)).run();
      tx.delete(budgetLines).where(eq(budgetLines.userId, userId)).run();
    }
    const maps = loadMaps(userId);

    const catLine = new Map(); // categoryId -> line key
    const subLine = new Map(); // subcategoryId -> line key
    for (const c of maps.cats) {
      let key = c.isHidden ? 'transfers' : firstMatch(CAT_RULES, c.name);
      if (!key) key = FALLBACK[stats.get(`cat:${c.id}`)?.suggestion] ?? null;
      if (key) catLine.set(c.id, key);
    }
    for (const s of maps.subs) {
      const parent = maps.catById.get(s.categoryId);
      if (parent?.isHidden) continue; // hidden stays out unless the user maps it
      const key = firstMatch(SUB_RULES, s.name);
      // A kids' category keeps its school inside it: that is the point of having one.
      if (key === 'school' && catLine.get(s.categoryId) === 'kids') continue;
      if (key && key !== catLine.get(s.categoryId)) subLine.set(s.id, key);
    }

    const used = new Set([...catLine.values(), ...subLine.values(), 'oneOffs']);
    const ids = {};
    Object.entries(LINES).forEach(([key, [name, kind]], i) => {
      if (!used.has(key)) return;
      ids[key] = tx.insert(budgetLines).values({ userId, name, kind, sortOrder: i }).returning({ id: budgetLines.id }).get().id;
    });
    for (const [id, key] of catLine) tx.update(categories).set({ budgetLineId: ids[key] }).where(eq(categories.id, id)).run();
    for (const [id, key] of subLine) tx.update(subcategories).set({ budgetLineId: ids[key] }).where(eq(subcategories.id, id)).run();
    return Object.keys(ids).length;
  });
}

