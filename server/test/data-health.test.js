import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { institutions, accounts, transactions, keywords } from '../src/db/schema.js';
import { buildCanonical } from '../src/upload/transform.js';
import { highlightRanges } from '../src/health/checks.js';
import { tokenize } from '../src/engine/classify.js';

let alice;
let bob;
let aliceId;
let acct;
let cats;
const cat = (name) => cats.find((c) => c.name === name);
const sub = (c, s) => cat(c).subcategories.find((x) => x.name === s);

let seq = 0;
function insertTxn(overrides = {}) {
  const desc = overrides.description ?? `HLT ${seq++}`;
  return db
    .insert(transactions)
    .values({ userId: aliceId, accountId: acct, date: '2026-01-15', description: desc, amountCents: -1000, currency: 'PLN', dedupKey: `${desc}|${Math.random()}`, ...overrides })
    .returning()
    .get();
}
const findings = async () => (await alice.get('/api/data-health')).body.findings;
const byKey = async (prefix) => (await findings()).filter((f) => f.key.startsWith(prefix));

const ids = {};

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  aliceId = (await createUser(admin, 'healthuser', 'password1')).id;
  await createUser(admin, 'healthbob', 'password1');
  admin.close();
  alice = await startTestClient();
  await alice.post('/api/auth/login', { username: 'healthuser', password: 'password1' });
  bob = await startTestClient();
  await bob.post('/api/auth/login', { username: 'healthbob', password: 'password1' });

  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Bank' }).returning().get();
  acct = db.insert(accounts).values({ userId: aliceId, institutionId: inst.id, name: 'Main', currency: 'PLN', holder: 'Me' }).returning().get().id;
  cats = (await alice.get('/api/categories')).body;

  // A restaurant keyword that is really a street name (the user's own address).
  const street = db.insert(keywords).values({ userId: aliceId, categoryId: cat('Food & Drink').id, subcategoryId: sub('Food & Drink', 'Restaurants').id, text: 'oak street' }).returning().get();
  ids.street = street.id;
  for (let i = 0; i < 4; i++) insertTxn({ description: `OAK STREET bistro ${i}`, amountCents: -5000, categoryId: cat('Food & Drink').id, subcategoryId: sub('Food & Drink', 'Restaurants').id, matchedKeywordId: street.id });
  // Salary that the street keyword caught: incoming money in Restaurants.
  for (let i = 0; i < 3; i++) insertTxn({ date: `2026-0${i + 1}-10`, description: `EMPLOYER GMBH pay oak street ${i}`, amountCents: 2000000, categoryId: cat('Food & Drink').id, subcategoryId: sub('Food & Drink', 'Restaurants').id, matchedKeywordId: street.id });
  // The same address in rows of two other categories (won by longer keywords elsewhere).
  for (let i = 0; i < 3; i++) insertTxn({ description: `SCHOOL XYZ oak street ${i}`, amountCents: -40000, categoryId: cat('General Services').id });
  for (let i = 0; i < 3; i++) insertTxn({ description: `TAX OFFICE oak street ${i}`, amountCents: -30000, categoryId: cat('Company').id });
  // A small refund is normal and must stay quiet.
  insertTxn({ description: 'PHARMACY REFUND', amountCents: 500, categoryId: cat('Medical').id });
  insertTxn({ description: 'PHARMACY', amountCents: -90000, categoryId: cat('Medical').id });

  // Imports: broken letters, 0.00 holds, an impossible row, a near-duplicate.
  insertTxn({ description: 'URZďż˝D SKARBOWY', amountCents: -100 });
  ids.hold1 = insertTxn({ description: 'Blokada pod trans BLIK', amountCents: 0 }).id;
  ids.hold2 = insertTxn({ description: 'Blokada pod trans BLIK', amountCents: 0 }).id;
  insertTxn({ description: 'SHIFTED', amountCents: -1, currency: '149,00' });
  insertTxn({ date: '2026-02-02', description: 'Żabka Warszawa', amountCents: -1234 });
  insertTxn({ date: '2026-02-02', description: 'ZABKA   WARSZAWA', amountCents: -1234 });
  // Two identical lines are two transactions, not a duplicate.
  insertTxn({ date: '2026-02-03', description: 'COFFEE', amountCents: -900 });
  insertTxn({ date: '2026-02-03', description: 'COFFEE', amountCents: -900 });
});

afterAll(() => {
  alice.close();
  bob.close();
});

