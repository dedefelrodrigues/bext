import { Router } from 'express';
import { basename } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { users, transactions, uploads, hashtags } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { publicUser } from '../auth/routes.js';
import { snapshot, snapshotQuietly, listBackups, KEEP, backupDir } from '../db/backup.js';

const CURRENCY_RE = /^[A-Z]{3}$/;
const THEMES = new Set(['light', 'dark']);
// The transaction list's page size (also its "load more" step). There is no
// upper bound — 0 means "load every transaction at once", which the settings
// page offers with a warning about how it renders. A floor keeps a typo like 1
// from turning the list into a one-row-per-request pager.
const MIN_PAGE_SIZE = 10;
const ALL_PAGE_SIZE = 0;

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

settingsRouter.get('/', (req, res) => {
  const row = db.select().from(users).where(eq(users.id, req.userId)).get();
  res.json({
    theme: row.theme,
    defaultCurrency: row.defaultCurrency,
    globalFuzzyDistance: row.globalFuzzyDistance,
    transactionsPageSize: row.transactionsPageSize,
  });
});

settingsRouter.put('/', (req, res) => {
  const patch = {};

  if (req.body?.theme !== undefined) {
    const theme = String(req.body.theme);
    if (!THEMES.has(theme)) {
      return res.status(400).json({ error: 'Theme must be "light" or "dark".' });
    }
    patch.theme = theme;
  }

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

  if (req.body?.transactionsPageSize !== undefined) {
    const size = Number(req.body.transactionsPageSize);
    if (!Number.isInteger(size) || (size !== ALL_PAGE_SIZE && size < MIN_PAGE_SIZE)) {
      return res.status(400).json({ error: `Transactions per page must be 0 (all) or a whole number of at least ${MIN_PAGE_SIZE}.` });
    }
    patch.transactionsPageSize = size;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  const updated = db
    .update(users)
    .set(patch)
    .where(eq(users.id, req.userId))
    .returning()
    .get();

  res.json(publicUser(updated));
});

// --- Danger zone: wipe the signed-in user's own transaction data ---
//
// Scoped to `req.userId` on purpose, which is also why it lives here rather than
// under /admin: clearing your own data is a per-user action, so the isolation
// rule holds and no button can reach another user's transactions.
//
// What goes: transactions (split children follow via the self-FK cascade), the
// upload archive rows, and the hashtag vocabulary. What stays: institutions,
// accounts, CSV templates, OFX settings, categories, subcategories, keywords
// and FX rates — the setup you would otherwise have to rebuild by hand.

function clearStats(userId) {
  const txns = db
    .select({ id: transactions.id, isLocked: transactions.isLocked, parentId: transactions.parentId })
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .all();
  const parentIds = new Set(txns.map((t) => t.parentId).filter((p) => p != null));

  return {
    transactions: txns.length,
    // Same warning surface as an upload rollback: manual categorizations and
    // splits are the work that cannot be recreated by re-importing.
    locked: txns.filter((t) => t.isLocked).length,
    split: txns.filter((t) => t.parentId != null || parentIds.has(t.id)).length,
    uploads: db.select({ n: sql`count(*)` }).from(uploads).where(eq(uploads.userId, userId)).get().n,
    hashtags: db.select({ n: sql`count(*)` }).from(hashtags).where(eq(hashtags.userId, userId)).get().n,
  };
}

settingsRouter.get('/clear-transactions', (req, res) => {
  res.json(clearStats(req.userId));
});

settingsRouter.post('/clear-transactions', (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Confirmation required.' });
  }

  const deleted = clearStats(req.userId);
  const userId = req.userId;
  snapshotQuietly('before-clear');

  // One transaction: a half-cleared database (transactions gone, archive kept)
  // would leave the Uploads page listing imports whose rows no longer exist.
  sqlite.transaction(() => {
    // Deleting uploads would cascade to their transactions anyway, but manual
    // entries carry no uploadId — so clear transactions explicitly first.
    db.delete(transactions).where(eq(transactions.userId, userId)).run();
    db.delete(uploads).where(eq(uploads.userId, userId)).run();
    // transaction_hashtags rows are already gone via the cascade above; this
    // drops the now-unused names too.
    db.delete(hashtags).where(eq(hashtags.userId, userId)).run();
  })();

  res.json({ deleted });
});

// --- Backups ---
//
// A snapshot covers the whole file — every user's data — so this lists names,
// sizes and reasons but never hands the file back over HTTP. The folder is in
// the project (`server/data/backups`), which is where you go to fetch one; a
// restore is a CLI job anyway, since it needs the server to let go of the file.

settingsRouter.get('/backups', (req, res) => {
  res.json({ dir: backupDir(), keep: KEEP, backups: listBackups() });
});

settingsRouter.post('/backups', (req, res) => {
  try {
    const file = snapshot('manual');
    res.status(201).json({ dir: backupDir(), keep: KEEP, created: basename(file), backups: listBackups() });
  } catch (err) {
    res.status(500).json({ error: `Could not write the backup: ${err.message}` });
  }
});
