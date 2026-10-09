import { one, str } from './tokenize.js';
import { parseAmountToCents } from '../amounts.js';

// One `STMTTRN` → the same canonical shape the CSV path's `buildCanonical`
// returns, so everything downstream (dedup, classification, business-flag
// defaulting, the confirm insert) is shared rather than duplicated.

// The description fields a user may merge, in the order they appear in the UI.
export const DESCRIPTION_FIELDS = ['NAME', 'MEMO', 'PAYEE.NAME', 'CHECKNUM', 'TRNTYPE'];
export const DEFAULT_DESCRIPTION_FIELDS = ['NAME', 'MEMO'];

// `DTPOSTED` is `YYYYMMDD[HHMMSS[.sss]][±h:TZ]`. We keep the date exactly as
// written and ignore the bracketed timezone, so a transaction lands on the day
// the bank shows it rather than being shifted by the reader's offset.
export function parseOfxDate(value) {
  const m = String(value ?? '').trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

// `TRNAMT` is specified as dot-decimal, but a few European exports emit a comma.
// A trailing `,dd`/`,d` with no dot anywhere is unambiguously a decimal comma;
// anything else parses as dot-decimal (where a comma is a thousands separator).
export function parseOfxAmount(value) {
  const s = String(value ?? '').trim();
  if (s === '') return null;
  const commaDecimal = !s.includes('.') && /,\d{1,2}$/.test(s);
  return parseAmountToCents(s, commaDecimal ? ',' : '.');
}

function fieldValue(txn, field) {
  if (field === 'PAYEE.NAME') {
    const payee = one(txn, 'PAYEE');
    return payee && typeof payee === 'object' ? str(payee, 'NAME') : '';
  }
  return str(txn, field);
}

// Join the configured fields with single spaces, skipping empties and any field
// that merely repeats text already in the description (banks routinely copy NAME
// into MEMO verbatim).
export function buildDescription(txn, fields) {
  const parts = [];
  for (const field of fields?.length ? fields : DEFAULT_DESCRIPTION_FIELDS) {
    const value = fieldValue(txn, field);
    if (!value) continue;
    if (parts.some((p) => p.toLowerCase() === value.toLowerCase())) continue;
    parts.push(value);
  }
  return parts.join(' ');
}

// A `CURRENCY`/`ORIGCURRENCY` aggregate: `{ sym, rate }` (or null).
function currencyBlock(txn, tag) {
  const node = one(txn, tag);
  if (node == null) return null;
  if (typeof node === 'string') {
    const sym = node.trim().toUpperCase();
    return sym ? { sym, rate: null } : null;
  }
  const sym = str(node, 'CURSYM').toUpperCase();
  const rate = Number(str(node, 'CURRATE'));
  return sym ? { sym, rate: Number.isFinite(rate) && rate > 0 ? rate : null } : null;
}

// Build the canonical row for one `STMTTRN`, or `{ error }` when a required
// field is missing — mirroring `buildCanonical`, so bad rows show up in the
// preview as `error` rows rather than failing the whole import.
export function buildCanonicalOfx(txn, { curdef, fields, account }) {
  const date = parseOfxDate(str(txn, 'DTPOSTED') || str(txn, 'DTUSER') || str(txn, 'DTAVAIL'));
  const amountCents = parseOfxAmount(str(txn, 'TRNAMT'));
  const description = buildDescription(txn, fields);

  if (amountCents === null) return { error: 'Unparseable amount.' };
  if (!date) return { error: 'Unparseable date.' };
  if (description === '') return { error: 'Empty description.' };

  // `CURRENCY` means TRNAMT itself is in that currency; `ORIGCURRENCY` means
  // TRNAMT is in the statement default and the original was in CURSYM, where
  // CURRATE converts CURSYM → statement default. Recording the original amount
  // in `foreign*` hands Phase 7's FX chain a per-row derived rate for free.
  const txnCurrency = currencyBlock(txn, 'CURRENCY');
  const orig = currencyBlock(txn, 'ORIGCURRENCY');
  const currency = txnCurrency?.sym || curdef || account.currency;

  let foreignAmountCents = null;
  let foreignCurrency = null;
  if (orig && orig.sym !== currency) {
    foreignCurrency = orig.sym;
    if (orig.rate) foreignAmountCents = Math.round(amountCents / orig.rate);
  }

  const fitid = str(txn, 'FITID');
  return { date, description, amountCents, currency, foreignAmountCents, foreignCurrency, fitid: fitid || null };
}
