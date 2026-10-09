import { createApp } from '../src/app.js';

// Boots the app on an ephemeral port and returns a client whose fetch persists
// cookies across calls (a lightweight session-aware browser stand-in).
export async function startTestClient() {
  const app = createApp();
  const server = await new Promise((res) => {
    const s = app.listen(0, () => res(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const cookies = new Map();

  function cookieHeader() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async function call(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const jar = cookieHeader();
    if (jar) headers.cookie = jar;

    const resp = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const setCookie = resp.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }

    const text = await resp.text();
    const json = text ? JSON.parse(text) : null;
    return { status: resp.status, body: json };
  }

  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
    clearCookies: () => cookies.clear(),
    close: () => server.close(),
  };
}

// Logs a client in as the seeded default admin.
export async function loginAsAdmin(client) {
  const res = await client.post('/api/auth/login', { username: 'admin', password: 'admin' });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
  return res.body;
}

// Creates a user via the admin API (admin-managed model — no self-registration).
export async function createUser(adminClient, username, password, isAdmin = false) {
  const res = await adminClient.post('/api/admin/users', { username, password, isAdmin });
  if (res.status !== 201) throw new Error(`create user failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
