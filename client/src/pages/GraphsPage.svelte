<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { auth } from '$lib/stores/auth.svelte.js';
  import { navigate } from '$lib/router.svelte.js';
  import { palette, colorFor, formatMoney, monthLabel } from '$lib/charts.js';
  import Card from '$lib/components/ui/Card.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import BarChart from '$lib/components/charts/BarChart.svelte';
  import LineChart from '$lib/components/charts/LineChart.svelte';
  import DonutChart from '$lib/components/charts/DonutChart.svelte';
  import HBars from '$lib/components/charts/HBars.svelte';
  import Legend from '$lib/components/charts/Legend.svelte';
  import CategoryExcluder from '$lib/components/CategoryExcluder.svelte';

  const pal = $derived(palette());

  // --- Filters (one row above the charts, shared by every report) ---
  let from = $state('');
  let to = $state('');
  let accountId = $state('');
  let holder = $state('');
  let business = $state('');
  let convert = $state(true);
  let currency = $state('');
  // Categories left out of every total on the page (e.g. "costs without Company").
  let excluded = $state([]);
  // Hidden categories are out of every total by default; this counts them in.
  let includeHidden = $state(false);

  let accounts = $state([]);
  let holders = $state([]);
  let categories = $state([]);

  // `loading` is the first load only; later refreshes set `refreshing`, which
  // leaves the charts mounted rather than collapsing the page (and with it the
  // scroll position) onto a one-line spinner.
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');

  // Report payloads.
  let monthly = $state(null);
  let byCategory = $state(null);
  let stacked = $state(null);
  let businessSeries = $state(null);
  let hashtagRows = $state(null);
  let timeline = $state(null);

  // Drill-down + timeline selection.
  let drillCategoryId = $state(null);
  let timelineCategoryId = $state('');

  // Which charts show their numbers instead of their marks. Every chart offers
  // this — it is the relief for the light-mode slots that sit under 3:1, and the
  // accessible fallback in general.
  let tableView = $state({});
  const toggleTable = (key) => (tableView = { ...tableView, [key]: !tableView[key] });

  function query(extra = {}) {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (accountId) params.set('accountId', accountId);
    if (holder) params.set('holder', holder);
    if (business) params.set('business', business);
    if (excluded.length) params.set('excludeCategoryIds', excluded.join(','));
    if (includeHidden) params.set('includeHidden', '1');
    if (!convert) params.set('convert', '0');
    else if (currency) params.set('currency', currency);
    for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') params.set(k, v);
    return params.toString();
  }

  async function load() {
    refreshing = true;
    error = '';
    try {
      const [m, c, s, b, h] = await Promise.all([
        api('/reports/monthly?' + query()),
        api('/reports/by-category?' + query()),
        api('/reports/monthly-by-category?' + query()),
        api('/reports/business?' + query()),
        api('/reports/hashtags?' + query()),
      ]);
      monthly = m;
      byCategory = c;
      stacked = s;
      businessSeries = b;
      hashtagRows = h;
      await Promise.all([loadDrill(), loadTimeline()]);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load reports.';
    } finally {
      refreshing = false;
      loading = false;
    }
  }

  async function loadDrill() {
    if (drillCategoryId == null) return;
    byCategory = await api('/reports/by-category?' + query({ level: 'sub', categoryIds: drillCategoryId }));
  }

  async function loadTimeline() {
    if (!timelineCategoryId) {
      timeline = null;
      return;
    }
    timeline = await api('/reports/monthly?' + query({ categoryIds: timelineCategoryId }));
  }

  onMount(async () => {
    const [a, c, h] = await Promise.all([api('/accounts'), api('/categories'), api('/transactions/holders')]);
    accounts = a;
    categories = c;
    holders = h;
    currency = auth.user?.defaultCurrency ?? '';
    await load();
  });

  function applyPeriod(kind) {
    const now = new Date();
    if (kind === 'all') {
      from = '';
      to = '';
    } else if (kind === 'ytd') {
      from = `${now.getFullYear()}-01-01`;
      to = '';
    } else if (kind === 'last12') {
      const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
      to = '';
    } else if (kind === 'prevYear') {
      const y = now.getFullYear() - 1;
      from = `${y}-01-01`;
      to = `${y}-12-31`;
    }
    load();
  }

  const periodIsAll = $derived(!from && !to);

  // --- Colors ------------------------------------------------------------
  // One key order for the whole page, taken from the stacked chart's series
  // (the server already ranks them and folds the tail into "Other"), so a
  // category wears the same hue in the donut, the stack and the timeline.
  const categoryKeys = $derived((stacked?.series ?? []).filter((s) => !s.isOther).map((s) => s.categoryId ?? 0));
  const categoryColor = (id) => colorFor(id ?? 0, categoryKeys, pal);

  const monthLabels = $derived((monthly?.months ?? []).map((m) => monthLabel(m.ym)));

  const incomeExpenseSeries = $derived([
    { key: 'income', name: 'Income', color: pal.polar.income, values: (monthly?.months ?? []).map((m) => m.income) },
    { key: 'expense', name: 'Expenses', color: pal.polar.expense, values: (monthly?.months ?? []).map((m) => m.expense) },
  ]);

  const stackedSeries = $derived(
    (stacked?.series ?? []).map((s) => ({
      key: s.isOther ? 'other' : s.categoryId ?? 0,
      name: s.name,
      color: s.isOther ? pal.other : categoryColor(s.categoryId),
      values: s.values,
    })),
  );

  const BUSINESS_LABELS = { business: 'Business', personal: 'Personal', mixed: 'Mixed' };
  const businessChartSeries = $derived(
    (businessSeries?.series ?? []).map((s, i) => ({
      key: s.flag,
      name: BUSINESS_LABELS[s.flag],
      color: pal.categorical[i],
      values: s.values,
    })),
  );

  // Donut: expense magnitudes only (income has no part-to-whole reading here).
  const donutSlices = $derived(
    (byCategory?.rows ?? [])
      .filter((r) => r.expense < 0)
      .map((r) => ({
        key: r.id ?? 0,
        name: r.name,
        value: -r.expense,
        color: drillCategoryId == null ? categoryColor(r.id) : colorFor(r.id ?? 0, (byCategory?.rows ?? []).map((x) => x.id ?? 0), pal),
        categoryId: r.categoryId,
      })),
  );

  const totals = $derived.by(() => {
    const months = monthly?.months ?? [];
    const income = months.reduce((s, m) => s + m.income, 0);
    const expense = months.reduce((s, m) => s + m.expense, 0);
    return { income, expense, net: income + expense };
  });

  const displayCurrency = $derived(monthly?.converted ? monthly.currency : '');
  const unconverted = $derived(monthly?.unconverted ?? 0);

  async function drillInto(slice) {
    if (drillCategoryId != null) return; // already inside a category
    drillCategoryId = slice.key || null;
    if (drillCategoryId == null) return; // "Uncategorized" has nothing to drill into
    await loadDrill();
  }

  // Turning hidden categories back off while drilled into one would leave the
  // page on an empty breakdown, so the drill-down comes out with it.
  async function hiddenChanged() {
    if (!includeHidden && drillCategoryId != null && categories.find((c) => c.id === drillCategoryId)?.isHidden) {
      drillCategoryId = null;
    }
    await load();
  }

  async function drillOut() {
    drillCategoryId = null;
    byCategory = await api('/reports/by-category?' + query());
  }

  const drillName = $derived(categories.find((c) => c.id === drillCategoryId)?.name ?? '');

  // The rail's controls are narrow and stacked, so they share one shape.
  const railSelect =
    'w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring';
