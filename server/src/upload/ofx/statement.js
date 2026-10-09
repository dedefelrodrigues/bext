import { decodeOfx } from './header.js';
import { tokenize, findAll, many, str } from './tokenize.js';

// Turn an OFX buffer into the statements we can import. Scope (locked in
// PLAN.md Phase 7.1): bank accounts (`STMTRS`) and credit cards (`CCSTMTRS`).
// Investment statements (`INVSTMTRS`) model buys/sells/units, which do not fit
// this app's single signed amount, and are rejected with a clear message.

export class OfxError extends Error {}

// A server-level `<STATUS>` with SEVERITY ERROR means the bank returned no data;
// importing an empty statement would silently look like "0 new transactions".
function assertNoErrorStatus(tree) {
  for (const status of findAll(tree, 'STATUS')) {
    if (str(status, 'SEVERITY').toUpperCase() !== 'ERROR') continue;
    const code = str(status, 'CODE');
    const message = str(status, 'MESSAGE');
    throw new OfxError(`The bank reported an error in this file${code ? ` (code ${code})` : ''}${message ? `: ${message}` : '.'}`);
  }
}

function accountOf(stmt) {
  const acct = stmt.BANKACCTFROM ?? stmt.CCACCTFROM ?? {};
  const node = Array.isArray(acct) ? acct[0] : acct;
  return { bankId: str(node, 'BANKID') || null, acctId: str(node, 'ACCTID') || null };
}

// { curdef, bankId, acctId, transactions: [STMTTRN…] } per statement, in file order.
export function readStatements(buffer) {
  const { text } = decodeOfx(buffer);
  if (!/<OFX\b/i.test(text)) throw new OfxError('This does not look like an OFX file.');

  const tree = tokenize(text);
  assertNoErrorStatus(tree);

  const found = [...findAll(tree, 'STMTRS'), ...findAll(tree, 'CCSTMTRS')];
  if (found.length === 0) {
    if (findAll(tree, 'INVSTMTRS').length > 0) {
      throw new OfxError('This is an investment statement (INVSTMTRS). BeXT imports bank and credit-card statements only.');
    }
    throw new OfxError('No bank or credit-card statement found in this file.');
  }

  return found.map((stmt) => {
    const list = many(stmt, 'BANKTRANLIST').flatMap((l) => many(l, 'STMTTRN'));
    return { curdef: str(stmt, 'CURDEF').toUpperCase() || null, ...accountOf(stmt), transactions: list };
  });
}
