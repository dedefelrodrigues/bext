import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { users, institutions, accounts } from '../src/db/schema.js';

let alice;
let bob;

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  await createUser(admin, 'alice', 'password1');
  await createUser(admin, 'bob', 'password1');
  admin.close();

  alice = await startTestClient();
  bob = await startTestClient();
  await alice.post('/api/auth/login', { username: 'alice', password: 'password1' });
  await bob.post('/api/auth/login', { username: 'bob', password: 'password1' });
});
afterAll(() => {
  alice.close();
  bob.close();
});

describe('institutions', () => {
  test('create, list, rename, validate', async () => {
    expect((await alice.post('/api/institutions', { name: '  ' })).status).toBe(400);

    const created = await alice.post('/api/institutions', { name: 'Alior Bank' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Alior Bank');

    const list = await alice.get('/api/institutions');
    expect(list.body.map((i) => i.name)).toContain('Alior Bank');

    const renamed = await alice.patch(`/api/institutions/${created.body.id}`, { name: 'Alior' });
    expect(renamed.body.name).toBe('Alior');
  });
});

describe('accounts', () => {
  let instId;
  beforeAll(async () => {
    instId = (await alice.post('/api/institutions', { name: 'Revolut' })).body.id;
  });

  test('requires a valid owned institution and a valid currency', async () => {
    expect((await alice.post('/api/accounts', { name: 'X', currency: 'PLN' })).status).toBe(400);
    expect((await alice.post('/api/accounts', { institutionId: instId, name: 'X', currency: 'PLNN' })).status).toBe(400);
    expect((await alice.post('/api/accounts', { institutionId: instId, name: '', currency: 'PLN' })).status).toBe(400);
  });

  test('holder defaults to the username when blank; currency is uppercased', async () => {
    const acc = await alice.post('/api/accounts', {
      institutionId: instId,
      name: 'Personal',
      currency: 'eur',
    });
    expect(acc.status).toBe(201);
    expect(acc.body.currency).toBe('EUR');
    expect(acc.body.holder).toBe('alice');
  });

  test('accepts an explicit holder', async () => {
    const acc = await alice.post('/api/accounts', {
      institutionId: instId,
      name: 'Joint',
      currency: 'PLN',
      holder: 'Spouse',
    });
    expect(acc.body.holder).toBe('Spouse');
  });

  test('list joins the institution name', async () => {
    const list = await alice.get('/api/accounts');
    const joint = list.body.find((a) => a.name === 'Joint');
    expect(joint.institutionName).toBe('Revolut');
  });

  test('patch updates fields and will not blank an existing holder', async () => {
    const acc = (await alice.get('/api/accounts')).body.find((a) => a.name === 'Personal');
    const updated = await alice.patch(`/api/accounts/${acc.id}`, { currency: 'usd', holder: '' });
    expect(updated.body.currency).toBe('USD');
    expect(updated.body.holder).toBe('alice'); // unchanged
  });

  test('delete removes the account', async () => {
    const acc = (await alice.get('/api/accounts')).body.find((a) => a.name === 'Joint');
    expect((await alice.del(`/api/accounts/${acc.id}`)).status).toBe(204);
    expect((await alice.get('/api/accounts')).body.find((a) => a.name === 'Joint')).toBeUndefined();
  });
});

describe('list stats (?stats=1)', () => {
  let instId;
  let acctId;
  let quietId;

  beforeAll(async () => {
    instId = (await alice.post('/api/institutions', { name: 'Stats Bank' })).body.id;
    acctId = (await alice.post('/api/accounts', { institutionId: instId, name: 'Busy', currency: 'PLN' })).body.id;
    quietId = (await alice.post('/api/accounts', { institutionId: instId, name: 'Quiet', currency: 'EUR' })).body.id;

    for (const [date, description, amountCents] of [
      ['2024-02-01', 'OLDEST', -1000],
      ['2025-06-15', 'MIDDLE', -2000],
      ['2026-09-21', 'NEWEST', 5000],
    ]) {
      await alice.post('/api/transactions', { accountId: acctId, date, description, amountCents });
    }
  });

  test('plain list carries no stats fields', async () => {
    const acc = (await alice.get('/api/accounts')).body.find((a) => a.id === acctId);
    expect(acc.txCount).toBeUndefined();
    expect(acc.lastUploadAt).toBeUndefined();
  });

  test('counts transactions and reports the date span', async () => {
    const acc = (await alice.get('/api/accounts?stats=1')).body.find((a) => a.id === acctId);
    expect(acc.txCount).toBe(3);
    expect(acc.firstDate).toBe('2024-02-01');
    expect(acc.lastDate).toBe('2026-09-21');
  });

  test('an account with no activity reports zeros, not nulls', async () => {
    const acc = (await alice.get('/api/accounts?stats=1')).body.find((a) => a.id === quietId);
    expect(acc.txCount).toBe(0);
    expect(acc.uploadCount).toBe(0);
    expect(acc.firstDate).toBeNull();
    expect(acc.lastUploadAt).toBeNull();
    expect(acc.hasOfx).toBe(false);
  });

  test('a split counts once, not once per child', async () => {
    const tx = (await alice.get(`/api/transactions?accountIds=${acctId}&q=MIDDLE`)).body.transactions[0];
    const split = await alice.post(`/api/transactions/${tx.id}/splits`, {
      splits: [{ amountCents: -1200 }, { amountCents: -800 }],
    });
    expect(split.status).toBe(201);

    const acc = (await alice.get('/api/accounts?stats=1')).body.find((a) => a.id === acctId);
    expect(acc.txCount).toBe(3);
  });

  test("stats never leak another user's rows", async () => {
    const bobInst = (await bob.post('/api/institutions', { name: 'Bobs' })).body.id;
    const bobAcct = (await bob.post('/api/accounts', { institutionId: bobInst, name: 'Bobs acct', currency: 'PLN' })).body.id;
    await bob.post('/api/transactions', { accountId: bobAcct, date: '2026-01-01', description: 'BOB', amountCents: -100 });

    const aliceList = (await alice.get('/api/accounts?stats=1')).body;
    expect(aliceList.find((a) => a.id === bobAcct)).toBeUndefined();
    expect(aliceList.find((a) => a.id === acctId).txCount).toBe(3);
    expect((await bob.get('/api/accounts?stats=1')).body.find((a) => a.id === bobAcct).txCount).toBe(1);
  });
});

describe('institution deletion guard', () => {
  test('cannot delete an institution that still has accounts', async () => {
    const instId = (await alice.post('/api/institutions', { name: 'ITAU' })).body.id;
    await alice.post('/api/accounts', { institutionId: instId, name: 'Checking', currency: 'BRL' });
    expect((await alice.del(`/api/institutions/${instId}`)).status).toBe(409);
  });
});

describe('isolation', () => {
  test("a user cannot see, edit, or delete another user's institutions/accounts", async () => {
    const aliceInst = (await alice.get('/api/institutions')).body[0];
    // bob's lists never include alice's data
    expect((await bob.get('/api/institutions')).body.find((i) => i.id === aliceInst.id)).toBeUndefined();
    // bob cannot rename or delete alice's institution
    expect((await bob.patch(`/api/institutions/${aliceInst.id}`, { name: 'hacked' })).status).toBe(404);
    expect((await bob.del(`/api/institutions/${aliceInst.id}`)).status).toBe(404);
    // bob cannot create an account under alice's institution
    expect((await bob.post('/api/accounts', { institutionId: aliceInst.id, name: 'X', currency: 'PLN' })).status).toBe(400);
  });
});

describe('cascade on user deletion', () => {
  test("deleting a user removes their institutions and accounts", async () => {
    const admin = await startTestClient();
    await loginAsAdmin(admin);
    const carol = await createUser(admin, 'carol', 'password1');

    const carolClient = await startTestClient();
    await carolClient.post('/api/auth/login', { username: 'carol', password: 'password1' });
    const inst = (await carolClient.post('/api/institutions', { name: 'CarolBank' })).body;
    await carolClient.post('/api/accounts', { institutionId: inst.id, name: 'C', currency: 'PLN' });
    carolClient.close();

    expect((await admin.del(`/api/admin/users/${carol.id}`)).status).toBe(204);
    admin.close();

    // No orphaned rows remain for the deleted user.
    expect(db.select().from(institutions).where(eq(institutions.userId, carol.id)).all()).toHaveLength(0);
    expect(db.select().from(accounts).where(eq(accounts.userId, carol.id)).all()).toHaveLength(0);
    expect(db.select().from(users).where(eq(users.id, carol.id)).all()).toHaveLength(0);
  });
});
