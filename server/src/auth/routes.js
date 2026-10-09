import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from './password.js';
import { requireAuth } from './middleware.js';

const MIN_PASSWORD = 8;

// Public projection of a user row — never leaks the password hash.
export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.isAdmin,
    passwordIsDefault: row.passwordIsDefault,
    theme: row.theme,
    defaultCurrency: row.defaultCurrency,
    globalFuzzyDistance: row.globalFuzzyDistance,
    transactionsPageSize: row.transactionsPageSize,
  };
}

export const authRouter = Router();

// No public registration — accounts are created by an admin (see admin routes).

authRouter.post('/login', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');

  const row = db.select().from(users).where(eq(users.username, username)).get();
  // Always run a comparison to avoid leaking whether the username exists.
  const ok = row
    ? await verifyPassword(password, row.passwordHash)
    : await verifyPassword(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinv');

  if (!row || !ok) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  req.session.userId = row.id;
  res.json(publicUser(row));
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('bext.sid');
    res.status(204).end();
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const row = db.select().from(users).where(eq(users.id, req.userId)).get();
  if (!row) {
    // Session references a deleted user — clear it.
    return req.session.destroy(() => res.status(401).json({ error: 'Not authenticated' }));
  }
  res.json(publicUser(row));
});

// A logged-in user changes their own password (also clears the default-password
// flag used to nudge the seeded admin).
authRouter.post('/change-password', requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? '');
  const newPassword = String(req.body?.newPassword ?? '');

  if (newPassword.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }

  const row = db.select().from(users).where(eq(users.id, req.userId)).get();
  const ok = await verifyPassword(currentPassword, row.passwordHash);
  if (!ok) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  const passwordHash = await hashPassword(newPassword);
  const updated = db
    .update(users)
    .set({ passwordHash, passwordIsDefault: false })
    .where(eq(users.id, req.userId))
    .returning()
    .get();

  res.json(publicUser(updated));
});
