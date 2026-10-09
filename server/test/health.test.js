import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from '../src/app.js';

let server;
let baseUrl;

beforeAll(async () => {
  const app = createApp();
  await new Promise((res) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      res();
    });
  });
});

afterAll(() => {
  server?.close();
});

test('GET /api/health returns ok', async () => {
  const resp = await fetch(`${baseUrl}/api/health`);
  expect(resp.status).toBe(200);
  const body = await resp.json();
  expect(body).toEqual({ status: 'ok', service: 'bext-server' });
});
