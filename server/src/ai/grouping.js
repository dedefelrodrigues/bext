import { and, eq, gte, isNull, isNotNull, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, aiProposals, aiProposalTransactions, transactions } from '../db/schema.js';
import { tokenize } from '../engine/classify.js';

// Merchant grouping.
//
// An uncategorized list is mostly the same shops over and over: 40 rows of a
// convenience store with a different branch number each time. A proposal is a
// *keyword* rule, which covers all of them at once, so the unit of analysis is
// the merchant, not the row — one lookup answers forty transactions, and
// "analyze 25" means 25 merchants rather than 25 repetitions of three.
//
// The group key is the description reduced to what identifies the business:
// lowercased, diacritics stripped (the engine's own tokenizer, so grouping and
// classification agree on what a word is), then every token that is a number,
// a single letter, or a date/reference fragment dropped. "ZABKA Z7412 KRAKOW"
// and "ZABKA Z8155 KRAKOW" both land on `zabka krakow`.

const MAX_KEY_TOKENS = 8; // a long description is a reference number with a shop in it

export function groupKeyOf(description) {
  const tokens = tokenize(description)
    .filter((t) => t.length > 1 && !/^\d+$/.test(t))
    .slice(0, MAX_KEY_TOKENS);
  // Nothing but numbers (a bare transfer reference): the whole normalized
  // description is the best key available — it will group exact repeats only.
  return tokens.length ? tokens.join(' ') : tokenize(description).join(' ');
}

// Group keys this engine has already proposed for. The database also refuses a
// duplicate (the unique index on user+engine+group), but the run should never
// spend a provider call to find that out.
export function analyzedGroupKeys(userId, engineKey) {
  return new Set(
    db
      .select({ groupKey: aiProposals.groupKey })
      .from(aiProposals)
      .where(and(eq(aiProposals.userId, userId), eq(aiProposals.engineKey, engineKey)))
      .all()
      .map((r) => r.groupKey),
  );
}

// Every transaction id that already carries a proposal from any engine, with the
// engines that proposed it — the log the review page reads to mark a row.
export function proposedTransactionIds(userId) {
  return db
    .select({ transactionId: aiProposalTransactions.transactionId, engineKey: aiProposals.engineKey })
    .from(aiProposalTransactions)
    .innerJoin(aiProposals, eq(aiProposals.id, aiProposalTransactions.proposalId))
    .where(eq(aiProposals.userId, userId))
    .all();
}

// The uncategorized rows an AI run may look at: this user's, with no category,
// and never a split container (a split counts once, through its children).
export function uncategorizedRows(userId, filters = {}) {
  const where = [eq(transactions.userId, userId), isNull(transactions.categoryId)];
  if (filters.accountId) where.push(eq(transactions.accountId, Number(filters.accountId)));
  if (filters.from) where.push(gte(transactions.date, String(filters.from)));
  if (filters.to) where.push(lte(transactions.date, String(filters.to)));

  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      date: transactions.date,
      description: transactions.description,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      isManual: transactions.isManual,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(...where))
    .all();

  const containers = new Set(
    db
      .select({ parentId: transactions.parentId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), isNotNull(transactions.parentId)))
      .all()
      .map((r) => r.parentId),
  );
  return rows.filter((r) => !containers.has(r.id));
}

// Rows → merchant groups, biggest first: the merchant that owns the most
// transactions is the one worth a lookup, so a capped run spends its budget
// where it buys the most classification.
export function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupKeyOf(row.description);
    let group = groups.get(key);
    if (!group) {
      group = { groupKey: key, rows: [], descriptions: new Map() };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.descriptions.set(row.description, (group.descriptions.get(row.description) ?? 0) + 1);
  }

  return [...groups.values()]
    .map((group) => {
      const variants = [...group.descriptions.entries()].sort((a, b) => b[1] - a[1]);
      return {
        groupKey: group.groupKey,
        rows: group.rows,
        txCount: group.rows.length,
        sampleDescription: variants[0][0],
        variants: variants.map(([description, count]) => ({ description, count })),
      };
    })
    .sort((a, b) => b.txCount - a.txCount || a.groupKey.localeCompare(b.groupKey));
}

// What a run would do, without doing it: how many merchants are waiting, how
// many this engine has already answered, and which ones come next.
export function planRun(userId, engineKey, filters, limit) {
  const rows = uncategorizedRows(userId, filters);
  const groups = groupRows(rows);
  const analyzed = analyzedGroupKeys(userId, engineKey);
  const eligible = groups.filter((g) => !analyzed.has(g.groupKey));
  return {
    uncategorized: rows.length,
    merchants: groups.length,
    alreadyAnalyzed: groups.length - eligible.length,
    eligible: eligible.length,
    selected: limit > 0 ? eligible.slice(0, limit) : eligible,
  };
}
