<script>
  import Button from '$lib/components/ui/Button.svelte';

  // OFX is self-describing, so unlike the CSV template this is entirely
  // optional — an account with nothing saved imports on the defaults. The only
  // real choice is which of the file's description-ish fields merge into the
  // transaction description, and in what order.
  let { settings, saving = false, onSave } = $props();

  const LABELS = {
    NAME: 'NAME — the payee/merchant as the bank names it',
    MEMO: 'MEMO — the free-text note',
    'PAYEE.NAME': 'PAYEE.NAME — the structured payee block, when sent',
    CHECKNUM: 'CHECKNUM — cheque / reference number',
    TRNTYPE: 'TRNTYPE — DEBIT, CREDIT, ATM, …',
  };

  // The edit buffer follows the settings it is editing. One card instance is
  // reused across accounts and re-rendered after a save, so seeding it once at
  // mount left it showing the *previous* account's fields.
  let fields = $state([]);
  $effect(() => {
    fields = [...(settings?.descriptionFields ?? ['NAME', 'MEMO'])];
  });

  // Clicking a field appends it (so click order is join order) or removes it.
  function toggle(field) {
    fields = fields.includes(field) ? fields.filter((f) => f !== field) : [...fields, field];
  }

  const dirty = $derived(JSON.stringify(fields) !== JSON.stringify(settings?.descriptionFields ?? []));
</script>

<div class="rounded-md border border-border bg-background p-3">
  <div class="mb-3 flex items-center gap-2 text-sm">
    <span class="font-medium">OFX description fields</span>
    <span class="text-muted-foreground">— merged in the order you pick them.</span>
  </div>

  <div class="flex flex-wrap gap-2">
    {#each settings?.available ?? [] as field (field)}
      {@const at = fields.indexOf(field)}
      <button
        type="button"
        onclick={() => toggle(field)}
        title={LABELS[field] ?? field}
        class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition {at >= 0
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-input bg-card text-muted-foreground hover:bg-accent'}"
      >
        {#if at >= 0}<span class="font-mono text-[10px] text-muted-foreground">{at + 1}</span>{/if}
        {field}
      </button>
    {/each}
  </div>

  <p class="mt-3 text-xs text-muted-foreground">
    Description preview: <span class="font-mono text-foreground">{fields.join(' ') || '— pick at least one —'}</span>
    · a field that only repeats text already in the description is skipped.
  </p>

  {#if settings?.acctId}
    <p class="mt-2 text-xs text-muted-foreground">
      Imports here are expected from account <span class="font-mono text-foreground">{settings.acctId}</span>{#if settings.bankId}
        at bank <span class="font-mono text-foreground">{settings.bankId}</span>{/if}. A file from a different account is flagged in the
      preview, never blocked.
    </p>
  {/if}

  <div class="mt-3 flex justify-end gap-2">
    {#if settings?.acctId}
      <Button variant="ghost" onclick={() => onSave({ descriptionFields: fields, forget: true })} disabled={saving || fields.length === 0}>
        Forget account id
      </Button>
    {/if}
    <Button onclick={() => onSave({ descriptionFields: fields })} disabled={saving || fields.length === 0 || !dirty}>
      {saving ? 'Saving…' : 'Save'}
    </Button>
  </div>
</div>
