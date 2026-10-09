<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';

  // The level-2 rate table. Level 1 (a rate the CSV itself implies) needs no
  // upkeep — it is read straight off transactions that carry both amount pairs.
  // A daily table runs to thousands of rows, so the list is filtered and paged
  // on the server and this page only ever holds a window of it.
  const PAGE_SIZE = 200;

  let rates = $state([]);
  let total = $state(0);
  let pairs = $state([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state('');
  let notice = $state('');
  let fileInput;

  // Filters
  let pair = $state('all'); // 'all' | 'EUR>PLN'
  let dateFrom = $state('');
  let dateTo = $state('');

  // Add form
  let date = $state('');
  let from = $state('');
  let to = $state('');
  let rate = $state('');

  const filterParams = $derived.by(() => {
    const p = new URLSearchParams();
    if (pair !== 'all') {
      const [f, t] = pair.split('>');
      p.set('from', f);
      p.set('to', t);
    }
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo) p.set('dateTo', dateTo);
    return p;
  });

  const filtered = $derived(pair !== 'all' || !!dateFrom || !!dateTo);

  // Deliberately not $state: the effect below both reads and writes it, and it
  // is bookkeeping about what was already fetched, not rendered state.
  let appliedKey = '';

  async function load(offset = 0) {
    const p = new URLSearchParams(filterParams);
    appliedKey = filterParams.toString();
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String(offset));
    const res = await api(`/fx/rates?${p}`);
    rates = offset === 0 ? res.rates : [...rates, ...res.rates];
    total = res.total;
  }

  // The pair list and the counts on the header come from the grouped summary, so
  // they describe the whole table rather than the loaded window.
  async function refresh() {
    error = '';
    try {
      const [summary] = await Promise.all([api('/fx/rates/summary'), load(0)]);
      pairs = summary.pairs;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load rates.';
    }
    loading = false;
  }

  onMount(refresh);

  // Re-query whenever a filter actually changes — `appliedKey` keeps the initial
  // load (and any refresh) from being repeated by this effect.
  $effect(() => {
    const key = filterParams.toString();
    if (key === appliedKey) return;
    appliedKey = key;
    load(0).catch(() => (error = 'Could not load rates.'));
  });

  async function loadMore() {
    loadingMore = true;
    try {
      await load(rates.length);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load more rates.';
    }
    loadingMore = false;
  }

  async function add(e) {
    e.preventDefault();
    error = '';
    notice = '';
    try {
      await api('/fx/rates', { method: 'POST', body: { date, from, to, rate } });
      date = '';
      rate = '';
      await refresh();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not save the rate.';
    }
  }

  async function remove(id) {
    try {
      await api(`/fx/rates/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not delete the rate.';
    }
  }

  // Deletes exactly what the filters describe — the confirmation quotes the same
  // count the header shows, so there is no gap between what you see and what goes.
  async function removeFiltered() {
    const what = filtered ? `the ${total} rate${total === 1 ? '' : 's'} matching these filters` : `all ${total} rates`;
    if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
    try {
      const res = await api(`/fx/rates?${filterParams}`, { method: 'DELETE' });
      notice = `Deleted ${res.deleted} rate${res.deleted === 1 ? '' : 's'}.`;
      await refresh();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not delete the rates.';
    }
  }

  async function exportCsv() {
    try {
      const { csv } = await api('/fx/rates/export');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bext-fx-rates.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not export rates.';
    }
  }

  async function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    error = '';
    notice = '';
    try {
      const csv = await file.text();
      const res = await api('/fx/rates/import', { method: 'POST', body: { csv } });
      notice = `Imported ${res.imported} rate${res.imported === 1 ? '' : 's'}.`;
      await refresh();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not import rates — check the CSV.';
    }
  }

  function clearFilters() {
    pair = 'all';
    dateFrom = '';
    dateTo = '';
  }
</script>

<div class="mb-6 flex items-start justify-between gap-3">
  <div>
    <h2 class="text-2xl font-bold tracking-tight">Exchange rates</h2>
    <p class="mt-1 text-sm text-muted-foreground">
      Used by the graphs when a transaction's own CSV can't imply a rate. The rate in effect for a
      transaction is the most recent one on or before its date; the inverse direction is derived
      automatically.
    </p>
  </div>
  <div class="flex shrink-0 items-center gap-2">
    <Button variant="outline" onclick={exportCsv}><Icon name="download" />Export</Button>
    <Button variant="outline" onclick={() => fileInput.click()}><Icon name="upload" />Import</Button>
  </div>
</div>
<input type="file" accept="text/csv,.csv" class="hidden" bind:this={fileInput} onchange={onImportFile} />

<Card class="p-6">
  <h3 class="text-sm font-semibold">Add a rate</h3>
  <form class="mt-3 flex flex-wrap items-end gap-2" onsubmit={add}>
    <div class="flex flex-col gap-1.5">
      <Label for="fx-date">Date</Label>
      <Input id="fx-date" type="date" bind:value={date} class="w-40" required />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="fx-from">From</Label>
      <Input id="fx-from" bind:value={from} maxlength="3" placeholder="EUR" class="w-20 uppercase" required />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="fx-to">To</Label>
      <Input id="fx-to" bind:value={to} maxlength="3" placeholder="PLN" class="w-20 uppercase" required />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="fx-rate">Rate</Label>
      <Input id="fx-rate" bind:value={rate} placeholder="4.25" class="w-28" required />
    </div>
    <Button type="submit">Add</Button>
  </form>
  <p class="mt-1.5 text-xs text-muted-foreground">CSV format: <code>date,from,to,rate</code> — importing merges into what's here.</p>
</Card>

{#if error}
  <p class="mt-4 text-sm text-destructive">{error}</p>
{/if}
{#if notice}
  <p class="mt-4 text-sm text-success">{notice}</p>
{/if}

<Card class="mt-6 p-6">
  <div class="flex flex-wrap items-end gap-2">
    <div class="flex flex-col gap-1.5">
      <Label for="fx-pair">Pair</Label>
      <select
        id="fx-pair"
        bind:value={pair}
        class="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
      >
        <option value="all">All pairs</option>
        {#each pairs as p (p.from + p.to)}
          <option value={`${p.from}>${p.to}`}>{p.from} → {p.to} ({p.count})</option>
        {/each}
      </select>
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="fx-date-from">From date</Label>
      <Input id="fx-date-from" type="date" bind:value={dateFrom} class="w-40" />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="fx-date-to">To date</Label>
      <Input id="fx-date-to" type="date" bind:value={dateTo} class="w-40" />
    </div>
    {#if filtered}
      <Button variant="outline" onclick={clearFilters}>Clear filters</Button>
    {/if}
    <div class="ml-auto">
      <Button variant="outline" onclick={removeFiltered} disabled={total === 0}>
        <Icon name="trash" />{filtered ? 'Delete filtered' : 'Delete all'}
      </Button>
    </div>
  </div>

  {#if loading}
    <p class="mt-4 text-sm text-muted-foreground">Loading…</p>
  {:else if total === 0}
    <p class="mt-4 text-sm text-muted-foreground">
      {filtered ? 'No rates match these filters.' : 'No rates yet — add one above or import a CSV.'}
    </p>
  {:else}
    <p class="mt-4 text-xs text-muted-foreground">
      Showing {rates.length} of {total} rate{total === 1 ? '' : 's'}.
    </p>
    <table class="mt-2 w-full text-sm">
      <thead>
        <tr class="text-left text-xs text-muted-foreground">
          <th class="py-1">Date</th><th class="py-1">Pair</th><th class="py-1 text-right">Rate</th>
          <th class="py-1">Source</th><th></th>
        </tr>
      </thead>
      <tbody>
        {#each rates as r (r.id)}
          <tr class="border-t border-border">
            <td class="py-1 tabular-nums">{r.date}</td>
            <td class="py-1">{r.from} → {r.to}</td>
            <td class="py-1 text-right tabular-nums">{r.rate}</td>
            <td class="py-1 text-xs text-muted-foreground">{r.source}</td>
            <td class="py-1 text-right">
              <IconButton onclick={() => remove(r.id)} title="Delete rate" aria-label="Delete rate">
                <Icon name="trash" />
              </IconButton>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rates.length < total}
      <div class="mt-4">
        <Button variant="outline" onclick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - rates.length)} more`}
        </Button>
      </div>
    {/if}
  {/if}
</Card>
