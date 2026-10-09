<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { auth } from '$lib/stores/auth.svelte.js';
  import { navigate } from '$lib/router.svelte.js';
  import Card from '$lib/components/ui/Card.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';

  // Home is a way in, not a dashboard. The charts and the month's numbers live
  // on Graphs, which is one click away and does them properly; repeating a
  // worse version here only made the page slow to open. What a tile can do that
  // the nav bar cannot is say what is waiting behind it — one cheap figure each,
  // and nothing that needs a report query.

  let loading = $state(true);
  let accounts = $state([]);
  let templates = $state([]);
  let uploads = $state([]);
  let total = $state(0);
  let uncategorized = $state(0);
  let budget = $state(null);
  let health = $state(null);

  onMount(async () => {
    // Small reads only. `limit=1` is a count: the list returns `total` for the
    // whole filter, not for the page. The budget summary is two counts, never
    // the statement.
    const [a, t, u, all, unc, b, h] = await Promise.all([
      api('/accounts'),
      api('/templates'),
      api('/uploads'),
      api('/transactions?limit=1'),
      api('/transactions?uncategorized=1&limit=1'),
      api('/budget/summary'),
      api('/data-health/summary').catch(() => null),
    ]);
    budget = b;
    health = h;
    accounts = a;
    templates = t;
    uploads = u;
    total = all.total;
    uncategorized = unc.total;
    loading = false;
  });

  const institutionCount = $derived(new Set(accounts.map((a) => a.institutionName)).size);
  const lastUpload = $derived(uploads[0] ?? null);

  // An account importing OFX needs no CSV template — OFX is self-describing.
  const ofxAccountIds = $derived(new Set(uploads.filter((u) => u.format === 'ofx').map((u) => u.accountId)));
  const accountsWithoutTemplate = $derived(
    accounts.filter((a) => !templates.some((t) => t.accountId === a.id) && !ofxAccountIds.has(a.id)),
  );

  const numberFormat = new Intl.NumberFormat(undefined);
  const count = (n) => numberFormat.format(n ?? 0);

  function relativeDay(value) {
    if (!value) return null;
    const then = new Date(value.replace(' ', 'T') + 'Z');
    const days = Math.floor((Date.now() - then.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return then.toISOString().slice(0, 10);
  }

  // The tiles. `state` is the one line each carries; it falls back to the
  // description when there is nothing to report yet.
  const tiles = $derived([
    {
      path: '/transactions',
      icon: 'list',
      title: 'Transactions',
      description: 'Filter, categorize, tag and split what came in.',
      state: total ? `${count(total)} transaction${total === 1 ? '' : 's'}` : null,
      note: uncategorized > 0 ? `${count(uncategorized)} uncategorized` : null,
    },
    {
      path: '/uploads',
      icon: 'upload',
      title: 'Uploads',
      description: 'Import a CSV or OFX statement, and roll one back.',
      state: lastUpload ? `Last import ${relativeDay(lastUpload.uploadedAt)}` : null,
      note: accountsWithoutTemplate.length
        ? `${accountsWithoutTemplate.length} account${accountsWithoutTemplate.length === 1 ? '' : 's'} without a template`
        : null,
    },
    {
      path: '/accounts',
      icon: 'folder',
      title: 'Accounts',
      description: 'Institutions, their accounts, and each import template.',
      state: accounts.length
        ? `${accounts.length} account${accounts.length === 1 ? '' : 's'} · ${institutionCount} institution${institutionCount === 1 ? '' : 's'}`
        : null,
    },
    {
      path: '/budget',
      icon: 'coins',
      title: 'Budget',
      description: 'Your average month as a P&L: income, taxes, fixed and variable costs, one-offs.',
      state: budget?.lineCount ? `${budget.lineCount} line${budget.lineCount === 1 ? '' : 's'}` : null,
      note: budget?.lineCount && budget.unmappedCategories
        ? `${budget.unmappedCategories} categor${budget.unmappedCategories === 1 ? 'y' : 'ies'} not on a line`
        : null,
    },
    {
      path: '/graphs',
      icon: 'chart',
      title: 'Graphs',
      description: 'Income against expenses, and where the money went.',
      state: null,
    },
    {
      path: '/graphs/explore',
      icon: 'compass',
      title: 'Explore',
      description: 'Pick months, drill into a category, read the rows behind it.',
      state: null,
    },
    {
      path: '/categories',
      icon: 'grid',
      title: 'Categories',
      description: 'The categories and subcategories everything lands in.',
      state: null,
    },
    {
      path: '/keywords',
      icon: 'key',
      title: 'Keywords',
      description: 'The rules that read a description and classify it.',
      state: null,
    },
    {
      path: '/rates',
      icon: 'coins',
      title: 'Rates',
      description: 'Exchange rates, for the accounts that are not in your currency.',
      state: null,
    },
    {
      path: '/health',
      icon: 'shield',
      title: 'Health',
      description: 'Rules catching the wrong rows, money going the wrong way, imports gone wrong.',
      state: health ? (health.open ? `${count(health.open)} open finding${health.open === 1 ? '' : 's'}` : 'Nothing found') : null,
    },
    {
      path: '/settings',
      icon: 'gear',
      title: 'Settings',
      description: 'Your defaults, backups, and the danger zone.',
      state: null,
    },
  ]);

  // Only the things that genuinely want doing. Empty most days, and then the
  // strip is not drawn at all. The default password is deliberately absent: the
  // shell already carries a banner for it on every page, directly above this.
  const attention = $derived(
    [
      uncategorized > 0 && {
        key: 'uncategorized',
        text: `${count(uncategorized)} transaction${uncategorized === 1 ? '' : 's'} still uncategorized`,
        hint: 'Select a word in a description to turn it into a keyword.',
        action: 'Categorize',
        go: () => navigate('/transactions'),
      },
      health?.high > 0 && {
        key: 'health',
        text: `${count(health.high)} serious data finding${health.high === 1 ? '' : 's'}`,
        hint: `Money filed the wrong way, or rows an import got wrong${health.open > health.high ? ` — ${count(health.open - health.high)} smaller ones too` : ''}.`,
        action: 'Review',
        go: () => navigate('/health'),
      },
      accountsWithoutTemplate.length > 0 && {
        key: 'templates',
        text: `${accountsWithoutTemplate.length} account${accountsWithoutTemplate.length === 1 ? ' has' : 's have'} no import template`,
        hint: `${accountsWithoutTemplate.map((a) => a.name).join(', ')} — not needed if you import OFX/QFX.`,
        action: 'Set one up',
        go: () => navigate(`/uploads/${accountsWithoutTemplate[0].id}/edit`),
      },
    ].filter(Boolean),
  );
</script>

<div>
  <div class="mb-5">
    <h2 class="text-xl font-semibold">Welcome back, {auth.user.username}</h2>
    <p class="text-sm text-muted-foreground">
      {#if loading}
        Loading…
      {:else if accounts.length === 0}
        Nothing here yet — three steps and your first statement is in.
      {:else}
        Everything lives behind one of these.
      {/if}
    </p>
  </div>

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if accounts.length === 0}
    <!-- First run: the only thing that matters is the path to the first upload. -->
    <Card class="max-w-3xl p-6">
      <h3 class="text-sm font-semibold">Getting started</h3>
      <ol class="mt-4 flex flex-col gap-4">
        {#each [
          { n: 1, title: 'Register an institution and an account', body: 'An account carries its currency and the person it belongs to.', label: 'Go to Accounts', go: () => navigate('/accounts') },
          { n: 2, title: 'Import your first extract', body: 'OFX/QFX files import as-is. For CSV, describe the layout once — delimiter, date format, which columns hold the description and the amount — saved per account and reusable.', label: 'Go to Uploads', go: () => navigate('/uploads') },
          { n: 3, title: 'Add keywords', body: 'Each keyword maps a phrase in a description to a category, and classification runs automatically on upload.', label: 'Go to Keywords', go: () => navigate('/keywords') },
        ] as step (step.n)}
          <li class="flex gap-3">
            <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{step.n}</span>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">{step.title}</p>
              <p class="text-xs text-muted-foreground">{step.body}</p>
            </div>
            <Button variant="outline" class="shrink-0 self-start" onclick={step.go}>{step.label}</Button>
          </li>
        {/each}
      </ol>
    </Card>
  {:else}
    {#if attention.length}
      <!-- Drawn only when something is actually waiting. -->
      <Card class="mb-5 divide-y divide-border">
        {#each attention as item (item.key)}
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">{item.text}</p>
              <p class="text-xs text-muted-foreground">{item.hint}</p>
            </div>
            <Button variant="outline" onclick={item.go}>{item.action}</Button>
          </div>
        {/each}
      </Card>
    {/if}

    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {#each tiles as tile (tile.path)}
        <button class="group text-left" onclick={() => navigate(tile.path)}>
          <Card class="flex h-full flex-col gap-2 p-4 transition group-hover:border-input group-hover:bg-accent/40 group-focus-visible:border-ring">
            <div class="flex items-center gap-2.5">
              <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition group-hover:text-foreground">
                <Icon name={tile.icon} size={16} />
              </span>
              <span class="font-semibold">{tile.title}</span>
              <Icon
                name="arrow-right"
                size={14}
                class="ml-auto shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100"
              />
            </div>
            <p class="text-sm text-muted-foreground">{tile.description}</p>
            {#if tile.state || tile.note}
              <p class="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs">
                {#if tile.state}<span class="tabular-nums text-foreground">{tile.state}</span>{/if}
                {#if tile.state && tile.note}<span class="text-muted-foreground/40">·</span>{/if}
                {#if tile.note}<span class="text-warning-foreground">{tile.note}</span>{/if}
              </p>
            {/if}
          </Card>
        </button>
      {/each}
    </div>
  {/if}
</div>
