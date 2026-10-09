import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { institutions, accounts, transactions, fxRates } from '../src/db/schema.js';

let alice;
let bob;
let aliceId;
let pln;
let eur;
let spouse;
let cats;
const cat = (name) => cats.find((c) => c.name === name);
const sub = (c, s) => cat(c).subcategories.find((x) => x.name === s);
let transferCat;
let internal;

let seq = 0;
function tx(overrides = {}) {
  const desc = overrides.description ?? `TRF ${seq++}`;
  return db
    .insert(transactions)
    .values({ userId: aliceId, accountId: pln, date: '2026-03-10', description: desc, amountCents: -1000, currency: 'PLN', dedupKey: `${desc}|${Math.random()}`, categoryId: transferCat, subcategoryId: internal, ...overrides })
    .returning()
    .get();
}
const view = async () => (await alice.get('/api/transfers')).body;
const pairOf = (v, id) => [...v.pairs, ...v.suggested].find((p) => p.out.id === id || p.in.id === id);

const ids = {};

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  aliceId = (await createUser(admin, 'trfuser', 'password1')).id;
  await createUser(admin, 'trfbob', 'password1');
  admin.close();
  alice = await startTestClient();
  await alice.post('/api/auth/login', { username: 'trfuser', password: 'password1' });
  bob = await startTestClient();
  await bob.post('/api/auth/login', { username: 'trfbob', password: 'password1' });

  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Bank' }).returning().get();
  pln = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'PLN', currency: 'PLN', holder: 'Me' }).returning().get().id;
  eur = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'EUR', currency: 'EUR', holder: 'Me' }).returning().get().id;
  spouse = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'Spouse', currency: 'PLN', holder: 'Spouse' }).returning().get().id;
  db.insert(fxRates).values({ userId: aliceId, date: '2026-01-01', fromCcy: 'EUR', toCcy: 'PLN', rate: 4.25 }).run();
  cats = (await alice.get('/api/categories')).body;
  transferCat = cat('Transfer In/Out').id;
  internal = sub('Transfer In/Out', 'Internal bank transfer').id;

  // Same currency, two days apart, between spouses.
  ids.sameOut = tx({ accountId: spouse, date: '2026-03-01', amountCents: -50000 }).id;
  ids.sameIn = tx({ accountId: pln, date: '2026-03-03', amountCents: 50000 }).id;
  // An exchange: −1,000 EUR ↔ +4,230 PLN the same day (0.5% off the table rate).
  ids.fxOut = tx({ accountId: eur, date: '2026-03-05', amountCents: -100000, currency: 'EUR' }).id;
  ids.fxIn = tx({ accountId: pln, date: '2026-03-05', amountCents: 423000 }).id;
  // A transfer whose other leg is filed as spending, exact amount: only suggested.
  ids.sugOut = tx({ accountId: pln, date: '2026-03-12', amountCents: -77700 }).id;
  ids.sugIn = tx({ accountId: spouse, date: '2026-03-12', amountCents: 77700, categoryId: cat('Income').id, subcategoryId: null }).id;
  // FX within 3% against a purchase is never proposed.
  ids.buy = tx({ accountId: eur, date: '2026-03-15', amountCents: -2000, currency: 'EUR', categoryId: cat('Food & Drink').id, subcategoryId: null }).id;
  ids.lonely = tx({ accountId: pln, date: '2026-03-15', amountCents: 8500 }).id;
  // Too far apart to pair.
  ids.lateOut = tx({ accountId: pln, date: '2026-02-01', amountCents: -30000 }).id;
  ids.lateIn = tx({ accountId: spouse, date: '2026-02-09', amountCents: 30000 }).id;
  // Money through an exchange wallet that is not imported.
  ids.k1 = tx({ accountId: eur, date: '2026-01-10', amountCents: -1000000, currency: 'EUR', description: 'Alior Bank - Kantor EUR transfer' }).id;
  ids.k2 = tx({ accountId: pln, date: '2026-01-20', amountCents: 2000000, description: 'Transfer EUR to PLN 78 2490' }).id;
  ids.k3 = tx({ accountId: pln, date: '2026-02-20', amountCents: 2200000, description: 'Transfer EUR to PLN 78 2490' }).id;
});

afterAll(() => {
  alice.close();
  bob.close();
});

