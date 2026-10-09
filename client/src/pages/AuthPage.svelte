<script>
  import { login } from '$lib/stores/auth.svelte.js';
  import { ApiError } from '$lib/api.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';

  let username = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(e) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      await login(username, password);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Something went wrong.';
    } finally {
      busy = false;
    }
  }
</script>

<main class="flex min-h-screen items-center justify-center bg-background p-4">
  <Card class="w-full max-w-sm p-6">
    <h1 class="text-2xl font-bold tracking-tight">BeXT</h1>
    <p class="mt-1 mb-6 text-sm text-muted-foreground">Sign in to your account</p>

    <form class="flex flex-col gap-4" onsubmit={submit}>
      <div class="flex flex-col gap-1.5">
        <Label for="username">Username</Label>
        <Input id="username" bind:value={username} autocomplete="username" required />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="password">Password</Label>
        <Input
          id="password"
          type="password"
          bind:value={password}
          autocomplete="current-password"
          required
        />
      </div>

      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}

      <Button type="submit" disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</Button>
    </form>

    <p class="mt-4 text-center text-xs text-muted-foreground">
      Accounts are created by an administrator.
    </p>
  </Card>
</main>
