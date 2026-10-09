import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { categories, subcategories, keywords } from '../src/db/schema.js';

let alice;
let bob;
let aliceId;

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  aliceId = (await createUser(admin, 'catalice', 'password1')).id;
  await createUser(admin, 'catbob', 'password1');
  admin.close();

  alice = await startTestClient();
  bob = await startTestClient();
  await alice.post('/api/auth/login', { username: 'catalice', password: 'password1' });
  await bob.post('/api/auth/login', { username: 'catbob', password: 'password1' });
});
afterAll(() => {
  alice.close();
  bob.close();
});

describe('seeding', () => {
  test('a new user gets the seeded categories with the special-case rules applied', async () => {
    const list = (await alice.get('/api/categories')).body;
    const byName = new Map(list.map((c) => [c.name, c]));

    // Unknown dropped; Cash Withdrawal appended; Transfer In/Out hidden; Company business.
    expect(byName.has('Unknown')).toBe(false);
    expect(byName.get('Cash Withdrawal').isCashWithdrawal).toBe(true);
    expect(byName.get('Transfer In/Out').isHidden).toBe(true);
    expect(byName.get('Company').businessDefault).toBe('business');
    expect(byName.get('Food & Drink').businessDefault).toBe('personal');

    // Default icons are seeded from the curated pool.
    expect(byName.get('Food & Drink').icon).toBe('utensils');
    expect(byName.get('Cash Withdrawal').icon).toBe('banknote');
    const groceriesSub = byName.get('Food & Drink').subcategories.find((s) => s.name === 'Groceries');
    expect(groceriesSub.icon).toBe('shopping-cart');

    // Subcategories and keyword counts flow through.
    const food = byName.get('Food & Drink');
    const groceries = food.subcategories.find((s) => s.name === 'Groceries');
    expect(groceries.keywordCount).toBeGreaterThan(0);
  });

  test('the seed file is the export format: one Cash Withdrawal, category-level keywords kept', async () => {
    const list = (await alice.get('/api/categories')).body;
    expect(list.filter((c) => c.isCashWithdrawal)).toHaveLength(1);
    const exported = (await alice.get('/api/categories/export')).body;
    const merch = exported.categories.find((c) => c.name === 'General Merchandise');
    expect(merch.keywords).toContain('OLX'); // a keyword on the category itself, no subcategory
  });

  test('seeded keyword rows exist for the user', () => {
    const n = db.select().from(keywords).where(eq(keywords.userId, aliceId)).all().length;
    expect(n).toBeGreaterThan(100);
  });
});

