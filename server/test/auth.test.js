import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';

let admin;
let client;

beforeAll(async () => {
  admin = await startTestClient();
  client = await startTestClient();
  await loginAsAdmin(admin);
  await createUser(admin, 'alice', 'supersecret');
});
afterAll(() => {
  admin.close();
  client.close();
});

describe('login + session', () => {
  test('login returns the public user (no hash) with role/flags', async () => {
    const res = await client.post('/api/auth/login', { username: 'alice', password: 'supersecret' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: expect.any(Number),
      username: 'alice',
      isAdmin: false,
      passwordIsDefault: false,
      theme: 'light',
      defaultCurrency: 'PLN',
      globalFuzzyDistance: 0,
      transactionsPageSize: 100,
    });
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  test('/me reflects the logged-in user', async () => {
    expect((await client.get('/api/auth/me')).body.username).toBe('alice');
  });

  test('logout clears the session', async () => {
    expect((await client.post('/api/auth/logout')).status).toBe(204);
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  test('wrong password fails; unknown user fails the same way (no enumeration)', async () => {
    expect((await client.post('/api/auth/login', { username: 'alice', password: 'nope' })).status).toBe(401);
    expect((await client.post('/api/auth/login', { username: 'ghost', password: 'whatever12' })).status).toBe(401);
  });
});

describe('change password', () => {
  test('rejects a wrong current password and too-short new password', async () => {
    await client.post('/api/auth/login', { username: 'alice', password: 'supersecret' });
    expect((await client.post('/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'brandnew1' })).status).toBe(400);
    expect((await client.post('/api/auth/change-password', { currentPassword: 'supersecret', newPassword: 'short' })).status).toBe(400);
  });

  test('changes the password and the old one stops working', async () => {
    const res = await client.post('/api/auth/change-password', {
      currentPassword: 'supersecret',
      newPassword: 'brandnew1',
    });
    expect(res.status).toBe(200);
    await client.post('/api/auth/logout');
    expect((await client.post('/api/auth/login', { username: 'alice', password: 'supersecret' })).status).toBe(401);
    expect((await client.post('/api/auth/login', { username: 'alice', password: 'brandnew1' })).status).toBe(200);
  });
});

describe('settings', () => {
  test('requires auth', async () => {
    client.clearCookies();
    expect((await client.get('/api/settings')).status).toBe(401);
  });

  test('reads and updates settings for the logged-in user', async () => {
    await client.post('/api/auth/login', { username: 'alice', password: 'brandnew1' });
    const updated = await client.put('/api/settings', { defaultCurrency: 'eur', globalFuzzyDistance: 2 });
    expect(updated.status).toBe(200);
    expect(updated.body.defaultCurrency).toBe('EUR');
    expect((await client.put('/api/settings', { defaultCurrency: 'EURO' })).status).toBe(400);
    expect((await client.put('/api/settings', { globalFuzzyDistance: -1 })).status).toBe(400);
  });

  test('transactions per page defaults to 100, has no ceiling, and rejects nonsense', async () => {
    await client.post('/api/auth/login', { username: 'alice', password: 'brandnew1' });
    expect((await client.get('/api/settings')).body.transactionsPageSize).toBe(100);

    const updated = await client.put('/api/settings', { transactionsPageSize: 200 });
    expect(updated.status).toBe(200);
    expect(updated.body.transactionsPageSize).toBe(200);
    expect((await client.get('/api/auth/me')).body.transactionsPageSize).toBe(200);

    // No upper bound — asking for every transaction at once is the user's call.
    expect((await client.put('/api/settings', { transactionsPageSize: 5000 })).body.transactionsPageSize).toBe(5000);
    expect((await client.put('/api/settings', { transactionsPageSize: 0 })).body.transactionsPageSize).toBe(0);

    expect((await client.put('/api/settings', { transactionsPageSize: 5 })).status).toBe(400);
    expect((await client.put('/api/settings', { transactionsPageSize: -100 })).status).toBe(400);
    expect((await client.put('/api/settings', { transactionsPageSize: 50.5 })).status).toBe(400);
    expect((await client.get('/api/settings')).body.transactionsPageSize).toBe(0);
  });

  test('theme defaults to light and can be set to dark, rejecting bad values', async () => {
    await client.post('/api/auth/login', { username: 'alice', password: 'brandnew1' });
    expect((await client.get('/api/settings')).body.theme).toBe('light');
    const updated = await client.put('/api/settings', { theme: 'dark' });
    expect(updated.status).toBe(200);
    expect(updated.body.theme).toBe('dark');
    expect((await client.get('/api/auth/me')).body.theme).toBe('dark');
    expect((await client.put('/api/settings', { theme: 'blue' })).status).toBe(400);
  });
});