</script>

<div class="flex flex-col gap-6">
  <div class="flex items-baseline justify-between gap-4">
    <div>
      <h2 class="text-xl font-semibold">Graphs</h2>
      <p class="text-sm text-muted-foreground">
        Split children count, not their parent; hidden categories are excluded unless you count them in.
      </p>
    </div>
    <div class="flex items-center gap-1">
      <button class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-foreground">Overview</button>
      <button
        class="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={() => navigate('/graphs/explore')}
      >
        Explore
      </button>
    </div>
  </div>

  <!-- Filters live in a rail beside the charts, not in a block above them:
       they are reachable at any scroll position, and "leave out" stays visible
       so an excluded category cannot silently skew what the page reads. -->
  <div class="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
    <aside class="lg:sticky lg:top-4">
      <Card class="flex flex-col gap-3 p-3">
        <div class="flex flex-col gap-1.5">
          <Label>Period</Label>
          <div class="flex flex-wrap gap-1">
            {#each [['all', 'All'], ['ytd', 'This year'], ['last12', 'Last 12 months'], ['prevYear', 'Last year']] as [kind, label] (kind)}
              <button
                class={'rounded-full border px-2.5 py-1 text-xs font-medium transition ' +
                  (kind === 'all' && periodIsAll
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground')}
                onclick={() => applyPeriod(kind)}
              >
                {label}
              </button>
            {/each}
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div class="flex flex-col gap-1.5">
            <Label for="g-from">From</Label>
            <Input id="g-from" type="date" bind:value={from} onchange={load} class="w-full px-2" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="g-to">To</Label>
            <Input id="g-to" type="date" bind:value={to} onchange={load} class="w-full px-2" />
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="g-account">Account</Label>
          <select id="g-account" bind:value={accountId} onchange={load} class={railSelect}>
            <option value="">All accounts</option>
            {#each accounts as a (a.id)}<option value={a.id}>{a.institutionName} · {a.name}</option>{/each}
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="g-holder">Holder</Label>
          <select id="g-holder" bind:value={holder} onchange={load} class={railSelect}>
            <option value="">Anyone</option>
            {#each holders as h (h)}<option value={h}>{h}</option>{/each}
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="g-business">Business</Label>
          <select id="g-business" bind:value={business} onchange={load} class={railSelect}>
            <option value="">Both</option>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
            <option value="mixed">Mixed</option>
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label>Amounts</Label>
          <div class="flex items-center gap-1.5">
            <button
              class="flex-1 rounded-md border border-input bg-card px-2 py-1.5 text-left text-xs hover:bg-accent"
              onclick={() => { convert = !convert; load(); }}
              title="Switch between one display currency and each transaction's own"
            >
              {convert ? `Converted to ${currency}` : 'Original currency'}
            </button>
            {#if convert}
              <Input bind:value={currency} maxlength="3" class="w-14 px-2 uppercase" onchange={load} />
            {/if}
          </div>
        </div>

        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input id="g-hidden" type="checkbox" bind:checked={includeHidden} onchange={hiddenChanged} />
          count hidden categories
        </label>

        <!-- A long category list would otherwise make the rail taller than the
             window, and a sticky rail you have to scroll to reach is no rail. -->
        <div class="max-h-[38vh] overflow-y-auto border-t border-border pt-3">
          <CategoryExcluder {categories} bind:excluded onchange={load} showHidden={includeHidden} compact />
        </div>

        {#if convert && unconverted > 0}
          <p class="rounded-md border border-warning-border bg-warning px-2 py-1.5 text-xs text-warning-foreground">
            {unconverted}
            {unconverted === 1 ? 'transaction has' : 'transactions have'} no rate to {monthly?.currency} and are counted unconverted.
            <button class="font-medium underline" onclick={() => navigate('/rates')}>Add rates</button>
          </p>
        {/if}
      </Card>
    </aside>

    <div class="min-w-0">
  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if monthly}
    <div
      class={'flex flex-col gap-5 transition-opacity ' + (refreshing ? 'opacity-60' : '')}
      aria-busy={refreshing}
    >
      <!-- Headline numbers: three figures, not three charts. -->
    <div class="grid gap-4 sm:grid-cols-3">
      {#each [['Income', totals.income], ['Expenses', totals.expense], ['Net', totals.net]] as [label, value] (label)}
        <Card class="p-4">
          <p class="text-xs text-muted-foreground">{label}</p>
          <p class="mt-1 text-2xl font-semibold">{formatMoney(value, displayCurrency)}</p>
        </Card>
      {/each}
    </div>

    <div class="grid gap-5 xl:grid-cols-2">
    <!-- 1. Monthly income vs expenses -->
    <Card class="p-5">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-sm font-semibold">Income vs expenses by month</h3>
        <Button variant="ghost" class="px-2 py-1 text-xs" onclick={() => toggleTable('monthly')}>
          {tableView.monthly ? 'Chart' : 'Table'}
        </Button>
      </div>
      {#if monthly.months.length === 0}
        <p class="text-sm text-muted-foreground">No transactions in this period.</p>
      {:else if tableView.monthly}
        <table class="w-full text-sm">
          <thead><tr class="text-left text-xs text-muted-foreground"><th class="py-1">Month</th><th class="py-1 text-right">Income</th><th class="py-1 text-right">Expenses</th><th class="py-1 text-right">Net</th></tr></thead>
          <tbody>
            {#each monthly.months as m (m.ym)}
              <tr class="border-t border-border tabular-nums">
                <td class="py-1">{monthLabel(m.ym, { long: true })}</td>
                <td class="py-1 text-right">{formatMoney(m.income, '')}</td>
                <td class="py-1 text-right">{formatMoney(m.expense, '')}</td>
                <td class="py-1 text-right">{formatMoney(m.net, displayCurrency)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <BarChart labels={monthLabels} series={incomeExpenseSeries} currency={displayCurrency} />
        <Legend class="mt-2" items={incomeExpenseSeries} />
      {/if}
    </Card>

    <!-- 2. Stacked monthly expenses by category -->
    <Card class="p-5">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-sm font-semibold">Expenses by category, by month</h3>
        <Button variant="ghost" class="px-2 py-1 text-xs" onclick={() => toggleTable('stacked')}>
          {tableView.stacked ? 'Chart' : 'Table'}
        </Button>
      </div>
      {#if stackedSeries.length === 0}
        <p class="text-sm text-muted-foreground">No expenses in this period.</p>
      {:else if tableView.stacked}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-muted-foreground">
                <th class="py-1">Category</th>
                {#each stacked.months as m (m)}<th class="py-1 text-right">{monthLabel(m)}</th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each stackedSeries as s (s.key)}
                <tr class="border-t border-border tabular-nums">
                  <td class="py-1">{s.name}</td>
                  {#each s.values as v, i (i)}<td class="py-1 text-right">{formatMoney(v, '')}</td>{/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <BarChart
          labels={stacked.months.map((m) => monthLabel(m))}
          series={stackedSeries}
          stacked
          currency={displayCurrency}
          height={300}
        />
        <Legend class="mt-2" items={stackedSeries} />
      {/if}
    </Card>

      <!-- 3. Category breakdown with subcategory drill-down -->
      <Card class="p-5">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm font-semibold">
            {drillCategoryId != null ? `${drillName} — subcategories` : 'Where the money went'}
          </h3>
          <div class="flex items-center gap-1">
            {#if drillCategoryId != null}
              <Button variant="ghost" class="px-2 py-1 text-xs" onclick={drillOut}>← All categories</Button>
            {/if}
          </div>
        </div>
        {#if donutSlices.length === 0}
          <p class="text-sm text-muted-foreground">No expenses in this period.</p>
        {:else}
          <DonutChart
            slices={donutSlices}
            currency={displayCurrency}
            centerLabel="Total spend"
            onselect={drillCategoryId == null ? drillInto : null}
          />
          {#if drillCategoryId == null}
            <p class="mt-3 text-xs text-muted-foreground">Click a category to see its subcategories.</p>
          {/if}
        {/if}
      </Card>

      <!-- 4. Single-category timeline -->
      <Card class="p-5">
        <div class="mb-3 flex items-center justify-between gap-3">
          <h3 class="text-sm font-semibold">Category over time</h3>
          <select
            bind:value={timelineCategoryId}
            onchange={loadTimeline}
            class="w-44 rounded-md border border-input bg-card px-2 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          >
            <option value="">Pick a category…</option>
            {#each categories as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
          </select>
        </div>
        {#if !timeline}
          <p class="text-sm text-muted-foreground">Pick a category to chart its monthly net.</p>
        {:else if timeline.months.length === 0}
          <p class="text-sm text-muted-foreground">Nothing in this category for the period.</p>
        {:else}
          <LineChart
            labels={timeline.months.map((m) => monthLabel(m.ym))}
            values={timeline.months.map((m) => m.net)}
            color={categoryColor(Number(timelineCategoryId))}
            currency={displayCurrency}
          />
        {/if}
      </Card>
      <!-- 5. Business vs personal over time -->
      <Card class="p-5">
        <h3 class="mb-3 text-sm font-semibold">Business vs personal</h3>
        {#if businessSeries.months.length === 0}
          <p class="text-sm text-muted-foreground">No expenses in this period.</p>
        {:else}
          <BarChart
            labels={businessSeries.months.map((m) => monthLabel(m))}
            series={businessChartSeries}
            stacked
            currency={displayCurrency}
            height={220}
          />
          <Legend class="mt-2" items={businessChartSeries} />
        {/if}
      </Card>

      <!-- 6. Spend per hashtag -->
      <Card class="p-5">
        <h3 class="mb-1 text-sm font-semibold">Spend per hashtag</h3>
        <p class="mb-3 text-xs text-muted-foreground">
          A transaction with two hashtags counts under both, so these need not sum to the period total.
        </p>
        {#if (hashtagRows?.rows ?? []).length === 0}
          <p class="text-sm text-muted-foreground">No hashtagged transactions in this period.</p>
        {:else}
          <HBars
            rows={hashtagRows.rows.filter((r) => r.expense < 0).map((r) => ({ key: r.id, name: r.name, value: -r.expense }))}
            currency={displayCurrency}
            color={pal.categorical[0]}
          />
        {/if}
      </Card>
      </div>
    </div>
  {/if}
    </div>
  </div>
</div>
