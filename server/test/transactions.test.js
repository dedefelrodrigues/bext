import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { institutions, accounts, categories, transactions, fxRates } from '../src/db/schema.js';

let alice;
let bob;
let aliceId;
let acctA; // holder "Andre"
let acctB; // holder "Spouse"
let foodCat;
let foodSub;
let hiddenCat; // Transfer In/Out (seeded hidden)

let seq = 0;
function insertTxn(overrides = {}) {
  const desc = overrides.description ?? `TXN ${seq++}`;
  return db
    .insert(transactions)
    .values({
      userId: aliceId,
      accountId: acctA,
      date: '2026-02-01',
      description: desc,
      amountCents: -1000,
      currency: 'PLN',
      dedupKey: `${desc}|${Math.random()}`,
      isManual: false,
      ...overrides,
    })
    .returning()
    .get();
}

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  aliceId = (await createUser(admin, 'txnuser', 'password1')).id;
  await createUser(admin, 'txnbob', 'password1');
  admin.close();

  alice = await startTestClient();
  bob = await startTestClient();
  await alice.post('/api/auth/login', { username: 'txnuser', password: 'password1' });
  await bob.post('/api/auth/login', { username: 'txnbob', password: 'password1' });

  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Bank' }).returning().get();
  acctA = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'Checking', currency: 'PLN', holder: 'Andre' }).returning().get().id;
  acctB = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'Joint', currency: 'PLN', holder: 'Spouse' }).returning().get().id;

  const cats = (await alice.get('/api/categories')).body;
  const food = cats.find((c) => c.name === 'Food & Drink');
  foodCat = food.id;
  foodSub = food.subcategories[0].id;
  hiddenCat = cats.find((c) => c.name === 'Transfer In/Out').id;
});

afterAll(() => {
  alice.close();
  bob.close();
});

