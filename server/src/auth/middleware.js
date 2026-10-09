import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

// Gates a route behind an authenticated session. On success it injects
// `req.userId` so downstream handlers scope every query to the session user —
// data isolation is enforced here, not left to individual handlers.
export function requireAuth(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.userId = userId;
  next();
}

// Gates admin-only routes. Must be mounted after requireAuth.
export function requireAdmin(req, res, next) {
  const row = db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, req.userId)).get();
  if (!row?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
