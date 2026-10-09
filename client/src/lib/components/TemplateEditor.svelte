<script>
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import { guessTemplate } from '$lib/templateGuess.js';

  // Controlled-ish template form. Owns a local draft seeded from `initial`; emits
  // the normalized value via onSave. Column pickers are populated from `headers`
  // (detected from a sample file via onDetect). `hasFile` gates detection.
  let {
    initial = null,
    headers = [],
    sampleRows = [],
    hasFile = false,
    detecting = false,
    saving = false,
    onDetect,
    onSave,
    onChange,
  } = $props();

  const ENCODINGS = [
    ['utf-8', 'UTF-8'],
    ['windows-1250', 'Windows-1250 (Central European)'],
    ['iso-8859-2', 'ISO-8859-2'],
    ['latin1', 'Latin-1 / ISO-8859-1'],
  ];
  const DELIMITERS = [
    [',', 'Comma ,'],
    [';', 'Semicolon ;'],
    ['\t', 'Tab'],
    ['|', 'Pipe |'],
  ];
  const OPS = [
    ['contains', 'contains'],
    ['equals', 'equals'],
  ];
  const MODES = [
    ['exclude', 'Exclude rows where'],
    ['include', 'Keep only rows where'],
  ];

  // Normalize a saved filter to the {op ∈ contains|equals, mode} shape, migrating
  // legacy not_* ops (which encoded direction in the op) to the new mode.
  function migrateFilter(f) {
    if (f?.mode && (f.op === 'contains' || f.op === 'equals')) {
      return { column: f.column ?? '', op: f.op, value: f.value ?? '', mode: f.mode };
    }
    const legacy = {
      equals: ['equals', 'include'],
      not_equals: ['equals', 'exclude'],
      contains: ['contains', 'include'],
      not_contains: ['contains', 'exclude'],
    };
    const [op, mode] = legacy[f?.op] ?? ['contains', 'exclude'];
    return { column: f?.column ?? '', op, value: f?.value ?? '', mode };
  }

  const blank = {
    encoding: 'utf-8',
    delimiter: ',',
    decimalSeparator: '.',
    headerRow: 0,
    dateFormat: 'YYYY-MM-DD',
    dateColumn: '',
    descriptionColumns: [],
    amountColumns: [],
    currencyColumn: '',
    foreignAmountColumn: '',
    foreignCurrencyColumn: '',
    filters: [],
  };

  // Seed the draft from `initial` once (and when the account/template identity changes).
  let draft = $state(structuredClone(blank));
  let seededId = $state(Symbol());
  $effect(() => {
    const id = initial ? `t${initial.id}` : 'blank';
    if (seededId !== id) {
      seededId = id;
      draft = initial
        ? {
            ...structuredClone(blank),
            ...initial,
            currencyColumn: initial.currencyColumn ?? '',
            foreignAmountColumn: initial.foreignAmountColumn ?? '',
            foreignCurrencyColumn: initial.foreignCurrencyColumn ?? '',
            descriptionColumns: [...(initial.descriptionColumns ?? [])],
            amountColumns: [...(initial.amountColumns ?? [])],
            filters: (initial.filters ?? []).map(migrateFilter),
          }
        : structuredClone(blank);
    }
  });

  // Surface the live draft to the parent on every change so "Preview import" can
  // persist the latest edits before previewing (snapshot = plain, deep-read).
  $effect(() => {
    onChange?.($state.snapshot(draft));
  });

  // Union of detected headers and any columns already referenced by the draft, so
  // a saved template still shows its columns before a file is re-detected.
  const columnOptions = $derived.by(() => {
    const set = new Set(headers);
    for (const c of [draft.dateColumn, draft.currencyColumn, draft.foreignAmountColumn, draft.foreignCurrencyColumn]) if (c) set.add(c);
    for (const c of [...draft.descriptionColumns, ...draft.amountColumns]) if (c) set.add(c);
    for (const f of draft.filters) if (f.column) set.add(f.column);
    return [...set];
  });

  function toggleIn(list, col) {
    // Keep multi-select columns in detected-header order for stable merges.
    const has = list.includes(col);
    const next = has ? list.filter((c) => c !== col) : [...list, col];
    return columnOptions.filter((c) => next.includes(c));
  }

  // Detect columns from the sample file, then auto-guess the mapping for any
  // field the user hasn't set yet (English / Portuguese / Polish header terms).
  async function handleDetect() {
    const res = await onDetect({ encoding: draft.encoding, delimiter: draft.delimiter, headerRow: Number(draft.headerRow) });
    if (!res?.headers) return;
    const g = guessTemplate(res.headers, res.sampleRows ?? []);
    if (!draft.dateColumn && g.dateColumn) draft.dateColumn = g.dateColumn;
    if (g.dateFormat && (!draft.dateFormat || draft.dateFormat === 'YYYY-MM-DD')) draft.dateFormat = g.dateFormat;
    if (draft.descriptionColumns.length === 0 && g.descriptionColumns.length) draft.descriptionColumns = g.descriptionColumns;
    if (draft.amountColumns.length === 0 && g.amountColumns.length) draft.amountColumns = g.amountColumns;
    if (!draft.currencyColumn && g.currencyColumn) draft.currencyColumn = g.currencyColumn;
    if (!draft.foreignAmountColumn && g.foreignAmountColumn) draft.foreignAmountColumn = g.foreignAmountColumn;
    if (!draft.foreignCurrencyColumn && g.foreignCurrencyColumn) draft.foreignCurrencyColumn = g.foreignCurrencyColumn;
  }

  // --- Column roles -------------------------------------------------------
  //
  // Mapping used to mean reading a column name out of one dropdown and finding
  // it again in the next. The table below turns it around: every detected
  // column is a row showing what is actually in it, and its roles are chips you
  // click. Date and the currency fields hold one column each, so clicking one
  // moves it; description and amount take several, so clicking toggles.
  const ROLES = [
    { key: 'date', label: 'Date', single: true, hint: 'The transaction date' },
    { key: 'description', label: 'Description', single: false, hint: 'Merged with spaces, in this order' },
    { key: 'amount', label: 'Amount', single: false, hint: 'Summed into one signed amount' },
    { key: 'currency', label: 'Currency', single: true, hint: 'Otherwise the account currency' },
    { key: 'fxAmount', label: 'FX amount', single: true, hint: 'The same amount in the other currency' },
    { key: 'fxCurrency', label: 'FX currency', single: true, hint: 'What that other currency is' },
  ];
  const SINGLE_FIELD = { date: 'dateColumn', currency: 'currencyColumn', fxAmount: 'foreignAmountColumn', fxCurrency: 'foreignCurrencyColumn' };

  function hasRole(column, role) {
    if (role === 'description') return draft.descriptionColumns.includes(column);
    if (role === 'amount') return draft.amountColumns.includes(column);
    return draft[SINGLE_FIELD[role]] === column;
  }

  function toggleRole(column, role) {
    if (role === 'description') {
      draft.descriptionColumns = toggleIn(draft.descriptionColumns, column);
      return;
    }
    if (role === 'amount') {
      draft.amountColumns = toggleIn(draft.amountColumns, column);
      return;
    }
    const field = SINGLE_FIELD[role];
    draft[field] = draft[field] === column ? '' : column;
  }

  // The first values the file actually holds for a column — the thing that
  // makes "which one is the date" answerable at a glance.
  function samplesFor(column) {
    return sampleRows
      .map((r) => String(r?.[column] ?? '').trim())
      .filter((v) => v !== '')
      .slice(0, 3);
  }

  // Columns the mapping refers to that this file does not actually contain.
  const missingFromFile = $derived(
    headers.length === 0
      ? []
      : [draft.dateColumn, ...draft.descriptionColumns, ...draft.amountColumns, draft.currencyColumn]
          .filter((c) => c && !headers.includes(c))
          .filter((c, i, all) => all.indexOf(c) === i),
  );

  // Filters get their own check: one pointing at a column this file lacks
  // excludes every row, and "22 filtered" in the preview does not say why.
  const filterColumnMissing = (column) => headers.length > 0 && column && !headers.includes(column);
  const brokenFilters = $derived(draft.filters.filter((f) => filterColumnMissing(f.column)).length);

  const mappedSummary = $derived.by(() => {
    const parts = [];
    if (draft.dateColumn) parts.push(`date ${draft.dateColumn}`);
    if (draft.descriptionColumns.length) parts.push(`description ${draft.descriptionColumns.join(' + ')}`);
    if (draft.amountColumns.length) parts.push(`amount ${draft.amountColumns.join(' + ')}`);
    parts.push(draft.currencyColumn ? `currency ${draft.currencyColumn}` : 'currency from the account');
    return parts.join(' · ');
  });

  // What is still missing before the template can do anything.
  const missing = $derived(
    [
      !draft.dateColumn && 'a date column',
      draft.descriptionColumns.length === 0 && 'at least one description column',
      draft.amountColumns.length === 0 && 'at least one amount column',
    ].filter(Boolean),
  );

  // Throw the mapping away and read it from this file instead. `handleDetect`
  // only fills what is empty — correct when you are adding to a mapping, no use
  // at all when the saved one was written for a different bank's export.
  function reguessFromFile() {
    const g = guessTemplate(headers, sampleRows);
    draft.dateColumn = g.dateColumn ?? '';
    if (g.dateFormat) draft.dateFormat = g.dateFormat;
    draft.descriptionColumns = [...(g.descriptionColumns ?? [])];
    draft.amountColumns = [...(g.amountColumns ?? [])];
    draft.currencyColumn = g.currencyColumn ?? '';
    draft.foreignAmountColumn = g.foreignAmountColumn ?? '';
    draft.foreignCurrencyColumn = g.foreignCurrencyColumn ?? '';
  }

  const selectCls =
    'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring';
