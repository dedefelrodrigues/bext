import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, categories, healthDismissals, keywords, offbookAccounts, subcategories, transactions, transferDecisions, users } from '../db/schema.js';
import { containerIds } from '../transactions/routes.js';
import { buildConverter } from '../fx/converter.js';
import { tokenize } from '../engine/classify.js';
import { groupKeyOf } from '../ai/grouping.js';
import { fingerprint, highlightRanges } from '../health/checks.js';

// --- Transfer reconciliation ---------------------------------------------------
//
// A transfer has two legs. Where both accounts are imported, the legs can be
// paired: money that left one arrived in the other, and the pair is internal.
// Where the other account is not imported — a bank's exchange wallet, a broker,
// a term deposit, a loan — the user declares it as an *off-book account*, and
// its rows are internal by definition; its running balance says what should be
// there. What is left — a transfer leg with no partner and no off-book account
// — is money that entered or left the household as a "transfer", and the page
// asks about it.
//
// Pairing is a pure function of the rows, the off-book declarations and the
// user's decisions, recomputed on every read like classification. It links;
// it never rewrites a category.
//
// A leg is *transfer-ish* when it sits in a hidden category (Transfer In/Out)
// or is uncategorized. A pair is found automatically when both legs are
// transfer-ish. When the other leg is filed as spending or income the pair is
// only *suggested*, and only on the exact same amount in the same currency: an
// FX match within 3% against an ordinary purchase is a coincidence far more
// often than a transfer (a school fee "matched" a Revolut balance migration).

const SAME_CCY_DAYS = 4; // bank transfers take a few days to land
const FX_DAYS = 2; // an exchange settles both legs together
const FX_TOLERANCE = 0.03; // the bank's rate against the rate table
const DAY = 86400000;

export const OFFBOOK_KINDS = ['exchange', 'savings', 'loan', 'other'];

function load(userId) {
  const user = db.select({ currency: users.defaultCurrency }).from(users).where(eq(users.id, userId)).get();
  const containers = containerIds(userId);
  const where = containers.length ? and(eq(transactions.userId, userId), notInArray(transactions.id, containers)) : eq(transactions.userId, userId);
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      holder: accounts.holder,
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

  const cats = db.select().from(categories).where(eq(categories.userId, userId)).all();
  const catById = new Map(cats.map((c) => [c.id, c]));
  const converter = buildConverter(userId, user.currency);
  for (const r of rows) {
    const c = converter.convert(r);
    r.value = c.converted ? c.cents : null;
    r.day = Math.round(Date.parse(r.date) / DAY);
    r.tokens = tokenize(r.description);
    r.tokenText = ` ${r.tokens.join(' ')} `;
    const cat = r.categoryId != null ? catById.get(r.categoryId) : null;
    r.transferish = !cat || cat.isHidden;
    r.hidden = !!cat?.isHidden;
  }
  // Per account, how many rows carry each word: words on most of an account's
  // rows (the owner's name, which Alior prints on every line) name nothing.
  const accountDf = new Map();
  for (const r of rows) {
    let e = accountDf.get(r.accountId);
    if (!e) accountDf.set(r.accountId, (e = { n: 0, df: new Map() }));
    e.n++;
    for (const t of new Set(r.tokens)) e.df.set(t, (e.df.get(t) ?? 0) + 1);
  }
  return {
    currency: user.currency,
    rows,
    accountDf,
    byId: new Map(rows.map((r) => [r.id, r])),
    catById,
    subById: new Map(db.select().from(subcategories).where(eq(subcategories.userId, userId)).all().map((s) => [s.id, s])),
    kwById: new Map(db.select().from(keywords).where(eq(keywords.userId, userId)).all().map((k) => [k.id, k])),
    offbook: db.select().from(offbookAccounts).where(eq(offbookAccounts.userId, userId)).all(),
    decisions: db.select().from(transferDecisions).where(eq(transferDecisions.userId, userId)).all(),
  };
}

export function rowView(r, d, highlightTokens = null) {
  const cat = r.categoryId != null ? d.catById.get(r.categoryId) : null;
  const sub = r.subcategoryId != null ? d.subById.get(r.subcategoryId) : null;
  const kw = r.matchedKeywordId != null ? d.kwById.get(r.matchedKeywordId) : null;
  return {
    id: r.id,
    date: r.date,
    description: r.description,
    accountName: r.accountName,
    holder: r.holder,
    amountCents: r.amountCents,
    currency: r.currency,
    value: r.value,
    category: cat ? { id: cat.id, name: cat.name, icon: cat.icon } : null,
    subcategory: sub ? { id: sub.id, name: sub.name } : null,
    keyword: kw ? { id: kw.id, text: kw.text } : null,
    manual: r.isLocked || r.isManual,
    highlight: highlightTokens ? highlightRanges(r.description, highlightTokens) : [],
  };
}

