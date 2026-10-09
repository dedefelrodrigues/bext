<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';
  import TemplateEditor from '$lib/components/TemplateEditor.svelte';
  import OfxSettingsCard from '$lib/components/OfxSettingsCard.svelte';

  let { initialAccountId = null, openEditor = false } = $props();

  let accounts = $state([]);
  let uploads = $state([]);
  let loading = $state(true);
  let pageError = $state('');
  let appliedDeepLink = null; // guard so a deep link is applied once per value

  let selectedAccountId = $state('');
  let template = $state(null);
  let ofxSettings = $state(null);
  let savingOfx = $state(false);
  let showEditor = $state(false);

  let filename = $state('');
  let fileB64 = $state('');
  let isOfx = $state(false); // sniffed from the file's own bytes, like the server does
  let headers = $state([]);
  let sampleRows = $state([]);
  let dragging = $state(false);
  let detecting = $state(false);
  let savingTemplate = $state(false);
  let liveDraft = $state(null); // latest editor draft, mirrored from TemplateEditor

  let preview = $state(null); // { headers, rows, summary }
  let excluded = $state(new Set());
  let previewing = $state(false);
  let confirming = $state(false);

  let copyFromId = $state('');

  const selectCls =
    'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring';

  const selectedAccount = $derived(accounts.find((a) => String(a.id) === selectedAccountId) ?? null);

  // The rail lists accounts under their institution, so picking one reads like
  // the Accounts page rather than like a dropdown of strings.
  const accountGroups = $derived.by(() => {
    const byInstitution = new Map();
    for (const a of accounts) {
      if (!byInstitution.has(a.institutionName)) byInstitution.set(a.institutionName, []);
      byInstitution.get(a.institutionName).push(a);
    }
    return [...byInstitution.entries()].map(([institution, list]) => ({ institution, accounts: list }));
  });

  // Which accounts already have a CSV template, and which import OFX (and so
  // need none) — the same question the Accounts page answers, shown where you
  // are about to feed one a file.
  let templates = $state([]);
  const templateAccountIds = $derived(new Set(templates.map((t) => t.accountId)));
  const ofxAccountIds = $derived(new Set(uploads.filter((u) => u.format === 'ofx').map((u) => u.accountId)));
  function accountState(a) {
    if (templateAccountIds.has(a.id)) return { label: 'CSV template', tone: 'ok' };
    if (ofxAccountIds.has(a.id)) return { label: 'OFX', tone: 'ok' };
    return { label: 'No template', tone: 'warn' };
  }

  // An account box is itself a drop target: dropping a statement on it picks
  // that account and loads the file in one move.
  let dropAccountId = $state(null);
  async function onAccountDrop(e, account) {
    e.preventDefault();
    dropAccountId = null;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (String(account.id) !== selectedAccountId) await selectAccount(String(account.id));
    takeFile(file);
  }

  async function refresh() {
    try {
      [accounts, uploads, templates] = await Promise.all([api('/accounts'), api('/uploads'), api('/templates')]);
      // A deep link (below) picks the account; otherwise default to the first.
      if (!selectedAccountId && accounts.length && !initialAccountId) await selectAccount(String(accounts[0].id));
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not load uploads.';
    } finally {
      loading = false;
    }
  }
  onMount(refresh);

  // Apply an incoming /uploads/:accountId[/edit] deep link once accounts load.
  $effect(() => {
    const target = initialAccountId ? String(initialAccountId) : null;
    const key = target ? `${target}:${openEditor}` : null;
    if (key && accounts.length && appliedDeepLink !== key) {
      appliedDeepLink = key;
      (async () => {
        if (accounts.some((a) => String(a.id) === target)) {
          await selectAccount(target);
          if (openEditor) showEditor = true;
        }
      })();
    }
  });

  async function selectAccount(id) {
    selectedAccountId = id;
    template = null;
    headers = [];
    sampleRows = [];
    liveDraft = null;
    preview = null;
    excluded = new Set();
    pageError = '';
    try {
      [template, ofxSettings] = await Promise.all([api(`/accounts/${id}/template`), api(`/accounts/${id}/ofx-settings`)]);
      showEditor = !template && !isOfx; // auto-open the CSV editor when none is configured yet
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not load the template.';
    }
  }

  // OFX/QFX files announce themselves in their first bytes — the same
  // content-based check the server does, so a mislabeled extension still lands
  // on the right path (and an OFX never asks for a CSV template).
  function sniffOfx(b64) {
    try {
      const head = atob(b64.slice(0, 512));
      return /^\s*OFXHEADER\s*:/im.test(head) || /<OFX>/i.test(head);
    } catch {
      return false;
    }
  }

  function onFileChange(e) {
    takeFile(e.target.files?.[0]);
  }

  function onDrop(e) {
    e.preventDefault();
    dragging = false;
    takeFile(e.dataTransfer?.files?.[0]);
  }

  function takeFile(file) {
    if (!file) return;
    filename = file.name;
    preview = null;
    headers = [];
    sampleRows = [];
    const reader = new FileReader();
    reader.onload = () => {
      fileB64 = String(reader.result).split(',')[1] ?? '';
      isOfx = sniffOfx(fileB64);
      if (isOfx) {
        showEditor = false;
        return;
      }
      // Reading the columns is the only thing you can do next with a CSV, and
      // the mapping table is useless until it has the file's own values in it.
      // The saved template's settings are the best first guess at how to read
      // it; when they are wrong the editor's own button re-reads.
      detect({
        encoding: template?.encoding ?? 'utf-8',
        delimiter: template?.delimiter ?? ',',
        headerRow: template?.headerRow ?? 0,
      });
    };
    reader.readAsDataURL(file);
  }

  async function detect(settings) {
    if (!fileB64) return;
    detecting = true;
    pageError = '';
    try {
      const res = await api(`/accounts/${selectedAccountId}/template/detect`, {
        method: 'POST',
        body: { ...settings, filename, contentBase64: fileB64 },
      });
      headers = res.headers;
      sampleRows = res.sampleRows ?? [];
      return res; // hand back to the editor so it can auto-guess the mapping
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not read the file.';
    } finally {
      detecting = false;
    }
  }

  async function saveTemplate(draft) {
    savingTemplate = true;
    pageError = '';
    try {
      template = await api(`/accounts/${selectedAccountId}/template`, { method: 'PUT', body: draft });
      showEditor = false;
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not save the template.';
    } finally {
      savingTemplate = false;
    }
  }

  async function saveOfxSettings(body) {
    savingOfx = true;
    pageError = '';
    try {
      ofxSettings = await api(`/accounts/${selectedAccountId}/ofx-settings`, { method: 'PUT', body });
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not save the OFX settings.';
    } finally {
      savingOfx = false;
    }
  }

  async function copyTemplate() {
    if (!copyFromId) return;
    pageError = '';
    try {
      template = await api(`/accounts/${selectedAccountId}/template/copy`, { method: 'POST', body: { fromAccountId: Number(copyFromId) } });
      showEditor = false;
      copyFromId = '';
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not copy the template.';
    }
  }

  async function runPreview() {
    if (!fileB64) return;
    previewing = true;
    pageError = '';
    preview = null;
    excluded = new Set();
    try {
      // Persist the latest editor draft first so the preview reflects any unsaved
      // template edits (e.g. a just-added row filter). OFX has no template at
      // all, so it skips both this and the "configure a template" gate.
      if (!isOfx) {
        if (liveDraft) {
          template = await api(`/accounts/${selectedAccountId}/template`, { method: 'PUT', body: liveDraft });
        }
        if (!template) {
          pageError = 'Configure and save a template first.';
          return;
        }
      }
      preview = await api(`/accounts/${selectedAccountId}/upload/preview`, { method: 'POST', body: { filename, contentBase64: fileB64 } });
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not preview the file.';
    } finally {
      previewing = false;
    }
  }

  function importable(row) {
    return row.status === 'ok' && !row.duplicate;
  }
  function toggle(index) {
    const next = new Set(excluded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    excluded = next;
  }
  const willImport = $derived(preview ? preview.rows.filter((r) => importable(r) && !excluded.has(r.index)).length : 0);

  async function confirmImport() {
    confirming = true;
    pageError = '';
    try {
      const res = await api(`/accounts/${selectedAccountId}/upload/confirm`, {
        method: 'POST',
        body: { filename, contentBase64: fileB64, excluded: [...excluded] },
      });
      preview = null;
      fileB64 = '';
      filename = '';
      isOfx = false;
      [uploads, ofxSettings] = await Promise.all([api('/uploads'), api(`/accounts/${selectedAccountId}/ofx-settings`)]);
      window.alert(`Imported ${res.imported} transaction${res.imported === 1 ? '' : 's'}.`);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not import.';
    } finally {
      confirming = false;
    }
  }

  async function rollback(u) {
    const parts = [`Delete upload "${u.filename}" and its ${u.currentCount} imported transaction${u.currentCount === 1 ? '' : 's'}?`];
    if (u.lockedCount) parts.push(`${u.lockedCount} are manually categorized (locked).`);
    if (u.splitCount) parts.push(`${u.splitCount} are split.`);
    parts.push('This cannot be undone.');
    if (!window.confirm(parts.join('\n'))) return;
    try {
      await api(`/uploads/${u.id}`, { method: 'DELETE' });
      uploads = await api('/uploads');
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not delete the upload.';
    }
  }

  function money(cents, currency) {
    const v = (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${v} ${currency}`;
  }
  const statusBadge = {
    filtered: { label: 'Filtered', cls: 'bg-muted text-muted-foreground' },
    error: { label: 'Error', cls: 'bg-destructive/10 text-destructive' },
  };
</script>

<div>
  <div class="mb-5">
    <h2 class="text-xl font-semibold">Uploads</h2>
    <p class="text-sm text-muted-foreground">
      Import bank extracts — CSV via a per-account template, or OFX/QFX with no mapping at all. Preview, then confirm.
    </p>
  </div>

  {#if pageError}<p class="mb-4 text-sm text-destructive">{pageError}</p>{/if}

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if accounts.length === 0}
    <Card class="p-8 text-center">
      <p class="text-sm text-muted-foreground">Create an account first, then come back to import its transactions.</p>
    </Card>
  {:else}
    <!-- Setup on the left, the work on the right: what you pick barely changes,
         while the mapping table and the preview want the whole window. -->
    <div class="grid gap-5 lg:grid-cols-[21rem_minmax(0,1fr)] lg:items-start">
      <aside class="lg:sticky lg:top-4">
        <Card class="flex flex-col gap-3 p-3">
          <div class="flex flex-col gap-1.5">
            <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Import into</span>
            <!-- One box per account, under its institution. A statement can be
                 dropped straight onto the account it belongs to, which picks
                 that account and loads the file in one move. -->
            <div class="-mx-1 flex max-h-[19rem] flex-col gap-2 overflow-y-auto px-1">
              {#each accountGroups as group (group.institution)}
                <div class="flex flex-col gap-1">
                  <span class="px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">{group.institution}</span>
                  {#each group.accounts as a (a.id)}
                    {@const on = String(a.id) === selectedAccountId}
                    {@const st = accountState(a)}
                    <button
                      class={'w-full rounded-lg border px-2.5 py-2 text-left transition ' +
                        (dropAccountId === a.id
                          ? 'border-primary bg-primary/10 ring-1 ring-primary'
                          : on
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-input hover:bg-accent')}
                      onclick={() => selectAccount(String(a.id))}
                      ondragover={(e) => { e.preventDefault(); dropAccountId = a.id; }}
                      ondragleave={() => { if (dropAccountId === a.id) dropAccountId = null; }}
                      ondrop={(e) => onAccountDrop(e, a)}
                      aria-pressed={on}
                      title={`Import into ${a.name} — or drop a statement here`}
                    >
                      <span class="flex items-center gap-1.5">
                        <span class="min-w-0 flex-1 truncate text-sm font-medium">{a.name}</span>
                        <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{a.currency}</span>
                      </span>
                      <span class="mt-0.5 flex items-center gap-1.5 text-[11px]">
                        <span class="min-w-0 flex-1 truncate text-muted-foreground">{a.holder}</span>
                        <span
                          class={'shrink-0 rounded px-1 py-0.5 ' +
                            (st.tone === 'ok'
                              ? 'bg-success/10 text-success'
                              : 'border border-warning-border bg-warning text-warning-foreground')}
                        >
                          {st.label}
                        </span>
                      </span>
                      {#if dropAccountId === a.id}
                        <span class="mt-1 block text-[11px] font-medium text-primary">Drop to import here</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/each}
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">File</span>
            <label
              class={'flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed px-3 py-4 text-center transition ' +
                (dragging ? 'border-primary bg-primary/5' : 'border-input hover:bg-accent')}
              ondragover={(e) => { e.preventDefault(); dragging = true; }}
              ondragleave={() => (dragging = false)}
              ondrop={onDrop}
            >
              <input type="file" accept="text/csv,.csv,.ofx,.qfx" class="hidden" onchange={onFileChange} />
              <Icon name="upload" />
              {#if filename}
                <span class="w-full truncate text-sm font-medium" title={filename}>{filename}</span>
                <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{isOfx ? 'OFX' : 'CSV'}</span>
              {:else}
                <span class="text-sm font-medium">Choose a file</span>
                <span class="text-xs text-muted-foreground">
                  {selectedAccount ? `or drop a CSV, OFX or QFX for ${selectedAccount.name}` : 'or drop a CSV, OFX or QFX here'}
                </span>
              {/if}
            </label>
          </div>

          <!-- What this account needs to read that file -->
          <div class="rounded-md border border-border bg-background p-2.5">
            {#if isOfx}
              <p class="text-xs">
                <span class="font-medium text-foreground">OFX — no template needed.</span>
                <span class="text-muted-foreground"> The file names its own dates, amounts, currencies and descriptions.</span>
              </p>
            {:else if template}
              <p class="text-xs">
                <span class="font-medium text-foreground">Template ready</span>
                <span class="text-muted-foreground">
                  · date {template.dateColumn} ({template.dateFormat}) · {template.amountColumns.length} amount column{template.amountColumns.length === 1 ? '' : 's'}
                  · {template.filters.length} filter{template.filters.length === 1 ? '' : 's'}
                </span>
              </p>
            {:else}
              <p class="text-xs font-medium text-warning-foreground">No template for this account yet.</p>
            {/if}
            {#if !isOfx}
              <Button variant="outline" class="mt-2 w-full" onclick={() => (showEditor = !showEditor)}>
                <Icon name={showEditor ? 'chevron-down' : 'pencil'} />{showEditor ? 'Hide the template' : template ? 'Edit template' : 'Set up the template'}
              </Button>
            {/if}
          </div>

          {#if !isOfx && showEditor && accounts.length > 1}
            <div class="flex flex-col gap-1.5">
              <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Copy a template</span>
              <select bind:value={copyFromId} class={selectCls}>
                <option value="">— from another account —</option>
                {#each accounts.filter((a) => String(a.id) !== selectedAccountId) as a (a.id)}
                  <option value={String(a.id)}>{a.institutionName} · {a.name}</option>
                {/each}
              </select>
              <Button variant="outline" onclick={copyTemplate} disabled={!copyFromId}>Copy it here</Button>
            </div>
          {/if}

          <div class="border-t border-border pt-3">
            <Button class="w-full" onclick={runPreview} disabled={!fileB64 || previewing || (!isOfx && !template && !liveDraft)}>
              <Icon name="search" />{previewing ? 'Reading…' : 'Preview import'}
            </Button>
            {#if showEditor && liveDraft}
              <p class="mt-1.5 text-xs text-muted-foreground">Preview saves your template edits first.</p>
            {:else if !fileB64}
              <p class="mt-1.5 text-xs text-muted-foreground">Choose a file to preview what it would import.</p>
            {/if}
          </div>
        </Card>
      </aside>

      <div class="flex min-w-0 flex-col gap-5">
        {#if isOfx && ofxSettings}
          <Card class="p-4">
            <OfxSettingsCard settings={ofxSettings} saving={savingOfx} onSave={saveOfxSettings} />
          </Card>
        {/if}

        {#if !isOfx && showEditor}
          <Card class="p-4">
            <h3 class="mb-3 text-sm font-semibold">Import template — {selectedAccount?.name ?? ''}</h3>
            <TemplateEditor
              initial={template}
              {headers}
              {sampleRows}
              hasFile={!!fileB64}
              {detecting}
              saving={savingTemplate}
              onDetect={detect}
              onSave={saveTemplate}
              onChange={(d) => (liveDraft = d)}
            />
          </Card>
        {/if}

        <!-- Preview -->
        {#if preview}
          <Card class="p-4">
            {#if preview.accountWarning}
              <p class="mb-3 rounded-md border border-warning-border bg-warning px-3 py-2 text-sm text-warning-foreground">{preview.accountWarning}</p>
            {/if}
            <div class="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span class="rounded bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">{preview.format === 'ofx' ? 'OFX' : 'CSV'}</span>
              <span class="rounded bg-primary/10 px-2 py-0.5 font-medium text-foreground">{preview.summary.toImport} to import</span>
              {#if preview.summary.duplicates}<span class="rounded bg-muted px-2 py-0.5 text-muted-foreground">{preview.summary.duplicates} duplicate</span>{/if}
              {#if preview.summary.filtered}<span class="rounded bg-muted px-2 py-0.5 text-muted-foreground">{preview.summary.filtered} filtered</span>{/if}
              {#if preview.summary.errors}<span class="rounded bg-destructive/10 px-2 py-0.5 text-destructive">{preview.summary.errors} error</span>{/if}
              <span class="ml-auto text-muted-foreground">{willImport} selected</span>
            </div>

            <div class="max-h-[60vh] overflow-auto rounded-md border border-border">
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                  <tr>
                    <th class="w-8 px-2 py-2"></th>
                    <th class="px-2 py-2">Date</th>
                    <th class="w-1/2 px-2 py-2">Description</th>
                    <th class="px-2 py-2 text-right">Amount</th>
                    <th class="px-2 py-2">Category</th>
                    <th class="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {#each preview.rows as row (row.index)}
                    <tr class="border-t border-border {importable(row) ? '' : 'opacity-60'}">
                      <td class="px-2 py-1.5">
                        {#if importable(row)}
                          <input type="checkbox" checked={!excluded.has(row.index)} onchange={() => toggle(row.index)} />
                        {/if}
                      </td>
                      {#if row.status === 'ok'}
                        <td class="whitespace-nowrap px-2 py-1.5 tabular-nums text-muted-foreground">{row.date}</td>
                        <td class="max-w-0 truncate px-2 py-1.5" title={row.description}>{row.description}</td>
                        <td class="whitespace-nowrap px-2 py-1.5 text-right tabular-nums {row.amountCents < 0 ? 'text-foreground' : 'text-success'}">{money(row.amountCents, row.currency)}</td>
                        <td class="whitespace-nowrap px-2 py-1.5">
                          {#if row.category}
                            <span class="inline-flex items-center gap-1 text-muted-foreground">
                              <CategoryIcon name={row.category.icon} categoryId={row.category.id} size={13} class="shrink-0" />
                              {row.category.name}{#if row.subcategory}<span class="text-muted-foreground/70"> › {row.subcategory.name}</span>{/if}
                            </span>
                          {:else}<span class="text-muted-foreground/50">—</span>{/if}
                        </td>
                        <td class="px-2 py-1.5">
                          {#if row.duplicate}<span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Duplicate</span>
                          {:else}<span class="rounded bg-success/10 px-1.5 py-0.5 text-xs text-success">New</span>{/if}
                        </td>
                      {:else}
                        <td class="px-2 py-1.5 text-muted-foreground" colspan="4">{row.reason}</td>
                        <td class="px-2 py-1.5"><span class="rounded px-1.5 py-0.5 text-xs {statusBadge[row.status].cls}">{statusBadge[row.status].label}</span></td>
                      {/if}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <div class="mt-4 flex justify-end gap-2">
              <Button variant="outline" onclick={() => (preview = null)}>Cancel</Button>
              <Button onclick={confirmImport} disabled={confirming || willImport === 0}>{confirming ? 'Importing…' : `Import ${willImport} transaction${willImport === 1 ? '' : 's'}`}</Button>
            </div>
          </Card>
        {:else if !showEditor && !isOfx}
          <Card class="p-8 text-center">
            <p class="text-sm text-muted-foreground">
              {#if !fileB64}
                Choose a file on the left. Its columns are read from the file itself, so nothing here fills in until one is loaded.
              {:else}
                Ready — press <span class="font-medium text-foreground">Preview import</span> to see what this file would bring in.
              {/if}
            </p>
          </Card>
        {/if}

        <!-- Archive -->
        <div>
          <h3 class="mb-2 font-semibold">Upload history</h3>
          {#if uploads.length === 0}
            <Card class="p-6 text-center"><p class="text-sm text-muted-foreground">No uploads yet.</p></Card>
          {:else}
            <Card class="overflow-hidden">
              <table class="w-full border-collapse text-sm">
                <thead>
                  <tr class="text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th class="border-b border-border px-3 py-2 text-left font-medium">File</th>
                    <th class="border-b border-border px-3 py-2 text-left font-medium">Account</th>
                    <th class="border-b border-border px-3 py-2 text-left font-medium">When</th>
                    <th class="border-b border-border px-3 py-2 text-right font-medium">Imported</th>
                    <th class="border-b border-border px-3 py-2 text-right font-medium">Still there</th>
                    <th class="border-b border-border px-3 py-2 text-left font-medium">Would destroy</th>
                    <th class="border-b border-border px-3 py-2"><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {#each uploads as u (u.id)}
                    <tr class="hover:bg-accent/40">
                      <td class="border-b border-border px-3 py-2">
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{(u.format ?? 'csv').toUpperCase()}</span>
                          <span class="truncate font-medium" title={u.filename}>{u.filename}</span>
                        </span>
                      </td>
                      <td class="border-b border-border px-3 py-2 text-muted-foreground">{u.accountName}</td>
                      <td class="whitespace-nowrap border-b border-border px-3 py-2 tabular-nums text-muted-foreground">
                        {new Date(u.uploadedAt + 'Z').toLocaleString()}
                      </td>
                      <td class="border-b border-border px-3 py-2 text-right tabular-nums">{u.importedCount}</td>
                      <td class="border-b border-border px-3 py-2 text-right tabular-nums">{u.currentCount}</td>
                      <td class="whitespace-nowrap border-b border-border px-3 py-2 text-xs text-muted-foreground">
                        {#if u.lockedCount || u.splitCount}
                          {#if u.lockedCount}<span class="rounded bg-warning px-1.5 py-0.5 text-warning-foreground">{u.lockedCount} locked</span>{/if}
                          {#if u.splitCount}<span class="ml-1 rounded bg-warning px-1.5 py-0.5 text-warning-foreground">{u.splitCount} split</span>{/if}
                        {:else}
                          <span class="text-muted-foreground/50">—</span>
                        {/if}
                      </td>
                      <td class="border-b border-border px-3 py-2">
                        <div class="flex justify-end">
                          <IconButton variant="danger" onclick={() => rollback(u)} title="Delete this upload and its transactions" aria-label={`Delete the upload ${u.filename}`}>
                            <Icon name="trash" />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </Card>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
