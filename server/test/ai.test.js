import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { institutions, accounts, categories, subcategories, keywords, transactions, aiProposals } from '../src/db/schema.js';
import { PROVIDERS } from '../src/ai/providers.js';
import { runsInFlight } from '../src/ai/runner.js';
import { groupKeyOf } from '../src/ai/grouping.js';
import { extractJson } from '../src/ai/prompt.js';

let alice;
let bob;
let aliceId;
let bobId;
let accountId;
let groceriesId;
let cornerShopId;

// Every provider call the tests make goes through this stub: a real one costs
// money and needs a network. `calls` is what the runner actually asked for.
const calls = [];
let answer = () => ({ text: '{}', sources: [] });

function stubProvider() {
  PROVIDERS.anthropic.complete = async (args) => {
    calls.push(args);
    return answer(args);
  };
}
const realComplete = PROVIDERS.anthropic.complete;

function insertTxn(userId, description, overrides = {}) {
  return db
    .insert(transactions)
    .values({
      userId,
      accountId,
      date: '2026-02-01',
      description,
      amountCents: -1234,
      currency: 'PLN',
      dedupKey: `${description}|${Math.random()}`,
      ...overrides,
    })
    .returning()
    .get().id;
}

// Runs a batch and waits for the background work, rather than polling the run.
async function runBatch(client, body = {}) {
  const res = await client.post('/api/ai/runs', body);
  if (res.status === 201) await runsInFlight.get(res.body.run.id);
  return res;
}

beforeAll(async () => {
  stubProvider();
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  aliceId = (await createUser(admin, 'aialice', 'password1')).id;
  bobId = (await createUser(admin, 'aibob', 'password1')).id;
  admin.close();

  alice = await startTestClient();
  await alice.post('/api/auth/login', { username: 'aialice', password: 'password1' });
  bob = await startTestClient();
  await bob.post('/api/auth/login', { username: 'aibob', password: 'password1' });

  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Alior' }).returning().get();
  accountId = db
    .insert(accounts)
    .values({ userId: aliceId, institutionId: inst.id, name: 'Current', currency: 'PLN', holder: 'Alice' })
    .returning()
    .get().id;

  groceriesId = db.insert(categories).values({ userId: aliceId, name: 'Groceries' }).returning().get().id;
  cornerShopId = db
    .insert(subcategories)
    .values({ userId: aliceId, categoryId: groceriesId, name: 'Corner shop' })
    .returning()
    .get().id;

  // One merchant across three branch codes, plus a second merchant.
  insertTxn(aliceId, 'MERCURIA SKLEP Z7412 KRAKOW');
  insertTxn(aliceId, 'MERCURIA SKLEP Z8155 KRAKOW');
  insertTxn(aliceId, 'MERCURIA SKLEP Z7412 KRAKOW');
  insertTxn(aliceId, 'VELORIA STORE 4021 WARSZAWA');
});

afterAll(() => {
  PROVIDERS.anthropic.complete = realComplete;
  alice?.close();
  bob?.close();
});

describe('merchant grouping', () => {
  test('branch codes and reference numbers fall out of the group key', () => {
    expect(groupKeyOf('MERCURIA SKLEP Z7412 KRAKOW')).toBe(groupKeyOf('MERCURIA SKLEP Z8155 KRAKOW'));
    expect(groupKeyOf('MERCURIA SKLEP Z7412 KRAKOW')).not.toBe(groupKeyOf('VELORIA STORE 4021 WARSZAWA'));
  });

  test('a description of nothing but digits still groups exact repeats', () => {
    expect(groupKeyOf('123 456')).toBe(groupKeyOf('123 456'));
  });
});

describe('answer parsing', () => {
  test('reads JSON out of a fenced, prefaced answer', () => {
    const parsed = extractJson('Here you go:\n```json\n{"keyword": "zabka", "categoryId": 3}\n```');
    expect(parsed).toEqual({ keyword: 'zabka', categoryId: 3 });
  });

  test('braces inside a string do not end the object early', () => {
    expect(extractJson('{"rationale": "a } brace", "keyword": "x"}').keyword).toBe('x');
  });

  test('an answer with no JSON at all is null', () => {
    expect(extractJson('I could not determine the merchant.')).toBeNull();
  });
});

