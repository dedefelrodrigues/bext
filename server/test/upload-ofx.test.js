import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { transactions } from '../src/db/schema.js';
import { tokenize } from '../src/upload/ofx/tokenize.js';
import { sniffEncoding, looksLikeOfx } from '../src/upload/ofx/header.js';
import { parseOfxDate, parseOfxAmount, buildDescription } from '../src/upload/ofx/transform.js';
import { buildOfxRows } from '../src/upload/ofx/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(resolve(__dirname, 'fixtures', name));
const fixtureB64 = (name) => fixture(name).toString('base64');
const sample = (name) => readFileSync(resolve(__dirname, '../../samples', name));
const ITAU_OFX = 'itau_extrato_sample.ofx'; // synthetic, in the real Itaú export's shape

let alice;
let bob;
let cardAcc; // USD credit card — card_v1.ofx
let bankAcc; // PLN bank — bank_v2.ofx
let itauAcc; // BRL — the Itaú-shaped sample
let bobAcc;

async function makeAccount(client, institutionId, name, currency) {
  const res = await client.post('/api/accounts', { institutionId, name, currency, holder: 'me' });
  return res.body.id;
}

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  await createUser(admin, 'ofxuser', 'password1');
  await createUser(admin, 'ofxbob', 'password1');
  admin.close();

  alice = await startTestClient();
  bob = await startTestClient();
  await alice.post('/api/auth/login', { username: 'ofxuser', password: 'password1' });
  await bob.post('/api/auth/login', { username: 'ofxbob', password: 'password1' });

  const inst = (await alice.post('/api/institutions', { name: 'OFX Bank' })).body;
  cardAcc = await makeAccount(alice, inst.id, 'Card USD', 'USD');
  bankAcc = await makeAccount(alice, inst.id, 'Bank PLN', 'PLN');
  itauAcc = await makeAccount(alice, inst.id, 'Itau OFX BRL', 'BRL');

  const bobInst = (await bob.post('/api/institutions', { name: 'Bob Bank' })).body;
  bobAcc = await makeAccount(bob, bobInst.id, 'Bob Card', 'USD');
});

afterAll(() => {
  alice.close();
  bob.close();
});

