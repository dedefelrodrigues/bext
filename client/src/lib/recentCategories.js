// Category suggestions for the pickers: what you picked last, then what holds
// the most transactions. "Last used" is a per-browser convenience (like the
// column toggles), so it lives in localStorage and survives being empty.

const STORAGE_KEY = 'bext.categories.recent';
const MAX_RECENT = 8;

const pairKey = (catId, subId) => `${catId}:${subId ?? ''}`;

function readRecent() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((p) => p && Number.isInteger(p.categoryId)) : [];
  } catch {
    return [];
  }
}

// Remember a committed pick (most recent first). Clearing a category is not a
// pick worth suggesting again.
export function recordRecentCategory(categoryId, subcategoryId) {
  const cat = Number(categoryId);
  if (!cat) return;
  const sub = subcategoryId ? Number(subcategoryId) : null;
  const next = [{ categoryId: cat, subcategoryId: sub }, ...readRecent().filter((p) => pairKey(p.categoryId, p.subcategoryId) !== pairKey(cat, sub))];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(0, MAX_RECENT)));
  } catch {
    /* private window — suggestions fall back to the most used */
  }
}

// Up to `limit` {categoryId, subcategoryId, recent} pairs: the last few picks,
// then the pairs owning the most transactions. Counts come from GET /categories
// (a category's txCount includes its subcategories', so the category on its own
// is credited only with the rows no subcategory claims). Pairs that no longer
// exist — a deleted category from an old pick — are skipped.
export function suggestCategories(categories, { limit = 6, recent = 3 } = {}) {
  const valid = new Set();
  const used = [];
  for (const c of categories) {
    valid.add(pairKey(c.id, null));
    let inSubs = 0;
    for (const s of c.subcategories ?? []) {
      valid.add(pairKey(c.id, s.id));
      inSubs += s.txCount ?? 0;
      if (s.txCount) used.push({ categoryId: c.id, subcategoryId: s.id, n: s.txCount });
    }
    const own = (c.txCount ?? 0) - inSubs;
    if (own > 0) used.push({ categoryId: c.id, subcategoryId: null, n: own });
  }

  const out = [];
  const seen = new Set();
  const add = (p, isRecent) => {
    const k = pairKey(p.categoryId, p.subcategoryId);
    if (out.length >= limit || seen.has(k) || !valid.has(k)) return;
    seen.add(k);
    out.push({ categoryId: p.categoryId, subcategoryId: p.subcategoryId ?? null, recent: isRecent });
  };
  for (const p of readRecent().slice(0, recent)) add(p, true);
  for (const p of used.sort((a, b) => b.n - a.n)) add(p, false);
  return out;
}
