<script>
  import Card from '$lib/components/ui/Card.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';

  // The right-hand hashtag palette on the transactions page. Tags are draggable
  // onto transaction rows; with rows selected they can also be applied in bulk
  // from here. Clicking a tag filters the list by it.
  let {
    hashtags = [],
    activeId = '',
    selectedCount = 0,
    onFilter,
    onCreate,
    onDelete,
    onApply,
    onDragStart,
    onDragEnd,
  } = $props();

  let newName = $state('');
  let busy = $state(false);
  let error = $state('');

  async function create(e) {
    e.preventDefault();
    const name = newName.trim().replace(/^#+/, '').trim();
    if (!name) return;
    busy = true;
    error = '';
    try {
      await onCreate(name);
      newName = '';
    } catch (err) {
      error = err?.message ?? 'Could not create the hashtag.';
    } finally {
      busy = false;
    }
  }
</script>

<Card class="p-2">
  <div class="mb-1 flex items-center justify-between px-1.5">
    <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Hashtags</span>
    {#if activeId}
      <button class="text-xs text-muted-foreground underline hover:text-foreground" onclick={() => onFilter('')}>Clear</button>
    {/if}
  </div>

  <form class="flex items-center gap-1 px-1 pb-2" onsubmit={create}>
    <input
      bind:value={newName}
      placeholder="New hashtag"
      maxlength="60"
      class="min-w-0 flex-1 rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
    />
    <IconButton type="submit" disabled={busy || !newName.trim()} title="Create hashtag" aria-label="Create hashtag"><Icon name="plus" /></IconButton>
  </form>
  {#if error}<p class="px-1.5 pb-1 text-xs text-destructive">{error}</p>{/if}

  {#if hashtags.length === 0}
    <p class="px-1.5 py-2 text-xs text-muted-foreground">No hashtags yet. Create one, then drag it onto a transaction.</p>
  {:else}
    <div class="max-h-[50vh] space-y-0.5 overflow-y-auto pr-0.5">
      {#each hashtags as h (h.id)}
        <div
          class="group flex items-center gap-1 rounded hover:bg-accent"
          draggable="true"
          ondragstart={(e) => {
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', `#${h.name}`);
            onDragStart(h);
          }}
          ondragend={() => onDragEnd()}
          role="listitem"
        >
          <button
            class={'flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm active:cursor-grabbing ' +
              (String(activeId) === String(h.id) ? 'bg-primary/10 font-medium text-primary' : '')}
            onclick={() => onFilter(String(activeId) === String(h.id) ? '' : String(h.id))}
            title={`Filter by #${h.name} — or drag onto a transaction`}
          >
            <Icon name="tag" size={12} class="shrink-0 text-muted-foreground" />
            <span class="flex-1 truncate">{h.name}</span>
            <span class="text-xs text-muted-foreground">{h.uses}</span>
          </button>
          {#if selectedCount > 0}
            <IconButton
              class="h-6 w-6 shrink-0"
              onclick={() => onApply(h)}
              title={`Tag ${selectedCount} selected transaction${selectedCount === 1 ? '' : 's'}`}
              aria-label="Tag selected transactions"
            >
              <Icon name="plus" size={13} />
            </IconButton>
          {:else}
            <IconButton
              variant="danger"
              class="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
              onclick={() => onDelete(h)}
              title="Delete hashtag"
              aria-label="Delete hashtag"
            >
              <Icon name="trash" size={13} />
            </IconButton>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <p class="px-1.5 pt-2 text-[11px] leading-snug text-muted-foreground">
    Drag a tag onto a transaction to attach it. With rows selected, dropping on any selected row tags them all.
  </p>
</Card>