// How well `b` answers `a` as the other leg, or null when it cannot.
function fit(a, b) {
  if (a.accountId === b.accountId || Math.sign(a.amountCents) !== -Math.sign(b.amountCents) || a.amountCents === 0) return null;
  const days = Math.abs(a.day - b.day);
  if (a.currency === b.currency) {
    if (Math.abs(a.amountCents) !== Math.abs(b.amountCents) || days > SAME_CCY_DAYS) return null;
    return { kind: 'same', days, diff: 0 };
  }
  if (a.value == null || b.value == null || days > FX_DAYS) return null;
  const diff = Math.abs(Math.abs(a.value) - Math.abs(b.value)) / Math.max(Math.abs(a.value), Math.abs(b.value));
  return diff <= FX_TOLERANCE ? { kind: 'fx', days, diff } : null;
}

export function reconcile(userId) {
  const d = load(userId);
  const used = new Set();
  const pairs = [];
  const rejected = new Set(d.decisions.filter((x) => x.status === 'rejected').map((x) => `${x.outId}:${x.inId}`));
  const orient = (a, b) => (a.amountCents < 0 ? [a, b] : [b, a]);

  // 1. What the user confirmed stands, whatever the matcher would say.
  for (const dec of d.decisions) {
    if (dec.status !== 'confirmed') continue;
    const o = d.byId.get(dec.outId);
    const i = d.byId.get(dec.inId);
    if (!o || !i || used.has(o.id) || used.has(i.id)) continue;
    used.add(o.id);
    used.add(i.id);
    pairs.push({ out: o, in: i, status: 'confirmed', ...(fit(o, i) ?? { kind: o.currency === i.currency ? 'same' : 'fx', days: Math.abs(o.day - i.day), diff: null }) });
  }

  // 2. The matcher: biggest legs first (they have the fewest look-alikes), each
  //    taking its closest partner by date, then by amount, then by id.
  const byDay = new Map();
  for (const r of d.rows) {
    let l = byDay.get(r.day);
    if (!l) byDay.set(r.day, (l = []));
    l.push(r);
  }
  const legs = d.rows.filter((r) => r.hidden && r.amountCents !== 0).sort((a, b) => Math.abs(b.value ?? b.amountCents) - Math.abs(a.value ?? a.amountCents) || a.id - b.id);
  for (const a of legs) {
    if (used.has(a.id)) continue;
    let best = null;
    for (let day = a.day - SAME_CCY_DAYS; day <= a.day + SAME_CCY_DAYS; day++) {
      for (const b of byDay.get(day) ?? []) {
        if (b.id === a.id || used.has(b.id)) continue;
        const [o, i] = orient(a, b);
        if (rejected.has(`${o.id}:${i.id}`)) continue;
        const f = fit(a, b);
        if (!f || (!b.transferish && f.kind !== 'same')) continue;
        const score = [f.days, f.diff, b.id];
        if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) {
          best = { b, f, score };
        }
      }
    }
    if (!best) continue;
    used.add(a.id);
    used.add(best.b.id);
    const [o, i] = orient(a, best.b);
    pairs.push({ out: o, in: i, status: best.b.transferish ? 'auto' : 'suggested', ...best.f });
  }

  // 3. Off-book accounts claim the transfer legs their patterns name.
  const offbook = d.offbook.map((ob) => ({ ...ob, tokenPatterns: (ob.patterns ?? []).map((p) => tokenize(p)).filter((t) => t.length), rows: [] }));
  const unmatched = [];
  for (const r of d.rows) {
    if (used.has(r.id) || !r.transferish || r.amountCents === 0) continue;
    const ob = offbook.find((o) => o.tokenPatterns.some((t) => r.tokenText.includes(` ${t.join(' ')} `)));
    if (ob) ob.rows.push(r);
    else if (r.hidden) unmatched.push(r); // an uncategorized row is not a transfer until someone says so
  }

  return { d, pairs, offbook, unmatched };
}

// --- Views for the page ------------------------------------------------------------

const MAX_ROWS = 200;
const ymOf = (date) => date.slice(0, 7);

