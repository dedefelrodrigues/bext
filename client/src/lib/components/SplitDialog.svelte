<script>
  import { untrack } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';

  // Split a leaf transaction into child lines that must sum to its amount. Each
  // child gets its own category + business flag (subcategory/hashtags editable
  // afterward). The parent becomes a hidden container.
  let { open = $bindable(false), tx = null, categories = [], onSaved } = $props();

  let lines = $state([]);
  let error = $state('');
  let saving = $state(false);

  function seed() {
    error = '';
    const total = tx ? tx.amountCents : 0;
    const first = Math.trunc(total / 2);
    lines = [
      { amountStr: (first / 100).toFixed(2), categoryId: '', businessFlag: 'personal' },
      { amountStr: ((total - first) / 100).toFixed(2), categoryId: '', businessFlag: 'personal' },
    ];
  }
  let lastOpen = false;
  $effect(() => {
    if (open && !lastOpen) untrack(seed);
    lastOpen = open;
  });

  const toCents = (s) => Math.round(parseFloat(s) * 100);
  const sumCents = $derived(lines.reduce((acc, l) => acc + (Number.isFinite(toCents(l.amountStr)) ? toCents(l.amountStr) : 0), 0));
  const targetCents = $derived(tx ? tx.amountCents : 0);
  const remaining = $derived(targetCents - sumCents);
  const balanced = $derived(remaining === 0 && lines.length >= 2);

  function money(cents) {
    return (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function apply() {
    error = '';
    if (!balanced) {
      error = 'Split lines must sum to the transaction amount.';
      return;
    }
    saving = true;
    try {
      const splits = lines.map((l) => ({
        amountCents: toCents(l.amountStr),
        categoryId: l.categoryId ? Number(l.categoryId) : null,
        businessFlag: l.businessFlag,
      }));
      await api(`/transactions/${tx.id}/splits`, { method: 'POST', body: { splits } });
      open = false;
      onSaved?.();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not split.';
    } finally {
      saving = false;
    }
  }

  const selectCls = 'w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring';
</script>

<Dialog bind:open title="Split transaction">
  {#if tx}
    <div class="flex flex-col gap-4">
      <p class="text-sm text-muted-foreground">
        <span class="font-medium text-foreground">{tx.description}</span> — total {money(tx.amountCents)}
        {tx.currency}. Lines must sum to the total.
      </p>

      <div class="flex flex-col gap-2">
        {#each lines as line, i (i)}
          <div class="flex items-center gap-2">
            <Input type="number" step="0.01" bind:value={line.amountStr} class="max-w-[8rem]" placeholder="0.00" />
            <select bind:value={line.categoryId} class={selectCls}>
              <option value="">Uncategorized</option>
              {#each categories as c (c.id)}<option value={String(c.id)}>{c.name}</option>{/each}
            </select>
            <select bind:value={line.businessFlag} class={selectCls + ' max-w-[8rem]'}>
              <option value="personal">Personal</option>
              <option value="business">Business</option>
              <option value="mixed">Mixed</option>
            </select>
            <Button variant="ghost" type="button" disabled={lines.length <= 2} onclick={() => (lines = lines.filter((_, j) => j !== i))} aria-label="Remove line">
              <Icon name="trash" />
            </Button>
          </div>
        {/each}
      </div>

      <div class="flex items-center justify-between text-sm">
        <Button variant="outline" type="button" onclick={() => (lines = [...lines, { amountStr: (remaining / 100).toFixed(2), categoryId: '', businessFlag: 'personal' }])}>
          <Icon name="plus" />Add line
        </Button>
        <span class={remaining === 0 ? 'text-success' : 'text-muted-foreground'}>
          {remaining === 0 ? 'Balanced' : `Remaining: ${money(remaining)} ${tx.currency}`}
        </span>
      </div>

      {#if error}<p class="text-sm text-destructive">{error}</p>{/if}

      <div class="flex justify-end gap-2">
        <Button variant="outline" type="button" onclick={() => (open = false)}>Cancel</Button>
        <Button type="button" disabled={saving || !balanced} onclick={apply}>{saving ? 'Splitting…' : 'Split'}</Button>
      </div>
    </div>
  {/if}
</Dialog>
