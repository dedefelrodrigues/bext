import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiKeys, aiProposals, aiProposalTransactions, aiRuns, categories, subcategories, users } from '../db/schema.js';
import { decryptSecret } from './crypto.js';
import { engineKeyOf, providerOf, serverKeyFor } from './providers.js';
import { SYSTEM_PROMPT, buildUserPrompt, extractJson, renderCategories } from './prompt.js';
import { planRun } from './grouping.js';

// Runs a batch of merchants past an AI engine and writes what it proposed.
//
// The run is a background job with a database row, not an HTTP request the page
// waits on: a web-searching engine spends tens of seconds per merchant, and a
// batch of 25 outlives any sensible request timeout — never mind a page reload.
// The review page creates the run, then polls it.

const CONCURRENCY = 3; // enough to hide the latency, gentle enough for a free tier
const MAX_KEYWORD = 200;

// --- Engine resolution ------------------------------------------------------

// The engine a user's settings currently name, with the key it would use.
// `ready` is false (with a reason) rather than throwing, because the settings
// page and the review page both need to *describe* an unusable engine.
export function resolveEngine(userId) {
  const user = db
    .select({
      provider: users.aiProvider,
      model: users.aiModel,
      webSearch: users.aiWebSearch,
      batchSize: users.aiBatchSize,
      defaultCurrency: users.defaultCurrency,
    })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return { ready: false, reason: 'Unknown user.' };

  const provider = providerOf(user.provider);
  if (!provider) {
    return { ready: false, reason: `Unknown AI provider "${user.provider}". Pick one in settings.` };
  }

  const model = user.model || provider.defaultModel;
  const webSearch = provider.supportsWebSearch && user.webSearch;

  let apiKey = serverKeyFor(provider);
  if (provider.keySource === 'user') {
    const row = db
      .select({ secret: aiKeys.secret })
      .from(aiKeys)
      .where(and(eq(aiKeys.userId, userId), eq(aiKeys.provider, provider.id)))
      .get();
    apiKey = row ? decryptSecret(row.secret) : null;
    if (row && !apiKey) {
      return { ready: false, reason: `The saved ${provider.label} key could not be read. Enter it again.`, provider, model, webSearch, batchSize: user.batchSize };
    }
  }

  const base = {
    provider,
    model,
    webSearch,
    batchSize: user.batchSize,
    defaultCurrency: user.defaultCurrency,
    engineKey: engineKeyOf(provider.id, model),
    apiKey,
  };
  if (!apiKey) {
    return {
      ...base,
      ready: false,
      reason:
        provider.keySource === 'server'
          ? `${provider.label} is not available on this server (${provider.keyEnv} is not set).`
          : `No ${provider.label} key saved. Add one in Settings → AI categorization.`,
    };
  }
  return { ...base, ready: true, reason: '' };
}

// --- The user's category tree, as the engine sees it ------------------------