// An off-book account's balance, month by month: money leaving your accounts
// into it raises it, money coming back lowers it (display currency, each row
// at its own date's rate). Rows with no rate are counted apart, not guessed.
function balanceSeries(rows) {
  const byMonth = new Map();
  let unconverted = 0;
  for (const r of rows) {
    if (r.value == null) {
      unconverted++;
      continue;
    }
    byMonth.set(ymOf(r.date), (byMonth.get(ymOf(r.date)) ?? 0) - r.value);
  }
  const months = [...byMonth.keys()].sort();
  const series = [];
  if (months.length) {
    let [y, m] = months[0].split('-').map(Number);
    const now = new Date();
    const last = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let running = 0;
    for (let guard = 0; guard < 1200; guard++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      running += byMonth.get(key) ?? 0;
      series.push({ ym: key, balance: running });
      if (key >= last) break;
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
  }
  // What has passed through (half of all movement: in and back out count once),
  // so "near zero" can be judged against the money involved — each row is
  // converted at the rate table's rate, not the bank's, and the difference adds up.
  const throughputCents = Math.round(rows.reduce((t, r) => t + Math.abs(r.value ?? 0), 0) / 2);
  return { series, balanceCents: series.length ? series[series.length - 1].balance : 0, throughputCents, unconverted };
}

// What to prefill when an unmatched group is declared as an off-book account:
// the group's words minus the ones on most of that account's rows, and a kind
// guessed from the usual words for an exchange wallet, a broker, a deposit or a
// loan. A draft for the user to edit, never applied on its own.
const KIND_HINTS = [
  [/kantor|exchange|wymiana/, 'exchange'],
  [/maklersk|broker|degiro|xtb|fund|lokat|deposit|savings|oszczednosc/, 'savings'],
  [/loan|lending|pozyczk|debt/, 'loan'],
];
function suggestion(g, d) {
  const acct = d.accountDf.get(g.accountId);
  // Patterns match consecutive words, so the draft is the longest run of
  // uncommon words, not the uncommon words stitched together.
  // Only on a real history: in an account of a handful of rows every word is "common".
  const common = (t) => t.length < 2 || (acct && acct.n >= 20 && acct.df.get(t) > acct.n * 0.3);
  let run = [];
  let words = [];
  for (const t of g.counterparty.split(' ')) {
    if (common(t)) run = [];
    else if ((run = [...run, t]).length > words.length) words = run;
  }
  words = words.slice(0, 4);
  const pattern = words.join(' ');
  const kind = KIND_HINTS.find(([re]) => re.test(g.counterparty))?.[1] ?? 'other';
  const name = words.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return { name: name || 'Other account', kind, patterns: pattern ? [pattern] : [] };
}

// Unmatched legs grouped the way they are decided: one account, one direction,
// one counterparty (the merchant key the AI review uses, so branch numbers and
// references fold together).
function unmatchedGroups(unmatched, d) {
  const groups = new Map();
  for (const r of unmatched) {
    const key = `${r.accountId}|${r.amountCents < 0 ? 'out' : 'in'}|${groupKeyOf(r.description)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, accountId: r.accountId, accountName: r.accountName, holder: r.holder, direction: r.amountCents < 0 ? 'out' : 'in', counterparty: groupKeyOf(r.description), rows: [] }));
    g.rows.push(r);
  }
  return [...groups.values()]
    .map((g) => {
      const sorted = g.rows.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
      return {
        key: g.key,
        accountName: g.accountName,
        holder: g.holder,
        direction: g.direction,
        counterparty: g.counterparty,
        rowCount: sorted.length,
        moneyCents: sorted.reduce((s, r) => s + Math.abs(r.value ?? 0), 0),
        rows: sorted.slice(0, MAX_ROWS).map((r) => rowView(r, d)),
        transactionIds: sorted.map((r) => r.id),
        firstDate: sorted[sorted.length - 1].date,
        lastDate: sorted[0].date,
        suggestion: suggestion(g, d),
      };
    })
    .sort((a, b) => b.moneyCents - a.moneyCents);
}

export function transfersView(userId) {
  const { d, pairs, offbook, unmatched } = reconcile(userId);
  const pairView = (p) => ({
    out: rowView(p.out, d),
    in: rowView(p.in, d),
    status: p.status,
    kind: p.kind,
    days: p.days,
    crossHolder: p.out.holder !== p.in.holder,
  });
  // "This is fine" on a group is a Health dismissal under its own key: the group
  // stays listed but leaves the count until its rows change.
  const dismissed = new Map(db.select().from(healthDismissals).where(eq(healthDismissals.userId, userId)).all().map((x) => [x.key, x.fingerprint]));
  const groups = unmatchedGroups(unmatched, d).map((g) => {
    const ackKey = `transfers:ack:${g.key}`;
    const ackFingerprint = fingerprint([ackKey, ...g.transactionIds.map(String)]);
    return { ...g, ackKey, ackFingerprint, acknowledged: dismissed.get(ackKey) === ackFingerprint };
  });
  const open = groups.filter((g) => !g.acknowledged);
  const offbookView = offbook.map((ob) => {
    const sorted = [...ob.rows].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    return {
      id: ob.id,
      name: ob.name,
      kind: ob.kind,
      patterns: ob.patterns,
      rowCount: sorted.length,
      ...balanceSeries(sorted),
      rows: sorted.slice(0, MAX_ROWS).map((r) => rowView(r, d, ob.tokenPatterns.find((t) => r.tokenText.includes(` ${t.join(' ')} `)))),
    };
  });
  const matched = pairs.filter((p) => p.status !== 'suggested');
  return {
    currency: d.currency,
    summary: {
      pairs: matched.length,
      suggested: pairs.length - matched.length,
      offbookRows: offbook.reduce((s, o) => s + o.rows.length, 0),
      offbookAccounts: offbook.length,
      unmatched: open.reduce((s, g) => s + g.rowCount, 0),
      unmatchedMoneyCents: open.reduce((s, g) => s + g.moneyCents, 0),
      acknowledged: groups.length - open.length,
    },
    suggested: pairs.filter((p) => p.status === 'suggested').map(pairView),
    pairs: matched.sort((a, b) => b.out.date.localeCompare(a.out.date)).map(pairView),
    offbook: offbookView,
    unmatched: groups,
  };
}
