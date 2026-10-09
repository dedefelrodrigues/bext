<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { navigate } from '$lib/router.svelte.js';
  import { formatMoney, monthLabel } from '$lib/charts.js';
  import Card from '$lib/components/ui/Card.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import CategorySelect from '$lib/components/ui/CategorySelect.svelte';
  import LineChart from '$lib/components/charts/LineChart.svelte';
  import EvidenceRows from '$lib/components/health/EvidenceRows.svelte';

  // Transfers between your own accounts: which legs pair up, which go to an
  // account you do not import (off-book: an exchange wallet, a broker, a
  // deposit, a loan), and which have no other side at all — money that left or
  // entered the household filed as a "transfer". Pairing links rows; it never
  // changes a category.

  const KINDS = [
    { id: 'exchange', label: 'Exchange wallet', hint: 'Money passes through; the balance should hover near zero.' },
    { id: 'savings', label: 'Savings / investments', hint: 'Money parked there; the balance is what you hold.' },
    { id: 'loan', label: 'Loan', hint: 'Money lent; the balance is what is owed to you.' },
    { id: 'other', label: 'Other', hint: 'An account of yours you do not import.' },
  ];
  const kindOf = (id) => KINDS.find((k) => k.id === id) ?? KINDS[3];

  let v = $state(null);
  let categories = $state([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let notice = $state('');
  let showAcknowledged = $state(false);

  // group key -> ticked row ids (a move acts on these)
  let selections = $state({});

  async function load() {
    refreshing = true;
    error = '';
    try {
      v = await api('/transfers');
      const next = {};
      for (const g of v.unmatched) next[g.key] = [...g.transactionIds];
      selections = next;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not reconcile the transfers.';
    } finally {
      refreshing = false;
      loading = false;
    }
  }
  onMount(async () => {
    try {
      categories = await api('/categories');
    } catch {
      categories = [];
    }
    await load();
  });

  const groups = $derived((v?.unmatched ?? []).filter((g) => showAcknowledged || !g.acknowledged));
  const cur = $derived(v?.currency ?? '');

  // --- Acting on an unmatched group ------------------------------------------------
  // active: { key, mode: 'declare' | 'move', target: 'new' | offbookId, name, kind, patterns, categoryId, subcategoryId }
  let active = $state(null);
  let working = $state(false);

  function startDeclare(g) {
    notice = '';
    active = {
      key: g.key,
      mode: 'declare',
      target: 'new',
      name: g.suggestion.name,
      kind: g.suggestion.kind,
      patterns: g.suggestion.patterns.join('\n'),
    };
  }
  function startMove(g) {
    notice = '';
    active = { key: g.key, mode: 'move', categoryId: '', subcategoryId: '' };
  }

  async function run(fn, done) {
    working = true;
    error = '';
    try {
      await fn();
      notice = done;
      active = null;
      await load();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not save.';
    } finally {
      working = false;
    }
  }

  function applyDeclare() {
    const a = active;
    const patterns = a.patterns.split('\n').map((p) => p.trim()).filter(Boolean);
    if (a.target === 'new') {
      return run(() => api('/transfers/offbook', { method: 'POST', body: { name: a.name, kind: a.kind, patterns } }), `Declared “${a.name}”.`);
    }
    const ob = v.offbook.find((o) => o.id === Number(a.target));
    return run(
      () => api(`/transfers/offbook/${ob.id}`, { method: 'PATCH', body: { patterns: [...ob.patterns, ...patterns] } }),
      `Added to “${ob.name}”.`,
    );
  }
  function applyMove(g) {
    const ids = selections[g.key] ?? [];
    if (!ids.length) return (error = 'Tick at least one row.');
    if (!active.categoryId) return (error = 'Pick a category.');
    return run(
      () =>
        api('/transactions/bulk-categorize', {
          method: 'POST',
          body: { transactionIds: ids, categoryId: Number(active.categoryId), subcategoryId: active.subcategoryId ? Number(active.subcategoryId) : null },
        }),
      `Moved ${ids.length} row${ids.length === 1 ? '' : 's'}.`,
    );
  }
  const acknowledge = (g) => run(() => api('/data-health/dismiss', { method: 'POST', body: { key: g.ackKey, fingerprint: g.ackFingerprint } }), 'Marked as fine.');
  const unacknowledge = (g) => run(() => api('/data-health/restore', { method: 'POST', body: { key: g.ackKey } }), 'Shown again.');

  // --- Off-book accounts ---------------------------------------------------------
  let editing = $state(null); // { id, name, kind, patterns }
  let openRows = $state(new Set());
  const toggleRows = (id) => {
    const n = new Set(openRows);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    openRows = n;
  };
  const startEdit = (ob) => (editing = { id: ob.id, name: ob.name, kind: ob.kind, patterns: ob.patterns.join('\n') });
  const saveEdit = () =>
    run(
      () =>
        api(`/transfers/offbook/${editing.id}`, {
          method: 'PATCH',
          body: { name: editing.name, kind: editing.kind, patterns: editing.patterns.split('\n').map((p) => p.trim()).filter(Boolean) },
        }).then(() => (editing = null)),
      'Saved.',
    );
  let confirmDelete = $state(null);
  const deleteOffbook = (ob) => run(() => api(`/transfers/offbook/${ob.id}`, { method: 'DELETE' }).then(() => (confirmDelete = null)), `Deleted “${ob.name}”; its rows are unmatched again.`);

  function balanceNote(ob) {
    if (ob.kind === 'exchange') {
      const share = ob.throughputCents ? Math.abs(ob.balanceCents) / ob.throughputCents : 0;
      const through = formatMoney(ob.throughputCents, cur, { compact: true });
      return share > 0.05
        ? `An exchange wallet should hover near zero; this is ${Math.round(share * 100)}% of the ${through} that passed through — money waiting there, or a leg not claimed yet.`
        : `Near zero against the ${through} that passed through (${(share * 100).toFixed(1)}%) — the gap is the bank's rate against the rate table.`;
    }
    if (ob.kind === 'savings') return 'What went in and has not come back: what you hold there, before gains or losses.';
    if (ob.kind === 'loan') return ob.balanceCents > 0 ? 'Still owed to you.' : 'Repaid.';
    return '';
  }

  // --- Pairs -------------------------------------------------------------------
  const decide = (p, status) =>
    run(
      () => api('/transfers/decisions', { method: 'POST', body: { outId: p.out.id, inId: p.in.id, status } }),
      status === 'confirmed' ? 'Pair confirmed.' : 'They will not be paired again.',
    );

  // Pairs grouped by route (from account → to account), biggest first.
  const routes = $derived.by(() => {
    const m = new Map();
    for (const p of v?.pairs ?? []) {
      const k = `${p.out.accountName} → ${p.in.accountName}`;
      let r = m.get(k);
      if (!r) m.set(k, (r = { key: k, pairs: [], money: 0, crossHolder: p.crossHolder }));
      r.pairs.push(p);
      r.money += Math.abs(p.out.value ?? 0);
    }
    return [...m.values()].sort((a, b) => b.pairs.length - a.pairs.length);
  });
  let openRoutes = $state(new Set());
  const toggleRoute = (k) => {
    const n = new Set(openRoutes);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    openRoutes = n;
  };

  const selectCls = 'rounded-md border border-input bg-card px-2 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring';
</script>

{#snippet leg(r)}
  <div class="min-w-0">
    <p class="truncate text-sm" title={r.description}>{r.description}</p>
    <p class="truncate text-xs text-muted-foreground">{r.date} · {r.accountName}{r.holder ? ` (${r.holder})` : ''} · {[r.category?.name ?? 'Uncategorized', r.subcategory?.name].filter(Boolean).join(' › ')}</p>
  </div>
  <span class={'whitespace-nowrap text-right text-sm tabular-nums ' + (r.amountCents > 0 ? 'text-success' : '')}>{formatMoney(r.amountCents, r.currency)}</span>
{/snippet}

<div class="flex flex-col gap-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h2 class="text-xl font-semibold">Transfers</h2>
      <p class="text-sm text-muted-foreground">
        Money moving between your own accounts. Pairs are linked, never recategorized; what has no other side is asked about below.
      </p>
    </div>
    <div class="flex items-center gap-1">
      <button class="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground" onclick={() => navigate('/accounts')}>Accounts</button>
      <button class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-foreground">Transfers</button>
    </div>
  </div>

  {#if error}<p class="text-sm text-destructive">{error}</p>{/if}
  {#if notice}<p class="rounded-md border border-border bg-accent/40 px-3 py-2 text-sm">{notice}</p>{/if}

  {#if loading}
    <p class="text-sm text-muted-foreground">Reconciling…</p>
  {:else if v}
    <div class={'flex flex-col gap-6 transition-opacity ' + (refreshing ? 'opacity-60' : '')}>
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card class="p-4">
          <p class="text-xs text-muted-foreground">Paired</p>
          <p class="mt-1 text-2xl font-semibold tabular-nums">{v.summary.pairs}</p>
          <p class="text-xs text-muted-foreground">both legs in your accounts</p>
        </Card>
        <Card class="p-4">
          <p class="text-xs text-muted-foreground">Off-book</p>
          <p class="mt-1 text-2xl font-semibold tabular-nums">{v.summary.offbookRows}</p>
          <p class="text-xs text-muted-foreground">rows in {v.summary.offbookAccounts} account{v.summary.offbookAccounts === 1 ? '' : 's'} you do not import</p>
        </Card>
        <Card class="p-4">
          <p class="text-xs text-muted-foreground">To confirm</p>
          <p class="mt-1 text-2xl font-semibold tabular-nums">{v.summary.suggested}</p>
          <p class="text-xs text-muted-foreground">pairs whose other leg is filed as spending or income</p>
        </Card>
        <Card class="p-4">
          <p class="text-xs text-muted-foreground">No other side</p>
          <p class="mt-1 text-2xl font-semibold tabular-nums">{v.summary.unmatched}</p>
          <p class="text-xs text-muted-foreground">legs · {formatMoney(v.summary.unmatchedMoneyCents, cur, { compact: true })}{v.summary.acknowledged ? ` · ${v.summary.acknowledged} group${v.summary.acknowledged === 1 ? '' : 's'} marked fine` : ''}</p>
        </Card>
      </div>

      <!-- 1. What has no other side: the work. -->
      <section class="flex flex-col gap-3">
        <div class="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h3 class="font-semibold">No other side</h3>
            <p class="text-sm text-muted-foreground">
              Filed as transfers, but nothing in your accounts matches them. If the other account is yours and not imported, declare it; if the money really left or came in, move the rows to the category they belong to.
            </p>
          </div>
          {#if v.summary.acknowledged}
            <label class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" bind:checked={showAcknowledged} /> show the ones marked fine
            </label>
          {/if}
        </div>
        {#if groups.length === 0}
          <Card class="p-5 text-sm text-muted-foreground">Every transfer has its other side.</Card>
        {/if}
        {#each groups as g (g.key)}
          <Card class={'p-4 ' + (g.acknowledged ? 'opacity-60' : '')}>
            <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h4 class="font-semibold">
                {g.accountName} · {g.direction === 'out' ? 'out to' : 'in from'} <span class="font-normal" title={g.counterparty}>“{g.suggestion.patterns[0] ?? g.counterparty}”</span>
              </h4>
              <p class="shrink-0 text-xs text-muted-foreground">
                {g.rowCount} row{g.rowCount === 1 ? '' : 's'} · {formatMoney(g.moneyCents, cur)} · {g.firstDate === g.lastDate ? g.firstDate : `${g.firstDate} – ${g.lastDate}`}
              </p>
            </div>
            <div class="mt-3">
              {#if g.acknowledged}
                <EvidenceRows rows={g.rows} total={g.rowCount} initial={5} />
              {:else}
                <EvidenceRows rows={g.rows} total={g.rowCount} initial={5} selectable bind:selected={selections[g.key]} />
              {/if}
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              {#if g.acknowledged}
                <Button variant="ghost" class="h-8 px-3 text-xs" onclick={() => unacknowledge(g)}>Show it again</Button>
              {:else}
                <Button variant="outline" class="h-8 px-3 text-xs" onclick={() => startDeclare(g)}>Declare as an off-book account…</Button>
                <Button variant="outline" class="h-8 px-3 text-xs" onclick={() => startMove(g)}>Move ticked rows to…</Button>
                <Button variant="ghost" class="h-8 px-3 text-xs" onclick={() => acknowledge(g)} title="Leave them as transfers; hidden from the count until these rows change">This is fine</Button>
              {/if}
            </div>

            {#if active?.key === g.key && active.mode === 'declare'}
              <div class="mt-2 flex flex-col gap-3 rounded-md border border-border bg-accent/30 p-3 text-sm">
                <p class="text-xs text-muted-foreground">
                  An account of yours you do not import. Every transfer row containing one of its texts (whole words, in order, case and accents ignored) becomes internal, and the account gets a running balance.
                </p>
                <div class="flex flex-wrap gap-3">
                  <div class="flex flex-col gap-1.5">
                    <Label>Add to</Label>
                    <select bind:value={active.target} class={selectCls}>
                      <option value="new">A new off-book account</option>
                      {#each v.offbook as ob (ob.id)}<option value={String(ob.id)}>{ob.name}</option>{/each}
                    </select>
                  </div>
                  {#if active.target === 'new'}
                    <div class="flex min-w-[14rem] flex-1 flex-col gap-1.5">
                      <Label>Name</Label>
                      <Input bind:value={active.name} />
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <Label>Kind</Label>
                      <select bind:value={active.kind} class={selectCls}>
                        {#each KINDS as k (k.id)}<option value={k.id}>{k.label}</option>{/each}
                      </select>
                    </div>
                  {/if}
                </div>
                <div class="flex flex-col gap-1.5">
                  <Label>Texts that identify its rows <span class="text-muted-foreground">(one per line)</span></Label>
                  <textarea bind:value={active.patterns} rows="2" class="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring"></textarea>
                </div>
                <div class="flex gap-2">
                  <Button class="h-8 px-3 text-xs" onclick={applyDeclare} disabled={working}>{working ? 'Saving…' : 'Declare'}</Button>
                  <Button class="h-8 px-3 text-xs" variant="outline" onclick={() => (active = null)}>Cancel</Button>
                </div>
              </div>
            {:else if active?.key === g.key && active.mode === 'move'}
              <div class="mt-2 flex flex-col gap-2 rounded-md border border-border bg-accent/30 p-3 text-sm">
                <p class="text-xs text-muted-foreground">
                  Moves the {(selections[g.key] ?? []).length} ticked row{(selections[g.key] ?? []).length === 1 ? '' : 's'} out of transfers into the category you pick (a gift, a payment, a salary) and locks them, like a manual categorization.
                </p>
                <CategorySelect {categories} bind:categoryId={active.categoryId} bind:subcategoryId={active.subcategoryId} placeholder="Pick a category…" />
                <div class="flex gap-2">
                  <Button class="h-8 px-3 text-xs" onclick={() => applyMove(g)} disabled={working}>{working ? 'Moving…' : 'Move'}</Button>
                  <Button class="h-8 px-3 text-xs" variant="outline" onclick={() => (active = null)}>Cancel</Button>
                </div>
              </div>
            {/if}
          </Card>
        {/each}
      </section>

      <!-- 2. Off-book accounts. -->
      <section class="flex flex-col gap-3">
        <div>
          <h3 class="font-semibold">Off-book accounts</h3>
          <p class="text-sm text-muted-foreground">Accounts of yours you do not import. Balance = what went in minus what came back, each row at its own date's rate.</p>
        </div>
        {#if v.offbook.length === 0}
          <Card class="p-5 text-sm text-muted-foreground">None yet. Declare one from a group above — an exchange wallet, a broker, a term deposit, a loan.</Card>
        {/if}
        <div class="grid gap-4 xl:grid-cols-2">
          {#each v.offbook as ob (ob.id)}
            <Card class="flex flex-col gap-3 p-4">
              {#if editing?.id === ob.id}
                <div class="flex flex-wrap gap-3">
                  <div class="flex min-w-[12rem] flex-1 flex-col gap-1.5"><Label>Name</Label><Input bind:value={editing.name} /></div>
                  <div class="flex flex-col gap-1.5">
                    <Label>Kind</Label>
                    <select bind:value={editing.kind} class={selectCls}>{#each KINDS as k (k.id)}<option value={k.id}>{k.label}</option>{/each}</select>
                  </div>
                </div>
                <div class="flex flex-col gap-1.5">
                  <Label>Texts that identify its rows <span class="text-muted-foreground">(one per line)</span></Label>
                  <textarea bind:value={editing.patterns} rows="3" class="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring"></textarea>
                </div>
                <div class="flex gap-2">
                  <Button class="h-8 px-3 text-xs" onclick={saveEdit} disabled={working}>Save</Button>
                  <Button class="h-8 px-3 text-xs" variant="outline" onclick={() => (editing = null)}>Cancel</Button>
                </div>
              {:else}
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <h4 class="truncate font-semibold">{ob.name}</h4>
                    <p class="text-xs text-muted-foreground">{kindOf(ob.kind).label} · {ob.rowCount} row{ob.rowCount === 1 ? '' : 's'}</p>
                  </div>
                  <div class="shrink-0 text-right">
                    <p class="text-xl font-semibold tabular-nums">{formatMoney(ob.balanceCents, cur)}</p>
                    <p class="text-xs text-muted-foreground">balance now</p>
                  </div>
                </div>
                {#if ob.series.length > 1}
                  <LineChart labels={ob.series.map((m) => monthLabel(m.ym, { long: true }))} values={ob.series.map((m) => m.balance)} currency={cur} height={140} />
                {/if}
                <p class="text-xs text-muted-foreground">{balanceNote(ob)}{ob.unconverted ? ` ${ob.unconverted} row${ob.unconverted === 1 ? ' has' : 's have'} no rate and ${ob.unconverted === 1 ? 'is' : 'are'} left out.` : ''}</p>
                <div class="flex flex-wrap gap-1.5">
                  {#each ob.patterns as p (p)}<span class="rounded bg-accent px-1.5 py-0.5 font-mono text-xs">{p}</span>{/each}
                </div>
                {#if openRows.has(ob.id)}
                  <EvidenceRows rows={ob.rows} total={ob.rowCount} initial={6} />
                {/if}
                <div class="flex flex-wrap items-center gap-2">
                  <Button variant="outline" class="h-8 px-3 text-xs" onclick={() => toggleRows(ob.id)}>{openRows.has(ob.id) ? 'Hide rows' : `Show ${ob.rowCount} rows`}</Button>
                  <Button variant="ghost" class="h-8 px-3 text-xs" onclick={() => startEdit(ob)}>Edit</Button>
                  {#if confirmDelete === ob.id}
                    <Button variant="destructive" class="h-8 px-3 text-xs" onclick={() => deleteOffbook(ob)}>Delete — its rows become unmatched</Button>
                    <Button variant="ghost" class="h-8 px-3 text-xs" onclick={() => (confirmDelete = null)}>Cancel</Button>
                  {:else}
                    <Button variant="ghost" class="h-8 px-3 text-xs text-destructive" onclick={() => (confirmDelete = ob.id)}>Delete…</Button>
                  {/if}
                </div>
              {/if}
            </Card>
          {/each}
        </div>
      </section>

      <!-- 3. Pairs to confirm. -->
      {#if v.suggested.length}
        <section class="flex flex-col gap-3">
          <div>
            <h3 class="font-semibold">Pairs to confirm</h3>
            <p class="text-sm text-muted-foreground">Same amount, same currency, a few days apart — but the other leg is filed as spending or income. Confirming links them; fix the category yourself if it is wrong.</p>
          </div>
          {#each v.suggested as p (p.out.id + ':' + p.in.id)}
            <Card class="p-4">
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2">
                {@render leg(p.out)}
                {@render leg(p.in)}
              </div>
              <div class="mt-3 flex gap-2">
                <Button class="h-8 px-3 text-xs" onclick={() => decide(p, 'confirmed')}>Confirm the pair</Button>
                <Button variant="outline" class="h-8 px-3 text-xs" onclick={() => decide(p, 'rejected')}>Not a pair</Button>
              </div>
            </Card>
          {/each}
        </section>
      {/if}

      <!-- 4. What paired, by route. -->
      <section class="flex flex-col gap-3">
        <div>
          <h3 class="font-semibold">Paired</h3>
          <p class="text-sm text-muted-foreground">Both legs found: the same amount within four days, or an exchange within 3% on the same or next days. A wrong pair can be undone.</p>
        </div>
        <Card class="divide-y divide-border">
          {#each routes as r (r.key)}
            <div>
              <button class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/40" onclick={() => toggleRoute(r.key)} aria-expanded={openRoutes.has(r.key)}>
                <Icon name="chevron-down" size={14} class={'shrink-0 text-muted-foreground transition ' + (openRoutes.has(r.key) ? '' : '-rotate-90')} />
                <span class="min-w-0 flex-1 truncate text-sm font-medium">{r.key}</span>
                {#if r.crossHolder}<span class="shrink-0 rounded bg-accent px-1.5 py-px text-[11px] text-muted-foreground">between holders</span>{/if}
                <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{r.pairs.length} pair{r.pairs.length === 1 ? '' : 's'} · {formatMoney(r.money, cur, { compact: true })}</span>
              </button>
              {#if openRoutes.has(r.key)}
                <ul class="max-h-[32rem] divide-y divide-border overflow-y-auto border-t border-border">
                  {#each r.pairs as p (p.out.id + ':' + p.in.id)}
                    <li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_auto]">
                      {@render leg(p.out)}
                      {@render leg(p.in)}
                      <div class="flex items-center gap-2 lg:justify-end">
                        <span class="text-xs text-muted-foreground">{p.status === 'confirmed' ? 'confirmed' : p.days === 0 ? 'same day' : `${p.days} day${p.days === 1 ? '' : 's'}`}</span>
                        <button class="text-xs text-destructive hover:underline" onclick={() => decide(p, 'rejected')}>Not a pair</button>
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/each}
        </Card>
      </section>
    </div>
  {/if}
</div>
