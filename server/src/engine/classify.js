// The keyword classification engine — a pure, deterministic function of
// (rules, transactions, distance settings). No database access lives here; the
// recompute layer (recompute.js) feeds it rows and persists the assignments.
//
// Semantics (per CLAUDE.md "Classification mechanism"):
//   - Normalize a description: lowercase, strip diacritics, tokenize on
//     non-alphanumerics (Polish `ł` is handled explicitly since it does not
//     decompose under Unicode NFD).
//   - A keyword of N tokens matches where an N-token window of the description
//     matches token-for-token within the effective fuzzy distance (per-keyword
//     override else the user global). Tokens shorter than 5 characters require an
//     exact match regardless of the distance setting (so `zus` ≉ `bus`).
//   - Among all matching keywords, the longest by character length wins; ties
//     break to the lowest keyword id. This makes re-runs stable.

const SHORT_TOKEN_GUARD = 5; // tokens < this length must match exactly

// Latin letters that don't decompose to ASCII under NFD, mapped by hand.
const SPECIAL_CHARS = { ł: 'l', đ: 'd', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th', ð: 'd' };

// Lowercase and strip diacritics (incl. Polish ł), leaving the raw character
// sequence intact — used for substring containment matching.
export function normalizeString(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[łđøßæœþð]/g, (ch) => SPECIAL_CHARS[ch] ?? ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // combining diacritical marks
}

// Normalize then split into tokens on non-alphanumeric characters AND letter↔digit
// boundaries, so a merchant glued to a date/reference (e.g. "BEATRIZ11/05") yields
// ["beatriz", "11", "05"]. Bank exports frequently run names into numbers.
export function tokenize(text) {
  if (!text) return [];
  return normalizeString(text).match(/[a-z]+|[0-9]+/g) ?? [];
}

// Levenshtein edit distance, short-circuiting once it provably exceeds `max`.
// Returns a value > max when the true distance exceeds the budget.
export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = i;
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost);
      diag = prev[j];
      prev[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

// Two tokens match if they are within the allowed distance — but any token
// shorter than SHORT_TOKEN_GUARD (on either side) demands an exact match.
function tokensMatch(kwToken, descToken, allowedDistance) {
  if (kwToken === descToken) return true;
  if (allowedDistance <= 0) return false;
  if (kwToken.length < SHORT_TOKEN_GUARD || descToken.length < SHORT_TOKEN_GUARD) return false;
  return levenshtein(kwToken, descToken, allowedDistance) <= allowedDistance;
}

// Precompute a keyword's normalized tokens and character length once so the
// engine can be run repeatedly over many transactions without re-tokenizing.
// `globalDistance` supplies the fallback when a keyword has no override.
export function prepareKeywords(keywords, globalDistance) {
  return keywords
    .map((k) => ({
      id: k.id,
      categoryId: k.categoryId,
      subcategoryId: k.subcategoryId ?? null,
      text: k.text,
      length: String(k.text).length,
      tokens: tokenize(k.text),
      normText: normalizeString(k.text).trim(),
      distance: k.distance == null ? globalDistance : k.distance,
    }))
    .filter((k) => k.tokens.length > 0);
}

// Fuzzy token-window match: the keyword's N tokens align with an N-token window
// of the description, each within the distance threshold (short tokens exact).
function tokenWindowMatch(keyword, descTokens) {
  const n = keyword.tokens.length;
  if (n === 0 || descTokens.length < n) return false;
  for (let i = 0; i + n <= descTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!tokensMatch(keyword.tokens[j], descTokens[i + j], keyword.distance)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// A prepared keyword matches a description if EITHER path succeeds:
//   1. the fuzzy token-window match (tolerates typos/OCR: żabka ≈ zapka), or
//   2. exact substring containment (catches names run into other text with no
//      separator, e.g. "mercado" inside "SUPERMERCADO"). The substring path is
//      exact and gated to keywords ≥ SHORT_TOKEN_GUARD chars to avoid short-string
//      noise (so "zus" never matches inside a larger word).
function keywordMatches(keyword, descTokens, normDesc) {
  if (tokenWindowMatch(keyword, descTokens)) return true;
  if (keyword.normText.length >= SHORT_TOKEN_GUARD && normDesc.includes(keyword.normText)) return true;
  return false;
}

// Classify a single description string against prepared keywords. Returns the
// winning keyword (longest char length; tie → lowest id) or null when none match.
export function classifyDescription(description, preparedKeywords) {
  const descTokens = tokenize(description);
  const normDesc = normalizeString(description);
  let best = null;
  for (const kw of preparedKeywords) {
    if (!keywordMatches(kw, descTokens, normDesc)) continue;
    if (
      best === null ||
      kw.length > best.length ||
      (kw.length === best.length && kw.id < best.id)
    ) {
      best = kw;
    }
  }
  return best;
}

// Classify many transactions at once. `transactions` need only carry `id` and
// `description`. Returns a Map of transaction id → winning keyword (or null),
// exposing category/subcategory/keyword for the caller to persist.
export function classify(transactions, keywords, globalDistance) {
  const prepared = prepareKeywords(keywords, globalDistance);
  const out = new Map();
  for (const tx of transactions) {
    out.set(tx.id, classifyDescription(tx.description, prepared));
  }
  return out;
}
