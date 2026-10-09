import { parseCsv } from './parse.js';
import { passesFilters, buildCanonical, dedupKey } from './transform.js';

// Turn a raw upload buffer into an ordered list of preview rows. This is the
// deterministic, DB-free core shared by both the preview and the confirm step:
// given the same file + template it always produces the same rows in the same
// order, so a row's `index` is a stable handle the client can use to exclude it.
//
// Each row carries:
//   index        — position in the data (stable across preview/confirm)
//   status       — 'ok' | 'filtered' | 'error'
//   reason       — human note for filtered/error rows
//   canonical    — { date, description, amountCents, currency, foreign… } (ok only)
//   dedupKey     — key for ok rows
//   occurrence   — 0-based count of prior ok rows in THIS file with the same key
//
// Dedup against already-imported transactions is layered on later (it needs the
// DB); here we only compute the in-file occurrence index.
export function buildRows(buffer, template, account) {
  const { headers, rows } = parseCsv(buffer, template);
  const seen = new Map(); // dedupKey -> count so far in this file
  const out = [];

  rows.forEach((row, index) => {
    if (!passesFilters(row, template.filters)) {
      out.push({ index, status: 'filtered', reason: 'Excluded by a template filter.' });
      return;
    }
    const canonical = buildCanonical(row, template, account);
    if (canonical.error) {
      out.push({ index, status: 'error', reason: canonical.error });
      return;
    }
    const key = dedupKey(canonical);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    out.push({ index, status: 'ok', canonical, dedupKey: key, occurrence });
  });

  return { headers, rows: out };
}
