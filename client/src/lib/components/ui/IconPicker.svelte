<script>
  import { ICON_NAMES } from '$lib/categoryIcons.js';
  import { cn } from '$lib/utils.js';
  import CategoryIcon from './CategoryIcon.svelte';

  // A grid picker over the curated icon pool. `value` is the selected icon name
  // (or null for "no icon").
  let { value = $bindable(null) } = $props();

  const cellBase =
    'flex h-9 w-9 items-center justify-center rounded-md border transition';
  const unselected = 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground';
  const selected = 'border-primary bg-accent text-foreground';
</script>

<div class="grid grid-cols-8 gap-1">
  <button
    type="button"
    class={cn(cellBase, value == null ? selected : unselected, 'text-xs')}
    onclick={() => (value = null)}
    title="No icon"
    aria-label="No icon"
  >
    —
  </button>
  {#each ICON_NAMES as n (n)}
    <button
      type="button"
      class={cn(cellBase, value === n ? selected : unselected)}
      onclick={() => (value = n)}
      title={n}
      aria-label={n}
    >
      <CategoryIcon name={n} size={18} />
    </button>
  {/each}
</div>
