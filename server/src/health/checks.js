import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, budgetLines, categories, keywords, subcategories, transactions, users } from '../db/schema.js';
import { containerIds } from '../transactions/routes.js';
import { buildConverter } from '../fx/converter.js';
import { normalizeString, tokenize } from '../engine/classify.js';

// --- Data health ------------------------------------------------------------
//
// Four families of checks over one user's data, each producing findings the
// Health page lists. They exist because every one of them was first found by
// hand: salary filed under Restaurants by a keyword matching the user's own
// street, a child benefit booked as a tax refund by `zus`, ATM cash hidden
// under Transfers, a bank line shifted by an unquoted delimiter.
//
//   rules      keywords whose text is shared by unrelated rows
//   direction  money going the wrong way for its category
//   imports    rows an import got wrong (broken text, 0.00 lines, duplicates)
//   structure  categories, subcategories and keywords nothing uses
//   transfers  transfer legs with no other side, pairs waiting to be confirmed
//              (the review itself lives on Accounts › Transfers)
//
// A finding carries a stable `key` (what it is about) and a `fingerprint` (the
// evidence). Dismissing stores both; the finding stays hidden while the
// evidence is unchanged and comes back when it moves — a keyword accepted as
// fine today is shown again once it starts catching new rows.
//
// Fixes are described, not applied, here: the page runs them through the same
// endpoints a hand edit uses (keyword edit, bulk categorize, delete), so a fix
// gets exactly the validation and recompute the manual path gets.

const MAX_ROWS = 200;
// Direction: at most this many of the category's other rows go to the strip.
const MAX_CONTEXT = 3000;
// Direction: the other way counts once it is 5% of the category's money, or
// any single row reaches 1,000 in the display currency.
const OPPOSITE_SHARE = 0.05;
const OPPOSITE_ROW = 100000;
// Rules: text found in this many rows of at least two other categories is
// shared text (a name, an address, bank boilerplate), not a merchant.
const EVERYWHERE_ROWS = 5;
const EVERYWHERE_CATEGORIES = 2;
// Imports: text that lost its letters on the way in — the Unicode replacement
// character, and what it (or UTF-8 in general) becomes when read as a
// single-byte code page.
const BROKEN_TEXT = /�|ďż˝|ï¿½|[ÃÄÅ][\u0080-¿]/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const IMPOSSIBLE_CENTS = 1e9; // ten million units: a shifted column, not a payment

