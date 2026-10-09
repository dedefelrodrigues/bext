import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, appSettings } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { publicUser } from '../auth/routes.js';
import { seedUserCategories } from '../db/seed.js';
import { snapshotQuietly } from '../db/backup.js';

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MIN_PASSWORD = 8;

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

function countAdmins() {
  return db
    .select({ n: sql`count(*)` })
    .from(users)
    .where(eq(users.isAdmin, true))
    .get().n;
}

function getAppSettings() {
  return db.select().from(appSettings).where(eq(appSettings.id, 1)).get();
}

// --- User management ---

adminRouter.get('/users', (_req, res) => {
  const rows = db.select().from(users).orderBy(users.username).all();
  res.json(rows.map((r) => ({ ...publicUser(r), createdAt: r.createdAt })));
});

adminRouter.post('/users', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const isAdmin = Boolean(req.body?.isAdmin);

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars (letters, digits, . _ -).' });
  }
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }
  if (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
    return res.status(409).json({ error: 'Username already taken.' });
  }

  // New users inherit the current app-default settings as a snapshot.
  const settings = getAppSettings();
  const passwordHash = await hashPassword(password);
  const created = db
    .insert(users)
    .values({
      username,
      passwordHash,
      isAdmin,
      passwordIsDefault: false,
      defaultCurrency: settings.defaultCurrency,
      globalFuzzyDistance: settings.globalFuzzyDistance,
    })
    .returning()
    .get();

  // Give the new user their own seeded categories/subcategories/keywords.
  seedUserCategories(created.id);

  res.status(201).json(publicUser(created));
});

adminRouter.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (req.body?.isAdmin !== undefined) {
    const isAdmin = Boolean(req.body.isAdmin);
    // Never allow removing the last admin.
    if (target.isAdmin && !isAdmin && countAdmins() <= 1) {
      return res.status(409).json({ error: 'Cannot remove the last admin.' });
    }
    const updated = db.update(users).set({ isAdmin }).where(eq(users.id, id)).returning().get();
    return res.json(publicUser(updated));
  }

  res.status(400).json({ error: 'Nothing to update.' });
});

adminRouter.post('/users/:id/password', async (req, res) => {
  const id = Number(req.params.id);
  const newPassword = String(req.body?.newPassword ?? '');
  if (newPassword.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }
  const target = db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const passwordHash = await hashPassword(newPassword);
  db.update(users).set({ passwordHash, passwordIsDefault: false }).where(eq(users.id, id)).run();
  res.status(204).end();
});

adminRouter.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.userId) {
    return res.status(409).json({ error: 'You cannot delete your own account.' });
  }
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.isAdmin && countAdmins() <= 1) {
    return res.status(409).json({ error: 'Cannot delete the last admin.' });
  }
  // Everything a user owns cascades away with them.
  snapshotQuietly('before-user-delete');
  db.delete(users).where(eq(users.id, id)).run();
  res.status(204).end();
});

// --- Application default settings ---

adminRouter.get('/app-settings', (_req, res) => {
  const s = getAppSettings();
  res.json({ defaultCurrency: s.defaultCurrency, globalFuzzyDistance: s.globalFuzzyDistance });
});

adminRouter.put('/app-settings', (req, res) => {
  const patch = {};
  if (req.body?.defaultCurrency !== undefined) {
    const currency = String(req.body.defaultCurrency).trim().toUpperCase();
    if (!CURRENCY_RE.test(currency)) {
      return res.status(400).json({ error: 'Currency must be a 3-letter code (e.g. PLN).' });
    }
    patch.defaultCurrency = currency;
  }
  if (req.body?.globalFuzzyDistance !== undefined) {
    const distance = Number(req.body.globalFuzzyDistance);
    if (!Number.isInteger(distance) || distance < 0) {
      return res.status(400).json({ error: 'Fuzzy distance must be a non-negative integer.' });
    }
    patch.globalFuzzyDistance = distance;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  const updated = db.update(appSettings).set(patch).where(eq(appSettings.id, 1)).returning().get();
  res.json({ defaultCurrency: updated.defaultCurrency, globalFuzzyDistance: updated.globalFuzzyDistance });
});
