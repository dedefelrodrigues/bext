<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { navigate } from '$lib/router.svelte.js';
  import { KINDS, KIND_LABEL, amount } from '$lib/budget.js';
  import Card from '$lib/components/ui/Card.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';

  // The mapping behind the P&L: the lines (named by you, each of a kind), which
  // line every category and subcategory lands on, and the hashtags that send
  // their rows somewhere else. Each category shows how regularly it moved money
  // over the last 12 complete months, and the kind that suggests.

  let setup = $state(null);
  let loading = $state(true);
  let error = $state('');

  async function load() {
    try {
      setup = await api('/budget/setup');
      if (setup.lines.length === 0) {
        await api('/budget/propose', { method: 'POST', body: {} });
        setup = await api('/budget/setup');
      }
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load the setup.';
    } finally {
      loading = false;
    }
  }
  onMount(load);

  async function run(fn) {
    error = '';
    try {
      await fn();
      setup = await api('/budget/setup');
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not save.';
    }
  }

  const lines = $derived(setup?.lines ?? []);
  const lineById = $derived(new Map(lines.map((l) => [l.id, l])));
  const linesOf = (kind) => lines.filter((l) => l.kind === kind);

  // --- Lines ---------------------------------------------------------------
  let newName = $state(Object.fromEntries(KINDS.map((k) => [k.id, ''])));
  const addLine = (kind) =>
    run(async () => {
      const name = (newName[kind] ?? '').trim();
      if (!name) return;
      await api('/budget/lines', { method: 'POST', body: { name, kind } });
      newName = { ...newName, [kind]: '' };
    });
  const renameLine = (l, name) => {
    if (!name.trim() || name.trim() === l.name) return;
    run(() => api(`/budget/lines/${l.id}`, { method: 'PATCH', body: { name } }));
  };
  const changeKind = (l, kind) => run(() => api(`/budget/lines/${l.id}`, { method: 'PATCH', body: { kind } }));
  const deleteLine = (l) => run(() => api(`/budget/lines/${l.id}`, { method: 'DELETE' }));
  function move(l, dir) {
    const same = linesOf(l.kind).map((x) => x.id);
    const i = same.indexOf(l.id);
    const j = i + dir;
    if (j < 0 || j >= same.length) return;
    [same[i], same[j]] = [same[j], same[i]];
    run(() => api('/budget/lines/order', { method: 'POST', body: { ids: same } }));
  }

  // Usage per line, so a delete says what it would un-map.
  const usage = $derived.by(() => {
    const u = new Map();
    const bump = (id) => id != null && u.set(id, (u.get(id) ?? 0) + 1);
    for (const c of setup?.categories ?? []) {
      bump(c.lineId);
      for (const s of c.subcategories) bump(s.lineId);
    }
    for (const t of setup?.hashtags ?? []) bump(t.lineId);
    return u;
  });

  // --- Mapping ---------------------------------------------------------------
  const mapCategory = (c, value) => run(() => api('/budget/mapping', { method: 'PUT', body: { categoryId: c.id, lineId: value ? Number(value) : null } }));
  const mapSub = (s, value) => run(() => api('/budget/mapping', { method: 'PUT', body: { subcategoryId: s.id, lineId: value ? Number(value) : null } }));

  let openCats = $state(new Set());
  const toggleCat = (id) => {
    const next = new Set(openCats);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openCats = next;
  };

  function regularityText(stats) {
    if (!stats || stats.activeMonths === 0) return 'no movement in 12 months';
    const steady = stats.cv != null && stats.cv <= 0.35 ? ', steady' : '';
    return `${stats.activeMonths}/${setup.statsMonths} months${steady} · ${amount(stats.meanCents)}/mo`;
  }
  // The suggestion is only worth saying when the mapping disagrees with it.
  function disagreement(lineId, stats) {
    const kind = lineById.get(lineId)?.kind;
    if (!stats?.suggestion || !kind || kind === 'excluded') return null;
    return kind === stats.suggestion ? null : KIND_LABEL[stats.suggestion];
  }

  const unmapped = $derived(
    (setup?.categories ?? []).filter((c) => !c.isHidden && c.lineId == null && (c.subcategories.length === 0 || c.subcategories.some((s) => s.lineId == null))).length,
  );

  // --- Hashtags --------------------------------------------------------------
  const routed = $derived((setup?.hashtags ?? []).filter((t) => t.lineId != null).sort((a, b) => a.order - b.order || a.id - b.id));
  const unrouted = $derived((setup?.hashtags ?? []).filter((t) => t.lineId == null));
  const saveTags = (list) => run(() => api('/budget/hashtags', { method: 'PUT', body: { items: list.map((t) => ({ hashtagId: t.id, lineId: t.lineId })) } }));
  const defaultTagLine = $derived(linesOf('extraordinary')[0]?.id ?? lines[0]?.id);
  let tagToAdd = $state('');
  function addTag() {
    const t = unrouted.find((x) => String(x.id) === tagToAdd);
    if (!t || !defaultTagLine) return;
    tagToAdd = '';
    saveTags([...routed, { ...t, lineId: defaultTagLine }]);
  }
  const retargetTag = (t, lineId) => saveTags(routed.map((x) => (x.id === t.id ? { ...x, lineId: Number(lineId) } : x)));
  const removeTag = (t) => saveTags(routed.filter((x) => x.id !== t.id));
  function moveTag(t, dir) {
    const list = [...routed];
    const i = list.findIndex((x) => x.id === t.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    saveTags(list);
  }

  // --- Start over ------------------------------------------------------------
  let confirmReset = $state(false);
  const reset = () =>
    run(async () => {
      await api('/budget/propose', { method: 'POST', body: { reset: true } });
      confirmReset = false;
    });

  const selectCls = 'min-w-0 rounded-md border border-input bg-card px-2 py-1 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring';
</script>

{#snippet lineOptions()}
  {#each KINDS as k (k.id)}
    {#if linesOf(k.id).length}
      <optgroup label={k.label}>
        {#each linesOf(k.id) as l (l.id)}<option value={String(l.id)}>{l.name}</option>{/each}
      </optgroup>
    {/if}
  {/each}
{/snippet}

<div class="flex flex-col gap-6">
  <div class="flex items-baseline justify-between gap-4">
    <div>
      <h2 class="text-xl font-semibold">Budget</h2>
      <p class="text-sm text-muted-foreground">
        A row lands on its pinned line, else on the line of its first routed hashtag, else its subcategory's, else its category's.
      </p>
    </div>
    <div class="flex items-center gap-1">
      <button
        class="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={() => navigate('/budget')}
      >
        P&amp;L
      </button>
      <button class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-foreground">Setup</button>
    </div>
  </div>

  {#if error}<p class="text-sm text-destructive">{error}</p>{/if}

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if setup}
    <div class="grid gap-5 xl:grid-cols-[29rem_minmax(0,1fr)] xl:items-start">
      <!-- Lines, by kind -->
      <div class="flex flex-col gap-4">
        {#each KINDS as k (k.id)}
          <Card class="p-3">
            <p class="text-xs font-semibold uppercase tracking-wide">{k.label}</p>
            <p class="mb-2 text-xs text-muted-foreground">{k.hint}</p>
            <ul class="flex flex-col gap-1">
              {#each linesOf(k.id) as l, i (l.id)}
                <li class="flex items-center gap-1">
                  <input
                    value={l.name}
                    onchange={(e) => renameLine(l, e.currentTarget.value)}
                    class="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm hover:border-input focus:border-ring focus:outline-none"
                    aria-label="Line name"
                  />
                  <span class="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground" title="Categories, subcategories and hashtags mapped here">{usage.get(l.id) ?? 0}</span>
                  <select value={l.kind} onchange={(e) => changeKind(l, e.currentTarget.value)} class={selectCls + ' w-32'} aria-label="Kind of {l.name}">
                    {#each KINDS as kk (kk.id)}<option value={kk.id}>{kk.label}</option>{/each}
                  </select>
                  <IconButton onclick={() => move(l, -1)} disabled={i === 0} title="Move up" aria-label="Move {l.name} up"><Icon name="chevron-down" class="rotate-180" size={14} /></IconButton>
                  <IconButton onclick={() => move(l, 1)} disabled={i === linesOf(k.id).length - 1} title="Move down" aria-label="Move {l.name} down"><Icon name="chevron-down" size={14} /></IconButton>
                  <IconButton variant="danger" onclick={() => deleteLine(l)} title={usage.get(l.id) ? 'Delete — what is mapped here becomes unassigned' : 'Delete'} aria-label="Delete {l.name}"><Icon name="trash" size={14} /></IconButton>
                </li>
              {/each}
            </ul>
            <form class="mt-2 flex gap-2" onsubmit={(e) => { e.preventDefault(); addLine(k.id); }}>
              <Input bind:value={newName[k.id]} placeholder="New line" class="h-8 text-sm" />
              <Button variant="outline" type="submit" class="h-8 px-3 text-xs">Add</Button>
            </form>
          </Card>
        {/each}

        <Card class="p-3">
          <p class="text-sm font-semibold">Start over</p>
          <p class="mb-2 text-xs text-muted-foreground">Propose the starting set again from your categories.</p>
          {#if confirmReset}
            <p class="mb-2 text-xs text-destructive">This throws away every line, mapping, hashtag route and pinned transaction.</p>
            <div class="flex gap-2">
              <Button variant="destructive" class="h-8 px-3 text-xs" onclick={reset}>Start over</Button>
              <Button variant="outline" class="h-8 px-3 text-xs" onclick={() => (confirmReset = false)}>Cancel</Button>
            </div>
          {:else}
            <Button variant="outline" class="h-8 px-3 text-xs" onclick={() => (confirmReset = true)}>Start over…</Button>
          {/if}
        </Card>
      </div>

      <div class="flex flex-col gap-5">
        <!-- Category mapping -->
        <Card class="overflow-hidden">
          <div class="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h3 class="text-sm font-semibold">Categories</h3>
              <p class="text-xs text-muted-foreground">
                Regularity over the last {setup.statsMonths} complete months, in {setup.currency}. Hidden categories count wherever you map them.
              </p>
            </div>
            {#if unmapped}<span class="shrink-0 text-xs text-warning-foreground">{unmapped} not on a line</span>{/if}
          </div>
          <ul class="divide-y divide-border">
            {#each setup.categories as c (c.id)}
              {@const open = openCats.has(c.id)}
              {@const differs = disagreement(c.lineId, c.stats)}
              <li>
                <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 md:grid-cols-[minmax(0,1fr)_19rem_13rem]">
                  <div class="flex min-w-0 items-center gap-2">
                    {#if c.subcategories.length}
                      <button class="shrink-0 text-muted-foreground hover:text-foreground" onclick={() => toggleCat(c.id)} aria-expanded={open} aria-label={open ? `Collapse ${c.name}` : `Expand ${c.name}`}>
                        <Icon name="chevron-down" size={14} class={'transition ' + (open ? '' : '-rotate-90')} />
                      </button>
                    {:else}<span class="w-3.5 shrink-0"></span>{/if}
                    <CategoryIcon name={c.icon} categoryId={c.id} size={16} class="shrink-0" />
                    <span class="truncate text-sm font-medium">{c.name}</span>
                    {#if c.isHidden}<span class="shrink-0 rounded bg-accent px-1.5 py-px text-[11px] text-muted-foreground">hidden</span>{/if}
                  </div>
                  <p class="hidden truncate text-xs tabular-nums text-muted-foreground md:block">
                    {regularityText(c.stats)}{#if differs}<span class="text-warning-foreground">{` · looks ${differs.toLowerCase()}`}</span>{/if}
                  </p>
                  <select value={c.lineId != null ? String(c.lineId) : ''} onchange={(e) => mapCategory(c, e.currentTarget.value)} class={selectCls + ' w-full ' + (c.lineId == null && !c.isHidden ? 'border-warning-border' : '')} aria-label="Line for {c.name}">
                    <option value="">{c.isHidden ? 'Excluded (hidden)' : 'Unassigned'}</option>
                    {@render lineOptions()}
                  </select>
                </div>
                {#if open}
                  <ul class="border-t border-border bg-accent/20">
                    {#each c.subcategories as s (s.id)}
                      {@const sDiffers = disagreement(s.lineId ?? c.lineId, s.stats)}
                      <li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1.5 pl-12 pr-4 md:grid-cols-[minmax(0,1fr)_19rem_13rem]">
                        <span class="truncate text-sm text-muted-foreground">{s.name}</span>
                        <p class="hidden truncate text-xs tabular-nums text-muted-foreground md:block">
                          {regularityText(s.stats)}{#if sDiffers}<span class="text-warning-foreground">{` · looks ${sDiffers.toLowerCase()}`}</span>{/if}
                        </p>
                        <select value={s.lineId != null ? String(s.lineId) : ''} onchange={(e) => mapSub(s, e.currentTarget.value)} class={selectCls + ' w-full'} aria-label="Line for {s.name}">
                          <option value="">As category ({lineById.get(c.lineId)?.name ?? (c.isHidden ? 'excluded' : 'unassigned')})</option>
                          {@render lineOptions()}
                        </select>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        </Card>

        <!-- Hashtag routes -->
        <Card class="p-4">
          <h3 class="text-sm font-semibold">Hashtags that move rows</h3>
          <p class="mb-3 text-xs text-muted-foreground">
            Tag a trip or a renovation and every row carrying the tag lands on the line you pick here, whatever its category. When a row has two, the higher one wins.
          </p>
          {#if routed.length}
            <ul class="mb-3 flex flex-col gap-1">
              {#each routed as t, i (t.id)}
                <li class="flex items-center gap-1.5">
                  <span class="min-w-0 flex-1 truncate text-sm">#{t.name}</span>
                  <select value={String(t.lineId)} onchange={(e) => retargetTag(t, e.currentTarget.value)} class={selectCls + ' w-48'} aria-label="Line for #{t.name}">
                    {@render lineOptions()}
                  </select>
                  <IconButton onclick={() => moveTag(t, -1)} disabled={i === 0} title="Move up" aria-label="Move #{t.name} up"><Icon name="chevron-down" class="rotate-180" size={14} /></IconButton>
                  <IconButton onclick={() => moveTag(t, 1)} disabled={i === routed.length - 1} title="Move down" aria-label="Move #{t.name} down"><Icon name="chevron-down" size={14} /></IconButton>
                  <IconButton variant="danger" onclick={() => removeTag(t)} title="Stop routing this tag" aria-label="Stop routing #{t.name}"><Icon name="x" size={14} /></IconButton>
                </li>
              {/each}
            </ul>
          {/if}
          {#if unrouted.length}
            <div class="flex gap-2">
              <select bind:value={tagToAdd} class={selectCls + ' flex-1 py-1.5'} aria-label="Hashtag to route">
                <option value="">Pick a hashtag…</option>
                {#each unrouted as t (t.id)}<option value={String(t.id)}>#{t.name}</option>{/each}
              </select>
              <Button variant="outline" class="h-8 px-3 text-xs" onclick={addTag} disabled={!tagToAdd}>Route it</Button>
            </div>
          {:else if !routed.length}
            <p class="text-xs text-muted-foreground">You have no hashtags yet — add them on the transaction list.</p>
          {/if}
        </Card>
      </div>
    </div>
  {/if}
</div>
