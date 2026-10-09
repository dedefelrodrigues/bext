import { parseDate } from './dates.js';
import { sumAmountColumns } from './amounts.js';
import { OVERFLOW } from './parse.js';

const CURRENCY_RE = /^[A-Z]{3}$/;

const FILTER_OPS = new Set(['equals', 'not_equals', 'contains', 'not_contains']);

// Whether a cell matches a filter's op+value. Case-insensitive and trimmed, so
// "completed" matches "COMPLETED" — banks are inconsistent about casing. The
// legacy not_* ops are still understood for templates saved before `mode`.
function matches(cell, op, value) {
  const c = String(cell ?? '').trim().toLowerCase();
  const v = String(value ?? '').trim().toLowerCase();
  if (op === 'equals') return c === v;
  if (op === 'not_equals') return c !== v;
  if (op === 'contains') return c.includes(v);
  if (op === 'not_contains') return !c.includes(v);
  return false;
}

// Does a raw row survive every saved filter? Each filter has a `mode`:
//   - exclude (default): drop the row when it matches the rule.
//   - include: keep only rows that match the rule.
// A filter with no mode is treated as include (the original pre-mode behavior,
// so legacy not_* filters still parse the same way).
export function passesFilters(row, filters) {
  for (const f of filters ?? []) {
    if (!f || !FILTER_OPS.has(f.op)) continue;
    const matched = matches(row[f.column], f.op, f.value);
    const mode = f.mode === 'exclude' ? 'exclude' : 'include';
    if (mode === 'exclude' && matched) return false; // matched → filtered out
    if (mode === 'include' && !matched) return false; // keep only matches
  }
  return true;
}

// Turn a raw row into a canonical transaction shape (or an error). Merges the
// description columns with single spaces, sums the amount columns into signed
// cents, parses the chosen date column, and resolves currency (column else the
// account currency) plus optional foreign amount/currency metadata.
export function buildCanonical(row, template, account) {
  if (row[OVERFLOW]) {
    return { error: 'More columns than the header: a delimiter inside a field shifted this line. Exclude it and add it by hand.' };
  }
  const description = (template.descriptionColumns ?? [])
    .map((c) => String(row[c] ?? '').trim())
    .filter((s) => s !== '')
    .join(' ');

  // Every amount cell empty is not a 0.00 transaction: it is a card hold, a
  // balance line or a note (ING prints holds with only a hold amount).
  const amountCells = (template.amountColumns ?? []).map((c) => String(row[c] ?? '').trim());
  if (amountCells.length && amountCells.every((c) => c === '')) return { error: 'No amount on this line (a card hold or a note?).' };
  const amountCents = sumAmountColumns(row, template.amountColumns ?? [], template.decimalSeparator);
  const date = parseDate(row[template.dateColumn], template.dateFormat);

  if (amountCents === null) return { error: 'Unparseable amount.' };
  if (!date) return { error: 'Unparseable date.' };
  if (description === '') return { error: 'Empty description.' };

  let currency = account.currency;
  if (template.currencyColumn) {
    const c = String(row[template.currencyColumn] ?? '').trim().toUpperCase();
    if (c && !CURRENCY_RE.test(c)) return { error: `Unreadable currency "${c}".` };
    if (c) currency = c;
  }

  let foreignAmountCents = null;
  let foreignCurrency = null;
  if (template.foreignAmountColumn) {
    const fc = sumAmountColumns(row, [template.foreignAmountColumn], template.decimalSeparator);
    if (fc !== null) foreignAmountCents = fc;
  }
  if (template.foreignCurrencyColumn) {
    const fcur = String(row[template.foreignCurrencyColumn] ?? '').trim().toUpperCase();
    if (CURRENCY_RE.test(fcur)) foreignCurrency = fcur;
  }

  return { date, description, amountCents, currency, foreignAmountCents, foreignCurrency };
}

export function dedupKey(canonical) {
  return `${canonical.date}|${canonical.description}|${canonical.amountCents}`;
}
