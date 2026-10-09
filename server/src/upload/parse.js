import iconv from 'iconv-lite';
import { parse as parseCsvSync } from 'csv-parse/sync';

// Normalize a few common encoding labels to what iconv-lite expects.
function normalizeEncoding(encoding) {
  const e = String(encoding ?? 'utf-8').toLowerCase().replace(/[\s_]/g, '-');
  if (e === 'utf-8' || e === 'utf8') return 'utf8';
  return e; // iconv-lite accepts 'windows-1250', 'latin1', 'iso-8859-2', …
}

// Decode raw file bytes to a string using the template encoding.
export function decodeBuffer(buffer, encoding) {
  const enc = normalizeEncoding(encoding);
  if (enc === 'utf8') return buffer.toString('utf8');
  return iconv.decode(buffer, enc);
}

// Decode + split a bank CSV into { headers, rows } where each row is an object
// keyed by trimmed header name. `headerRow` is the 0-based line index of the
// header (Alior has a criteria line before it). Empty lines are preserved during
// parsing so the header index stays a true line number, then blank data rows are
// dropped. Extra/short columns are tolerated (Alior's trailing delimiter); cells
// under an empty header name are ignored.
//
// A row whose *non-empty* cells run past the header is marked with `OVERFLOW`:
// a bank that leaves a delimiter unquoted inside a field (Alior printed a sender
// as `IXE LLES;BE`) shifts every later column by one, so the amount column holds
// text and the currency column holds the amount. The row is flagged rather than
// guessed back into place.
export const OVERFLOW = Symbol('overflow');

export function parseCsv(buffer, template) {
  const text = decodeBuffer(buffer, template.encoding);
  const records = parseCsvSync(text, {
    delimiter: template.delimiter || ',',
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    bom: true,
  });

  const headerRow = Number(template.headerRow) || 0;
  const headerCells = records[headerRow] ?? [];
  const headers = headerCells.map((h) => String(h).trim());

  const rows = [];
  for (let i = headerRow + 1; i < records.length; i++) {
    const cells = records[i];
    if (!cells || cells.every((c) => String(c).trim() === '')) continue; // blank line
    const obj = {};
    headers.forEach((h, idx) => {
      if (h !== '') obj[h] = cells[idx] ?? '';
    });
    if (cells.slice(headers.length).some((c) => String(c).trim() !== '')) obj[OVERFLOW] = true;
    rows.push(obj);
  }

  return { headers: headers.filter((h) => h !== ''), rows };
}
