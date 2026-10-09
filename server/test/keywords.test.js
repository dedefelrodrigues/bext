import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { institutions, accounts, categories, subcategories, keywords, transactions } from '../src/db/schema.js';

let alice;
let bob;
let aliceId;
let bobId;
let accountId;
let foodCatId;
let groceriesSubId;

// Inserts a bare imported transaction for a user's account and returns its id.
function insertTxn(userId, description, overrides = {}) {
  return db
    .insert(transactions)
    .values({
      userId,
      accountId,
      date: '2026-01-01',
      description,
      amountCents: -1000,
      currency: 'PLN',
      dedupKey: `${description}|${Math.random()}`,
      ...overrides,
    })
    .returning()
    .get().id;
}

function txn(id) {
  return db.select().from(transactions).where(eq(transactions.id, id)).get();
}

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  aliceId = (await createUser(admin, 'kwalice', 'password1')).id;
  bobId = (await createUser(admin, 'kwbob', 'password1')).id;
  admin.close();

  alice = await startTestClient();
  bob = await startTestClient();
  await alice.post('/api/auth/login', { username: 'kwalice', password: 'password1' });
  await bob.post('/api/auth/login', { username: 'kwbob', password: 'password1' });

  // A minimal institution + account for alice so transactions have a home.
  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Test Bank' }).returning().get();
  accountId = db
    .insert(accounts)
    .values({ userId: aliceId, institutionId: inst.id, name: 'Checking', currency: 'PLN', holder: 'kwalice' })
    .returning()
    .get().id;

  const cats = (await alice.get('/api/categories')).body;
  const food = cats.find((c) => c.name === 'Food & Drink');
  foodCatId = food.id;
  groceriesSubId = food.subcategories.find((s) => s.name === 'Groceries').id;
});

afterAll(() => {
  alice.close();
  bob.close();
});

describe('keyword CRUD + validation', () => {
  test('create requires text and a valid owned category', async () => {
    expect((await alice.post('/api/keywords', { text: '', categoryId: foodCatId })).status).toBe(400);
    expect((await alice.post('/api/keywords', { text: 'x', categoryId: 999999 })).status).toBe(404);

    const created = await alice.post('/api/keywords', {
      text: 'zabka',
      categoryId: foodCatId,
      subcategoryId: groceriesSubId,
      distance: 1,
    });
    expect(created.status).toBe(201);
    expect(created.body.text).toBe('zabka');
    expect(created.body.subcategoryId).toBe(groceriesSubId);
    expect(created.body.distance).toBe(1);
  });

  test('subcategory must belong to the chosen category', async () => {
    const other = (await alice.post('/api/categories', { name: 'Other Cat' })).body;
    const res = await alice.post('/api/keywords', { text: 'nope', categoryId: other.id, subcategoryId: groceriesSubId });
    expect(res.status).toBe(400);
  });

  test('patch updates fields and validates distance', async () => {
    const k = (await alice.post('/api/keywords', { text: 'orlen', categoryId: foodCatId })).body;
    expect((await alice.patch(`/api/keywords/${k.id}`, { distance: -1 })).status).toBe(400);
    const upd = await alice.patch(`/api/keywords/${k.id}`, { text: 'orlen stacja', distance: 2 });
    expect(upd.body.text).toBe('orlen stacja');
    expect(upd.body.distance).toBe(2);
    // Clearing the override sends it back to the global distance.
    const cleared = await alice.patch(`/api/keywords/${k.id}`, { distance: null });
    expect(cleared.body.distance).toBeNull();
  });

  test('changing category detaches a now-mismatched subcategory', async () => {
    const k = (await alice.post('/api/keywords', { text: 'detachme', categoryId: foodCatId, subcategoryId: groceriesSubId })).body;
    const other = (await alice.post('/api/categories', { name: 'Detach Target' })).body;
    const upd = await alice.patch(`/api/keywords/${k.id}`, { categoryId: other.id });
    expect(upd.body.categoryId).toBe(other.id);
    expect(upd.body.subcategoryId).toBeNull();
  });

  test('delete removes the keyword', async () => {
    const k = (await alice.post('/api/keywords', { text: 'deleteme', categoryId: foodCatId })).body;
    expect((await alice.del(`/api/keywords/${k.id}`)).status).toBe(204);
    expect((await alice.get('/api/keywords')).body.find((x) => x.id === k.id)).toBeUndefined();
  });
});