describe('list + filters + summary', () => {
  let income;
  let expenseFood;
  let uncategorized;
  let hidden;
  let spouseTxn;

  test('seed a spread of transactions', () => {
    income = insertTxn({ description: 'SALARY', amountCents: 500000, categoryId: null });
    expenseFood = insertTxn({ description: 'ZABKA', amountCents: -2500, categoryId: foodCat, subcategoryId: foodSub, businessFlag: 'personal' });
    uncategorized = insertTxn({ description: 'MYSTERY', amountCents: -1500, categoryId: null });
    hidden = insertTxn({ description: 'TRANSFER OUT', amountCents: -10000, categoryId: hiddenCat });
    spouseTxn = insertTxn({ description: 'SPOUSE LUNCH', amountCents: -3000, accountId: acctB, categoryId: foodCat, businessFlag: 'business' });
    expect([income, expenseFood, uncategorized, hidden, spouseTxn].every((t) => t.id)).toBe(true);
  });

  test('default list excludes hidden-category rows and totals correctly', async () => {
    const { transactions: rows, summary, total } = (await alice.get('/api/transactions')).body;
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(hidden.id); // hidden category excluded
    expect(ids).toContain(income.id);
    expect(total).toBe(4); // income, food, uncategorized, spouse (hidden excluded)
    // income 500000; expenses -2500 -1500 -3000 = -7000 (hidden -10000 excluded)
    expect(summary.income).toBe(500000);
    expect(summary.expense).toBe(-7000);
    expect(summary.net).toBe(493000);
  });

  test('excludeCategoryIds drops whole categories from the rows and the totals', async () => {
    const without = (await alice.get(`/api/transactions?excludeCategoryIds=${foodCat}`)).body;
    const ids = without.transactions.map((r) => r.id);
    expect(ids).not.toContain(expenseFood.id);
    expect(ids).not.toContain(spouseTxn.id);
    // Uncategorized rows survive an exclusion, exactly as they survive hiding.
    expect(ids).toContain(uncategorized.id);
    expect(ids).toContain(income.id);
    expect(without.summary.expense).toBe(-1500);

    // It subtracts from a selection rather than widening it: asking for Food
    // and leaving Food out leaves nothing.
    const contradiction = (await alice.get(`/api/transactions?categoryIds=${foodCat}&excludeCategoryIds=${foodCat}`)).body;
    expect(contradiction.total).toBe(0);

    // Junk ids are dropped, so a junk-only list excludes nothing.
    expect((await alice.get('/api/transactions?excludeCategoryIds=nonsense')).body.total).toBe(4);
  });

  test('the reports honour the exclusion too, so a chart and the list agree', async () => {
    const { rows } = (await alice.get(`/api/reports/by-category?excludeCategoryIds=${foodCat}`)).body;
    expect(rows.map((r) => r.id)).not.toContain(foodCat);
    // What is left is the uncategorized -1500 (income sits in the same bucket).
    expect(rows.find((r) => r.id == null).expense).toBe(-1500);
  });

  test('includeHidden=1 brings hidden rows back', async () => {
    const { total } = (await alice.get('/api/transactions?includeHidden=1')).body;
    expect(total).toBe(5);
  });

  test('type, uncategorized, category, holder, business filters', async () => {
    expect((await alice.get('/api/transactions?type=income')).body.transactions.map((r) => r.id)).toEqual([income.id]);
    expect((await alice.get('/api/transactions?type=expense')).body.total).toBe(3);
    // SALARY and MYSTERY both have no category.
    const unc = (await alice.get('/api/transactions?uncategorized=1')).body.transactions.map((r) => r.id).sort((a, b) => a - b);
    expect(unc).toEqual([income.id, uncategorized.id].sort((a, b) => a - b));
    expect((await alice.get(`/api/transactions?categoryId=${foodCat}`)).body.total).toBe(2);
    expect((await alice.get('/api/transactions?holder=Spouse')).body.transactions.map((r) => r.id)).toEqual([spouseTxn.id]);
    expect((await alice.get('/api/transactions?business=business')).body.transactions.map((r) => r.id)).toEqual([spouseTxn.id]);
    expect((await alice.get(`/api/transactions?accountId=${acctB}`)).body.total).toBe(1);
  });

  test('multi-select category filtering (categoryIds/subcategoryIds/uncategorized OR-combined)', async () => {
    // categoryIds includes both food rows.
    expect((await alice.get(`/api/transactions?categoryIds=${foodCat}`)).body.total).toBe(2);
    // Whole food category OR uncategorized = 2 food + 2 uncategorized (SALARY, MYSTERY).
    const combo = (await alice.get(`/api/transactions?categoryIds=${foodCat}&uncategorized=1`)).body.transactions.map((r) => r.id).sort((a, b) => a - b);
    expect(combo).toEqual([income.id, expenseFood.id, uncategorized.id, spouseTxn.id].sort((a, b) => a - b));
    // subcategoryIds narrows to the single row carrying foodSub (spouse row has no sub).
    expect((await alice.get(`/api/transactions?subcategoryIds=${foodSub}`)).body.transactions.map((r) => r.id)).toEqual([expenseFood.id]);
  });

  test('facets reports categories/subcategories present in transactions with counts', async () => {
    const facets = (await alice.get('/api/transactions/facets')).body;
    expect(facets.uncategorized).toBe(2); // SALARY + MYSTERY
    expect(facets.categories.find((c) => c.categoryId === foodCat).count).toBe(2);
    expect(facets.subcategories.find((s) => s.subcategoryId === foodSub).count).toBe(1);
    // Hidden category is excluded by default, included with includeHidden=1.
    expect(facets.categories.some((c) => c.categoryId === hiddenCat)).toBe(false);
    const withHidden = (await alice.get('/api/transactions/facets?includeHidden=1')).body;
    expect(withHidden.categories.some((c) => c.categoryId === hiddenCat)).toBe(true);
    // Months present in the data (all seeded rows are 2026-02), with counts.
    expect(facets.months.find((m) => m.ym === '2026-02').count).toBe(4);
  });

  test('date range filter', async () => {
    const old = insertTxn({ description: 'OLD', amountCents: -100, date: '2025-01-01' });
    expect((await alice.get('/api/transactions?from=2026-01-01')).body.transactions.map((r) => r.id)).not.toContain(old.id);
    expect((await alice.get('/api/transactions?to=2025-12-31')).body.transactions.map((r) => r.id)).toContain(old.id);
  });

  test('holders endpoint lists distinct account holders', async () => {
    expect((await alice.get('/api/transactions/holders')).body).toEqual(['Andre', 'Spouse']);
  });
});

