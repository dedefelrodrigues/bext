<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { navigate } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';

  // Which engine runs the AI categorization, and the key it runs on.
  //
  // The key is the only secret this app stores for you, so the card is explicit
  // about it: it is held encrypted on the server, it is never sent back to the
  // browser, and the card shows its last four characters so you can tell which
  // one is saved without revealing it.

  let engines = $state([]);
  let provider = $state('anthropic');
  let model = $state('');
  let webSearch = $state(true);
  let batchSize = $state(25);
  let engine = $state(null);

  let keyDraft = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let savingKey = $state(false);
  let error = $state('');
  let saved = $state(false);

  const selected = $derived(engines.find((e) => e.id === provider) ?? null);
  const effectiveModel = $derived(model || selected?.defaultModel || '');

  async function refresh() {
    const [engineList, settings] = await Promise.all([api('/ai/engines'), api('/ai/settings')]);
    engines = engineList;
    provider = settings.provider;
    model = settings.model;
    webSearch = settings.webSearch;
    batchSize = settings.batchSize;
    engine = settings.engine;
  }

  onMount(async () => {
    try {
      await refresh();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load the AI settings.';
    } finally {
      loading = false;
    }
  });

  // Picking a provider drops the model with it: "gpt-5" would name an engine
  // Claude cannot be.
  function pickProvider(id) {
    if (provider === id) return;
    provider = id;
    model = '';
    keyDraft = '';
    saved = false;
  }

  async function save(e) {
    e?.preventDefault();
    error = '';
    saved = false;
    saving = true;
    try {
      const res = await api('/ai/settings', {
        method: 'PUT',
        body: { provider, model, webSearch, batchSize: Number(batchSize) },
      });
      model = res.model;
      engine = res.engine;
      saved = true;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not save the AI settings.';
    } finally {
      saving = false;
    }
  }

  async function saveKey() {
    if (!keyDraft.trim()) return;
    error = '';
    savingKey = true;
    try {
      await api(`/ai/keys/${provider}`, { method: 'PUT', body: { key: keyDraft.trim() } });
      keyDraft = '';
      await refresh();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not save the key.';
    } finally {
      savingKey = false;
    }
  }

  async function removeKey() {
    error = '';
    savingKey = true;
    try {
      await api(`/ai/keys/${provider}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not remove the key.';
    } finally {
      savingKey = false;
    }
  }
</script>

<Card class="p-5">
  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else}
    <form class="flex flex-col gap-5" onsubmit={save}>
      <!-- Engine -->
      <div class="flex flex-col gap-2">
        <Label>Engine</Label>
        <div class="grid gap-1.5 sm:grid-cols-2">
          {#each engines as e (e.id)}
            <button
              type="button"
              class={'flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition ' +
                (provider === e.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent')}
              onclick={() => pickProvider(e.id)}
              aria-pressed={provider === e.id}
            >
              <span class="mt-0.5">
                <Icon name={provider === e.id ? 'check' : 'sparkles'} size={14} />
              </span>
              <span class="min-w-0">
                <span class="block text-sm font-medium">{e.label}</span>
                <span class="block text-xs text-muted-foreground">
                  {#if e.keySource === 'server'}
                    {e.hasKey ? 'Free, provided by this server' : `Unavailable — ${e.keyEnv} is not set`}
                  {:else if e.hasKey}
                    Key saved {e.hint}
                  {:else}
                    No key yet
                  {/if}
                  {#if !e.supportsWebSearch} · cannot search the web{/if}
                </span>
              </span>
            </button>
          {/each}
        </div>
      </div>

      <!-- The selected engine's key -->
      {#if selected?.keySource === 'user'}
        <div class="flex flex-col gap-1.5">
          <Label for="ai-key">{selected.keyLabel}</Label>
          <div class="flex gap-2">
            <Input
              id="ai-key"
              type="password"
              bind:value={keyDraft}
              placeholder={selected.hasKey ? `Saved ${selected.hint} — enter a new key to replace it` : selected.keyPlaceholder}
              autocomplete="off"
            />
            <Button variant="outline" onclick={saveKey} disabled={savingKey || !keyDraft.trim()}>Save key</Button>
            {#if selected.hasKey}
              <Button variant="ghost" onclick={removeKey} disabled={savingKey}>Remove</Button>
            {/if}
          </div>
          <p class="text-xs text-muted-foreground">
            Stored encrypted on the server and never sent back to this page. Runs are billed to this key by
            {selected.label}.
          </p>
        </div>
      {:else if selected}
        <p class="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {#if selected.hasKey}
            This engine runs on a key the server provides — nothing to enter, and nothing billed to you.
          {:else}
            This engine is offered only when the server sets <code>{selected.keyEnv}</code>. Ask whoever runs BeXT to set
            it, or pick an engine you hold a key for.
          {/if}
        </p>
      {/if}

      <div class="grid gap-5 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <Label for="ai-model">Model</Label>
          <Input id="ai-model" bind:value={model} placeholder={selected?.defaultModel ?? ''} list="ai-models" />
          <datalist id="ai-models">
            {#each selected?.models ?? [] as m (m)}<option value={m}></option>{/each}
          </datalist>
          <p class="text-xs text-muted-foreground">
            Blank uses {selected?.defaultModel}. Provider and model together are the <em>engine</em>: changing either one
            lets you re-analyze merchants an earlier engine already answered.
          </p>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="ai-batch">Merchants per run</Label>
          <Input id="ai-batch" type="number" min="1" max="200" bind:value={batchSize} />
          <p class="text-xs text-muted-foreground">
            A run analyzes this many <em>merchants</em>, not rows — repeats of one shop are one lookup.
          </p>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <Switch
          checked={webSearch}
          disabled={!selected?.supportsWebSearch}
          onCheckedChange={(v) => (webSearch = v)}
          aria-label="Look the merchant up on the web"
        />
        <div class="min-w-0">
          <p class="text-sm font-medium">Look the merchant up on the web</p>
          <p class="text-xs text-muted-foreground">
            {#if selected?.supportsWebSearch}
              Resolves an abbreviated statement line to a real business before categorizing it. Slower, and each search
              costs — turn it off for a fast, cheap pass on merchants you expect the model to know.
            {:else}
              {selected?.label} has no web search in its API. Its proposals are made from the description alone, and are
              logged as ungrounded.
            {/if}
          </p>
        </div>
      </div>

      {#if error}<p class="text-sm text-destructive">{error}</p>{/if}

      <div class="flex items-center gap-3">
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        {#if saved}<span class="text-sm text-muted-foreground">Saved.</span>{/if}
        <button type="button" class="ml-auto text-sm text-primary underline" onclick={() => navigate('/ai')}>
          Go to AI review
        </button>
      </div>

      {#if engine && !engine.ready}
        <p class="rounded-md border border-warning-border bg-warning px-3 py-2 text-xs text-warning-foreground">
          {engine.reason}
        </p>
      {:else if engine}
        <p class="text-xs text-muted-foreground">
          Ready: {engine.label} · {effectiveModel} · web lookup {engine.webSearch ? 'on' : 'off'}.
        </p>
      {/if}
    </form>
  {/if}
</Card>
