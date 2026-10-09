import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { fxRates, transactions } from '../db/schema.js';

// --- FX conversion ------------------------------------------------------
//
// Converts a transaction's signed minor units into a single display currency,
// following the locked fallback chain:
//
//   1. the rate derived from the row's own amount pair — either the row already
//      carries the target-currency amount (`foreignCurrency === target`), or a
//      *different* row of the same user pins the (from → to) rate for that date;
//   2. a user-uploaded rate table (`fx_rates`);
//   3. a live daily-rate API — deferred, not in v1.
//
// Nothing is ever silently guessed: a row we cannot convert comes back with
// `converted: false` so the UI can show it unconverted and visibly flagged.

const key = (from, to) => `${from}>${to}`;

// A pair index: key -> [{ date, rate }] sorted by date ascending.
function addRate(index, from, to, date, rate) {
  if (!Number.isFinite(rate) || rate <= 0 || from === to) return;
  const k = key(from, to);
  let list = index.get(k);
  if (!list) index.set(k, (list = []));
  // First writer for a (pair, date) wins — callers add in priority order.
  if (!list.some((e) => e.date === date)) list.push({ date, rate });
}

function sortIndex(index) {
  for (const list of index.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return index;
}

// The rate in effect for `date`: the latest entry on or before it. Falls back
// to the direct pair first, then to the inverse pair (1/rate).
function lookup(index, from, to, date) {
  const direct = pick(index.get(key(from, to)), date);
  if (direct != null) return direct;
  const inverse = pick(index.get(key(to, from)), date);
  return inverse != null ? 1 / inverse : null;
}

function pick(list, date) {
  if (!list || list.length === 0) return null;
  let found = null;
  for (const entry of list) {
    if (entry.date > date) break;
    found = entry.rate;
  }
  return found;
}

// Rates implied by transactions that carry both amount pairs (e.g. Alior's
// operation currency vs. account currency): 1 foreignCurrency = amount/foreign
// units of currency, on that row's date.
function derivedIndex(userId) {
  const rows = db
    .select({
      date: transactions.date,
      currency: transactions.currency,
      amountCents: transactions.amountCents,
      foreignCurrency: transactions.foreignCurrency,
      foreignAmountCents: transactions.foreignAmountCents,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNotNull(transactions.foreignCurrency),
        isNotNull(transactions.foreignAmountCents),
        ne(transactions.foreignAmountCents, 0),
      ),
    )
    .all();

  const index = new Map();
  for (const r of rows) {
    if (!r.foreignCurrency || r.foreignCurrency === r.currency) continue;
    const rate = Math.abs(r.amountCents) / Math.abs(r.foreignAmountCents);
    addRate(index, r.foreignCurrency, r.currency, r.date, rate);
  }
  return sortIndex(index);
}

function uploadedIndex(userId) {
  const rows = db.select().from(fxRates).where(eq(fxRates.userId, userId)).all();
  const index = new Map();
  for (const r of rows) addRate(index, r.fromCcy, r.toCcy, r.date, r.rate);
  return sortIndex(index);
}

/**
 * Builds a converter into `target` for one user.
 *
 * `convert(row)` takes anything carrying { date, currency, amountCents,
 * foreignCurrency, foreignAmountCents } and returns
 * `{ cents, converted, source }` where `source` is one of
 * 'same' | 'row' | 'derived' | 'uploaded' | null.
 */
export function buildConverter(userId, target) {
  const to = String(target || '').toUpperCase();
  const derived = derivedIndex(userId);
  const uploaded = uploadedIndex(userId);

  function convert(row) {
    const from = row.currency;
    if (!to || from === to) return { cents: row.amountCents, converted: true, source: 'same' };

    // The row itself already states the amount in the target currency.
    if (row.foreignCurrency === to && row.foreignAmountCents != null) {
      // Keep the canonical sign — the foreign leg of a pair is same-signed in
      // every sample, but guard against a table that stores it unsigned.
      const magnitude = Math.abs(row.foreignAmountCents);
      return { cents: row.amountCents < 0 ? -magnitude : magnitude, converted: true, source: 'row' };
    }

    for (const [index, source] of [
      [derived, 'derived'],
      [uploaded, 'uploaded'],
    ]) {
      const rate = lookup(index, from, to, row.date);
      if (rate != null) return { cents: Math.round(row.amountCents * rate), converted: true, source };
    }

    return { cents: row.amountCents, converted: false, source: null };
  }

  return { target: to, convert };
}