describe('manual create + edit + lock', () => {
  test('create a manual transaction with a category (locked)', async () => {
    const res = await alice.post('/api/transactions', { accountId: acctA, date: '2026-03-03', description: 'CASH LUNCH', amountCents: -4200, categoryId: foodCat });
    expect(res.status).toBe(201);
    expect(res.body.isManual).toBe(true);
    expect(res.body.isLocked).toBe(true);
    expect(res.body.category.name).toBe('Food & Drink');
  });

  test('manual transactions are fully editable; imported are not', async () => {
    const manual = (await alice.post('/api/transactions', { accountId: acctA, date: '2026-03-04', description: 'EDIT ME', amountCents: -100 })).body;
    const edited = await alice.patch(`/api/transactions/${manual.id}`, { description: 'EDITED', amountCents: -250, date: '2026-03-05' });
    expect(edited.status).toBe(200);
    expect(edited.body.description).toBe('EDITED');
    expect(edited.body.amountCents).toBe(-250);

    const imported = insertTxn({ description: 'IMMUTABLE', amountCents: -900 });
    expect((await alice.patch(`/api/transactions/${imported.id}`, { amountCents: -1 })).status).toBe(400);
    expect((await alice.patch(`/api/transactions/${imported.id}`, { description: 'x' })).status).toBe(400);
  });

  test('categorizing an imported transaction locks it; reset re-runs the engine', async () => {
    const tx = insertTxn({ description: 'FRESHMERCHANT SHOP', amountCents: -700 });
    // Auto-classify via a keyword first.
    const cat = (await alice.post('/api/categories', { name: 'Auto Cat' })).body;
    await alice.post('/api/keywords', { text: 'freshmerchant', categoryId: cat.id, distance: 0 });
    expect(db.select().from(transactions).where(eq(transactions.id, tx.id)).get().categoryId).toBe(cat.id);

    // Manually recategorize → locked, keyword link cleared.
    const patched = await alice.patch(`/api/transactions/${tx.id}`, { categoryId: foodCat });
    expect(patched.body.categoryId).toBe(foodCat);
    expect(patched.body.isLocked).toBe(true);
    expect(patched.body.matchedKeywordId).toBeNull();

    // Reset → engine reclassifies back to the keyword's category.
    const reset = await alice.post(`/api/transactions/${tx.id}/reset-classification`);
    expect(reset.body.categoryId).toBe(cat.id);
    expect(reset.body.isLocked).toBe(false);
  });

  test('delete: manual allowed, imported blocked', async () => {
    const manual = (await alice.post('/api/transactions', { accountId: acctA, date: '2026-03-06', description: 'DEL', amountCents: -1 })).body;
    expect((await alice.del(`/api/transactions/${manual.id}`)).status).toBe(204);
    const imported = insertTxn({ description: 'NO DELETE', amountCents: -1 });
    expect((await alice.del(`/api/transactions/${imported.id}`)).status).toBe(400);
  });
});

