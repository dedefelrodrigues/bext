<script>
  import { formatMoney } from '$lib/charts.js';
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';
  import HighlightedText from './HighlightedText.svelte';

  // The transactions behind a finding, as a ledger: date · description (the
  // keyword's words marked) · account · where it sits now · what put it there ·
  // amount. With `selectable`, a checkbox per row picks what a fix acts on.
  let {
    rows = [],
    total = rows.length, // rows the finding covers (the list may be capped)
    selectable = false,
    selected = $bindable([]),
    initial = 8,
  } = $props();

  let showAll = $state(false);
  const shown = $derived(showAll ? rows : rows.slice(0, initial));
  const selectedSet = $derived(new Set(selected));

  function toggle(id) {
    selected = selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id];
  }
  const allShownSelected = $derived(shown.every((r) => selectedSet.has(r.id)));
  function toggleShown() {
    const ids = new Set(shown.map((r) => r.id));
    selected = allShownSelected ? selected.filter((x) => !ids.has(x)) : [...new Set([...selected, ...ids])];
  }

  const grid = $derived(
    (selectable ? 'grid-cols-[1.25rem_5.5rem_minmax(0,1fr)_auto]' : 'grid-cols-[5.5rem_minmax(0,1fr)_auto]') +
      (selectable ? ' lg:grid-cols-[1.25rem_5.5rem_minmax(0,1fr)_8rem_13rem_auto]' : ' lg:grid-cols-[5.5rem_minmax(0,1fr)_8rem_13rem_auto]'),
  );
</script>

<div class="rounded-md border border-border text-sm">
  {#if selectable}
    <div class={'grid items-center gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground ' + grid}>
      <input type="checkbox" checked={allShownSelected} onchange={toggleShown} aria-label="Select the rows shown" />
      <span class="col-span-2 lg:col-span-4">{selected.length} of {total} selected for the fix</span>
    </div>
  {/if}
  <ul class="max-h-[28rem] divide-y divide-border overflow-y-auto">
    {#each shown as r (r.id)}
      <li class={'grid items-center gap-3 px-3 py-1.5 ' + grid + (selectable && !selectedSet.has(r.id) ? ' opacity-50' : '')}>
        {#if selectable}
          <input type="checkbox" checked={selectedSet.has(r.id)} onchange={() => toggle(r.id)} aria-label="Include {r.description}" />
        {/if}
        <span class="tabular-nums text-muted-foreground">{r.date}</span>
        <span class="truncate" title={r.description}><HighlightedText text={r.description} ranges={r.highlight} /></span>
        <span class="hidden truncate text-xs text-muted-foreground lg:block" title={r.accountName}>{r.accountName}</span>
        <span class="hidden min-w-0 flex-col text-xs lg:flex">
          <span class="flex min-w-0 items-center gap-1">
            {#if r.category}<CategoryIcon name={r.category.icon} categoryId={r.category.id} size={12} class="shrink-0" />{/if}
            <span class="truncate">{[r.category?.name ?? 'Uncategorized', r.subcategory?.name].filter(Boolean).join(' › ')}</span>
          </span>
          <span class="truncate text-muted-foreground">
            {r.keyword ? `keyword “${r.keyword.text}”` : r.manual ? 'set by hand' : 'no keyword'}
          </span>
        </span>
        <span class={'whitespace-nowrap text-right tabular-nums ' + (r.amountCents > 0 ? 'text-success' : '')}>{formatMoney(r.amountCents, r.currency)}</span>
      </li>
    {/each}
  </ul>
  {#if rows.length > initial}
    <button class="w-full border-t border-border px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground" onclick={() => (showAll = !showAll)}>
      {showAll ? 'Show fewer' : `Show all ${rows.length}`}{total > rows.length ? ` (latest ${rows.length} of ${total})` : ''}
    </button>
  {/if}
</div>
