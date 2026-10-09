import { readStatements, OfxError } from './statement.js';
import { buildCanonicalOfx, DEFAULT_DESCRIPTION_FIELDS } from './transform.js';
import { dedupKey } from '../transform.js';

export { OfxError };

// OFX rows dedup by the bank's own transaction id when it sends one. The prefix
// keeps the two key spaces apart so a `fitid:` can never collide with a
// `date|description|amount` key. Known trade-off (locked in PLAN.md): the same
// statement imported once as CSV and once as OFX will not dedup against itself.
export function ofxDedupKey(canonical) {
  return canonical.fitid ? `fitid:${canonical.fitid}` : dedupKey(canonical);
}

// The OFX twin of `buildRows`: same `{ headers, rows }` contract, same stable
// row `index`, same `status`/`reason`/`canonical`/`dedupKey`/`occurrence` shape,
// so `annotate` and the confirm path treat both formats identically. Adds a
// `meta` block carrying the file's own account identity for the mismatch check.
//
// Unlike CSV there is no template and no row filtering — OFX is self-describing,
// so an account needs no setup at all to import one.
export function buildOfxRows(buffer, settings, account) {
  const statements = readStatements(buffer);
  const fields = settings?.descriptionFields?.length ? settings.descriptionFields : DEFAULT_DESCRIPTION_FIELDS;

  const seen = new Map(); // dedupKey -> count so far in this file
  const out = [];
  let index = 0;

  for (const stmt of statements) {
    for (const txn of stmt.transactions) {
      const i = index++;
      const canonical = buildCanonicalOfx(txn, { curdef: stmt.curdef, fields, account });
      if (canonical.error) {
        out.push({ index: i, status: 'error', reason: canonical.error });
        continue;
      }
      const key = ofxDedupKey(canonical);
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      out.push({ index: i, status: 'ok', canonical, dedupKey: key, occurrence });
    }
  }

  // The first statement's identity represents the file (a mixed-account file is
  // unusual; the mismatch check below flags whichever differs from the account).
  const first = statements[0] ?? {};
  return {
    headers: ['Date', 'Description', 'Amount', 'Currency'],
    rows: out,
    meta: {
      bankId: first.bankId ?? null,
      acctId: first.acctId ?? null,
      curdef: first.curdef ?? null,
      statementCount: statements.length,
      accounts: statements.map((s) => ({ bankId: s.bankId, acctId: s.acctId })),
    },
  };
}

// Compare the file's account identity against the one remembered for this
// account. Warn, never block (locked decision): banks do change identifier
// formats, and the user picked the target account deliberately.
export function accountMismatch(meta, settings) {
  if (!settings?.acctId) return null;
  const mismatch = meta.accounts.some((a) => a.acctId && a.acctId !== settings.acctId);
  if (!mismatch) return null;
  const seen = meta.accounts.map((a) => a.acctId).filter(Boolean).join(', ');
  return `This file is for account ${seen}, but previous OFX imports here were for ${settings.acctId}. Importing anyway will mix two accounts.`;
}
