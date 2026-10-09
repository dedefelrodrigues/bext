import { afterAll, beforeAll, expect, test } from 'vitest';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';

// Two independent sessions must never see each other's data. This is the
// baseline isolation guarantee that every later phase's resources rely on.
let a;
let b;
beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  await createUser(admin, 'usera', 'passworda');
  await createUser(admin, 'userb', 'passwordb');
  admin.close();

  a = await startTestClient();
  b = await startTestClient();
  await a.post('/api/auth/login', { username: 'usera', password: 'passworda' });
  await b.post('/api/auth/login', { username: 'userb', password: 'passwordb' });
});
afterAll(() => {
  a.close();
  b.close();
});

test('each session sees only its own identity', async () => {
  expect((await a.get('/api/auth/me')).body.username).toBe('usera');
  expect((await b.get('/api/auth/me')).body.username).toBe('userb');
});

test('settings changes are scoped per user', async () => {
  await a.put('/api/settings', { defaultCurrency: 'EUR' });
  await b.put('/api/settings', { defaultCurrency: 'USD' });
  expect((await a.get('/api/settings')).body.defaultCurrency).toBe('EUR');
  expect((await b.get('/api/settings')).body.defaultCurrency).toBe('USD');
});

test('non-admin users cannot reach admin routes', async () => {
  expect((await a.get('/api/admin/users')).status).toBe(403);
  expect((await a.post('/api/admin/users', { username: 'sneaky', password: 'password1' })).status).toBe(403);
});