// Short, stable digest of the evidence (djb2), so a dismissal can tell whether
// a finding changed.
export function fingerprint(parts) {
  let h = 5381;
  for (const ch of parts.join('|')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

function load(userId) {
  const user = db.select({ currency: users.defaultCurrency }).from(users).where(eq(users.id, userId)).get();
  const containers = containerIds(userId);
  const where = containers.length
    ? and(eq(transactions.userId, userId), notInArray(transactions.id, containers))
    : eq(transactions.userId, userId);
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      uploadId: transactions.uploadId,
      date: transactions.date,
      description: transactions.description,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      foreignAmountCents: transactions.foreignAmountCents,
      foreignCurrency: transactions.foreignCurrency,
      categoryId: transactions.categoryId,
      subcategoryId: transactions.subcategoryId,
      matchedKeywordId: transactions.matchedKeywordId,
      isManual: transactions.isManual,
      isLocked: transactions.isLocked,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(where)
    .all();

  const converter = buildConverter(userId, user.currency);
  for (const r of rows) {
    const c = converter.convert(r);
    r.value = c.converted ? c.cents : null; // null: no rate — left out of money, never mixed in
    r.tokens = tokenize(r.description);
    r.tokenText = ` ${r.tokens.join(' ')} `;
  }
  // token -> rows containing it, so "which rows contain this keyword's text"
  // walks the rows of its rarest word instead of every row.
  const index = new Map();
  for (const r of rows) {
    for (const t of new Set(r.tokens)) {
      let l = index.get(t);
      if (!l) index.set(t, (l = []));
      l.push(r);
    }
  }

  const cats = db.select().from(categories).where(eq(categories.userId, userId)).all();
  const subs = db.select().from(subcategories).where(eq(subcategories.userId, userId)).all();
  const kws = db.select().from(keywords).where(eq(keywords.userId, userId)).all();
  const lineCount = db.select({ id: budgetLines.id }).from(budgetLines).where(eq(budgetLines.userId, userId)).all().length;
  return {
    currency: user.currency,
    rows,
    index,
    cats,
    subs,
    kws,
    lineCount,
    catById: new Map(cats.map((c) => [c.id, c])),
    subById: new Map(subs.map((s) => [s.id, s])),
    kwById: new Map(kws.map((k) => [k.id, k])),
  };
}

// Where a keyword's words sit in the original description, as [start, end)
// ranges, so the page can mark them. Found on a normalized copy (case, accents,
// ł) that maps back character by character; the engine's token rules apply — a
// token is a run of letters or of digits, so "R500" holds the tokens r and 500.
export function highlightRanges(description, tokens) {
  if (!tokens?.length) return [];
  let norm = '';
  const map = [];
  for (let i = 0; i < description.length; i++) {
    for (const ch of normalizeString(description[i])) {
      norm += ch;
      map.push(i);
    }
  }
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const edge = (t) => (/^[0-9]/.test(t) ? '0-9' : 'a-z');
  const re = new RegExp(`(?<![${edge(tokens[0])}])${tokens.map(esc).join('[^a-z0-9]*')}(?![${edge(tokens[tokens.length - 1])}])`, 'g');
  const out = [];
  for (const m of norm.matchAll(re)) out.push([map[m.index], map[m.index + m[0].length - 1] + 1]);
  return out;
}

function rowView(r, d, highlightTokens = null) {
  const cat = r.categoryId != null ? d.catById.get(r.categoryId) : null;
  const sub = r.subcategoryId != null ? d.subById.get(r.subcategoryId) : null;
  const kw = r.matchedKeywordId != null ? d.kwById.get(r.matchedKeywordId) : null;
  return {
    id: r.id,
    date: r.date,
    description: r.description,
    accountName: r.accountName,
    amountCents: r.amountCents,
    currency: r.currency,
    category: cat ? { id: cat.id, name: cat.name, icon: cat.icon } : null,
    subcategory: sub ? { id: sub.id, name: sub.name } : null,
    keyword: kw ? { id: kw.id, text: kw.text } : null,
    manual: r.isLocked || r.isManual,
    highlight: highlightTokens ? highlightRanges(r.description, highlightTokens) : [],
  };
}

// Rows whose description contains these tokens consecutively (whole words,
// accents and case ignored) — the keyword's text, without the fuzzy tolerance.
function rowsContaining(d, tokens) {
  if (!tokens.length) return [];
  let rarest = null;
  for (const t of tokens) {
    const l = d.index.get(t) ?? [];
    if (!rarest || l.length < rarest.length) rarest = l;
  }
  const needle = ` ${tokens.join(' ')} `;
  return rarest.filter((r) => r.tokenText.includes(needle));
}

const money = (list) => list.reduce((s, r) => s + Math.abs(r.value ?? 0), 0);
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || b.id - a.id;

// `highlightTokens`: the keyword words to mark in each row's description.
function finding(d, base, rowList = [], highlightTokens = null) {
  const sorted = [...rowList].sort(byDateDesc);
  return {
    severity: 'medium',
    fixes: [],
    items: [],
    ...base,
    rowCount: rowList.length,
    moneyCents: money(rowList),
    currency: d.currency,
    rows: sorted.slice(0, MAX_ROWS).map((r) => rowView(r, d, highlightTokens)),
    rowIds: sorted.map((r) => r.id),
  };
}

const catLabel = (d, catId, subId) => {
  const c = d.catById.get(catId);
  const s = subId != null ? d.subById.get(subId) : null;
  return s ? `${c?.name} › ${s.name}` : c?.name ?? 'Uncategorized';
};

// --- Direction ----------------------------------------------------------------
//
// A category's direction is where most of its *rows* go, over all time — not
// its money: 42 misfiled salaries outweigh years of restaurant meals in money,
// and would make Restaurants look like an income category. Money breaks ties.
// Rows
// going the other way are grouped by what put them there — one keyword, or a
// hand categorization — because that is what a fix changes. Small refunds are
// normal and stay quiet; hidden categories (transfers) go both ways by design.
function direction(d) {
  const out = [];
  const byCat = new Map();
  for (const r of d.rows) {
    if (r.categoryId == null || r.value == null || r.amountCents === 0) continue;
    const cat = d.catById.get(r.categoryId);
    if (!cat || cat.isHidden) continue;
    let e = byCat.get(r.categoryId);
    if (!e) byCat.set(r.categoryId, (e = { in: 0, out: 0, nIn: 0, nOut: 0, rows: [] }));
    if (r.value > 0) {
      e.in += r.value;
      e.nIn++;
    } else {
      e.out += -r.value;
      e.nOut++;
    }
    e.rows.push(r);
  }
  for (const [catId, e] of byCat) {
    const incoming = e.nIn !== e.nOut ? e.nIn > e.nOut : e.in > e.out; // the category's direction
    const dominant = incoming ? e.in : e.out;
    if (dominant === 0) continue;
    const groups = new Map();
    for (const r of e.rows) {
      if (r.value > 0 === incoming) continue;
      const cause = r.matchedKeywordId != null ? `kw:${r.matchedKeywordId}` : r.isLocked || r.isManual ? 'manual' : 'none';
      let g = groups.get(cause);
      if (!g) groups.set(cause, (g = []));
      g.push(r);
    }
    for (const [cause, list] of groups) {
      const total = money(list);
      const biggest = Math.max(...list.map((r) => Math.abs(r.value)));
      if (total < dominant * OPPOSITE_SHARE && biggest < OPPOSITE_ROW) continue;
      const cat = d.catById.get(catId);
      const kw = cause.startsWith('kw:') ? d.kwById.get(Number(cause.slice(3))) : null;
      const way = incoming ? 'outgoing' : 'incoming';
      const fixes = [{ type: 'recategorize', label: 'Move these rows to…', transactionIds: list.map((r) => r.id) }];
      // The rest of the category, for the strip the page draws: where these
      // rows sit against everything else filed there.
      const flagged = new Set(list.map((r) => r.id));
      const rest = e.rows.filter((r) => !flagged.has(r.id)).map((r) => r.value);
      const sortedRest = [...rest].sort((a, b) => a - b);
      const context = {
        category: cat.name,
        restCount: rest.length,
        typicalCents: sortedRest.length ? sortedRest[Math.floor(sortedRest.length / 2)] : 0,
        rest: rest.length > MAX_CONTEXT ? rest.filter((_, i) => i % Math.ceil(rest.length / MAX_CONTEXT) === 0) : rest,
        flagged: list.map((r) => ({ id: r.id, value: r.value, description: r.description, date: r.date })),
      };
      if (kw) fixes.push({ type: 'edit-keyword', label: 'Edit the keyword…', keywordId: kw.id, text: kw.text });
      out.push(
        finding(
          d,
          {
            key: `direction:${catId}:${cause}`,
            check: 'direction',
            severity: total >= dominant * 0.25 || total >= 1000000 ? 'high' : 'medium',
            title: `${list.length} ${way} row${list.length === 1 ? '' : 's'} in ${cat.name}${kw ? ` — keyword “${kw.text}”` : cause === 'manual' ? ' — set by hand' : ''}`,
            detail:
              `${cat.name} is mostly ${incoming ? 'income' : 'spending'}; these rows go the other way. ` +
              (kw
                ? `They were put here by “${kw.text}” (→ ${catLabel(d, kw.categoryId, kw.subcategoryId)}); if the keyword is matching text it should not, edit it — a longer keyword elsewhere also outranks it.`
                : cause === 'manual'
                  ? 'They were categorized by hand.'
                  : 'No keyword explains them.') +
              ' A refund is normal; a salary or a benefit is not.',
            fixes,
            context,
          },
          list,
          kw ? tokenize(kw.text) : null,
        ),
      );
    }
  }
  return out;
}

// --- Rules --------------------------------------------------------------------
function rules(d) {
  const out = [];
  for (const kw of d.kws) {
    const kwTokens = tokenize(kw.text);
    if (!kwTokens.length) continue;
    // Everywhere: the keyword's text shows up across unrelated categories — a
    // name, an address, a bank's boilerplate. It only loses there because
    // longer keywords win; the next row that no longer keyword covers lands in
    // this keyword's category.
    if (kwTokens.join(' ').length < 5) continue; // too short to be shared text
    const elsewhere = [];
    const otherCats = new Set();
    for (const r of rowsContaining(d, kwTokens)) {
      if (r.matchedKeywordId === kw.id || r.categoryId === kw.categoryId) continue;
      elsewhere.push(r);
      otherCats.add(r.categoryId ?? 0);
    }
    if (elsewhere.length >= EVERYWHERE_ROWS && otherCats.size >= EVERYWHERE_CATEGORIES) {
      // Where the keyword wins today, beside where its text also appears: the
      // decision is whether narrowing it would lose rows it is right about.
      const own = d.rows.filter((r) => r.matchedKeywordId === kw.id).sort(byDateDesc);
      out.push(
        finding(
          d,
          {
            key: `rules:everywhere:${kw.id}`,
            check: 'rules',
            severity: 'medium',
            title: `“${kw.text}” also appears in ${elsewhere.length} rows of ${otherCats.size} other categories`,
            detail: `Text shared by unrelated rows is usually your own name, an address or a bank's boilerplate, not a merchant. It loses in the rows below only because a longer keyword wins there; a new row carrying it that no longer keyword covers will land in ${catLabel(d, kw.categoryId, kw.subcategoryId)}. The rows below are where it appears elsewhere.`,
            fixes: [
              { type: 'edit-keyword', label: 'Make it more specific…', keywordId: kw.id, text: kw.text },
              { type: 'delete-keywords', label: 'Delete the keyword', keywordIds: [kw.id] },
            ],
            own: { count: own.length, category: catLabel(d, kw.categoryId, kw.subcategoryId), rows: own.slice(0, MAX_ROWS).map((r) => rowView(r, d, kwTokens)) },
          },
          elsewhere,
          kwTokens,
        ),
      );
    }
  }
  return out;
}

// --- Imports ------------------------------------------------------------------
function imports(d) {
  const out = [];
  const perAccount = (list, key) => {
    const m = new Map();
    for (const r of list) {
      let l = m.get(r.accountId);
      if (!l) m.set(r.accountId, (l = []));
      l.push(r);
    }
    return [...m.entries()].map(([accountId, l]) => ({ key: `${key}:${accountId}`, accountName: l[0].accountName, list: l }));
  };

  const broken = d.rows.filter((r) => BROKEN_TEXT.test(r.description));
  for (const g of perAccount(broken, 'imports:broken')) {
    out.push(
      finding(
        d,
        {
          key: g.key,
          check: 'imports',
          title: `${g.list.length} row${g.list.length === 1 ? '' : 's'} in ${g.accountName} ${g.list.length === 1 ? 'has' : 'have'} broken letters`,
          detail:
            'The file lost its accented letters before or during the import (“ďż˝”, “�”). Keywords written with those letters will not match these rows, and a clean export of the same months would not deduplicate against them. The letters cannot be recovered from the rows; a clean download from the bank, imported with the right encoding (Polish banks: Windows-1250), can replace them.',
        },
        g.list,
      ),
    );
  }

  const empty = d.rows.filter((r) => r.amountCents === 0 && !r.isManual);
  for (const g of perAccount(empty, 'imports:empty')) {
    out.push(
      finding(
        d,
        {
          key: g.key,
          check: 'imports',
          title: `${g.list.length} row${g.list.length === 1 ? '' : 's'} of 0.00 in ${g.accountName}`,
          detail:
            'Lines with no amount — usually card holds (“Blokada”), or a statement’s closing line — imported as 0.00. They count nowhere but clutter the lists. New uploads now flag a line with no amount in the preview instead of importing it.',
          fixes: [{ type: 'delete-empty-rows', label: 'Delete these rows', transactionIds: g.list.map((r) => r.id) }],
        },
        g.list,
      ),
    );
  }

  const impossible = d.rows.filter((r) => !CURRENCY_RE.test(r.currency) || Math.abs(r.amountCents) >= IMPOSSIBLE_CENTS);
  for (const g of perAccount(impossible, 'imports:impossible')) {
    out.push(
      finding(
        d,
        {
          key: g.key,
          check: 'imports',
          severity: 'high',
          title: `${g.list.length} impossible row${g.list.length === 1 ? '' : 's'} in ${g.accountName}`,
          detail:
            'An unreadable currency or an amount of ten million or more: almost always a bank line whose columns shifted (a delimiter inside a field). Uploads now reject such lines; these came in before that. Compare them with the original file and fix or remove them.',
        },
        g.list,
      ),
    );
  }

  // Duplicates the import's own dedup missed: one account, one date, one
  // amount, the same words — but written differently (case, spacing, accents),
  // so the dedup keys differ. That is what a statement imported twice in two
  // shapes looks like (CSV and OFX, or two export formats). Identical wording is
  // not a duplicate: the dedup key already counted those, occurrence by
  // occurrence, and two identical lines in one file are two transactions.
  const seen = new Map();
  for (const r of d.rows) {
    if (r.amountCents === 0) continue;
    const k = `${r.accountId}|${r.date}|${r.amountCents}|${r.tokens.join(' ')}`;
    let l = seen.get(k);
    if (!l) seen.set(k, (l = []));
    l.push(r);
  }
  const dupes = [];
  for (const l of seen.values()) {
    if (l.length > 1 && new Set(l.map((r) => r.description)).size > 1) dupes.push(...l);
  }
  if (dupes.length) {
    out.push(
      finding(
        d,
        {
          key: 'imports:duplicates',
          check: 'imports',
          title: `${dupes.length} rows look like duplicates`,
          detail:
            'Same account, date and amount, and the same words written differently (case, spacing or accents) — which is how one statement imported twice in two formats looks, since the import only recognizes identical wording. Check them against the bank; if they are copies, roll back the extra upload on the Uploads page.',
        },
        dupes,
      ),
    );
  }
  return out;
}

// --- Structure ------------------------------------------------------------------
function structure(d) {
  const out = [];
  const rowsByCat = new Set(d.rows.map((r) => r.categoryId));
  const rowsBySub = new Set(d.rows.map((r) => r.subcategoryId));
  const kwCats = new Set(d.kws.map((k) => k.categoryId));
  const kwSubs = new Set(d.kws.map((k) => k.subcategoryId));

  const emptyCats = d.cats.filter((c) => !rowsByCat.has(c.id) && !kwCats.has(c.id));
  const emptySubs = d.subs.filter((s) => !rowsBySub.has(s.id) && !kwSubs.has(s.id) && !emptyCats.some((c) => c.id === s.categoryId));
  const items = [
    ...emptyCats.map((c) => ({ type: 'category', id: c.id, name: c.name, note: 'no rows, no keywords', fix: { type: 'delete-category', label: 'Delete', categoryId: c.id } })),
    ...emptySubs.map((s) => ({ type: 'subcategory', id: s.id, name: `${d.catById.get(s.categoryId)?.name} › ${s.name}`, note: 'no rows, no keywords', fix: { type: 'delete-subcategory', label: 'Delete', subcategoryId: s.id } })),
  ];
  if (items.length) {
    out.push({
      ...finding(d, {
        key: 'structure:empty',
        check: 'structure',
        severity: 'low',
        title: `${items.length} categor${items.length === 1 ? 'y' : 'ies'} with nothing in ${items.length === 1 ? 'it' : 'them'}`,
        detail: 'No transactions and no keywords point at these, so they only lengthen every category picker. Keep the ones you plan to use.',
      }),
      items,
    });
  }

  // Keywords that classify nothing: either their text never appears
  // (a merchant you no longer use — or rows not imported yet), or it appears
  // but a longer keyword wins every time (shadowed: it can go).
  const won = new Set(d.rows.map((r) => r.matchedKeywordId).filter((id) => id != null));
  const idle = d.kws.filter((k) => !won.has(k.id));
  const shadowed = [];
  const unseen = [];
  for (const k of idle) {
    const tokens = tokenize(k.text);
    const hits = rowsContaining(d, tokens);
    if (hits.length) {
      const winners = [...new Set(hits.map((r) => r.matchedKeywordId).filter((id) => id != null && id !== k.id))].map((id) => d.kwById.get(id));
      // A winner with the very same words ("r500" and "r 500") is a duplicate
      // rule, not a more specific one — worth saying plainly.
      const twin = winners.find((w) => w && tokenize(w.text).join(' ') === tokens.join(' '));
      const by = winners.slice(0, 2).map((w) => `“${w?.text}”`).join(', ');
      const note = twin
        ? `duplicate of “${twin.text}”${twin.categoryId !== k.categoryId || twin.subcategoryId !== k.subcategoryId ? ` (→ ${catLabel(d, twin.categoryId, twin.subcategoryId)}, not ${catLabel(d, k.categoryId, k.subcategoryId)})` : ''}`
        : `in ${hits.length} row${hits.length === 1 ? '' : 's'}, outranked${by ? ` by ${by}` : ''}`;
      const sample = [...hits].sort(byDateDesc).slice(0, 5).map((r) => rowView(r, d, tokens));
      shadowed.push({ type: 'keyword', id: k.id, name: k.text, note, rows: sample, rowCount: hits.length, fix: { type: 'delete-keywords', label: 'Delete', keywordIds: [k.id] } });
    } else {
      unseen.push({ type: 'keyword', id: k.id, name: k.text, note: `→ ${catLabel(d, k.categoryId, k.subcategoryId)}`, fix: { type: 'delete-keywords', label: 'Delete', keywordIds: [k.id] } });
    }
  }
  if (shadowed.length) {
    out.push({
      ...finding(d, {
        key: 'structure:shadowed',
        check: 'structure',
        severity: 'low',
        title: `${shadowed.length} keyword${shadowed.length === 1 ? ' is' : 's are'} always outranked`,
        detail: 'Their text appears in your descriptions, but a longer keyword wins every one of those rows, so they classify nothing. Unless you want them as a fallback for future rows, they can go.',
        fixes: [{ type: 'delete-keywords', label: `Delete all ${shadowed.length}`, keywordIds: shadowed.map((s) => s.id) }],
      }),
      items: shadowed,
    });
  }
  if (unseen.length) {
    out.push({
      ...finding(d, {
        key: 'structure:unseen',
        check: 'structure',
        severity: 'low',
        title: `${unseen.length} keyword${unseen.length === 1 ? '' : 's'} match no description at all`,
        detail: 'Nothing you have imported contains their text. Some are for merchants you no longer use; some wait for an account you have not imported yet — keep those.',
      }),
      items: unseen,
    });
  }

  // Budget: categories not on a line yet land in Unassigned.
  if (d.lineCount > 0) {
    const open = d.cats.filter(
      (c) => !c.isHidden && c.budgetLineId == null && (() => {
        const own = d.subs.filter((s) => s.categoryId === c.id);
        return own.length === 0 || own.some((s) => s.budgetLineId == null);
      })(),
    );
    if (open.length) {
      out.push({
        ...finding(d, {
          key: 'structure:budget',
          check: 'structure',
          severity: 'low',
          title: `${open.length} categor${open.length === 1 ? 'y is' : 'ies are'} not on a Budget line`,
          detail: 'Their money counts as Unassigned in the P&L until they are placed.',
          fixes: [{ type: 'open', label: 'Place them in Setup', href: '/budget/setup' }],
        }),
        items: open.map((c) => ({ type: 'category', id: c.id, name: c.name, note: '' })),
      });
    }
  }
  return out;
}

// --- Transfers ------------------------------------------------------------------
// One summary per state, pointing at the Transfers tab where they are decided.
// Imported lazily: the reconciler imports this module for its highlighting.
async function transfers(d, userId) {
  const { transfersView } = await import('../transfers/reconcile.js');
  const v = transfersView(userId);
  const out = [];
  if (v.summary.unmatched) {
    const open = v.unmatched.filter((g) => !g.acknowledged);
    const rows = open.flatMap((g) => g.rows).sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
    out.push({
      key: 'transfers:unmatched',
      check: 'transfers',
      severity: 'medium',
      title: `${v.summary.unmatched} transfer leg${v.summary.unmatched === 1 ? ' has' : 's have'} no other side`,
      detail:
        'Filed as transfers, but no matching leg exists in your other accounts and no off-book account (an exchange wallet, a broker, a deposit) claims them. Either the other account is not imported — declare it — or the money really left or entered the household, and belongs in a spending or income category.',
      fixes: [{ type: 'open', label: 'Review on Transfers', href: '/accounts/transfers' }],
      items: [],
      rowCount: v.summary.unmatched,
      moneyCents: v.summary.unmatchedMoneyCents,
      currency: d.currency,
      rows: rows.slice(0, MAX_ROWS),
      rowIds: open.flatMap((g) => g.transactionIds),
    });
  }
  if (v.summary.suggested) {
    out.push({
      key: 'transfers:suggested',
      check: 'transfers',
      severity: 'low',
      title: `${v.summary.suggested} possible transfer pair${v.summary.suggested === 1 ? '' : 's'} to confirm`,
      detail: 'A transfer whose matching leg is filed as spending or income. Confirm the pair (and fix the category), or say it is not one.',
      fixes: [{ type: 'open', label: 'Review on Transfers', href: '/accounts/transfers' }],
      items: [],
      rowCount: 0,
      moneyCents: 0,
      currency: d.currency,
      rows: [],
      rowIds: v.suggested.flatMap((p) => [p.out.id, p.in.id]),
    });
  }
  return out;
}

// Every finding for a user, fingerprinted; dismissals are applied by the route.
export async function runChecks(userId) {
  const d = load(userId);
  const all = [...rules(d), ...direction(d), ...imports(d), ...structure(d), ...(await transfers(d, userId))];
  for (const f of all) {
    f.fingerprint = fingerprint([f.key, ...(f.rowIds ?? []).map(String), ...(f.items ?? []).map((i) => `${i.type}:${i.id}`)]);
    delete f.rowIds;
  }
  const order = { high: 0, medium: 1, low: 2 };
  return all.sort((a, b) => order[a.severity] - order[b.severity] || b.moneyCents - a.moneyCents);
}
