<script>
  import { auth, logout } from '$lib/stores/auth.svelte.js';
  import { router, navigate } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import HomePage from '../../pages/HomePage.svelte';
  import AccountsPage from '../../pages/AccountsPage.svelte';
  import CategoriesPage from '../../pages/CategoriesPage.svelte';
  import KeywordsPage from '../../pages/KeywordsPage.svelte';
  import UploadsPage from '../../pages/UploadsPage.svelte';
  import TransactionsPage from '../../pages/TransactionsPage.svelte';
  import GraphsPage from '../../pages/GraphsPage.svelte';
  import ExplorePage from '../../pages/ExplorePage.svelte';
  import BudgetPage from '../../pages/BudgetPage.svelte';
  import BudgetSetupPage from '../../pages/BudgetSetupPage.svelte';
  import HealthPage from '../../pages/HealthPage.svelte';
  import TransfersPage from '../../pages/TransfersPage.svelte';
  import RatesPage from '../../pages/RatesPage.svelte';
  import AiReviewPage from '../../pages/AiReviewPage.svelte';
  import SettingsPage from '../../pages/SettingsPage.svelte';
  import AdminUsersPage from '../../pages/AdminUsersPage.svelte';
  import AppDefaultsPage from '../../pages/AppDefaultsPage.svelte';

  const nav = $derived([
    { path: '/', label: 'Home' },
    { path: '/accounts', label: 'Accounts' },
    { path: '/transactions', label: 'Transactions' },
    { path: '/graphs', label: 'Graphs' },
    { path: '/budget', label: 'Budget' },
    { path: '/categories', label: 'Categories' },
    { path: '/keywords', label: 'Keywords' },
    { path: '/ai', label: 'AI review' },
    { path: '/uploads', label: 'Uploads' },
    { path: '/rates', label: 'Rates' },
    { path: '/health', label: 'Health' },
    { path: '/settings', label: 'Settings' },
    ...(auth.user.isAdmin
      ? [
          { path: '/admin/users', label: 'Users' },
          { path: '/admin/settings', label: 'App defaults' },
        ]
      : []),
  ]);

  const current = $derived(router.path);
  // Admin routes are gated client-side too (the server enforces the real check).
  const isAdminRoute = $derived(current.startsWith('/admin'));
  const showAdmin = $derived(isAdminRoute && auth.user.isAdmin);

  // /uploads, /uploads/:accountId, /uploads/:accountId/edit — deep links from the
  // Accounts page carry a preselected account (and optionally open the editor).
  const uploadsRoute = $derived.by(() => {
    const m = current.match(/^\/uploads(?:\/(\d+))?(\/edit)?$/);
    return m ? { accountId: m[1] ?? null, edit: !!m[2] } : null;
  });

  // A nav item is active on its exact path or any sub-path (e.g. /uploads/5).
  const isActive = (path) => current === path || current.startsWith(path + '/');

  // How wide the page content may run. A single clamp for every route wasted
  // most of a desktop screen on the pages that hold tables, and silently capped
  // the ones that asked for more (Transactions requests 104rem). Forms read
  // badly past ~65 characters, so they stay narrow; tables and charts get the
  // window. `wide` keeps a margin at the very largest sizes rather than going
  // edge to edge, which is hard to scan.
  const WIDTHS = {
    narrow: 'max-w-2xl', // single-column forms: app defaults
    mid: 'max-w-4xl', // dashboards and mixed prose/controls
    wide: 'max-w-[110rem]', // tables, ledgers, graph grids
  };
  const ROUTE_WIDTH = [
    [/^\/settings$/, 'wide'],
    [/^\/admin\/settings$/, 'narrow'],
    [/^\/admin\/users$/, 'mid'],
    [/^\/$/, 'wide'],
    [/^\/accounts/, 'wide'],
    [/^\/transactions/, 'wide'],
    [/^\/graphs/, 'wide'],
    [/^\/budget/, 'wide'],
    [/^\/health/, 'wide'],
    [/^\/rates/, 'wide'],
    [/^\/uploads/, 'wide'],
    [/^\/categories/, 'wide'],
    [/^\/keywords/, 'wide'],
    [/^\/ai/, 'wide'],
  ];
  const contentWidth = $derived(WIDTHS[ROUTE_WIDTH.find(([re]) => re.test(current))?.[1] ?? 'mid']);

  async function handleLogout() {
    await logout();
    navigate('/');
  }
</script>

<div class="min-h-screen bg-background">
  <header class="border-b border-border bg-card">
    <div class={'mx-auto flex items-center justify-between px-4 py-3 ' + contentWidth}>
      <div class="flex items-center gap-6">
        <span class="text-lg font-bold tracking-tight">BeXT</span>
        <nav class="flex items-center gap-1">
          {#each nav as item (item.path)}
            <button
              class={'rounded-md px-3 py-1.5 text-sm font-medium transition ' +
                (isActive(item.path)
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
              onclick={() => navigate(item.path)}
            >
              {item.label}
            </button>
          {/each}
        </nav>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-sm text-muted-foreground">{auth.user.username}</span>
        <ThemeToggle />
        <Button variant="outline" onclick={handleLogout}>Log out</Button>
      </div>
    </div>
  </header>

  {#if auth.user.passwordIsDefault}
    <div class="border-b border-warning-border bg-warning">
      <div class={'mx-auto flex items-center justify-between px-4 py-2 text-sm text-warning-foreground ' + contentWidth}>
        <span>You're using the default password. Please change it.</span>
        <button class="font-medium underline" onclick={() => navigate('/settings')}>Change password</button>
      </div>
    </div>
  {/if}

  <main class={'mx-auto px-4 py-8 ' + contentWidth}>
    {#if current === '/accounts'}
      <AccountsPage />
    {:else if current === '/accounts/transfers'}
      <TransfersPage />
    {:else if current === '/transactions'}
      <TransactionsPage />
    {:else if current === '/graphs'}
      <GraphsPage />
    {:else if current === '/graphs/explore'}
      <ExplorePage />
    {:else if current === '/budget'}
      <BudgetPage />
    {:else if current === '/budget/setup'}
      <BudgetSetupPage />
    {:else if current === '/health'}
      <HealthPage />
    {:else if current === '/categories'}
      <CategoriesPage />
    {:else if current === '/keywords'}
      <KeywordsPage />
    {:else if uploadsRoute}
      <UploadsPage initialAccountId={uploadsRoute.accountId} openEditor={uploadsRoute.edit} />
    {:else if current === '/ai'}
      <AiReviewPage />
    {:else if current === '/rates'}
      <RatesPage />
    {:else if current === '/settings'}
      <SettingsPage />
    {:else if current === '/admin/users'}
      {#if showAdmin}<AdminUsersPage />{:else}<p class="text-sm text-muted-foreground">Not authorized.</p>{/if}
    {:else if current === '/admin/settings'}
      {#if showAdmin}<AppDefaultsPage />{:else}<p class="text-sm text-muted-foreground">Not authorized.</p>{/if}
    {:else}
      <HomePage />
    {/if}
  </main>
</div>
