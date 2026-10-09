<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { navigate } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';
  import CategorySelect from '$lib/components/ui/CategorySelect.svelte';

  // AI review — the transaction list, turned into a review queue.
  //
  // The page works in *merchants*, not rows: the AI proposes a keyword rule, and
  // a rule is about a merchant, so one proposal carries the whole group of
  // transactions it would classify. The rail holds what narrows a run (engine,
  // filters, how many), the window holds the proposals, and each proposal opens
  // into the rationale, what the engine read on the web, and the ledger rows it
  // would categorize.
  //
  // Nothing here runs an engine by itself: a run costs money, so it starts on a
  // button, says up front how many merchants it will look at, and can be
  // stopped.

  let engine = $state(null);
  let plan = $state(null);
  let proposals = $state([]);
  let decided = $state([]);
  let accountsList = $state([]);
  let categories = $state([]);
  let run = $state(null);

  let tab = $state('pending'); // 'pending' | 'decided'
  let accountId = $state('');
  let from = $state('');
  let to = $state('');
  let limit = $state(25);
  let loading = $state(true);
  let starting = $state(false);
  let error = $state('');
  let notice = $state('');

  let expanded = $state(new Set());
  let editingCat = $state(null); // proposal id whose category picker is open
  let drafts = $state({}); // proposal id → { categoryId, subcategoryId, keyword }
  let selected = $state([]); // proposal ids checked for a bulk decision
  let busyIds = $state([]);

  let pollTimer = null;

  const filters = $derived({ accountId: accountId || null, from: from || null, to: to || null });
  const running = $derived(run?.status === 'running');
  const pending = $derived(proposals);

  function draftOf(p) {
    return drafts[p.id] ?? { categoryId: p.categoryId ?? '', subcategoryId: p.subcategoryId ?? '', keyword: p.keyword };
  }
  function setDraft(p, patch) {
    drafts = { ...drafts, [p.id]: { ...draftOf(p), ...patch } };
  }

  function query() {
    const q = new URLSearchParams();
    if (accountId) q.set('accountId', accountId);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    q.set('limit', String(limit || 0));
    return q.toString();
  }

  async function loadPlan() {
    plan = await api(`/ai/plan?${query()}`);
    engine = plan.engine;
  }

  async function loadProposals() {
    [proposals, decided] = await Promise.all([api('/ai/proposals?status=pending'), api('/ai/proposals?status=decided')]);
  }

  async function loadAll() {
    error = '';
    try {
      const [, , accts, cats, runs] = await Promise.all([
        loadPlan(),
        loadProposals(),
        api('/accounts'),
        api('/categories'),
        api('/ai/runs'),
      ]);
      accountsList = accts;
      categories = cats;
      run = runs[0] ?? null;
      if (run?.status === 'running') startPolling();
      if (engine) limit = engine.batchSize;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load the AI review page.';
    } finally {
      loading = false;
    }
  }

  onMount(loadAll);
  onDestroy(() => clearInterval(pollTimer));

  // While a run works, the page follows it: the progress line is the run row
  // itself, so a reload mid-run picks it back up.
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const next = await api(`/ai/runs/${run.id}`);
        const advanced = next.completed !== run.completed;
        run = next;
        if (advanced) await loadProposals();
        if (next.status !== 'running') {
          clearInterval(pollTimer);
          await Promise.all([loadProposals(), loadPlan()]);
        }
      } catch {
        clearInterval(pollTimer);
      }
    }, 2500);
  }

  async function startRun() {
    error = '';
    notice = '';
    starting = true;
    try {
      const res = await api('/ai/runs', { method: 'POST', body: { filters, limit: Number(limit) } });
      run = res.run;
      startPolling();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not start the run.';
    } finally {
      starting = false;
    }
  }

  async function cancelRun() {
    if (!run) return;
    try {
      run = await api(`/ai/runs/${run.id}/cancel`, { method: 'POST', body: {} });
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not cancel the run.';
    }
  }

  async function decide(p, action, mode) {
    busyIds = [...busyIds, p.id];
    error = '';
    try {
      const draft = draftOf(p);
      const body =
        action === 'accept'
          ? { mode, categoryId: draft.categoryId || null, subcategoryId: draft.subcategoryId || null, keyword: draft.keyword }
          : {};
      const res = await api(`/ai/proposals/${p.id}/${action}`, { method: 'POST', body });
      if (action === 'accept' && mode === 'rule') {
        notice = `Keyword "${res.keyword}" created — ${res.reclassified} transaction${res.reclassified === 1 ? '' : 's'} reclassified.`;
      } else if (action === 'accept') {
        notice = `${res.updated} transaction${res.updated === 1 ? '' : 's'} categorized.`;
      } else {
        notice = '';
      }
      selected = selected.filter((id) => id !== p.id);
      await Promise.all([loadProposals(), loadPlan()]);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not record that decision.';
    } finally {
      busyIds = busyIds.filter((id) => id !== p.id);
    }
  }

  // Bulk decisions run one at a time on purpose: accepting a rule triggers a
  // full reclassification, and firing ten of those at once would have them
  // racing over the same rows.
  async function decideSelected(action, mode) {
    const targets = pending.filter((p) => selected.includes(p.id));
    for (const p of targets) {
      if (action === 'accept' && !draftOf(p).categoryId) continue; // nothing to accept it into
      await decide(p, action, mode);
    }
    notice = `${targets.length} proposal${targets.length === 1 ? '' : 's'} ${action === 'accept' ? 'accepted' : 'rejected'}.`;
  }

  function toggleSelected(id) {
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
  }
  function toggleExpanded(id) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function money(cents, currency) {
    const v = (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency ? `${v} ${currency}` : v;
  }

  const catById = $derived(new Map(categories.map((c) => [c.id, c])));
  const subById = $derived(
    new Map(categories.flatMap((c) => c.subcategories.map((s) => [s.id, { ...s, categoryId: c.id }]))),
  );

  const confidenceTone = (n) =>
    n == null ? 'text-muted-foreground' : n >= 80 ? 'text-success' : n >= 55 ? 'text-warning-foreground' : 'text-destructive';

  // date · description · account · amount — the transaction list's own row, so a
  // covered transaction reads the same here as it does there.
  const TX_GRID = 'grid-template-columns: 5.5rem minmax(0,1fr) 7rem 7rem;';
</script>

<div>
  <div class="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="flex items-center gap-2 text-xl font-semibold"><Icon name="sparkles" size={18} /> AI review</h2>
      <p class="text-sm text-muted-foreground">
        An engine reads the merchants you have not categorized, looks them up, and proposes a keyword rule for each. You
        decide what lands.
      </p>
    </div>
    <div class="flex gap-1 rounded-md border border-input p-1 text-sm">
      <button
        class={'rounded px-3 py-1 font-medium transition ' + (tab === 'pending' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
        onclick={() => (tab = 'pending')}
      >
        To review {pending.length ? `(${pending.length})` : ''}
      </button>
      <button
        class={'rounded px-3 py-1 font-medium transition ' + (tab === 'decided' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
        onclick={() => (tab = 'decided')}
      >
        Decided {decided.length ? `(${decided.length})` : ''}
      </button>
    </div>
  </div>

  <div class="grid gap-6 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
    <!-- Rail: the engine, what a run would cost, and what narrows it -->
    <div class="flex flex-col gap-4 lg:sticky lg:top-4">
      <Card class="p-4">
        <div class="mb-3 flex items-center justify-between gap-2">
          <span class="text-sm font-semibold">Engine</span>
          <button class="text-xs text-primary underline" onclick={() => navigate('/settings')}>Change</button>
        </div>
        {#if engine}
          <p class="text-sm">{engine.label ?? '—'}</p>
          <p class="text-xs text-muted-foreground">
            {engine.model} · web lookup {engine.webSearch ? 'on' : 'off'}
          </p>
          {#if !engine.ready}
            <p class="mt-2 rounded-md border border-warning-border bg-warning px-2 py-1.5 text-xs text-warning-foreground">
              {engine.reason}
            </p>
          {/if}
        {/if}
      </Card>

      <Card class="p-4">
        <span class="mb-3 block text-sm font-semibold">Run</span>

        {#if plan}
          <dl class="mb-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt class="text-muted-foreground">Uncategorized</dt>
            <dd class="text-right tabular-nums">{plan.uncategorized}</dd>
            <dt class="text-muted-foreground">Merchants</dt>
            <dd class="text-right tabular-nums">{plan.merchants}</dd>
            <dt class="text-muted-foreground" title="Already analyzed by this engine — a different engine may look again">
              Already analyzed
            </dt>
            <dd class="text-right tabular-nums">{plan.alreadyAnalyzed}</dd>
            <dt class="font-medium">Would analyze</dt>
            <dd class="text-right font-medium tabular-nums">{plan.willAnalyze}</dd>
          </dl>
        {/if}

        <div class="mb-3 flex flex-col gap-1.5">
          <Label for="ai-limit">Merchants this run</Label>
          <Input id="ai-limit" type="number" min="1" max="200" bind:value={limit} onchange={loadPlan} />
        </div>

        {#if running}
          <div class="mb-2">
            <div class="mb-1 flex items-center justify-between text-xs">
              <span>Analyzing…</span>
              <span class="tabular-nums">{run.completed + run.failed} / {run.requested}</span>
            </div>
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                class="h-full bg-primary transition-all"
                style="width: {run.requested ? ((run.completed + run.failed) / run.requested) * 100 : 0}%"
              ></div>
            </div>
          </div>
          <Button variant="outline" class="w-full" onclick={cancelRun}>Stop after the current merchant</Button>
        {:else}
          <Button class="w-full" onclick={startRun} disabled={starting || !engine?.ready || !plan?.willAnalyze}>
            {starting ? 'Starting…' : `Analyze ${plan?.willAnalyze ?? 0} merchant${plan?.willAnalyze === 1 ? '' : 's'}`}
          </Button>
          {#if plan && !plan.willAnalyze && plan.merchants}
            <p class="mt-2 text-xs text-muted-foreground">
              This engine has answered every uncategorized merchant here. Switch model or provider in settings for a
              second opinion.
            </p>
          {/if}
        {/if}

        {#if run && !running && run.failed}
          <p class="mt-2 text-xs text-destructive">
            {run.failed} merchant{run.failed === 1 ? '' : 's'} failed — {run.error}
          </p>
        {/if}
      </Card>

      <Card class="p-4">
        <span class="mb-3 block text-sm font-semibold">Narrow it</span>
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1.5">
            <Label for="ai-account">Account</Label>
            <select
              id="ai-account"
              bind:value={accountId}
              onchange={loadPlan}
              class="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            >
              <option value="">All accounts</option>
              {#each accountsList as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
            </select>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div class="flex flex-col gap-1.5">
              <Label for="ai-from">From</Label>
              <Input id="ai-from" type="date" bind:value={from} onchange={loadPlan} />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="ai-to">To</Label>
              <Input id="ai-to" type="date" bind:value={to} onchange={loadPlan} />
            </div>
          </div>
        </div>
      </Card>

      {#if plan?.next?.length && !running}
        <Card class="p-4">
          <span class="mb-2 block text-sm font-semibold">Next in line</span>
          <ul class="flex flex-col gap-1 text-xs text-muted-foreground">
            {#each plan.next.slice(0, 6) as n (n.description)}
              <li class="flex items-baseline justify-between gap-2">
                <span class="min-w-0 truncate" title={n.description}>{n.description}</span>
                <span class="shrink-0 tabular-nums">{n.txCount}</span>
              </li>
            {/each}
          </ul>
        </Card>
      {/if}
    </div>

    <!-- The proposals -->
    <div class="min-w-0">
      {#if error}<p class="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>{/if}
      {#if notice}<p class="mb-3 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{notice}</p>{/if}

      {#if loading}
        <p class="text-sm text-muted-foreground">Loading…</p>
      {:else if tab === 'pending'}
        {#if selected.length}
          <div class="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <span class="font-medium">{selected.length} selected</span>
            <div class="ml-auto flex flex-wrap gap-2">
              <Button variant="outline" onclick={() => decideSelected('accept', 'rule')}>Accept as rules</Button>
              <Button variant="ghost" onclick={() => decideSelected('reject')}>Reject</Button>
              <Button variant="ghost" onclick={() => (selected = [])}>Clear</Button>
            </div>
          </div>
        {/if}

        {#if !pending.length}
          <Card class="p-8 text-center">
            <p class="text-sm font-medium">Nothing waiting for review.</p>
            <p class="mt-1 text-sm text-muted-foreground">
              {#if plan?.willAnalyze}
                Run the engine from the rail — {plan.willAnalyze} merchant{plan.willAnalyze === 1 ? '' : 's'} are waiting.
              {:else if plan?.uncategorized === 0}
                Every transaction is categorized. There is nothing for the AI to look at.
              {:else}
                Every uncategorized merchant here has been through this engine already.
              {/if}
            </p>
          </Card>
        {:else}
          <div class="flex flex-col gap-2">
            {#each pending as p (p.id)}
              {@const draft = draftOf(p)}
              {@const cat = draft.categoryId ? catById.get(Number(draft.categoryId)) : null}
              {@const sub = draft.subcategoryId ? subById.get(Number(draft.subcategoryId)) : null}
              <Card class="overflow-visible p-0">
                <div class="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <input
                    type="checkbox"
                    class="h-3.5 w-3.5 shrink-0"
                    checked={selected.includes(p.id)}
                    onchange={() => toggleSelected(p.id)}
                    aria-label="Select proposal"
                  />

                  <!-- The merchant: what the statement says, and what the engine says it is -->
                  <div class="min-w-0 flex-1 basis-56">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <span class="truncate text-sm font-medium" title={p.sampleDescription}>{p.merchant ?? p.sampleDescription}</span>
                      <span class="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                        {p.txCount} tx
                      </span>
                      {#if !p.webSearch}
                        <span class="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground" title="Proposed without a web lookup">
                          no web
                        </span>
                      {/if}
                    </div>
                    <p class="truncate text-xs text-muted-foreground" title={p.sampleDescription}>{p.sampleDescription}</p>
                  </div>

                  <!-- The rule it proposes -->
                  <div class="flex min-w-0 basis-44 items-center gap-1.5">
                    <Icon name="key" size={12} class="shrink-0 text-muted-foreground" />
                    <Input
                      class="h-7 py-1 text-xs"
                      value={draft.keyword}
                      oninput={(e) => setDraft(p, { keyword: e.currentTarget.value })}
                      aria-label="Proposed keyword"
                    />
                  </div>

                  <!-- The category, editable before it lands -->
                  <div class="relative min-w-0 basis-52">
                    {#if editingCat === p.id}
                      <div class="absolute left-0 top-1/2 z-30 w-72 -translate-y-1/2">
                        <CategorySelect
                          {categories}
                          categoryId={draft.categoryId}
                          subcategoryId={draft.subcategoryId}
                          allowNone
                          autoOpen
                          placeholder="Choose a category"
                          onChange={(v) => setDraft(p, { categoryId: v.categoryId, subcategoryId: v.subcategoryId })}
                          onClose={() => (editingCat = null)}
                        />
                      </div>
                    {:else}
                      <button
                        class="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                        onclick={() => (editingCat = p.id)}
                        title="Click to change the category before accepting"
                      >
                        {#if cat}
                          <CategoryIcon name={cat.icon} categoryId={cat.id} size={13} class="shrink-0" />
                          <span class="truncate">{cat.name}{sub ? ` › ${sub.name}` : ''}</span>
                        {:else}
                          <span class="truncate text-destructive">No category — pick one</span>
                        {/if}
                      </button>
                    {/if}
                  </div>

                  <span class={'shrink-0 text-xs tabular-nums ' + confidenceTone(p.confidence)} title="How sure the engine is">
                    {p.confidence == null ? '—' : `${p.confidence}%`}
                  </span>

                  <div class="ml-auto flex shrink-0 items-center gap-1.5">
                    <Button
                      class="px-2.5 py-1 text-xs"
                      disabled={busyIds.includes(p.id) || !draft.categoryId || !draft.keyword.trim()}
                      onclick={() => decide(p, 'accept', 'rule')}
                      title="Create the keyword rule — every matching transaction, now and later"
                    >
                      Accept rule
                    </Button>
                    <Button
                      variant="outline"
                      class="px-2.5 py-1 text-xs"
                      disabled={busyIds.includes(p.id) || !draft.categoryId}
                      onclick={() => decide(p, 'accept', 'once')}
                      title="Categorize just these transactions, without creating a rule"
                    >
                      Just these
                    </Button>
                    <Button
                      variant="ghost"
                      class="px-2.5 py-1 text-xs"
                      disabled={busyIds.includes(p.id)}
                      onclick={() => decide(p, 'reject')}
                    >
                      Reject
                    </Button>
                    <button
                      class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      onclick={() => toggleExpanded(p.id)}
                      aria-label={expanded.has(p.id) ? 'Hide details' : 'Show details'}
                      aria-expanded={expanded.has(p.id)}
                    >
                      <Icon name="chevron-down" size={14} class={expanded.has(p.id) ? 'rotate-180 transition-transform' : 'transition-transform'} />
                    </button>
                  </div>
                </div>

                {#if expanded.has(p.id)}
                  <div class="border-t border-border px-3 py-3">
                    {#if p.rationale}
                      <p class="mb-2 text-xs text-muted-foreground">{p.rationale}</p>
                    {/if}
                    {#if p.sources?.length}
                      <ul class="mb-3 flex flex-wrap gap-1.5">
                        {#each p.sources as s (s.url)}
                          <li>
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              class="inline-flex max-w-[18rem] items-center gap-1 truncate rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                              title={s.url}
                            >
                              <Icon name="search" size={10} />{s.title}
                            </a>
                          </li>
                        {/each}
                      </ul>
                    {:else}
                      <p class="mb-3 text-[11px] text-muted-foreground">
                        No web sources — this proposal came from the description alone.
                      </p>
                    {/if}

                    <p class="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                      {p.coveredCount} transaction{p.coveredCount === 1 ? '' : 's'} · {p.stillUncategorized} still uncategorized
                    </p>
                    <div class="rounded-md border border-border">
                      {#each p.transactions as tx (tx.id)}
                        <div class="grid items-center gap-3 px-3 py-1.5 text-xs odd:bg-muted/40" style={TX_GRID}>
                          <span class="tabular-nums text-muted-foreground">{tx.date}</span>
                          <span class="truncate" title={tx.description}>{tx.description}</span>
                          <span class="truncate text-muted-foreground">{tx.accountName}</span>
                          <span class={'text-right tabular-nums ' + (tx.amountCents < 0 ? '' : 'text-success')}>
                            {money(tx.amountCents, tx.currency)}
                          </span>
                        </div>
                      {/each}
                      {#if p.coveredCount > p.transactions.length}
                        <p class="px-3 py-1.5 text-[11px] text-muted-foreground">
                          …and {p.coveredCount - p.transactions.length} more.
                        </p>
                      {/if}
                    </div>
                  </div>
                {/if}
              </Card>
            {/each}
          </div>
        {/if}
      {:else}
        <!-- The log: what has been proposed, by which engine, and what you did -->
        {#if !decided.length}
          <Card class="p-8 text-center text-sm text-muted-foreground">Nothing decided yet.</Card>
        {:else}
          <Card class="p-0">
            <div class="grid items-center gap-3 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground" style="grid-template-columns: minmax(0,1fr) 9rem 10rem 8rem 6rem;">
              <span>Merchant</span>
              <span>Keyword</span>
              <span>Category</span>
              <span>Engine</span>
              <span class="text-right">Outcome</span>
            </div>
            {#each decided as p (p.id)}
              <div class="grid items-center gap-3 border-t border-border px-3 py-2 text-xs" style="grid-template-columns: minmax(0,1fr) 9rem 10rem 8rem 6rem;">
                <span class="min-w-0 truncate" title={p.sampleDescription}>{p.merchant ?? p.sampleDescription}</span>
                <span class="truncate text-muted-foreground">{p.keyword}</span>
                <span class="truncate text-muted-foreground">
                  {p.categoryName ?? '—'}{p.subcategoryName ? ` › ${p.subcategoryName}` : ''}
                </span>
                <span class="truncate text-muted-foreground" title={p.engineKey}>{p.model}</span>
                <span class="text-right">
                  <span
                    class={'rounded-full px-2 py-0.5 text-[10px] ' +
                      (p.status === 'rejected' ? 'bg-muted text-muted-foreground' : 'bg-success/15 text-success')}
                  >
                    {p.status === 'accepted' ? 'rule' : p.status === 'accepted_once' ? 'once' : 'rejected'}
                  </span>
                </span>
              </div>
            {/each}
          </Card>
        {/if}
      {/if}
    </div>
  </div>
</div>
