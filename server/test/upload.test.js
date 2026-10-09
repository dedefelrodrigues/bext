import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { transactions } from '../src/db/schema.js';
import { parseDate } from '../src/upload/dates.js';
import { parseAmountToCents } from '../src/upload/amounts.js';
import { passesFilters, buildCanonical } from '../src/upload/transform.js';
import { parseCsv } from '../src/upload/parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleB64 = (name) => readFileSync(resolve(__dirname, '../../samples', name)).toString('base64');

const ALIOR = {
  encoding: 'windows-1250',
  delimiter: ';',
  decimalSeparator: ',',
  headerRow: 1,
  dateFormat: 'DD-MM-YYYY',
  dateColumn: 'Data transakcji',
  descriptionColumns: ['Nazwa odbiorcy', 'Szczegóły transakcji'],
  amountColumns: ['Kwota w walucie rachunku'],
  currencyColumn: 'Waluta rachunku',
  foreignAmountColumn: 'Kwota operacji',
  foreignCurrencyColumn: 'Waluta operacji',
  filters: [],
};
const REVOLUT = {
  encoding: 'utf-8',
  delimiter: ',',
  decimalSeparator: '.',
  headerRow: 0,
  dateFormat: 'YYYY-MM-DD HH:mm:ss',
  dateColumn: 'Started Date',
  descriptionColumns: ['Description'],
  amountColumns: ['Amount', 'Fee'],
  currencyColumn: 'Currency',
  filters: [{ column: 'State', op: 'equals', value: 'COMPLETED' }],
};
const ITAU = {
  encoding: 'utf-8',
  delimiter: ',',
  decimalSeparator: '.',
  headerRow: 0,
  dateFormat: 'YYYY-MM-DD',
  dateColumn: 'Date',
  descriptionColumns: ['Description'],
  amountColumns: ['Amount'],
  currencyColumn: null,
  filters: [{ column: 'Description', op: 'contains', value: 'SALDO', mode: 'exclude' }],
};

let alice;
let bob;
let aliorAcc;
let revolutAcc;
let itauAcc;

async function makeAccount(client, institutionId, name, currency) {
  const res = await client.post('/api/accounts', { institutionId, name, currency, holder: 'me' });
  return res.body.id;
}

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  await createUser(admin, 'uploader', 'password1');
  await createUser(admin, 'uploadbob', 'password1');
  admin.close();

  alice = await startTestClient();
  bob = await startTestClient();
  await alice.post('/api/auth/login', { username: 'uploader', password: 'password1' });
  await bob.post('/api/auth/login', { username: 'uploadbob', password: 'password1' });

  const inst = (await alice.post('/api/institutions', { name: 'Multi Bank' })).body;
  aliorAcc = await makeAccount(alice, inst.id, 'Alior PLN', 'PLN');
  revolutAcc = await makeAccount(alice, inst.id, 'Revolut PLN', 'PLN');
  itauAcc = await makeAccount(alice, inst.id, 'Itau BRL', 'BRL');
});

afterAll(() => {
  alice.close();
  bob.close();
});

