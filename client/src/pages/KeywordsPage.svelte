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
  import CategorySelect from '$lib/components/ui/CategorySelect.svelte';
  import { categoryPalette, categoryColor } from '$lib/categoryColors.js';

  const kwPalette = $derived(categoryPalette());

  let keywords = $state([]);
  let categories = $state([]);
  let globalDistance = $state(0);
  let loading = $state(true);
  let pageError = $state('');
  let fileInput;

  // Lookups derived from the category tree.
  const catById = $derived(new Map(categories.map((c) => [c.id, c])));
  const subById = $derived(
    new Map(categories.flatMap((c) => c.subcategories.map((s) => [s.id, { ...s, categoryId: c.id }]))),
  );

  // Filters
  let search = $state('');
  let filterCategory = $state('all');
  // 'all' | 'dead' (matched nothing) | 'override' (has its own distance)
  let filterKind = $state('all');

  // Sorting. Yield leads by default: the question this page is opened with is
  // usually "which rules are doing the work, and which have gone stale".
  let sortKey = $state('matches');
  let sortDir = $state('desc');

  function toggleSort(key) {
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      return;
    }
    sortKey = key;
    sortDir = key === 'matches' ? 'desc' : 'asc';
  }
  const ariaSort = (key) => (sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');

  const matched = $derived(
    keywords.filter((k) => {
      if (filterCategory !== 'all' && k.categoryId !== Number(filterCategory)) return false;
      if (filterKind === 'dead' && (k.matchCount ?? 0) > 0) return false;
      if (filterKind === 'override' && k.distance == null) return false;
      if (search.trim() && !k.text.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    }),
  );

  const visible = $derived.by(() => {
    const rows = [...matched];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let cmp;
      if (sortKey === 'matches') cmp = (a.matchCount ?? 0) - (b.matchCount ?? 0);
      else if (sortKey === 'category') {
        cmp = (catById.get(a.categoryId)?.name ?? '').localeCompare(catById.get(b.categoryId)?.name ?? '', undefined, { sensitivity: 'base' });
      } else cmp = a.text.localeCompare(b.text, undefined, { sensitivity: 'base' });
      if (cmp === 0) cmp = a.text.localeCompare(b.text, undefined, { sensitivity: 'base' });
      return cmp * dir;
    });
    return rows;
  });

  const deadCount = $derived(keywords.filter((k) => (k.matchCount ?? 0) === 0).length);
  const overrideCount = $derived(keywords.filter((k) => k.distance != null).length);
  const classified = $derived(keywords.reduce((sum, k) => sum + (k.matchCount ?? 0), 0));
  const busiest = $derived(Math.max(1, ...keywords.map((k) => k.matchCount ?? 0)));
  const countFormat = new Intl.NumberFormat(undefined);
  const count = (n) => countFormat.format(n ?? 0);

  // --- The side panel: the transactions one rule is holding ------------------
  //
  // Closed until a rule is clicked. It reads the transaction list filtered by
  // `keywordIds`, which is the same query the list page's keyword filter uses,
  // so what it shows is exactly what that rule owns.
  const PANEL_PAGE = 50;
  let panelKeyword = $state(null);
  let panelRows = $state([]);
  let panelTotal = $state(0);
  let panelLoading = $state(false);
  let panelError = $state('');

  async function openPanel(k) {
    panelKeyword = k;
    panelRows = [];
    panelTotal = 0;
    panelError = '';
    panelLoading = true;
    try {
      const res = await api(`/transactions?keywordIds=${k.id}&limit=${PANEL_PAGE}`);
      // A slow request for a rule you have already clicked away from must not
      // overwrite the one you are looking at now.
      if (panelKeyword?.id !== k.id) return;
      panelRows = res.transactions;
      panelTotal = res.total;
    } catch (err) {
      if (panelKeyword?.id !== k.id) return;
      panelError = err instanceof ApiError ? err.message : 'Could not load these transactions.';
    } finally {
      if (panelKeyword?.id === k.id) panelLoading = false;
    }
  }

  function closePanel() {
    panelKeyword = null;
    panelRows = [];
    panelTotal = 0;
    panelError = '';
  }

  function onKeydown(e) {
    // The dialog owns Escape while it is open — one press should close the
    // thing in front of you, not everything at once.
    if (e.key === 'Escape' && panelKeyword && !open) closePanel();
  }

  function money(cents, currency) {
    return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100) + ' ' + currency;
  }

  // A rule that was edited or deleted must not leave a stale panel behind.
  function syncPanel() {
    if (!panelKeyword) return;
    const fresh = keywords.find((k) => k.id === panelKeyword.id);
    if (!fresh) closePanel();
    else panelKeyword = fresh;
  }

  async function refresh() {
    pageError = '';
    try {
      const [kws, cats, settings] = await Promise.all([
        api('/keywords'),
        api('/categories'),
        api('/settings'),
      ]);
      keywords = kws;
      categories = cats;
      globalDistance = settings.globalFuzzyDistance;
      syncPanel();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not load keywords.';
    } finally {
      loading = false;
    }
  }
  onMount(refresh);

  // --- Keyword dialog ---
  let open = $state(false);
  let editing = $state(null);
  let text = $state('');
  let categoryId = $state(''); // '' = nothing chosen yet
  let subcategoryId = $state(''); // '' = no subcategory
  let distance = $state(''); // '' = use the global default
  let formError = $state('');
  let saving = $state(false);

  function openNew() {
    editing = null;
    text = '';
    categoryId = categories[0]?.id != null ? String(categories[0].id) : '';
    subcategoryId = '';
    distance = '';
    formError = '';
    open = true;
  }
  function openEdit(k) {
    editing = k;
    text = k.text;
    categoryId = String(k.categoryId);
    subcategoryId = k.subcategoryId != null ? String(k.subcategoryId) : '';
    distance = k.distance != null ? String(k.distance) : '';
    formError = '';
    open = true;
  }

  // Inline creation from the CategorySelect. Each creates the entity, refreshes
  // the category tree so the picker can display it, and returns the new id.
  async function createCategory(name) {
    const created = await api('/categories', { method: 'POST', body: { name } });
    categories = await api('/categories');
    return created.id;
  }
  async function createSubcategory(catId, name) {
    const created = await api(`/categories/${catId}/subcategories`, { method: 'POST', body: { name } });
    categories = await api('/categories');
    return created.id;
  }

  async function save(e) {
    e.preventDefault();
    formError = '';
    if (!categoryId) {
      formError = 'Choose a category.';
      return;
    }
    saving = true;
    try {
      const body = {
        text,
        categoryId: Number(categoryId),
        subcategoryId: subcategoryId === '' ? null : Number(subcategoryId),
        distance: distance === '' ? null : Number(distance),
      };
      if (editing) await api(`/keywords/${editing.id}`, { method: 'PATCH', body });
      else await api('/keywords', { method: 'POST', body });
      open = false;
      await refresh();
    } catch (err) {
      formError = err instanceof ApiError ? err.message : 'Could not save keyword.';
    } finally {
      saving = false;
    }
  }
  async function remove(k) {
    if (!window.confirm(`Delete keyword "${k.text}"? Transactions matched only by it become uncategorized.`)) return;
    try {
      await api(`/keywords/${k.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not delete keyword.';
    }
  }

  let recomputing = $state(false);
  async function recompute() {
    recomputing = true;
    pageError = '';
    try {
      const { changed } = await api('/keywords/recompute', { method: 'POST' });
      window.alert(`Re-ran classification: ${changed} transaction${changed === 1 ? '' : 's'} updated.`);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not re-run classification.';
    } finally {
      recomputing = false;
    }
  }

  // --- CSV export / import ---
  async function exportCsv() {
    try {
      const { csv } = await api('/keywords/export');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bext-keywords.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not export keywords.';
    }
  }
  async function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!window.confirm('Importing replaces ALL your current keywords and re-runs classification. Continue?')) return;
    try {
      const csv = await file.text();
      const res = await api('/keywords/import', { method: 'POST', body: { csv } });
      pageError = '';
      await refresh();
      window.alert(`Imported ${res.imported} keyword${res.imported === 1 ? '' : 's'}.`);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not import keywords — check the CSV.';
    }
  }

  function categoryLabel(k) {
    const cat = catById.get(k.categoryId);
    const sub = k.subcategoryId != null ? subById.get(k.subcategoryId) : null;
    return { cat, sub };
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div>
  <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-xl font-semibold">Keywords</h2>
      <p class="text-sm text-muted-foreground">
        {#if loading}
          Rules that classify transactions.
        {:else}
          {keywords.length} rule{keywords.length === 1 ? '' : 's'} holding {count(classified)} transaction{classified === 1 ? '' : 's'}. Global fuzzy
          distance is <span class="font-medium text-foreground">{globalDistance}</span> — set a per-keyword override to loosen or tighten a single rule.
        {/if}
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <Button variant="outline" onclick={recompute} disabled={recomputing}>{recomputing ? 'Reclassifying…' : 'Reclassify'}</Button>
      <Button variant="outline" onclick={exportCsv}><Icon name="download" />Export</Button>
      <Button variant="outline" onclick={() => fileInput.click()}><Icon name="upload" />Import</Button>
      <Button onclick={openNew} disabled={categories.length === 0}><Icon name="plus" />Add keyword</Button>
    </div>
  </div>
  <input type="file" accept="text/csv,.csv" class="hidden" bind:this={fileInput} onchange={onImportFile} />

  {#if pageError}
    <p class="mb-4 text-sm text-destructive">{pageError}</p>
  {/if}

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if categories.length === 0}
    <Card class="p-8 text-center">
      <p class="text-sm text-muted-foreground">Create a category first, then add keywords to classify transactions.</p>
    </Card>
  {:else}
    <!-- The panel is closed until a rule is clicked; when it opens the table
         gives up the width rather than the page scrolling sideways. -->
    <div class={'grid gap-4 ' + (panelKeyword ? 'xl:grid-cols-[minmax(0,1fr)_23rem] xl:items-start' : '')}>
      <div class="min-w-0">
        <Card class="mb-3 flex flex-wrap items-center gap-2 p-2.5">
          <Input placeholder="Search keywords…" bind:value={search} class="max-w-xs" />
          <select
            bind:value={filterCategory}
            class="rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          >
            <option value="all">All categories</option>
            {#each categories as c (c.id)}
              <option value={String(c.id)}>{c.name}</option>
            {/each}
          </select>
          {#each [['all', `All ${keywords.length}`], ['dead', `No matches ${deadCount}`], ['override', `Own distance ${overrideCount}`]] as [kind, label] (kind)}
            <button
              class={'rounded-full border px-2.5 py-1 text-xs transition ' +
                (filterKind === kind
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground')}
              onclick={() => (filterKind = kind)}
              aria-pressed={filterKind === kind}
            >
              {label}
            </button>
          {/each}
          <span class="ml-auto text-sm text-muted-foreground">{visible.length} of {keywords.length}</span>
        </Card>

        {#if keywords.length === 0}
          <Card class="p-8 text-center">
            <p class="text-sm text-muted-foreground">No keywords yet. Add one to start classifying transactions.</p>
          </Card>
        {:else if visible.length === 0}
          <Card class="p-8 text-center">
            <p class="text-sm text-muted-foreground">No keywords match your filters.</p>
          </Card>
        {:else}
          <Card class="overflow-hidden">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {#each [['text', 'Keyword', 'left'], ['category', 'Category', 'left'], ['matches', 'Matches', 'right']] as [key, label, align] (key)}
                    <th
                      scope="col"
                      class={'border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground ' +
                        (align === 'right' ? 'text-right' : 'text-left')}
                      aria-sort={ariaSort(key)}
                    >
                      <button class="inline-flex items-center gap-1 uppercase hover:text-foreground" onclick={() => toggleSort(key)}>
                        {label}
                        {#if sortKey === key}
                          <Icon name="chevron-down" size={12} class={sortDir === 'asc' ? 'rotate-180' : ''} />
                        {/if}
                      </button>
                    </th>
                  {/each}
                  <th scope="col" class="hidden border-b border-border px-3 py-2 lg:table-cell"><span class="sr-only">Share</span></th>
                  <th scope="col" class="border-b border-border px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Distance
                  </th>
                  <th scope="col" class="border-b border-border px-3 py-2"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {#each visible as k (k.id)}
                  {@const label = categoryLabel(k)}
                  {@const dead = (k.matchCount ?? 0) === 0}
                  <tr
                    class={'cursor-pointer transition hover:bg-accent ' +
                      (panelKeyword?.id === k.id ? 'bg-accent shadow-[inset_2px_0_0_var(--color-foreground)]' : '')}
                    onclick={() => openPanel(k)}
                    aria-selected={panelKeyword?.id === k.id}
                  >
                    <td class="border-b border-border px-3 py-2">
                      <span class="font-medium">{k.text}</span>
                      {#if dead}
                        <span
                          class="ml-1.5 rounded border border-warning-border bg-warning px-1.5 py-0.5 text-[11px] text-warning-foreground"
                          title="No transaction is currently classified by this rule — a typo, or a merchant you no longer use"
                        >
                          no matches
                        </span>
                      {/if}
                    </td>
                    <td class="border-b border-border px-3 py-2">
                      <span class="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <CategoryIcon name={label.cat?.icon} categoryId={label.cat?.id} size={14} class="shrink-0" />
                        <span class="truncate">{label.cat?.name ?? '—'}{#if label.sub}<span class="text-muted-foreground/70"> › {label.sub.name}</span>{/if}</span>
                      </span>
                    </td>
                    <td class="whitespace-nowrap border-b border-border px-3 py-2 text-right tabular-nums">{count(k.matchCount)}</td>
                    <td class="hidden w-40 border-b border-border px-3 py-2 lg:table-cell">
                      <span class="block h-1.5 w-full rounded-full bg-muted">
                        <span
                          class="block h-1.5 rounded-full"
                          style={`width: ${Math.round(((k.matchCount ?? 0) / busiest) * 100)}%; background: ${categoryColor(label.cat?.id, kwPalette) ?? 'currentColor'}`}
                        ></span>
                      </span>
                    </td>
                    <td class="whitespace-nowrap border-b border-border px-3 py-2 text-right">
                      {#if k.distance != null}
                        <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title="Per-keyword distance override">d={k.distance}</span>
                      {:else}
                        <span class="text-xs text-muted-foreground/60" title="Uses the global fuzzy distance">global</span>
                      {/if}
                    </td>
                    <td class="border-b border-border px-3 py-2">
                      <div class="flex justify-end gap-0.5">
                        <IconButton
                          onclick={(e) => { e.stopPropagation(); openEdit(k); }}
                          title="Edit keyword"
                          aria-label={`Edit ${k.text}`}
                        >
                          <Icon name="pencil" />
                        </IconButton>
                        <IconButton
                          variant="danger"
                          onclick={(e) => { e.stopPropagation(); remove(k); }}
                          title="Delete keyword"
                          aria-label={`Delete ${k.text}`}
                        >
                          <Icon name="trash" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </Card>
          <p class="mt-3 text-xs text-muted-foreground">
            Click a rule to see the transactions it is holding. "Matches" counts what each rule currently owns — a longer keyword that outranks
            it holds those rows instead, which is what <em>longest keyword wins</em> looks like from here.
          </p>
        {/if}
      </div>

      {#if panelKeyword}
        <aside class="xl:sticky xl:top-4">
          <Card class="flex max-h-[80vh] flex-col overflow-hidden">
            <header class="flex items-start gap-2 border-b border-border px-3 py-2.5">
              <div class="min-w-0">
                <p class="truncate font-semibold" title={panelKeyword.text}>{panelKeyword.text}</p>
                <p class="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CategoryIcon
                    name={categoryLabel(panelKeyword).cat?.icon}
                    categoryId={categoryLabel(panelKeyword).cat?.id}
                    size={12}
                    class="shrink-0"
                  />
                  <span class="truncate">
                    {categoryLabel(panelKeyword).cat?.name ?? '—'}{#if categoryLabel(panelKeyword).sub}
                      › {categoryLabel(panelKeyword).sub.name}
                    {/if}
                  </span>
                </p>
              </div>
              <IconButton class="ml-auto shrink-0" onclick={closePanel} title="Close (Esc)" aria-label="Close the panel">
                <Icon name="x" />
              </IconButton>
            </header>

            <div class="flex items-baseline gap-2 border-b border-border px-3 py-2">
              <span class="text-lg font-semibold tabular-nums">{count(panelTotal)}</span>
              <span class="text-xs text-muted-foreground">transaction{panelTotal === 1 ? '' : 's'} classified by this rule</span>
            </div>

            {#if panelError}
              <p class="px-3 py-3 text-sm text-destructive">{panelError}</p>
            {:else if panelLoading}
              <p class="px-3 py-3 text-sm text-muted-foreground">Loading…</p>
            {:else if panelRows.length === 0}
              <p class="px-3 py-3 text-sm text-muted-foreground">
                Nothing is classified by this rule right now. Either no description matches it, or a longer keyword is winning those rows.
              </p>
            {:else}
              <ul class="divide-y divide-border overflow-y-auto">
                {#each panelRows as tx (tx.id)}
                  <li class="px-3 py-2">
                    <div class="flex items-start gap-2">
                      <span class="min-w-0 flex-1 truncate text-sm" title={tx.description}>{tx.description}</span>
                      <span class={'shrink-0 whitespace-nowrap text-sm tabular-nums ' + (tx.amountCents < 0 ? 'text-foreground' : 'text-success')}>
                        {money(tx.amountCents, tx.currency)}
                      </span>
                    </div>
                    <p class="mt-0.5 truncate text-xs text-muted-foreground" title="{tx.accountName} · {tx.holder}">
                      {tx.date} · {tx.accountName}
                    </p>
                  </li>
                {/each}
              </ul>
              {#if panelTotal > panelRows.length}
                <p class="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                  Showing the first {panelRows.length}. Open Transactions and filter by this keyword to work through the rest.
                </p>
              {/if}
            {/if}
          </Card>
        </aside>
      {/if}
    </div>
  {/if}
</div>

<!-- Keyword dialog -->
<Dialog bind:open title={editing ? 'Edit keyword' : 'Add keyword'}>
  <form class="flex flex-col gap-4" onsubmit={save}>
    <div class="flex flex-col gap-1.5">
      <Label for="kw-text">Keyword</Label>
      <Input id="kw-text" bind:value={text} placeholder="e.g. żabka or orlen stacja" required />
      <p class="text-xs text-muted-foreground">Multi-word keywords match consecutive words in a description.</p>
    </div>
    <div class="flex flex-col gap-1.5">
      <Label>Category <span class="text-muted-foreground">› subcategory (optional)</span></Label>
      <CategorySelect
        {categories}
        bind:categoryId
        bind:subcategoryId
        onCreateCategory={createCategory}
        onCreateSubcategory={createSubcategory}
      />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="kw-dist">Distance override <span class="text-muted-foreground">(blank = global {globalDistance})</span></Label>
      <Input id="kw-dist" type="number" min="0" bind:value={distance} placeholder={String(globalDistance)} class="max-w-[8rem]" />
    </div>
    {#if formError}<p class="text-sm text-destructive">{formError}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="outline" type="button" onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
    </div>
  </form>
</Dialog>
