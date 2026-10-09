import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { institutions, accounts } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';

const MAX_NAME = 120;

function publicInstitution(row) {
  return { id: row.id, name: row.name, createdAt: row.createdAt };
}

// Fetches an institution only if it belongs to the requesting user (isolation).
function getOwned(id, userId) {
  return db
    .select()
    .from(institutions)
    .where(and(eq(institutions.id, id), eq(institutions.userId, userId)))
    .get();
}

export const institutionsRouter = Router();
institutionsRouter.use(requireAuth);

institutionsRouter.get('/', (req, res) => {
  const rows = db
    .select()
    .from(institutions)
    .where(eq(institutions.userId, req.userId))
    .orderBy(institutions.name)
    .all();
  res.json(rows.map(publicInstitution));
});

institutionsRouter.post('/', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > MAX_NAME) {
    return res.status(400).json({ error: 'Institution name is required (max 120 chars).' });
  }
  const created = db
    .insert(institutions)
    .values({ userId: req.userId, name })
    .returning()
    .get();
  res.status(201).json(publicInstitution(created));
});

institutionsRouter.patch('/:id', (req, res) => {
  const existing = getOwned(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Institution not found.' });

  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > MAX_NAME) {
    return res.status(400).json({ error: 'Institution name is required (max 120 chars).' });
  }
  const updated = db
    .update(institutions)
    .set({ name })
    .where(eq(institutions.id, existing.id))
    .returning()
    .get();
  res.json(publicInstitution(updated));
});

institutionsRouter.delete('/:id', (req, res) => {
  const existing = getOwned(Number(req.params.id), req.userId);
  if (!existing) return res.status(404).json({ error: 'Institution not found.' });

  const { n } = db
    .select({ n: sql`count(*)` })
    .from(accounts)
    .where(eq(accounts.institutionId, existing.id))
    .get();
  if (n > 0) {
    return res
      .status(409)
      .json({ error: 'Delete or move its accounts before deleting this institution.' });
  }

  db.delete(institutions).where(eq(institutions.id, existing.id)).run();
  res.status(204).end();
});
