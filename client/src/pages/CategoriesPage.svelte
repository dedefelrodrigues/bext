<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';
  import IconPicker from '$lib/components/ui/IconPicker.svelte';
  import { categoryPalette, categoryColor } from '$lib/categoryColors.js';

  const catPalette = $derived(categoryPalette());

  let categories = $state([]);
  let loading = $state(true);
  let pageError = $state('');
  let fileInput;

  async function refresh() {
    pageError = '';
    try {
      categories = await api('/categories');
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not load categories.';
    } finally {
      loading = false;
    }
  }
  onMount(refresh);

  // --- Category dialog ---
  let catOpen = $state(false);
  let catEditing = $state(null);
  let catName = $state('');
  let catIcon = $state(null);
  let catBusiness = $state('personal');
  let catHidden = $state(false);
  let catCash = $state(false);
  let catError = $state('');
  let catSaving = $state(false);

  function openNewCategory() {
    catEditing = null;
    catName = '';
    catIcon = null;
    catBusiness = 'personal';
    catHidden = false;
    catCash = false;
    catError = '';
    catOpen = true;
  }
  function openEditCategory(cat) {
    catEditing = cat;
    catName = cat.name;
    catIcon = cat.icon;
    catBusiness = cat.businessDefault;
    catHidden = cat.isHidden;
    catCash = cat.isCashWithdrawal;
    catError = '';
    catOpen = true;
  }
  async function saveCategory(e) {
    e.preventDefault();
    catError = '';
    catSaving = true;
    const body = { name: catName, icon: catIcon, businessDefault: catBusiness, isHidden: catHidden, isCashWithdrawal: catCash };
    try {
      if (catEditing) await api(`/categories/${catEditing.id}`, { method: 'PATCH', body });
      else await api('/categories', { method: 'POST', body });
      catOpen = false;
      await refresh();
    } catch (err) {
      catError = err instanceof ApiError ? err.message : 'Could not save category.';
    } finally {
      catSaving = false;
    }
  }
  async function deleteCategory(cat) {
    if (!window.confirm(`Delete category "${cat.name}" and all its subcategories and keywords?`)) return;
    try {
      await api(`/categories/${cat.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not delete category.';
    }
  }

  // --- Subcategory dialog ---
  let subOpen = $state(false);
  let subEditing = $state(null);
  let subCategoryId = $state(null);
  let subName = $state('');
  let subIcon = $state(null);
  let subError = $state('');
  let subSaving = $state(false);

  function openNewSubcategory(cat) {
    subEditing = null;
    subCategoryId = cat.id;
    subName = '';
    subIcon = null;
    subError = '';
    subOpen = true;
  }
  function openEditSubcategory(cat, sub) {
    subEditing = sub;
    subCategoryId = cat.id;
    subName = sub.name;
    subIcon = sub.icon;
    subError = '';
    subOpen = true;
  }
  async function saveSubcategory(e) {
    e.preventDefault();
    subError = '';
    subSaving = true;
    const body = { name: subName, icon: subIcon };
    try {
      if (subEditing) await api(`/subcategories/${subEditing.id}`, { method: 'PATCH', body: { ...body, categoryId: subCategoryId } });
      else await api(`/categories/${subCategoryId}/subcategories`, { method: 'POST', body });
      subOpen = false;
      await refresh();
    } catch (err) {
      subError = err instanceof ApiError ? err.message : 'Could not save subcategory.';
    } finally {
      subSaving = false;
    }
  }
  async function deleteSubcategory(sub) {
    if (!window.confirm(`Delete subcategory "${sub.name}" and its keywords?`)) return;
    try {
      await api(`/subcategories/${sub.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not delete subcategory.';
    }
  }

  // --- Export / import ---
  async function exportJson() {
    try {
      const data = await api('/categories/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bext-categories.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not export categories.';
    }
  }
  async function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!window.confirm('Importing replaces ALL your current categories, subcategories, and keywords. Continue?')) return;
    try {
      const parsed = JSON.parse(await file.text());
      await api('/categories/import', { method: 'POST', body: parsed });
      await refresh();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not import — is the file valid JSON?';
    }
  }

  const businessLabel = { business: 'Business', personal: 'Personal', mixed: 'Mixed' };

  // The counts the list now returns. The bar is scaled against the busiest
  // category rather than the total, so the small ones stay visible instead of
  // all collapsing into a sliver next to Food & Drink.
  const busiest = $derived(Math.max(1, ...categories.map((c) => c.txCount ?? 0)));
  const totalTx = $derived(categories.reduce((sum, c) => sum + (c.txCount ?? 0), 0));
  const totalKw = $derived(categories.reduce((sum, c) => sum + (c.keywordCount ?? 0), 0));
  const totalSubs = $derived(categories.reduce((sum, c) => sum + c.subcategories.length, 0));

  const countFormat = new Intl.NumberFormat(undefined);
  const count = (n) => countFormat.format(n ?? 0);
  // Net, not spend: a refund belongs against the category it came back to, and
  // Income reads as the positive number it is.
  function money(cents) {
    const v = (cents ?? 0) / 100;
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0, signDisplay: 'auto' }).format(v);
  }

  // The server converts before summing, so the figure is in one currency; rows
  // no rate could reach are counted separately rather than silently mixed in.
  const displayCurrency = $derived(categories[0]?.currency ?? '');
  const unconvertedTotal = $derived(categories.reduce((sum, c) => sum + (c.unconvertedCount ?? 0), 0));
