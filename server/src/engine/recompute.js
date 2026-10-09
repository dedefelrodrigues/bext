import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, keywords, transactions } from '../db/schema.js';
import { classifyDescription, prepareKeywords } from './classify.js';

// Re-runs the classification engine over a user's imported transactions and
// persists the result. Called after any keyword add/edit/delete (rule change).
//
// The engine only ever touches engine-owned rows: it skips locked (manual)
// categorizations, split children, and split containers (parents). A row that no
// keyword matches reverts to uncategorized (category/subcategory/matchedKeyword
// all NULL) — this is how deleting a keyword un-classifies its transactions
// unless another keyword still wins. Manual transactions are the user's to
// categorize and are left alone.
//
// Runs in a single DB transaction so the recompute is atomic. Returns the number
// of transactions whose assignment changed.
export function recomputeUser(userId) {
  const user = db.select({ d: users.globalFuzzyDistance }).from(users).where(eq(users.id, userId)).get();
  if (!user) return 0;

  const kws = db
    .select({ id: keywords.id, categoryId: keywords.categoryId, subcategoryId: keywords.subcategoryId, text: keywords.text, distance: keywords.distance })
    .from(keywords)
    .where(eq(keywords.userId, userId))
    .all();
  const prepared = prepareKeywords(kws, user.d);

  // Candidate rows: this user's imported, non-locked, non-child transactions.
  const rows = db
    .select({
      id: transactions.id,
      description: transactions.description,
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
      matchedKeywordId: transactions.matchedKeywordId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.isLocked, false),
        eq(transactions.isManual, false),
        isNull(transactions.parentId),
      ),
    )
    .all();

  // Split containers (rows that are a parent of another row) are never touched.
  const parentIds = new Set(
    db
      .select({ parentId: transactions.parentId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), isNotNull(transactions.parentId)))
      .all()
      .map((r) => r.parentId),
  );

  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (parentIds.has(row.id)) continue; // container
      const match = classifyDescription(row.description, prepared);
      const nextCat = match ? match.categoryId : null;
      const nextSub = match ? match.subcategoryId : null;
      const nextKw = match ? match.id : null;

      if (row.categoryId === nextCat && row.subcategoryId === nextSub && row.matchedKeywordId === nextKw) {
        continue;
      }
      db.update(transactions)
        .set({ categoryId: nextCat, subcategoryId: nextSub, matchedKeywordId: nextKw })
        .where(eq(transactions.id, row.id))
        .run();
      changed++;
    }
  });
  return changed;
}
