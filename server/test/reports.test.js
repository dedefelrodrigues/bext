import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { institutions, accounts, transactions } from '../src/db/schema.js';

let alice;
let aliceId;
let acct;
let foodCat;
let foodSub;
let otherSub;
let companyCat;
let hiddenCat;

let seq = 0;
function insertTxn(overrides = {}) {
  const desc = overrides.description ?? `RPT ${seq++}`;
  return db
    .insert(transactions)
    .values({
      userId: aliceId,
      accountId: acct,
      date: '2026-01-15',
      description: desc,
      amountCents: -1000,
      currency: 'PLN',
      dedupKey: `${desc}|${Math.random()}`,
      ...overrides,
    })
    .returning()
    .get();
}

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  aliceId = (await createUser(admin, 'rptuser', 'password1')).id;
  admin.close();

  alice = await startTestClient();
  await alice.post('/api/auth/login', { username: 'rptuser', password: 'password1' });

  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Bank' }).returning().get();
  acct = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'Checking', currency: 'PLN', holder: 'Andre' }).returning().get().id;

  const cats = (await alice.get('/api/categories')).body;
  const food = cats.find((c) => c.name === 'Food & Drink');
  foodCat = food.id;
  foodSub = food.subcategories[0].id;
  otherSub = food.subcategories[1].id;
  companyCat = cats.find((c) => c.name === 'Company').id;
  hiddenCat = cats.find((c) => c.name === 'Transfer In/Out').id;

  // January: salary + two food expenses (one per subcategory) + a hidden transfer.
  insertTxn({ date: '2026-01-05', description: 'SALARY', amountCents: 800000 });
  insertTxn({ date: '2026-01-10', amountCents: -2500, categoryId: foodCat, subcategoryId: foodSub });
  insertTxn({ date: '2026-01-20', amountCents: -1500, categoryId: foodCat, subcategoryId: otherSub });
  insertTxn({ date: '2026-01-25', amountCents: -50000, categoryId: hiddenCat });
  // February is deliberately empty — the month gap must still be charted.
  // March: a business cost and an uncategorized spend.
  insertTxn({ date: '2026-03-02', amountCents: -30000, categoryId: companyCat, businessFlag: 'business' });
  insertTxn({ date: '2026-03-03', amountCents: -900, categoryId: null });
});

afterAll(() => {
  alice.close();
});

describe('monthly income vs expenses', () => {
  test('buckets by month, fills the gap, and excludes hidden categories', async () => {
    const { months, currency, converted } = (await alice.get('/api/reports/monthly')).body;
    expect(months.map((m) => m.ym)).toEqual(['2026-01', '2026-02', '2026-03']);
    const jan = months[0];
    expect(jan.income).toBe(800000);
    expect(jan.expense).toBe(-4000); // hidden -50000 excluded
    expect(jan.net).toBe(796000);
    expect(months[1]).toMatchObject({ income: 0, expense: 0, count: 0 });
    expect(months[2].expense).toBe(-30900);
    expect(converted).toBe(true);
    expect(currency).toBe('PLN'); // the user's default
  });

  test('accepts the same filters as the list (date range, category)', async () => {
    const filtered = (await alice.get(`/api/reports/monthly?from=2026-01-01&to=2026-01-31&categoryIds=${foodCat}`)).body;
    expect(filtered.months).toEqual([{ ym: '2026-01', income: 0, expense: -4000, net: -4000, count: 2 }]);
  });

  test('includeHidden=1 brings the transfer back', async () => {
    const { months } = (await alice.get('/api/reports/monthly?includeHidden=1')).body;
    expect(months[0].expense).toBe(-54000);
  });
});

describe('category breakdown', () => {
  test('groups by category with an Uncategorized bucket', async () => {
    const { rows, level } = (await alice.get('/api/reports/by-category')).body;
    expect(level).toBe('category');
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName['Food & Drink'].expense).toBe(-4000);
    expect(byName['Company'].expense).toBe(-30000);
    expect(byName['Uncategorized'].expense).toBe(-900);
    expect(byName['Uncategorized'].income).toBe(800000); // the salary is uncategorized too
    expect(rows[0].name).toBe('Company'); // biggest spender first
  });

  test('level=sub drills into one category', async () => {
    const { rows } = (await alice.get(`/api/reports/by-category?level=sub&categoryIds=${foodCat}`)).body;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.expense).sort((a, b) => a - b)).toEqual([-2500, -1500]);
    expect(rows.every((r) => r.categoryId === foodCat)).toBe(true);
  });
});

describe('stacked monthly expenses by category', () => {
  test('one series per category, aligned to the month axis', async () => {
    const { months, series } = (await alice.get('/api/reports/monthly-by-category')).body;
    expect(months).toEqual(['2026-01', '2026-02', '2026-03']);
    const food = series.find((s) => s.name === 'Food & Drink');
    expect(food.values).toEqual([4000, 0, 0]); // positive magnitudes
    expect(series.find((s) => s.name === 'Company').values).toEqual([0, 0, 30000]);
    expect(series.find((s) => s.name === 'Uncategorized').values).toEqual([0, 0, 900]);
    expect(series.some((s) => s.name === 'Transfer In/Out')).toBe(false);
  });

  test('limit folds the tail into an Other series without losing money', async () => {
    const { series } = (await alice.get('/api/reports/monthly-by-category?limit=1')).body;
    expect(series.map((s) => s.name)).toEqual(['Company', 'Other']);
    const total = series.flatMap((s) => s.values).reduce((a, b) => a + b, 0);
    expect(total).toBe(30000 + 4000 + 900);
  });
});

