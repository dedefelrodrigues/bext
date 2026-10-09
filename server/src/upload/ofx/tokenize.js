// One tolerant tag reader for *both* OFX dialects.
//
// OFX 1.x is SGML: leaf tags are never closed (`<TRNAMT>-12.34` runs straight
// into the next tag), while aggregates are (`<STMTTRN>…</STMTTRN>`). OFX 2.x is
// well-formed XML where everything closes. The rule below covers both without
// branching on the version:
//
//   an opening tag followed immediately by non-blank text is a LEAF (its value
//   is that text); one followed by another tag is an AGGREGATE (push it);
//   a closing tag pops the stack up to that name, and is ignored when the name
//   was never pushed — which is exactly the XML leaf case.
//
// The result is a plain nested object: leaves are strings, aggregates are
// objects, and a name repeated inside one parent becomes an array. Unknown tags
// are kept, so callers read only what they understand.

const TAG = /<\s*(\/?)\s*([A-Za-z0-9._:-]+)([^>]*)>/g;

function attach(parent, name, value) {
  const existing = parent[name];
  if (existing === undefined) parent[name] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else parent[name] = [existing, value];
  return value;
}

// Decode the handful of entities banks actually emit.
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/gi, '&');
}

export function tokenize(text) {
  const root = {};
  const stack = [{ name: '#root', node: root }];

  TAG.lastIndex = 0;
  let match;
  while ((match = TAG.exec(text)) !== null) {
    const [, closing, rawName, rest] = match;
    const name = rawName.toUpperCase();
    if (rawName.startsWith('?') || rawName.startsWith('!')) continue; // <?xml?>, <!-- -->

    if (closing) {
      const at = stack.findLastIndex((f) => f.name === name);
      if (at > 0) stack.length = at; // pop through the matching open tag
      continue; // an unmatched close is an XML leaf we already handled
    }

    const parent = stack[stack.length - 1].node;
    if (rest.trimEnd().endsWith('/')) {
      attach(parent, name, ''); // <TAG/>
      continue;
    }

    // Text up to the next tag decides leaf vs. aggregate.
    const from = TAG.lastIndex;
    const nextTag = text.indexOf('<', from);
    const raw = text.slice(from, nextTag === -1 ? text.length : nextTag);
    const value = decodeEntities(raw).trim();

    if (value !== '') attach(parent, name, value);
    else stack.push({ name, node: attach(parent, name, {}) });
  }

  return root;
}

// Read a child as a single value, tolerating a bank that repeated the tag.
export function one(node, name) {
  const v = node?.[name];
  return Array.isArray(v) ? v[0] : v;
}

// Read a child as a list, whether the bank sent none, one, or many.
export function many(node, name) {
  const v = node?.[name];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// A leaf's trimmed string value ('' when absent or when it is an aggregate).
export function str(node, name) {
  const v = one(node, name);
  return typeof v === 'string' ? v.trim() : '';
}

// Depth-first search for every aggregate with the given tag name.
export function findAll(node, name, out = []) {
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (key === name) out.push(item);
      if (item && typeof item === 'object') findAll(item, name, out);
    }
  }
  return out;
}
