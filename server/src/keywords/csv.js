// Minimal RFC-4180-ish CSV for the keyword round-trip (`keyword,category,
// subcategory,distance`). Kept dependency-free and local — the richer bank-CSV
// parsing (csv-parse, encodings, delimiters) arrives with the upload pipeline.

// Quote a field only when it contains a comma, quote, or newline; double any
// embedded quotes.
function quote(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Serialize keyword rows to a CSV string with a header line.
export function keywordsToCsv(rows) {
  const lines = ['keyword,category,subcategory,distance'];
  for (const r of rows) {
    lines.push([quote(r.keyword), quote(r.category), quote(r.subcategory), quote(r.distance)].join(','));
  }
  return lines.join('\n') + '\n';
}

// Parse a CSV string into an array of raw string cells per row (quotes handled).
// Blank lines are skipped. Not a general CSV lib — sufficient for the 4-column
// keyword format.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false; // whether the current row has any content

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Drop fully blank lines (a single empty cell and nothing else).
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ',') {
      pushField();
      started = true;
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // handled by the following \n (or end of input)
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || field !== '' || row.length) pushRow();
  return rows;
}

// Parse keyword CSV into normalized objects. Tolerates an optional header row
// (detected by a `keyword,category` first line). Returns
// { rows: [{ keyword, category, subcategory, distance }], error }.
export function parseKeywordCsv(text) {
  const cells = parseCsv(text);
  if (cells.length === 0) return { rows: [] };

  let start = 0;
  const first = cells[0].map((c) => c.trim().toLowerCase());
  if (first[0] === 'keyword' && (first[1] === 'category' || first[1] === undefined)) start = 1;

  const rows = [];
  for (let i = start; i < cells.length; i++) {
    const [keyword = '', category = '', subcategory = '', distanceRaw = ''] = cells[i];
    const kw = keyword.trim();
    if (!kw) continue; // skip rows without a keyword
    const cat = category.trim();
    if (!cat) return { error: `Row ${i + 1}: missing category for keyword "${kw}".` };

    let distance = null;
    const dRaw = distanceRaw.trim();
    if (dRaw !== '') {
      const d = Number(dRaw);
      if (!Number.isInteger(d) || d < 0) return { error: `Row ${i + 1}: distance must be a non-negative integer.` };
      distance = d;
    }
    rows.push({ keyword: kw, category: cat, subcategory: subcategory.trim(), distance });
  }
  return { rows };
}
