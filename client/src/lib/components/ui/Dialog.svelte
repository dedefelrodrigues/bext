<script>
  let { open = $bindable(false), title = '', children } = $props();

  function onKeydown(e) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <button
      class="absolute inset-0 bg-black/50"
      aria-label="Close dialog"
      onclick={() => (open = false)}
    ></button>
    <div class="relative z-10 w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
      {#if title}<h3 class="mb-4 text-lg font-semibold">{title}</h3>{/if}
      {@render children?.()}
    </div>
  </div>
{/if}
