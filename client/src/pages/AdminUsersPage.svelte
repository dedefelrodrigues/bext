<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { auth } from '$lib/stores/auth.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';

  let userList = $state([]);
  let loading = $state(true);
  let listError = $state('');

  // Create-user form
  let newUsername = $state('');
  let newPassword = $state('');
  let newIsAdmin = $state(false);
  let createError = $state('');
  let creating = $state(false);

  // Per-row password reset
  let resetForId = $state(null);
  let resetPassword = $state('');
  let resetError = $state('');

  async function refresh() {
    listError = '';
    try {
      userList = await api('/admin/users');
    } catch (err) {
      listError = err instanceof ApiError ? err.message : 'Could not load users.';
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  async function createUser(e) {
    e.preventDefault();
    createError = '';
    creating = true;
    try {
      await api('/admin/users', {
        method: 'POST',
        body: { username: newUsername, password: newPassword, isAdmin: newIsAdmin },
      });
      newUsername = '';
      newPassword = '';
      newIsAdmin = false;
      await refresh();
    } catch (err) {
      createError = err instanceof ApiError ? err.message : 'Could not create user.';
    } finally {
      creating = false;
    }
  }

  async function toggleAdmin(user) {
    try {
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { isAdmin: !user.isAdmin } });
      await refresh();
    } catch (err) {
      listError = err instanceof ApiError ? err.message : 'Could not update user.';
    }
  }

  function openReset(user) {
    resetForId = resetForId === user.id ? null : user.id;
    resetPassword = '';
    resetError = '';
  }

  async function submitReset(user) {
    resetError = '';
    try {
      await api(`/admin/users/${user.id}/password`, {
        method: 'POST',
        body: { newPassword: resetPassword },
      });
      resetForId = null;
      resetPassword = '';
    } catch (err) {
      resetError = err instanceof ApiError ? err.message : 'Could not reset password.';
    }
  }

  async function deleteUser(user) {
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    try {
      await api(`/admin/users/${user.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      listError = err instanceof ApiError ? err.message : 'Could not delete user.';
    }
  }
</script>

<div class="mx-auto max-w-3xl">
  <h2 class="mb-1 text-xl font-semibold">User management</h2>
  <p class="mb-6 text-sm text-muted-foreground">Create, delete, and reset passwords for application users.</p>

  <Card class="mb-8 p-6">
    <h3 class="mb-4 text-sm font-semibold">New user</h3>
    <form class="flex flex-col gap-4" onsubmit={createUser}>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <Label for="nu">Username</Label>
          <Input id="nu" bind:value={newUsername} required />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="np">Password</Label>
          <Input id="np" type="password" bind:value={newPassword} required />
        </div>
      </div>
      <label class="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" bind:checked={newIsAdmin} /> Administrator
      </label>
      {#if createError}
        <p class="text-sm text-destructive">{createError}</p>
      {/if}
      <div>
        <Button type="submit" disabled={creating}>
          <Icon name="plus" />{creating ? 'Creating…' : 'Create user'}
        </Button>
      </div>
    </form>
  </Card>

  <Card class="p-2">
    {#if loading}
      <p class="p-4 text-sm text-muted-foreground">Loading…</p>
    {:else if listError}
      <p class="p-4 text-sm text-destructive">{listError}</p>
    {:else}
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th class="px-4 py-2 font-medium">User</th>
            <th class="px-4 py-2 font-medium">Role</th>
            <th class="px-4 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each userList as user (user.id)}
            <tr class="border-b border-border last:border-0">
              <td class="px-4 py-3">
                <span class="font-medium">{user.username}</span>
                {#if user.id === auth.user.id}<span class="ml-1 text-xs text-muted-foreground">(you)</span>{/if}
              </td>
              <td class="px-4 py-3">
                {#if user.isAdmin}
                  <span class="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">Admin</span>
                {:else}
                  <span class="text-muted-foreground">User</span>
                {/if}
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center justify-end gap-1">
                  <Button variant="ghost" onclick={() => toggleAdmin(user)}>
                    <Icon name="shield" />{user.isAdmin ? 'Revoke admin' : 'Make admin'}
                  </Button>
                  <IconButton onclick={() => openReset(user)} title="Reset password" aria-label="Reset password">
                    <Icon name="key" />
                  </IconButton>
                  <IconButton variant="danger" onclick={() => deleteUser(user)} title="Delete user" aria-label="Delete user">
                    <Icon name="trash" />
                  </IconButton>
                </div>
                {#if resetForId === user.id}
                  <div class="mt-2 flex items-center justify-end gap-2">
                    <Input
                      type="password"
                      placeholder="New password"
                      bind:value={resetPassword}
                      class="max-w-48"
                    />
                    <Button onclick={() => submitReset(user)}>Set</Button>
                  </div>
                  {#if resetError}<p class="mt-1 text-right text-xs text-destructive">{resetError}</p>{/if}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </Card>
</div>
