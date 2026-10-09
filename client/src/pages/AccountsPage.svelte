<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { auth } from '$lib/stores/auth.svelte.js';
  import { navigate } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';

  // The page is a ledger: one row per account, the institution printed once per
  // group the way a statement prints it. Sorting reorders the groups by their
  // best row and the rows inside them, so an institution stays a single block
  // however the table is sorted.

  let institutions = $state([]);
  let accounts = $state([]);
  let templates = $state([]);
  let loading = $state(true);
  let pageError = $state('');

  let sortKey = $state('lastUploadAt');
  let sortDir = $state('desc');

  const accountsWithTemplate = $derived(new Set(templates.map((t) => t.accountId)));

  async function refresh() {
    pageError = '';
    try {
      [institutions, accounts, templates] = await Promise.all([
        api('/institutions'),
        api('/accounts?stats=1'),
        api('/templates'),
      ]);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not load data.';
    } finally {
      loading = false;
    }
  }
  onMount(refresh);

  // --- Derived figures -------------------------------------------------------

  const maxTxCount = $derived(Math.max(1, ...accounts.map((a) => a.txCount ?? 0)));
  const totalTx = $derived(accounts.reduce((sum, a) => sum + (a.txCount ?? 0), 0));
  const currencies = $derived([...new Set(accounts.map((a) => a.currency))].sort());
  const holders = $derived([...new Set(accounts.map((a) => a.holder))].sort());
  const coverage = $derived.by(() => {
    const first = accounts.map((a) => a.firstDate).filter(Boolean).sort();
    const last = accounts.map((a) => a.lastDate).filter(Boolean).sort();
    if (first.length === 0) return null;
    return { from: first[0], to: last[last.length - 1] };
  });

  // An account importing OFX needs no CSV template — OFX is self-describing.
  function importState(acc) {
    if (accountsWithTemplate.has(acc.id)) return { label: 'CSV template', tone: 'ok' };
    if (acc.hasOfx) return { label: 'OFX', tone: 'ok' };
    return { label: 'No template', tone: 'warn' };
  }
  const needTemplate = $derived(accounts.filter((a) => importState(a).tone === 'warn').length);

  // --- Sorting ---------------------------------------------------------------

  const COLUMNS = [
    { key: 'name', label: 'Account', align: 'left' },
    { key: 'holder', label: 'Holder', align: 'left' },
    { key: 'currency', label: 'Cur', align: 'left' },
    { key: 'txCount', label: 'Transactions', align: 'right' },
    { key: 'share', label: 'Share', align: 'left', wide: true, sortable: false },
    { key: 'firstDate', label: 'First', align: 'right', wide: true },
    { key: 'lastDate', label: 'Last', align: 'right', wide: true },
    { key: 'lastUploadAt', label: 'Last import', align: 'right' },
    { key: 'import', label: 'Import', align: 'left', sortable: false },
  ];

  const NUMERIC_KEYS = new Set(['txCount']);

  function sortValue(acc, key) {
    if (key === 'institution') return acc.institutionName ?? '';
    const v = acc[key];
    if (NUMERIC_KEYS.has(key)) return v ?? 0;
    return v ?? ''; // nulls (no transactions, never imported) sort as empty
  }

  function compare(a, b, key, dir) {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    let cmp;
    if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' });
    if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return dir === 'asc' ? cmp : -cmp;
  }

  function toggleSort(key) {
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      return;
    }
    sortKey = key;
    // Text reads naturally A→Z; counts and dates are asked about newest/biggest first.
    sortDir = key === 'name' || key === 'holder' || key === 'currency' || key === 'institution' ? 'asc' : 'desc';
  }

  const ariaSort = (key) => (sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');

  // Institutions in sort order, each with its accounts in the same order. An
  // institution with no accounts keeps its place alphabetically at the end, so
  // it stays visible (and deletable) instead of vanishing from the page.
  const groups = $derived.by(() => {
    const byInstitution = new Map(institutions.map((inst) => [inst.id, []]));
    for (const acc of accounts) {
      if (!byInstitution.has(acc.institutionId)) byInstitution.set(acc.institutionId, []);
      byInstitution.get(acc.institutionId).push(acc);
    }

    const filled = [];
    const empty = [];
    for (const inst of institutions) {
      const rows = [...(byInstitution.get(inst.id) ?? [])].sort((a, b) => compare(a, b, sortKey, sortDir));
      (rows.length > 0 ? filled : empty).push({ institution: inst, rows });
    }

    if (sortKey === 'institution') {
      filled.sort((x, y) =>
        sortDir === 'asc'
          ? x.institution.name.localeCompare(y.institution.name, undefined, { sensitivity: 'base' })
          : y.institution.name.localeCompare(x.institution.name, undefined, { sensitivity: 'base' }),
      );
    } else {
      // A group ranks by its own leading row, so the institution whose account
      // was imported most recently leads a "last import" sort.
      filled.sort((x, y) => compare(x.rows[0], y.rows[0], sortKey, sortDir));
    }
    empty.sort((x, y) => x.institution.name.localeCompare(y.institution.name, undefined, { sensitivity: 'base' }));
    return [...filled, ...empty];
  });

  const sortNote = $derived.by(() => {
    const col = [{ key: 'institution', label: 'Institution' }, ...COLUMNS].find((c) => c.key === sortKey);
    return col ? `sorted by ${col.label.toLowerCase()}` : '';
  });

  // --- Formatting ------------------------------------------------------------

  const numberFormat = new Intl.NumberFormat(undefined);
  const formatCount = (n) => numberFormat.format(n ?? 0);

  // `uploaded_at` is a UTC 'YYYY-MM-DD HH:MM:SS' stamp from SQLite.
  function relativeDay(value) {
    if (!value) return null;
    const then = new Date(value.replace(' ', 'T') + 'Z');
    const days = Math.floor((Date.now() - then.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return then.toISOString().slice(0, 10);
  }

  // --- Institution dialog ---
  let instOpen = $state(false);
  let instEditing = $state(null);
  let instName = $state('');
  let instError = $state('');
  let instSaving = $state(false);

  function openNewInstitution() {
    instEditing = null;
    instName = '';
    instError = '';
    instOpen = true;
  }
  function openEditInstitution(inst) {
    instEditing = inst;
    instName = inst.name;
    instError = '';
    instOpen = true;
  }
  async function saveInstitution(e) {
    e.preventDefault();
    instError = '';
    instSaving = true;
    try {
      if (instEditing) await api(`/institutions/${instEditing.id}`, { method: 'PATCH', body: { name: instName } });
      else await api('/institutions', { method: 'POST', body: { name: instName } });
      instOpen = false;
      await refresh();
    } catch (err) {
      instError = err instanceof ApiError ? err.message : 'Could not save institution.';
    } finally {
      instSaving = false;
    }
  }
  async function deleteInstitution(inst) {
    if (!window.confirm(`Delete institution "${inst.name}"?`)) return;
    try {
      await api(`/institutions/${inst.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not delete institution.';
    }
  }

  // --- Account dialog ---
  let accOpen = $state(false);
  let accEditing = $state(null);
  let accInstitutionId = $state(null);
  let accName = $state('');
  let accCurrency = $state('');
  let accHolder = $state('');
  let accError = $state('');
  let accSaving = $state(false);

  function openNewAccount(institutionId) {
    accEditing = null;
    accInstitutionId = institutionId ?? institutions[0]?.id ?? null;
    accName = '';
    accCurrency = auth.user.defaultCurrency;
    accHolder = '';
    accError = '';
    accOpen = true;
  }
  function openEditAccount(acc) {
    accEditing = acc;
    accInstitutionId = acc.institutionId;
    accName = acc.name;
    accCurrency = acc.currency;
    accHolder = acc.holder;
    accError = '';
    accOpen = true;
  }
  async function saveAccount(e) {
    e.preventDefault();
    accError = '';
    accSaving = true;
    const body = {
      institutionId: accInstitutionId,
      name: accName,
      currency: accCurrency,
      holder: accHolder,
    };
    try {
      if (accEditing) await api(`/accounts/${accEditing.id}`, { method: 'PATCH', body });
      else await api('/accounts', { method: 'POST', body });
      accOpen = false;
      await refresh();
    } catch (err) {
      accError = err instanceof ApiError ? err.message : 'Could not save account.';
    } finally {
      accSaving = false;
    }
  }
  async function deleteAccount(acc) {
    const warning =
      acc.txCount > 0
        ? `Delete account "${acc.name}"? Its ${formatCount(acc.txCount)} transaction${acc.txCount === 1 ? '' : 's'}, splits and upload history go with it. A backup is taken first.`
        : `Delete account "${acc.name}"?`;
    if (!window.confirm(warning)) return;
    try {
      await api(`/accounts/${acc.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not delete account.';
    }
  }
</script>

<div>
  <div class="mb-5 flex flex-wrap items-start justify-between gap-4">
    <div>
      <h2 class="text-xl font-semibold">Accounts</h2>
      <p class="text-sm text-muted-foreground">
        {#if loading}
          Loading…
        {:else}
          {accounts.length} account{accounts.length === 1 ? '' : 's'} across {institutions.length} institution{institutions.length ===
          1
            ? ''
            : 's'}{sortNote ? ` · ${sortNote}` : ''}
        {/if}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <div class="mr-2 flex items-center gap-1">
        <button class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-foreground">Accounts</button>
        <button
          class="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onclick={() => navigate('/accounts/transfers')}
        >
          Transfers
        </button>
      </div>
      <Button variant="outline" onclick={() => openNewAccount(null)} disabled={institutions.length === 0}>
        <Icon name="plus" />Add account
      </Button>
      <Button onclick={openNewInstitution}><Icon name="plus" />Add institution</Button>
    </div>
  </div>

  {#if pageError}
    <p class="mb-4 text-sm text-destructive">{pageError}</p>
  {/if}

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if institutions.length === 0}
    <Card class="p-8 text-center">
      <p class="text-sm text-muted-foreground">No institutions yet. Add one to get started.</p>
    </Card>
  {:else}
    <!-- Summary strip: what the whole ledger adds up to. -->
    <div class="mb-4 flex flex-wrap overflow-hidden rounded-xl border border-border bg-card">
      <div class="min-w-32 flex-1 px-4 py-2.5">
        <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">Transactions</dt>
        <dd class="text-lg font-semibold tabular-nums">{formatCount(totalTx)}</dd>
      </div>
      <div class="min-w-48 flex-1 border-l border-border px-4 py-2.5">
        <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">Coverage</dt>
        <dd class="text-lg font-semibold tabular-nums">
          {#if coverage}{coverage.from} → {coverage.to}{:else}<span class="text-muted-foreground">—</span>{/if}
        </dd>
      </div>
      <div class="min-w-32 flex-1 border-l border-border px-4 py-2.5">
        <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">Currencies</dt>
        <dd class="truncate text-lg font-semibold">
          {#if currencies.length}{currencies.join(' ')}{:else}<span class="text-muted-foreground">—</span>{/if}
        </dd>
      </div>
      <div class="min-w-32 flex-1 border-l border-border px-4 py-2.5">
        <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">Holders</dt>
        <dd class="truncate text-lg font-semibold" title={holders.join(', ')}>
          {#if holders.length}{holders.join(', ')}{:else}<span class="text-muted-foreground">—</span>{/if}
        </dd>
      </div>
      <div class="min-w-36 flex-1 border-l border-border px-4 py-2.5">
        <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">Needs a template</dt>
        <dd class={'text-lg font-semibold tabular-nums ' + (needTemplate > 0 ? 'text-warning-foreground' : '')}>
          {needTemplate}
        </dd>
      </div>
    </div>

    <Card class="overflow-x-auto">
      <table class="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th
              scope="col"
              class="border-b border-border px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              aria-sort={ariaSort('institution')}
            >
              <button class="inline-flex items-center gap-1 uppercase hover:text-foreground" onclick={() => toggleSort('institution')}>
                Institution
                {#if sortKey === 'institution'}
                  <Icon name="chevron-down" size={12} class={sortDir === 'asc' ? 'rotate-180' : ''} />
                {/if}
              </button>
            </th>
            {#each COLUMNS as col (col.key)}
              <th
                scope="col"
                class={'whitespace-nowrap border-b border-border px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground ' +
                  (col.align === 'right' ? 'text-right ' : 'text-left ') +
                  (col.wide ? 'hidden xl:table-cell' : '')}
                aria-sort={col.sortable === false ? undefined : ariaSort(col.key)}
              >
                {#if col.sortable === false}
                  {col.label}
                {:else}
                  <button class="inline-flex items-center gap-1 uppercase hover:text-foreground" onclick={() => toggleSort(col.key)}>
                    {col.label}
                    {#if sortKey === col.key}
                      <Icon name="chevron-down" size={12} class={sortDir === 'asc' ? 'rotate-180' : ''} />
                    {/if}
                  </button>
                {/if}
              </th>
            {/each}
            <th scope="col" class="border-b border-border px-3 py-2.5"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each groups as group (group.institution.id)}
            {#if group.rows.length === 0}
              <tr class="group">
                <th scope="row" class="whitespace-nowrap border-b border-border px-3 py-2.5 text-left font-semibold">
                  <span class="inline-flex items-center gap-1">
                    {group.institution.name}
                    <IconButton
                      class="h-6 w-6 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                      onclick={() => openEditInstitution(group.institution)}
                      title="Rename institution"
                      aria-label={`Rename ${group.institution.name}`}
                    >
                      <Icon name="pencil" size={13} />
                    </IconButton>
                    <IconButton
                      variant="danger"
                      class="h-6 w-6 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                      onclick={() => deleteInstitution(group.institution)}
                      title="Delete institution"
                      aria-label={`Delete ${group.institution.name}`}
                    >
                      <Icon name="trash" size={13} />
                    </IconButton>
                  </span>
                </th>
                <td class="border-b border-border px-3 py-2.5 text-muted-foreground" colspan={COLUMNS.length + 1}>
                  No accounts yet —
                  <button class="underline hover:text-foreground" onclick={() => openNewAccount(group.institution.id)}>
                    add one
                  </button>
                  to start importing.
                </td>
              </tr>
            {:else}
              {#each group.rows as acc, i (acc.id)}
                {@const imp = importState(acc)}
                <tr class="group hover:bg-accent">
                  <!-- The institution name prints once per group, statement-style;
                       continuation rows keep it for assistive tech only. -->
                  {#if i === 0}
                    <th scope="row" class="whitespace-nowrap border-b border-border px-3 py-2.5 text-left align-middle font-semibold">
                      <span class="inline-flex items-center gap-1">
                        {group.institution.name}
                        <IconButton
                          class="h-6 w-6 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                          onclick={() => openEditInstitution(group.institution)}
                          title="Rename institution"
                          aria-label={`Rename ${group.institution.name}`}
                        >
                          <Icon name="pencil" size={13} />
                        </IconButton>
                        <IconButton
                          class="h-6 w-6 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                          onclick={() => openNewAccount(group.institution.id)}
                          title="Add an account here"
                          aria-label={`Add an account under ${group.institution.name}`}
                        >
                          <Icon name="plus" size={13} />
                        </IconButton>
                      </span>
                    </th>
                  {:else}
                    <th scope="row" class="border-b border-border px-3 py-2.5 text-left font-normal">
                      <span class="sr-only">{group.institution.name}</span>
                    </th>
                  {/if}

                  <td class="border-b border-border px-3 py-2.5 font-medium">{acc.name}</td>
                  <td class="border-b border-border px-3 py-2.5 text-muted-foreground">{acc.holder}</td>
                  <td class="border-b border-border px-3 py-2.5">
                    <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{acc.currency}</span>
                  </td>
                  <td class="whitespace-nowrap border-b border-border px-3 py-2.5 text-right tabular-nums">
                    {#if acc.txCount > 0}
                      {formatCount(acc.txCount)}
                    {:else}
                      <span class="text-muted-foreground">0</span>
                    {/if}
                  </td>
                  <td class="hidden border-b border-border px-3 py-2.5 xl:table-cell">
                    <span class="block h-1.5 w-full min-w-10 rounded-full bg-muted" title={`${formatCount(acc.txCount)} of ${formatCount(totalTx)}`}>
                      <span
                        class="block h-1.5 rounded-full bg-muted-foreground"
                        style={`width: ${Math.round(((acc.txCount ?? 0) / maxTxCount) * 100)}%`}
                      ></span>
                    </span>
                  </td>
                  <td class="hidden whitespace-nowrap border-b border-border px-3 py-2.5 text-right tabular-nums text-muted-foreground xl:table-cell">
                    {acc.firstDate ?? '—'}
                  </td>
                  <td class="hidden whitespace-nowrap border-b border-border px-3 py-2.5 text-right tabular-nums text-muted-foreground xl:table-cell">
                    {acc.lastDate ?? '—'}
                  </td>
                  <td class="whitespace-nowrap border-b border-border px-3 py-2.5 text-right">
                    {#if acc.lastUploadAt}
                      {relativeDay(acc.lastUploadAt)}
                    {:else}
                      <span class="text-muted-foreground">never</span>
                    {/if}
                  </td>
                  <td class="whitespace-nowrap border-b border-border px-3 py-2.5">
                    <button
                      class={'rounded px-1.5 py-0.5 text-xs font-medium transition hover:opacity-80 ' +
                        (imp.tone === 'ok'
                          ? 'bg-success/10 text-success'
                          : 'border border-warning-border bg-warning text-warning-foreground')}
                      onclick={() => navigate(`/uploads/${acc.id}/edit`)}
                      title="Edit the CSV import template"
                    >
                      {imp.label}
                    </button>
                  </td>
                  <td class="whitespace-nowrap border-b border-border px-3 py-2.5">
                    <div class="flex justify-end gap-0.5">
                      <IconButton
                        onclick={() => navigate(`/uploads/${acc.id}`)}
                        title="Upload a statement"
                        aria-label={`Upload a statement to ${acc.name}`}
                      >
                        <Icon name="upload" />
                      </IconButton>
                      <IconButton
                        onclick={() => navigate(`/uploads/${acc.id}/edit`)}
                        title="Import template"
                        aria-label={`Edit the import template of ${acc.name}`}
                      >
                        <Icon name="sliders" />
                      </IconButton>
                      <IconButton onclick={() => openEditAccount(acc)} title="Edit account" aria-label={`Edit ${acc.name}`}>
                        <Icon name="pencil" />
                      </IconButton>
                      <IconButton
                        variant="danger"
                        onclick={() => deleteAccount(acc)}
                        title="Delete account"
                        aria-label={`Delete ${acc.name}`}
                      >
                        <Icon name="trash" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              {/each}
            {/if}
          {/each}
        </tbody>
      </table>
    </Card>
    <p class="mt-3 text-xs text-muted-foreground">
      Transaction counts exclude split children — a split transaction counts once. Narrow windows hide the share bar and the
      first/last columns.
    </p>
  {/if}
</div>

<style>
  /* The card supplies the table's outer edge, so the last row drops its rule. */
  tbody tr:last-child > * {
    border-bottom-width: 0;
  }
</style>

<!-- Institution dialog -->
<Dialog bind:open={instOpen} title={instEditing ? 'Rename institution' : 'Add institution'}>
  <form class="flex flex-col gap-4" onsubmit={saveInstitution}>
    <div class="flex flex-col gap-1.5">
      <Label for="inst-name">Name</Label>
      <Input id="inst-name" bind:value={instName} placeholder="e.g. Alior Bank" required />
    </div>
    {#if instError}<p class="text-sm text-destructive">{instError}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="outline" type="button" onclick={() => (instOpen = false)}>Cancel</Button>
      <Button type="submit" disabled={instSaving}>{instSaving ? 'Saving…' : 'Save'}</Button>
    </div>
  </form>
</Dialog>

<!-- Account dialog -->
<Dialog bind:open={accOpen} title={accEditing ? 'Edit account' : 'Add account'}>
  <form class="flex flex-col gap-4" onsubmit={saveAccount}>
    <div class="flex flex-col gap-1.5">
      <Label for="acc-inst">Institution</Label>
      <select
        id="acc-inst"
        bind:value={accInstitutionId}
        class="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
      >
        {#each institutions as inst (inst.id)}
          <option value={inst.id}>{inst.name}</option>
        {/each}
      </select>
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="acc-name">Account name</Label>
      <Input id="acc-name" bind:value={accName} placeholder="e.g. Personal Checking" required />
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="flex flex-col gap-1.5">
        <Label for="acc-currency">Currency</Label>
        <Input id="acc-currency" bind:value={accCurrency} maxlength="3" class="uppercase" placeholder="PLN" required />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="acc-holder">Account holder</Label>
        <Input id="acc-holder" bind:value={accHolder} placeholder={auth.user.username} />
      </div>
    </div>
    <p class="text-xs text-muted-foreground">Leave holder blank to use your own username.</p>
    {#if accError}<p class="text-sm text-destructive">{accError}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="outline" type="button" onclick={() => (accOpen = false)}>Cancel</Button>
      <Button type="submit" disabled={accSaving}>{accSaving ? 'Saving…' : 'Save'}</Button>
    </div>
  </form>
</Dialog>
