<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';

  let defaultCurrency = $state('');
  let globalFuzzyDistance = $state(0);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let saved = $state(false);

  onMount(async () => {
    const s = await api('/admin/app-settings');
    defaultCurrency = s.defaultCurrency;
    globalFuzzyDistance = s.globalFuzzyDistance;
    loading = false;
  });

  async function save(e) {
    e.preventDefault();
    error = '';
    saved = false;
    saving = true;
    try {
      const updated = await api('/admin/app-settings', {
        method: 'PUT',
        body: { defaultCurrency, globalFuzzyDistance: Number(globalFuzzyDistance) },
      });
      defaultCurrency = updated.defaultCurrency;
      globalFuzzyDistance = updated.globalFuzzyDistance;
      saved = true;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not save defaults.';
    } finally {
      saving = false;
    }
  }
</script>

<div class="mx-auto max-w-lg">
  <h2 class="mb-1 text-xl font-semibold">Application defaults</h2>
  <p class="mb-6 text-sm text-muted-foreground">
    Applied to each new user when their account is created. Changing these does not affect
    existing users.
  </p>

  <Card class="p-6">
    {#if loading}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else}
      <form class="flex flex-col gap-5" onsubmit={save}>
        <div class="flex flex-col gap-1.5">
          <Label for="currency">Default currency</Label>
          <Input id="currency" bind:value={defaultCurrency} maxlength="3" class="uppercase" placeholder="PLN" />
          <p class="text-xs text-muted-foreground">Three-letter ISO code (e.g. PLN, EUR, BRL).</p>
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="distance">Global fuzzy-match distance</Label>
          <Input id="distance" type="number" min="0" step="1" bind:value={globalFuzzyDistance} />
          <p class="text-xs text-muted-foreground">Default typo tolerance for keyword classification.</p>
        </div>

        {#if error}<p class="text-sm text-destructive">{error}</p>{/if}
        {#if saved}<p class="text-sm text-success">Saved.</p>{/if}

        <div>
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save defaults'}</Button>
        </div>
      </form>
    {/if}
  </Card>
</div>