describe('OFX parsing units', () => {
  test('the SGML and XML dialects tokenize to the same tree', () => {
    const sgml = '<OFX><STMTRS><CURDEF>BRL<BANKTRANLIST><STMTTRN><TRNAMT>-12.34<MEMO>A &amp; B</STMTTRN></BANKTRANLIST></STMTRS></OFX>';
    const xml =
      '<?xml version="1.0"?><OFX><STMTRS><CURDEF>BRL</CURDEF><BANKTRANLIST><STMTTRN><TRNAMT>-12.34</TRNAMT><MEMO>A &amp; B</MEMO></STMTTRN></BANKTRANLIST></STMTRS></OFX>';
    expect(tokenize(sgml)).toEqual(tokenize(xml));
    expect(tokenize(sgml).OFX.STMTRS.BANKTRANLIST.STMTTRN.MEMO).toBe('A & B');
  });

  test('encoding is read from whichever preamble the file uses', () => {
    expect(sniffEncoding(fixture('card_v1.ofx'))).toBe('windows-1252');
    expect(sniffEncoding(fixture('bank_v2.ofx'))).toBe('utf8');
    expect(looksLikeOfx(fixture('card_v1.ofx'))).toBe(true);
    expect(looksLikeOfx(Buffer.from('Date,Description,Amount\n2020-01-01,x,1.00\n'))).toBe(false);
  });

  test('DTPOSTED truncates to the written date, ignoring time and timezone', () => {
    expect(parseOfxDate('20260105093000[-3:EST]')).toBe('2026-01-05');
    expect(parseOfxDate('20260105')).toBe('2026-01-05');
    expect(parseOfxDate('20261332')).toBeNull();
    expect(parseOfxDate('')).toBeNull();
  });

  test('TRNAMT keeps its sign and survives a stray decimal comma', () => {
    expect(parseOfxAmount('-12.34')).toBe(-1234);
    expect(parseOfxAmount('1200.00')).toBe(120000);
    expect(parseOfxAmount('-0.01')).toBe(-1);
    expect(parseOfxAmount('1,234.56')).toBe(123456); // comma = thousands
    expect(parseOfxAmount('-12,34')).toBe(-1234); // comma = decimal
    expect(parseOfxAmount('')).toBeNull();
  });

  test('description merges the configured fields and drops repeats', () => {
    const txn = { NAME: 'ZABKA', MEMO: 'zabka', TRNTYPE: 'DEBIT', PAYEE: { NAME: 'Zabka Polska' } };
    expect(buildDescription(txn, ['NAME', 'MEMO'])).toBe('ZABKA'); // MEMO repeats NAME
    expect(buildDescription(txn, ['PAYEE.NAME', 'NAME'])).toBe('Zabka Polska ZABKA');
    expect(buildDescription(txn, ['TRNTYPE', 'NAME'])).toBe('DEBIT ZABKA');
    expect(buildDescription({ MEMO: 'only memo' })).toBe('only memo'); // defaults
  });

  test('buildOfxRows dedups by FITID within the file and flags bad rows', () => {
    const built = buildOfxRows(fixture('card_v1.ofx'), null, { currency: 'USD' });
    expect(built.rows).toHaveLength(4);
    expect(built.meta.acctId).toBe('4111111111111111');
    // The two identical STMTTRNs share a FITID: both kept, occurrence-counted.
    expect(built.rows[0].dedupKey).toBe('fitid:X1');
    expect(built.rows[0].occurrence).toBe(0);
    expect(built.rows[1].occurrence).toBe(1);
    // No FITID → the standard date|description|amount key.
    expect(built.rows[2].dedupKey).toBe('2026-01-06|GROCERIES BIG STORE|-5000');
    // No NAME/MEMO at all → an error row, not a silent import.
    expect(built.rows[3]).toMatchObject({ status: 'error', reason: 'Empty description.' });
  });
});

