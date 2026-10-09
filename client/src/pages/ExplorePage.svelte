<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { auth } from '$lib/stores/auth.svelte.js';
  import { navigate } from '$lib/router.svelte.js';
  import { palette, colorFor, formatMoney } from '$lib/charts.js';
  import Card from '$lib/components/ui/Card.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';
  import CategorySelect from '$lib/components/ui/CategorySelect.svelte';
  import DonutChart from '$lib/components/charts/DonutChart.svelte';
  import CategoryExcluder from '$lib/components/CategoryExcluder.svelte';

  // Explore: pick a period with toggles, see where it went on the left, and the
  // transactions behind it on the right. Both halves run off one filter set, so
  // the list is always the rows the chart counted — the one deliberate
  // exception is a picked subcategory, which narrows the list while the ring
  // stays on the whole category so its share is still readable.

  const pal = $derived(palette());
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const PAGE = 100;

  // --- Filters -----------------------------------------------------------
  // Months are a *set*, not a range: the toggles are the point of this page.
  // The from/to range is the escape hatch for a period the toggles can't say
  // (mid-month to mid-month); when both are set they simply AND.
  let selMonths = $state([]);
  let from = $state('');
  let to = $state('');
  let accountId = $state('');
  let holder = $state('');
  let business = $state('');
  // Expenses and income are two independent toggles rather than one either/or
  // dropdown: a period is often only readable with both on screen (what came
  // in, what went out, what is left). At least one stays on — with neither
  // there is nothing to draw.
  let showExpense = $state(true);
  let showIncome = $state(false);
  const type = $derived(showExpense && showIncome ? '' : showIncome ? 'income' : 'expense');
  let currency = $state('');
  let sort = $state('amount_desc');
  // Categories left out of every total on the page (e.g. "costs without Company").
  let excluded = $state([]);
  // Hidden categories (internal transfers and the like) are out of every total
  // by default; this counts them in, for the periods where one of them really
  // is income or a cost you want in the income-minus-expenses picture.
  let includeHidden = $state(false);

  // Category drill-down, driven by clicking a slice/bar on the left.
  let selCatId = $state(null);
  let selSubId = $state(null);

  let accounts = $state([]);
  let holders = $state([]);
  let categories = $state([]);
  let facets = $state({ months: [] });

  let breakdown = $state(null);
  let rows = $state([]);
  let total = $state(0);
  let offset = $state(0);
  // `loading` is the *first* load only. Every refresh after that sets
  // `refreshing` instead and leaves the two columns mounted: tearing them out
  // for a spinner collapses the page, and the browser drops the scroll position
  // — so a click on a slice bounced you back to the top of the page every time.
  let loading = $state(true);
  let refreshing = $state(false);
  let listLoading = $state(false);
  let error = $state('');

  // --- Period toggles ----------------------------------------------------
  // One row per year in the data: the year chip, then its twelve months. A
  // month with nothing in it is shown disabled rather than hidden, so the grid
  // stays aligned and the gaps in the data are visible.
  const years = $derived.by(() => {
    const byYear = new Map();
    for (const m of facets.months ?? []) {
      if (!/^\d{4}-\d{2}$/.test(m.ym)) continue;
      const y = m.ym.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, { year: y, count: 0, counts: new Map() });
      const e = byYear.get(y);
      e.count += m.count;
      e.counts.set(Number(m.ym.slice(5, 7)), m.count);
    }
    return [...byYear.values()].sort((a, b) => b.year.localeCompare(a.year));
  });

  // Ten years of data is ten rows of twelve buttons — far more grid than
  // anyone reads at once. A from/to pair decides which year rows are drawn;
  // it is only about what is *displayed*, never about what is counted (the
  // month toggles below still say that), so months picked in a year you then
  // scroll out of keep applying, and the page says so.
  let yearFrom = $state('');
  let yearTo = $state('');
  const allYears = $derived(years.map((y) => y.year)); // newest first
  const visibleYears = $derived(
    yearFrom && yearTo ? years.filter((y) => y.year >= yearFrom && y.year <= yearTo) : years,
  );
  const hiddenYearCount = $derived(years.length - visibleYears.length);
  const selectedOutsideView = $derived(
    selMonths.filter((ym) => !visibleYears.some((y) => ym.startsWith(y.year + '-'))).length,
  );

  // Open on the most recent three years that have data — enough to compare
  // against last year without burying the page.
  function defaultYearRange() {
    if (!allYears.length) return;
    yearTo = allYears[0];
    yearFrom = allYears[Math.min(2, allYears.length - 1)];
  }
  // The two ends cannot cross; moving one past the other pushes it along.
  function yearRangeChanged(which) {
    if (yearFrom > yearTo) {
      if (which === 'from') yearTo = yearFrom;
      else yearFrom = yearTo;
    }
  }

  const monthsOfYear = (y) => (facets.months ?? []).filter((m) => m.ym.startsWith(y + '-')).map((m) => m.ym);
  const yearState = (y) => {
    const all = monthsOfYear(y);
    const on = all.filter((ym) => selMonths.includes(ym)).length;
    return on === 0 ? 'off' : on === all.length ? 'all' : 'some';
  };

  function toggleMonth(ym) {
    selMonths = selMonths.includes(ym) ? selMonths.filter((m) => m !== ym) : [...selMonths, ym];
    reload();
  }
  function toggleYear(y) {
    const all = monthsOfYear(y);
    selMonths = yearState(y) === 'all' ? selMonths.filter((m) => !all.includes(m)) : [...new Set([...selMonths, ...all])];
    reload();
  }
  function clearPeriod() {
    selMonths = [];
    from = '';
    to = '';
    reload();
  }
  const periodIsAll = $derived(selMonths.length === 0 && !from && !to);

  // --- Queries -----------------------------------------------------------
  function baseParams() {
    const p = new URLSearchParams();
    if (selMonths.length) p.set('months', [...selMonths].sort().join(','));
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (accountId) p.set('accountId', accountId);
    if (holder) p.set('holder', holder);
    if (business) p.set('business', business);
    if (type) p.set('type', type);
    if (excluded.length) p.set('excludeCategoryIds', excluded.join(','));
    if (includeHidden) p.set('includeHidden', '1');
    return p;
  }

  async function toggleSide(which) {
    if (which === 'expense') {
      if (showExpense && !showIncome) return; // never leave both off
      showExpense = !showExpense;
    } else {
      if (showIncome && !showExpense) return;
      showIncome = !showIncome;
    }
    await reload();
  }

  async function loadBreakdown() {
    const p = baseParams();
    if (currency) p.set('currency', currency);
    if (selCatId != null) {
      p.set('level', 'sub');
      p.set('categoryIds', String(selCatId));
    }
    breakdown = await api('/reports/by-category?' + p.toString());
  }

  async function loadList(reset = true) {
    if (reset) offset = 0;
    listLoading = true;
    const p = baseParams();
    // A subcategory narrows; the server ORs categoryIds with subcategoryIds, so
    // once a subcategory is picked it is the only category filter sent.
    if (selSubId != null) p.set('subcategoryIds', String(selSubId));
    else if (selCatId != null) p.set('categoryIds', String(selCatId));
    p.set('sort', sort);
    p.set('limit', String(PAGE));
    p.set('offset', String(offset));
    try {
      const res = await api('/transactions?' + p.toString());
      rows = reset ? res.transactions : [...rows, ...res.transactions];
      total = res.total;
    } finally {
      listLoading = false;
    }
  }

  async function reload() {
    refreshing = true;
    error = '';
    try {
      await Promise.all([loadBreakdown(), loadList(true)]);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load this period.';
    } finally {
      refreshing = false;
      loading = false;
    }
  }

  async function loadMore() {
    offset += PAGE;
    try {
      await loadList(false);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load more transactions.';
    }
  }

  onMount(async () => {
    try {
      const [a, c, h, f] = await Promise.all([
        api('/accounts'),
        api('/categories'),
        api('/transactions/holders'),
        api('/transactions/facets'),
      ]);
      accounts = a;
      categories = c;
      holders = h;
      facets = f;
      currency = auth.user?.defaultCurrency ?? '';
      defaultYearRange();
      // Open on the most recent year that has data — an empty page on first
      // visit would say nothing about what the toggles do.
      const latest = years[0];
      if (latest) selMonths = monthsOfYear(latest.year);
      await reload();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load this page.';
      loading = false;
    }
  });

  // --- Chart data --------------------------------------------------------
  // Expense magnitudes, biggest first; the key list is fixed by that ranking so
  // a category keeps its hue between the ring and the bars beside it.
  // Two rings off one response — the by-category report always carries both
  // halves, so income costs no extra request. The colour ranking is shared
  // between them (biggest movement first, whichever direction it went), so a
  // category that both spends and earns wears one hue on both rings.
  const spendRows = $derived(
    (breakdown?.rows ?? []).filter((r) => r.expense < 0).map((r) => ({ ...r, value: -r.expense })),
  );
  const incomeRows = $derived(
    (breakdown?.rows ?? []).filter((r) => r.income > 0).map((r) => ({ ...r, value: r.income })),
  );
  const colorKeys = $derived(
    [...(breakdown?.rows ?? [])]
      .sort((a, b) => Math.max(-b.expense, b.income) - Math.max(-a.expense, a.income))
      .map((r) => r.id ?? 0),
  );
  const rowColor = (r) => colorFor(r.id ?? 0, colorKeys, pal);
  const toSlices = (rs) => rs.map((r) => ({ key: r.id ?? 0, name: r.name, value: r.value, color: rowColor(r) }));
  const spendSlices = $derived(showExpense ? toSlices(spendRows) : []);
  const incomeSlices = $derived(showIncome ? toSlices(incomeRows) : []);
  const spendTotal = $derived(spendRows.reduce((s, r) => s + r.value, 0));
  const incomeTotal = $derived(incomeRows.reduce((s, r) => s + r.value, 0));
  const bothSides = $derived(showExpense && showIncome);
  const nothingToShow = $derived(spendSlices.length === 0 && incomeSlices.length === 0);
  const displayCurrency = $derived(breakdown?.converted ? breakdown.currency : '');

  // A click on a slice or a bar: first level picks the category, second toggles
  // one of its subcategories. Rows with no id ("Uncategorized", "No
  // subcategory") have nothing to drill into, so they are inert.
  async function pick(row) {
    const id = row.id ?? row.key ?? null;
    if (!id) return;
    if (selCatId == null) {
      selCatId = id;
      selSubId = null;
    } else {
      selSubId = selSubId === id ? null : id;
    }
    await reload();
  }

  // Leaving out the category you happen to be drilled into would strand the
  // page on an empty ring, so the drill-down comes back out with it.
  async function excludeChanged(ids) {
    if (selCatId != null && ids.includes(selCatId)) {
      selCatId = null;
      selSubId = null;
    }
    await reload();
  }

  // The month toggles count the same rows the page does, so their counts have
  // to be reloaded with the flag; a drill-down into a category that is only
  // visible while hidden ones are counted comes back out with it.
  async function toggleHidden() {
    if (!includeHidden && selCatId != null && categories.find((c) => c.id === selCatId)?.isHidden) {
      selCatId = null;
      selSubId = null;
    }
    facets = await api('/transactions/facets' + (includeHidden ? '?includeHidden=1' : ''));
    await reload();
  }

  async function clearCategory() {
    selCatId = null;
    selSubId = null;
    await reload();
  }

  const selCatName = $derived(categories.find((c) => c.id === selCatId)?.name ?? '');
  const selSubName = $derived(
    (breakdown?.rows ?? []).find((r) => r.id === selSubId)?.name ?? '',
  );

  // --- Inline recategorization -------------------------------------------
  // The list is where a miscategorized row actually shows itself ("why is that
  // in Travel?"), so it is where it gets fixed — the same click-the-category
  // edit as the transactions page. A commit locks the row server-side, as any
  // manual categorization does.
  let editingCatId = $state(null);
  let editCatId = $state('');
  let editSubId = $state('');

  function startCatEdit(tx) {
    editingCatId = tx.id;
    editCatId = tx.categoryId != null ? String(tx.categoryId) : '';
    editSubId = tx.subcategoryId != null ? String(tx.subcategoryId) : '';
  }

  // Does a just-edited row still belong in what is on screen? Moving it out of
  // the category being drilled into — or into one that is left out, or hidden —
  // takes it out of the view it was answering for.
  function stillMatches(u) {
    if (u.category?.isHidden && !includeHidden) return false;
    if (u.categoryId != null && excluded.includes(u.categoryId)) return false;
    if (selSubId != null) return u.subcategoryId === selSubId;
    if (selCatId != null) return u.categoryId === selCatId;
    return true;
  }

  async function commitInlineCat(tx, v) {
    try {
      const updated = await api(`/transactions/${tx.id}`, {
        method: 'PATCH',
        body: {
          categoryId: v.categoryId ? Number(v.categoryId) : null,
          subcategoryId: v.subcategoryId ? Number(v.subcategoryId) : null,
        },
      });
      if (stillMatches(updated)) {
        rows = rows.map((r) => (r.id === updated.id ? updated : r));
      } else {
        rows = rows.filter((r) => r.id !== updated.id);
        total = Math.max(0, total - 1);
      }
      // The money moved between categories, so the ring beside the list is now
      // stale — refresh it in place rather than leaving a wrong total on screen.
      refreshing = true;
      await loadBreakdown();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not update the category.';
    } finally {
      refreshing = false;
    }
  }

  async function createCategory(name) {
    const c = await api('/categories', { method: 'POST', body: { name } });
    categories = await api('/categories');
    return c.id;
  }
  async function createSubcategory(catId, name) {
    const sub = await api(`/categories/${catId}/subcategories`, { method: 'POST', body: { name } });
    categories = await api('/categories');
    return sub.id;
  }

  function money(cents, ccy) {
    const v = (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return ccy ? `${v} ${ccy}` : v;
  }

  const periodLabel = $derived.by(() => {
    if (periodIsAll) return 'All time';
    const parts = [];
    if (selMonths.length) {
      const sorted = [...selMonths].sort();
      parts.push(
        selMonths.length === 1
          ? `${MONTHS[Number(sorted[0].slice(5, 7)) - 1]} ${sorted[0].slice(0, 4)}`
          : `${selMonths.length} months`,
      );
    }
    if (from || to) parts.push(`${from || '…'} → ${to || '…'}`);
    return parts.join(' · ');
  });
</script>

<div class="flex flex-col gap-6">
  <div class="flex items-baseline justify-between gap-4">
    <div>
      <h2 class="text-xl font-semibold">Explore</h2>
      <p class="text-sm text-muted-foreground">
        Toggle a period, click a category, read the transactions behind it.
      </p>
    </div>
    <div class="flex items-center gap-1">
      <button
        class="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={() => navigate('/graphs')}
      >
        Overview
      </button>
      <button class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-foreground">Explore</button>
    </div>
  </div>

  <!-- Period: a year row, its months beside it, every one a toggle — spread
       across the page, with the totals for whatever is selected beside it. -->
  <Card class="p-4">
    <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem] xl:gap-6">
      <div class="min-w-0">
    {#if allYears.length > 1}
      <div class="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span class="text-muted-foreground">Years</span>
        <select
          bind:value={yearFrom}
          onchange={() => yearRangeChanged('from')}
          class="rounded-md border border-input bg-card px-2 py-1 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          aria-label="First year shown"
        >
          {#each allYears as y (y)}<option value={y}>{y}</option>{/each}
        </select>
        <span class="text-muted-foreground">→</span>
        <select
          bind:value={yearTo}
          onchange={() => yearRangeChanged('to')}
          class="rounded-md border border-input bg-card px-2 py-1 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          aria-label="Last year shown"
        >
          {#each allYears as y (y)}<option value={y}>{y}</option>{/each}
        </select>
        {#if hiddenYearCount > 0}
          <span class="text-xs text-muted-foreground">
            {hiddenYearCount} more {hiddenYearCount === 1 ? 'year' : 'years'} in the data
            <button class="font-medium underline hover:text-foreground" onclick={() => { yearFrom = allYears[allYears.length - 1]; yearTo = allYears[0]; }}>
              show all
            </button>
          </span>
        {/if}
        {#if selectedOutsideView > 0}
          <span class="text-xs text-muted-foreground">
            · {selectedOutsideView} selected {selectedOutsideView === 1 ? 'month is' : 'months are'} outside these years and still counted
          </span>
        {/if}
      </div>
    {/if}

    <div class="flex flex-col gap-2">
      {#each visibleYears as y (y.year)}
        {@const ys = yearState(y.year)}
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            class={'w-16 shrink-0 rounded-md px-2 py-1 text-xs font-semibold tabular-nums transition ' +
              (ys === 'all'
                ? 'bg-primary text-primary-foreground'
                : ys === 'some'
                  ? 'bg-accent text-foreground ring-1 ring-inset ring-primary/40'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
            onclick={() => toggleYear(y.year)}
            title={`${y.count} transactions in ${y.year}`}
          >
            {y.year}
          </button>
          {#each MONTHS as label, i (label)}
            {@const ym = `${y.year}-${String(i + 1).padStart(2, '0')}`}
            {@const count = y.counts.get(i + 1) ?? 0}
            <button
              class={'w-11 rounded-md px-1 py-1 text-xs font-medium transition ' +
                (count === 0
                  ? 'cursor-default text-muted-foreground/30'
                  : selMonths.includes(ym)
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
              disabled={count === 0}
              onclick={() => toggleMonth(ym)}
              title={count ? `${count} transactions` : 'Nothing in this month'}
            >
              {label}
            </button>
          {/each}
        </div>
      {/each}
      {#if years.length === 0}
        <p class="text-sm text-muted-foreground">No transactions yet.</p>
      {/if}
    </div>

    <div class="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
      <div class="flex flex-col gap-1.5">
        <Label for="x-from">From</Label>
        <Input id="x-from" type="date" bind:value={from} onchange={reload} class="w-40" />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="x-to">To</Label>
        <Input id="x-to" type="date" bind:value={to} onchange={reload} class="w-40" />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="x-account">Account</Label>
        <select
          id="x-account"
          bind:value={accountId}
          onchange={reload}
          class="w-44 rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
        >
          <option value="">All accounts</option>
          {#each accounts as a (a.id)}<option value={a.id}>{a.institutionName} · {a.name}</option>{/each}
        </select>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="x-holder">Holder</Label>
        <select
          id="x-holder"
          bind:value={holder}
          onchange={reload}
          class="w-32 rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
        >
          <option value="">Anyone</option>
          {#each holders as h (h)}<option value={h}>{h}</option>{/each}
        </select>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="x-business">Business</Label>
        <select
          id="x-business"
          bind:value={business}
          onchange={reload}
          class="w-32 rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
        >
          <option value="">Both</option>
          <option value="business">Business</option>
          <option value="personal">Personal</option>
          <option value="mixed">Mixed</option>
        </select>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label>Show</Label>
        <div class="flex items-center gap-1">
          {#each [{ key: 'expense', label: 'Expenses', on: showExpense }, { key: 'income', label: 'Income', on: showIncome }] as side (side.key)}
            <button
              class={'rounded-md border px-3 py-2 text-sm transition ' +
                (side.on
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-input bg-card text-muted-foreground hover:bg-accent')}
              onclick={() => toggleSide(side.key)}
              aria-pressed={side.on}
              title={side.on ? `Hide ${side.label.toLowerCase()}` : `Show ${side.label.toLowerCase()}`}
            >
              {side.label}
            </button>
          {/each}
        </div>
      </div>

      <label class="flex items-center gap-1.5 pb-2 text-sm text-muted-foreground">
        <input type="checkbox" bind:checked={includeHidden} onchange={toggleHidden} /> hidden categories
      </label>

      <Button variant="outline" onclick={clearPeriod} disabled={periodIsAll}>Clear period</Button>
    </div>

    <div class="mt-4 border-t border-border pt-4">
      <CategoryExcluder {categories} bind:excluded onchange={excludeChanged} showHidden={includeHidden} />
    </div>

    {#if selMonths.length > 0 && (from || to)}
      <p class="mt-3 text-xs text-muted-foreground">
        The month toggles and the date range both apply — only transactions inside a selected month
        <em>and</em> the range are counted.
      </p>
    {/if}
      </div>

      <!-- What the selection adds up to. It used to sit under the ring, which
           described the categories; here it describes the period you picked. -->
      <div class="flex flex-col justify-start gap-1 border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Selected period</span>
          <span class="text-xs text-muted-foreground">{periodLabel}</span>
        </div>
        {#if showExpense}
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-sm text-muted-foreground">Total spend</span>
            <span class={'tabular-nums ' + (bothSides ? 'text-base font-medium' : 'text-xl font-semibold')}>
              {formatMoney(spendTotal, displayCurrency)}
            </span>
          </div>
        {/if}
        {#if showIncome}
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-sm text-muted-foreground">Total received</span>
            <span class={'tabular-nums ' + (bothSides ? 'text-base font-medium' : 'text-xl font-semibold')}>
              {formatMoney(incomeTotal, displayCurrency)}
            </span>
          </div>
        {/if}
        {#if bothSides}
          <div class="mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-2">
            <span class="text-sm text-muted-foreground">Net</span>
            <span class={'text-xl font-semibold tabular-nums ' + (incomeTotal - spendTotal < 0 ? '' : 'text-success')}>
              {formatMoney(incomeTotal - spendTotal, displayCurrency)}
            </span>
          </div>
        {/if}
        <p class="mt-1 text-xs text-muted-foreground">
          {total.toLocaleString()} {total === 1 ? 'transaction' : 'transactions'}
        </p>
        {#if breakdown?.unconverted > 0}
          <p class="text-xs text-muted-foreground">
            {breakdown.unconverted}
            {breakdown.unconverted === 1 ? 'transaction has' : 'transactions have'} no rate to
            {breakdown.currency} and are counted unconverted.
            <button class="font-medium underline" onclick={() => navigate('/rates')}>Add rates</button>
          </p>
        {/if}
      </div>
    </div>
  </Card>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else}
    <div
      class={'grid gap-5 transition-opacity xl:grid-cols-[24rem_minmax(0,1fr)] xl:items-start ' +
        (refreshing ? 'opacity-60' : '')}
      aria-busy={refreshing}
    >
      <!-- Left: where the money went in the selected period. -->
      <div class="flex flex-col gap-4">
        <Card class="p-5">
          <div class="mb-3 flex items-baseline justify-between gap-3">
            <h3 class="text-sm font-semibold">
              {selCatId != null
                ? `${selCatName} — subcategories`
                : bothSides
                  ? 'Where the money went, and where it came from'
                  : showIncome
                    ? 'Where the money came from'
                    : 'Where the money went'}
            </h3>
            <span class="text-xs text-muted-foreground">{periodLabel}</span>
          </div>

          {#if selCatId != null}
            <button
              class="mb-3 inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium hover:bg-accent/70"
              onclick={clearCategory}
            >
              ← All categories
            </button>
          {/if}

          {#if nothingToShow}
            <p class="text-sm text-muted-foreground">Nothing to show for this period.</p>
          {:else}
            {#if showExpense}
              <div class="flex flex-col gap-2">
                {#if bothSides}<h4 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Out</h4>{/if}
                {#if spendSlices.length}
                  <DonutChart slices={spendSlices} currency={displayCurrency} size={220} centerLabel="Spent" onselect={pick} />
                {:else}
                  <p class="text-sm text-muted-foreground">Nothing went out in this period.</p>
                {/if}
              </div>
            {/if}

            {#if showIncome}
              <div class={'flex flex-col gap-2 ' + (showExpense ? 'mt-5 border-t border-border pt-5' : '')}>
                {#if bothSides}<h4 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">In</h4>{/if}
                {#if incomeSlices.length}
                  <DonutChart slices={incomeSlices} currency={displayCurrency} size={220} centerLabel="Received" onselect={pick} />
                {:else}
                  <p class="text-sm text-muted-foreground">Nothing came in during this period.</p>
                {/if}
              </div>
            {/if}

            {#if selSubId != null}
              <p class="mt-2 text-xs text-muted-foreground">
                The ring still covers all of {selCatName}; the list beside it is narrowed to {selSubName}.
              </p>
            {/if}
          {/if}
        </Card>
      </div>

      <!-- Right: the transactions behind exactly those numbers. -->
      <Card class="flex flex-col p-5">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-semibold">Transactions</h3>
            <p class="text-xs text-muted-foreground">
              {total.toLocaleString()}
              {total === 1 ? 'transaction' : 'transactions'}
              {#if selCatId != null}
                in {selCatName}{#if selSubId != null} › {selSubName}{/if}
              {/if}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Label for="x-sort">Order by</Label>
            <select
              id="x-sort"
              bind:value={sort}
              onchange={() => loadList(true)}
              class="rounded-md border border-input bg-card px-2 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            >
              <option value="amount_desc">Value — largest first</option>
              <option value="amount_asc">Value — smallest first</option>
              <option value="date_desc">Date — newest first</option>
              <option value="date_asc">Date — oldest first</option>
              <option value="description">Description (A→Z)</option>
            </select>
          </div>
        </div>

        {#if (selCatId != null || selSubId != null)}
          <button
            class="mb-2 inline-flex w-fit items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium hover:bg-accent/70"
            onclick={clearCategory}
          >
            {selCatName}{#if selSubId != null} › {selSubName}{/if} ×
          </button>
        {/if}

        {#if rows.length === 0}
          <p class="text-sm text-muted-foreground">No transactions match this selection.</p>
        {:else}
          <!-- One line per transaction, the same ledger shape the transaction
               list uses, so the two read alike. -->
          <div class="exrow border-b border-border px-1 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>Date</span>
            <span>Description</span>
            <span class="hidden xl:block">Account</span>
            <span>Category</span>
            <span class="text-right">Amount</span>
          </div>
          <ul class="divide-y divide-border">
            {#each rows as tx (tx.id)}
              <li class="exrow px-1 py-2 hover:bg-accent/40">
                <span class="text-xs tabular-nums text-muted-foreground">{tx.date}</span>

                <span class="min-w-0 truncate text-sm" title={tx.description}>{tx.description}</span>

                <span class="hidden min-w-0 truncate text-xs text-muted-foreground xl:block" title="{tx.accountName} · {tx.holder}">
                  {tx.accountName}
                </span>

                <!-- relative, so the inline editor overlays rather than widening the column -->
                <div class="relative min-w-0">
                  {#if editingCatId === tx.id}
                    <div class="absolute left-0 top-1/2 z-30 w-72 -translate-y-1/2">
                      <CategorySelect
                        {categories}
                        bind:categoryId={editCatId}
                        bind:subcategoryId={editSubId}
                        allowNone
                        autoOpen
                        placeholder="Uncategorized"
                        onCreateCategory={createCategory}
                        onCreateSubcategory={createSubcategory}
                        onChange={(v) => commitInlineCat(tx, v)}
                        onClose={() => (editingCatId = null)}
                      />
                    </div>
                  {:else}
                    <button
                      class="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
                      onclick={() => startCatEdit(tx)}
                      title={tx.category ? `${tx.category.name}${tx.subcategory ? ' › ' + tx.subcategory.name : ''} — click to change` : 'Click to categorize'}
                    >
                      {#if tx.category}
                        <CategoryIcon name={tx.category.icon} categoryId={tx.category.id} size={12} class="shrink-0" />
                        <span class="truncate text-foreground">{tx.category.name}{#if tx.subcategory}<span class="text-muted-foreground"> › {tx.subcategory.name}</span>{/if}</span>
                      {:else}
                        <span class="truncate text-muted-foreground/60">Uncategorized</span>
                      {/if}
                      {#each tx.hashtags as h (h.id)}
                        <span class="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">#{h.name}</span>
                      {/each}
                    </button>
                  {/if}
                </div>

                <span class={'whitespace-nowrap text-right text-sm tabular-nums ' + (tx.amountCents < 0 ? 'text-foreground' : 'text-success')}>
                  {money(tx.amountCents, tx.currency)}
                </span>
              </li>
            {/each}
          </ul>

          {#if rows.length < total}
            <Button variant="outline" class="mt-3 self-start" onclick={loadMore} disabled={listLoading}>
              {listLoading ? 'Loading…' : `Load ${Math.min(PAGE, total - rows.length)} more`}
            </Button>
          {/if}

          <p class="mt-3 text-xs text-muted-foreground">
            Amounts here are in each transaction's own currency; the chart totals are converted.
            <button class="font-medium underline" onclick={() => navigate('/transactions')}>Open the full list</button>
            to edit, split or tag.
          </p>
        {/if}
      </Card>
    </div>
  {/if}
</div>

<style>
  /* date · description (elastic) · [account] · category · amount. The account
     column only exists above 1280px, and a display:none cell would still hold
     its track, so the template changes with it. */
  .exrow {
    display: grid;
    align-items: center;
    gap: 0.75rem;
    grid-template-columns: 4.75rem minmax(0, 1fr) 10rem 8rem;
  }
  @media (min-width: 1280px) {
    .exrow {
      grid-template-columns: 4.75rem minmax(0, 1fr) 9rem 11rem 8rem;
    }
  }
</style>
