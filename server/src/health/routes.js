import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { healthDismissals, transactions } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { snapshotQuietly } from '../db/backup.js';
import { runChecks } from './checks.js';

export const healthRouter = Router();
healthRouter.use(requireAuth);

function dismissals(userId) {
  return new Map(
    db.select().from(healthDismissals).where(eq(healthDismissals.userId, userId)).all().map((d) => [d.key, d.fingerprint]),
  );
}

// A finding is dismissed while its evidence matches what was dismissed.
async function withDismissals(userId) {
  const dismissed = dismissals(userId);
  return (await runChecks(userId)).map((f) => ({ ...f, dismissed: dismissed.get(f.key) === f.fingerprint }));
}

healthRouter.get('/', async (req, res) => {
  res.json({ findings: await withDismissals(req.userId) });
});

// For the Home attention strip: open findings only, by severity.
healthRouter.get('/summary', async (req, res) => {
  const open = (await withDismissals(req.userId)).filter((f) => !f.dismissed);
  res.json({
    open: open.length,
    high: open.filter((f) => f.severity === 'high').length,
    medium: open.filter((f) => f.severity === 'medium').length,
    low: open.filter((f) => f.severity === 'low').length,
  });
});

healthRouter.post('/dismiss', (req, res) => {
  const key = String(req.body?.key ?? '');
  const fp = String(req.body?.fingerprint ?? '');
  if (!key || !fp) return res.status(400).json({ error: 'Name the finding.' });
  db.insert(healthDismissals)
    .values({ userId: req.userId, key, fingerprint: fp })
    .onConflictDoUpdate({ target: [healthDismissals.userId, healthDismissals.key], set: { fingerprint: fp } })
    .run();
  res.json({ ok: true });
});

healthRouter.post('/restore', (req, res) => {
  const key = String(req.body?.key ?? '');
  db.delete(healthDismissals).where(and(eq(healthDismissals.userId, req.userId), eq(healthDismissals.key, key))).run();
  res.json({ ok: true });
});

// Imported rows are immutable and cannot be deleted one by one — except a line
// that carries no amount at all, which is not a transaction (a card hold, a
// statement's closing line). Only 0.00 rows of this user are touched, and the
// database is snapshotted first, as before anything that destroys transactions.
healthRouter.post('/delete-empty-rows', (req, res) => {
  const ids = Array.isArray(req.body?.transactionIds)
    ? [...new Set(req.body.transactionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (!ids.length) return res.status(400).json({ error: 'Select the rows to delete.' });
  const targets = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.userId, req.userId), eq(transactions.amountCents, 0), inArray(transactions.id, ids)))
    .all()
    .map((r) => r.id);
  if (!targets.length) return res.json({ deleted: 0 });
  snapshotQuietly('before-health-delete');
  db.delete(transactions).where(inArray(transactions.id, targets)).run();
  res.json({ deleted: targets.length });
});
