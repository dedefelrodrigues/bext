import { Router } from 'express';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  aiKeys,
  aiProposals,
  aiProposalTransactions,
  aiRuns,
  categories,
  keywords,
  subcategories,
  transactions,
  users,
} from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { recomputeUser } from '../engine/recompute.js';
import { encryptSecret, keyHint } from './crypto.js';
import { PROVIDERS, PROVIDER_IDS, providerOf, serverKeyFor } from './providers.js';
import { planRun, proposedTransactionIds } from './grouping.js';
import { resolveEngine, startRun } from './runner.js';

export const aiRouter = Router();

aiRouter.use(requireAuth);

const MAX_BATCH = 200; // a run is money; a typo should not spend 5000 lookups

// --- Engines and keys -------------------------------------------------------

// What engines exist, which are usable, and which hold a saved key. Never the
// key itself — only the last four characters, so you can tell which one is in.
aiRouter.get('/engines', (req, res) => {
  const saved = new Map(
    db
      .select({ provider: aiKeys.provider, hint: aiKeys.hint })
      .from(aiKeys)
      .where(eq(aiKeys.userId, req.userId))
      .all()
      .map((row) => [row.provider, row.hint]),
  );

  res.json(
    PROVIDER_IDS.map((id) => {
      const provider = PROVIDERS[id];
      const serverKey = serverKeyFor(provider);
      return {
        id,
        label: provider.label,
        keySource: provider.keySource,
        keyLabel: provider.keyLabel ?? null,
        keyPlaceholder: provider.keyPlaceholder ?? null,
        keyEnv: provider.keyEnv ?? null,
        defaultModel: provider.defaultModel,
        models: provider.models,
        supportsWebSearch: provider.supportsWebSearch,
        hasKey: provider.keySource === 'server' ? !!serverKey : saved.has(id),
        hint: saved.get(id) ?? null,
      };
    }),
  );
});

function engineSummary(userId) {
  const engine = resolveEngine(userId);
  return {
    provider: engine.provider?.id ?? null,
    label: engine.provider?.label ?? null,
    model: engine.model ?? null,
    engineKey: engine.engineKey ?? null,
    webSearch: !!engine.webSearch,
    supportsWebSearch: !!engine.provider?.supportsWebSearch,
    batchSize: engine.batchSize ?? 25,
    ready: engine.ready,
    reason: engine.reason,
  };
}

aiRouter.get('/settings', (req, res) => {
  const row = db
    .select({
      provider: users.aiProvider,
      model: users.aiModel,
      webSearch: users.aiWebSearch,
      batchSize: users.aiBatchSize,
    })
    .from(users)
    .where(eq(users.id, req.userId))
    .get();
  res.json({ ...row, engine: engineSummary(req.userId) });
});

aiRouter.put('/settings', (req, res) => {
  const patch = {};

  if (req.body?.provider !== undefined) {
    const provider = providerOf(String(req.body.provider));
    if (!provider) return res.status(400).json({ error: 'Unknown AI provider.' });
    patch.aiProvider = provider.id;
    // The model belongs to the provider: keeping "gpt-5" selected while
    // switching to Claude would name an engine that cannot exist.
    if (req.body?.model === undefined) patch.aiModel = '';
  }

  if (req.body?.model !== undefined) {
    patch.aiModel = String(req.body.model ?? '').trim().slice(0, 100);
  }

  if (req.body?.webSearch !== undefined) {
    patch.aiWebSearch = !!req.body.webSearch;
  }

  if (req.body?.batchSize !== undefined) {
    const size = Number(req.body.batchSize);
    if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH) {
      return res.status(400).json({ error: `Merchants per run must be a whole number from 1 to ${MAX_BATCH}.` });
    }
    patch.aiBatchSize = size;
  }

  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

  db.update(users).set(patch).where(eq(users.id, req.userId)).run();
  const row = db
    .select({
      provider: users.aiProvider,
      model: users.aiModel,
      webSearch: users.aiWebSearch,
      batchSize: users.aiBatchSize,
    })
    .from(users)
    .where(eq(users.id, req.userId))
    .get();
  res.json({ ...row, engine: engineSummary(req.userId) });
});

aiRouter.put('/keys/:provider', (req, res) => {
  const provider = providerOf(req.params.provider);
  if (!provider) return res.status(404).json({ error: 'Unknown AI provider.' });
  if (provider.keySource !== 'user') {
    return res.status(400).json({ error: `${provider.label} uses a key supplied by the server.` });
  }

  const key = String(req.body?.key ?? '').trim();
  if (!key) return res.status(400).json({ error: 'Enter an API key.' });

  const values = { userId: req.userId, provider: provider.id, secret: encryptSecret(key), hint: keyHint(key) };
  const existing = db
    .select({ id: aiKeys.id })
    .from(aiKeys)
    .where(and(eq(aiKeys.userId, req.userId), eq(aiKeys.provider, provider.id)))
    .get();
  if (existing) db.update(aiKeys).set(values).where(eq(aiKeys.id, existing.id)).run();
  else db.insert(aiKeys).values(values).run();

  res.json({ provider: provider.id, hasKey: true, hint: values.hint });
});

