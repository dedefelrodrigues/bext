// Parse a date/datetime cell into a canonical 'YYYY-MM-DD' string using a
// template's date format. Time components are matched but discarded — a
// transaction stores a date only (per CLAUDE.md). Returns null when the value
// doesn't match the format or is out of range, so the caller can flag the row.
//
// Supported tokens: YYYY, MM, DD (date, captured) and HH, mm, ss (time, matched
// then ignored). Everything else in the format is a literal. Month/day allow one
// or two digits so non-zero-padded exports still parse.

const TOKENS = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'];

function escapeRegex(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build (once per format) a regex plus the ordered list of captured date parts.
function compileFormat(format) {
  let re = '^';
  const order = [];
  let i = 0;
  while (i < format.length) {
    const tok = TOKENS.find((t) => format.startsWith(t, i));
    if (tok === 'YYYY') {
      re += '(\\d{4})';
      order.push('y');
    } else if (tok === 'MM') {
      re += '(\\d{1,2})';
      order.push('m');
    } else if (tok === 'DD') {
      re += '(\\d{1,2})';
      order.push('d');
    } else if (tok === 'HH' || tok === 'mm' || tok === 'ss') {
      re += '\\d{1,2}';
    } else {
      re += escapeRegex(format[i]);
      i += 1;
      continue;
    }
    i += tok.length;
  }
  return { regex: new RegExp(re), order };
}

const cache = new Map();
function formatFor(format) {
  let compiled = cache.get(format);
  if (!compiled) {
    compiled = compileFormat(format);
    cache.set(format, compiled);
  }
  return compiled;
}

export function parseDate(value, format) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v || !format) return null;

  const { regex, order } = formatFor(format);
  const m = v.match(regex);
  if (!m) return null;

  const parts = {};
  order.forEach((key, idx) => {
    parts[key] = Number(m[idx + 1]);
  });
  const { y, m: mo, d } = parts;
  if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
