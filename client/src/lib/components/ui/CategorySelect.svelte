<script>
  import { untrack } from 'svelte';
  import { cn } from '$lib/utils.js';
  import CategoryIcon from './CategoryIcon.svelte';
  import Icon from './Icon.svelte';

  // A single searchable field that picks a category OR a category+subcategory
  // from a hierarchical, icon-decorated list. Replaces the old pair of dependent
  // <select>s. Selecting a category row clears the subcategory; selecting a
  // subcategory sets both. When `onCreateCategory` / `onCreateSubcategory` are
  // provided, the menu also offers inline creation.
  let {
    categories = [],
    categoryId = $bindable(''),
    subcategoryId = $bindable(''),
    onCreateCategory = null,
    onCreateSubcategory = null,
    placeholder = 'Select a category…',
    allowNone = false, // offer an "uncategorized" choice that clears the category
    autoOpen = false, // open the menu on mount (for inline row editing)
    onChange = null, // fired with { categoryId, subcategoryId } on a committed pick
    onClose = null, // fired whenever the menu closes (pick or cancel)
    // [{ categoryId, subcategoryId, recent }] offered above the full list while
    // nothing is typed — see $lib/recentCategories.js.
    suggestions = [],
    // An element around the picker (a popover holding other fields) whose
    // presses do not count as "outside" and so leave the menu open.
    within = null,
  } = $props();

  // Deliberately a one-shot read: `autoOpen` says how the menu *starts* (the
  // inline row editor wants it already open), and no caller flips it afterwards
  // — untrack says so out loud instead of leaving a reactivity warning behind.
  let open = $state(untrack(() => !!autoOpen));
  let query = $state('');
  let mode = $state('browse'); // 'browse' | 'newCategory' | 'newSub'
  let draftCat = $state('');
  let draftSub = $state('');
  let newSubTarget = $state(null); // category to add a subcategory under
  let busy = $state(false);
  let error = $state('');
  let rootEl;
  let searchEl = $state(null);

  const catById = $derived(new Map(categories.map((c) => [c.id, c])));
  const subById = $derived(
    new Map(categories.flatMap((c) => c.subcategories.map((s) => [s.id, { ...s, categoryId: c.id }]))),
  );
  const selectedCat = $derived(categoryId ? catById.get(Number(categoryId)) : null);
  const selectedSub = $derived(subcategoryId ? subById.get(Number(subcategoryId)) : null);

  // Categories (with their subcategories) matching the current search. A matching
  // category keeps all its subs; otherwise only the subs that match are kept.
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const out = [];
    for (const c of categories) {
      const catMatch = !q || c.name.toLowerCase().includes(q);
      const subs = c.subcategories.filter((s) => !q || catMatch || s.name.toLowerCase().includes(q));
      if (!q || catMatch || subs.length) out.push({ cat: c, subs });
    }
    return out;
  });

  const suggested = $derived(
    suggestions
      .map((p) => ({ ...p, cat: catById.get(p.categoryId), sub: p.subcategoryId != null ? subById.get(p.subcategoryId) : null }))
      .filter((p) => p.cat && (p.subcategoryId == null || p.sub)),
  );

  // Enter takes the first match of what was typed: the category if its own
  // name matched, else its first matching subcategory.
  function pickFirstMatch() {
    const q = query.trim().toLowerCase();
    const first = filtered[0];
    if (!q || !first) return;
    if (first.cat.name.toLowerCase().includes(q) || !first.subs.length) pickCategory(first.cat);
    else pickSub(first.cat, first.subs[0]);
  }

  // Focus the search box as soon as the menu opens in browse mode.
  $effect(() => {
    if (open && mode === 'browse' && searchEl) searchEl.focus();
  });

  function openMenu() {
    open = true;
    mode = 'browse';
    query = '';
    error = '';
  }
  function close() {
    open = false;
    mode = 'browse';
    query = '';
    draftCat = '';
    draftSub = '';
    newSubTarget = null;
    error = '';
    onClose?.();
  }
  function commit(cat, sub) {
    onChange?.({ categoryId: cat, subcategoryId: sub });
  }
  function pickCategory(c) {
    categoryId = String(c.id);
    subcategoryId = '';
    commit(String(c.id), '');
    close();
  }
  function pickSub(c, s) {
    categoryId = String(c.id);
    subcategoryId = String(s.id);
    commit(String(c.id), String(s.id));
    close();
  }
  function startNewCategory() {
    mode = 'newCategory';
    draftCat = query.trim();
    draftSub = '';
    error = '';
  }
  function startNewSub(c) {
    mode = 'newSub';
    newSubTarget = c;
    draftSub = '';
    error = '';
  }

  async function confirmNewCategory() {
    if (!draftCat.trim()) {
      error = 'Enter a category name.';
      return;
    }
    busy = true;
    error = '';
    try {
      const cid = await onCreateCategory(draftCat.trim());
      const sid = draftSub.trim() ? await onCreateSubcategory(cid, draftSub.trim()) : null;
      categoryId = String(cid);
      subcategoryId = sid ? String(sid) : '';
      commit(String(cid), sid ? String(sid) : '');
      close();
    } catch (e) {
      error = e?.message ?? 'Could not create the category.';
    } finally {
      busy = false;
    }
  }
  async function confirmNewSub() {
    if (!draftSub.trim()) {
      error = 'Enter a subcategory name.';
      return;
    }
    busy = true;
    error = '';
    try {
      const sid = await onCreateSubcategory(newSubTarget.id, draftSub.trim());
      categoryId = String(newSubTarget.id);
      subcategoryId = String(sid);
      commit(String(newSubTarget.id), String(sid));
      close();
    } catch (e) {
      error = e?.message ?? 'Could not create the subcategory.';
    } finally {
      busy = false;
    }
  }

  // Close on an outside press. Uses pointerdown (before the click fires) so the
  // in-menu buttons that swap the view — "New category/subcategory…" — aren't
  // mistaken for outside clicks once Svelte has torn down the row that was
  // clicked. composedPath() reflects the press's origin even mid-teardown.
  function onWindowPointerDown(e) {
    if (!open || !rootEl) return;
    const path = e.composedPath?.() ?? [];
    if (path.includes(rootEl) || rootEl.contains(e.target)) return;
    if (within && (path.includes(within) || within.contains(e.target))) return;
    close();
  }
  // Handle keys on the inner inputs (not the window) so stopPropagation keeps the
  // parent Dialog open and preventDefault keeps the outer <form> from submitting.
  function onSearchKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault(); // don't submit the keyword form
      pickFirstMatch();
    }
  }
  function onDraftKeydown(e, confirmFn) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      mode = 'browse';
    } else if (e.key === 'Enter') {
      e.preventDefault();
      confirmFn();
    }
  }

  const primaryBtn =
    'rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50';
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="relative" bind:this={rootEl}>
  <button
    type="button"
    onclick={() => (open ? close() : openMenu())}
    class="flex w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm outline-none transition focus:border-ring focus:ring-1 focus:ring-ring"
  >
    <span class="flex min-w-0 items-center gap-1.5">
      {#if selectedCat}
        <CategoryIcon name={selectedCat.icon} categoryId={selectedCat.id} size={16} class="shrink-0" />
        <span class="truncate text-foreground">{selectedCat.name}</span>
        {#if selectedSub}
          <span class="text-muted-foreground">›</span>
          <CategoryIcon name={selectedSub.icon} categoryId={selectedCat.id} size={14} class="shrink-0" />
          <span class="truncate text-muted-foreground">{selectedSub.name}</span>
        {/if}
      {:else}
        <span class="text-muted-foreground">{placeholder}</span>
      {/if}
    </span>
    <span class="shrink-0 text-muted-foreground"><Icon name="chevron-down" /></span>
  </button>

  {#if open}
    <div class="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-card shadow-lg">
      {#if mode === 'browse'}
        <div class="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <span class="text-muted-foreground"><Icon name="search" size={14} /></span>
          <input
            bind:this={searchEl}
            bind:value={query}
            onkeydown={onSearchKeydown}
            placeholder="Search categories & subcategories…"
            class="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div class="max-h-64 overflow-y-auto py-1">
          {#if suggested.length && !query.trim()}
            <p class="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Suggested</p>
            {#each suggested as p (`${p.categoryId}:${p.subcategoryId ?? ''}`)}
              <button
                type="button"
                onclick={() => (p.sub ? pickSub(p.cat, p.sub) : pickCategory(p.cat))}
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span class="flex w-4 shrink-0 justify-center"><CategoryIcon name={p.sub?.icon ?? p.cat.icon} categoryId={p.cat.id} size={15} /></span>
                <span class="min-w-0 truncate text-foreground">
                  {p.cat.name}{#if p.sub}<span class="text-muted-foreground">{' › '}{p.sub.name}</span>{/if}
                </span>
                {#if p.recent}<span class="ml-auto shrink-0 text-[10px] text-muted-foreground" title="Picked recently">recent</span>{/if}
              </button>
            {/each}
            <div class="my-1 border-t border-border"></div>
          {/if}
          {#if allowNone && !query.trim()}
            <button
              type="button"
              onclick={() => { categoryId = ''; subcategoryId = ''; commit('', ''); close(); }}
              class={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent', !categoryId ? 'bg-accent' : '')}
            >
              <span class="w-4 text-center text-muted-foreground">—</span>
              <span class="text-muted-foreground">Uncategorized</span>
            </button>
          {/if}
          {#each filtered as { cat, subs } (cat.id)}
            <button
              type="button"
              onclick={() => pickCategory(cat)}
              class={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent',
                String(cat.id) === categoryId && !subcategoryId ? 'bg-accent' : '',
              )}
            >
              <span class="flex w-4 shrink-0 justify-center"><CategoryIcon name={cat.icon} categoryId={cat.id} size={16} /></span>
              <span class="truncate font-medium text-foreground">{cat.name}</span>
            </button>
            {#each subs as s (s.id)}
              <button
                type="button"
                onclick={() => pickSub(cat, s)}
                class={cn(
                  'flex w-full items-center gap-2 py-1.5 pl-9 pr-3 text-left text-sm hover:bg-accent',
                  String(s.id) === subcategoryId ? 'bg-accent' : '',
                )}
              >
                <span class="flex w-3.5 shrink-0 justify-center"><CategoryIcon name={s.icon} categoryId={cat.id} size={14} /></span>
                <span class="truncate text-muted-foreground">{s.name}</span>
              </button>
            {/each}
            {#if onCreateSubcategory}
              <button
                type="button"
                onclick={() => startNewSub(cat)}
                class="flex w-full items-center gap-1.5 py-1 pl-9 pr-3 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Icon name="plus" size={12} /> New subcategory…
              </button>
            {/if}
          {/each}
          {#if filtered.length === 0}
            <p class="px-3 py-3 text-center text-sm text-muted-foreground">No matching categories.</p>
          {/if}
        </div>
        {#if onCreateCategory}
          <div class="border-t border-border p-1">
            <button
              type="button"
              onclick={startNewCategory}
              class="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-accent"
            >
              <Icon name="plus" />
              {query.trim() ? `New category “${query.trim()}”` : 'New category…'}
            </button>
          </div>
        {/if}
      {:else if mode === 'newCategory'}
        <div class="flex flex-col gap-2 p-3">
          <p class="text-sm font-medium text-foreground">New category</p>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:value={draftCat}
            onkeydown={(e) => onDraftKeydown(e, confirmNewCategory)}
            autofocus
            placeholder="Category name"
            class="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          />
          <input
            bind:value={draftSub}
            onkeydown={(e) => onDraftKeydown(e, confirmNewCategory)}
            placeholder="First subcategory (optional)"
            class="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          />
          {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
          <div class="flex justify-end gap-2">
            <button type="button" class="px-2 text-sm text-muted-foreground hover:text-foreground" onclick={() => (mode = 'browse')}>Back</button>
            <button type="button" disabled={busy} onclick={confirmNewCategory} class={primaryBtn}>{busy ? 'Creating…' : 'Create'}</button>
          </div>
        </div>
      {:else if mode === 'newSub'}
        <div class="flex flex-col gap-2 p-3">
          <p class="text-sm font-medium text-foreground">
            New subcategory under “{newSubTarget?.name}”
          </p>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:value={draftSub}
            onkeydown={(e) => onDraftKeydown(e, confirmNewSub)}
            autofocus
            placeholder="Subcategory name"
            class="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          />
          {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
          <div class="flex justify-end gap-2">
            <button type="button" class="px-2 text-sm text-muted-foreground hover:text-foreground" onclick={() => (mode = 'browse')}>Back</button>
            <button type="button" disabled={busy} onclick={confirmNewSub} class={primaryBtn}>{busy ? 'Creating…' : 'Create'}</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