describe('checks', () => {
  test('money going the wrong way is grouped by the keyword that put it there', async () => {
    const [f] = await byKey(`direction:${cat('Food & Drink').id}:kw:${ids.street}`);
    expect(f).toMatchObject({ check: 'direction', severity: 'high', rowCount: 3 });
    expect(f.title).toContain('incoming');
    expect(f.fixes.map((x) => x.type)).toEqual(['recategorize', 'edit-keyword']);
    expect(f.fixes[0].transactionIds).toHaveLength(3);
    // The pharmacy refund (0.5% of Medical) raises nothing.
    expect(await byKey(`direction:${cat('Medical').id}`)).toEqual([]);
  });

  test('keyword text shared by unrelated rows is called out', async () => {
    const [f] = await byKey(`rules:everywhere:${ids.street}`);
    expect(f.rowCount).toBe(6);
    expect(f.title).toContain('2 other categories');
  });

  test('imports: broken letters, 0.00 lines, impossible rows, near-duplicates', async () => {
    expect((await byKey('imports:broken'))[0].rowCount).toBe(1);
    const [empty] = await byKey('imports:empty');
    expect(empty.fixes[0]).toMatchObject({ type: 'delete-empty-rows' });
    expect(empty.fixes[0].transactionIds.sort()).toEqual([ids.hold1, ids.hold2].sort());
    expect((await byKey('imports:impossible'))[0].severity).toBe('high');
    const [dupes] = await byKey('imports:duplicates');
    expect(dupes.rows.map((r) => r.description).sort()).toEqual(['ZABKA   WARSZAWA', 'Żabka Warszawa']);
  });

  test('structure: empty categories and idle keywords', async () => {
    const [empty] = await byKey('structure:empty');
    expect(empty.items.length).toBeGreaterThan(0);
    expect(empty.items.every((i) => i.fix)).toBe(true);
    // Seeded keywords match none of these rows.
    const [unseen] = await byKey('structure:unseen');
    expect(unseen.items.length).toBeGreaterThan(10);
  });
});

describe('evidence for deciding', () => {
  test('a keyword is marked where it sits, accents and case folded', () => {
    const marks = (d, k) => highlightRanges(d, tokenize(k)).map(([a, b]) => d.slice(a, b));
    expect(marks('ZUS Centrum Obsługi Świadczeń dla R odzin', 'centrum obslugi swiadczen')).toEqual(['Centrum Obsługi Świadczeń']);
    expect(marks('WYPŁATA R500 dla', 'r 500')).toEqual(['R500']);
    expect(marks('Autopay S.A eon.pl/mojeon', 'eon.pl')).toEqual(['eon.pl']);
    expect(marks('zabkazabka', 'zabka')).toEqual([]); // not a whole token
  });

  test('direction findings carry the rest of the category, rows carry marks', async () => {
    const [f] = await byKey(`direction:${cat('Food & Drink').id}:kw:${ids.street}`);
    expect(f.context.restCount).toBe(4);
    expect(f.context.flagged).toHaveLength(3);
    expect(f.context.typicalCents).toBe(-5000);
    expect(f.rows[0].highlight.length).toBe(1);
  });

  test('a shared-text finding shows where the keyword wins today', async () => {
    const [f] = await byKey(`rules:everywhere:${ids.street}`);
    expect(f.own.count).toBe(7); // 4 meals + 3 misfiled salaries
    expect(f.own.category).toBe('Food & Drink › Restaurants');
  });
});

describe('dismissing', () => {
  test('a dismissed finding stays dismissed until its evidence changes', async () => {
    const [f] = await byKey('imports:broken');
    await alice.post('/api/data-health/dismiss', { key: f.key, fingerprint: f.fingerprint });
    expect((await byKey('imports:broken'))[0].dismissed).toBe(true);
    const before = (await alice.get('/api/data-health/summary')).body.open;

    insertTxn({ description: 'Gdaďż˝sk', amountCents: -100 });
    const [changed] = await byKey('imports:broken');
    expect(changed.dismissed).toBe(false);
    expect(changed.rowCount).toBe(2);
    expect((await alice.get('/api/data-health/summary')).body.open).toBe(before + 1);

    await alice.post('/api/data-health/dismiss', { key: changed.key, fingerprint: changed.fingerprint });
    await alice.post('/api/data-health/restore', { key: changed.key });
    expect((await byKey('imports:broken'))[0].dismissed).toBe(false);
  });
});

describe('deleting 0.00 rows', () => {
  test('only this user\'s 0.00 rows go', async () => {
    const real = insertTxn({ description: 'REAL', amountCents: -5000 });
    expect((await bob.post('/api/data-health/delete-empty-rows', { transactionIds: [ids.hold1] })).body.deleted).toBe(0);
    const res = await alice.post('/api/data-health/delete-empty-rows', { transactionIds: [ids.hold1, ids.hold2, real.id] });
    expect(res.body.deleted).toBe(2);
    expect(db.select().from(transactions).where(eq(transactions.id, real.id)).get()).toBeTruthy();
    expect(await byKey('imports:empty')).toEqual([]);
  });

  test('bob sees none of alice\'s findings', async () => {
    const bobs = (await bob.get('/api/data-health')).body.findings;
    expect(bobs.filter((f) => f.check !== 'structure')).toEqual([]);
  });
});

describe('uploads', () => {
  test('a line with every amount cell empty is an error, not 0.00', () => {
    const template = { dateColumn: 'D', dateFormat: 'YYYY-MM-DD', descriptionColumns: ['T'], amountColumns: ['A'], decimalSeparator: ',' };
    expect(buildCanonical({ D: '2026-06-22', T: 'Blokada', A: '' }, template, { currency: 'PLN' }).error).toMatch(/No amount/);
    expect(buildCanonical({ D: '2026-06-22', T: 'Fee only', A: '0,00' }, template, { currency: 'PLN' }).amountCents).toBe(0);
  });
});
