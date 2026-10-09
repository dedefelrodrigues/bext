import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';

// The Rates page reads the table through filters + paging and prunes it in bulk;
// these cover that surface on its own DB so the conversion-chain fixtures in
// fx.test.js stay untouched.
let alice;
let bob;

const csv = (rows) => 'date,from,to,rate\n' + rows.join('\n') + '\n';

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  await createUser(admin, 'ratesalice', 'password1');
  await createUser(admin, 'ratesbob', 'password1');
  admin.close();

  alice = await startTestClient();
  bob = await startTestClient();
  await alice.post('/api/auth/login', { username: 'ratesalice', password: 'password1' });
  await bob.post('/api/auth/login', { username: 'ratesbob', password: 'password1' });

  await alice.post('/api/fx/rates/import', {
    csv: csv([
      '2025-01-01,EUR,PLN,4.10',
      '2025-06-01,EUR,PLN,4.20',
      '2026-01-01,EUR,PLN,4.30',
      '2025-01-01,USD,PLN,3.90',
      '2026-01-01,USD,PLN,3.80',
    ]),
  });
  await bob.post('/api/fx/rates/import', { csv: csv(['2025-01-01,GBP,PLN,5.00']) });
});

afterAll(() => {
  alice.close();
  bob.close();
});

describe('listing', () => {
  test('unfiltered listing reports the full total', async () => {
    const res = await alice.get('/api/fx/rates');
    expect(res.body.total).toBe(5);
    expect(res.body.rates).toHaveLength(5);
    // Newest first.
    expect(res.body.rates[0].date).toBe('2026-01-01');
  });

  test('filters by pair and by date range, together', async () => {
    expect((await alice.get('/api/fx/rates?from=EUR&to=PLN')).body.total).toBe(3);
    expect((await alice.get('/api/fx/rates?dateFrom=2025-06-01')).body.total).toBe(3);
    expect((await alice.get('/api/fx/rates?dateTo=2025-12-31')).body.total).toBe(3);

    const both = await alice.get('/api/fx/rates?from=EUR&to=PLN&dateFrom=2025-02-01&dateTo=2025-12-31');
    expect(both.body.total).toBe(1);
    expect(both.body.rates[0]).toMatchObject({ date: '2025-06-01', rate: 4.2 });
  });

  test('limit/offset page through the matches while total stays the full count', async () => {
    const first = await alice.get('/api/fx/rates?limit=2');
    expect(first.body.rates).toHaveLength(2);
    expect(first.body.total).toBe(5);

    const second = await alice.get('/api/fx/rates?limit=2&offset=2');
    expect(second.body.rates).toHaveLength(2);
    const ids = [...first.body.rates, ...second.body.rates].map((r) => r.id);
    expect(new Set(ids).size).toBe(4); // no overlap between pages
  });

  test('summary groups by pair with counts and the date span', async () => {
    const { body } = await alice.get('/api/fx/rates/summary');
    expect(body.total).toBe(5);
    expect(body.latest).toBe('2026-01-01');
    expect(body.pairs).toEqual([
      { from: 'EUR', to: 'PLN', count: 3, earliest: '2025-01-01', latest: '2026-01-01' },
      { from: 'USD', to: 'PLN', count: 2, earliest: '2025-01-01', latest: '2026-01-01' },
    ]);
  });

  test("the summary never counts another user's rates", async () => {
    expect((await bob.get('/api/fx/rates/summary')).body).toMatchObject({ total: 1 });
  });
});

describe('bulk delete', () => {
  test('deletes exactly the filtered subset', async () => {
    const res = await alice.del('/api/fx/rates?from=EUR&to=PLN&dateTo=2025-12-31');
    expect(res.body).toEqual({ deleted: 2 });
    expect((await alice.get('/api/fx/rates')).body.total).toBe(3);
  });

  test("another user's rates are never in range", async () => {
    expect((await alice.del('/api/fx/rates')).body).toEqual({ deleted: 3 });
    expect((await alice.get('/api/fx/rates')).body.total).toBe(0);
    expect((await bob.get('/api/fx/rates')).body.total).toBe(1);
  });
});
