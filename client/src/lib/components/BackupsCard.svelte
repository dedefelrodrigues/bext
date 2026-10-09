<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';

  // Snapshots of the whole database. The app takes one on its own before
  // anything that destroys transactions; this is the button for the moment
  // *you* know is risky — the evening you re-import six statements.
  //
  // The files are never served over HTTP (a snapshot holds every user's data),
  // so the card shows the folder to open rather than a download link.
  let data = $state({ dir: '', keep: 5, backups: [] });
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let justCreated = $state('');

  // Why a snapshot was taken, in words rather than the filename's slug.
  const REASONS = {
    manual: 'you asked',
    'before-upload': 'before an import',
    'before-rollback': 'before an upload rollback',
    'before-clear': 'before clearing transactions',
    'before-account-delete': 'before deleting an account',
    'before-user-delete': 'before deleting a user',
    'pre-restore': 'before a restore',
  };
  const reason = (label) => REASONS[label] ?? label.replace(/-/g, ' ');

  const size = (bytes) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  function when(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function load() {
    try {
      data = await api('/settings/backups');
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not list the backups.';
    }
    loading = false;
  }

  async function backupNow() {
    busy = true;
    error = '';
    justCreated = '';
    try {
      const res = await api('/settings/backups', { method: 'POST', body: {} });
      data = res;
      justCreated = res.created;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not write the backup.';
    } finally {
      busy = false;
    }
  }

  onMount(load);
</script>

<Card class="p-6">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold">Backups</h3>
      <p class="mt-1 text-xs text-muted-foreground">
        A complete copy of the database, taken automatically before an import, a rollback, a clear or a
        deleted account — and whenever you press the button. The newest {data.keep} are kept; older ones are
        removed as new ones arrive.
      </p>
    </div>
    <Button variant="outline" class="shrink-0" onclick={backupNow} disabled={busy}>
      {busy ? 'Backing up…' : 'Back up now'}
    </Button>
  </div>

  {#if error}
    <p class="mt-3 text-sm text-destructive">{error}</p>
  {/if}

  {#if loading}
    <p class="mt-3 text-sm text-muted-foreground">Loading…</p>
  {:else if data.backups.length === 0}
    <p class="mt-3 text-sm text-muted-foreground">No backups yet.</p>
  {:else}
    <ul class="mt-4 divide-y divide-border border-t border-border">
      {#each data.backups as b (b.name)}
        <li class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm">
          <span class="tabular-nums">{when(b.takenAt)}</span>
          <span class="text-muted-foreground">{reason(b.label)}</span>
          <span class="ml-auto tabular-nums text-xs text-muted-foreground">{size(b.bytes)}</span>
          {#if b.name === justCreated}
            <span class="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">just now</span>
          {/if}
          <span class="w-full truncate font-mono text-xs text-muted-foreground">{b.name}</span>
        </li>
      {/each}
    </ul>

    <p class="mt-3 text-xs text-muted-foreground">
      The files live in <code class="font-mono">{data.dir}</code>. To go back to one, stop the server and run
      <code class="font-mono">npm run db:restore &lt;file&gt;</code> — it checks the snapshot, tells you what is
      in it, and keeps the current database before swapping.
    </p>
  {/if}
</Card>