describe('business vs personal and hashtags', () => {
  test('splits expense magnitudes per flag per month', async () => {
    const { series } = (await alice.get('/api/reports/business')).body;
    const business = series.find((s) => s.flag === 'business');
    const personal = series.find((s) => s.flag === 'personal');
    expect(business.values).toEqual([0, 0, 30000]);
    expect(personal.values).toEqual([4000, 0, 900]);
  });

  test('spend per hashtag counts a transaction under each of its tags', async () => {
    const trip = insertTxn({ date: '2026-03-08', amountCents: -7000, categoryId: foodCat });
    await alice.post(`/api/transactions/${trip.id}/hashtags`, { name: 'lisbon' });
    await alice.post(`/api/transactions/${trip.id}/hashtags`, { name: 'food-tour' });

    const { rows } = (await alice.get('/api/reports/hashtags')).body;
    expect(rows.map((r) => r.name).sort()).toEqual(['food-tour', 'lisbon']);
    expect(rows.every((r) => r.expense === -7000 && r.count === 1)).toBe(true);
  });
});

describe('FX in reports', () => {
  test('mixed currencies are converted into one display currency', async () => {
    // A 100.00 EUR spend with no rate on file yet.
    insertTxn({ date: '2026-04-04', amountCents: -10000, currency: 'EUR', categoryId: foodCat });
    const before = (await alice.get('/api/reports/monthly?from=2026-04-01&to=2026-04-30')).body;
    expect(before.unconverted).toBe(1);
    expect(before.months[0].expense).toBe(-10000); // shown unconverted, flagged
    expect(before.currencies).toEqual(['EUR']);

    await alice.post('/api/fx/rates', { date: '2026-04-01', from: 'EUR', to: 'PLN', rate: 4.3 });
    const after = (await alice.get('/api/reports/monthly?from=2026-04-01&to=2026-04-30')).body;
    expect(after.unconverted).toBe(0);
    expect(after.months[0].expense).toBe(-43000);
  });

  test('convert=0 keeps original amounts', async () => {
    const raw = (await alice.get('/api/reports/monthly?from=2026-04-01&to=2026-04-30&convert=0')).body;
    expect(raw.converted).toBe(false);
    expect(raw.months[0].expense).toBe(-10000);
  });

  test('currency= overrides the display currency', async () => {
    const inEur = (await alice.get('/api/reports/monthly?from=2026-04-01&to=2026-04-30&currency=EUR')).body;
    expect(inEur.currency).toBe('EUR');
    expect(inEur.months[0].expense).toBe(-10000); // already EUR
  });
});

describe('classification progress', () => {
  // June is this suite's own window, so the numbers stay independent of the
  // fixtures the other describes add.
  const june = 'from=2026-06-01&to=2026-06-30';

  beforeAll(() => {
    insertTxn({ date: '2026-06-02', amountCents: -10000, categoryId: foodCat });
    insertTxn({ date: '2026-06-03', amountCents: 20000, categoryId: null });
    insertTxn({ date: '2026-06-04', amountCents: -5000, categoryId: null });
    insertTxn({ date: '2026-06-05', amountCents: -70000, categoryId: hiddenCat });
  });

  test('measures pending work by value, counting income and expense alike', async () => {
    const res = (await alice.get(`/api/reports/classification?${june}`)).body;
    expect(res.currency).toBe('PLN');
    expect(res.totalCents).toBe(35000); // hidden -70000 excluded
    expect(res.pendingCents).toBe(25000);
    expect(res.classifiedCents).toBe(10000);
    expect(res.totalCount).toBe(3);
    expect(res.pendingCount).toBe(2);
    expect(res.unconvertedCount).toBe(0);
  });

  test('the category selection is ignored, other filters are not', async () => {
    const uncat = (await alice.get(`/api/reports/classification?${june}&uncategorized=1`)).body;
    expect(uncat.totalCents).toBe(35000);
    expect(uncat.pendingCents).toBe(25000);

    const catPicked = (await alice.get(`/api/reports/classification?${june}&categoryIds=${foodCat}`)).body;
    expect(catPicked.totalCents).toBe(35000);

    const expensesOnly = (await alice.get(`/api/reports/classification?${june}&type=expense`)).body;
    expect(expensesOnly.totalCents).toBe(15000);
    expect(expensesOnly.pendingCents).toBe(5000);
  });

  test('rows no rate can reach are counted apart, not folded into the totals', async () => {
    const july = 'from=2026-07-01&to=2026-07-31';
    insertTxn({ date: '2026-07-02', amountCents: -4000, categoryId: foodCat });
    insertTxn({ date: '2026-07-03', amountCents: -30000, currency: 'HUF', categoryId: null });

    const res = (await alice.get(`/api/reports/classification?${july}`)).body;
    expect(res.unconvertedCount).toBe(1);
    expect(res.unconvertedPending).toBe(1);
    expect(res.totalCents).toBe(4000); // the HUF row is left out of the money totals
    expect(res.pendingCents).toBe(0);
    expect(res.totalCount).toBe(2); // but it is still counted as work to do
    expect(res.pendingCount).toBe(1);

    await alice.post('/api/fx/rates', { date: '2026-07-01', from: 'HUF', to: 'PLN', rate: 0.01 });
    const after = (await alice.get(`/api/reports/classification?${july}`)).body;
    expect(after.unconvertedCount).toBe(0);
    expect(after.pendingCents).toBe(300);
    expect(after.totalCents).toBe(4300);
  });
});

describe('isolation', () => {
  test('reports require a session', async () => {
    const anon = await startTestClient();
    expect((await anon.get('/api/reports/monthly')).status).toBe(401);
    anon.close();
  });
});