describe('engines and keys', () => {
  test('an engine with no key is not ready, and a run is refused before it spends anything', async () => {
    const engines = await alice.get('/api/ai/engines');
    expect(engines.status).toBe(200);
    expect(engines.body.find((e) => e.id === 'anthropic').hasKey).toBe(false);
    expect(engines.body.find((e) => e.id === 'deepseek').supportsWebSearch).toBe(false);

    const run = await alice.post('/api/ai/runs', {});
    expect(run.status).toBe(400);
    expect(run.body.error).toMatch(/No Claude .* key saved/);
    expect(calls.length).toBe(0);
  });

  test('a saved key is never served back, only its last four characters', async () => {
    const saved = await alice.put('/api/ai/keys/anthropic', { key: 'sk-ant-secret-value-9876' });
    expect(saved.status).toBe(200);
    expect(saved.body.hint).toBe('••••9876');
    expect(JSON.stringify(saved.body)).not.toContain('secret-value');

    const engines = await alice.get('/api/ai/engines');
    const anthropic = engines.body.find((e) => e.id === 'anthropic');
    expect(anthropic.hasKey).toBe(true);
    expect(JSON.stringify(engines.body)).not.toContain('secret-value');

    const settings = await alice.get('/api/ai/settings');
    expect(settings.body.engine.ready).toBe(true);
    expect(settings.body.engine.model).toBe('claude-opus-5');
  });

  test('switching provider drops a model that belonged to the old one', async () => {
    await alice.put('/api/ai/settings', { provider: 'openai', model: 'gpt-5' });
    const switched = await alice.put('/api/ai/settings', { provider: 'anthropic' });
    expect(switched.body.model).toBe('');
    expect(switched.body.engine.model).toBe('claude-opus-5');
  });
});

describe('a run', () => {
  test('analyzes merchants, not rows, and logs every transaction it covered', async () => {
    calls.length = 0;
    answer = ({ user }) => ({
      text: user.includes('MERCURIA')
        ? JSON.stringify({
            merchant: 'Mercuria',
            keyword: 'mercuria',
            categoryId: groceriesId,
            subcategoryId: cornerShopId,
            confidence: 92,
            rationale: 'A convenience store chain.',
            sources: [{ title: 'Mercuria', url: 'https://mercuria.example' }],
          })
        : JSON.stringify({ merchant: 'Veloria', keyword: 'veloria', categoryId: groceriesId, confidence: 88 }),
      sources: [],
    });

    const plan = await alice.get('/api/ai/plan');
    expect(plan.body.uncategorized).toBe(4);
    expect(plan.body.merchants).toBe(2); // three Żabka rows are one merchant
    expect(plan.body.willAnalyze).toBe(2);

    const res = await runBatch(alice);
    expect(res.status).toBe(201);
    expect(calls.length).toBe(2);
    expect(calls[0].webSearch).toBe(true);

    const run = await alice.get(`/api/ai/runs/${res.body.run.id}`);
    expect(run.body.status).toBe('done');
    expect(run.body.completed).toBe(2);
    expect(run.body.failed).toBe(0);

    const proposals = await alice.get('/api/ai/proposals');
    expect(proposals.body.length).toBe(2);
    const mercuria = proposals.body.find((p) => p.keyword === 'mercuria');
    expect(mercuria.txCount).toBe(3);
    expect(mercuria.coveredCount).toBe(3);
    expect(mercuria.categoryName).toBe('Groceries');
    expect(mercuria.subcategoryName).toBe('Corner shop');
    expect(mercuria.confidence).toBe(92);
    expect(mercuria.sources[0].url).toBe('https://mercuria.example');
  });

  test('the same engine never analyzes the same merchant twice', async () => {
    const plan = await alice.get('/api/ai/plan');
    expect(plan.body.alreadyAnalyzed).toBe(2);
    expect(plan.body.eligible).toBe(0);

    calls.length = 0;
    const res = await alice.post('/api/ai/runs', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been analyzed/);
    expect(calls.length).toBe(0);
  });

  test('a different engine may look again', async () => {
    await alice.put('/api/ai/settings', { provider: 'anthropic', model: 'claude-haiku-4-5' });
    const plan = await alice.get('/api/ai/plan');
    expect(plan.body.eligible).toBe(2);
    expect(plan.body.alreadyAnalyzed).toBe(0);
    await alice.put('/api/ai/settings', { provider: 'anthropic', model: '' });
  });

  test('a model that invents a source when it did not search has it dropped', async () => {
    // Observed live: Gemini with the web lookup off still returned a Wikipedia
    // URL, and the article does not exist. A fabricated citation is worse than
    // none — it looks like evidence.
    await alice.put('/api/ai/settings', { provider: 'anthropic', model: 'claude-haiku-4-5', webSearch: false });
    insertTxn(aliceId, 'UNGROUNDED MERCHANT AB');
    answer = () => ({
      text: JSON.stringify({
        keyword: 'ungrounded merchant',
        categoryId: groceriesId,
        sources: [{ title: 'Invented', url: 'https://en.wikipedia.org/wiki/does-not-exist' }],
      }),
      sources: [],
    });
    await runBatch(alice, { limit: 1 });

    const proposals = await alice.get('/api/ai/proposals');
    const ungrounded = proposals.body.find((p) => p.keyword === 'ungrounded merchant');
    expect(ungrounded.webSearch).toBe(false);
    expect(ungrounded.sources).toEqual([]);

    await alice.put('/api/ai/settings', { provider: 'anthropic', model: '', webSearch: true });
  });

  test('when a search did run, the provider grounding metadata outranks the model\'s own list', async () => {
    insertTxn(aliceId, 'GROUNDED MERCHANT CD');
    answer = () => ({
      text: JSON.stringify({
        keyword: 'grounded merchant',
        categoryId: groceriesId,
        sources: [{ title: 'Model retelling', url: 'https://model.example' }],
      }),
      sources: [{ title: 'What the tool actually fetched', url: 'https://provider.example' }],
    });
    await runBatch(alice, { limit: 1 });

    const proposals = await alice.get('/api/ai/proposals');
    const grounded = proposals.body.find((p) => p.keyword === 'grounded merchant');
    expect(grounded.sources).toEqual([{ title: 'What the tool actually fetched', url: 'https://provider.example' }]);
  });

  test('a merchant the engine cannot place is still logged, without a category', async () => {
    insertTxn(aliceId, 'PMT REF 88213 XYZCORP');
    answer = () => ({ text: JSON.stringify({ merchant: null, keyword: 'xyzcorp', categoryId: null, rationale: 'No idea.' }), sources: [] });

    const res = await runBatch(alice, { limit: 1 });
    expect(res.status).toBe(201);
    const pending = await alice.get('/api/ai/proposals');
    const unplaced = pending.body.find((p) => p.keyword === 'xyzcorp');
    expect(unplaced.categoryId).toBeNull();
    expect(unplaced.status).toBe('pending');
  });

  test('a provider failure fails one merchant, not the run, and leaves it eligible', async () => {
    insertTxn(aliceId, 'SOME NEW MERCHANT LTD');
    answer = () => {
      throw new Error('429 rate limited');
    };
    const res = await runBatch(alice, { limit: 1 });
    expect(res.status).toBe(201);
    const run = await alice.get(`/api/ai/runs/${res.body.run.id}`);
    expect(run.body.failed).toBe(1);
    expect(run.body.error).toMatch(/rate limited/);

    // Nothing was logged for it, so it comes back next time.
    const plan = await alice.get('/api/ai/plan');
    expect(plan.body.next.some((n) => n.description === 'SOME NEW MERCHANT LTD')).toBe(true);
  });

  test('an engine that invents a category has it dropped', async () => {
    insertTxn(aliceId, 'INVENTED MERCHANT SA');
    answer = () => ({ text: JSON.stringify({ keyword: 'invented merchant', categoryId: 999999, subcategoryId: 424242 }), sources: [] });
    await runBatch(alice, { limit: 1 });
    const proposals = await alice.get('/api/ai/proposals');
    const made_up = proposals.body.find((p) => p.keyword === 'invented merchant');
    expect(made_up.categoryId).toBeNull();
    expect(made_up.subcategoryId).toBeNull();
  });
});

