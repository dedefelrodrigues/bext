<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { navigate } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';

  // A summary of the level-2 rate table — the rows themselves (thousands, for a
  // daily table) live on the Rates page so Settings stays a page you can scan.
  let summary = $state(null);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    try {
      summary = await api('/fx/rates/summary');
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load exchange rates.';
    }
    loading = false;
  });
</script>

<Card class="p-6">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold">Exchange rates</h3>
      <p class="mt-1 text-xs text-muted-foreground">
        Used by the graphs when a transaction's own CSV can't imply a rate. The rate in effect for a
        transaction is the most recent one on or before its date; the inverse direction is derived
        automatically.
      </p>
    </div>
    <Button variant="outline" class="shrink-0" onclick={() => navigate('/rates')}>Manage rates</Button>
  </div>

  {#if error}
    <p class="mt-3 text-sm text-destructive">{error}</p>
  {:else if loading}
    <p class="mt-3 text-sm text-muted-foreground">Loading…</p>
  {:else if summary.total === 0}
    <p class="mt-3 text-sm text-muted-foreground">No rates on file yet.</p>
  {:else}
    <p class="mt-3 text-sm">
      <span class="font-medium tabular-nums">{summary.total}</span> rate{summary.total === 1 ? '' : 's'}
      on file, latest <span class="tabular-nums">{summary.latest}</span>.
    </p>
    <ul class="mt-2 flex flex-wrap gap-2">
      {#each summary.pairs as p (p.from + p.to)}
        <li class="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
          <span class="font-medium text-foreground">{p.from} → {p.to}</span>
          <span class="tabular-nums"> · {p.count} · {p.earliest} → {p.latest}</span>
        </li>
      {/each}
    </ul>
  {/if}
</Card>
