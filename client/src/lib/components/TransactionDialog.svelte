<script>
  import { untrack } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import CategorySelect from '$lib/components/ui/CategorySelect.svelte';

  // Create (tx null) or edit a transaction. Category + business apply to any row;
  // date/description/amount are editable only for manual rows. Hashtags are
  // attached/detached live. `onSaved` asks the parent to refresh the list.
  let { open = $bindable(false), tx = null, accounts = [], categories = [], defaultAccountId = null, onSaved, onCategoriesChanged } = $props();

  let accountId = $state('');
  let date = $state('');
  let description = $state('');
  let amountStr = $state('');
  let currency = $state('');
  let categoryId = $state('');
  let subcategoryId = $state('');
  let businessFlag = $state('personal');
  let hashtagList = $state([]);
  // Budget: a pin to a P&L line ('' = decided by hashtag/category) and a spread.
  let budgetLineId = $state('');
  let spreadMonths = $state(1);
  let budgetLines = $state([]);
  let newTag = $state('');
  let error = $state('');
  let saving = $state(false);

  const isCreate = $derived(!tx);
  const isManual = $derived(!tx || tx.isManual);

  function seed() {
    error = '';
    if (tx) {
      accountId = String(tx.accountId);
      date = tx.date;
      description = tx.description;
      amountStr = (tx.amountCents / 100).toFixed(2);
      currency = tx.currency;
      categoryId = tx.categoryId != null ? String(tx.categoryId) : '';
      subcategoryId = tx.subcategoryId != null ? String(tx.subcategoryId) : '';
      businessFlag = tx.businessFlag;
      hashtagList = [...(tx.hashtags ?? [])];
      budgetLineId = tx.budgetLineId != null ? String(tx.budgetLineId) : '';
      spreadMonths = tx.spreadMonths ?? 1;
      api('/budget/lines').then((l) => (budgetLines = l)).catch(() => (budgetLines = []));
    } else {
      accountId = defaultAccountId ? String(defaultAccountId) : accounts[0] ? String(accounts[0].id) : '';
      date = new Date().toISOString().slice(0, 10);
      description = '';
      amountStr = '';
      currency = '';
      categoryId = '';
      subcategoryId = '';
      businessFlag = 'personal';
      hashtagList = [];
    }
  }

  // Seed only when the dialog opens (untracked so parent refreshes don't wipe edits).
  let lastOpen = false;
  $effect(() => {
    if (open && !lastOpen) untrack(seed);
    lastOpen = open;
  });

  async function createCategory(name) {
    const created = await api('/categories', { method: 'POST', body: { name } });
    onCategoriesChanged?.();
    return created.id;
  }
  async function createSubcategory(catId, name) {
    const created = await api(`/categories/${catId}/subcategories`, { method: 'POST', body: { name } });
    onCategoriesChanged?.();
    return created.id;
  }

  async function save(e) {
    e.preventDefault();
    error = '';
    const amountCents = Math.round(parseFloat(amountStr) * 100);
    if (!Number.isFinite(amountCents)) {
      error = 'Enter a valid amount.';
      return;
    }
    saving = true;
    try {
      const cat = { categoryId: categoryId ? Number(categoryId) : null, subcategoryId: subcategoryId ? Number(subcategoryId) : null };
      if (isCreate) {
        await api('/transactions', { method: 'POST', body: { accountId: Number(accountId), date, description, amountCents, currency: currency || undefined, ...cat, businessFlag } });
      } else {
        const patch = { ...cat, businessFlag };
        const nextLine = budgetLineId ? Number(budgetLineId) : null;
        if (nextLine !== (tx.budgetLineId ?? null)) patch.budgetLineId = nextLine;
        const nextSpread = Math.max(1, Math.round(Number(spreadMonths) || 1));
        if (nextSpread !== (tx.spreadMonths ?? 1)) patch.spreadMonths = nextSpread;
        if (isManual) Object.assign(patch, { date, description, amountCents });
        await api(`/transactions/${tx.id}`, { method: 'PATCH', body: patch });
      }
      open = false;
      onSaved?.();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not save.';
    } finally {
      saving = false;
    }
  }

  async function addTag() {
    const name = newTag.trim();
    if (!name) return;
    try {
      hashtagList = (await api(`/transactions/${tx.id}/hashtags`, { method: 'POST', body: { name } })).hashtags;
      newTag = '';
      onSaved?.();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not add hashtag.';
    }
  }
  async function removeTag(id) {
    try {
      hashtagList = (await api(`/transactions/${tx.id}/hashtags/${id}`, { method: 'DELETE' })).hashtags;
      onSaved?.();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not remove hashtag.';
    }
  }

  async function resetClassification() {
    try {
      await api(`/transactions/${tx.id}/reset-classification`, { method: 'POST' });
      open = false;
      onSaved?.();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not reset.';
    }
  }
  async function remove() {
    if (!window.confirm('Delete this manual transaction?')) return;
    try {
      await api(`/transactions/${tx.id}`, { method: 'DELETE' });
      open = false;
      onSaved?.();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not delete.';
    }
  }

  const selectCls = 'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring';
  const accountName = $derived(accounts.find((a) => String(a.id) === accountId));
