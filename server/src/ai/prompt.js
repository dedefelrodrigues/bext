// The prompt the engines answer, and the parser that reads the answer back.
//
// One contract for all four providers: a single JSON object, described in the
// system prompt rather than in a provider-specific schema mode. `extractJson`
// is deliberately forgiving — a model that wraps its answer in a code fence or
// adds a sentence of preamble has still answered.

export const SYSTEM_PROMPT = `You classify bank transactions for a personal finance tool.

You are given ONE merchant, as it appears on a bank statement, together with the
user's own list of categories and subcategories. Your job is to work out what the
business actually is and which of the user's categories it belongs to, then
propose a keyword rule that will classify this merchant's transactions from now
on.

If you have a web search tool, use it to identify unfamiliar or local merchants
before deciding. Statement descriptions are abbreviated, contain branch codes and
are often not in English.

Rules:
- Choose "categoryId" from the listed ids ONLY. Never invent a category.
- Choose "subcategoryId" from the subcategories listed under the category you
  chose, or null. Never invent a subcategory.
- If no listed category is a reasonable fit, set both to null and explain why in
  "rationale". Do not force a bad match.
- "keyword" is the text that will be matched against future descriptions. It must
  be a word or short phrase that literally appears in the descriptions shown,
  lowercase, with no branch codes, dates, card numbers or reference numbers. Keep
  it as short as it can be while still identifying this business and not matching
  unrelated ones. Matching is on whole words, so a keyword of two words matches
  only where both appear in order.
- "confidence" is 0-100: how sure you are that the business is what you say it is
  AND that the category fits.
- "sources" lists the pages you actually used, if any.

Answer with a single JSON object and nothing else:

{"merchant": "the real business name", "keyword": "…", "categoryId": 12,
 "subcategoryId": 41, "confidence": 85, "rationale": "one or two sentences",
 "sources": [{"title": "…", "url": "…"}]}`;

// The user's category tree, as ids the model must choose from.
export function renderCategories(categories) {
  return categories
    .map((cat) => {
      const head = `[${cat.id}] ${cat.name}${cat.isHidden ? ' (hidden)' : ''}`;
      const subs = (cat.subcategories ?? []).map((sub) => `    [${sub.id}] ${sub.name}`);
      return [head, ...subs].join('\n');
    })
    .join('\n');
}

const money = (cents, currency) => `${(cents / 100).toFixed(2)} ${currency}`;

export function buildUserPrompt(group, categoryTree, { defaultCurrency } = {}) {
  const dates = group.rows.map((r) => r.date).sort();
  const amounts = group.rows
    .slice(0, 5)
    .map((r) => money(r.amountCents, r.currency))
    .join(', ');
  const accounts = [...new Set(group.rows.map((r) => r.accountName))].join(', ');

  const variants = group.variants
    .slice(0, 5)
    .map((v) => `- "${v.description}" (${v.count} transaction${v.count === 1 ? '' : 's'})`)
    .join('\n');

  return `Statement descriptions for this merchant:
${variants}

Transactions: ${group.txCount}
Account(s): ${accounts}
Dates: ${dates[0]} to ${dates[dates.length - 1]}
Example amounts: ${amounts}
The user's reporting currency is ${defaultCurrency ?? 'unknown'}. Negative amounts are money going out.

The user's categories (choose one id, and optionally one of its subcategory ids):
${categoryTree}`;
}

// Pull the first balanced JSON object out of a model's answer. Brace counting
// rather than a regex because a rationale may legitimately contain braces, and
// string-aware so an escaped quote inside it cannot end the scan early.
export function extractJson(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