describe('pairing', () => {
  test('same currency within four days pairs automatically, across holders too', async () => {
    const p = pairOf(await view(), ids.sameOut);
    expect(p).toMatchObject({ status: 'auto', kind: 'same', days: 2, crossHolder: true });
    expect(p.in.id).toBe(ids.sameIn);
  });

  test('an exchange pairs on the converted amount', async () => {
    const p = pairOf(await view(), ids.fxOut);
    expect(p).toMatchObject({ status: 'auto', kind: 'fx' });
    expect(p.in.id).toBe(ids.fxIn);
  });

  test('a leg filed as income is only suggested, and only on the exact amount', async () => {
    const v = await view();
    expect(pairOf(v, ids.sugOut)).toMatchObject({ status: 'suggested' });
    expect(pairOf(v, ids.buy)).toBeUndefined();
    expect(pairOf(v, ids.lateOut)).toBeUndefined();
  });

  test('decisions: rejected never again, confirmed stands', async () => {
    await alice.post('/api/transfers/decisions', { outId: ids.sugOut, inId: ids.sugIn, status: 'rejected' });
    expect(pairOf(await view(), ids.sugOut)).toBeUndefined();
    await alice.post('/api/transfers/decisions/undo', { outId: ids.sugOut, inId: ids.sugIn });
    expect(pairOf(await view(), ids.sugOut)).toMatchObject({ status: 'suggested' });

    // Nine days apart is too far for the matcher, not for the user.
    expect((await alice.post('/api/transfers/decisions', { outId: ids.lateIn, inId: ids.lateOut, status: 'confirmed' })).status).toBe(200);
    expect(pairOf(await view(), ids.lateOut)).toMatchObject({ status: 'confirmed', days: 8 });
  });

  test('decisions are validated and scoped to the user', async () => {
    expect((await alice.post('/api/transfers/decisions', { outId: ids.sameOut, inId: ids.sameOut, status: 'confirmed' })).status).toBe(400);
    expect((await alice.post('/api/transfers/decisions', { outId: ids.fxIn, inId: ids.sameIn, status: 'confirmed' })).status).toBe(400); // same account
    expect((await bob.post('/api/transfers/decisions', { outId: ids.sameOut, inId: ids.sameIn, status: 'rejected' })).status).toBe(404);
  });
});

describe('off-book accounts', () => {
  test('unmatched legs are grouped with a declaration drafted', async () => {
    const v = await view();
    const kantor = v.unmatched.find((g) => g.counterparty.includes('kantor'));
    expect(kantor.suggestion).toMatchObject({ kind: 'exchange' });
    expect(kantor.suggestion.patterns[0]).toContain('kantor');
    expect(v.unmatched.some((g) => g.transactionIds.includes(ids.lonely))).toBe(true);
  });

  test('a declared account claims its rows and keeps a running balance', async () => {
    const res = await alice.post('/api/transfers/offbook', { name: 'Kantor', kind: 'exchange', patterns: 'alior bank kantor\ntransfer eur to pln' });
    expect(res.status).toBe(201);
    const v = await view();
    const k = v.offbook.find((o) => o.id === res.body.id);
    expect(k.rowCount).toBe(3);
    // +42,500 PLN in (10,000 EUR at 4.25), then −20,000 and −22,000 back out.
    expect(k.series.find((m) => m.ym === '2026-01').balance).toBe(4250000 - 2000000);
    expect(k.series.find((m) => m.ym === '2026-02').balance).toBe(50000);
    expect(v.unmatched.some((g) => g.transactionIds.includes(ids.k2))).toBe(false);
    expect((await alice.patch(`/api/transfers/offbook/${k.id}`, { patterns: [] })).status).toBe(400);
    expect((await bob.patch(`/api/transfers/offbook/${k.id}`, { name: 'x' })).status).toBe(404);
  });

  test('"this is fine" takes a group out of the count until its rows change', async () => {
    const before = await view();
    const g = before.unmatched.find((x) => x.transactionIds.includes(ids.lonely));
    await alice.post('/api/data-health/dismiss', { key: g.ackKey, fingerprint: g.ackFingerprint });
    const after = await view();
    expect(after.unmatched.find((x) => x.key === g.key).acknowledged).toBe(true);
    expect(after.summary.unmatched).toBe(before.summary.unmatched - g.rowCount);
    await alice.post('/api/data-health/restore', { key: g.ackKey });
  });

  test('health summarizes what is left, pointing at the tab', async () => {
    const findings = (await alice.get('/api/data-health')).body.findings;
    const f = findings.find((x) => x.key === 'transfers:unmatched');
    expect(f.fixes[0]).toMatchObject({ type: 'open', href: '/accounts/transfers' });
    expect(f.rowCount).toBeGreaterThan(0);
  });
});