describe('OFX import end to end', () => {
  test('a credit-card SGML file imports with no template configured', async () => {
    // No CSV template exists for this account — OFX needs no mapping at all.
    expect((await alice.get(`/api/accounts/${cardAcc}/template`)).body).toBeNull();

    const preview = (await alice.post(`/api/accounts/${cardAcc}/upload/preview`, { filename: 'card.ofx', contentBase64: fixtureB64('card_v1.ofx') })).body;
    expect(preview.format).toBe('ofx');
    expect(preview.summary).toEqual({ total: 4, toImport: 3, duplicates: 0, filtered: 0, errors: 1 });
    // windows-1252 decoded through the file's own CHARSET header.
    expect(preview.rows[0].description).toBe('CAFÉ MOKA');
    expect(preview.rows[0].amountCents).toBe(-1234);
    expect(preview.rows[0].currency).toBe('USD'); // CURDEF
    expect(preview.accountWarning).toBeNull();

    const confirm = await alice.post(`/api/accounts/${cardAcc}/upload/confirm`, { filename: 'card.ofx', contentBase64: fixtureB64('card_v1.ofx') });
    expect(confirm.status).toBe(201);
    expect(confirm.body).toMatchObject({ imported: 3, format: 'ofx' });

    const rows = db.select().from(transactions).where(eq(transactions.accountId, cardAcc)).all();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.fitid === 'X1')).toHaveLength(2);
    expect(rows.find((r) => r.fitid === null).description).toBe('GROCERIES BIG STORE');
  });

  test('re-upload dedups by FITID even when the bank reworded the descriptions', async () => {
    const same = (await alice.post(`/api/accounts/${cardAcc}/upload/preview`, { filename: 'card.ofx', contentBase64: fixtureB64('card_v1.ofx') })).body;
    expect(same.summary).toMatchObject({ toImport: 0, duplicates: 3 });

    // Same FITIDs, different MEMO/NAME text: the standard key would miss these.
    const reworded = (await alice.post(`/api/accounts/${cardAcc}/upload/preview`, { filename: 'card2.ofx', contentBase64: fixtureB64('card_v1_reworded.ofx') })).body;
    const byFitid = reworded.rows.filter((r) => r.status === 'ok' && r.fitid === 'X1');
    expect(byFitid.every((r) => r.duplicate)).toBe(true);
    // The FITID-less row falls back to date|description|amount, which the
    // rewording changed — so it legitimately reads as new.
    expect(reworded.summary.toImport).toBe(1);
  });

  test('an XML file classifies, defaults the business flag and keeps FX metadata', async () => {
    const cat = (await alice.post('/api/categories', { name: 'OFX Groceries', businessDefault: 'business' })).body;
    // Longer than the seeded `zabka` keyword, so longest-match wins the row.
    await alice.post('/api/keywords', { text: 'zabka z1234', categoryId: cat.id, distance: 0 });

    const preview = (await alice.post(`/api/accounts/${bankAcc}/upload/preview`, { filename: 'bank.ofx', contentBase64: fixtureB64('bank_v2.ofx') })).body;
    expect(preview.summary).toEqual({ total: 4, toImport: 4, duplicates: 0, filtered: 0, errors: 0 });

    const zabka = preview.rows.find((r) => r.description.startsWith('ZABKA'));
    expect(zabka.description).toBe('ZABKA Z1234 Card payment & fee');
    expect(zabka.category.name).toBe('OFX Groceries');

    // ORIGCURRENCY: amount is in CURDEF, the original in EUR at 4.30.
    const hotel = preview.rows.find((r) => r.description === 'HOTEL BERLIN');
    expect(hotel).toMatchObject({ currency: 'PLN', amountCents: -43000, foreignCurrency: 'EUR', foreignAmountCents: -10000 });
    // CURRENCY: the amount itself is in that currency, not CURDEF.
    expect(preview.rows.find((r) => r.description === 'SPOTIFY').currency).toBe('USD');
    // PAYEE is not a default description field.
    expect(preview.rows.find((r) => r.description === 'SALARY FEB')).toBeTruthy();

    await alice.post(`/api/accounts/${bankAcc}/upload/confirm`, { filename: 'bank.ofx', contentBase64: fixtureB64('bank_v2.ofx') });
    const persisted = db.select().from(transactions).where(eq(transactions.accountId, bankAcc)).all();
    expect(persisted).toHaveLength(4);
    expect(persisted.find((t) => t.fitid === 'P1').businessFlag).toBe('business');
  });

  test('an Itaú extract imports, dedups on re-upload and rolls back', async () => {
    const b64 = sample(ITAU_OFX).toString('base64');
    const preview = (await alice.post(`/api/accounts/${itauAcc}/upload/preview`, { filename: ITAU_OFX, contentBase64: b64 })).body;
    expect(preview.summary).toEqual({ total: 30, toImport: 30, duplicates: 0, filtered: 0, errors: 0 });
    expect(preview.meta).toMatchObject({ bankId: '0341', acctId: '1234567890', curdef: 'BRL', statementCount: 1 });
    expect(preview.rows[0]).toMatchObject({ date: '2026-01-07', amountCents: 5400, currency: 'BRL', description: 'PIX TRANSF ANA 07 01' });

    const confirm = await alice.post(`/api/accounts/${itauAcc}/upload/confirm`, { filename: ITAU_OFX, contentBase64: b64, excluded: [] });
    expect(confirm.body.imported).toBe(30);

    const again = (await alice.post(`/api/accounts/${itauAcc}/upload/preview`, { filename: ITAU_OFX, contentBase64: b64 })).body;
    expect(again.summary).toMatchObject({ toImport: 0, duplicates: 30 });

    const archive = (await alice.get('/api/uploads')).body;
    const entry = archive.find((u) => u.id === confirm.body.uploadId);
    expect(entry).toMatchObject({ format: 'ofx', currentCount: 30 });

    await alice.del(`/api/uploads/${entry.id}`);
    expect(db.select().from(transactions).where(eq(transactions.accountId, itauAcc)).all()).toHaveLength(0);
  });

  test('a file from a different account warns but still imports', async () => {
    // cardAcc learned ACCTID 4111111111111111 from its first import.
    const settings = (await alice.get(`/api/accounts/${cardAcc}/ofx-settings`)).body;
    expect(settings.acctId).toBe('4111111111111111');

    const preview = (await alice.post(`/api/accounts/${cardAcc}/upload/preview`, { filename: 'other.ofx', contentBase64: fixtureB64('bank_v2.ofx') })).body;
    expect(preview.accountWarning).toContain('PL9999');
    expect(preview.summary.toImport).toBe(4); // a warning, never a block

    // Forgetting the identity silences it.
    await alice.put(`/api/accounts/${cardAcc}/ofx-settings`, { descriptionFields: ['NAME', 'MEMO'], forget: true });
    const after = (await alice.post(`/api/accounts/${cardAcc}/upload/preview`, { filename: 'other.ofx', contentBase64: fixtureB64('bank_v2.ofx') })).body;
    expect(after.accountWarning).toBeNull();
  });

  test('unsupported and malformed files fail with a clear message, never a 500', async () => {
    const cases = [
      ['investment.ofx', /investment statement/i],
      ['error.ofx', /bank reported an error/i],
    ];
    for (const [name, re] of cases) {
      const res = await alice.post(`/api/accounts/${cardAcc}/upload/preview`, { filename: name, contentBase64: fixtureB64(name) });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(re);
    }
    // Truncated OFX: recognized as OFX by its header, then rejected.
    const truncated = Buffer.from('OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTR');
    const res = await alice.post(`/api/accounts/${cardAcc}/upload/preview`, { filename: 't.ofx', contentBase64: truncated.toString('base64') });
    expect(res.status).toBe(400);
  });
});

