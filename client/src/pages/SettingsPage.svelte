<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { navigate } from '$lib/router.svelte.js';
  import { auth, changePassword, setTheme } from '$lib/stores/auth.svelte.js';
  import { theme } from '$lib/theme.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import FxRatesCard from '$lib/components/FxRatesCard.svelte';
  import ClearTransactionsCard from '$lib/components/ClearTransactionsCard.svelte';
  import BackupsCard from '$lib/components/BackupsCard.svelte';
  import AiSettingsCard from '$lib/components/AiSettingsCard.svelte';

  const themeOptions = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  let defaultCurrency = $state('');
  let globalFuzzyDistance = $state(0);
  let transactionsPageSize = $state(100);
  // 0 = every transaction at once. Anything from 1000 up is worth a warning:
  // the list renders every row it holds, so a few thousand make it sluggish.
  const pageSizeOptions = [
    { value: 50, label: '50' },
    { value: 100, label: '100' },
    { value: 200, label: '200' },
    { value: 500, label: '500' },
    { value: 1000, label: '1,000' },
    { value: 2000, label: '2,000' },
    { value: 0, label: 'All transactions' },
  ];
  const heavyPageSize = $derived(transactionsPageSize === 0 || Number(transactionsPageSize) >= 1000);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let saved = $state(false);

  onMount(async () => {
    const s = await api('/settings');
    defaultCurrency = s.defaultCurrency;
    globalFuzzyDistance = s.globalFuzzyDistance;
    transactionsPageSize = s.transactionsPageSize;
    loading = false;
  });

  async function save(e) {
    e.preventDefault();
    error = '';
    saved = false;
    saving = true;
    try {
      const updated = await api('/settings', {
        method: 'PUT',
        body: {
          defaultCurrency,
          globalFuzzyDistance: Number(globalFuzzyDistance),
          transactionsPageSize: Number(transactionsPageSize),
        },
      });
      // Keep the global auth user in sync (currency/distance feed later phases).
      auth.user = { ...auth.user, ...updated };
      defaultCurrency = updated.defaultCurrency;
      globalFuzzyDistance = updated.globalFuzzyDistance;
      transactionsPageSize = updated.transactionsPageSize;
      saved = true;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not save settings.';
    } finally {
      saving = false;
    }
  }

  // --- Sections -------------------------------------------------------------
  //
  // Settings was one scroll of seven unrelated things. The rail jumps between
  // them and says which one you are in. It scrolls elements rather than linking
  // to `#ids`: the router itself lives in `location.hash`, so an anchor link
  // would navigate the app away from this page.
  const SECTIONS = [
    { key: 'preferences', label: 'Preferences', hint: 'Currency, matching, page size' },
    { key: 'appearance', label: 'Appearance', hint: 'Light or dark' },
    { key: 'security', label: 'Password', hint: 'How you sign in' },
    { key: 'ai', label: 'AI categorization', hint: 'Which engine, and its key' },
    { key: 'rates', label: 'Exchange rates', hint: 'What converts your currencies' },
    { key: 'backups', label: 'Backups', hint: 'Snapshots of the database' },
    { key: 'danger', label: 'Danger zone', hint: 'Irreversible, and yours only' },
  ];
  let activeSection = $state('preferences');

  // The sections are found by their `data-section` attribute rather than held
  // in a `bind:this` map: binding into a plain object left it empty, and the
  // attribute is needed by the observer below anyway.
  const sectionEl = (key) => document.querySelector(`[data-section="${key}"]`);

  function goTo(key) {
    const el = sectionEl(key);
    if (!el) return;
    // Say it immediately: you asked for this section, so the rail should not
    // wait on a scroll event to agree with you (and the last section can only
    // ever get so close to the top).
    activeSection = key;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      el.scrollIntoView({ block: 'start' });
      return;
    }
    const before = window.scrollY;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Some environments ignore smooth scrolling outright rather than falling
    // back to a jump, which leaves the button looking dead. If nothing has
    // moved a few frames later, jump.
    setTimeout(() => {
      if (Math.abs(window.scrollY - before) < 2) el.scrollIntoView({ block: 'start' });
    }, 150);
  }

  // Which section the page is in: the last one whose top has passed under the
  // header. A plain scroll check rather than an IntersectionObserver — six
  // rectangles per scroll is nothing, and the answer is the one you can reason
  // about, where an observer's margins are guesswork.
  const HEADER_OFFSET = 130;

  function updateActiveSection() {
    let current = SECTIONS[0].key;
    for (const section of SECTIONS) {
      const el = sectionEl(section.key);
      if (el && el.getBoundingClientRect().top <= HEADER_OFFSET) current = section.key;
    }
    activeSection = current;
  }

  $effect(() => {
    updateActiveSection();
    window.addEventListener('scroll', updateActiveSection, { passive: true });
    window.addEventListener('resize', updateActiveSection);
    return () => {
      window.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  });

  // --- Change password ---
  let currentPassword = $state('');
  let newPassword = $state('');
  let pwError = $state('');
  let pwSaved = $state(false);
  let pwSaving = $state(false);

  async function submitPassword(e) {
    e.preventDefault();
    pwError = '';
    pwSaved = false;
    pwSaving = true;
    try {
      await changePassword(currentPassword, newPassword);
      currentPassword = '';
      newPassword = '';
      pwSaved = true;
    } catch (err) {
      pwError = err instanceof ApiError ? err.message : 'Could not change password.';
    } finally {
      pwSaving = false;
    }
  }
</script>

<div>
  <div class="mb-5">
    <h2 class="text-xl font-semibold">Settings</h2>
    <p class="text-sm text-muted-foreground">Your own defaults, your data, and the two ways to undo a bad day.</p>
  </div>

  <div class="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start">
    <!-- Section rail. Buttons, not anchors: the router lives in location.hash. -->
    <nav class="lg:sticky lg:top-4" aria-label="Settings sections">
      <ul class="flex flex-wrap gap-1 lg:flex-col">
        {#each SECTIONS as section (section.key)}
          <li class="lg:w-full">
            <button
              class={'w-full rounded-md px-2.5 py-1.5 text-left transition ' +
                (activeSection === section.key
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground') +
                (section.key === 'danger' ? ' hover:text-destructive' : '')}
              onclick={() => goTo(section.key)}
              aria-current={activeSection === section.key ? 'true' : undefined}
            >
              <span class={'block text-sm font-medium ' + (section.key === 'danger' ? 'text-destructive' : '')}>
                {section.label}
                {#if section.key === 'security' && auth.user.passwordIsDefault}
                  <span class="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-warning-foreground align-middle" title="You are still using the default password"></span>
                {/if}
              </span>
              <span class="hidden text-xs text-muted-foreground lg:block">{section.hint}</span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>

    <!-- Two columns of sections on a wide window, one on a narrow one. A little
         trailing space so a jump to the last section is not fighting the end of
         the page; it no longer needs a screenful, because clicking the rail
         sets the active section itself. -->
    <div class="grid min-w-0 gap-6 pb-16 xl:grid-cols-2 xl:items-start">
      <div class="flex min-w-0 flex-col gap-8">
      <!-- Preferences -->
      <section data-section="preferences" class="scroll-mt-4">
        <h3 class="mb-1 text-lg font-semibold">Preferences</h3>
        <p class="mb-3 text-sm text-muted-foreground">Defaults used across accounts, classification and the transaction list.</p>
        <Card class="p-5">
          {#if loading}
            <p class="text-sm text-muted-foreground">Loading…</p>
          {:else}
            <form class="flex flex-col gap-5" onsubmit={save}>
              <div class="grid gap-5 sm:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                  <Label for="currency">Default currency</Label>
                  <Input id="currency" bind:value={defaultCurrency} maxlength="3" class="uppercase" placeholder="PLN" />
                  <p class="text-xs text-muted-foreground">
                    Three-letter ISO code (e.g. PLN, EUR, BRL). Graphs and totals convert into it.
                  </p>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Label for="distance">Global fuzzy-match distance</Label>
                  <Input id="distance" type="number" min="0" step="1" bind:value={globalFuzzyDistance} />
                  <p class="text-xs text-muted-foreground">
                    0 = exact substring match; 1 = allow one typo per word, etc. Overridable per keyword. Words under five
                    characters always need an exact match.
                  </p>
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <Label for="page-size">Transactions per page</Label>
                <select
                  id="page-size"
                  bind:value={transactionsPageSize}
                  class="w-full max-w-xs rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                >
                  {#each pageSizeOptions as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                </select>
                <p class="text-xs text-muted-foreground">
                  How many rows the transaction list loads at a time, and how many each “Load more” adds. The list's own
                  footer changes it too, and saves the change back here.
                </p>
                {#if heavyPageSize}
                  <p class="text-xs text-warning-foreground">
                    The list renders every row it has loaded, so a few thousand at once will make the page slow to open,
                    scroll and filter — on a database of several thousand transactions, “All transactions” can take ten
                    seconds or more <em>each time</em> you change a filter. Fine for a one-off sweep; painful as an
                    everyday setting.
                  </p>
                {/if}
              </div>

              {#if error}<p class="text-sm text-destructive">{error}</p>{/if}
              {#if saved}<p class="text-sm text-success">Saved.</p>{/if}

              <div>
                <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
              </div>
            </form>
          {/if}
        </Card>
      </section>

      <!-- Appearance -->
      <section data-section="appearance" class="scroll-mt-4">
        <h3 class="mb-1 text-lg font-semibold">Appearance</h3>
        <p class="mb-3 text-sm text-muted-foreground">Kept with your account, so it follows you to another device.</p>
        <Card class="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <Label>Theme</Label>
            <p class="mt-1 text-xs text-muted-foreground">The toggle in the header changes this too.</p>
          </div>
          <div class="inline-flex w-fit rounded-md border border-input p-1">
            {#each themeOptions as opt (opt.value)}
              <button
                type="button"
                onclick={() => setTheme(opt.value)}
                class={'rounded px-4 py-1.5 text-sm font-medium transition ' +
                  (theme.value === opt.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        </Card>
      </section>

      <!-- Password -->
      <section data-section="security" class="scroll-mt-4">
        <h3 class="mb-1 text-lg font-semibold">Password</h3>
        <p class="mb-3 text-sm text-muted-foreground">
          {#if auth.user.passwordIsDefault}
            <span class="text-warning-foreground">You're still using the default password — please set a new one.</span>
          {:else}
            Update the password you use to sign in. There is no reset by email: an admin, or the CLI script, is the way back in.
          {/if}
        </p>
        <Card class="p-5">
          <form class="flex flex-col gap-5" onsubmit={submitPassword}>
            <div class="grid gap-5 sm:grid-cols-2">
              <div class="flex flex-col gap-1.5">
                <Label for="current">Current password</Label>
                <Input id="current" type="password" bind:value={currentPassword} autocomplete="current-password" required />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label for="new">New password</Label>
                <Input id="new" type="password" bind:value={newPassword} autocomplete="new-password" required />
                <p class="text-xs text-muted-foreground">At least 8 characters.</p>
              </div>
            </div>

            {#if pwError}<p class="text-sm text-destructive">{pwError}</p>{/if}
            {#if pwSaved}<p class="text-sm text-success">Password changed.</p>{/if}

            <div>
              <Button type="submit" disabled={pwSaving}>{pwSaving ? 'Saving…' : 'Change password'}</Button>
            </div>
          </form>
        </Card>
      </section>

      </div>

      <div class="flex min-w-0 flex-col gap-8">
      <!-- AI categorization -->
      <section data-section="ai" class="scroll-mt-4">
        <h3 class="mb-1 text-lg font-semibold">AI categorization</h3>
        <p class="mb-3 text-sm text-muted-foreground">
          The engine that reads an uncategorized merchant, looks it up, and proposes a keyword rule. Reviewing what it
          proposes happens on the <button type="button" class="text-primary underline" onclick={() => navigate('/ai')}>AI review</button> page.
        </p>
        <AiSettingsCard />
      </section>

      <!-- Exchange rates -->
      <section data-section="rates" class="scroll-mt-4">
        <h3 class="mb-1 text-lg font-semibold">Exchange rates</h3>
        <p class="mb-3 text-sm text-muted-foreground">
          The table that converts a transaction into your default currency. The rows themselves live on the Rates page — a
          daily table runs to thousands of them.
        </p>
        <FxRatesCard />
      </section>

      <!-- Backups -->
      <section data-section="backups" class="scroll-mt-4">
        <h3 class="mb-1 text-lg font-semibold">Backups</h3>
        <p class="mb-3 text-sm text-muted-foreground">
          Taken automatically before anything that destroys transactions. This is the button for the moment you know is
          risky. Restoring is a command-line job: <code class="rounded bg-muted px-1 py-0.5 text-xs">npm run db:restore</code>.
        </p>
        <BackupsCard />
      </section>

      <!-- Danger zone -->
      <section data-section="danger" class="scroll-mt-4">
        <h3 class="mb-1 text-lg font-semibold text-destructive">Danger zone</h3>
        <p class="mb-3 text-sm text-muted-foreground">
          Irreversible, and limited to your own data — never another user's. A backup is taken first either way.
        </p>
        <ClearTransactionsCard />
      </section>
      </div>
    </div>
  </div>
</div>
