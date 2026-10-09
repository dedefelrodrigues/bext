<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { auth } from '$lib/stores/auth.svelte.js';
  import { navigate } from '$lib/router.svelte.js';
  import { formatMoney, monthLabel } from '$lib/charts.js';
  import { KIND_LABEL, VIA_LABEL, amount } from '$lib/budget.js';
  import Card from '$lib/components/ui/Card.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';

  // --- The rail: which months, and whose money ---------------------------
  let windowMonths = $state(12);
  let year = $state(null); // a calendar year instead of the last N months
  let ahead = $state(null); // the month in progress and the next N instead
  let accountId = $state('');
  let holder = $state('');
  let business = $state('');
  let currency = $state('');

  let accounts = $state([]);
  let holders = $state([]);
  let firstYear = $state(null);
  let lines = $state([]);

  let st = $state(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let proposed = $state(false);

  function query(extra = {}) {
    const p = new URLSearchParams();
    if (year) p.set('year', year);
    else if (ahead) p.set('ahead', ahead);
    else p.set('window', windowMonths);
    if (accountId) p.set('accountId', accountId);
    if (holder) p.set('holder', holder);
    if (business) p.set('business', business);
    if (currency) p.set('currency', currency);
    for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, v);
    return p.toString();
  }

  async function load() {
    refreshing = true;
    error = '';
    try {
      st = await api('/budget/statement?' + query());
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not build the statement.';
    } finally {
      refreshing = false;
      loading = false;
    }
    if (panel) loadPanel();
  }

  onMount(async () => {
    currency = auth.user?.defaultCurrency ?? '';
    try {
      const [a, h, oldest, l] = await Promise.all([
        api('/accounts'),
        api('/transactions/holders'),
        api('/transactions?sort=date_asc&limit=1&includeHidden=1'),
        api('/budget/lines'),
      ]);
      accounts = a;
      holders = h;
      lines = l;
      firstYear = Number(oldest.transactions?.[0]?.date?.slice(0, 4)) || null;
      // First open: propose lines from the categories rather than a blank page.
      if (lines.length === 0) {
        lines = (await api('/budget/propose', { method: 'POST', body: {} })).lines;
        proposed = lines.length > 0;
      }
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load the page.';
    }
    await load();
  });

  function pickWindow(n) {
    windowMonths = n;
    year = null;
    ahead = null;
    load();
  }
  function pickAhead(n) {
    ahead = n;
    year = null;
    load();
  }
  function pickYear(y) {
    year = y;
    ahead = null;
    load();
  }

  // Years with data, newest first — running forward to the last month anything
  // reaches (a purchase spread into next year makes next year selectable).
  const years = $derived.by(() => {
    const now = new Date().getFullYear();
    const last = Math.max(now, Number(st?.horizon?.slice(0, 4)) || now);
    const out = [];
    for (let y = last; y >= (firstYear ?? now); y--) out.push(y);
    return out;
  });

  // --- The statement as rows -------------------------------------------------
  //
  // Groups (one per kind) carry their lines; the three subtotals sit between
  // them where a P&L puts them. Lines expand into categories (or hashtags) and
  // those into subcategories. Groups start open, lines closed.
  const ORDER = ['income', 'tax', '=netIncome', 'committed', '=discretionary', 'fixed', 'periodic', 'variable', 'unassigned', '=normalResult', 'extraordinary', '=netResult', 'excluded'];
  const SUBTOTAL = { netIncome: 'Net income', discretionary: 'Discretionary income', normalResult: 'Normal-month result', netResult: 'Net result' };

  let collapsedGroups = $state(new Set(['excluded']));
  let expanded = $state(new Set());
  const toggle = (set, key) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const rows = $derived.by(() => {
    if (!st) return [];
    const out = [];
    const byKind = new Map(st.groups.map((g) => [g.kind, g]));
    for (const step of ORDER) {
      if (step.startsWith('=')) {
        const key = step.slice(1);
        out.push({ ...st.subtotals[key], type: 'subtotal', key, name: SUBTOTAL[key] });
        continue;
      }
      const g = byKind.get(step);
      if (!g) continue;
      out.push({ ...g, type: 'group', key: `g:${g.kind}`, name: KIND_LABEL[g.kind] });
      if (collapsedGroups.has(g.kind)) continue;
      for (const line of g.lines) {
        const lk = `l:${line.key}`;
        out.push({ ...line, type: 'line', key: lk, line, depth: 1, excluded: g.kind === 'excluded' });
        if (!expanded.has(lk)) continue;
        for (const node of line.children) {
          const nk = `${lk}|${node.key}`;
          out.push({ ...node, nodeType: node.type, type: 'node', key: nk, line, path: [node.key], depth: 2, excluded: g.kind === 'excluded' });
          if (!expanded.has(nk)) continue;
          for (const leaf of node.children) {
            out.push({ ...leaf, nodeType: leaf.type, type: 'node', key: `${nk}|${leaf.key}`, line, path: [node.key, leaf.key], depth: 3, excluded: g.kind === 'excluded', children: [] });
          }
        }
      }
    }
    return out;
  });

  const columns = $derived(st?.columns ?? []);
  const cur = $derived(st?.currency ?? '');
  const hasCurrent = $derived(columns.some((c) => c.current));
  const hasFuture = $derived(columns.some((c) => c.future));
  const aheadOnly = $derived(st?.averagedOver === 'future');
  // Months ahead are shaded: what they show is committed, not spent.
  const colShade = (c) => (c?.future ? 'bg-accent/30 ' : '');

  function columnLabel(c, i) {
    const m = monthLabel(c.ym);
    return i === 0 || c.ym.endsWith('-01') ? `${m} ’${c.ym.slice(2, 4)}` : m;
  }

  // --- The average month, in a sentence of figures -------------------------
  const groupMean = (kinds, pick = 'mean') => (st?.groups ?? []).filter((g) => kinds.includes(g.kind)).reduce((s, g) => s + g[pick], 0);
  const headline = $derived.by(() => {
    if (!st) return [];
    const income = groupMean(['income']);
    const net = st.subtotals.netResult.mean;
    const extraordinary = groupMean(['extraordinary']);
    return [
      { label: 'Net income', value: st.subtotals.netIncome.mean, total: st.subtotals.netIncome.total, note: `after ${amount(-groupMean(['tax']))} taxes` },
      { label: 'Committed', value: groupMean(['committed']), total: null, note: 'known yearly costs, per month' },
      { label: 'Discretionary income', value: st.subtotals.discretionary.mean, total: st.subtotals.discretionary.total, note: 'after taxes and commitments' },
      { label: 'Living costs', value: groupMean(['fixed', 'periodic', 'variable', 'unassigned']), total: null, note: `${amount(-groupMean(['fixed']))} of it fixed` },
      { label: 'Normal-month result', value: st.subtotals.normalResult.mean, total: st.subtotals.normalResult.total, note: 'before one-offs' },
      { label: 'Net result', value: net, total: st.subtotals.netResult.total, note: [extraordinary ? `after ${amount(-extraordinary)} one-offs` : '', income > 0 ? `${Math.round((net / income) * 100)}% of income kept` : ''].filter(Boolean).join(' · ') },
    ];
  });

  // --- The drill-down panel --------------------------------------------------
  let panel = $state(null); // { lineKey, lineName, path, nodeName, month }
  let panelData = $state(null);
  let panelLoading = $state(false);
  let panelError = $state('');

  function openCell(row, month) {
    panel = {
      lineKey: row.line.key,
      lineName: row.line.name,
      path: row.path ?? [],
      nodeName: row.type === 'node' ? row.name : null,
      month,
    };
    loadPanel();
  }

  async function loadPanel() {
    const p = panel;
    panelLoading = true;
    panelError = '';
    try {
      const data = await api('/budget/rows?' + query({ line: p.lineKey, node: p.path.join(','), month: p.month }));
      if (panel === p) panelData = data;
    } catch (err) {
      if (panel === p) panelError = err instanceof ApiError ? err.message : 'Could not load these transactions.';
    } finally {
      if (panel === p) panelLoading = false;
    }
  }

  function closePanel() {
    panel = null;
    panelData = null;
  }
  function onKeydown(e) {
    if (e.key === 'Escape' && panel) closePanel();
  }

  const panelPeriod = $derived.by(() => {
    if (!panel) return '';
    if (panel.month) {
      const c = columns.find((x) => x.ym === panel.month);
      return monthLabel(panel.month, { long: true }) + (c?.current ? ' (so far)' : c?.future ? ' (committed)' : '');
    }
    return aheadOnly ? `the ${st?.averagedCount ?? ''} months ahead (committed)` : `the ${st?.averagedCount ?? ''} complete months`;
  });

  let saving = $state(null);
  async function patchRow(tx, body) {
    saving = tx.id;
    panelError = '';
    try {
      await api(`/transactions/${tx.id}`, { method: 'PATCH', body });
      await load();
    } catch (err) {
      panelError = err instanceof ApiError ? err.message : 'Could not save.';
    } finally {
      saving = null;
    }
  }

  // Mean and Total stay pinned to the right edge, as the names are to the left,
  // so a long window scrolls its months between them. With border-collapse a
  // border does not travel with a sticky cell, so the divider is a shadow.
  const MEAN = 'sticky right-[5.5rem] z-10 w-[4.5rem] min-w-[4.5rem] max-w-[4.5rem] shadow-[inset_1px_0_0_var(--color-border)] ';
  const TOTAL = 'sticky right-0 z-10 w-[5.5rem] min-w-[5.5rem] max-w-[5.5rem] ';

  const railSelect =
    'w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring';
  const chip = (on) =>
    'rounded-full border px-2.5 py-1 text-xs font-medium transition ' +
    (on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground');
  const cellCls = (v, c) =>
    'w-full rounded px-0.5 py-1 text-right tabular-nums transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
    (v === 0 ? 'text-muted-foreground/50 ' : '') +
    (c?.current ? 'italic text-muted-foreground ' : '') +
    (c?.future && v !== 0 ? 'text-muted-foreground ' : '');
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex flex-col gap-6">
  <div class="flex items-baseline justify-between gap-4">
    <div>
      <h2 class="text-xl font-semibold">Budget</h2>
      <p class="text-sm text-muted-foreground">
        Your months as a P&amp;L. Averages use complete months only; costs are negative. Click any figure for the rows behind it.
      </p>
    </div>
    <div class="flex items-center gap-1">
      <button class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-foreground">P&amp;L</button>
      <button
        class="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={() => navigate('/budget/setup')}
      >
        Setup
      </button>
    </div>
  </div>

  {#if proposed}
    <div class="flex items-center justify-between gap-3 rounded-lg border border-border bg-accent/40 px-4 py-2.5 text-sm">
      <span>These lines were proposed from your categories and how regularly each one occurs. Rename, merge and remap them as you like.</span>
      <div class="flex shrink-0 items-center gap-2">
        <button class="font-medium underline" onclick={() => navigate('/budget/setup')}>Review in Setup</button>
        <IconButton onclick={() => (proposed = false)} title="Dismiss" aria-label="Dismiss"><Icon name="x" /></IconButton>
      </div>
    </div>
  {/if}

  <div class="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
    <aside class="lg:sticky lg:top-4">
      <Card class="flex flex-col gap-3 p-3">
        <div class="flex flex-col gap-1.5">
          <Label>Window</Label>
          <div class="flex flex-wrap gap-1">
            {#each [3, 6, 12, 24] as n (n)}
              <button class={chip(!year && !ahead && windowMonths === n)} onclick={() => pickWindow(n)}>Last {n} months</button>
            {/each}
          </div>
          <div class="flex flex-wrap gap-1">
            {#each [3, 6, 12] as n (n)}
              <button class={chip(!year && ahead === n)} onclick={() => pickAhead(n)} title="The month in progress and the next {n}: what spread purchases have already committed">Next {n} months</button>
            {/each}
          </div>
          {#if years.length}
            <div class="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
              {#each years as y (y)}
                <button class={chip(year === y)} onclick={() => pickYear(y)}>{y}</button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="b-account">Account</Label>
          <select id="b-account" bind:value={accountId} onchange={load} class={railSelect}>
            <option value="">All accounts</option>
            {#each accounts as a (a.id)}<option value={a.id}>{a.institutionName} · {a.name}</option>{/each}
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="b-holder">Holder</Label>
          <select id="b-holder" bind:value={holder} onchange={load} class={railSelect}>
            <option value="">Anyone</option>
            {#each holders as h (h)}<option value={h}>{h}</option>{/each}
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="b-business">Business</Label>
          <select id="b-business" bind:value={business} onchange={load} class={railSelect}>
            <option value="">Both</option>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
            <option value="mixed">Mixed</option>
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="b-currency">Shown in</Label>
          <Input id="b-currency" bind:value={currency} maxlength="3" class="w-20 px-2 uppercase" onchange={load} />
        </div>

        {#if st?.unconverted.count}
          <p class="rounded-md border border-warning-border bg-warning px-2 py-1.5 text-xs text-warning-foreground">
            {st.unconverted.count}
            {st.unconverted.count === 1 ? 'transaction' : 'transactions'} in {st.unconverted.currencies.join(', ')} have no rate to {cur} and are left out.
            <button class="font-medium underline" onclick={() => navigate('/rates')}>Add rates</button>
          </p>
        {/if}
      </Card>
    </aside>

    <div class="min-w-0">
      {#if error}<p class="mb-3 text-sm text-destructive">{error}</p>{/if}

      {#if loading}
        <p class="text-sm text-muted-foreground">Loading…</p>
      {:else if st}
        <div class={'flex flex-col gap-5 transition-opacity ' + (refreshing ? 'opacity-60' : '')} aria-busy={refreshing}>
          {#if aheadOnly}
            <p class="rounded-lg border border-border bg-accent/30 px-4 py-2.5 text-sm">
              These months are ahead: every figure is what is already committed to them — spread purchases, and anything dated in the future. Nothing here has been spent yet.
            </p>
          {/if}
          <!-- The average month: six figures, read left to right like the statement. -->
          <div class="grid gap-3 sm:grid-cols-3 2xl:grid-cols-6">
            <!-- Over months ahead only what is committed shows, so the figures that are
                 zero there (income, taxes) would only be noise. -->
            {#each aheadOnly ? headline.filter((h) => Math.round(h.value / 100) !== 0) : headline as h (h.label)}
              <Card class="p-4">
                <p class="text-xs text-muted-foreground">{h.label} <span class="text-muted-foreground/70">/ month</span></p>
                <p class="mt-1 text-2xl font-semibold tabular-nums">{amount(h.value)} <span class="text-sm font-normal text-muted-foreground">{cur}</span></p>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  {[h.total != null ? `${amount(h.total)} in ${st.averagedCount} months` : '', h.note].filter(Boolean).join(' · ')}
                </p>
              </Card>
            {/each}
          </div>

          <div>
            <Card class="overflow-hidden">
              <div class="overflow-x-auto">
                <table class="w-full border-collapse text-[13px]">
                  <thead>
                    <tr class="border-b border-border text-xs text-muted-foreground">
                      <th class="sticky left-0 z-10 min-w-[12.5rem] bg-card px-3 py-2 text-left font-medium">{cur}</th>
                      {#each columns as c, i (c.ym)}
                        <th
                          class={'whitespace-nowrap px-1 py-2 text-right font-medium ' + (c.future ? 'min-w-[3.5rem] ' : '') + colShade(c) + (c.current ? 'italic' : '')}
                          title={c.current ? 'In progress — not in the averages' : c.future ? 'Ahead — only what is already committed' : ''}
                        >
                          {columnLabel(c, i)}{c.current ? '*' : ''}
                        </th>
                      {/each}
                      <th class={MEAN + 'whitespace-nowrap bg-card px-1.5 py-2 text-right font-semibold text-foreground'} title={aheadOnly ? 'Over the months ahead' : 'Over the complete months'}>Mean</th>
                      <th class={TOTAL + 'whitespace-nowrap bg-card px-1.5 py-2 text-right font-medium'} title={aheadOnly ? 'Sum of the months ahead' : 'Sum of the complete months'}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each rows as r (r.key)}
                      {#if r.type === 'subtotal'}
                        <tr class="border-y border-border bg-accent font-semibold">
                          <td class="sticky left-0 z-10 bg-inherit px-3 py-2"><span class="bg-transparent">= {r.name}</span></td>
                          {#each r.values as v, i (i)}
                            <td class={'px-1 py-2 text-right tabular-nums ' + (columns[i].current || columns[i].future ? 'italic text-muted-foreground ' : v < 0 ? 'text-destructive' : '')}>{amount(v)}</td>
                          {/each}
                          <td class={MEAN + 'bg-inherit px-1.5 py-2 text-right tabular-nums ' + (r.mean < 0 ? 'text-destructive' : '')}>{amount(r.mean)}</td>
                          <td class={TOTAL + 'bg-inherit px-1.5 py-2 text-right tabular-nums ' + (r.total < 0 ? 'text-destructive' : '')}>{amount(r.total)}</td>
                        </tr>
                      {:else if r.type === 'group'}
                        <!-- A kind holding one line would only repeat it, unless it is folded. -->
                        {@const showTotals = r.lines.length > 1 || collapsedGroups.has(r.kind)}
                        <tr class={'border-t border-border ' + (r.kind === 'excluded' ? 'text-muted-foreground' : '')}>
                          <td class="sticky left-0 z-10 bg-card px-3 pb-1 pt-3">
                            <button
                              class="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold uppercase tracking-wide"
                              onclick={() => (collapsedGroups = toggle(collapsedGroups, r.kind))}
                              aria-expanded={!collapsedGroups.has(r.kind)}
                            >
                              <Icon name="chevron-down" size={14} class={'transition ' + (collapsedGroups.has(r.kind) ? '-rotate-90' : '')} />
                              {r.name}
                              {#if r.kind === 'excluded'}<span class="font-normal normal-case tracking-normal">· not counted</span>{/if}
                              {#if r.kind === 'unassigned'}<span class="font-normal normal-case tracking-normal text-warning-foreground" title="Categories not on a line yet, and uncategorized money — place them in Setup">· to place</span>{/if}
                            </button>
                          </td>
                          {#each r.values as v, i (i)}
                            <td class={'px-1 pb-1 pt-3 text-right text-xs font-semibold tabular-nums ' + colShade(columns[i]) + (columns[i].current ? 'italic text-muted-foreground' : '')}>{showTotals && v ? amount(v) : ''}</td>
                          {/each}
                          <td class={MEAN + 'bg-card px-1.5 pb-1 pt-3 text-right text-xs font-semibold tabular-nums'}>{showTotals ? amount(r.mean) : ''}</td>
                          <td class={TOTAL + 'bg-card px-1.5 pb-1 pt-3 text-right text-xs font-semibold tabular-nums'}>{showTotals ? amount(r.total) : ''}</td>
                        </tr>
                      {:else}
                        {@const open = expanded.has(r.key)}
                        {@const canOpen = r.type === 'line' ? r.children.length > 0 : r.depth === 2 && r.children.length > 0}
                        <tr class={'group ' + (r.excluded ? 'text-muted-foreground' : '')}>
                          <td class="sticky left-0 z-10 bg-card py-0.5 pr-3" style="padding-left: {r.depth * 0.9 + 0.4}rem">
                            <div class="flex min-w-0 max-w-[13rem] items-center gap-1.5">
                              {#if canOpen}
                                <button
                                  class="shrink-0 rounded text-muted-foreground hover:text-foreground"
                                  onclick={() => (expanded = toggle(expanded, r.key))}
                                  aria-label={open ? `Collapse ${r.name}` : `Expand ${r.name}`}
                                  aria-expanded={open}
                                >
                                  <Icon name="chevron-down" size={14} class={'transition ' + (open ? '' : '-rotate-90')} />
                                </button>
                              {:else}
                                <span class="w-3.5 shrink-0"></span>
                              {/if}
                              {#if r.type === 'node' && r.nodeType !== 'hashtag'}
                                <CategoryIcon name={r.icon} categoryId={r.categoryId} size={13} class="shrink-0" />
                              {/if}
                              <span class={'truncate ' + (r.type === 'line' ? 'font-medium' : 'text-muted-foreground')} title={r.name}>{r.name}</span>
                            </div>
                          </td>
                          {#each r.values as v, i (i)}
                            <td class={'px-0.5 py-0 ' + colShade(columns[i])}>
                              <button
                                class={cellCls(v, columns[i])}
                                onclick={() => openCell(r, columns[i].ym)}
                                aria-label="{r.name}, {monthLabel(columns[i].ym, { long: true })}: {amount(v)}"
                              >
                                {v ? amount(v) : '–'}
                              </button>
                            </td>
                          {/each}
                          <td class={MEAN + 'bg-card px-0.5 py-0'}>
                            <button class={cellCls(r.mean) + ' font-medium text-foreground'} onclick={() => openCell(r, null)} aria-label="{r.name}, mean: {amount(r.mean)}">
                              {amount(r.mean)}
                            </button>
                          </td>
                          <td class={TOTAL + 'bg-card px-0.5 py-0'}>
                            <button class={cellCls(r.total)} onclick={() => openCell(r, null)} aria-label="{r.name}, total: {amount(r.total)}">
                              {amount(r.total)}
                            </button>
                          </td>
                        </tr>
                      {/if}
                    {/each}
                  </tbody>
                </table>
              </div>
              {#if hasCurrent || hasFuture}
                <div class="flex flex-col gap-0.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                  {#if hasCurrent}<p>* The month in progress is shown but kept out of Mean and Total.</p>{/if}
                  {#if hasFuture}
                    <p>
                      Shaded months are ahead: they hold only what is already committed — the slices of spread purchases and anything dated in the future.
                      {aheadOnly ? 'Mean and Total are over those months.' : 'They are not in Mean and Total.'}
                    </p>
                  {/if}
                </div>
              {/if}
            </Card>

            <!-- A drawer over the right edge rather than a column beside the table:
                 the statement needs every pixel of width for its months, and a
                 panel that opens below it would open out of sight. -->
            {#if panel}
              <aside class="fixed inset-y-0 right-0 z-40 flex w-full max-w-[26rem] p-3">
                <Card class="flex w-full flex-col overflow-hidden shadow-xl">
                  <header class="flex items-start gap-2 border-b border-border px-3 py-2.5">
                    <div class="min-w-0">
                      <p class="truncate font-semibold">
                        {panel.lineName}{#if panel.nodeName}<span class="font-normal text-muted-foreground">{` › ${panel.nodeName}`}</span>{/if}
                      </p>
                      <p class="mt-0.5 text-xs text-muted-foreground">{panelPeriod}</p>
                    </div>
                    <IconButton class="ml-auto shrink-0" onclick={closePanel} title="Close (Esc)" aria-label="Close the panel"><Icon name="x" /></IconButton>
                  </header>

                  {#if panelData}
                    <div class="flex items-baseline gap-2 border-b border-border px-3 py-2">
                      <span class="text-lg font-semibold tabular-nums">{formatMoney(panelData.total, cur)}</span>
                      <span class="text-xs text-muted-foreground">{panelData.rows.length} transaction{panelData.rows.length === 1 ? '' : 's'}</span>
                    </div>
                  {/if}

                  {#if panelError}<p class="px-3 py-2 text-sm text-destructive">{panelError}</p>{/if}
                  {#if panelLoading && !panelData}
                    <p class="px-3 py-3 text-sm text-muted-foreground">Loading…</p>
                  {:else if panelData && panelData.rows.length === 0}
                    <p class="px-3 py-3 text-sm text-muted-foreground">Nothing here.</p>
                  {:else if panelData}
                    <ul class={'divide-y divide-border overflow-y-auto transition-opacity ' + (panelLoading ? 'opacity-60' : '')}>
                      {#each panelData.rows as tx (tx.id)}
                        <li class="px-3 py-2">
                          <div class="flex items-start gap-2">
                            <span class="min-w-0 flex-1 truncate text-sm" title={tx.description}>{tx.description}</span>
                            <span class={'shrink-0 whitespace-nowrap text-sm tabular-nums ' + (tx.cents < 0 ? 'text-foreground' : 'text-success')}>{formatMoney(tx.cents, '')}</span>
                          </div>
                          <p class="mt-0.5 truncate text-xs text-muted-foreground">
                            {[tx.date, tx.accountName, [tx.category?.name ?? 'Uncategorized', tx.subcategory?.name].filter(Boolean).join(' › ')].join(' · ')}
                          </p>
                          <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span class="rounded bg-accent px-1.5 py-px">{tx.via === 'hashtag' ? `#${tx.hashtag?.name}` : VIA_LABEL[tx.via]}</span>
                            {#if tx.spreadMonths}
                              <span>month{tx.slices.length === 1 ? '' : 's'} {tx.slices.map((s) => s + 1).join(', ')} of {tx.spreadMonths} · {formatMoney(tx.convertedTotal, cur)} in all</span>
                            {:else if tx.currency !== cur}
                              <span>{formatMoney(tx.amountCents, tx.currency)}</span>
                            {/if}
                          </p>
                          <div class="mt-1.5 flex items-center gap-2">
                            <select
                              class="min-w-0 flex-1 rounded-md border border-input bg-card px-1.5 py-1 text-xs outline-none focus:border-ring"
                              value={tx.budgetLineId ?? ''}
                              disabled={saving === tx.id}
                              onchange={(e) => patchRow(tx, { budgetLineId: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
                              aria-label="P&L line for this transaction"
                              title="Pin this transaction to a line"
                            >
                              <option value="">Line: automatic</option>
                              {#each lines as l (l.id)}<option value={l.id}>Pinned to {l.name}</option>{/each}
                            </select>
                            <label class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title="Spread the amount over this many months from the month it was paid">
                              spread
                              <input
                                type="number"
                                min="1"
                                max="120"
                                value={tx.spreadMonths ?? 1}
                                disabled={saving === tx.id}
                                onchange={(e) => patchRow(tx, { spreadMonths: Number(e.currentTarget.value) || 1 })}
                                class="w-12 rounded-md border border-input bg-card px-1.5 py-0.5 text-right text-xs tabular-nums outline-none focus:border-ring"
                              />
                              mo
                            </label>
                          </div>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </Card>
              </aside>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