describe('category CRUD', () => {
  test('create validates name and businessDefault', async () => {
    expect((await alice.post('/api/categories', { name: '  ' })).status).toBe(400);
    expect((await alice.post('/api/categories', { name: 'X', businessDefault: 'nope' })).status).toBe(400);

    const created = await alice.post('/api/categories', { name: 'Hobbies', businessDefault: 'mixed', icon: 'music' });
    expect(created.status).toBe(201);
    expect(created.body.businessDefault).toBe('mixed');
    expect(created.body.isHidden).toBe(false);
    expect(created.body.icon).toBe('music');
  });

  test('icon can be set and cleared on a category and subcategory', async () => {
    const cat = (await alice.post('/api/categories', { name: 'Iconic', icon: 'star' })).body;
    expect(cat.icon).toBe('star');
    const cleared = await alice.patch(`/api/categories/${cat.id}`, { icon: null });
    expect(cleared.body.icon).toBeNull();

    const sub = (await alice.post(`/api/categories/${cat.id}/subcategories`, { name: 'S', icon: 'tag' })).body;
    expect(sub.icon).toBe('tag');
    const subUpdated = await alice.patch(`/api/subcategories/${sub.id}`, { name: 'S', icon: 'gift' });
    expect(subUpdated.body.icon).toBe('gift');
  });

  test('patch updates flags (bulk mark-business is just a businessDefault edit)', async () => {
    const cat = (await alice.post('/api/categories', { name: 'ZUS test' })).body;
    const updated = await alice.patch(`/api/categories/${cat.id}`, { businessDefault: 'business', isHidden: true });
    expect(updated.body.businessDefault).toBe('business');
    expect(updated.body.isHidden).toBe(true);
  });

  test('subcategory create, rename, and delete', async () => {
    const cat = (await alice.post('/api/categories', { name: 'Pets' })).body;
    const sub = await alice.post(`/api/categories/${cat.id}/subcategories`, { name: 'Vet' });
    expect(sub.status).toBe(201);

    const renamed = await alice.patch(`/api/subcategories/${sub.body.id}`, { name: 'Veterinary' });
    expect(renamed.body.name).toBe('Veterinary');

    expect((await alice.del(`/api/subcategories/${sub.body.id}`)).status).toBe(204);
    const cats = (await alice.get('/api/categories')).body.find((c) => c.id === cat.id);
    expect(cats.subcategories).toHaveLength(0);
  });

  test('a subcategory can be moved to another category, taking its rows along', async () => {
    const from = (await alice.post('/api/categories', { name: 'Move From' })).body;
    const to = (await alice.post('/api/categories', { name: 'Move To' })).body;
    const sub = (await alice.post(`/api/categories/${from.id}/subcategories`, { name: 'Roaming' })).body;
    const kw = db
      .insert(keywords)
      .values({ userId: aliceId, categoryId: from.id, subcategoryId: sub.id, text: 'roam-me' })
      .returning()
      .get();

    const moved = await alice.patch(`/api/subcategories/${sub.id}`, { name: 'Roaming', categoryId: to.id });
    expect(moved.status).toBe(200);
    expect(moved.body.categoryId).toBe(to.id);

    // The keyword follows, so it no longer claims the old category.
    expect(db.select().from(keywords).where(eq(keywords.id, kw.id)).get().categoryId).toBe(to.id);

    const list = (await alice.get('/api/categories')).body;
    expect(list.find((c) => c.id === from.id).subcategories).toHaveLength(0);
    expect(list.find((c) => c.id === to.id).subcategories.map((s) => s.name)).toContain('Roaming');
  });

  test('moving a subcategory to a category you do not own is rejected', async () => {
    const bobCat = (await bob.post('/api/categories', { name: 'Bob Only' })).body;
    const cat = (await alice.post('/api/categories', { name: 'Alice Only' })).body;
    const sub = (await alice.post(`/api/categories/${cat.id}/subcategories`, { name: 'S' })).body;
    const res = await alice.patch(`/api/subcategories/${sub.id}`, { name: 'S', categoryId: bobCat.id });
    expect(res.status).toBe(404);
  });

  test('deleting a category cascades its subcategories and keywords', async () => {
    const cat = (await alice.get('/api/categories')).body.find((c) => c.name === 'Food & Drink');
    expect((await alice.del(`/api/categories/${cat.id}`)).status).toBe(204);
    expect(db.select().from(subcategories).where(eq(subcategories.categoryId, cat.id)).all()).toHaveLength(0);
    expect(db.select().from(keywords).where(eq(keywords.categoryId, cat.id)).all()).toHaveLength(0);
  });
});

describe('export / import round-trip', () => {
  test('export produces the seed shape and import replaces the tree', async () => {
    const exported = (await bob.get('/api/categories/export')).body;
    expect(Array.isArray(exported.categories)).toBe(true);
    const sample = exported.categories.find((c) => c.subcategories.some((s) => s.keywords.length));
    expect(sample.subcategories[0]).toHaveProperty('keywords');

    // Import a small tree — it fully replaces the existing one.
    const payload = {
      categories: [
        {
          name: 'Only Category',
          icon: 'star',
          businessDefault: 'business',
          isHidden: true,
          subcategories: [{ name: 'Sub A', icon: 'tag', keywords: ['foo', 'bar'] }],
        },
      ],
    };
    expect((await bob.post('/api/categories/import', payload)).status).toBe(204);

    const after = (await bob.get('/api/categories')).body;
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('Only Category');
    expect(after[0].icon).toBe('star');
    expect(after[0].businessDefault).toBe('business');
    expect(after[0].isHidden).toBe(true);
    expect(after[0].subcategories[0].icon).toBe('tag');
    expect(after[0].subcategories[0].keywordCount).toBe(2);
  });

  test('import rejects a malformed body', async () => {
    expect((await bob.post('/api/categories/import', { categories: 'nope' })).status).toBe(400);
    expect((await bob.post('/api/categories/import', { categories: [{ name: '' }] })).status).toBe(400);
  });
});

