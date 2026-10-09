<script>
  import Card from '$lib/components/ui/Card.svelte';

  // How much of the filtered work is classified, measured in money rather than
  // row count — one 4,000 PLN invoice matters more than twenty coffees. The
  // category selection is stripped server-side, so filtering to "uncategorized"
  // still shows real progress instead of a permanent 0%.
  let { progress = null, money } = $props();

  // When no row can be converted (e.g. filtered to a currency with no rate on
  // file), the money total is 0 and would read as "nothing left to do" — fall
  // back to counting rows and say which basis is on screen.
  const byMoney = $derived(progress != null && progress.totalCents > 0);
  const pct = $derived.by(() => {
    if (!progress) return null;
    if (byMoney) return Math.round((progress.classifiedCents / progress.totalCents) * 100);
    if (progress.totalCount > 0) return Math.round(((progress.totalCount - progress.pendingCount) / progress.totalCount) * 100);
    return null;
  });
  const done = $derived(progress != null && progress.pendingCount === 0);
</script>

{#if progress && progress.totalCount > 0}
  <Card class="mb-4 p-3">
    <div class="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span class="text-sm font-medium">
        {#if done}
          Everything classified
        {:else if byMoney}
          {money(progress.pendingCents, progress.currency)} left to classify
        {:else}
          {progress.pendingCount} transaction{progress.pendingCount === 1 ? '' : 's'} left to classify
        {/if}
      </span>
      <span class="text-xs text-muted-foreground">
        {#if pct != null}<span class="font-medium text-foreground">{pct}%</span>{/if}
        {#if byMoney}of {money(progress.totalCents, progress.currency)} ·{/if}
        {progress.pendingCount} of {progress.totalCount} transaction{progress.totalCount === 1 ? '' : 's'} left
      </span>
    </div>

    <div class="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin="0" aria-valuemax="100" aria-label="Classification progress">
      <div class="h-full rounded-full bg-success transition-[width] duration-300" style="width: {pct ?? 0}%"></div>
    </div>

    {#if progress.unconvertedCount > 0}
      <p class="mt-1.5 text-[11px] text-muted-foreground">
        {#if byMoney}
          {progress.unconvertedCount} transaction{progress.unconvertedCount === 1 ? '' : 's'} ({progress.unconvertedPending} still uncategorized)
          {progress.unconvertedCount === 1 ? 'is' : 'are'} missing from these amounts — no exchange rate to {progress.currency} covers
          {progress.unconvertedCount === 1 ? 'it' : 'them'} yet.
        {:else}
          Counting transactions, not amounts: no exchange rate to {progress.currency} covers
          {progress.unconvertedCount === 1 ? 'this row' : 'any of these rows'} yet.
        {/if}
      </p>
    {/if}
  </Card>
{/if}
