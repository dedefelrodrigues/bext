<script>
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';

  // "Show me the costs without Company, without Travel." A row of chips, one
  // per category, each clicked to drop that category out of every total on the
  // page — the subtractive counterpart to the category *selection* elsewhere.
  // Hidden categories are not offered: they are already out of the totals —
  // unless the page is counting them (`showHidden`), in which case they are
  // ordinary categories here and can be dropped like any other.
  // `compact` is the rail version: no explanatory sentence (the chips carry a
  // title each) and a tighter header, so it fits a 16rem column.
  let { categories = [], excluded = $bindable([]), onchange = null, showHidden = false, compact = false } = $props();

  const options = $derived(categories.filter((c) => showHidden || !c.isHidden));
  const anyExcluded = $derived(excluded.length > 0);

  function toggle(id) {
    excluded = excluded.includes(id) ? excluded.filter((x) => x !== id) : [...excluded, id];
    onchange?.(excluded);
  }

  function reset() {
    excluded = [];
    onchange?.(excluded);
  }
</script>

{#if options.length}
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span class="text-sm font-medium text-foreground">Leave out</span>
      {#if compact}
        {#if anyExcluded}
          <span class="text-xs text-muted-foreground">{excluded.length} out of every total</span>
        {/if}
      {:else}
        <span class="text-xs text-muted-foreground">
          {#if anyExcluded}
            {excluded.length}
            {excluded.length === 1 ? 'category is' : 'categories are'} out of every total on this page
          {:else}
            click a category to drop it from every total on this page
          {/if}
        </span>
      {/if}
      {#if anyExcluded}
        <button class="text-xs font-medium underline text-muted-foreground hover:text-foreground" onclick={reset}>
          Reset
        </button>
      {/if}
    </div>
    <div class="flex flex-wrap gap-1.5">
      {#each options as c (c.id)}
        {@const off = excluded.includes(c.id)}
        <button
          class={'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition ' +
            (off
              ? 'border-input bg-card text-muted-foreground/50 line-through'
              : 'border-input bg-card text-foreground hover:bg-accent')}
          onclick={() => toggle(c.id)}
          title={off ? `Put ${c.name} back into the totals` : `Leave ${c.name} out of the totals`}
        >
          <CategoryIcon name={c.icon} categoryId={c.id} size={12} class="shrink-0" />
          {c.name}
        </button>
      {/each}
    </div>
  </div>
{/if}
