import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import {
  institutions,
  accounts,
  categories,
  keywords,
  transactions,
  uploads,
  hashtags,
  transactionHashtags,
  fxRates,
} from '../src/db/schema.js';

// Two ordinary users with their own data, to prove the wipe is scoped to the caller.
let alice; // owns the data under test
let bob; // must be untouched
let aliceId;
let bobId;
let acct;
let bobAcct;

function insertTxn(userId, accountId, overrides = {}) {
  const desc = overrides.description ?? `TXN ${Math.random()}`;
  return db
    .insert(transactions)
    .values({
      userId,
      accountId,
      date: '2026-02-01',
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
  aliceId = (await createUser(admin, 'clearalice', 'password1')).id;
  bobId = (await createUser(admin, 'clearbob', 'password1')).id;
  admin.close();

  alice = await startTestClient();
  bob = await startTestClient();
  await alice.post('/api/auth/login', { username: 'clearalice', password: 'password1' });
  await bob.post('/api/auth/login', { username: 'clearbob', password: 'password1' });

  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Bank' }).returning().get();
  acct = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'Checking', currency: 'PLN', holder: 'Andre' }).returning().get().id;

  const bobInst = db.insert(institutions).values({ userId: bobId, name: 'Bank' }).returning().get();
  bobAcct = db.insert(accounts).values({ userId: bobId, institutionId: bobInst.id, name: 'Checking', currency: 'PLN', holder: 'Bob' }).returning().get().id;
});

afterAll(() => {
  alice.close();
  bob.close();
});

// Rebuilds a representative dataset: an upload with imported rows, a locked
// (manually categorized) row, a parent/child split, a hashtag link, a manual
// entry with no uploadId, and one row belonging to the other user.
function seedData() {
  const upload = db
    .insert(uploads)
    .values({ userId: aliceId, accountId: acct, filename: 'x.csv', totalRows: 3, importedCount: 3 })
    .returning()
    .get();

  insertTxn(aliceId, acct, { uploadId: upload.id });
  insertTxn(aliceId, acct, { uploadId: upload.id, isLocked: true });
  const parent = insertTxn(aliceId, acct, { uploadId: upload.id, amountCents: -5000 });
  insertTxn(aliceId, acct, { parentId: parent.id, amountCents: -2000 });
  insertTxn(aliceId, acct, { parentId: parent.id, amountCents: -3000 });
  const manual = insertTxn(aliceId, acct, { isManual: true });

  const tag = db.insert(hashtags).values({ userId: aliceId, name: 'trip' }).returning().get();
  db.insert(transactionHashtags).values({ transactionId: manual.id, hashtagId: tag.id }).run();

  insertTxn(bobId, bobAcct, { description: 'BOB ROW' });
  db.insert(hashtags).values({ userId: bobId, name: 'bobtag' }).run();

  return { uploadId: upload.id };
}

const countFor = (table, userId) =>
  db.select().from(table).where(eq(table.userId, userId)).all().length;

describe('clear transactions — preview', () => {
  test('reports what would be destroyed, counting locked and split rows', async () => {
    seedData();
    const res = await alice.get('/api/settings/clear-transactions');
    expect(res.status).toBe(200);
    // 3 imported + 2 split children + 1 manual = 6
    expect(res.body.transactions).toBe(6);
    expect(res.body.locked).toBe(1);
    expect(res.body.split).toBe(3); // the parent and its two children
    expect(res.body.uploads).toBe(1);
    expect(res.body.hashtags).toBe(1);
  });

  test("counts only the caller's own data", async () => {
    const res = await bob.get('/api/settings/clear-transactions');
    expect(res.body.transactions).toBe(1);
    expect(res.body.hashtags).toBe(1);
    expect(res.body.uploads).toBe(0);
  });
});

describe('clear transactions — wipe', () => {
  test('requires an explicit confirmation', async () => {
    const res = await alice.post('/api/settings/clear-transactions', {});
    expect(res.status).toBe(400);
    expect(countFor(transactions, aliceId)).toBe(6);
  });

  test('removes transactions, splits, hashtag links, names and the upload archive', async () => {
    const res = await alice.post('/api/settings/clear-transactions', { confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toMatchObject({ transactions: 6, locked: 1, split: 3, uploads: 1, hashtags: 1 });

    expect(countFor(transactions, aliceId)).toBe(0);
    expect(countFor(uploads, aliceId)).toBe(0);
    expect(countFor(hashtags, aliceId)).toBe(0);
    // The join table is emptied by the FK cascade, not by an explicit delete.
    expect(db.select().from(transactionHashtags).all()).toHaveLength(0);
  });

  test('keeps accounts, categories and keywords — the setup you would rebuild by hand', () => {
    expect(countFor(institutions, aliceId)).toBe(1);
    expect(countFor(accounts, aliceId)).toBe(1);
    expect(countFor(categories, aliceId)).toBeGreaterThan(0);
    expect(countFor(keywords, aliceId)).toBeGreaterThan(0);
  });

  test('leaves the other user untouched', () => {
    expect(countFor(transactions, bobId)).toBe(1);
    expect(countFor(hashtags, bobId)).toBe(1);
  });

  test('is idempotent on an already-empty database', async () => {
    const res = await alice.post('/api/settings/clear-transactions', { confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.deleted.transactions).toBe(0);
  });

  test('keeps uploaded FX rates', async () => {
    db.insert(fxRates).values({ userId: aliceId, date: '2026-01-01', fromCcy: 'EUR', toCcy: 'PLN', rate: 4.3 }).run();
    await alice.post('/api/settings/clear-transactions', { confirm: true });
    expect(countFor(fxRates, aliceId)).toBe(1);
  });
});

describe('clear transactions — access', () => {
  test('a non-admin can clear their own data (it is a per-user action, not an admin one)', async () => {
    const setup = await startTestClient();
    await loginAsAdmin(setup);
    const plainId = (await createUser(setup, 'clearplain', 'password1')).id;
    setup.close();

    const inst = db.insert(institutions).values({ userId: plainId, name: 'Bank' }).returning().get();
    const plainAcct = db
      .insert(accounts)
      .values({ userId: plainId, institutionId: inst.id, name: 'Checking', currency: 'PLN', holder: 'P' })
      .returning()
      .get().id;
    insertTxn(plainId, plainAcct, { description: 'PLAIN ROW' });

    const plain = await startTestClient();
    await plain.post('/api/auth/login', { username: 'clearplain', password: 'password1' });
    expect((await plain.get('/api/settings/clear-transactions')).body.transactions).toBe(1);
    expect((await plain.post('/api/settings/clear-transactions', { confirm: true })).status).toBe(200);
    expect(countFor(transactions, plainId)).toBe(0);
    plain.close();
  });

  test('an anonymous caller cannot reach the endpoint', async () => {
    const anon = await startTestClient();
    expect((await anon.get('/api/settings/clear-transactions')).status).toBe(401);
    expect((await anon.post('/api/settings/clear-transactions', { confirm: true })).status).toBe(401);
    anon.close();
  });
});