describe('accepting and rejecting', () => {
  test('accepting as a rule creates the keyword and classifies every matching row', async () => {
    const proposals = await alice.get('/api/ai/proposals');
    const mercuria = proposals.body.find((p) => p.keyword === 'mercuria');

    const res = await alice.post(`/api/ai/proposals/${mercuria.id}/accept`, { mode: 'rule' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');

    const kw = db.select().from(keywords).where(eq(keywords.id, res.body.keywordId)).get();
    expect(kw.text).toBe('mercuria');
    expect(kw.categoryId).toBe(groceriesId);
    expect(kw.subcategoryId).toBe(cornerShopId);

    const rows = db.select().from(transactions).where(eq(transactions.userId, aliceId)).all();
    const mercuriaRows = rows.filter((r) => r.description.startsWith('MERCURIA'));
    expect(mercuriaRows.length).toBe(3);
    expect(mercuriaRows.every((r) => r.categoryId === groceriesId && r.subcategoryId === cornerShopId)).toBe(true);
    // Engine-assigned, not locked — a later rule change is still free to win it.
    expect(mercuriaRows.every((r) => !r.isLocked && r.matchedKeywordId === kw.id)).toBe(true);
  });

  test('a decided proposal cannot be decided again', async () => {
    const decided = await alice.get('/api/ai/proposals?status=decided');
    const mercuria = decided.body.find((p) => p.keyword === 'mercuria');
    const again = await alice.post(`/api/ai/proposals/${mercuria.id}/accept`, { mode: 'rule' });
    expect(again.status).toBe(400);
  });

  test('accepting once categorizes the covered rows and locks them, without a rule', async () => {
    const before = db.select().from(keywords).where(eq(keywords.userId, aliceId)).all().length;
    const proposals = await alice.get('/api/ai/proposals');
    const veloria = proposals.body.find((p) => p.keyword === 'veloria');

    const res = await alice.post(`/api/ai/proposals/${veloria.id}/accept`, { mode: 'once' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted_once');
    expect(res.body.updated).toBe(1);
    expect(db.select().from(keywords).where(eq(keywords.userId, aliceId)).all().length).toBe(before);

    const row = db.select().from(transactions).where(eq(transactions.userId, aliceId)).all()
      .find((r) => r.description.startsWith('VELORIA'));
    expect(row.categoryId).toBe(groceriesId);
    expect(row.isLocked).toBe(true);
  });

  test('a category chosen in the panel overrides the one the engine proposed', async () => {
    const other = db.insert(categories).values({ userId: aliceId, name: 'Unplaced' }).returning().get().id;
    const proposals = await alice.get('/api/ai/proposals');
    const unplaced = proposals.body.find((p) => p.keyword === 'xyzcorp');

    const res = await alice.post(`/api/ai/proposals/${unplaced.id}/accept`, { mode: 'once', categoryId: other });
    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBe(other);
  });

  test('rejecting keeps the log, so the same engine does not pay for it again', async () => {
    const proposals = await alice.get('/api/ai/proposals');
    const target = proposals.body[0];
    const res = await alice.post(`/api/ai/proposals/${target.id}/reject`, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');

    const still = db.select().from(aiProposals).where(eq(aiProposals.id, target.id)).get();
    expect(still.status).toBe('rejected');
    const plan = await alice.get('/api/ai/plan');
    expect(plan.body.next.some((n) => n.description === target.sampleDescription)).toBe(false);
  });
});

describe('isolation', () => {
  test("a user sees neither another user's proposals nor their keys", async () => {
    expect((await bob.get('/api/ai/proposals')).body).toEqual([]);
    expect((await bob.get('/api/ai/engines')).body.find((e) => e.id === 'anthropic').hasKey).toBe(false);

    const alicesProposal = db.select().from(aiProposals).where(eq(aiProposals.userId, aliceId)).all()[0];
    expect((await bob.post(`/api/ai/proposals/${alicesProposal.id}/reject`, {})).status).toBe(404);
    expect((await bob.get('/api/ai/plan')).body.uncategorized).toBe(0);
  });

  test('the routes are behind a session', async () => {
    const anon = await startTestClient();
    expect((await anon.get('/api/ai/proposals')).status).toBe(401);
    expect((await anon.post('/api/ai/runs', {})).status).toBe(401);
    anon.close();
  });
});

describe('the encryption key', () => {
  test('a hand-edited key file does not break saving a provider key', async () => {
    // The file is the one thing here a person is likely to open and edit, and
    // the forms it comes back in are not always 32 hex bytes: a passphrase, a
    // quoted value, or a whole `NAME=value` line pasted from an env file. The
    // module caches the derived key on first use, so each form needs a fresh
    // import — otherwise this passes by re-using the first key and proves
    // nothing.
    for (const written of ['BEXT_AI_KEY_SECRET=a-passphrase-someone-typed', '"quoted-passphrase"', 'a'.repeat(64)]) {
      vi.resetModules();
      process.env.BEXT_AI_KEY_SECRET = written;
      const { encryptSecret, decryptSecret } = await import('../src/ai/crypto.js');
      const sealed = encryptSecret('sk-provider-key-0001');
      expect(sealed).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
      expect(decryptSecret(sealed)).toBe('sk-provider-key-0001');
    }
    delete process.env.BEXT_AI_KEY_SECRET;
    vi.resetModules();
  });

  test('the env value and the same value written as a NAME=line agree on the key', async () => {
    // The two sources must derive the same key, or moving a secret from the
    // file into the environment would silently orphan every saved provider key.
    vi.resetModules();
    process.env.BEXT_AI_KEY_SECRET = 'shared-secret-value';
    const bare = await import('../src/ai/crypto.js');
    const sealed = bare.encryptSecret('sk-provider-key-0002');

    vi.resetModules();
    process.env.BEXT_AI_KEY_SECRET = 'BEXT_AI_KEY_SECRET=shared-secret-value';
    const assigned = await import('../src/ai/crypto.js');
    expect(assigned.decryptSecret(sealed)).toBe('sk-provider-key-0002');

    // And a different secret must not open it — otherwise the derivation is
    // throwing the value away.
    vi.resetModules();
    process.env.BEXT_AI_KEY_SECRET = 'a-completely-different-secret';
    const other = await import('../src/ai/crypto.js');
    expect(other.decryptSecret(sealed)).toBeNull();

    delete process.env.BEXT_AI_KEY_SECRET;
    vi.resetModules();
  });
});
