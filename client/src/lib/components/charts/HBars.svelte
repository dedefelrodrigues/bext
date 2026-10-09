<script>
  import { formatMoney } from '$lib/charts.js';

  // Ranked magnitudes with names on the left — the right form when the labels
  // are long (hashtags) and the comparison is between rows, not over time.
  let { rows = [], currency = '', color = null, onselect = null } = $props();

  const max = $derived(Math.max(1, ...rows.map((r) => r.value)));
</script>

<ul class="flex flex-col gap-2">
  {#each rows as row (row.key ?? row.name)}
    <li>
      <button
        class="flex w-full items-center gap-3 rounded px-1 py-1 text-left hover:bg-accent"
        onclick={() => onselect?.(row)}
      >
        <span class="w-40 shrink-0 truncate text-sm">{row.name}</span>
        <span class="h-2 flex-1 rounded-sm bg-muted">
          <span
            class="block h-2 rounded-sm"
            style={`width:${Math.max((row.value / max) * 100, 1)}%; background:${row.color ?? color}`}
          ></span>
        </span>
        <span class="w-28 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
          {formatMoney(row.value, currency, { compact: true })}
        </span>
      </button>
    </li>
  {/each}
</ul>
