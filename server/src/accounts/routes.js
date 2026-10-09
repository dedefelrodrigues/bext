import { Router } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, institutions, transactions, uploads, users } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { snapshotQuietly } from '../db/backup.js';

const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_NAME = 120;

function publicAccount(row) {
  return {
    id: row.id,
    institutionId: row.institutionId,
    name: row.name,
    currency: row.currency,
    holder: row.holder,
    createdAt: row.createdAt,
  };
}

function getOwnedAccount(id, userId) {
  return db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .get();
}

function ownsInstitution(id, userId) {
  return !!db
    .select({ id: institutions.id })
    .from(institutions)
    .where(and(eq(institutions.id, id), eq(institutions.userId, userId)))
    .get();
}

// Validates and normalizes account fields from a request body. Returns
// { error } or { value }. `partial` allows missing fields (for PATCH).
function parseFields(body, partial) {
  const out = {};

  if (body?.name !== undefined || !partial) {
    const name = String(body?.name ?? '').trim();
    if (!name || name.length > MAX_NAME) return { error: 'Account name is required (max 120 chars).' };
    out.name = name;
  }
  if (body?.currency !== undefined || !partial) {
    const currency = String(body?.currency ?? '').trim().toUpperCase();
    if (!CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code (e.g. PLN).' };
    out.currency = currency;
  }
  if (body?.holder !== undefined) {
    const holder = String(body.holder).trim();
    if (holder.length > MAX_NAME) return { error: 'Holder name is too long (max 120 chars).' };
    out.holder = holder; // may be '' — caller decides the default
  }
  return { value: out };
}

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

// Per-account activity figures for the Accounts ledger: how much is in there,
// how far the history reaches, and when it was last fed. Two grouped queries
// rather than a join per account. Opt-in (`?stats=1`) because the other pages
// that read /accounts only need the names — they should not pay for a scan of
// the transactions table to fill a filter dropdown.
function accountStats(userId) {
  // Split children live in the same account as their parent; counting both
  // would report a split transaction twice, so only top-level rows count.
  const txRows = db
    .select({
      accountId: transactions.accountId,
      txCount: sql`count(*)`.mapWith(Number),
      firstDate: sql`min(${transactions.date})`,
      lastDate: sql`max(${transactions.date})`,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.parentId)))
    .groupBy(transactions.accountId)
    .all();

  const upRows = db
    .select({
      accountId: uploads.accountId,
      uploadCount: sql`count(*)`.mapWith(Number),
      lastUploadAt: sql`max(${uploads.uploadedAt})`,
      ofxCount: sql`sum(case when ${uploads.format} = 'ofx' then 1 else 0 end)`.mapWith(Number),
    })
    .from(uploads)
    .where(eq(uploads.userId, userId))
    .groupBy(uploads.accountId)
    .all();

  const byAccount = new Map();
  const blank = () => ({
    txCount: 0,
    firstDate: null,
    lastDate: null,
    uploadCount: 0,
    lastUploadAt: null,
    hasOfx: false,
  });
  for (const r of txRows) {
    byAccount.set(r.accountId, { ...blank(), txCount: r.txCount, firstDate: r.firstDate, lastDate: r.lastDate });
  }
  for (const r of upRows) {
    const entry = byAccount.get(r.accountId) ?? blank();
    entry.uploadCount = r.uploadCount;
    entry.lastUploadAt = r.lastUploadAt;
    entry.hasOfx = r.ofxCount > 0;
    byAccount.set(r.accountId, entry);
  }
  return { byAccount, blank };
}

accountsRouter.get('/', (req, res) => {
  const rows = db
    .select({
      id: accounts.id,
      institutionId: accounts.institutionId,
      institutionName: institutions.name,
      name: accounts.name,
      currency: accounts.currency,
      holder: accounts.holder,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.userId, req.userId))
    .orderBy(institutions.name, accounts.name)
    .all();

  if (req.query.stats !== '1') return res.json(rows);

  const { byAccount, blank } = accountStats(req.userId);
  res.json(rows.map((row) => ({ ...row, ...(byAccount.get(row.id) ?? blank()) })));
});

accountsRouter.post('/', (req, res) => {
  const institutionId = Number(req.body?.institutionId);
  if (!institutionId || !ownsInstitution(institutionId, req.userId)) {
    return res.status(400).json({ error: 'A valid institution is required.' });
  }
  const parsed = parseFields(req.body, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  // Holder defaults to the user's own username when left blank.
  let holder = parsed.value.holder;
  if (!holder) {
    holder = db.select({ username: users.username }).from(users).where(eq(users.id, req.userId)).get().username;
  }

  const created = db
    .insert(accounts)
    .values({ userId: req.userId, institutionId, name: parsed.value.name, currency: parsed.value.currency, holder })
    .returning()
    .get();
  res.status(201).json(publicAccount(created));
});

accountsRouter.patch('/:id', (req, res) => {
  const existing = getOwnedAccount(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Account not found.' });

  const parsed = parseFields(req.body, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const patch = { ...parsed.value };

  // Allow moving the account to another institution the user owns.
  if (req.body?.institutionId !== undefined) {
    const institutionId = Number(req.body.institutionId);
    if (!institutionId || !ownsInstitution(institutionId, req.userId)) {
      return res.status(400).json({ error: 'A valid institution is required.' });
    }
    patch.institutionId = institutionId;
  }
  if (patch.holder === '') delete patch.holder; // don't blank an existing holder
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  const updated = db.update(accounts).set(patch).where(eq(accounts.id, existing.id)).returning().get();
  res.json(publicAccount(updated));
});

accountsRouter.delete('/:id', (req, res) => {
  const existing = getOwnedAccount(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Account not found.' });
  // Deleting an account takes its transactions, templates and uploads with it.
  snapshotQuietly('before-account-delete');
  db.delete(accounts).where(eq(accounts.id, existing.id)).run();
  res.status(204).end();
});