describe('CSV export / import', () => {
  test('export yields a header + rows resolving names', async () => {
    const { csv } = (await alice.get('/api/keywords/export')).body;
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('keyword,category,subcategory,distance');
    expect(lines.length).toBeGreaterThan(1);
  });

  test('import replaces the keyword set, matching names, and rejects unknown categories', async () => {
    // bob starts from his seeded keywords; import fully replaces them.
    const csv = 'keyword,category,subcategory,distance\ncarrefour,Food & Drink,Groceries,2\nsalary,Income,,\n';
    const res = await bob.post('/api/keywords/import', { csv });
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(2);

    const after = (await bob.get('/api/keywords')).body;
    expect(after).toHaveLength(2);
    const carrefour = after.find((k) => k.text === 'carrefour');
    expect(carrefour.distance).toBe(2);

    // Unknown category → whole import rejected.
    const bad = await bob.post('/api/keywords/import', { csv: 'keyword,category,subcategory,distance\nx,No Such Cat,,\n' });
    expect(bad.status).toBe(400);
    // The prior import survived (all-or-nothing).
    expect((await bob.get('/api/keywords')).body).toHaveLength(2);
  });

  test('CSV round-trips through export → import', async () => {
    const exported = (await bob.get('/api/keywords/export')).body.csv;
    const res = await bob.post('/api/keywords/import', { csv: exported });
    expect(res.status).toBe(201);
    expect((await bob.get('/api/keywords')).body).toHaveLength(2);
  });
});

// These use invented merchant tokens (≥5 chars, absent from the seed) so the
// assertions test only the keywords created here, not the seeded ruleset.
describe('recompute on rule changes', () => {
  test('creating a keyword classifies matching non-locked transactions', async () => {
    const t1 = insertTxn(aliceId, 'PLATNOSC ZORPTECH WARSZAWA');
    const t2 = insertTxn(aliceId, 'QUUXMART FUELING');
    const cat = (await alice.post('/api/categories', { name: 'Recompute Cat' })).body;

    await alice.post('/api/keywords', { text: 'zorptech', categoryId: cat.id, distance: 0 });
    expect(txn(t1).categoryId).toBe(cat.id);
    expect(txn(t2).categoryId).toBeNull();
  });

  test('locked and manual transactions are never touched', async () => {
    const locked = insertTxn(aliceId, 'WOMBLE STORE', { isLocked: true, categoryId: foodCatId });
    const manual = insertTxn(aliceId, 'WOMBLE STORE', { isManual: true });
    const cat = (await alice.post('/api/categories', { name: 'Lock Test Cat' })).body;

    await alice.post('/api/keywords', { text: 'womble', categoryId: cat.id, distance: 0 });
    expect(txn(locked).categoryId).toBe(foodCatId); // preserved
    expect(txn(manual).categoryId).toBeNull(); // untouched
  });

  test('deleting a keyword reverts its matched transactions to uncategorized', async () => {
    const tx = insertTxn(aliceId, 'VBNSTORE PURCHASE');
    const cat = (await alice.post('/api/categories', { name: 'Revert Cat' })).body;
    const k = (await alice.post('/api/keywords', { text: 'vbnstore', categoryId: cat.id, distance: 0 })).body;
    expect(txn(tx).categoryId).toBe(cat.id);
    expect(txn(tx).matchedKeywordId).toBe(k.id);

    await alice.del(`/api/keywords/${k.id}`);
    expect(txn(tx).categoryId).toBeNull();
    expect(txn(tx).matchedKeywordId).toBeNull();
  });

  test('longer keyword re-wins on the next recompute', async () => {
    const tx = insertTxn(aliceId, 'WUMPUS FROBNICATE CENTRUM');
    const short = (await alice.post('/api/categories', { name: 'Short Win' })).body;
    const long = (await alice.post('/api/categories', { name: 'Long Win' })).body;

    await alice.post('/api/keywords', { text: 'wumpus', categoryId: short.id, distance: 0 });
    expect(txn(tx).categoryId).toBe(short.id);

    await alice.post('/api/keywords', { text: 'wumpus frobnicate', categoryId: long.id, distance: 0 });
    expect(txn(tx).categoryId).toBe(long.id);
  });
});