describe('hashtags', () => {
  test('attach, filter by, list, and detach', async () => {
    const tx = insertTxn({ description: 'TRIP HOTEL', amountCents: -20000 });
    const attach = await alice.post(`/api/transactions/${tx.id}/hashtags`, { name: '#Lisbon2026' });
    expect(attach.status).toBe(201);
    expect(attach.body.hashtags[0].name).toBe('Lisbon2026'); // leading # stripped

    const list = (await alice.get('/api/hashtags')).body;
    const tag = list.find((h) => h.name === 'Lisbon2026');
    expect(tag.uses).toBe(1);

    const filtered = (await alice.get(`/api/transactions?hashtagId=${tag.id}`)).body.transactions;
    expect(filtered.map((r) => r.id)).toEqual([tx.id]);

    const detach = await alice.del(`/api/transactions/${tx.id}/hashtags/${tag.id}`);
    expect(detach.body.hashtags).toHaveLength(0);
  });

  test('a hashtag can be created standalone and deleted with its links', async () => {
    const created = await alice.post('/api/hashtags', { name: '#renovation' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'renovation', uses: 0 });

    // Re-creating the same name returns the same tag rather than a duplicate.
    const again = await alice.post('/api/hashtags', { name: 'renovation' });
    expect(again.body.id).toBe(created.body.id);

    const tx = insertTxn({ description: 'TILES', amountCents: -5000 });
    await alice.post('/api/hashtags/assign', { hashtagId: created.body.id, transactionIds: [tx.id] });

    expect((await alice.del(`/api/hashtags/${created.body.id}`)).status).toBe(204);
    expect((await alice.get('/api/hashtags')).body.some((h) => h.name === 'renovation')).toBe(false);
    const after = (await alice.get(`/api/transactions?accountId=${acctA}`)).body.transactions.find((r) => r.id === tx.id);
    expect(after.hashtags).toHaveLength(0);
  });

  test('bulk assign tags many transactions at once and is idempotent', async () => {
    const a = insertTxn({ description: 'TRAIN', amountCents: -3000 });
    const b = insertTxn({ description: 'HOTEL', amountCents: -9000 });

    const res = await alice.post('/api/hashtags/assign', { name: '#Porto', transactionIds: [a.id, b.id] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(2);
    expect(res.body.hashtag.name).toBe('Porto');
    expect(res.body.hashtags[a.id].map((h) => h.name)).toEqual(['Porto']);
    expect(res.body.hashtags[b.id].map((h) => h.name)).toEqual(['Porto']);

    const repeat = await alice.post('/api/hashtags/assign', { name: 'Porto', transactionIds: [a.id, b.id] });
    expect(repeat.body.added).toBe(0);
    expect(repeat.body.hashtags[a.id]).toHaveLength(1);

    const tag = (await alice.get('/api/hashtags')).body.find((h) => h.name === 'Porto');
    expect(tag.uses).toBe(2);

    const off = await alice.post('/api/hashtags/unassign', { hashtagId: tag.id, transactionIds: [a.id] });
    expect(off.body.hashtags[a.id]).toHaveLength(0);
    expect((await alice.get('/api/hashtags')).body.find((h) => h.name === 'Porto').uses).toBe(1);
  });

  test('bulk assign skips transactions belonging to another user', async () => {
    const mine = insertTxn({ description: 'MINE', amountCents: -100 });
    const res = await bob.post('/api/hashtags/assign', { name: 'bobtrip', transactionIds: [mine.id] });
    expect(res.status).toBe(200);
    expect(res.body.hashtags[mine.id]).toBeUndefined();

    const still = (await alice.get(`/api/transactions?accountId=${acctA}`)).body.transactions.find((r) => r.id === mine.id);
    expect(still.hashtags).toHaveLength(0);
  });

  test('bulk endpoints reject an empty selection or an unknown tag', async () => {
    expect((await alice.post('/api/hashtags/assign', { name: 'x', transactionIds: [] })).status).toBe(400);
    const tx = insertTxn({ description: 'NOPE', amountCents: -100 });
    expect((await alice.post('/api/hashtags/unassign', { name: 'never-used', transactionIds: [tx.id] })).status).toBe(404);
  });
});

describe('bulk categorize', () => {
  let a1;
  let a2;
  let manual;

  beforeAll(async () => {
    a1 = insertTxn({ date: '2026-12-01', description: 'BULK ONE', amountCents: -100 });
    a2 = insertTxn({ date: '2026-12-02', description: 'BULK TWO', amountCents: -200 });
    manual = (await alice.post('/api/transactions', {
      accountId: acctA, date: '2026-12-03', description: 'BULK MANUAL', amountCents: -300,
    })).body;
  });

  test('applies one category to many rows and locks the imported ones', async () => {
    const res = await alice.post('/api/transactions/bulk-categorize', {
      transactionIds: [a1.id, a2.id, manual.id],
      categoryId: foodCat,
      subcategoryId: foodSub,
      businessFlag: 'business',
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(3);
    for (const t of res.body.transactions) {
      expect(t.categoryId).toBe(foodCat);
      expect(t.subcategoryId).toBe(foodSub);
      expect(t.businessFlag).toBe('business');
    }
    const byId = new Map(res.body.transactions.map((t) => [t.id, t]));
    expect(byId.get(a1.id).isLocked).toBe(true);
    expect(byId.get(a1.id).matchedKeywordId).toBe(null);
    // A manual transaction is already the user's word; locking is meaningless there.
    expect(byId.get(manual.id).isManual).toBe(true);
  });

  test('clearing the category is a deliberate uncategorization, and still locks', async () => {
    const res = await alice.post('/api/transactions/bulk-categorize', {
      transactionIds: [a1.id],
      categoryId: null,
    });
    expect(res.body.transactions[0].categoryId).toBe(null);
    expect(res.body.transactions[0].isLocked).toBe(true);
  });

  test('validates the selection, the category and the flag', async () => {
    expect((await alice.post('/api/transactions/bulk-categorize', { transactionIds: [], categoryId: foodCat })).status).toBe(400);
    expect((await alice.post('/api/transactions/bulk-categorize', { transactionIds: [a1.id], categoryId: 999999 })).status).toBe(400);
    expect(
      (await alice.post('/api/transactions/bulk-categorize', { transactionIds: [a1.id], categoryId: foodCat, businessFlag: 'nope' })).status,
    ).toBe(400);
  });

  test("another user's ids are skipped, never touched", async () => {
    const before = (await bob.get('/api/transactions?limit=all')).body.total;
    const res = await bob.post('/api/transactions/bulk-categorize', { transactionIds: [a2.id], categoryId: null });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
    expect((await bob.get('/api/transactions?limit=all')).body.total).toBe(before);
    // a2 keeps what alice gave it.
    const mine = (await alice.get(`/api/transactions?q=BULK%20TWO&limit=all`)).body.transactions[0];
    expect(mine.categoryId).toBe(foodCat);
  });
});

describe('splits', () => {
  test('splits must sum to the parent amount', async () => {
    const parent = insertTxn({ description: 'AMAZON ORDER', amountCents: -10000 });
    const bad = await alice.post(`/api/transactions/${parent.id}/splits`, {
      splits: [{ amountCents: -6000, categoryId: foodCat }, { amountCents: -3000 }],
    });
    expect(bad.status).toBe(400);
  });

  test('valid split replaces the parent with children in the list and totals', async () => {
    const parent = insertTxn({ description: 'COSTCO', amountCents: -10000 });
    const before = (await alice.get('/api/transactions')).body.summary.expense;

    const res = await alice.post(`/api/transactions/${parent.id}/splits`, {
      splits: [
        { amountCents: -6000, categoryId: foodCat, businessFlag: 'personal' },
        { amountCents: -4000, categoryId: foodCat, businessFlag: 'business' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.children).toHaveLength(2);

    const { transactions: rows, summary } = (await alice.get('/api/transactions')).body;
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(parent.id); // container hidden
    expect(rows.filter((r) => r.isSplitChild)).toHaveLength(2);
    expect(summary.expense).toBe(before); // children sum to the parent → totals unchanged

    // Remove the split → parent returns.
    const removed = await alice.del(`/api/transactions/${parent.id}/splits`);
    expect(removed.body.children).toHaveLength(0);
    expect((await alice.get('/api/transactions')).body.transactions.map((r) => r.id)).toContain(parent.id);
  });
});

describe('currency filter and sort order', () => {
  // A private month so these rows never disturb the counts other describes assert.
  const may = 'from=2026-05-01&to=2026-05-31';

  beforeAll(() => {
    insertTxn({ date: '2026-05-01', description: 'zabka nowa', amountCents: -1000, currency: 'PLN' });
    insertTxn({ date: '2026-05-02', description: 'Albert Heijn', amountCents: -2000, currency: 'EUR' });
    insertTxn({ date: '2026-05-03', description: 'ZABKA CENTRUM', amountCents: -3000, currency: 'EUR' });
    insertTxn({ date: '2026-05-04', description: 'Migros', amountCents: -4000, currency: 'CHF' });
  });

  test('facets list the currencies actually present, with counts', async () => {
    const { currencies } = (await alice.get('/api/transactions/facets')).body;
    const byCode = Object.fromEntries(currencies.map((c) => [c.currency, c.count]));
    expect(byCode.EUR).toBe(2);
    expect(byCode.CHF).toBe(1);
    expect(byCode.PLN).toBeGreaterThan(1);
  });

  test('the filter is on the transaction currency, not the account currency', async () => {
    // acctA is a PLN account holding EUR and CHF rows (the Revolut shape).
    const eur = (await alice.get(`/api/transactions?${may}&currencies=EUR`)).body;
    expect(eur.total).toBe(2);
    expect(eur.transactions.every((r) => r.currency === 'EUR')).toBe(true);
    expect(eur.summary.expense).toBe(-5000);

    const two = (await alice.get(`/api/transactions?${may}&currencies=EUR,CHF`)).body;
    expect(two.total).toBe(3);

    // Junk codes are dropped; a list of only junk filters nothing.
    expect((await alice.get(`/api/transactions?${may}&currencies=eur,zzzz,%20chf`)).body.total).toBe(3);
    expect((await alice.get(`/api/transactions?${may}&currencies=nonsense`)).body.total).toBe(4);
  });

  test('sorting by description groups repeats regardless of case', async () => {
    const sorted = (await alice.get(`/api/transactions?${may}&sort=description`)).body.transactions;
    expect(sorted.map((r) => r.description)).toEqual(['Albert Heijn', 'Migros', 'ZABKA CENTRUM', 'zabka nowa']);
  });

  test('date sorts both ways, and an unknown sort falls back to newest first', async () => {
    const asc = (await alice.get(`/api/transactions?${may}&sort=date_asc`)).body.transactions;
    expect(asc.map((r) => r.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04']);

    const bogus = (await alice.get(`/api/transactions?${may}&sort=whatever`)).body.transactions;
    expect(bogus.map((r) => r.date)).toEqual(['2026-05-04', '2026-05-03', '2026-05-02', '2026-05-01']);
  });

  test('sorting by value ranks on the size of the movement, ignoring its sign', async () => {
    // Its own month, so these rows never disturb the counts asserted above.
    const june = 'from=2026-06-01&to=2026-06-30';
    insertTxn({ date: '2026-06-01', description: 'VAL small', amountCents: -1000 });
    insertTxn({ date: '2026-06-02', description: 'VAL medium', amountCents: -4000 });
    // An income row bigger than every expense must lead the "largest" order.
    insertTxn({ date: '2026-06-03', description: 'VAL salary', amountCents: 500000 });

    const big = (await alice.get(`/api/transactions?${june}&sort=amount_desc`)).body.transactions;
    expect(big.map((r) => r.amountCents)).toEqual([500000, -4000, -1000]);

    const small = (await alice.get(`/api/transactions?${june}&sort=amount_asc`)).body.transactions;
    expect(small.map((r) => r.amountCents)).toEqual([-1000, -4000, 500000]);
  });

  test('limit=all (and limit=0) loads every matching row, ignoring paging', async () => {
    const paged = (await alice.get(`/api/transactions?${may}&limit=2`)).body;
    expect(paged.transactions).toHaveLength(2);
    expect(paged.total).toBe(4);

    for (const limit of ['all', '0']) {
      const every = (await alice.get(`/api/transactions?${may}&limit=${limit}`)).body;
      expect(every.transactions).toHaveLength(4);
      expect(every.total).toBe(4);
    }

    // A junk limit falls back to the default page size rather than everything.
    expect((await alice.get(`/api/transactions?${may}&limit=abc`)).body.transactions).toHaveLength(4);
  });

  test('paging a description sort neither repeats nor skips a row', async () => {
    const first = (await alice.get(`/api/transactions?${may}&sort=description&limit=2`)).body.transactions;
    const second = (await alice.get(`/api/transactions?${may}&sort=description&limit=2&offset=2`)).body.transactions;
    expect([...first, ...second].map((r) => r.id)).toHaveLength(4);
    expect(new Set([...first, ...second].map((r) => r.id)).size).toBe(4);
  });
});

describe('month toggles (the explore period picker)', () => {
  // Three separate months so a *set* of months proves something a range cannot.
  beforeAll(() => {
    insertTxn({ date: '2026-08-10', description: 'MTH aug', amountCents: -100 });
    insertTxn({ date: '2026-09-10', description: 'MTH sep', amountCents: -200 });
    insertTxn({ date: '2026-10-10', description: 'MTH oct', amountCents: -300 });
  });

  const only = (rows) => rows.filter((r) => r.description.startsWith('MTH ')).map((r) => r.description).sort();

  test('a set of months selects exactly those months, gaps and all', async () => {
    const two = (await alice.get('/api/transactions?months=2026-08,2026-10&limit=all')).body;
    expect(only(two.transactions)).toEqual(['MTH aug', 'MTH oct']);

    const one = (await alice.get('/api/transactions?months=2026-09&limit=all')).body;
    expect(only(one.transactions)).toEqual(['MTH sep']);
  });

  test('months and a date range AND together, and junk months are dropped', async () => {
    const both = (await alice.get('/api/transactions?months=2026-08,2026-09,2026-10&from=2026-09-01&limit=all')).body;
    expect(only(both.transactions)).toEqual(['MTH oct', 'MTH sep']);

    // Only junk: the whole filter is dropped rather than matching nothing.
    const junk = (await alice.get('/api/transactions?months=nonsense&limit=all')).body;
    expect(only(junk.transactions)).toEqual(['MTH aug', 'MTH oct', 'MTH sep']);
  });

  test('the reports share the filter, so a chart and the list agree', async () => {
    const { months } = (await alice.get('/api/reports/monthly?months=2026-08,2026-10')).body;
    // monthRange fills September in between, but with nothing in it.
    expect(months.map((m) => m.ym)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(months.map((m) => m.count)).toEqual([1, 0, 1]);
  });
});

describe('sorting by account and category', () => {
  const nov = 'from=2024-12-01&to=2024-12-31&includeHidden=1';

  beforeAll(() => {
    insertTxn({ date: '2024-12-01', description: 'SORT one', accountId: acctB, categoryId: foodCat, subcategoryId: foodSub });
    insertTxn({ date: '2024-12-02', description: 'SORT two', accountId: acctA, categoryId: hiddenCat });
    insertTxn({ date: '2024-12-03', description: 'SORT three', accountId: acctB });
  });

  test('account sorts by name both ways, newest first within an account', async () => {
    const asc = (await alice.get(`/api/transactions?${nov}&sort=account_asc`)).body.transactions;
    expect(asc.map((r) => r.description)).toEqual(['SORT two', 'SORT three', 'SORT one']);
    const desc = (await alice.get(`/api/transactions?${nov}&sort=account_desc`)).body.transactions;
    expect(desc.map((r) => r.description)).toEqual(['SORT three', 'SORT one', 'SORT two']);
  });

  test('category sorts by name; uncategorized leads A–Z and trails Z–A', async () => {
    const q = nov;
    const asc = (await alice.get(`/api/transactions?${q}&sort=category_asc`)).body.transactions;
    // (uncategorized) < Food & Drink < Transfer In/Out
    expect(asc.map((r) => r.description)).toEqual(['SORT three', 'SORT one', 'SORT two']);
    const desc = (await alice.get(`/api/transactions?${q}&sort=category_desc`)).body.transactions;
    expect(desc.map((r) => r.description)).toEqual(['SORT two', 'SORT one', 'SORT three']);
  });

  test('description sorts Z–A too', async () => {
    const desc = (await alice.get(`/api/transactions?${nov}&sort=description_desc`)).body.transactions;
    expect(desc.map((r) => r.description)).toEqual(['SORT two', 'SORT three', 'SORT one']);
  });
});

describe('grouped by description', () => {
  const jul = 'from=2026-07-01&to=2026-07-31';

  beforeAll(() => {
    // Three rows of one shop (two spellings of case/spacing), two of a
    // bigger-ticket one, one foreign row with a rate and one without.
    insertTxn({ date: '2026-07-01', description: 'GROCER Z1 KRAKOW', amountCents: -1000 });
    insertTxn({ date: '2026-07-05', description: 'grocer  z1 krakow', amountCents: -1500 });
    insertTxn({ date: '2026-07-09', description: 'GROCER Z1 KRAKOW', amountCents: -500, categoryId: foodCat });
    insertTxn({ date: '2026-07-02', description: 'GROCER Z2 KRAKOW', amountCents: -700 });
    insertTxn({ date: '2026-07-03', description: 'FURNITURE', amountCents: -50000 });
    insertTxn({ date: '2026-07-04', description: 'FURNITURE', amountCents: -30000, accountId: acctB });
    insertTxn({ date: '2026-07-06', description: 'US SHOP', amountCents: -1000, currency: 'USD' });
    insertTxn({ date: '2026-07-07', description: 'UK SHOP', amountCents: -2000, currency: 'GBP' });
    db.insert(fxRates).values({ userId: aliceId, date: '2026-07-01', fromCcy: 'USD', toCcy: 'PLN', rate: 4 }).run();
  });

  test('one line per description, case and spacing ignored, ranked by |total|', async () => {
    const res = (await alice.get(`/api/transactions/groups?${jul}`)).body;
    expect(res.total).toBe(8);
    expect(res.totalGroups).toBe(5);
    expect(res.summary.expense).toBe(-(1000 + 1500 + 500 + 700 + 50000 + 30000 + 1000 + 2000));

    const [furniture, us, grocer] = res.groups;
    expect(furniture).toMatchObject({ description: 'FURNITURE', count: 2, totalCents: -80000, currency: 'PLN', accountName: null, accountCount: 2 });
    expect(furniture.ids).toHaveLength(2);
    // Converted at 4 PLN/USD before it is summed.
    expect(us).toMatchObject({ description: 'US SHOP', totalCents: -4000, currency: 'PLN', converted: true });
    expect(grocer).toMatchObject({
      description: 'GROCER Z1 KRAKOW', count: 3, variantCount: 2, totalCents: -3000,
      firstDate: '2026-07-01', lastDate: '2026-07-09', category: null, categoryCount: 2, uncategorizedCount: 2,
    });
  });

  test('a group no rate reaches keeps its own currency, flagged', async () => {
    const uk = (await alice.get(`/api/transactions/groups?${jul}`)).body.groups.find((g) => g.description === 'UK SHOP');
    expect(uk).toMatchObject({ totalCents: -2000, currency: 'GBP', converted: false });
  });

  test('ranks by count, by description and by date too', async () => {
    const byCount = (await alice.get(`/api/transactions/groups?${jul}&sort=count_desc`)).body.groups;
    expect(byCount.map((g) => g.count)).toEqual([3, 2, 1, 1, 1]);
    const byName = (await alice.get(`/api/transactions/groups?${jul}&sort=description`)).body.groups;
    expect(byName.map((g) => g.description)).toEqual(['FURNITURE', 'GROCER Z1 KRAKOW', 'GROCER Z2 KRAKOW', 'UK SHOP', 'US SHOP']);
    const recent = (await alice.get(`/api/transactions/groups?${jul}&sort=date_desc`)).body.groups;
    expect(recent[0].description).toBe('GROCER Z1 KRAKOW');
  });

  test('merchant mode folds branch numbers together', async () => {
    const res = (await alice.get(`/api/transactions/groups?${jul}&groupBy=merchant&sort=count_desc`)).body;
    expect(res.totalGroups).toBe(4);
    expect(res.groups[0]).toMatchObject({ key: 'grocer krakow', count: 4, variantCount: 3 });
  });

  test('pages over groups, and the list filters apply', async () => {
    const first = (await alice.get(`/api/transactions/groups?${jul}&limit=2`)).body;
    const rest = (await alice.get(`/api/transactions/groups?${jul}&limit=2&offset=2`)).body;
    expect(first.groups).toHaveLength(2);
    expect(first.totalGroups).toBe(5);
    expect(new Set([...first.groups, ...rest.groups].map((g) => g.key)).size).toBe(4);

    const uncat = (await alice.get(`/api/transactions/groups?${jul}&uncategorized=1`)).body;
    expect(uncat.groups.find((g) => g.key === 'grocer z1 krakow').count).toBe(2);
  });

  test('members returns the rows behind one group', async () => {
    const res = (await alice.get(`/api/transactions/groups/members?${jul}&key=${encodeURIComponent('grocer z1 krakow')}`)).body;
    expect(res.transactions.map((t) => t.date)).toEqual(['2026-07-09', '2026-07-05', '2026-07-01']);
    expect((await alice.get(`/api/transactions/groups/members?${jul}&key=nope`)).body.transactions).toEqual([]);
  });

  test('another user sees none of it', async () => {
    const res = (await bob.get(`/api/transactions/groups?${jul}`)).body;
    expect(res.total).toBe(0);
    expect(res.groups).toEqual([]);
    expect((await bob.get(`/api/transactions/groups/members?${jul}&key=furniture`)).body.transactions).toEqual([]);
  });
});

describe('free-text search and the keyword filter', () => {
  let kwId;

  beforeAll(async () => {
    insertTxn({ date: '2026-11-02', description: 'QQMART 123 WARSZAWA', amountCents: -4200 });
    insertTxn({ date: '2026-11-03', description: 'qqmart krakow', amountCents: -1100 });
    insertTxn({ date: '2026-11-04', description: 'ZZSHOP WARSZAWA', amountCents: -900 });
    insertTxn({ date: '2026-11-05', description: 'FEE 100% OF NOTHING', amountCents: -100 });
    // A keyword categorizes the two QQMART rows (the recompute runs on save),
    // which is what the keyword filter then selects on.
    kwId = (await alice.post('/api/keywords', { text: 'qqmart', categoryId: foodCat })).body.id;
  });

  const descs = (body) => body.transactions.map((t) => t.description).sort();

  test('q matches the description, case-insensitively', async () => {
    const res = (await alice.get('/api/transactions?q=QQMART&limit=all')).body;
    expect(descs(res)).toEqual(['QQMART 123 WARSZAWA', 'qqmart krakow']);
    expect(res.total).toBe(2);
    expect(res.summary.expense).toBe(-5300);
  });

  test('every term has to appear, so a second word narrows', async () => {
    const one = (await alice.get('/api/transactions?q=warszawa&limit=all')).body;
    expect(descs(one)).toEqual(['QQMART 123 WARSZAWA', 'ZZSHOP WARSZAWA'].sort());

    const two = (await alice.get('/api/transactions?q=warszawa%20qqmart&limit=all')).body;
    expect(descs(two)).toEqual(['QQMART 123 WARSZAWA']);
  });

  test("LIKE's wildcards are literal text, not patterns", async () => {
    const pct = (await alice.get('/api/transactions?q=100%25&limit=all')).body;
    expect(descs(pct)).toEqual(['FEE 100% OF NOTHING']);

    // '_' would match any single character if it were not escaped.
    const underscore = (await alice.get('/api/transactions?q=_&limit=all')).body;
    expect(underscore.total).toBe(0);
  });

  test('a blank query is no filter at all', async () => {
    const blank = (await alice.get('/api/transactions?q=%20%20&limit=all')).body;
    const none = (await alice.get('/api/transactions?limit=all')).body;
    expect(blank.total).toBe(none.total);
  });

  test('keywordIds selects the rows one rule caught; 0 selects the rows none did', async () => {
    const caught = (await alice.get(`/api/transactions?keywordIds=${kwId}&limit=all`)).body;
    expect(descs(caught)).toEqual(['QQMART 123 WARSZAWA', 'qqmart krakow']);
    caught.transactions.forEach((t) => expect(t.matchedKeyword).toMatchObject({ id: kwId, text: 'qqmart' }));

    const uncaught = (await alice.get(`/api/transactions?keywordIds=0&limit=all`)).body;
    expect(uncaught.transactions.some((t) => t.matchedKeywordId != null)).toBe(false);
    expect(descs(uncaught)).toContain('ZZSHOP WARSZAWA');

    // The two halves OR back together into the whole list.
    const both = (await alice.get(`/api/transactions?keywordIds=0,${kwId}&limit=all`)).body;
    expect(both.total).toBe(caught.total + uncaught.total);
  });

  test('facets count the keywords that actually caught something', async () => {
    const facets = (await alice.get('/api/transactions/facets')).body;
    expect(facets.keywords).toContainEqual({ keywordId: kwId, text: 'qqmart', count: 2 });
    expect(facets.noKeyword).toBeGreaterThan(0);
  });

  test('search and the keyword filter AND with everything else', async () => {
    const res = (await alice.get(`/api/transactions?q=krakow&keywordIds=${kwId}&type=expense&limit=all`)).body;
    expect(descs(res)).toEqual(['qqmart krakow']);
  });

  test('the reports see the same rows', async () => {
    const { months } = (await alice.get('/api/reports/monthly?q=qqmart&months=2026-11')).body;
    expect(months).toEqual([{ ym: '2026-11', income: 0, expense: -5300, net: -5300, count: 2 }]);
  });
});

describe('isolation', () => {
  test("a user cannot read or mutate another user's transactions", async () => {
    const tx = insertTxn({ description: 'PRIVATE', amountCents: -1 });
    expect((await bob.get('/api/transactions')).body.transactions.find((r) => r.id === tx.id)).toBeUndefined();
    expect((await bob.patch(`/api/transactions/${tx.id}`, { businessFlag: 'business' })).status).toBe(404);
    expect((await bob.post(`/api/transactions/${tx.id}/hashtags`, { name: 'x' })).status).toBe(404);
    expect((await bob.post(`/api/transactions/${tx.id}/splits`, { splits: [] })).status).toBe(404);
  });
});
