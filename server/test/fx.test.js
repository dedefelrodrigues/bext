import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { institutions, accounts, transactions } from '../src/db/schema.js';
import { buildConverter } from '../src/fx/converter.js';

let alice;
let bob;
let aliceId;
let bobId;
let acct;

let seq = 0;
function insertTxn(overrides = {}) {
  const desc = overrides.description ?? `FX ${seq++}`;
  return db
    .insert(transactions)
    .values({
      userId: aliceId,
      accountId: acct,
      date: '2026-03-10',
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
  aliceId = (await createUser(admin, 'fxuser', 'password1')).id;
  bobId = (await createUser(admin, 'fxbob', 'password1')).id;
  admin.close();

  alice = await startTestClient();
  bob = await startTestClient();
  await alice.post('/api/auth/login', { username: 'fxuser', password: 'password1' });
  await bob.post('/api/auth/login', { username: 'fxbob', password: 'password1' });

  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Bank' }).returning().get();
  acct = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'Checking', currency: 'PLN', holder: 'Andre' }).returning().get().id;
});

afterAll(() => {
  alice.close();
  bob.close();
});

describe('rate table CRUD + CSV round-trip', () => {
  test('creates, lists and deletes a manual rate', async () => {
    const created = await alice.post('/api/fx/rates', { date: '2026-03-01', from: 'eur', to: 'pln', rate: '4.25' });
    expect(created.status).toBe(201);
    expect(created.body.rate).toMatchObject({ date: '2026-03-01', from: 'EUR', to: 'PLN', rate: 4.25, source: 'manual' });

    const list = (await alice.get('/api/fx/rates')).body.rates;
    expect(list).toHaveLength(1);

    expect((await alice.del(`/api/fx/rates/${created.body.rate.id}`)).status).toBe(204);
    expect((await alice.get('/api/fx/rates')).body.rates).toHaveLength(0);
  });

  test('rejects bad dates, codes, equal currencies and non-positive rates', async () => {
    for (const body of [
      { date: '01-03-2026', from: 'EUR', to: 'PLN', rate: 4 },
      { date: '2026-03-01', from: 'EURO', to: 'PLN', rate: 4 },
      { date: '2026-03-01', from: 'PLN', to: 'PLN', rate: 4 },
      { date: '2026-03-01', from: 'EUR', to: 'PLN', rate: 0 },
    ]) {
      expect((await alice.post('/api/fx/rates', body)).status).toBe(400);
    }
  });

  test('CSV import merges and re-import updates the same (date,from,to)', async () => {
    const csv = 'date,from,to,rate\n2026-03-01,EUR,PLN,4.20\n2026-03-05,EUR,PLN,4.30\n2026-03-05,USD,PLN,3.90\n';
    expect((await alice.post('/api/fx/rates/import', { csv })).body).toEqual({ imported: 3 });

    const again = await alice.post('/api/fx/rates/import', { csv: 'date,from,to,rate\n2026-03-01,EUR,PLN,4.11\n' });
    expect(again.status).toBe(201);

    const rates = (await alice.get('/api/fx/rates')).body.rates;
    expect(rates).toHaveLength(3); // updated, not duplicated
    expect(rates.find((r) => r.date === '2026-03-01').rate).toBe(4.11);

    const exported = (await alice.get('/api/fx/rates/export')).body.csv;
    expect(exported.split('\n')[0]).toBe('date,from,to,rate');
    expect(exported).toContain('2026-03-01,EUR,PLN,4.11');
  });

  test('a bad row rejects the whole file', async () => {
    const before = (await alice.get('/api/fx/rates')).body.rates.length;
    const res = await alice.post('/api/fx/rates/import', { csv: 'date,from,to,rate\n2026-04-01,EUR,PLN,4.4\n2026-04-02,EUR,PLN,oops\n' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Row 3/);
    expect((await alice.get('/api/fx/rates')).body.rates).toHaveLength(before);
  });

  test("a user cannot see or delete another user's rates", async () => {
    expect((await bob.get('/api/fx/rates')).body.rates).toEqual([]);
    const mine = (await alice.get('/api/fx/rates')).body.rates[0];
    expect((await bob.del(`/api/fx/rates/${mine.id}`)).status).toBe(404);
  });
});

describe('conversion fallback chain', () => {
  test('same currency passes through untouched', () => {
    const { convert } = buildConverter(aliceId, 'PLN');
    expect(convert({ date: '2026-03-10', currency: 'PLN', amountCents: -1234 })).toMatchObject({ cents: -1234, converted: true, source: 'same' });
  });

  test("level 1: the row's own amount pair wins, sign preserved", () => {
    const { convert } = buildConverter(aliceId, 'PLN');
    const row = { date: '2026-03-10', currency: 'EUR', amountCents: -1000, foreignCurrency: 'PLN', foreignAmountCents: -4250 };
    expect(convert(row)).toMatchObject({ cents: -4250, converted: true, source: 'row' });
    // Even if the table stores the foreign leg unsigned, the canonical sign holds.
    expect(convert({ ...row, foreignAmountCents: 4250 }).cents).toBe(-4250);
  });

  test('level 1: a rate derived from another row converts rows that lack a pair', () => {
    // An Alior-style row: 100.00 EUR of operation currency booked as 425.00 PLN.
    insertTxn({ description: 'PAIRED', amountCents: -42500, currency: 'PLN', foreignCurrency: 'EUR', foreignAmountCents: -10000 });
    const { convert } = buildConverter(aliceId, 'PLN');
    const res = convert({ date: '2026-03-10', currency: 'EUR', amountCents: -2000 });
    expect(res).toMatchObject({ converted: true, source: 'derived' });
    expect(res.cents).toBe(-8500); // 20.00 EUR * 4.25
  });

  test('level 2: the uploaded table fills the gaps, latest rate on or before the date', async () => {
    await alice.post('/api/fx/rates/import', { csv: 'date,from,to,rate\n2026-01-01,GBP,PLN,5.00\n2026-03-01,GBP,PLN,5.20\n' });
    const { convert } = buildConverter(aliceId, 'PLN');
    expect(convert({ date: '2026-02-10', currency: 'GBP', amountCents: -1000 })).toMatchObject({ cents: -5000, source: 'uploaded' });
    expect(convert({ date: '2026-03-10', currency: 'GBP', amountCents: -1000 })).toMatchObject({ cents: -5200, source: 'uploaded' });
  });

  test('the inverse pair is used as 1/rate when only one direction is on file', () => {
    const inverse = buildConverter(aliceId, 'GBP').convert({ date: '2026-01-15', currency: 'PLN', amountCents: -5000 });
    expect(inverse).toMatchObject({ cents: -1000, converted: true, source: 'uploaded' });
  });

  test('a rate dated after the transaction is not used', () => {
    const { convert } = buildConverter(aliceId, 'PLN');
    // The GBP table starts 2026-01-01, so an older row stays unconverted.
    expect(convert({ date: '2025-12-31', currency: 'GBP', amountCents: -1000 })).toMatchObject({ converted: false, source: null });
  });

  test('nothing is guessed: an unreachable currency comes back flagged', () => {
    const { convert } = buildConverter(aliceId, 'PLN');
    expect(convert({ date: '2026-03-10', currency: 'BRL', amountCents: -5000 })).toEqual({ cents: -5000, converted: false, source: null });
  });

  test("another user's rates never leak into a conversion", () => {
    const row = { date: '2026-03-10', currency: 'GBP', amountCents: -1000 };
    expect(buildConverter(aliceId, 'PLN').convert(row).converted).toBe(true);
    // Bob owns no rates and no paired rows, so the very same row is unconvertible.
    expect(buildConverter(bobId, 'PLN').convert(row)).toMatchObject({ converted: false, source: null });
  });
});