describe('OFX settings', () => {
  test('defaults apply with no row saved, and the field list is validated', async () => {
    const fresh = (await alice.get(`/api/accounts/${bankAcc}/ofx-settings`)).body;
    expect(fresh).toMatchObject({ descriptionFields: ['NAME', 'MEMO'], acctId: 'PL9999' });
    expect(fresh.available).toContain('PAYEE.NAME');

    expect((await alice.put(`/api/accounts/${bankAcc}/ofx-settings`, { descriptionFields: ['NOPE'] })).status).toBe(400);

    const saved = (await alice.put(`/api/accounts/${bankAcc}/ofx-settings`, { descriptionFields: ['PAYEE.NAME', 'MEMO', 'MEMO'] })).body;
    expect(saved.descriptionFields).toEqual(['PAYEE.NAME', 'MEMO']); // deduped, order kept

    // The chosen fields drive the next preview's descriptions.
    const preview = (await alice.post(`/api/accounts/${bankAcc}/upload/preview`, { filename: 'bank.ofx', contentBase64: fixtureB64('bank_v2.ofx') })).body;
    expect(preview.rows.find((r) => r.fitid === 'P3').description).toBe('ACME SP Z O O SALARY FEB');
    await alice.put(`/api/accounts/${bankAcc}/ofx-settings`, { descriptionFields: ['NAME', 'MEMO'] });
  });

  test('isolation: user B cannot read or write user A OFX settings', async () => {
    expect((await bob.get(`/api/accounts/${bankAcc}/ofx-settings`)).status).toBe(404);
    expect((await bob.put(`/api/accounts/${bankAcc}/ofx-settings`, { descriptionFields: ['MEMO'] })).status).toBe(404);
    expect((await bob.post(`/api/accounts/${bankAcc}/upload/preview`, { filename: 'x.ofx', contentBase64: fixtureB64('bank_v2.ofx') })).status).toBe(404);
    // Bob's own account is untouched by Alice's imports.
    expect((await bob.get(`/api/accounts/${bobAcc}/ofx-settings`)).body.acctId).toBeNull();
  });
});