describe('isolation', () => {
  test("a user cannot read or mutate another user's keywords", async () => {
    const aliceKw = (await alice.get('/api/keywords')).body[0];
    expect((await bob.get('/api/keywords')).body.find((k) => k.id === aliceKw.id)).toBeUndefined();
    expect((await bob.patch(`/api/keywords/${aliceKw.id}`, { text: 'hacked' })).status).toBe(404);
    expect((await bob.del(`/api/keywords/${aliceKw.id}`)).status).toBe(404);
  });

  test("a user cannot attach a keyword to another user's category", async () => {
    const aliceCat = (await alice.get('/api/categories')).body[0];
    const res = await bob.post('/api/keywords', { text: 'x', categoryId: aliceCat.id });
    expect(res.status).toBe(404);
  });
});

describe('match counts on the list', () => {
  let kwId;

  beforeAll(async () => {
    // A rule and three transactions it classifies, plus one it does not.
    kwId = (await alice.post('/api/keywords', { text: 'yieldshop', categoryId: foodCatId })).body.id;
    for (let i = 0; i < 3; i++) insertTxn(aliceId, `YIELDSHOP BRANCH ${i}`);
    insertTxn(aliceId, 'SOMETHING ELSE ENTIRELY');
    await alice.post('/api/keywords/recompute');
  });

  test('a rule reports how many transactions it owns', async () => {
    const k = (await alice.get('/api/keywords')).body.find((x) => x.id === kwId);
    expect(k.matchCount).toBe(3);
  });

  test('a rule that matches nothing reports zero, not undefined', async () => {
    const dead = (await alice.post('/api/keywords', { text: 'nosuchmerchantanywhere', categoryId: foodCatId })).body;
    const k = (await alice.get('/api/keywords')).body.find((x) => x.id === dead.id);
    expect(k.matchCount).toBe(0);
  });

  test('the count matches what ?keywordIds= lists, splits included', async () => {
    const listed = (await alice.get(`/api/transactions?keywordIds=${kwId}`)).body.total;
    const k = (await alice.get('/api/keywords')).body.find((x) => x.id === kwId);
    expect(k.matchCount).toBe(listed);

    // Splitting one of them makes it a container: the children carry the money,
    // so both the count and the list drop it rather than counting it twice.
    const target = (await alice.get(`/api/transactions?keywordIds=${kwId}`)).body.transactions[0];
    const split = await alice.post(`/api/transactions/${target.id}/splits`, {
      splits: [{ amountCents: -600 }, { amountCents: -400 }],
    });
    expect(split.status).toBe(201);

    const after = (await alice.get('/api/keywords')).body.find((x) => x.id === kwId);
    const listedAfter = (await alice.get(`/api/transactions?keywordIds=${kwId}`)).body.total;
    expect(after.matchCount).toBe(2);
    expect(after.matchCount).toBe(listedAfter);
  });

  test("counts never include another user's rows", async () => {
    const bobCats = (await bob.get('/api/categories')).body;
    const bobKw = (await bob.post('/api/keywords', { text: 'yieldshop', categoryId: bobCats[0].id })).body;
    const k = (await bob.get('/api/keywords')).body.find((x) => x.id === bobKw.id);
    expect(k.matchCount).toBe(0);
  });
});