aiRouter.delete('/keys/:provider', (req, res) => {
  const provider = providerOf(req.params.provider);
  if (!provider) return res.status(404).json({ error: 'Unknown AI provider.' });
  db.delete(aiKeys).where(and(eq(aiKeys.userId, req.userId), eq(aiKeys.provider, provider.id))).run();
  res.json({ provider: provider.id, hasKey: false, hint: null });
});

// --- Planning and runs ------------------------------------------------------

function filtersOf(query) {
  return {
    accountId: query.accountId ? Number(query.accountId) : null,
    from: query.from || null,
    to: query.to || null,
  };
}

// What a run would cost you, before you pay for it.
aiRouter.get('/plan', (req, res) => {
  const engine = resolveEngine(req.userId);
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : (engine.batchSize ?? 25);
  const plan = planRun(req.userId, engine.engineKey ?? '', filtersOf(req.query), Number.isInteger(limit) ? limit : 25);
  res.json({
    engine: engineSummary(req.userId),
    uncategorized: plan.uncategorized,
    merchants: plan.merchants,
    alreadyAnalyzed: plan.alreadyAnalyzed,
    eligible: plan.eligible,
    willAnalyze: plan.selected.length,
    next: plan.selected.slice(0, 10).map((g) => ({ description: g.sampleDescription, txCount: g.txCount })),
  });
});

aiRouter.post('/runs', (req, res) => {
  const limit = req.body?.limit !== undefined ? Number(req.body.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH)) {
    return res.status(400).json({ error: `Merchants per run must be a whole number from 1 to ${MAX_BATCH}.` });
  }
  try {
    const { run, plan } = startRun(req.userId, { filters: filtersOf(req.body?.filters ?? {}), limit });
    res.status(201).json({ run, eligible: plan.eligible, alreadyAnalyzed: plan.alreadyAnalyzed });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

function ownedRun(id, userId) {
  return db
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.id, id), eq(aiRuns.userId, userId)))
    .get();
}

aiRouter.get('/runs', (req, res) => {
  const rows = db
    .select()
    .from(aiRuns)
    .where(eq(aiRuns.userId, req.userId))
    .orderBy(desc(aiRuns.id))
    .limit(20)
    .all();
  res.json(rows);
});

aiRouter.get('/runs/:id', (req, res) => {
  const run = ownedRun(Number(req.params.id), req.userId);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  res.json(run);
});

aiRouter.post('/runs/:id/cancel', (req, res) => {
  const run = ownedRun(Number(req.params.id), req.userId);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  if (run.status !== 'running') return res.json(run);
  // The workers check this between merchants: the one in flight finishes and is
  // kept (it is already paid for), nothing new starts.
  db.update(aiRuns).set({ status: 'canceled' }).where(eq(aiRuns.id, run.id)).run();
  res.json({ ...run, status: 'canceled' });
});

// --- Proposals --------------------------------------------------------------

const PENDING = 'pending';

