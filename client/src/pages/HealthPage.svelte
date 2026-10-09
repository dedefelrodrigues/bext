<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { navigate } from '$lib/router.svelte.js';
  import { formatMoney } from '$lib/charts.js';
  import Card from '$lib/components/ui/Card.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';
  import CategorySelect from '$lib/components/ui/CategorySelect.svelte';
  import EvidenceRows from '$lib/components/health/EvidenceRows.svelte';
  import AmountStrip from '$lib/components/health/AmountStrip.svelte';

  // Data health: what the checks found in your rules, the direction of your
  // money, your imports and your category structure. A fix is shown with what
  // it changes and runs only on confirm, through the same endpoints a hand
  // edit uses; "this is fine" hides a finding until its evidence changes.

  const CHECKS = [
    { id: 'rules', label: 'Rules', hint: 'Keywords whose text is shared by unrelated rows — a name, an address.' },
    { id: 'direction', label: 'Direction', hint: 'Money going the other way from the rest of its category.' },
    { id: 'imports', label: 'Imports', hint: 'Broken letters, 0.00 lines, impossible rows, missed duplicates.' },
    { id: 'structure', label: 'Structure', hint: 'Categories and keywords nothing uses; categories off the Budget.' },
    { id: 'transfers', label: 'Transfers', hint: 'Transfer legs with no other side; pairs to confirm (decided on Accounts › Transfers).' },
  ];
  const SEVERITY = { high: 'High', medium: 'Medium', low: 'Low' };

  let findings = $state([]);
  let categories = $state([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let notice = $state('');
  let check = $state('');
  let showDismissed = $state(false);
  // finding key -> the row ids a row fix (move, delete 0.00) will act on
  let selections = $state({});
  const ROW_FIXES = new Set(['recategorize', 'delete-empty-rows']);
  const rowFixIds = (f) => f.fixes.find((x) => ROW_FIXES.has(x.type))?.transactionIds ?? null;

  async function load() {
    refreshing = true;
    error = '';
    try {
      findings = (await api('/data-health')).findings;
      // Row fixes start with every row ticked; you untick the ones to leave alone.
      const next = {};
      for (const f of findings) {
        const ids = rowFixIds(f);
        if (ids) next[f.key] = [...ids];
      }
      selections = next;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not run the checks.';
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

  const open = $derived(findings.filter((f) => !f.dismissed));
  const dismissedCount = $derived(findings.length - open.length);
  const countFor = (id) => open.filter((f) => f.check === id).length;
  const visible = $derived(findings.filter((f) => (showDismissed ? f.dismissed : !f.dismissed) && (!check || f.check === check)));

  // --- Expanding, fixing, dismissing -------------------------------------------
  let expanded = $state(new Set());
  const toggleOpen = (key) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  };

  // The fix being prepared: { findingKey, fix, itemId?, text?, categoryId?, subcategoryId? }
  let active = $state(null);
  let working = $state(false);

  function startFix(f, fix, item = null) {
    notice = '';
    if (fix.type === 'open') return navigate(fix.href);
    active = { findingKey: f.key, fix, itemId: item?.id ?? null, text: fix.text ?? '', categoryId: '', subcategoryId: '' };
  }
  const isActive = (f, fix, item = null) =>
    active && active.findingKey === f.key && active.fix === fix && active.itemId === (item?.id ?? null);

  function describe(fix, f) {
    const n = ROW_FIXES.has(fix.type) ? (selections[f.key] ?? []).length : 0;
    switch (fix.type) {
      case 'recategorize':
        return `Moves the ${n} ticked row${n === 1 ? '' : 's'} to the category you pick and locks ${n === 1 ? 'it' : 'them'}, exactly like a manual categorization — a keyword recompute will leave ${n === 1 ? 'it' : 'them'} alone.`;
      case 'edit-keyword':
        return 'Changes the keyword’s text, then re-runs classification over every row that is not locked. Adding words makes it match less.';
      case 'delete-keywords':
        return `Deletes ${fix.keywordIds.length} keyword${fix.keywordIds.length === 1 ? '' : 's'} and re-runs classification; rows only ${fix.keywordIds.length === 1 ? 'it' : 'they'} explained go back to uncategorized unless another keyword matches.`;
      case 'delete-empty-rows':
        return `Deletes the ${n} ticked row${n === 1 ? '' : 's'} of 0.00. A backup of the database is taken first.`;
      case 'delete-category':
        return 'Deletes the category (and any subcategories under it). Nothing points at it.';
      case 'delete-subcategory':
        return 'Deletes the subcategory. Nothing points at it.';
      default:
        return '';
    }
  }

  async function apply() {
    const { fix } = active;
    const ticked = selections[active.findingKey] ?? [];
    working = true;
    error = '';
    try {
      if (ROW_FIXES.has(fix.type) && !ticked.length) throw new ApiError('Tick at least one row.', 400);
      if (fix.type === 'recategorize') {
        if (!active.categoryId) throw new ApiError('Pick a category.', 400);
        await api('/transactions/bulk-categorize', {
          method: 'POST',
          body: { transactionIds: ticked, categoryId: Number(active.categoryId), subcategoryId: active.subcategoryId ? Number(active.subcategoryId) : null },
        });
        notice = `Moved ${ticked.length} row${ticked.length === 1 ? '' : 's'}.`;
      } else if (fix.type === 'edit-keyword') {
        const text = active.text.trim();
        if (!text || text === fix.text) throw new ApiError('Change the text first.', 400);
        await api(`/keywords/${fix.keywordId}`, { method: 'PATCH', body: { text } });
        notice = `Keyword is now “${text}”; classification re-ran.`;
      } else if (fix.type === 'delete-keywords') {
        for (const id of fix.keywordIds) await api(`/keywords/${id}`, { method: 'DELETE' });
        notice = `Deleted ${fix.keywordIds.length} keyword${fix.keywordIds.length === 1 ? '' : 's'}.`;
      } else if (fix.type === 'delete-empty-rows') {
        const res = await api('/data-health/delete-empty-rows', { method: 'POST', body: { transactionIds: ticked } });
        notice = `Deleted ${res.deleted} row${res.deleted === 1 ? '' : 's'} of 0.00.`;
      } else if (fix.type === 'delete-category') {
        await api(`/categories/${fix.categoryId}`, { method: 'DELETE' });
        notice = 'Category deleted.';
      } else if (fix.type === 'delete-subcategory') {
        await api(`/subcategories/${fix.subcategoryId}`, { method: 'DELETE' });
        notice = 'Subcategory deleted.';
      }
      active = null;
      if (fix.type.startsWith('delete-') && fix.type !== 'delete-empty-rows') categories = await api('/categories');
      await load();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not apply the fix.';
    } finally {
      working = false;
    }
  }

  async function dismiss(f) {
    await api('/data-health/dismiss', { method: 'POST', body: { key: f.key, fingerprint: f.fingerprint } });
    await load();
  }
  async function restore(f) {
    await api('/data-health/restore', { method: 'POST', body: { key: f.key } });
    await load();
  }

  const severityDot = { high: 'bg-destructive', medium: 'bg-warning-foreground', low: 'bg-muted-foreground/60' };
  const chip = (on) =>
    'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition ' +
    (on ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground');
</script>

{#snippet fixPanel(f, fix)}
  <div class="mt-2 flex flex-col gap-2 rounded-md border border-border bg-accent/30 p-3 text-sm">
    <p class="text-xs text-muted-foreground">{describe(fix, f)}</p>
    {#if fix.type === 'recategorize'}
      <CategorySelect {categories} bind:categoryId={active.categoryId} bind:subcategoryId={active.subcategoryId} placeholder="Pick a category…" />
    {:else if fix.type === 'edit-keyword'}
      <Input bind:value={active.text} aria-label="Keyword text" />
    {/if}
    <div class="flex gap-2">
      <Button class="h-8 px-3 text-xs" variant={fix.type.startsWith('delete') ? 'destructive' : 'default'} onclick={apply} disabled={working}>
        {working ? 'Working…' : fix.type.startsWith('delete') ? 'Delete' : 'Apply'}
      </Button>
      <Button class="h-8 px-3 text-xs" variant="outline" onclick={() => (active = null)} disabled={working}>Cancel</Button>
    </div>
  </div>
{/snippet}

<div class="flex flex-col gap-6">
  <div>
    <h2 class="text-xl font-semibold">Data health</h2>
    <p class="text-sm text-muted-foreground">
      Checks for the mistakes that quietly bend every total: rules catching the wrong rows, money going the wrong way, imports gone wrong, clutter.
    </p>
  </div>

  <div class="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
    <aside class="lg:sticky lg:top-4">
      <Card class="flex flex-col gap-1 p-2">
        <button class={chip(!check && !showDismissed)} onclick={() => { check = ''; showDismissed = false; }}>
          <span>All open</span><span class="tabular-nums">{open.length}</span>
        </button>
        {#each CHECKS as c (c.id)}
          <button class={chip(check === c.id && !showDismissed)} onclick={() => { check = c.id; showDismissed = false; }} title={c.hint}>
            <span>{c.label}</span><span class="tabular-nums">{countFor(c.id)}</span>
          </button>
        {/each}
        <div class="my-1 border-t border-border"></div>
        <button class={chip(showDismissed)} onclick={() => { showDismissed = !showDismissed; check = ''; }}>
          <span>Marked as fine</span><span class="tabular-nums">{dismissedCount}</span>
        </button>
        <div class="my-1 border-t border-border"></div>
        <div class="flex flex-col gap-1.5 px-2 py-1 text-xs text-muted-foreground">
          {#each CHECKS as c (c.id)}<p><span class="font-medium text-foreground">{c.label}</span> — {c.hint}</p>{/each}
        </div>
        <Button variant="outline" class="m-1 h-8 text-xs" onclick={load} disabled={refreshing}>{refreshing ? 'Checking…' : 'Check again'}</Button>
      </Card>
    </aside>

    <div class={'flex min-w-0 flex-col gap-3 transition-opacity ' + (refreshing && !loading ? 'opacity-60' : '')}>
      {#if error}<p class="text-sm text-destructive">{error}</p>{/if}
      {#if notice}<p class="rounded-md border border-border bg-accent/40 px-3 py-2 text-sm">{notice}</p>{/if}

      {#if loading}
        <p class="text-sm text-muted-foreground">Running the checks…</p>
      {:else if visible.length === 0}
        <Card class="p-6 text-sm text-muted-foreground">
          {showDismissed ? 'Nothing is marked as fine.' : check ? 'Nothing found by this check.' : 'Nothing found. Your data looks healthy.'}
        </Card>
      {:else}
        {#each visible as f (f.key)}
          <Card class="p-4">
            <div class="flex items-start gap-3">
              <span class={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + severityDot[f.severity]} aria-hidden="true"></span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 class="font-semibold">{f.title}</h3>
                  <p class="shrink-0 text-xs text-muted-foreground">
                    {SEVERITY[f.severity]} · {CHECKS.find((c) => c.id === f.check)?.label}{#if f.check === 'direction' && f.moneyCents}{` · ${formatMoney(f.moneyCents, f.currency)}`}{/if}
                  </p>
                </div>
                <p class="mt-1 text-sm text-muted-foreground">{f.detail}</p>

                {#if f.items.length}
                  <ul class="mt-3 max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {#each f.items as item (item.type + item.id)}
                      <li class="px-3 py-1.5">
                        <div class="flex items-center gap-3 text-sm">
                          {#if item.rows?.length}
                            <button class="shrink-0 text-muted-foreground hover:text-foreground" onclick={() => toggleOpen(`${f.key}|${item.id}`)} aria-expanded={expanded.has(`${f.key}|${item.id}`)} aria-label="Show where “{item.name}” appears">
                              <Icon name="chevron-down" size={14} class={'transition ' + (expanded.has(`${f.key}|${item.id}`) ? '' : '-rotate-90')} />
                            </button>
                          {/if}
                          <span class="min-w-0 flex-1 truncate" title={item.name}>{item.type === 'keyword' ? `“${item.name}”` : item.name}</span>
                          <span class="hidden shrink-0 truncate text-xs text-muted-foreground sm:block">{item.note}</span>
                          {#if item.fix && !f.dismissed}
                            <button class="shrink-0 text-xs text-destructive hover:underline" onclick={() => startFix(f, item.fix, item)}>{item.fix.label}</button>
                          {/if}
                        </div>
                        {#if item.rows?.length && expanded.has(`${f.key}|${item.id}`)}
                          <div class="mt-1.5"><EvidenceRows rows={item.rows} total={item.rowCount} initial={5} /></div>
                        {/if}
                        {#if item.fix && isActive(f, item.fix, item)}{@render fixPanel(f, item.fix)}{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}

                {#if f.context}
                  <div class="mt-3 rounded-md border border-border p-3">
                    <AmountStrip rest={f.context.rest} flagged={f.context.flagged} currency={f.currency} category={f.context.category} />
                    <p class="mt-2 text-xs text-muted-foreground">
                      A typical row in {f.context.category} is {formatMoney(f.context.typicalCents, f.currency)}; these {f.rowCount} average {formatMoney(Math.round(f.context.flagged.reduce((a, t) => a + t.value, 0) / Math.max(1, f.context.flagged.length)), f.currency)}.
                      Close to zero among the rest is usually a refund; far off on the other side is usually misfiled.
                    </p>
                  </div>
                {/if}

                {#if f.own}
                  <p class="mt-3 text-xs font-medium text-muted-foreground">Where it wins today — {f.own.count} row{f.own.count === 1 ? '' : 's'} in {f.own.category}</p>
                  <div class="mt-1"><EvidenceRows rows={f.own.rows} total={f.own.count} initial={4} /></div>
                  <p class="mt-3 text-xs font-medium text-muted-foreground">Where its text also appears — {f.rowCount} row{f.rowCount === 1 ? '' : 's'}</p>
                {/if}

                {#if f.rowCount}
                  <div class={f.own ? 'mt-1' : 'mt-3'}>
                    {#if selections[f.key] && !f.dismissed}
                      <EvidenceRows rows={f.rows} total={f.rowCount} selectable bind:selected={selections[f.key]} />
                    {:else}
                      <EvidenceRows rows={f.rows} total={f.rowCount} />
                    {/if}
                  </div>
                {/if}

                <div class="mt-3 flex flex-wrap items-center gap-2">
                  {#if !f.dismissed}
                    {#each f.fixes as fix (fix.type + fix.label)}
                      <Button variant="outline" class="h-8 px-3 text-xs" onclick={() => startFix(f, fix)}>
                        {fix.label}
                      </Button>
                    {/each}
                    <Button variant="ghost" class="h-8 px-3 text-xs" onclick={() => dismiss(f)} title="Hide this until what it found changes">This is fine</Button>
                  {:else}
                    <Button variant="ghost" class="h-8 px-3 text-xs" onclick={() => restore(f)}>Show it again</Button>
                  {/if}
                </div>
                {#each f.fixes as fix (fix.type + fix.label)}
                  {#if isActive(f, fix)}{@render fixPanel(f, fix)}{/if}
                {/each}
              </div>
            </div>
          </Card>
        {/each}
      {/if}
    </div>
  </div>
</div>
