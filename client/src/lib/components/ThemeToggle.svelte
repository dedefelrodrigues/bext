<script>
  import { theme } from '$lib/theme.svelte.js';
  import { setTheme } from '$lib/stores/auth.svelte.js';

  const isDark = $derived(theme.value === 'dark');

  async function toggle() {
    try {
      await setTheme(isDark ? 'light' : 'dark');
    } catch {
      // Optimistic apply already happened; ignore persistence errors.
    }
  }
</script>

<button
  type="button"
  onclick={toggle}
  aria-label="Toggle dark mode"
  title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
  class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-card text-foreground transition hover:bg-accent"
>
  {#if isDark}
    <!-- sun -->
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  {:else}
    <!-- moon -->
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  {/if}
</button>