function proposalRows(userId, { status, runId, limit = 200 }) {
  const where = [eq(aiProposals.userId, userId)];
  if (status === PENDING) where.push(eq(aiProposals.status, PENDING));
  else if (status === 'decided') where.push(sql`${aiProposals.status} <> ${PENDING}`);
  if (runId) where.push(eq(aiProposals.runId, runId));

  const rows = db
    .select({
      id: aiProposals.id,
      runId: aiProposals.runId,
      provider: aiProposals.provider,
      model: aiProposals.model,
      engineKey: aiProposals.engineKey,
      webSearch: aiProposals.webSearch,
      groupKey: aiProposals.groupKey,
      sampleDescription: aiProposals.sampleDescription,
      merchant: aiProposals.merchant,
      keyword: aiProposals.keyword,
      categoryId: aiProposals.categoryId,
      categoryName: categories.name,
      categoryIcon: categories.icon,
      subcategoryId: aiProposals.subcategoryId,
      subcategoryName: subcategories.name,
      confidence: aiProposals.confidence,
      rationale: aiProposals.rationale,
      sources: aiProposals.sources,
      status: aiProposals.status,
      txCount: aiProposals.txCount,
      createdKeywordId: aiProposals.createdKeywordId,
      createdAt: aiProposals.createdAt,
      decidedAt: aiProposals.decidedAt,
    })
    .from(aiProposals)
    .leftJoin(categories, eq(categories.id, aiProposals.categoryId))
    .leftJoin(subcategories, eq(subcategories.id, aiProposals.subcategoryId))
    .where(and(...where))
    .orderBy(desc(aiProposals.txCount), desc(aiProposals.id))
    .limit(limit)
    .all();

  if (!rows.length) return rows;

  // The transactions each proposal covers — the log, read back. Still-
  // uncategorized ones are what an accept would actually change.
  const covered = db
    .select({
      proposalId: aiProposalTransactions.proposalId,
      id: transactions.id,
      date: transactions.date,
      description: transactions.description,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      accountName: accounts.name,
      categoryId: transactions.categoryId,
    })
    .from(aiProposalTransactions)
    .innerJoin(transactions, eq(transactions.id, aiProposalTransactions.transactionId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(inArray(aiProposalTransactions.proposalId, rows.map((r) => r.id)))
    .orderBy(desc(transactions.date))
    .all();

  const byProposal = new Map(rows.map((r) => [r.id, []]));
  for (const tx of covered) byProposal.get(tx.proposalId)?.push(tx);

  return rows.map((row) => {
    const txns = byProposal.get(row.id) ?? [];
    return {
      ...row,
      transactions: txns.slice(0, 25),
      coveredCount: txns.length,
      stillUncategorized: txns.filter((t) => t.categoryId == null).length,
    };
  });
}

aiRouter.get('/proposals', (req, res) => {
  const status = req.query.status === 'decided' ? 'decided' : req.query.status === 'all' ? 'all' : PENDING;
  const runId = req.query.runId ? Number(req.query.runId) : null;
  res.json(proposalRows(req.userId, { status, runId }));
});

// How much of the AI log there is, for the page header and the settings card.
aiRouter.get('/stats', (req, res) => {
  const counts = db
    .select({ status: aiProposals.status, n: sql`count(*)`.mapWith(Number) })
    .from(aiProposals)
    .where(eq(aiProposals.userId, req.userId))
    .groupBy(aiProposals.status)
    .all();
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  const engines = db
    .select({ engineKey: aiProposals.engineKey, n: sql`count(*)`.mapWith(Number) })
    .from(aiProposals)
    .where(eq(aiProposals.userId, req.userId))
    .groupBy(aiProposals.engineKey)
    .all();
  res.json({
    pending: byStatus.pending ?? 0,
    accepted: (byStatus.accepted ?? 0) + (byStatus.accepted_once ?? 0),
    rejected: byStatus.rejected ?? 0,
    analyzedTransactions: new Set(proposedTransactionIds(req.userId).map((r) => r.transactionId)).size,
    engines,
  });
});

function ownedProposal(id, userId) {
  return db
    .select()
    .from(aiProposals)
    .where(and(eq(aiProposals.id, id), eq(aiProposals.userId, userId)))
    .get();
}

// The category an accept lands on: whatever the reviewer chose in the panel,
// else what the engine proposed. Editing before accepting is the point — the
// engine is a first draft, not a verdict.
function resolveAcceptCategory(body, proposal, userId) {
  const categoryId = body?.categoryId !== undefined && body.categoryId !== null && body.categoryId !== ''
    ? Number(body.categoryId)
    : proposal.categoryId;
  if (!Number.isInteger(categoryId)) return { error: 'Choose a category before accepting.' };

  const cat = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
    .get();
  if (!cat) return { error: 'Category not found.', status: 404 };

  const rawSub = body?.subcategoryId !== undefined ? body.subcategoryId : proposal.subcategoryId;
  if (rawSub === null || rawSub === '' || rawSub === undefined) return { categoryId, subcategoryId: null };

  const sub = db
    .select({ id: subcategories.id, categoryId: subcategories.categoryId })
    .from(subcategories)
    .where(and(eq(subcategories.id, Number(rawSub)), eq(subcategories.userId, userId)))
    .get();
  if (!sub) return { error: 'Subcategory not found.', status: 404 };
  if (sub.categoryId !== categoryId) return { error: 'Subcategory does not belong to the chosen category.' };
  return { categoryId, subcategoryId: sub.id };
}

function coveredTransactionIds(proposalId) {
  return db
    .select({ id: aiProposalTransactions.transactionId })
    .from(aiProposalTransactions)
    .where(eq(aiProposalTransactions.proposalId, proposalId))
    .all()
    .map((r) => r.id);
}

aiRouter.post('/proposals/:id/accept', (req, res) => {
  const proposal = ownedProposal(Number(req.params.id), req.userId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });
  if (proposal.status !== PENDING) return res.status(400).json({ error: 'This proposal was already decided.' });

  const pick = resolveAcceptCategory(req.body ?? {}, proposal, req.userId);
  if (pick.error) return res.status(pick.status ?? 400).json({ error: pick.error });

  const mode = req.body?.mode === 'once' ? 'once' : 'rule';
  const now = new Date().toISOString();

  if (mode === 'once') {
    // No rule: categorize exactly the transactions this proposal covered and
    // that nothing else has claimed since. Imported rows lock, as a manual
    // categorization does, so a recompute never takes them back.
    const ids = coveredTransactionIds(proposal.id);
    let updated = 0;
    if (ids.length) {
      const rows = db
        .select({ id: transactions.id, isManual: transactions.isManual })
        .from(transactions)
        .where(and(eq(transactions.userId, req.userId), inArray(transactions.id, ids), isNull(transactions.categoryId)))
        .all();
      const base = { categoryId: pick.categoryId, subcategoryId: pick.subcategoryId };
      db.transaction(() => {
        const imported = rows.filter((r) => !r.isManual).map((r) => r.id);
        const manual = rows.filter((r) => r.isManual).map((r) => r.id);
        if (imported.length) {
          db.update(transactions)
            .set({ ...base, isLocked: true, matchedKeywordId: null })
            .where(inArray(transactions.id, imported))
            .run();
        }
        if (manual.length) db.update(transactions).set(base).where(inArray(transactions.id, manual)).run();
      });
      updated = rows.length;
    }
    db.update(aiProposals)
      .set({ status: 'accepted_once', categoryId: pick.categoryId, subcategoryId: pick.subcategoryId, decidedAt: now })
      .where(eq(aiProposals.id, proposal.id))
      .run();
    return res.json({ ...proposal, status: 'accepted_once', ...pick, decidedAt: now, updated, keywordId: null });
  }

  // Accept as a rule: the proposal *is* a keyword mapping, so create the
  // keyword and let the engine do what it always does — including winning rows
  // from a shorter keyword, and covering merchants that arrive next month.
  const text = String(req.body?.keyword ?? proposal.keyword ?? '').trim();
  if (!text) return res.status(400).json({ error: 'A keyword is required to accept this as a rule.' });

  const existing = db
    .select({ id: keywords.id })
    .from(keywords)
    .where(and(eq(keywords.userId, req.userId), sql`lower(${keywords.text}) = lower(${text})`))
    .get();

  let keywordId;
  if (existing) {
    db.update(keywords)
      .set({ categoryId: pick.categoryId, subcategoryId: pick.subcategoryId })
      .where(eq(keywords.id, existing.id))
      .run();
    keywordId = existing.id;
  } else {
    keywordId = db
      .insert(keywords)
      .values({ userId: req.userId, categoryId: pick.categoryId, subcategoryId: pick.subcategoryId, text })
      .returning()
      .get().id;
  }

  const changed = recomputeUser(req.userId);

  // The engine never touches manual transactions, so a rule alone would leave a
  // hand-entered row of the same merchant uncategorized. Apply the accepted
  // category to the covered manual rows directly — they are the user's own and
  // no recompute will contradict it.
  const ids = coveredTransactionIds(proposal.id);
  let manualUpdated = 0;
  if (ids.length) {
    const manual = db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, req.userId),
          inArray(transactions.id, ids),
          eq(transactions.isManual, true),
          isNull(transactions.categoryId),
        ),
      )
      .all()
      .map((r) => r.id);
    if (manual.length) {
      db.update(transactions)
        .set({ categoryId: pick.categoryId, subcategoryId: pick.subcategoryId })
        .where(inArray(transactions.id, manual))
        .run();
      manualUpdated = manual.length;
    }
  }

  db.update(aiProposals)
    .set({
      status: 'accepted',
      categoryId: pick.categoryId,
      subcategoryId: pick.subcategoryId,
      keyword: text,
      createdKeywordId: keywordId,
      decidedAt: now,
    })
    .where(eq(aiProposals.id, proposal.id))
    .run();

  res.json({ ...proposal, status: 'accepted', ...pick, keyword: text, keywordId, reclassified: changed + manualUpdated, decidedAt: now });
});

aiRouter.post('/proposals/:id/reject', (req, res) => {
  const proposal = ownedProposal(Number(req.params.id), req.userId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });
  if (proposal.status !== PENDING) return res.status(400).json({ error: 'This proposal was already decided.' });

  const now = new Date().toISOString();
  db.update(aiProposals).set({ status: 'rejected', decidedAt: now }).where(eq(aiProposals.id, proposal.id)).run();
  // Deliberately kept, not deleted: the log is what stops this engine paying to
  // reach the same rejected answer again.
  res.json({ ...proposal, status: 'rejected', decidedAt: now });
});