function categoryTreeFor(userId) {
  const cats = db.select().from(categories).where(eq(categories.userId, userId)).all();
  const subs = db.select().from(subcategories).where(eq(subcategories.userId, userId)).all();
  const byCategory = new Map(cats.map((c) => [c.id, { ...c, subcategories: [] }]));
  for (const sub of subs) byCategory.get(sub.categoryId)?.subcategories.push(sub);
  return [...byCategory.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

// --- One merchant -----------------------------------------------------------

// Keeps the engine honest: a category it invented, or one belonging to another
// user, is dropped rather than stored. The proposal survives without it — an
// unplaceable merchant is still analyzed, and the review page lets you pick the
// category yourself before accepting.
function validatePick(answer, tree) {
  const catId = Number(answer?.categoryId);
  const cat = Number.isInteger(catId) ? tree.find((c) => c.id === catId) : null;
  if (!cat) return { categoryId: null, subcategoryId: null };

  const subId = Number(answer?.subcategoryId);
  const sub = Number.isInteger(subId) ? cat.subcategories.find((s) => s.id === subId) : null;
  return { categoryId: cat.id, subcategoryId: sub ? sub.id : null };
}

function cleanKeyword(answer, group) {
  const raw = String(answer?.keyword ?? '').trim();
  // A rule needs something to match on; the group key is the description with
  // its branch codes and reference numbers already stripped, so its leading
  // words are the safe fallback when a model returns none.
  const fallback = group.groupKey.split(' ').slice(0, 2).join(' ');
  return (raw || fallback).slice(0, MAX_KEYWORD);
}

async function analyzeGroup({ engine, group, tree, categoryTreeText }) {
  const { text, sources } = await engine.provider.complete({
    apiKey: engine.apiKey,
    model: engine.model,
    webSearch: engine.webSearch,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(group, categoryTreeText, { defaultCurrency: engine.defaultCurrency }),
  });

  const answer = extractJson(text);
  if (!answer) throw new Error('The engine did not return a readable JSON answer.');

  const pick = validatePick(answer, tree);
  const confidence = Number(answer.confidence);

  // Citations are shown only when a search actually happened. A model asked NOT
  // to search still volunteers a plausible-looking URL — a Gemini run with the
  // lookup off cited a Wikipedia article that does not exist — and a fabricated
  // source chip is worse than none, because it looks like evidence. When the
  // lookup did run, the provider's own grounding metadata outranks the model's
  // retelling of it; the model's list fills in only where the provider gave
  // none.
  const cited = Array.isArray(answer.sources)
    ? answer.sources.filter((s) => s?.url).map((s) => ({ title: String(s.title ?? s.url), url: String(s.url) }))
    : [];
  const attributed = engine.webSearch ? (sources.length ? sources : cited) : [];

  return {
    merchant: answer.merchant ? String(answer.merchant).slice(0, 200) : null,
    keyword: cleanKeyword(answer, group),
    ...pick,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : null,
    rationale: answer.rationale ? String(answer.rationale).slice(0, 2000) : null,
    sources: attributed.slice(0, 8),
  };
}

function saveProposal(userId, runId, engine, group, result) {
  db.transaction(() => {
    const proposal = db
      .insert(aiProposals)
      .values({
        userId,
        runId,
        provider: engine.provider.id,
        model: engine.model,
        engineKey: engine.engineKey,
        webSearch: engine.webSearch,
        groupKey: group.groupKey,
        sampleDescription: group.sampleDescription,
        merchant: result.merchant,
        keyword: result.keyword,
        categoryId: result.categoryId,
        subcategoryId: result.subcategoryId,
        confidence: result.confidence,
        rationale: result.rationale,
        sources: result.sources,
        txCount: group.txCount,
      })
      .returning()
      .get();

    // The per-transaction log: which rows this proposal covered, so the review
    // page can mark them and a later question ("was this row ever analyzed?")
    // has an answer that does not depend on re-deriving the group key.
    for (const row of group.rows) {
      db.insert(aiProposalTransactions).values({ proposalId: proposal.id, transactionId: row.id }).run();
    }
  });
}

// --- The run ----------------------------------------------------------------

function runStatus(runId) {
  return db.select({ status: aiRuns.status }).from(aiRuns).where(eq(aiRuns.id, runId)).get()?.status;
}

async function processRun(userId, runId, engine, groups) {
  const tree = categoryTreeFor(userId);
  const categoryTreeText = renderCategories(tree);
  const queue = [...groups];

  async function worker() {
    for (;;) {
      if (runStatus(runId) === 'canceled') return;
      const group = queue.shift();
      if (!group) return;
      try {
        const result = await analyzeGroup({ engine, group, tree, categoryTreeText });
        saveProposal(userId, runId, engine, group, result);
        db.update(aiRuns).set({ completed: sql`${aiRuns.completed} + 1` }).where(eq(aiRuns.id, runId)).run();
      } catch (err) {
        // One merchant failing is not the run failing — the rest still run, and
        // nothing is logged for this one, so a later run may try it again.
        const lastError = err?.message ?? String(err);
        db.update(aiRuns)
          .set({ failed: sql`${aiRuns.failed} + 1`, error: lastError })
          .where(eq(aiRuns.id, runId))
          .run();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker));

  const final = db.select().from(aiRuns).where(eq(aiRuns.id, runId)).get();
  if (final?.status === 'canceled') {
    db.update(aiRuns).set({ finishedAt: new Date().toISOString() }).where(eq(aiRuns.id, runId)).run();
    return;
  }
  db.update(aiRuns)
    .set({
      // Every merchant failing is a broken engine, not 25 unlucky merchants.
      status: final && final.completed === 0 && final.failed > 0 ? 'failed' : 'done',
      finishedAt: new Date().toISOString(),
    })
    .where(eq(aiRuns.id, runId))
    .run();
}

// Creates the run row and starts the work. Returns the run immediately —
// the caller polls it. Throws (synchronously) only for the things the user can
// fix before anything is spent: no key, no candidates.
export function startRun(userId, { filters = {}, limit } = {}) {
  const engine = resolveEngine(userId);
  if (!engine.ready) {
    const err = new Error(engine.reason);
    err.status = 400;
    throw err;
  }

  const size = Number.isInteger(limit) && limit >= 0 ? limit : engine.batchSize;
  const plan = planRun(userId, engine.engineKey, filters, size);
  if (!plan.selected.length) {
    const err = new Error(
      plan.merchants === 0
        ? 'No uncategorized transactions to analyze.'
        : `Every uncategorized merchant here has already been analyzed by ${engine.provider.label} (${engine.model}). Switch engine in settings for a second opinion.`,
    );
    err.status = 400;
    throw err;
  }

  const run = db
    .insert(aiRuns)
    .values({
      userId,
      provider: engine.provider.id,
      model: engine.model,
      engineKey: engine.engineKey,
      webSearch: engine.webSearch,
      requested: plan.selected.length,
    })
    .returning()
    .get();

  // Deliberately not awaited: the HTTP response returns the run id now, the
  // work continues in the background, and the page polls.
  const work = processRun(userId, run.id, engine, plan.selected).catch((err) => {
    db.update(aiRuns)
      .set({ status: 'failed', error: err?.message ?? String(err), finishedAt: new Date().toISOString() })
      .where(eq(aiRuns.id, run.id))
      .run();
  });
  // Exposed so tests can await the batch instead of polling for it.
  runsInFlight.set(run.id, work);
  work.finally(() => runsInFlight.delete(run.id));

  return { run, plan };
}

export const runsInFlight = new Map();
