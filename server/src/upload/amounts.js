// Parse a money cell into integer minor units (cents). Honors the template's
// decimal separator, strips the matching thousands separator and any currency
// symbols/whitespace, and preserves the sign (negative = outflow across all
// banks). An empty cell counts as 0 (so summed amount columns can be sparse).
// Returns null on a genuinely unparseable non-empty value so the row is flagged.
//
// "Strips currency symbols" must not mean "keeps any digits it can find": a cell
// of prose (`/OPF/IN/924452800/Targa GmbH/…`, which is what an amount column
// holds once an unquoted delimiter has shifted the row) used to parse as its
// digits run together — 9.2e20. A money cell may carry a currency code or
// symbol, never words or slashes.
export function parseAmountToCents(value, decimalSeparator = '.') {
  if (value == null) return 0;
  let s = String(value).trim();
  if (s === '') return 0;
  if ((s.match(/\p{L}/gu) ?? []).length > 3) return null;
  if (/[^\p{L}\p{Sc}\s\d.,+'-]/u.test(s)) return null;

  const thousands = decimalSeparator === ',' ? '.' : ',';
  s = s.split(thousands).join(''); // drop thousands separators
  if (decimalSeparator === ',') s = s.replace(',', '.');
  s = s.replace(/[^0-9.+-]/g, ''); // strip currency symbols, spaces, etc.

  if (s === '' || s === '-' || s === '+' || s === '.') return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

// Sum several amount columns into one signed cents value. Empty cells are 0;
// any unparseable cell makes the whole sum null (the row is flagged as invalid).
export function sumAmountColumns(row, columns, decimalSeparator = '.') {
  let total = 0;
  for (const col of columns ?? []) {
    const cents = parseAmountToCents(row[col], decimalSeparator);
    if (cents === null) return null;
    total += cents;
  }
  return total;
}