</script>

<div>
  <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-xl font-semibold">Categories</h2>
      <p class="text-sm text-muted-foreground">
        {#if loading}
          Organize categories, subcategories, and their classification keywords.
        {:else}
          {categories.length} categories · {totalSubs} subcategories · {totalKw} keyword{totalKw === 1 ? '' : 's'} · {count(totalTx)} transactions · net
          in {displayCurrency}{#if unconvertedTotal}<span class="text-warning-foreground" title="Rows with no exchange rate are counted unconverted">
              , {count(unconvertedTotal)} unconverted
            </span>{/if}
        {/if}
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <Button variant="outline" onclick={exportJson}><Icon name="download" />Export</Button>
      <Button variant="outline" onclick={() => fileInput.click()}><Icon name="upload" />Import</Button>
      <Button onclick={openNewCategory}><Icon name="plus" />Add category</Button>
    </div>
  </div>
  <input type="file" accept="application/json,.json" class="hidden" bind:this={fileInput} onchange={onImportFile} />

  {#if pageError}
    <p class="mb-4 text-sm text-destructive">{pageError}</p>
  {/if}

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if categories.length === 0}
    <Card class="p-8 text-center">
      <p class="text-sm text-muted-foreground">No categories yet. Add one to get started.</p>
    </Card>
  {:else}
    <!-- A card per category, flowing into as many columns as the window allows.
         Each one carries what the category is actually worth. -->
    <div class="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {#each categories as cat (cat.id)}
        <Card class="flex flex-col overflow-hidden">
          <header class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2.5">
            <CategoryIcon name={cat.icon} categoryId={cat.id} size={18} class="shrink-0" />
            <h3 class="min-w-0 truncate font-semibold" title={cat.name}>{cat.name}</h3>
            {#if cat.businessDefault !== 'personal'}
              <span class="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{businessLabel[cat.businessDefault]}</span>
            {/if}
            {#if cat.isHidden}
              <span class="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" title="Left out of lists, graphs and totals by default">Hidden</span>
            {/if}
            {#if cat.isCashWithdrawal}
              <span class="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" title="Transactions here feed the cash pool">Cash pool</span>
            {/if}
            <div class="ml-auto flex shrink-0 items-center gap-0.5">
              <IconButton class="h-7 w-7" onclick={() => openNewSubcategory(cat)} title="Add a subcategory" aria-label={`Add a subcategory to ${cat.name}`}>
                <Icon name="plus" size={14} />
              </IconButton>
              <IconButton class="h-7 w-7" onclick={() => openEditCategory(cat)} title="Edit category" aria-label={`Edit ${cat.name}`}>
                <Icon name="pencil" size={14} />
              </IconButton>
              <IconButton class="h-7 w-7" variant="danger" onclick={() => deleteCategory(cat)} title="Delete category" aria-label={`Delete ${cat.name}`}>
                <Icon name="trash" size={14} />
              </IconButton>
            </div>
          </header>

          {#if cat.subcategories.length === 0}
            <p class="px-3 py-3 text-sm text-muted-foreground">No subcategories.</p>
          {:else}
            <ul class="flex flex-col gap-0.5 p-1.5">
              {#each cat.subcategories as sub (sub.id)}
                <li class="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent">
                  <CategoryIcon name={sub.icon} categoryId={cat.id} size={13} class="shrink-0" />
                  <span class="min-w-0 truncate text-sm" title={sub.name}>{sub.name}</span>
                  <span
                    class="ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                    title={`${count(sub.txCount)} transaction${sub.txCount === 1 ? '' : 's'} · ${sub.keywordCount} keyword${sub.keywordCount === 1 ? '' : 's'}`}
                  >
                    {count(sub.txCount)} tx · {sub.keywordCount} kw
                  </span>
                  <span class="flex shrink-0 gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    <IconButton class="h-6 w-6" onclick={() => openEditSubcategory(cat, sub)} title="Edit subcategory" aria-label={`Edit ${sub.name}`}>
                      <Icon name="pencil" size={12} />
                    </IconButton>
                    <IconButton class="h-6 w-6" variant="danger" onclick={() => deleteSubcategory(sub)} title="Delete subcategory" aria-label={`Delete ${sub.name}`}>
                      <Icon name="trash" size={12} />
                    </IconButton>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}

          <footer class="mt-auto flex items-center gap-2.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span class="h-1.5 flex-1 rounded-full bg-muted" title={`${count(cat.txCount)} of ${count(totalTx)} transactions`}>
              <span
                class="block h-1.5 rounded-full"
                style={`width: ${Math.round(((cat.txCount ?? 0) / busiest) * 100)}%; background: ${categoryColor(cat.id, catPalette) ?? 'currentColor'}`}
              ></span>
            </span>
            <span class="shrink-0 tabular-nums text-foreground">{count(cat.txCount)} tx</span>
            <span class="shrink-0 text-muted-foreground/40">·</span>
            <span
              class="shrink-0 tabular-nums text-foreground"
              title={`Net of everything in this category, converted to ${displayCurrency}` +
                (cat.unconvertedCount ? ` — ${cat.unconvertedCount} row${cat.unconvertedCount === 1 ? '' : 's'} had no rate and are counted unconverted` : '')}
            >
              {money(cat.amountCents)}{#if cat.unconvertedCount}<span class="text-warning-foreground">*</span>{/if}
            </span>
            <span class="shrink-0 text-muted-foreground/40">·</span>
            <span class="shrink-0 tabular-nums" title={`${cat.keywordCount} keyword${cat.keywordCount === 1 ? '' : 's'} point here`}>{cat.keywordCount} kw</span>
          </footer>
        </Card>
      {/each}
    </div>
  {/if}
</div>

<!-- Category dialog -->
<Dialog bind:open={catOpen} title={catEditing ? 'Edit category' : 'Add category'}>
  <form class="flex flex-col gap-4" onsubmit={saveCategory}>
    <div class="flex flex-col gap-1.5">
      <Label for="cat-name">Name</Label>
      <Input id="cat-name" bind:value={catName} placeholder="e.g. Food & Drink" required />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label>Icon</Label>
      <IconPicker bind:value={catIcon} />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="cat-business">Business / personal default</Label>
      <select
        id="cat-business"
        bind:value={catBusiness}
        class="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
      >
        <option value="personal">Personal</option>
        <option value="business">Business</option>
        <option value="mixed">Mixed</option>
      </select>
    </div>
    <label class="flex items-center gap-2 text-sm text-foreground">
      <input type="checkbox" bind:checked={catHidden} /> Hidden (excluded from lists, graphs, and totals)
    </label>
    <label class="flex items-center gap-2 text-sm text-foreground">
      <input type="checkbox" bind:checked={catCash} /> Feeds the cash pool (ATM withdrawals)
    </label>
    {#if catError}<p class="text-sm text-destructive">{catError}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="outline" type="button" onclick={() => (catOpen = false)}>Cancel</Button>
      <Button type="submit" disabled={catSaving}>{catSaving ? 'Saving…' : 'Save'}</Button>
    </div>
  </form>
</Dialog>

<!-- Subcategory dialog -->
<Dialog bind:open={subOpen} title={subEditing ? 'Edit subcategory' : 'Add subcategory'}>
  <form class="flex flex-col gap-4" onsubmit={saveSubcategory}>
    <div class="flex flex-col gap-1.5">
      <Label for="sub-name">Name</Label>
      <Input id="sub-name" bind:value={subName} placeholder="e.g. Groceries" required />
    </div>
    {#if subEditing}
      <div class="flex flex-col gap-1.5">
        <Label for="sub-category">Category</Label>
        <select
          id="sub-category"
          bind:value={subCategoryId}
          class="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
        >
          {#each categories as cat (cat.id)}
            <option value={cat.id}>{cat.name}</option>
          {/each}
        </select>
        <p class="text-xs text-muted-foreground">
          Moving it takes its keywords and already-categorized transactions along.
        </p>
      </div>
    {/if}
    <div class="flex flex-col gap-1.5">
      <Label>Icon</Label>
      <IconPicker bind:value={subIcon} />
    </div>
    {#if subError}<p class="text-sm text-destructive">{subError}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="outline" type="button" onclick={() => (subOpen = false)}>Cancel</Button>
      <Button type="submit" disabled={subSaving}>{subSaving ? 'Saving…' : 'Save'}</Button>
    </div>
  </form>
</Dialog>