describe('date/amount parsing units', () => {
  test('parseDate handles the sample formats and truncates time', () => {
    expect(parseDate('16-05-2023', 'DD-MM-YYYY')).toBe('2023-05-16');
    expect(parseDate('2018-03-19 9:11:22', 'YYYY-MM-DD HH:mm:ss')).toBe('2018-03-19');
    expect(parseDate('2021-03-08', 'YYYY-MM-DD')).toBe('2021-03-08');
    expect(parseDate('not a date', 'YYYY-MM-DD')).toBeNull();
    expect(parseDate('32-01-2020', 'DD-MM-YYYY')).toBeNull();
  });
  test('parseAmountToCents honors the decimal separator and sign', () => {
    expect(parseAmountToCents('-2045,41', ',')).toBe(-204541);
    expect(parseAmountToCents('1971.0', '.')).toBe(197100);
    expect(parseAmountToCents('1.234,56', ',')).toBe(123456); // dot thousands
    expect(parseAmountToCents('', '.')).toBe(0);
    expect(parseAmountToCents('abc', '.')).toBeNull();
  });

  test('parseAmountToCents keeps a currency marker but rejects prose', () => {
    expect(parseAmountToCents('-12,50 zł', ',')).toBe(-1250);
    expect(parseAmountToCents('PLN 1 234,00', ',')).toBe(123400);
    expect(parseAmountToCents('€ 9.99', '.')).toBe(999);
    // What an amount column holds once an unquoted delimiter shifted the row.
    expect(parseAmountToCents('/OPF/IN/924452800/Targa GmbH/1/Refund 102458699', ',')).toBeNull();
  });

  test('a delimiter inside a field is flagged, not imported as garbage', () => {
    const csv = [
      'Date;Sender;Details;Amount;Currency',
      '28-05-2024;WISE EUROPE IXE LLES;BE;Refund /OPF/IN/924452800;149,00;PLN',
      '29-05-2024;ZABKA;Groceries;-12,50;PLN;',
    ].join('\n');
    const template = { delimiter: ';', decimalSeparator: ',', encoding: 'utf-8', headerRow: 0, dateColumn: 'Date', dateFormat: 'DD-MM-YYYY', descriptionColumns: ['Sender', 'Details'], amountColumns: ['Amount'], currencyColumn: 'Currency' };
    const { rows } = parseCsv(Buffer.from(csv), template);
    const [shifted, trailing] = rows.map((r) => buildCanonical(r, template, { currency: 'PLN' }));
    expect(shifted.error).toMatch(/More columns than the header/);
    // A trailing empty cell (Alior ends every line with ';') is not an overflow.
    expect(trailing).toMatchObject({ amountCents: -1250, currency: 'PLN' });
  });

  test('an unreadable currency cell is an error, not a currency', () => {
    const template = { dateColumn: 'D', dateFormat: 'YYYY-MM-DD', descriptionColumns: ['T'], amountColumns: ['A'], currencyColumn: 'C', decimalSeparator: ',' };
    const out = buildCanonical({ D: '2024-05-28', T: 'x', A: '1,00', C: '149,00' }, template, { currency: 'PLN' });
    expect(out.error).toMatch(/currency/);
  });

  test('passesFilters: exclude (default) drops matches, include keeps only matches', () => {
    const row = { Description: 'SALDO FINAL', State: 'COMPLETED' };
    // exclude: a matching row is filtered out (case-insensitive).
    expect(passesFilters(row, [{ column: 'Description', op: 'contains', value: 'saldo', mode: 'exclude' }])).toBe(false);
    expect(passesFilters({ Description: 'PIX' }, [{ column: 'Description', op: 'contains', value: 'saldo', mode: 'exclude' }])).toBe(true);
    // include: only matching rows survive.
    expect(passesFilters(row, [{ column: 'State', op: 'equals', value: 'COMPLETED', mode: 'include' }])).toBe(true);
    expect(passesFilters({ State: 'REVERTED' }, [{ column: 'State', op: 'equals', value: 'COMPLETED', mode: 'include' }])).toBe(false);
    // legacy op without a mode behaves as before (include semantics).
    expect(passesFilters(row, [{ column: 'Description', op: 'not_contains', value: 'SALDO' }])).toBe(false);
  });
});

describe('template CRUD', () => {
  test('template must be configured before upload', async () => {
    expect((await alice.get(`/api/accounts/${aliorAcc}/template`)).body).toBeNull();
    const preview = await alice.post(`/api/accounts/${aliorAcc}/upload/preview`, { filename: 'x.csv', contentBase64: sampleB64('Alior.csv') });
    expect(preview.status).toBe(400);
  });

  test('PUT validates and saves; GET returns it', async () => {
    expect((await alice.put(`/api/accounts/${aliorAcc}/template`, { ...ALIOR, decimalSeparator: '!' })).status).toBe(400);
    expect((await alice.put(`/api/accounts/${aliorAcc}/template`, { ...ALIOR, descriptionColumns: [] })).status).toBe(400);

    const saved = await alice.put(`/api/accounts/${aliorAcc}/template`, ALIOR);
    expect(saved.status).toBe(200);
    expect(saved.body.dateColumn).toBe('Data transakcji');
    expect(saved.body.foreignCurrencyColumn).toBe('Waluta operacji');

    const got = (await alice.get(`/api/accounts/${aliorAcc}/template`)).body;
    expect(got.amountColumns).toEqual(['Kwota w walucie rachunku']);
    expect(got.filters).toEqual([]);
  });

  test('copy template from another account', async () => {
    await alice.put(`/api/accounts/${revolutAcc}/template`, REVOLUT);
    const copyTarget = await makeAccount(alice, (await alice.get('/api/accounts')).body[0].institutionId, 'Copy Target', 'PLN');
    const res = await alice.post(`/api/accounts/${copyTarget}/template/copy`, { fromAccountId: revolutAcc });
    expect(res.status).toBe(200);
    expect(res.body.dateColumn).toBe('Started Date');
    expect(res.body.amountColumns).toEqual(['Amount', 'Fee']);
  });
});

