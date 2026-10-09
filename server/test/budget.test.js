import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { institutions, accounts, transactions, fxRates } from '../src/db/schema.js';
import { resolveWindow, sliceAmount, addMonths } from '../src/budget/engine.js';
import { suggestKind } from '../src/budget/propose.js';

// "Today" is pinned to 15 April 2026: a 3-month window is Jan–Mar (complete)
// plus April as the month in progress.
const AS_OF = 'asOf=2026-04-15';

let alice;
let bob;
let aliceId;
let acct;
let cats;
const cat = (name) => cats.find((c) => c.name === name);
const sub = (catName, subName) => cat(catName).subcategories.find((s) => s.name === subName);

let seq = 0;
function insertTxn(overrides = {}) {
  const desc = overrides.description ?? `BUD ${seq++}`;
  return db
    .insert(transactions)
    .values({ userId: aliceId, accountId: acct, date: '2026-01-15', description: desc, amountCents: -1000, currency: 'PLN', dedupKey: `${desc}|${Math.random()}`, ...overrides })
    .returning()
    .get();
}

const statement = async (q = '') => (await alice.get(`/api/budget/statement?window=3&${AS_OF}${q}`)).body;
const line = (st, name) => st.groups.flatMap((g) => g.lines).find((l) => l.name === name);
const group = (st, kind) => st.groups.find((g) => g.kind === kind);

let ids = {};

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  aliceId = (await createUser(admin, 'budgetuser', 'password1')).id;
  await createUser(admin, 'budgetbob', 'password1');
  admin.close();

  alice = await startTestClient();
  await alice.post('/api/auth/login', { username: 'budgetuser', password: 'password1' });
  bob = await startTestClient();
  await bob.post('/api/auth/login', { username: 'budgetbob', password: 'password1' });

  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Bank' }).returning().get();
  acct = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'Main', currency: 'PLN', holder: 'Me' }).returning().get().id;
  cats = (await alice.get('/api/categories')).body;

  const salary = sub('Income', 'Salary');
  const rent = sub('Rent & Utilities', 'Rent');
  for (const m of ['01', '02', '03', '04']) {
    insertTxn({ date: `2026-${m}-05`, description: `SALARY ${m}`, amountCents: 1000000, categoryId: cat('Income').id, subcategoryId: salary.id });
    insertTxn({ date: `2026-${m}-02`, description: `RENT ${m}`, amountCents: -300000, categoryId: cat('Rent & Utilities').id, subcategoryId: rent.id });
  }
  // Taxes: PIT sits under Company, a subcategory rule places it.
  insertTxn({ date: '2026-01-20', amountCents: -200000, categoryId: cat('Company').id, subcategoryId: sub('Company', 'PIT Tax').id });
  // Groceries of different sizes.
  insertTxn({ date: '2026-01-10', amountCents: -10000, categoryId: cat('Food & Drink').id });
  insertTxn({ date: '2026-02-10', amountCents: -20000, categoryId: cat('Food & Drink').id });
  insertTxn({ date: '2026-03-10', amountCents: -90000, categoryId: cat('Food & Drink').id });
  // A hidden transfer nobody mapped, and an uncategorized spend.
  insertTxn({ date: '2026-02-11', amountCents: -500000, categoryId: cat('Transfer In/Out').id });
  insertTxn({ date: '2026-03-12', amountCents: -4000, categoryId: null });
  // A sofa bought in December, spread over 4 months later: Jan–Mar get slices.
  ids.sofa = insertTxn({ date: '2025-12-20', description: 'SOFA', amountCents: -400001, spreadMonths: 4, categoryId: cat('Home Improvement').id }).id;
  // A dentist bill that the user will pin to One-offs.
  ids.dentist = insertTxn({ date: '2026-02-15', description: 'DENTIST', amountCents: -80000, categoryId: cat('Medical').id }).id;
  // A trip, tagged — the tag will route it.
  ids.trip = insertTxn({ date: '2026-03-01', description: 'HOTEL', amountCents: -150000, categoryId: cat('Travel').id }).id;
  // EUR income with and without a rate.
  const eurAcct = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'EUR', currency: 'EUR', holder: 'Me' }).returning().get().id;
  db.insert(fxRates).values({ userId: aliceId, date: '2026-01-01', fromCcy: 'EUR', toCcy: 'PLN', rate: 4.25 }).run();
  insertTxn({ date: '2026-03-20', description: 'EUR BONUS', accountId: eurAcct, amountCents: 10000, currency: 'EUR', categoryId: cat('Income').id, subcategoryId: salary.id });
  insertTxn({ date: '2026-03-21', description: 'SEK THING', amountCents: -10000, currency: 'SEK', categoryId: cat('Food & Drink').id });
});

