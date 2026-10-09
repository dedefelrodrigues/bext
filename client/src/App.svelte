<script>
  import { auth, loadUser } from '$lib/stores/auth.svelte.js';
  import AuthPage from './pages/AuthPage.svelte';
  import AppShell from '$lib/components/AppShell.svelte';

  loadUser();
</script>

{#if auth.loading}
  <div class="flex min-h-screen items-center justify-center text-sm text-gray-500">Loading…</div>
{:else if !auth.user}
  <AuthPage />
{:else}
  <AppShell />
{/if}