</script>

<Dialog bind:open title={isCreate ? 'Add transaction' : 'Edit transaction'}>
  <form class="flex flex-col gap-4" onsubmit={save}>
    <div class="flex flex-col gap-1.5">
      <Label>Account</Label>
      {#if isCreate}
        <select bind:value={accountId} class={selectCls}>
          {#each accounts as a (a.id)}<option value={String(a.id)}>{a.institutionName} · {a.name} ({a.currency})</option>{/each}
        </select>
      {:else}
        <p class="text-sm text-muted-foreground">{accountName?.name} · {tx.currency}{tx.isManual ? '' : ' · imported'}</p>
      {/if}
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="flex flex-col gap-1.5">
        <Label for="tx-date">Date</Label>
        {#if isManual}<Input id="tx-date" type="date" bind:value={date} required />{:else}<p class="py-2 text-sm text-muted-foreground">{date}</p>{/if}
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="tx-amount">Amount</Label>
        {#if isManual}
          <Input id="tx-amount" type="number" step="0.01" bind:value={amountStr} placeholder="-42.00" required />
        {:else}
          <p class="py-2 text-sm text-muted-foreground">{amountStr} {tx.currency}</p>
        {/if}
      </div>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="tx-desc">Description</Label>
      {#if isManual}<Input id="tx-desc" bind:value={description} required />{:else}<p class="py-2 text-sm text-muted-foreground">{description}</p>{/if}
    </div>

    <div class="flex flex-col gap-1.5">
      <Label>Category</Label>
      <CategorySelect {categories} bind:categoryId bind:subcategoryId allowNone placeholder="Uncategorized" onCreateCategory={createCategory} onCreateSubcategory={createSubcategory} />
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="tx-biz">Business / personal</Label>
      <select id="tx-biz" bind:value={businessFlag} class={selectCls}>
        <option value="personal">Personal</option>
        <option value="business">Business</option>
        <option value="mixed">Mixed</option>
      </select>
    </div>

    {#if !isCreate && budgetLines.length}
      <div class="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
        <div class="flex flex-col gap-1.5">
          <Label for="tx-line">Budget line</Label>
          <select id="tx-line" bind:value={budgetLineId} class={selectCls}>
            <option value="">Automatic</option>
            {#each budgetLines as l (l.id)}<option value={String(l.id)}>Pinned to {l.name}</option>{/each}
          </select>
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="tx-spread">Spread (months)</Label>
          <Input id="tx-spread" type="number" min="1" max="120" bind:value={spreadMonths} title="Count this amount in equal parts over this many months, from the month it was paid" />
        </div>
      </div>
    {/if}

    {#if !isCreate}
      <div class="flex flex-col gap-1.5">
        <Label>Hashtags</Label>
        <div class="flex flex-wrap items-center gap-1.5">
          {#each hashtagList as h (h.id)}
            <span class="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs">
              #{h.name}
              <button type="button" class="text-muted-foreground hover:text-destructive" onclick={() => removeTag(h.id)} aria-label="Remove hashtag">×</button>
            </span>
          {/each}
        </div>
        <div class="flex gap-2">
          <Input bind:value={newTag} placeholder="add hashtag" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} />
          <Button variant="outline" type="button" onclick={addTag}>Add</Button>
        </div>
      </div>
    {/if}

    {#if error}<p class="text-sm text-destructive">{error}</p>{/if}

    <div class="flex items-center justify-between gap-2">
      <div class="flex gap-2">
        {#if !isCreate && !tx.isManual && tx.isLocked}
          <Button variant="ghost" type="button" onclick={resetClassification} title="Revert to automatic classification">Reset to auto</Button>
        {/if}
        {#if !isCreate && tx.isManual}
          <Button variant="ghost" type="button" class="text-destructive" onclick={remove}>Delete</Button>
        {/if}
      </div>
      <div class="flex gap-2">
        <Button variant="outline" type="button" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  </form>
</Dialog>