afterAll(() => {
  alice.close();
  bob.close();
});

describe('window and slices', () => {
  test('the last N complete months, plus the month in progress', () => {
    const w = resolveWindow({ window: 3, asOf: '2026-01-10' });
    expect(w.complete).toEqual(['2025-10', '2025-11', '2025-12']);
    expect(w.columns.map((c) => c.current)).toEqual([false, false, false, true]);
  });

  test('a calendar year runs past the month in progress, averaging only the past', () => {
    const w = resolveWindow({ year: 2026, asOf: '2026-04-15' });
    expect(w.columns).toHaveLength(12);
    expect(w.averaged).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(w.columns[3]).toEqual({ ym: '2026-04', current: true, future: false });
    expect(w.columns[4]).toEqual({ ym: '2026-05', current: false, future: true });
    // A year wholly ahead averages what is committed to it.
    const next = resolveWindow({ year: 2027, asOf: '2026-04-15' });
    expect(next.averagedOver).toBe('future');
    expect(next.averaged).toHaveLength(12);
  });

  test('ahead=N is the month in progress and the next N', () => {
    const w = resolveWindow({ ahead: 3, asOf: '2026-11-15' });
    expect(w.columns.map((c) => c.ym)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(w.averaged).toEqual(['2026-12', '2027-01', '2027-02']);
  });

  test('slices sum to the amount, the remainder on the first', () => {
    const s = sliceAmount(-1001, '2025-11', 3);
    expect(s.map((x) => x.ym)).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(s.map((x) => x.cents)).toEqual([-335, -333, -333]);
    expect(addMonths('2026-01', -13)).toBe('2024-12');
  });

  test('regularity suggests a kind', () => {
    expect(suggestKind(12000, 12, 0.1)).toBe('income');
    expect(suggestKind(-12000, 12, 0.1)).toBe('fixed');
    expect(suggestKind(-12000, 12, 0.8)).toBe('variable');
    expect(suggestKind(-12000, 3, 1.5)).toBe('periodic');
    expect(suggestKind(-12000, 1, 3)).toBe('extraordinary');
  });
});

describe('the starting set', () => {
  test('is proposed from the category names, once', async () => {
    const res = await alice.post(`/api/budget/propose?${AS_OF}`, {});
    expect(res.status).toBe(200);
    const names = res.body.lines.map((l) => `${l.kind}:${l.name}`);
    expect(names).toEqual(expect.arrayContaining(['income:Salary', 'tax:Taxes & social', 'fixed:Housing', 'extraordinary:Home projects', 'extraordinary:One-offs', 'excluded:Transfers']));
    for (const l of res.body.lines) ids[l.name] = l.id;
    // Calling it again without reset changes nothing.
    expect((await alice.post('/api/budget/propose', {})).body.created).toBe(0);
  });

  test('a kids category gets its own line, school included', async () => {
    const kidsCat = (await bob.post('/api/categories', { name: 'Kids' })).body;
    const school = (await bob.post(`/api/categories/${kidsCat.id}/subcategories`, { name: 'School' })).body;
    const lines = (await bob.post(`/api/budget/propose?${AS_OF}`, {})).body.lines;
    const setup = (await bob.get(`/api/budget/setup?${AS_OF}`)).body;
    const kids = setup.categories.find((c) => c.id === kidsCat.id);
    expect(lines.find((l) => l.id === kids.lineId)).toMatchObject({ name: 'Kids', kind: 'periodic' });
    expect(kids.subcategories.find((s) => s.id === school.id).lineId).toBeNull(); // follows its category
    // Leave bob with no lines: the isolation tests below expect a blank user.
    for (const l of lines) await bob.del(`/api/budget/lines/${l.id}`);
  });

  test('setup shows the mapping and each category\'s regularity', async () => {
    const setup = (await alice.get(`/api/budget/setup?${AS_OF}`)).body;
    const rentCat = setup.categories.find((c) => c.name === 'Rent & Utilities');
    expect(rentCat.lineId).toBe(ids.Housing);
    const company = setup.categories.find((c) => c.name === 'Company');
    expect(company.subcategories.find((s) => s.name === 'PIT Tax').lineId).toBe(ids['Taxes & social']);
    expect(setup.categories.find((c) => c.name === 'Transfer In/Out').lineId).toBe(ids.Transfers);
  });
});

describe('the statement', () => {
  test('lines, subtotals, and averages over complete months only', async () => {
    const st = await statement();
    expect(st.columns.map((c) => c.ym)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(st.averagedCount).toBe(3);
    expect(st.averagedOver).toBe('past');

    const salary = line(st, 'Salary');
    // 10,000 PLN a month, plus a 100 EUR bonus at 4.25 in March.
    expect(salary.values).toEqual([1000000, 1000000, 1042500, 1000000]);
    expect(salary.mean).toBe(Math.round(3042500 / 3)); // April is not in it
    expect(line(st, 'Taxes & social').values[0]).toBe(-200000);
    expect(line(st, 'Housing').mean).toBe(-300000);

    const everyday = line(st, 'Everyday');
    expect(everyday.values.slice(0, 3)).toEqual([-10000, -20000, -90000]);
    expect(everyday.mean).toBe(-40000);
    expect(everyday.total).toBe(-120000); // Jan–Mar; April is not in it

    // Hidden and unmapped: shown as excluded, summed nowhere.
    const excluded = group(st, 'excluded');
    expect(excluded.values[1]).toBe(-500000);
    expect(group(st, 'unassigned').values[2]).toBe(-4000);

    const { netIncome, normalResult, netResult } = st.subtotals;
    expect(netIncome.values[0]).toBe(1000000 - 200000);
    // Normal month (Jan) = net income − rent − groceries (no unassigned in Jan).
    expect(normalResult.values[0]).toBe(800000 - 300000 - 10000);
    // The sofa's January slice is extraordinary: −400001 over 4 months from Dec.
    expect(netResult.values[0]).toBe(normalResult.values[0] - 100000);
    // The SEK row has no rate: left out and counted, not mixed in at face value.
    expect(st.unconverted).toEqual({ count: 1, currencies: ['SEK'] });
  });

  test('a spread purchase lands its slices on its own line, even from before the window', async () => {
    const home = line(await statement(), 'Home projects');
    // Dec (outside) took −100001 incl. the remainder; Jan–Mar take −100000 each.
    expect(home.values).toEqual([-100000, -100000, -100000, 0]);
  });

  test('months ahead hold the committed slices of a spread', async () => {
    // A laptop bought in March, spread over 6 months: April is in progress,
    // May–August are ahead and already owe their slice.
    const laptop = insertTxn({ date: '2026-03-25', description: 'LAPTOP', amountCents: -600000, categoryId: cat('Home Improvement').id, spreadMonths: 6 });
    const st = (await alice.get(`/api/budget/statement?ahead=6&${AS_OF}`)).body;
    expect(st.columns.map((c) => c.ym)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(st.averagedOver).toBe('future');
    const home = line(st, 'Home projects');
    expect(home.values).toEqual([-100000, -100000, -100000, -100000, -100000, 0, 0]);
    expect(home.mean).toBe(Math.round(-400000 / 6)); // May–Oct: four slices over six months
    expect(st.horizon).toBe('2026-08');
    // The Mean cell's rows are the committed months'.
    const rows = (await alice.get(`/api/budget/rows?ahead=6&${AS_OF}&line=${home.id}`)).body;
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ description: 'LAPTOP', slices: [2, 3, 4, 5], cents: -400000 });
    db.delete(transactions).where(eq(transactions.id, laptop.id)).run();
  });

  test('a pin beats the category mapping, and a hashtag routes its rows', async () => {
    const before = await statement();
    expect(line(before, 'Health').values[1]).toBe(-80000);

    expect((await alice.patch(`/api/transactions/${ids.dentist}`, { budgetLineId: ids['One-offs'] })).status).toBe(200);
    const tag = (await alice.post(`/api/transactions/${ids.trip}/hashtags`, { name: 'lisbon' })).body.hashtags[0];
    expect((await alice.put('/api/budget/hashtags', { items: [{ hashtagId: tag.id, lineId: ids['One-offs'] }] })).status).toBe(200);

    const st = await statement();
    const oneOffs = line(st, 'One-offs');
    expect(oneOffs.values).toEqual([0, -80000, -150000, 0]);
    // The tag groups its rows under the tag, then the category.
    expect(oneOffs.children.map((c) => c.name)).toEqual(expect.arrayContaining(['#lisbon', 'Medical']));
    expect(line(st, 'Health')?.values[1] ?? 0).toBe(0);
    expect(line(st, 'Travel')?.total ?? 0).toBe(0);
  });

  test('the drill-down lists exactly the rows behind a cell', async () => {
    const st = await statement();
    const home = line(st, 'Home projects');
    const cell = (await alice.get(`/api/budget/rows?window=3&${AS_OF}&line=${home.id}&month=2026-02`)).body;
    expect(cell.total).toBe(home.values[1]);
    expect(cell.rows).toHaveLength(1);
    expect(cell.rows[0]).toMatchObject({ description: 'SOFA', spreadMonths: 4, slices: [2], cents: -100000 });

    // No month = the window's complete months (the Mean/Total cells).
    const all = (await alice.get(`/api/budget/rows?window=3&${AS_OF}&line=${home.id}`)).body;
    expect(all.total).toBe(home.total);
    expect(all.rows[0].slices).toEqual([1, 2, 3]);

    // A node narrows the list: the everyday line, one category.
    const everyday = line(st, 'Everyday');
    const node = everyday.children[0];
    const narrowed = (await alice.get(`/api/budget/rows?window=3&${AS_OF}&line=${everyday.id}&node=${node.key}`)).body;
    expect(narrowed.total).toBe(node.total);

    const un = (await alice.get(`/api/budget/rows?window=3&${AS_OF}&line=unassigned`)).body;
    expect(un.rows.map((r) => r.via)).toEqual(['uncategorized']);
  });

  test('a subcategory can override its category', async () => {
    const rent = sub('Rent & Utilities', 'Rent');
    await alice.put('/api/budget/mapping', { subcategoryId: rent.id, lineId: ids['One-offs'] });
    expect(line(await statement(), 'Housing')?.total ?? 0).toBe(0);
    await alice.put('/api/budget/mapping', { subcategoryId: rent.id, lineId: null });
    expect(line(await statement(), 'Housing').total).toBe(-900000);
  });

  test('committed yearly costs sit between net income and discretionary income', async () => {
    const committed = (await alice.post('/api/budget/lines', { name: 'Rent', kind: 'committed' })).body;
    const rent = sub('Rent & Utilities', 'Rent');
    await alice.put('/api/budget/mapping', { subcategoryId: rent.id, lineId: committed.id });
    const st = await statement();
    expect(st.groups.map((g) => g.kind).slice(0, 3)).toEqual(['income', 'tax', 'committed']);
    const { netIncome, discretionary, normalResult } = st.subtotals;
    expect(discretionary.values[0]).toBe(netIncome.values[0] - 300000);
    // The normal month still takes everything off: moving rent changed no total.
    expect(normalResult.values[0]).toBe(800000 - 300000 - 10000);
    await alice.put('/api/budget/mapping', { subcategoryId: rent.id, lineId: null });
    await alice.del(`/api/budget/lines/${committed.id}`);
  });

  test('narrowing by account keeps only that account', async () => {
    const st = await statement(`&accountId=${acct}`);
    expect(line(st, 'Salary').values[2]).toBe(1000000); // the EUR bonus lives in the other account
  });
});

describe('editing', () => {
  test('pin and spread are validated', async () => {
    expect((await alice.patch(`/api/transactions/${ids.dentist}`, { spreadMonths: 0 })).status).toBe(400);
    expect((await alice.patch(`/api/transactions/${ids.dentist}`, { spreadMonths: 121 })).status).toBe(400);
    const ok = await alice.patch(`/api/transactions/${ids.dentist}`, { spreadMonths: 1 });
    expect(ok.body.spreadMonths).toBeNull();
    expect((await alice.patch(`/api/transactions/${ids.dentist}`, { budgetLineId: 999999 })).status).toBe(400);
  });

  test('a split container cannot be pinned or spread', async () => {
    const parent = insertTxn({ date: '2026-02-01', description: 'SPLIT ME', amountCents: -2000 });
    const split = await alice.post(`/api/transactions/${parent.id}/splits`, { splits: [{ amountCents: -1000 }, { amountCents: -1000 }] });
    expect(split.status).toBe(201);
    expect((await alice.patch(`/api/transactions/${parent.id}`, { spreadMonths: 3 })).status).toBe(400);
  });

  test('deleting a line sends its rows back to the next rule', async () => {
    const created = (await alice.post('/api/budget/lines', { name: 'Temp', kind: 'variable' })).body;
    await alice.patch(`/api/transactions/${ids.dentist}`, { budgetLineId: created.id });
    expect(line(await statement(), 'Temp').values[1]).toBe(-80000);
    expect((await alice.del(`/api/budget/lines/${created.id}`)).status).toBe(204);
    const row = db.select().from(transactions).where(eq(transactions.id, ids.dentist)).get();
    expect(row.budgetLineId).toBeNull();
    expect(line(await statement(), 'Health').values[1]).toBe(-80000);
  });

  test('lines are validated and ordered within their kind', async () => {
    expect((await alice.post('/api/budget/lines', { name: '', kind: 'fixed' })).status).toBe(400);
    expect((await alice.post('/api/budget/lines', { name: 'X', kind: 'nope' })).status).toBe(400);
    const a = (await alice.post('/api/budget/lines', { name: 'A', kind: 'fixed' })).body;
    const housing = ids.Housing;
    const ordered = (await alice.post('/api/budget/lines/order', { ids: [a.id, housing] })).body;
    const fixed = ordered.filter((l) => l.kind === 'fixed').map((l) => l.name);
    expect(fixed.indexOf('A')).toBeLessThan(fixed.indexOf('Housing'));
  });
});

describe('isolation', () => {
  test('another user cannot touch or use these lines', async () => {
    expect((await bob.patch(`/api/budget/lines/${ids.Housing}`, { name: 'Mine' })).status).toBe(404);
    expect((await bob.del(`/api/budget/lines/${ids.Housing}`)).status).toBe(404);
    expect((await bob.put('/api/budget/mapping', { categoryId: cat('Travel').id, lineId: null })).status).toBe(404);
    expect((await bob.get('/api/budget/lines')).body).toEqual([]);
    const bobCats = (await bob.get('/api/categories')).body;
    expect((await bob.put('/api/budget/mapping', { categoryId: bobCats[0].id, lineId: ids.Housing })).status).toBe(400);
    expect((await bob.get(`/api/budget/statement?window=3&${AS_OF}`)).body.groups).toEqual([]);
  });

  test('the home summary counts categories without a line', async () => {
    const s = (await alice.get('/api/budget/summary')).body;
    expect(s.lineCount).toBeGreaterThan(5);
    expect(typeof s.unmappedCategories).toBe('number');
  });
});