describe('isolation', () => {
  test("a user cannot read or mutate another user's categories", async () => {
    const aliceCat = (await alice.get('/api/categories')).body[0];
    expect((await bob.get('/api/categories')).body.find((c) => c.id === aliceCat.id)).toBeUndefined();
    expect((await bob.patch(`/api/categories/${aliceCat.id}`, { name: 'hacked' })).status).toBe(404);
    expect((await bob.del(`/api/categories/${aliceCat.id}`)).status).toBe(404);
    expect((await bob.post(`/api/categories/${aliceCat.id}/subcategories`, { name: 'x' })).status).toBe(404);
  });
});

describe('volume on the category list', () => {
  let instId;
  let acctId;
  let catId;
  let subId;

  beforeAll(async () => {
    instId = (await alice.post('/api/institutions', { name: 'Volume Bank' })).body.id;
    acctId = (await alice.post('/api/accounts', { institutionId: instId, name: 'Main', currency: 'PLN' })).body.id;

    const cat = (await alice.post('/api/categories', { name: 'Volume Test' })).body;
    catId = cat.id;
    subId = (await alice.post(`/api/categories/${catId}/subcategories`, { name: 'Sub One' })).body.id;

    // Two rows on the subcategory, one on the category alone.
    for (const [description, amountCents, sub] of [
      ['VOL ONE', -2500, true],
      ['VOL TWO', -1500, true],
      ['VOL THREE', -1000, false],
    ]) {
      await alice.post('/api/transactions', {
        accountId: acctId,
        date: '2026-04-01',
        description,
        amountCents,
        categoryId: catId,
        ...(sub ? { subcategoryId: subId } : {}),
      });
    }
  });

  test('a category reports its transactions and their net', async () => {
    const c = (await alice.get('/api/categories')).body.find((x) => x.id === catId);
    expect(c.txCount).toBe(3);
    expect(c.amountCents).toBe(-5000);
  });

  test('a subcategory reports only its own rows', async () => {
    const c = (await alice.get('/api/categories')).body.find((x) => x.id === catId);
    const sub = c.subcategories.find((s) => s.id === subId);
    expect(sub.txCount).toBe(2);
    expect(sub.amountCents).toBe(-4000);
  });

  test('a category with nothing in it reports zeros', async () => {
    const empty = (await alice.post('/api/categories', { name: 'Empty Test' })).body;
    const c = (await alice.get('/api/categories')).body.find((x) => x.id === empty.id);
    expect(c.txCount).toBe(0);
    expect(c.amountCents).toBe(0);
    expect(c.keywordCount).toBe(0);
  });

  test('a split counts once, through its children', async () => {
    const tx = (await alice.get('/api/transactions?q=VOL THREE')).body.transactions[0];
    const split = await alice.post(`/api/transactions/${tx.id}/splits`, {
      splits: [
        { amountCents: -600, categoryId: catId },
        { amountCents: -400, categoryId: catId },
      ],
    });
    expect(split.status).toBe(201);

    const c = (await alice.get('/api/categories')).body.find((x) => x.id === catId);
    // The parent leaves the count, its two children join it: 2 + 2 = 4 rows,
    // and the money is unchanged because the children sum to the parent.
    expect(c.txCount).toBe(4);
    expect(c.amountCents).toBe(-5000);
  });

  test('a category counts the keywords pointing at it, subcategories included', async () => {
    await alice.post('/api/keywords', { text: 'volumekw', categoryId: catId });
    await alice.post('/api/keywords', { text: 'volumesubkw', categoryId: catId, subcategoryId: subId });
    const c = (await alice.get('/api/categories')).body.find((x) => x.id === catId);
    expect(c.keywordCount).toBe(2);
    expect(c.subcategories.find((s) => s.id === subId).keywordCount).toBe(1);
  });
});
