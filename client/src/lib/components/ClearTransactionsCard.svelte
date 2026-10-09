<script>
  // Danger zone: wipes the signed-in user's own transaction data, keeping the
  // setup (accounts, templates, categories, keywords, rates) that would be
  // tedious to rebuild. Counts are fetched when the dialog opens so the warning
  // reflects what is actually about to be destroyed.
  import { api, ApiError } from '$lib/api.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';

  const CONFIRM_WORD = 'DELETE';

  let stats = $state(null);
  let open = $state(false);
  let word = $state('');
  let clearing = $state(false);
  let error = $state('');
  let cleared = $state(null);

  const nothingToClear = $derived(
    stats !== null && stats.transactions + stats.uploads + stats.hashtags === 0,
  );

  async function openDialog() {
    error = '';
    cleared = null;
    word = '';
    stats = null;
    open = true;
    try {
      stats = await api('/settings/clear-transactions');
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not read the current totals.';
    }
  }

  async function clearAll() {
    error = '';
    clearing = true;
    try {
      const res = await api('/settings/clear-transactions', { method: 'POST', body: { confirm: true } });
      cleared = res.deleted;
      open = false;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not clear transactions.';
    } finally {
      clearing = false;
    }
  }
</script>

<Card class="border-destructive/40 p-6">
  <div class="flex flex-col gap-4">
    <div>
      <p class="text-sm font-medium">Clear all transactions</p>
      <p class="mt-1 text-sm text-muted-foreground">
        Deletes every transaction, split, hashtag and upload-history entry on your account. Your
        institutions, accounts, CSV templates, OFX settings, categories, keywords and exchange rates
        all stay — so you can re-import from a clean slate. Other users are never affected.
      </p>
    </div>

    {#if cleared}
      <p class="text-sm text-success" role="status">
        Cleared {cleared.transactions} transaction{cleared.transactions === 1 ? '' : 's'},
        {cleared.uploads} upload{cleared.uploads === 1 ? '' : 's'} and
        {cleared.hashtags} hashtag{cleared.hashtags === 1 ? '' : 's'}.
      </p>
    {/if}

    <div>
      <Button variant="destructive" onclick={openDialog}>Clear all transactions…</Button>
    </div>
  </div>
</Card>

<Dialog bind:open title="Clear all transactions?">
  {#if stats === null && !error}
    <p class="text-sm text-muted-foreground">Counting…</p>
  {:else if stats}
    <div class="flex flex-col gap-4">
      {#if nothingToClear}
        <p class="text-sm text-muted-foreground">There is nothing to clear — you have no transactions.</p>
      {:else}
        <p class="text-sm">
          This permanently deletes
          <strong>{stats.transactions} transaction{stats.transactions === 1 ? '' : 's'}</strong>,
          <strong>{stats.uploads}</strong> upload-history
          {stats.uploads === 1 ? 'entry' : 'entries'} and
          <strong>{stats.hashtags}</strong> hashtag{stats.hashtags === 1 ? '' : 's'}.
        </p>

        {#if stats.locked > 0 || stats.split > 0}
          <p class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {#if stats.locked > 0}<strong>{stats.locked}</strong> manually categorized{/if}{#if stats.locked > 0 && stats.split > 0}
              and
            {/if}{#if stats.split > 0}<strong>{stats.split}</strong> split{/if}
            transaction{stats.locked + stats.split === 1 ? '' : 's'} will be destroyed. That work is
            not recreated by re-importing the same files.
          </p>
        {/if}

        <p class="text-sm text-muted-foreground">
          Kept: accounts, templates, categories, keywords and exchange rates. This cannot be undone.
        </p>

        <div class="flex flex-col gap-1.5">
          <Label for="clear-confirm">Type <strong>{CONFIRM_WORD}</strong> to confirm</Label>
          <Input id="clear-confirm" bind:value={word} autocomplete="off" placeholder={CONFIRM_WORD} />
        </div>
      {/if}

      {#if error}<p class="text-sm text-destructive">{error}</p>{/if}

      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
        {#if !nothingToClear}
          <Button
            variant="destructive"
            disabled={word !== CONFIRM_WORD || clearing}
            onclick={clearAll}
          >
            {clearing ? 'Clearing…' : 'Clear everything'}
          </Button>
        {/if}
      </div>
    </div>
  {:else}
    <p class="text-sm text-destructive">{error}</p>
  {/if}
</Dialog>