describe('end-to-end import of the sample extracts', () => {
  test('Alior: DD-MM-YYYY, comma decimals, foreign metadata', async () => {
    // template already saved above
    const preview = (await alice.post(`/api/accounts/${aliorAcc}/upload/preview`, { filename: 'Alior.csv', contentBase64: sampleB64('Alior.csv') })).body;
    expect(preview.summary).toEqual({ total: 22, toImport: 22, duplicates: 0, filtered: 0, errors: 0 });
    const first = preview.rows.find((r) => r.status === 'ok');
    expect(first.date).toBe('2023-05-16');
    expect(first.amountCents).toBe(-123456);
    expect(first.currency).toBe('PLN');
    expect(first.foreignCurrency).toBe('PLN');

    const confirm = await alice.post(`/api/accounts/${aliorAcc}/upload/confirm`, { filename: 'Alior.csv', contentBase64: sampleB64('Alior.csv') });
    expect(confirm.status).toBe(201);
    expect(confirm.body.imported).toBe(22);
    expect(db.select().from(transactions).where(eq(transactions.accountId, aliorAcc)).all()).toHaveLength(22);
  });

  test('Revolut: Amount+Fee summed, datetime truncated, State filter', async () => {
    const preview = (await alice.post(`/api/accounts/${revolutAcc}/upload/preview`, { filename: 'Revolut_sample.csv', contentBase64: sampleB64('Revolut_sample.csv') })).body;
    expect(preview.summary.total).toBe(21);
    expect(preview.summary.toImport).toBe(21);
    const confirm = await alice.post(`/api/accounts/${revolutAcc}/upload/confirm`, { filename: 'Revolut_sample.csv', contentBase64: sampleB64('Revolut_sample.csv') });
    expect(confirm.body.imported).toBe(21);
  });

  test('Itau: single amount, implicit currency, noise rows filtered + classified', async () => {
    await alice.put(`/api/accounts/${itauAcc}/template`, ITAU);
    // A distinctive keyword that classifies the SISPAG rows.
    const cat = (await alice.post('/api/categories', { name: 'Phase5 Pix' })).body;
    await alice.post('/api/keywords', { text: 'sispag acme', categoryId: cat.id, distance: 0 });

    const preview = (await alice.post(`/api/accounts/${itauAcc}/upload/preview`, { filename: 'itau.csv', contentBase64: sampleB64('itau_combined.csv') })).body;
    expect(preview.summary.filtered).toBe(6); // SALDO rows
    expect(preview.summary.toImport).toBe(48);
    const sispag = preview.rows.find((r) => r.status === 'ok' && r.description.includes('SISPAG'));
    expect(sispag.category.name).toBe('Phase5 Pix');
    expect(sispag.currency).toBe('BRL'); // fell back to the account currency

    const confirm = await alice.post(`/api/accounts/${itauAcc}/upload/confirm`, { filename: 'itau.csv', contentBase64: sampleB64('itau_combined.csv') });
    expect(confirm.body.imported).toBe(48);
    const persisted = db.select().from(transactions).where(eq(transactions.accountId, itauAcc)).all();
    expect(persisted).toHaveLength(48);
    expect(persisted.find((t) => t.description.includes('SISPAG')).categoryId).toBe(cat.id);
  });
});

describe('dedup on re-upload', () => {
  test('re-uploading the same file imports nothing (all duplicates)', async () => {
    const preview = (await alice.post(`/api/accounts/${aliorAcc}/upload/preview`, { filename: 'Alior.csv', contentBase64: sampleB64('Alior.csv') })).body;
    expect(preview.summary.duplicates).toBe(22);
    expect(preview.summary.toImport).toBe(0);
    const confirm = await alice.post(`/api/accounts/${aliorAcc}/upload/confirm`, { filename: 'Alior.csv', contentBase64: sampleB64('Alior.csv') });
    expect(confirm.body.imported).toBe(0);
    expect(db.select().from(transactions).where(eq(transactions.accountId, aliorAcc)).all()).toHaveLength(22);
  });
});

describe('upload archive + rollback', () => {
  test('archive lists uploads with live stats; rollback removes transactions', async () => {
    const list = (await alice.get('/api/uploads')).body;
    const itau = list.find((u) => u.accountId === itauAcc);
    expect(itau.importedCount).toBe(48);
    expect(itau.currentCount).toBe(48);
    expect(itau.lockedCount).toBe(0);

    expect((await alice.del(`/api/uploads/${itau.id}`)).status).toBe(204);
    expect(db.select().from(transactions).where(eq(transactions.accountId, itauAcc)).all()).toHaveLength(0);
    expect((await alice.get('/api/uploads')).body.find((u) => u.id === itau.id)).toBeUndefined();
  });
});

describe('isolation', () => {
  test("another user cannot touch alice's template, uploads, or accounts", async () => {
    expect((await bob.get(`/api/accounts/${aliorAcc}/template`)).status).toBe(404);
    expect((await bob.put(`/api/accounts/${aliorAcc}/template`, ALIOR)).status).toBe(404);
    expect((await bob.post(`/api/accounts/${aliorAcc}/upload/preview`, { filename: 'x', contentBase64: sampleB64('Alior.csv') })).status).toBe(404);

    const aliceUpload = (await alice.get('/api/uploads')).body[0];
    expect((await bob.del(`/api/uploads/${aliceUpload.id}`)).status).toBe(404);
    expect((await bob.get('/api/uploads')).body).toHaveLength(0);
  });
});