</script>

<div class="flex flex-col gap-5">
  <!-- How to read the file at all: these four decide what "columns" even are,
       so they sit above the detect button that uses them. -->
  <div class="flex flex-wrap items-end gap-3">
    <div class="flex flex-col gap-1.5">
      <Label>Encoding</Label>
      <select bind:value={draft.encoding} class={selectCls + ' w-56'}>
        {#each ENCODINGS as [v, label] (v)}<option value={v}>{label}</option>{/each}
      </select>
    </div>
    <div class="flex flex-col gap-1.5">
      <Label>Delimiter</Label>
      <select bind:value={draft.delimiter} class={selectCls + ' w-36'}>
        {#each DELIMITERS as [v, label] (v)}<option value={v}>{label}</option>{/each}
      </select>
    </div>
    <div class="flex flex-col gap-1.5">
      <Label>Decimal</Label>
      <select bind:value={draft.decimalSeparator} class={selectCls + ' w-32'}>
        <option value=".">Dot .</option>
        <option value=",">Comma ,</option>
      </select>
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="hr">Header row</Label>
      <input
        id="hr"
        type="number"
        min="1"
        value={Number(draft.headerRow) + 1}
        oninput={(e) => (draft.headerRow = Math.max(0, (parseInt(e.currentTarget.value, 10) || 1) - 1))}
        class={selectCls + ' w-28'}
        title="The line the column names are on (first row = 1)"
      />
    </div>
    <Button variant="outline" onclick={handleDetect} disabled={!hasFile || detecting}>
      <Icon name="search" />{detecting ? 'Reading…' : columnOptions.length ? 'Read the file again' : 'Read columns from the file'}
    </Button>
  </div>

  {#if columnOptions.length === 0}
    <p class="text-sm text-muted-foreground">
      {#if !hasFile}
        Choose a CSV file first — the columns come from the file itself, so there is nothing to map until one is loaded.
      {:else}
        Set the encoding, delimiter and header row above, then read the columns. Header row is the line the column
        <em>names</em> are on: Alior puts a criteria line above them, so it is 2 there.
      {/if}
    </p>
  {:else}
    <!-- The mapping table: one row per column in the file, with what is in it -->
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Label>Columns in your file</Label>
        <span class="text-xs text-muted-foreground">
          Click a role to give it to a column. Description and amount take several — description merges them with spaces, amount sums them.
        </span>
        {#if sampleRows.length > 0}
          <Button variant="ghost" class="ml-auto px-2 py-1 text-xs" onclick={reguessFromFile} title="Replace the whole mapping with a guess made from this file">
            Map it from this file
          </Button>
        {/if}
      </div>

      <div class="overflow-x-auto rounded-md border border-border">
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="bg-muted/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th class="px-3 py-2 font-medium">Column</th>
              <th class="px-3 py-2 font-medium">First rows in the file</th>
              <th class="px-3 py-2 font-medium">Use it as</th>
            </tr>
          </thead>
          <tbody>
            {#each columnOptions as c (c)}
              {@const samples = samplesFor(c)}
              {@const used = ROLES.some((r) => hasRole(c, r.key))}
              <tr class={'border-t border-border align-top ' + (used ? 'bg-primary/5' : '')}>
                <td class="px-3 py-2">
                  <span class="font-medium">{c}</span>
                </td>
                <td class="px-3 py-2">
                  {#if samples.length}
                    <span class="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      {#each samples as v, i (i)}
                        <span class="max-w-[18rem] truncate rounded bg-muted px-1.5 py-0.5 tabular-nums" title={v}>{v}</span>
                      {/each}
                    </span>
                  {:else if sampleRows.length === 0}
                    <span class="text-xs text-muted-foreground/60">—</span>
                  {:else if !headers.includes(c)}
                    <span class="text-xs text-warning-foreground">not in this file</span>
                  {:else}
                    <span class="text-xs text-muted-foreground/60">empty in the first rows</span>
                  {/if}
                </td>
                <td class="px-3 py-2">
                  <div class="flex flex-wrap gap-1">
                    {#each ROLES as role (role.key)}
                      {@const on = hasRole(c, role.key)}
                      <button
                        class={'rounded-full border px-2 py-0.5 text-xs transition ' +
                          (on
                            ? 'border-primary bg-primary/10 font-medium text-primary'
                            : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground')}
                        onclick={() => toggleRole(c, role.key)}
                        aria-pressed={on}
                        title={role.hint}
                      >
                        {role.label}
                      </button>
                    {/each}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <p class="text-xs text-muted-foreground">
        {mappedSummary}{#if sampleRows.length === 0} · the columns here come from the saved template — load a file to see its values{/if}
      </p>
      {#if sampleRows.length > 0 && missingFromFile.length}
        <p class="text-xs text-warning-foreground">
          This file has no {missingFromFile.map((c) => `“${c}”`).join(', ')} — either the encoding, delimiter or header row above is wrong for it, or
          the bank changed its export.
        </p>
      {/if}
    </div>

    <!-- Date format sits beside the column it applies to, with a sample to read it against -->
    {#if draft.dateColumn}
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1.5">
          <Label for="df">Date format in “{draft.dateColumn}”</Label>
          <Input id="df" bind:value={draft.dateFormat} placeholder="e.g. DD-MM-YYYY" class="w-56" />
        </div>
        {#if samplesFor(draft.dateColumn).length}
          <p class="pb-2 text-xs text-muted-foreground">
            The file has <span class="font-medium text-foreground">{samplesFor(draft.dateColumn)[0]}</span> — write the pattern that matches it.
            Tokens: YYYY, MM, DD, HH, mm, ss. Any time is truncated.
          </p>
        {:else}
          <p class="pb-2 text-xs text-muted-foreground">Tokens: YYYY, MM, DD, HH, mm, ss. Any time is truncated.</p>
        {/if}
      </div>
    {/if}

    <!-- Row filters -->
    <div class="flex flex-col gap-2">
      <Label>Row filters</Label>
      <p class="-mt-1 text-xs text-muted-foreground">
        By default a filter <em>excludes</em> matching rows — e.g. drop balance lines with <code>Exclude rows where Description contains SALDO</code>.
        Switch to <em>Keep only</em> to whitelist instead (e.g. <code>State equals COMPLETED</code>).
      </p>
      {#each draft.filters as filter, i (i)}
        <div class="flex flex-wrap items-center gap-2">
          <select bind:value={filter.mode} class={selectCls + ' max-w-[13rem]'}>
            {#each MODES as [v, label] (v)}<option value={v}>{label}</option>{/each}
          </select>
          <select bind:value={filter.column} class={selectCls + ' max-w-[12rem]'}>
            <option value="">column…</option>
            {#each columnOptions as c (c)}<option value={c}>{c}</option>{/each}
          </select>
          <select bind:value={filter.op} class={selectCls + ' max-w-[9rem]'}>
            {#each OPS as [v, label] (v)}<option value={v}>{label}</option>{/each}
          </select>
          <Input bind:value={filter.value} placeholder="value" class="max-w-[12rem]" />
          <Button variant="ghost" onclick={() => (draft.filters = draft.filters.filter((_, j) => j !== i))}><Icon name="trash" /></Button>
          {#if filterColumnMissing(filter.column)}
            <span class="text-xs text-warning-foreground">
              “{filter.column}” is not in this file — as written, this filter drops every row.
            </span>
          {/if}
        </div>
      {/each}
      <div>
        <Button variant="outline" onclick={() => (draft.filters = [...draft.filters, { column: '', op: 'contains', value: '', mode: 'exclude' }])}>
          <Icon name="plus" />Add filter
        </Button>
      </div>
    </div>
  {/if}

  <div class="flex flex-wrap items-center justify-end gap-3">
    {#if columnOptions.length > 0 && missing.length}
      <p class="mr-auto text-xs text-warning-foreground">Still needs {missing.join(', ')}.</p>
    {:else if brokenFilters > 0}
      <p class="mr-auto text-xs text-warning-foreground">
        {brokenFilters}
        {brokenFilters === 1 ? 'filter refers' : 'filters refer'} to a column this file does not have, so nothing would be imported.
      </p>
    {/if}
    <Button onclick={() => onSave(draft)} disabled={saving || columnOptions.length === 0}>{saving ? 'Saving…' : 'Save template'}</Button>
  </div>
</div>
