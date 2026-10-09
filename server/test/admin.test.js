import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestClient, loginAsAdmin } from './helpers.js';

let admin;
beforeAll(async () => {
  admin = await startTestClient();
  await loginAsAdmin(admin);
});
afterAll(() => admin.close());

describe('seeded admin', () => {
  test('admin/admin exists and is flagged as default-password admin', async () => {
    const me = await admin.get('/api/auth/me');
    expect(me.body.username).toBe('admin');
    expect(me.body.isAdmin).toBe(true);
    expect(me.body.passwordIsDefault).toBe(true);
  });
});

describe('user management', () => {
  test('creates a user, listing includes it', async () => {
    const created = await admin.post('/api/admin/users', { username: 'bob', password: 'password1' });
    expect(created.status).toBe(201);
    expect(created.body.isAdmin).toBe(false);

    const list = await admin.get('/api/admin/users');
    expect(list.body.map((u) => u.username)).toEqual(expect.arrayContaining(['admin', 'bob']));
  });

  test('rejects duplicate username and weak inputs', async () => {
    expect((await admin.post('/api/admin/users', { username: 'bob', password: 'password1' })).status).toBe(409);
    expect((await admin.post('/api/admin/users', { username: 'x', password: 'password1' })).status).toBe(400);
    expect((await admin.post('/api/admin/users', { username: 'okname', password: 'short' })).status).toBe(400);
  });

  test('admin can reset a user password', async () => {
    const bob = (await admin.get('/api/admin/users')).body.find((u) => u.username === 'bob');
    expect((await admin.post(`/api/admin/users/${bob.id}/password`, { newPassword: 'newpass12' })).status).toBe(204);

    const bobClient = await startTestClient();
    expect((await bobClient.post('/api/auth/login', { username: 'bob', password: 'newpass12' })).status).toBe(200);
    bobClient.close();
  });

  test('new users inherit current app-default settings as a snapshot', async () => {
    await admin.put('/api/admin/app-settings', { defaultCurrency: 'BRL', globalFuzzyDistance: 3 });
    const created = await admin.post('/api/admin/users', { username: 'carol', password: 'password1' });
    expect(created.body.defaultCurrency).toBe('BRL');
    expect(created.body.globalFuzzyDistance).toBe(3);
    // Changing app defaults afterwards does not touch the existing user.
    await admin.put('/api/admin/app-settings', { defaultCurrency: 'USD' });
    const carol = (await admin.get('/api/admin/users')).body.find((u) => u.username === 'carol');
    expect(carol.defaultCurrency).toBe('BRL');
  });
});

describe('admin guards', () => {
  test('admin cannot delete their own account', async () => {
    const me = await admin.get('/api/auth/me');
    expect((await admin.del(`/api/admin/users/${me.body.id}`)).status).toBe(409);
  });

  test('cannot remove or delete the last admin', async () => {
    const me = await admin.get('/api/auth/me');
    // Demoting the only admin is blocked.
    expect((await admin.patch(`/api/admin/users/${me.body.id}`, { isAdmin: false })).status).toBe(409);
  });

  test('demoting a non-last admin is allowed', async () => {
    const bob = (await admin.get('/api/admin/users')).body.find((u) => u.username === 'bob');
    // Promote bob so there are two admins, then demoting bob is permitted.
    expect((await admin.patch(`/api/admin/users/${bob.id}`, { isAdmin: true })).status).toBe(200);
    expect((await admin.patch(`/api/admin/users/${bob.id}`, { isAdmin: false })).status).toBe(200);
  });

  test('can delete a normal user', async () => {
    const carol = (await admin.get('/api/admin/users')).body.find((u) => u.username === 'carol');
    expect((await admin.del(`/api/admin/users/${carol.id}`)).status).toBe(204);
    expect((await admin.get('/api/admin/users')).body.find((u) => u.username === 'carol')).toBeUndefined();
  });
});

describe('app default settings', () => {
  test('reads and validates', async () => {
    expect((await admin.get('/api/admin/app-settings')).status).toBe(200);
    expect((await admin.put('/api/admin/app-settings', { defaultCurrency: 'EURO' })).status).toBe(400);
    expect((await admin.put('/api/admin/app-settings', { globalFuzzyDistance: -2 })).status).toBe(400);
  });
});
