import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { offbookAccounts, transactions, transferDecisions } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { OFFBOOK_KINDS, transfersView } from './reconcile.js';

export const transfersRouter = Router();
transfersRouter.use(requireAuth);

transfersRouter.get('/', (req, res) => res.json(transfersView(req.userId)));

// --- Off-book accounts ---------------------------------------------------------

// Patterns arrive as a list (or one text, one pattern per line or comma).
function parseOffbook(body, partial = false) {
  const out = {};
  if (body?.name !== undefined || !partial) {
    const name = String(body?.name ?? '').trim();
    if (!name) return { error: 'Name the account.' };
    out.name = name.slice(0, 120);
  }
  if (body?.kind !== undefined || !partial) {
    const kind = String(body?.kind ?? 'other');
    if (!OFFBOOK_KINDS.includes(kind)) return { error: 'Unknown kind.' };
    out.kind = kind;
  }
  if (body?.patterns !== undefined || !partial) {
    const raw = Array.isArray(body?.patterns) ? body.patterns : String(body?.patterns ?? '').split(/[\n,]/);
    const patterns = [...new Set(raw.map((p) => String(p).trim()).filter(Boolean))].slice(0, 50);
    if (!patterns.length) return { error: 'Give at least one text that identifies its rows.' };
    out.patterns = patterns;
  }
  return { value: out };
}

const owned = (id, userId) =>
  db.select().from(offbookAccounts).where(and(eq(offbookAccounts.id, Number(id)), eq(offbookAccounts.userId, userId))).get();

transfersRouter.post('/offbook', (req, res) => {
  const p = parseOffbook(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const created = db.insert(offbookAccounts).values({ userId: req.userId, ...p.value }).returning().get();
  res.status(201).json(created);
});

transfersRouter.patch('/offbook/:id', (req, res) => {
  const existing = owned(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Off-book account not found.' });
  const p = parseOffbook(req.body, true);
  if (p.error) return res.status(400).json({ error: p.error });
  if (!Object.keys(p.value).length) return res.status(400).json({ error: 'Nothing to update.' });
  res.json(db.update(offbookAccounts).set(p.value).where(eq(offbookAccounts.id, existing.id)).returning().get());
});

transfersRouter.delete('/offbook/:id', (req, res) => {
  const existing = owned(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Off-book account not found.' });
  db.delete(offbookAccounts).where(eq(offbookAccounts.id, existing.id)).run();
  res.status(204).end();
});

// --- Pair decisions --------------------------------------------------------------
//
// `confirmed`: these two are a pair. `rejected`: never propose them together
// again. The outgoing leg is whichever of the two is negative; both must be
// this user's, in different accounts, of opposite sign.
function parsePair(body, userId) {
  const ids = [Number(body?.outId), Number(body?.inId)];
  if (!ids.every((n) => Number.isInteger(n) && n > 0) || ids[0] === ids[1]) return { error: 'Name two transactions.' };
  const rows = db
    .select({ id: transactions.id, amountCents: transactions.amountCents, accountId: transactions.accountId })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, ids)))
    .all();
  if (rows.length !== 2) return { error: 'Transaction not found.', status: 404 };
  const [a, b] = rows;
  if (a.accountId === b.accountId) return { error: 'A pair spans two accounts.' };
  if (Math.sign(a.amountCents) !== -Math.sign(b.amountCents) || a.amountCents === 0) return { error: 'A pair is money out on one side and in on the other.' };
  const [o, i] = a.amountCents < 0 ? [a, b] : [b, a];
  return { value: { outId: o.id, inId: i.id } };
}

transfersRouter.post('/decisions', (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!['confirmed', 'rejected'].includes(status)) return res.status(400).json({ error: 'Confirm or reject.' });
  const p = parsePair(req.body, req.userId);
  if (p.error) return res.status(p.status ?? 400).json({ error: p.error });
  db.insert(transferDecisions)
    .values({ userId: req.userId, ...p.value, status })
    .onConflictDoUpdate({ target: [transferDecisions.outId, transferDecisions.inId], set: { status } })
    .run();
  res.json({ ok: true });
});

transfersRouter.post('/decisions/undo', (req, res) => {
  const p = parsePair(req.body, req.userId);
  if (p.error) return res.status(p.status ?? 400).json({ error: p.error });
  db.delete(transferDecisions)
    .where(and(eq(transferDecisions.userId, req.userId), eq(transferDecisions.outId, p.value.outId), eq(transferDecisions.inId, p.value.inId)))
    .run();
  res.json({ ok: true });
});
