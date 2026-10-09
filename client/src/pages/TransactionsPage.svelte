<script>
  import { onMount, tick } from 'svelte';
  import { api, ApiError } from '$lib/api.js';
  import { auth } from '$lib/stores/auth.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import CategoryIcon from '$lib/components/ui/CategoryIcon.svelte';
  import CategorySelect from '$lib/components/ui/CategorySelect.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import TransactionDialog from '$lib/components/TransactionDialog.svelte';
  import SplitDialog from '$lib/components/SplitDialog.svelte';
  import HashtagPanel from '$lib/components/HashtagPanel.svelte';
  import ClassificationProgress from '$lib/components/ClassificationProgress.svelte';
  import { recordRecentCategory, suggestCategories } from '$lib/recentCategories.js';

  // Rows per page (and per "load more"), from the user's own setting. 0 = load
  // every matching transaction at once.
  // How many rows a load pulls. It starts from the user's saved setting and is
  // changed from the footer of the list itself — where you actually notice the
  // page is too short (or too long). A change there is saved back to the
  // setting, so the list opens the same way next time.
  let pageSize = $state(auth.user?.transactionsPageSize ?? 100);
  const loadsAll = $derived(pageSize === 0);
  const PAGE_SIZE_CHOICES = [100, 200, 500, 0];
  let customPageSize = $state('');

  async function setPageSize(n) {
    if (n === pageSize) return;
    pageSize = n;
    customPageSize = '';
    await load(true);
    // Persist quietly: a failure here costs nothing this session, and a page
    // error about a preference would be noise over the list you just resized.
    try {
      const updated = await api('/settings', { method: 'PUT', body: { transactionsPageSize: n } });
      auth.user = { ...auth.user, ...updated };
    } catch {
      /* the session keeps the new size either way */
    }
  }
  function applyCustomPageSize() {
    const n = Number(customPageSize);
    if (!Number.isInteger(n) || n < 1) return;
    setPageSize(n);
  }
  const pageSizeLabel = (n) => (n === 0 ? 'All' : String(n));

  // --- Ledger columns -------------------------------------------------------
  // The row is a grid, not a stack: date, description, account, category, tags
  // and amount each get their own track so amounts line up in one column. The
  // description takes whatever the fixed tracks leave, which is most of it.
  // Account, category and tags can be switched off — they are the ones worth
  // trading for description width when a merchant string is long.
  const OPTIONAL_COLUMNS = [
    { key: 'account', label: 'Account', width: '6.5rem' },
    { key: 'category', label: 'Category', width: '10rem' },
    { key: 'tags', label: 'Tags', width: '5.5rem' },
  ];
  const COLUMNS_STORAGE_KEY = 'bext.transactions.columns';

  function loadColumnPrefs() {
    const shown = { account: true, category: true, tags: true };
    try {
      const saved = JSON.parse(localStorage.getItem(COLUMNS_STORAGE_KEY) ?? 'null');
      if (saved && typeof saved === 'object') {
        for (const { key } of OPTIONAL_COLUMNS) if (typeof saved[key] === 'boolean') shown[key] = saved[key];
      }
    } catch {
      /* private window, or cleared site data — the defaults are fine */
    }
    return shown;
  }
  let shownColumns = $state(loadColumnPrefs());

  function toggleColumn(key) {
    shownColumns = { ...shownColumns, [key]: !shownColumns[key] };
    try {
      localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(shownColumns));
    } catch {
      /* the session keeps the choice either way */
    }
  }

  // Narrow windows drop the optional columns whatever the preference says —
  // three truncated tracks in 700px are worse than none.
  const WIDE_QUERY = '(min-width: 1024px)';
  let wideEnough = $state(typeof window === 'undefined' ? true : window.matchMedia(WIDE_QUERY).matches);
  $effect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = (e) => (wideEnough = e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  });

  const visibleColumns = $derived(
    Object.fromEntries(OPTIONAL_COLUMNS.map(({ key }) => [key, wideEnough && shownColumns[key]])),
  );
  // 1.25rem checkbox · 4.75rem date · description · optionals · amount · actions
  const gridStyle = $derived(
    'grid-template-columns: 1.25rem 4.75rem minmax(0, 1fr)' +
      OPTIONAL_COLUMNS.filter(({ key }) => visibleColumns[key])
        .map(({ width }) => ' ' + width)
        .join('') +
      ' 7rem 5.25rem',
  );

  // The grouped view has no tags track (a group's rows can carry different
  // ones) and gains a count: checkbox · last seen · count · description ·
  // optionals · total · actions.
  const groupGridStyle = $derived(
    'grid-template-columns: 1.25rem 4.75rem 3rem minmax(0, 1fr)' +
      (visibleColumns.account ? ' 6.5rem' : '') +
      (visibleColumns.category ? ' 10rem' : '') +
      ' 8rem 3.5rem',
  );

  let accounts = $state([]);
  let categories = $state([]);
  let holders = $state([]);
  let hashtags = $state([]);
  let facets = $state({ uncategorized: 0, categories: [], subcategories: [], months: [], currencies: [], keywords: [], noKeyword: 0 });
  let rows = $state([]);
  let total = $state(0);
  let summary = $state({ income: 0, expense: 0, net: 0 });
  let progress = $state(null);
  let offset = $state(0);
  let loading = $state(true);
  let pageError = $state('');

  // Filters
  let fAccount = $state('');
  // Category selection (left-panel tree): whole categories, specific
  // subcategories, and/or uncategorized — OR-combined.
  let selCatIds = $state([]);
  let selSubIds = $state([]);
  let selUncat = $state(false);
  let expandedCats = $state([]);
  let expandedYears = $state([]);
  let fHolder = $state('');
  let fBusiness = $state('');
  let fType = $state('');
  let fHashtag = $state('');
  let fFrom = $state('');
  let fTo = $state('');
  let fIncludeHidden = $state(false);
  // Free text over the description, and which keyword categorized the row
  // ('' = any, '0' = none). The search box is debounced: typing should narrow
  // the list as you go without a request per keystroke.
  let fSearch = $state('');
  let fKeyword = $state('');
  let searchTimer = null;
  function searchChanged() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => load(true), 250);
  }
  function clearSearch() {
    clearTimeout(searchTimer);
    fSearch = '';
    load(true);
  }
  // Transaction currencies to show — a multi-select, since one account can hold
  // several (Revolut). Empty = all of them.
  let fCurrencies = $state([]);
  let fSort = $state('date_desc');

  // --- Sorting --------------------------------------------------------------
  // Every order the list offers, tied to the column header that toggles it.
  // A header's first click takes the first entry for its column (newest,
  // A–Z, largest), a second click the other direction.
  const ROW_SORTS = [
    { key: 'date_desc', label: 'Newest first', col: 'date', dir: 'desc' },
    { key: 'date_asc', label: 'Oldest first', col: 'date', dir: 'asc' },
    { key: 'description', label: 'Description A–Z', col: 'description', dir: 'asc' },
    { key: 'description_desc', label: 'Description Z–A', col: 'description', dir: 'desc' },
    { key: 'account_asc', label: 'Account A–Z', col: 'account', dir: 'asc' },
    { key: 'account_desc', label: 'Account Z–A', col: 'account', dir: 'desc' },
    { key: 'category_asc', label: 'Category A–Z', col: 'category', dir: 'asc' },
    { key: 'category_desc', label: 'Category Z–A', col: 'category', dir: 'desc' },
    { key: 'amount_desc', label: 'Largest amount', col: 'amount', dir: 'desc' },
    { key: 'amount_asc', label: 'Smallest amount', col: 'amount', dir: 'asc' },
  ];
  // Grouped, the list ranks descriptions: by what they add up to (the money
  // left to categorize) or by how many rows they stand for.
  const GROUP_SORTS = [
    { key: 'total_desc', label: 'Largest total', col: 'amount', dir: 'desc' },
    { key: 'total_asc', label: 'Smallest total', col: 'amount', dir: 'asc' },
    { key: 'count_desc', label: 'Most transactions', col: 'count', dir: 'desc' },
    { key: 'count_asc', label: 'Fewest transactions', col: 'count', dir: 'asc' },
    { key: 'description', label: 'Description A–Z', col: 'description', dir: 'asc' },
    { key: 'description_desc', label: 'Description Z–A', col: 'description', dir: 'desc' },
    { key: 'date_desc', label: 'Most recent', col: 'date', dir: 'desc' },
    { key: 'date_asc', label: 'Oldest', col: 'date', dir: 'asc' },
  ];

  // Grouped view: '' = one line per transaction; 'description' = one line per
  // description (case and spacing ignored); 'merchant' = one line per merchant
  // (numbers dropped, the AI review's grouping).
  const GROUP_MODES = [
    { key: '', label: 'Rows', title: 'One line per transaction' },
    { key: 'description', label: 'Same description', title: 'One line per description, with how many rows share it and their total' },
    { key: 'merchant', label: 'Same merchant', title: 'Like "same description", but numbers are ignored — branch and reference numbers fold into one merchant' },
  ];
  let fGroup = $state('');
  let groups = $state([]);
  let totalGroups = $state(0);
  const sortOptions = $derived(fGroup ? GROUP_SORTS : ROW_SORTS);
  const activeSort = $derived(sortOptions.find((o) => o.key === fSort));
  const defaultSort = () => (fGroup ? 'total_desc' : 'date_desc');

  function sortByColumn(col) {
    const opts = sortOptions.filter((o) => o.col === col);
    if (!opts.length) return;
    fSort = activeSort?.col === col ? (opts.find((o) => o.key !== fSort) ?? opts[0]).key : opts[0].key;
    load(true);
  }
  function setGroupMode(mode) {
    if (mode === fGroup) return;
    fGroup = mode;
    if (!sortOptions.some((o) => o.key === fSort)) fSort = defaultSort();
    load(true);
  }

  function queryString() {
    const p = new URLSearchParams();
    if (fAccount) p.set('accountId', fAccount);
    if (selUncat) p.set('uncategorized', '1');
    if (selCatIds.length) p.set('categoryIds', selCatIds.join(','));
    if (selSubIds.length) p.set('subcategoryIds', selSubIds.join(','));
    if (fHolder) p.set('holder', fHolder);
    if (fBusiness) p.set('business', fBusiness);
    if (fType) p.set('type', fType);
    if (fHashtag) p.set('hashtagId', fHashtag);
    if (fFrom) p.set('from', fFrom);
    if (fTo) p.set('to', fTo);
    if (fIncludeHidden) p.set('includeHidden', '1');
    if (fSearch.trim()) p.set('q', fSearch.trim());
    if (fKeyword) p.set('keywordIds', fKeyword);
    if (fCurrencies.length) p.set('currencies', fCurrencies.join(','));
    if (fGroup) p.set('groupBy', fGroup);
    if (fGroup || fSort !== 'date_desc') p.set('sort', fSort);
    p.set('limit', loadsAll ? 'all' : String(pageSize));
    p.set('offset', String(offset));
    return p.toString();
  }

  async function load(reset = true) {
    if (reset) {
      offset = 0;
      selIds = [];
      lastClicked = -1;
      expanded = {};
    }
    loading = true;
    pageError = '';
    try {
      if (fGroup) {
        const res = await api('/transactions/groups?' + queryString());
        groups = reset ? res.groups : [...groups, ...res.groups];
        totalGroups = res.totalGroups;
        rows = [];
        total = res.total;
        summary = res.summary;
        if (reset) loadProgress();
        return;
      }
      const res = await api('/transactions?' + queryString());
      rows = reset ? res.transactions : [...rows, ...res.transactions];
      groups = [];
      total = res.total;
      summary = res.summary;
      if (reset) loadProgress();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not load transactions.';
    } finally {
      loading = false;
    }
  }
  // Classification progress for the current filters (the server ignores the
  // category selection, so the bar keeps meaning while filtering uncategorized).
  async function loadProgress() {
    try {
      progress = await api('/reports/classification?' + queryString());
    } catch {
      progress = null; // a missing bar is better than a page-level error here
    }
  }

  function loadMore() {
    offset += pageSize;
    load(false);
  }

  async function loadFacets() {
    facets = await api('/transactions/facets' + (fIncludeHidden ? '?includeHidden=1' : ''));
  }
  async function loadSupporting() {
    const [a, c, h, t] = await Promise.all([api('/accounts'), api('/categories'), api('/transactions/holders'), api('/hashtags')]);
    accounts = a; categories = c; holders = h; hashtags = t;
    await loadFacets();
  }
  async function refreshAll() {
    await Promise.all([loadSupporting(), load(true)]);
  }
  onMount(async () => {
    await loadSupporting();
    await load(true);
  });

  // --- Category tree (left panel) ---
  const catCount = $derived(new Map(facets.categories.map((c) => [c.categoryId, c.count])));
  const subCount = $derived(new Map(facets.subcategories.map((s) => [s.subcategoryId, s.count])));
  // Only categories that appear in transactions, each with only its used subcategories.
  const treeCats = $derived(
    categories
      .filter((c) => catCount.has(c.id))
      .map((c) => ({
        ...c,
        count: catCount.get(c.id) ?? 0,
        subs: (c.subcategories ?? []).filter((s) => subCount.has(s.id)).map((s) => ({ ...s, count: subCount.get(s.id) })),
      })),
  );
  const catSelectionActive = $derived(selUncat || selCatIds.length > 0 || selSubIds.length > 0);
  const uncatOnly = $derived(selUncat && selCatIds.length === 0 && selSubIds.length === 0);

  function toggleCat(id) {
    selCatIds = selCatIds.includes(id) ? selCatIds.filter((x) => x !== id) : [...selCatIds, id];
    load(true);
  }
  function toggleSub(id) {
    selSubIds = selSubIds.includes(id) ? selSubIds.filter((x) => x !== id) : [...selSubIds, id];
    load(true);
  }
  function toggleExpand(id) {
    expandedCats = expandedCats.includes(id) ? expandedCats.filter((x) => x !== id) : [...expandedCats, id];
  }
  function clearCategorySelection() {
    selCatIds = [];
    selSubIds = [];
    selUncat = false;
    load(true);
  }
  // Header "Uncategorized only" switch: selects just uncategorized, clearing any category picks.
  function setUncatOnly(on) {
    selCatIds = [];
    selSubIds = [];
    selUncat = on;
    load(true);
  }

  function toggleCurrency(code) {
    fCurrencies = fCurrencies.includes(code) ? fCurrencies.filter((c) => c !== code) : [...fCurrencies, code];
    load(true);
  }

  // --- Period picker (left panel): year → month drill-down over the from/to range. ---
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Years present in the data, each with the months (present) that fall under them.
  const periodYears = $derived.by(() => {
    const byYear = new Map();
    for (const m of facets.months ?? []) {
      if (!/^\d{4}-\d{2}$/.test(m.ym)) continue;
      const y = m.ym.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, { year: y, count: 0, months: [] });
      const entry = byYear.get(y);
      entry.count += m.count;
      entry.months.push({ ym: m.ym, month: Number(m.ym.slice(5, 7)), count: m.count });
    }
    return [...byYear.values()]
      .map((e) => ({ ...e, months: e.months.sort((a, b) => b.month - a.month) }))
      .sort((a, b) => b.year.localeCompare(a.year));
  });
  function monthEnd(ym) {
    const [y, m] = ym.split('-').map(Number);
    return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  }
  const yearIsSelected = (y) => fFrom === `${y}-01-01` && fTo === `${y}-12-31`;
  const monthIsSelected = (ym) => fFrom === `${ym}-01` && fTo === monthEnd(ym);
  function selectYear(y) {
    if (yearIsSelected(y)) { fFrom = ''; fTo = ''; }
    else { fFrom = `${y}-01-01`; fTo = `${y}-12-31`; }
    load(true);
  }
  function selectMonth(ym) {
    if (monthIsSelected(ym)) { fFrom = ''; fTo = ''; }
    else { fFrom = `${ym}-01`; fTo = monthEnd(ym); }
    load(true);
  }
  function toggleYear(y) {
    expandedYears = expandedYears.includes(y) ? expandedYears.filter((x) => x !== y) : [...expandedYears, y];
  }
  function clearDates() {
    fFrom = '';
    fTo = '';
    load(true);
  }

  function resetFilters() {
    fAccount = fHolder = fBusiness = fType = fHashtag = fFrom = fTo = '';
    fSearch = fKeyword = '';
    fCurrencies = [];
    fSort = defaultSort();
    selCatIds = [];
    selSubIds = [];
    selUncat = false;
    fIncludeHidden = false;
    loadFacets();
    load(true);
  }

  // --- Row selection (bulk actions) ---
  // Ids of checked rows. Kept as a plain array so `selIds.includes` reads
  // naturally in the markup; selections never survive a filter change.
  let selIds = $state([]);
  let lastClicked = $state(-1);
  const selectedCount = $derived(selIds.length);
  const selSet = $derived(new Set(selIds));
  const allVisibleSelected = $derived(
    fGroup
      ? groups.length > 0 && groups.every((g) => g.ids.every((id) => selSet.has(id)))
      : rows.length > 0 && selIds.length === rows.length,
  );

  function toggleRow(tx, index, shiftKey) {
    // Shift-click extends from the previously clicked row, the way a file list does.
    if (shiftKey && lastClicked >= 0 && lastClicked < rows.length) {
      const [from, to] = lastClicked < index ? [lastClicked, index] : [index, lastClicked];
      const range = rows.slice(from, to + 1).map((r) => r.id);
      const adding = !selIds.includes(tx.id);
      selIds = adding ? [...new Set([...selIds, ...range])] : selIds.filter((id) => !range.includes(id));
    } else {
      selIds = selIds.includes(tx.id) ? selIds.filter((id) => id !== tx.id) : [...selIds, tx.id];
    }
    lastClicked = index;
  }
  function toggleAllVisible() {
    selIds = allVisibleSelected ? [] : fGroup ? groups.flatMap((g) => g.ids) : rows.map((r) => r.id);
    lastClicked = -1;
  }
  // A group is checked when every one of its rows is; checking it selects
  // them all, so the bulk bar categorizes and tags whole groups at once.
  const groupSelected = (g) => g.ids.every((id) => selSet.has(id));
  function toggleGroup(g, index, shiftKey) {
    const span = shiftKey && lastClicked >= 0 && lastClicked < groups.length
      ? groups.slice(Math.min(lastClicked, index), Math.max(lastClicked, index) + 1)
      : [g];
    const ids = span.flatMap((x) => x.ids);
    if (groupSelected(g)) {
      const drop = new Set(ids);
      selIds = selIds.filter((id) => !drop.has(id));
    } else {
      selIds = [...new Set([...selIds, ...ids])];
    }
    lastClicked = index;
  }
  function clearSelection() {
    selIds = [];
    lastClicked = -1;
  }

  // --- Bulk categorize ---
  // The counterpart to a keyword: some merchants are never going to be one
  // rule ("PAYMENT 4471"), so a selection can be given a category by hand in
  // one call. Same semantics as editing one row — it locks, so a recompute
  // leaves it alone.
  let bulkCatId = $state('');
  let bulkSubId = $state('');
  let bulkBusy = $state(false);

  async function bulkCategorize() {
    if (!selIds.length || bulkBusy) return;
    bulkBusy = true;
    pageError = '';
    try {
      const res = await api('/transactions/bulk-categorize', {
        method: 'POST',
        body: {
          transactionIds: selIds,
          categoryId: bulkCatId ? Number(bulkCatId) : null,
          subcategoryId: bulkSubId ? Number(bulkSubId) : null,
        },
      });
      recordRecentCategory(bulkCatId, bulkSubId);
      // Rows that no longer belong under the current filters drop out (and take
      // their money out of the totals with them); the rest redraw in place.
      if (fGroup) await reloadGroups();
      else for (const t of res.transactions) ingest(t);
      clearSelection();
      bulkCatId = '';
      bulkSubId = '';
      await Promise.all([loadFacets(), loadProgress()]);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not categorize the selection.';
    } finally {
      bulkBusy = false;
    }
  }

  // --- Grouped view: expand, categorize a whole group ---
  // Re-fetch as many groups as are loaded, so a categorization redraws the
  // list without throwing away the pages already loaded under it.
  async function reloadGroups() {
    const n = loadsAll ? 0 : Math.max(groups.length, pageSize);
    const p = new URLSearchParams(queryString());
    p.set('limit', loadsAll ? 'all' : String(n));
    p.set('offset', '0');
    const res = await api('/transactions/groups?' + p);
    groups = res.groups;
    totalGroups = res.totalGroups;
    total = res.total;
    summary = res.summary;
    offset = loadsAll ? 0 : Math.max(0, n - pageSize);
    const present = new Set(groups.map((g) => g.key));
    expanded = Object.fromEntries(Object.entries(expanded).filter(([k]) => present.has(k)));
  }

  // key → { loading, rows } for the groups opened in place.
  let expanded = $state({});
  async function toggleExpandGroup(g) {
    if (expanded[g.key]) {
      const { [g.key]: _, ...rest } = expanded;
      expanded = rest;
      return;
    }
    expanded = { ...expanded, [g.key]: { loading: true, rows: [] } };
    const p = new URLSearchParams(queryString());
    for (const k of ['limit', 'offset', 'sort']) p.delete(k);
    p.set('key', g.key);
    let entry;
    try {
      entry = { loading: false, rows: (await api('/transactions/groups/members?' + p)).transactions };
    } catch {
      entry = { loading: false, rows: [], error: true };
    }
    if (expanded[g.key]) expanded = { ...expanded, [g.key]: entry };
  }

  let editingGroupKey = $state(null);
  function startGroupCatEdit(g) {
    editingGroupKey = g.key;
    editCatId = g.category ? String(g.category.id) : '';
    editSubId = g.subcategory ? String(g.subcategory.id) : '';
  }
  // Categorizing a group categorizes every row in it — the same call as the
  // bulk bar, so imported rows lock exactly as a manual categorization does.
  async function categorizeGroup(g, v) {
    try {
      await api('/transactions/bulk-categorize', {
        method: 'POST',
        body: {
          transactionIds: g.ids,
          categoryId: v.categoryId ? Number(v.categoryId) : null,
          subcategoryId: v.subcategoryId ? Number(v.subcategoryId) : null,
        },
      });
      recordRecentCategory(v.categoryId, v.subcategoryId);
      await reloadGroups();
      await Promise.all([loadFacets(), loadProgress()]);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not categorize the group.';
    }
  }

  // --- Hashtags: drag-and-drop + bulk tagging ---
  let dragTag = $state(null); // the hashtag currently being dragged from the panel
  let dropTargetId = $state(null); // row highlighted under the pointer
  let bulkTagName = $state('');

  // Merge the server's per-transaction hashtag lists back into the loaded rows.
  function applyHashtagMap(map) {
    if (!map) return;
    rows = rows.map((r) => (map[r.id] ? { ...r, hashtags: map[r.id] } : r));
  }
  async function refreshHashtags() {
    hashtags = await api('/hashtags');
  }

  // Attach a tag to the given transactions. `tag` is either an existing
  // hashtag object or a bare name (created server-side on the fly).
  async function assignTag(tag, ids) {
    if (!ids.length) return;
    try {
      const body = typeof tag === 'string' ? { name: tag } : { hashtagId: tag.id };
      const res = await api('/hashtags/assign', { method: 'POST', body: { ...body, transactionIds: ids } });
      applyHashtagMap(res.hashtags);
      await refreshHashtags();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not attach the hashtag.';
    }
  }
  async function unassignTag(tag, ids) {
    try {
      const res = await api('/hashtags/unassign', { method: 'POST', body: { hashtagId: tag.id, transactionIds: ids } });
      applyHashtagMap(res.hashtags);
      await refreshHashtags();
      // The row may drop out of view when filtering by the tag just removed.
      if (fHashtag && String(fHashtag) === String(tag.id)) await load(true);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not remove the hashtag.';
    }
  }

  // A drop lands on the row under the pointer — or on the whole selection when
  // that row is part of it, which is how several rows get tagged in one gesture.
  function dropTargets(tx) {
    return selIds.includes(tx.id) ? selIds : [tx.id];
  }
  function onRowDragOver(e, tx) {
    if (!dragTag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropTargetId = tx.id;
  }
  async function onRowDrop(e, tx) {
    e.preventDefault();
    const tag = dragTag;
    dragTag = null;
    dropTargetId = null;
    if (tag) await assignTag(tag, dropTargets(tx));
  }
  const rowIsDropTarget = (tx) => dragTag != null && dropTargetId != null && dropTargets({ id: dropTargetId }).includes(tx.id);

  // The same gesture on a group tags every row in it (or the whole selection,
  // when the group is part of it).
  let dropTargetKey = $state(null);
  const groupDropTargets = (g) => (groupSelected(g) ? selIds : g.ids);
  function onGroupDragOver(e, g) {
    if (!dragTag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropTargetKey = g.key;
  }
  async function onGroupDrop(e, g) {
    e.preventDefault();
    const tag = dragTag;
    dragTag = null;
    dropTargetKey = null;
    if (tag) await assignTag(tag, groupDropTargets(g));
  }
  function groupIsDropTarget(g) {
    if (dragTag == null || dropTargetKey == null) return false;
    if (g.key === dropTargetKey) return true;
    const target = groups.find((x) => x.key === dropTargetKey);
    return target != null && groupSelected(target) && groupSelected(g);
  }

  async function bulkTag(e) {
    e?.preventDefault?.();
    const name = bulkTagName.trim().replace(/^#+/, '').trim();
    if (!name || !selIds.length) return;
    await assignTag(name, selIds);
    bulkTagName = '';
  }
  async function createHashtag(name) {
    await api('/hashtags', { method: 'POST', body: { name } });
    await refreshHashtags();
  }
  async function deleteHashtag(h) {
    if (!window.confirm(`Delete #${h.name}? It will be removed from ${h.uses} transaction${h.uses === 1 ? '' : 's'}.`)) return;
    try {
      await api(`/hashtags/${h.id}`, { method: 'DELETE' });
      if (String(fHashtag) === String(h.id)) fHashtag = '';
      await refreshHashtags();
      await load(true);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not delete the hashtag.';
    }
  }
  function filterByHashtag(id) {
    fHashtag = id;
    load(true);
  }

  // --- Dialogs ---
  let editOpen = $state(false);
  let editTx = $state(null);
  function openEdit(tx) {
    editTx = tx;
    editOpen = true;
  }
  function openCreate() {
    editTx = null;
    editOpen = true;
  }

  // --- Inline category edit (per row) ---
  let editingCatId = $state(null);
  let editCatId = $state('');
  let editSubId = $state('');
  function startCatEdit(tx) {
    editingCatId = tx.id;
    editCatId = tx.categoryId != null ? String(tx.categoryId) : '';
    editSubId = tx.subcategoryId != null ? String(tx.subcategoryId) : '';
  }
  // Does an edited row still belong in the current view? (category selection + hidden)
  function stillMatches(u) {
    if (u.category?.isHidden && !fIncludeHidden) return false;
    // A manual categorization drops the row's matched keyword, so an edit can
    // take it straight out of a keyword-filtered view.
    if (fKeyword === '0' && u.matchedKeywordId != null) return false;
    if (fKeyword && fKeyword !== '0' && String(u.matchedKeywordId) !== fKeyword) return false;
    if (!catSelectionActive) return true;
    if (selUncat && u.categoryId == null) return true;
    if (u.categoryId != null && selCatIds.includes(u.categoryId)) return true;
    if (u.subcategoryId != null && selSubIds.includes(u.subcategoryId)) return true;
    return false;
  }
  // Update a row in place, or drop it (and adjust totals) if it no longer matches.
  function ingest(updated) {
    if (stillMatches(updated)) {
      rows = rows.map((r) => (r.id === updated.id ? updated : r));
      return;
    }
    const removed = rows.find((r) => r.id === updated.id);
    rows = rows.filter((r) => r.id !== updated.id);
    if (removed) {
      total = Math.max(0, total - 1);
      const inc = removed.amountCents > 0 ? -removed.amountCents : 0;
      const exp = removed.amountCents < 0 ? -removed.amountCents : 0;
      summary = { income: summary.income + inc, expense: summary.expense + exp, net: summary.net + inc + exp };
    }
  }
  async function commitInlineCat(tx, v) {
    try {
      const updated = await api(`/transactions/${tx.id}`, {
        method: 'PATCH',
        body: { categoryId: v.categoryId ? Number(v.categoryId) : null, subcategoryId: v.subcategoryId ? Number(v.subcategoryId) : null },
      });
      recordRecentCategory(v.categoryId, v.subcategoryId);
      ingest(updated);
      loadProgress();
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not update category.';
    }
  }

  // --- Text-selection → create keyword ---
  // Selecting text inside any description opens the keyword popover straight
  // away, with the category list already open.
  function onGlobalMouseUp(e) {
    if (e.target.closest?.('.sel-action')) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!text) return;
    const node = sel.anchorNode;
    const el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el?.closest?.('[data-desc]')) return;
    openKeyword(text, sel.getRangeAt(0).getBoundingClientRect());
  }
  function maybeClearSelection(e) {
    if (e.target.closest?.('.sel-action')) return;
    if (kwOpen && !kwSaving) closeKeyword();
  }

  let splitOpen = $state(false);
  let splitTx = $state(null);
  function openSplit(tx) {
    splitTx = tx;
    splitOpen = true;
  }
  async function removeSplit(parentId) {
    if (!window.confirm('Remove this split and restore the single transaction?')) return;
    try {
      await api(`/transactions/${parentId}/splits`, { method: 'DELETE' });
      await load(true);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : 'Could not remove split.';
    }
  }

  // --- Inline keyword creation from a description ---
  // A popover beside the selection (or the row's + button): the phrase, still
  // editable, over a category list that is already open with suggestions on
  // top — picking a category is the commit, so a rule is one selection and one
  // click. Picks are remembered so the next suggestions lead with them.
  const KW_POPOVER_WIDTH = 320;
  const KW_POPOVER_HEIGHT = 440; // phrase + the open menu, roughly
  let kwOpen = $state(false);
  let kwText = $state('');
  let kwCategoryId = $state('');
  let kwSubcategoryId = $state('');
  let kwError = $state('');
  let kwSaving = $state(false);
  let kwPos = $state({ left: 0, top: 0 });
  let kwPopoverEl = $state(null);
  let kwSuggestions = $state([]);
  async function openKeyword(text, rect) {
    kwText = text;
    kwCategoryId = '';
    kwSubcategoryId = '';
    kwError = '';
    kwSuggestions = suggestCategories(categories);
    // Below the anchor when it fits, else above it; never off the window.
    const below = rect.bottom + 6;
    const top = below + KW_POPOVER_HEIGHT <= window.innerHeight ? below : Math.max(8, rect.top - 6 - KW_POPOVER_HEIGHT);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - KW_POPOVER_WIDTH - 8));
    kwPos = { left, top };
    // A fresh CategorySelect each time, so it opens itself again.
    kwOpen = false;
    await tick();
    kwOpen = true;
  }
  function closeKeyword() {
    kwOpen = false;
    window.getSelection()?.removeAllRanges();
  }
  async function saveKeyword(v) {
    kwError = '';
    if (!v.categoryId) return;
    if (!kwText.trim()) return (kwError = 'Enter the phrase to match.');
    kwSaving = true;
    try {
      await api('/keywords', {
        method: 'POST',
        body: { text: kwText.trim(), categoryId: Number(v.categoryId), subcategoryId: v.subcategoryId ? Number(v.subcategoryId) : null },
      });
      recordRecentCategory(v.categoryId, v.subcategoryId);
      closeKeyword();
      await load(true); // recompute already ran server-side
      categories = await api('/categories'); // their counts moved with it
    } catch (err) {
      kwError = err instanceof ApiError ? err.message : 'Could not create keyword.';
    } finally {
      kwSaving = false;
    }
  }
  async function createCategory(name) {
    const c = await api('/categories', { method: 'POST', body: { name } });
    categories = await api('/categories');
    return c.id;
  }
  async function createSubcategory(catId, name) {
    const s = await api(`/categories/${catId}/subcategories`, { method: 'POST', body: { name } });
    categories = await api('/categories');
    return s.id;
  }

  function money(cents, currency) {
    const v = (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency ? `${v} ${currency}` : v;
  }

  // --- Matched-keyword highlighting in descriptions ---
  // Mirror the engine's normalization (lowercase + strip diacritics, incl. the
  // non-decomposing Latin chars), while recording, for each normalized character,
  // the offset it came from in the original string — so a span found in normalized
  // space maps back to the exact original substring (e.g. "zabka" → "ŻABKA").
  const KW_SPECIAL = { ł: 'l', đ: 'd', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th', ð: 'd' };
  function normWithMap(text) {
    let norm = '';
    const map = [];
    let orig = 0;
    for (const ch of String(text ?? '')) {
      let n = ch.toLowerCase();
      n = KW_SPECIAL[n] ?? n;
      n = n.normalize('NFD').replace(/[̀-ͯ]/g, '');
      for (let k = 0; k < n.length; k++) map.push(orig);
      norm += n;
      orig += ch.length;
    }
    map.push(orig); // sentinel: end offset
    return { norm, map };
  }
  // Split a description into { pre, mark, post } around the matched keyword, or
  // null when the keyword can't be located literally (fuzzy/typo match).
  function descParts(tx) {
    const kwText = tx.matchedKeyword?.text;
    if (!kwText) return null;
    const nkw = normWithMap(kwText).norm.trim();
    if (!nkw) return null;
    const { norm, map } = normWithMap(tx.description);
    const idx = norm.indexOf(nkw);
    if (idx === -1) return null;
    const start = map[idx];
    const end = map[idx + nkw.length];
    return { pre: tx.description.slice(0, start), mark: tx.description.slice(start, end), post: tx.description.slice(end) };
  }
  // The summary only names a currency when the rows can only be in one of them:
  // a single selected currency, or an account whose rows are all its own.
  const summaryCurrency = $derived(
    fCurrencies.length === 1 ? fCurrencies[0] : fAccount ? accounts.find((a) => String(a.id) === fAccount)?.currency ?? '' : '',
  );
  const bizLabel = { business: 'B', personal: 'P', mixed: 'M' };
  const listLength = $derived(fGroup ? groups.length : rows.length);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const selectCls = 'rounded-md border border-input bg-card px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring';
</script>

<svelte:window onmouseup={onGlobalMouseUp} onpointerdown={maybeClearSelection} />

<!-- A column header that sorts the list; a second click flips the direction. -->
{#snippet sortHead(col, label, cls = '')}
  {@const on = activeSort?.col === col}
  <button
    class={'flex min-w-0 items-center gap-0.5 uppercase tracking-wide transition hover:text-foreground ' + (on ? 'font-semibold text-foreground ' : '') + cls}
    onclick={() => sortByColumn(col)}
    title={on ? `Sorted: ${activeSort.label} — click to reverse` : `Sort by ${label.toLowerCase()}`}
  >
    <span class="truncate">{label}</span>{#if on}<span aria-hidden="true">{activeSort.dir === 'asc' ? '↑' : '↓'}</span>{/if}
  </button>
{/snippet}

{#if kwOpen}
  <div
    bind:this={kwPopoverEl}
    class="sel-action fixed z-50 flex flex-col gap-2 rounded-md border border-border bg-card p-2.5 shadow-lg"
    style="left: {kwPos.left}px; top: {kwPos.top}px; width: {KW_POPOVER_WIDTH}px"
    role="dialog"
    aria-label="Create keyword"
    tabindex="-1"
    onkeydown={(e) => { if (e.key === 'Escape' && !kwSaving) closeKeyword(); }}
  >
    <div class="flex items-center gap-2">
      <label for="kw-text" class="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Keyword</label>
      <input
        id="kw-text"
        bind:value={kwText}
        class="min-w-0 flex-1 rounded border border-input bg-card px-2 py-1 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
        title="Trim to the distinctive part (e.g. the merchant) — every matching transaction is classified"
      />
      <button class="shrink-0 text-muted-foreground hover:text-foreground" onclick={closeKeyword} aria-label="Cancel" title="Cancel (Esc)"><Icon name="x" size={14} /></button>
    </div>
    <CategorySelect
      {categories}
      bind:categoryId={kwCategoryId}
      bind:subcategoryId={kwSubcategoryId}
      autoOpen
      suggestions={kwSuggestions}
      within={kwPopoverEl}
      placeholder="Pick a category to create the rule…"
      onCreateCategory={createCategory}
      onCreateSubcategory={createSubcategory}
      onChange={saveKeyword}
      onClose={() => { if (!kwSaving && !kwError) closeKeyword(); }}
    />
    {#if kwSaving}<p class="text-xs text-muted-foreground">Creating the rule and classifying…</p>{/if}
    {#if kwError}<p class="text-xs text-destructive">{kwError}</p>{/if}
  </div>
{/if}

<div>
  <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-xl font-semibold">Transactions</h2>
      <p class="text-sm text-muted-foreground">Filter, categorize, tag, split, and add transactions.</p>
    </div>
    <div class="flex items-center gap-3">
      <label class="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <Switch checked={uncatOnly} onCheckedChange={setUncatOnly} />
        Uncategorized only
      </label>
      <Button onclick={openCreate} disabled={accounts.length === 0}><Icon name="plus" />Add transaction</Button>
    </div>
  </div>

  {#if pageError}<p class="mb-4 text-sm text-destructive">{pageError}</p>{/if}

  <div class="flex flex-col gap-4 lg:flex-row lg:items-start">
    <!-- Period + category filters (left) -->
    <aside class="w-full shrink-0 space-y-3 lg:sticky lg:top-4 lg:w-56">
      <!-- Period picker -->
      <Card class="p-2">
        <div class="mb-1 flex items-center justify-between px-1.5">
          <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Period</span>
          {#if fFrom || fTo}
            <button class="text-xs text-muted-foreground underline hover:text-foreground" onclick={clearDates}>Clear</button>
          {/if}
        </div>
        <div class="flex items-center gap-1 px-1 pb-2">
          <input type="date" bind:value={fFrom} onchange={() => load(true)} class="{selectCls} min-w-0 flex-1 px-1.5" title="From date" />
          <span class="text-muted-foreground">–</span>
          <input type="date" bind:value={fTo} onchange={() => load(true)} class="{selectCls} min-w-0 flex-1 px-1.5" title="To date" />
        </div>
        {#if periodYears.length}
          <div class="max-h-[34vh] space-y-0.5 overflow-y-auto pr-0.5">
            {#each periodYears as y (y.year)}
              <div>
                <div class="flex items-center gap-1 rounded hover:bg-accent">
                  <button class="flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground" onclick={() => toggleYear(y.year)} aria-label="Toggle months">
                    <Icon name="chevron-down" size={12} class={expandedYears.includes(y.year) ? '' : '-rotate-90'} />
                  </button>
                  <button
                    class={'flex flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-sm ' + (yearIsSelected(y.year) ? 'bg-primary/10 font-medium text-primary' : '')}
                    onclick={() => selectYear(y.year)}
                  >
                    <span class="flex-1">{y.year}</span>
                    <span class="text-xs text-muted-foreground">{y.count}</span>
                  </button>
                </div>
                {#if expandedYears.includes(y.year)}
                  <div class="ml-6 grid grid-cols-3 gap-1 py-1">
                    {#each y.months as m (m.ym)}
                      <button
                        class={'rounded px-1 py-1 text-xs ' + (monthIsSelected(m.ym) ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}
                        onclick={() => selectMonth(m.ym)}
                        title={`${m.count} transaction${m.count === 1 ? '' : 's'}`}
                      >
                        {MONTHS[m.month - 1]}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </Card>

      <!-- Category tree -->
      <Card class="p-2">
        <div class="mb-1 flex items-center justify-between px-1.5">
          <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Categories</span>
          {#if catSelectionActive}
            <button class="text-xs text-muted-foreground underline hover:text-foreground" onclick={clearCategorySelection}>Clear</button>
          {/if}
        </div>
        <div class="max-h-[70vh] space-y-0.5 overflow-y-auto pr-0.5">
          {#if facets.uncategorized > 0}
            <label class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
              <input type="checkbox" checked={selUncat} onchange={() => { selUncat = !selUncat; load(true); }} />
              <span class="flex-1 truncate text-muted-foreground/80">Uncategorized</span>
              <span class="text-xs text-muted-foreground">{facets.uncategorized}</span>
            </label>
          {/if}
          {#each treeCats as c (c.id)}
            <div>
              <div class="flex items-center gap-1 rounded hover:bg-accent">
                {#if c.subs.length}
                  <button class="flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground" onclick={() => toggleExpand(c.id)} aria-label="Toggle subcategories">
                    <Icon name="chevron-down" size={12} class={expandedCats.includes(c.id) ? '' : '-rotate-90'} />
                  </button>
                {:else}
                  <span class="h-6 w-5 shrink-0"></span>
                {/if}
                <label class="flex flex-1 cursor-pointer items-center gap-2 py-1 pr-1.5 text-sm">
                  <input type="checkbox" checked={selCatIds.includes(c.id)} onchange={() => toggleCat(c.id)} />
                  <CategoryIcon name={c.icon} categoryId={c.id} size={14} class="shrink-0" />
                  <span class="flex-1 truncate">{c.name}</span>
                  <span class="text-xs text-muted-foreground">{c.count}</span>
                </label>
              </div>
              {#if expandedCats.includes(c.id) && c.subs.length}
                <div class="ml-6 space-y-0.5">
                  {#each c.subs as s (s.id)}
                    <label class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                      <input
                        type="checkbox"
                        checked={selCatIds.includes(c.id) || selSubIds.includes(s.id)}
                        disabled={selCatIds.includes(c.id)}
                        onchange={() => toggleSub(s.id)}
                      />
                      <span class="flex-1 truncate text-muted-foreground">{s.name}</span>
                      <span class="text-xs text-muted-foreground">{s.count}</span>
                    </label>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
          {#if treeCats.length === 0 && facets.uncategorized === 0}
            <p class="px-1.5 py-2 text-xs text-muted-foreground">No transactions yet.</p>
          {/if}
        </div>
      </Card>
    </aside>

    <div class="min-w-0 flex-1">
  <!-- Filters -->
  <Card class="mb-4 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative">
        <input
          type="search"
          bind:value={fSearch}
          oninput={searchChanged}
          onsearch={() => load(true)}
          placeholder="Search descriptions…"
          title="Every word has to appear somewhere in the description"
          class="w-56 rounded-md border border-input bg-card py-1.5 pl-3 pr-7 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
        />
        {#if fSearch}
          <button
            class="absolute right-1.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground hover:text-foreground"
            onclick={clearSearch}
            title="Clear the search"
            aria-label="Clear the search"
          >×</button>
        {/if}
      </div>
      {#if facets.keywords?.length}
        <select bind:value={fKeyword} onchange={() => load(true)} class={selectCls} title="Which keyword categorized the row">
          <option value="">Any keyword</option>
          <option value="0">No keyword ({facets.noKeyword})</option>
          {#each facets.keywords as k (k.keywordId)}<option value={String(k.keywordId)}>{k.text} ({k.count})</option>{/each}
        </select>
      {/if}
      <select bind:value={fAccount} onchange={() => load(true)} class={selectCls}>
        <option value="">All accounts</option>
        {#each accounts as a (a.id)}<option value={String(a.id)}>{a.name}</option>{/each}
      </select>
      <select bind:value={fType} onchange={() => load(true)} class={selectCls}>
        <option value="">Income & expense</option>
        <option value="expense">Expense</option>
        <option value="income">Income</option>
      </select>
      <select bind:value={fBusiness} onchange={() => load(true)} class={selectCls}>
        <option value="">Any</option>
        <option value="business">Business</option>
        <option value="personal">Personal</option>
        <option value="mixed">Mixed</option>
      </select>
      {#if holders.length > 1}
        <select bind:value={fHolder} onchange={() => load(true)} class={selectCls}>
          <option value="">All holders</option>
          {#each holders as h (h)}<option value={h}>{h}</option>{/each}
        </select>
      {/if}
      <select bind:value={fSort} onchange={() => load(true)} class={selectCls} title="Sort order — or click a column header">
        {#each sortOptions as o (o.key)}<option value={o.key}>{o.label}</option>{/each}
      </select>
      <div class="flex overflow-hidden rounded-md border border-input text-sm" role="group" aria-label="Grouping">
        {#each GROUP_MODES as m (m.key)}
          <button
            class={'px-2.5 py-1.5 transition ' + (fGroup === m.key ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
            onclick={() => setGroupMode(m.key)}
            title={m.title}
            aria-pressed={fGroup === m.key}
          >{m.label}</button>
        {/each}
      </div>
      <label class="flex items-center gap-1.5 text-sm text-muted-foreground">
        <input type="checkbox" bind:checked={fIncludeHidden} onchange={() => { loadFacets(); load(true); }} /> hidden
      </label>
      <button class="ml-auto text-sm text-muted-foreground underline hover:text-foreground" onclick={resetFilters}>Reset</button>
    </div>
    {#if facets.currencies.length > 1}
      <div class="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
        <span class="text-xs uppercase tracking-wide text-muted-foreground">Currency</span>
        {#each facets.currencies as c (c.currency)}
          <button
            class={'rounded-full border px-2 py-0.5 text-xs transition ' +
              (fCurrencies.includes(c.currency)
                ? 'border-primary bg-primary/10 font-medium text-primary'
                : 'border-border text-muted-foreground hover:bg-accent')}
            onclick={() => toggleCurrency(c.currency)}
            title={`${c.count} transaction${c.count === 1 ? '' : 's'} in ${c.currency}`}
          >
            {c.currency} <span class="text-muted-foreground">{c.count}</span>
          </button>
        {/each}
        {#if fCurrencies.length}
          <button class="text-xs text-muted-foreground underline hover:text-foreground" onclick={() => { fCurrencies = []; load(true); }}>All</button>
        {/if}
      </div>
    {/if}
  </Card>

  <!-- Summary -->
  <div class="mb-4 flex flex-wrap gap-3 text-sm">
    <span class="rounded-md bg-success/10 px-3 py-1.5 text-success">Income {money(summary.income, summaryCurrency)}</span>
    <span class="rounded-md bg-muted px-3 py-1.5 text-foreground">Expenses {money(summary.expense, summaryCurrency)}</span>
    <span class="rounded-md bg-accent px-3 py-1.5 font-medium text-foreground">Net {money(summary.net, summaryCurrency)}</span>
    <span class="ml-auto self-center text-muted-foreground"
      >{total} transaction{total === 1 ? '' : 's'}{#if fGroup} in {totalGroups} group{totalGroups === 1 ? '' : 's'}{/if}</span
    >
  </div>

  <ClassificationProgress {progress} {money} />

  {#if selectedCount > 0}
    <Card class="mb-3 flex flex-wrap items-center gap-2 border-primary/40 bg-primary/5 p-2.5">
      <span class="text-sm font-medium">{selectedCount} {fGroup ? `transaction${selectedCount === 1 ? '' : 's'} ` : ''}selected</span>
      <div class="flex items-center gap-1.5">
        <div class="w-64">
          <CategorySelect
            {categories}
            bind:categoryId={bulkCatId}
            bind:subcategoryId={bulkSubId}
            onCreateCategory={createCategory}
            onCreateSubcategory={createSubcategory}
            allowNone
            placeholder="Categorize as…"
          />
        </div>
        <Button onclick={bulkCategorize} disabled={bulkBusy}>
          <Icon name="check" />Apply to {selectedCount}
        </Button>
      </div>
      <span class="h-5 w-px bg-border"></span>
      <form class="flex items-center gap-1.5" onsubmit={bulkTag}>
        <input
          bind:value={bulkTagName}
          list="hashtag-names"
          placeholder="Add hashtag…"
          maxlength="60"
          class="{selectCls} w-44"
        />
        <Button type="submit" disabled={!bulkTagName.trim()}><Icon name="tag" />Tag selected</Button>
      </form>
      <button class="ml-auto text-sm text-muted-foreground underline hover:text-foreground" onclick={clearSelection}>Clear selection</button>
    </Card>
    <datalist id="hashtag-names">
      {#each hashtags as h (h.id)}<option value={h.name}></option>{/each}
    </datalist>
  {/if}

  {#if loading && listLength === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if listLength === 0}
    <Card class="p-8 text-center"><p class="text-sm text-muted-foreground">No transactions match your filters.</p></Card>
  {:else}
    <Card class="divide-y divide-border">
      <!-- Selection + which optional columns are showing -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-1.5 text-xs text-muted-foreground">
        <label class="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={allVisibleSelected} onchange={toggleAllVisible} />
          {#if fGroup}Select all {plural(groups.length, 'group')} loaded{:else}Select all {rows.length} loaded{/if}
        </label>
        <div class="ml-auto flex items-center gap-1.5">
          <span class="uppercase tracking-wide">Columns</span>
          {#each OPTIONAL_COLUMNS as col (col.key)}
            <button
              class={'rounded-full border px-2 py-0.5 text-[11px] transition ' +
                (!wideEnough
                  ? 'cursor-not-allowed border-border text-muted-foreground/50'
                  : shownColumns[col.key]
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'border-border hover:bg-accent hover:text-foreground')}
              onclick={() => toggleColumn(col.key)}
              disabled={!wideEnough}
              title={wideEnough
                ? (shownColumns[col.key] ? `Hide the ${col.label.toLowerCase()} column` : `Show the ${col.label.toLowerCase()} column`)
                : 'This column only shows on a wider window'}
              aria-pressed={shownColumns[col.key]}
            >
              {col.label}
            </button>
          {/each}
        </div>
      </div>

      {#if fGroup}
      <!-- Grouped: one line per description, ranked by total or count -->
      <div class="grid items-center gap-3 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground" style={groupGridStyle}>
        <span></span>
        {@render sortHead('date', 'Last')}
        {@render sortHead('count', 'Count', 'justify-self-end')}
        {@render sortHead('description', 'Description')}
        {#if visibleColumns.account}<span>Account</span>{/if}
        {#if visibleColumns.category}<span>Category</span>{/if}
        {@render sortHead('amount', 'Total', 'justify-self-end')}
        <span></span>
      </div>

      {#each groups as g, i (g.key)}
        {@const open = expanded[g.key]}
        <div
          class={'grid items-center gap-3 px-3 py-2 hover:bg-accent/40 ' +
            (groupIsDropTarget(g) ? 'bg-primary/10 ring-1 ring-inset ring-primary ' : '') +
            (groupSelected(g) ? 'bg-primary/5' : '')}
          style={groupGridStyle}
          ondragover={(e) => onGroupDragOver(e, g)}
          ondragleave={() => { if (dropTargetKey === g.key) dropTargetKey = null; }}
          ondrop={(e) => onGroupDrop(e, g)}
          role="listitem"
        >
          <input
            type="checkbox"
            class="h-3.5 w-3.5 shrink-0"
            checked={groupSelected(g)}
            onclick={(e) => toggleGroup(g, i, e.shiftKey)}
            aria-label="Select every transaction in this group"
          />

          <span class="text-xs tabular-nums text-muted-foreground" title={g.firstDate === g.lastDate ? g.lastDate : `${g.firstDate} – ${g.lastDate}`}>{g.lastDate}</span>

          <span class="justify-self-end rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-foreground" title={plural(g.count, 'transaction')}>×{g.count}</span>

          <div class="flex min-w-0 items-center gap-1.5">
            <button
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onclick={() => toggleExpandGroup(g)}
              title={open ? 'Hide its transactions' : 'Show its transactions'}
              aria-label={open ? 'Collapse group' : 'Expand group'}
              aria-expanded={!!open}
            >
              <Icon name="chevron-down" size={12} class={open ? '' : '-rotate-90'} />
            </button>
            <span data-desc class="min-w-0 cursor-text truncate text-sm" title={g.description}>{g.description}</span>
            {#if g.variantCount > 1}
              <span class="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground" title="Different spellings folded into this line">{plural(g.variantCount, 'variant')}</span>
            {/if}
          </div>

          {#if visibleColumns.account}
            <span class="truncate text-xs text-muted-foreground">{g.accountName ?? plural(g.accountCount, 'account')}</span>
          {/if}

          {#if visibleColumns.category}
            <div class="relative min-w-0">
              {#if editingGroupKey === g.key}
                <div class="absolute left-0 top-1/2 z-30 w-72 -translate-y-1/2">
                  <CategorySelect
                    {categories}
                    bind:categoryId={editCatId}
                    bind:subcategoryId={editSubId}
                    allowNone
                    autoOpen
                    placeholder="Uncategorized"
                    onCreateCategory={createCategory}
                    onCreateSubcategory={createSubcategory}
                    onChange={(v) => categorizeGroup(g, v)}
                    onClose={() => (editingGroupKey = null)}
                  />
                </div>
              {:else}
                <button
                  class="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs hover:bg-accent"
                  onclick={() => startGroupCatEdit(g)}
                  title={`Click to categorize all ${plural(g.count, 'transaction')}`}
                >
                  {#if g.category}
                    <CategoryIcon name={g.category.icon} categoryId={g.category.id} size={13} class="shrink-0" />
                    <span class="truncate text-foreground">{g.category.name}{#if g.subcategory}<span class="text-muted-foreground"> › {g.subcategory.name}</span>{/if}</span>
                  {:else if g.categoryCount === 1}
                    <span class="truncate text-muted-foreground/60">Uncategorized</span>
                  {:else}
                    <span class="truncate text-muted-foreground">Mixed{#if g.uncategorizedCount} · {g.uncategorizedCount} uncategorized{/if}</span>
                  {/if}
                </button>
              {/if}
            </div>
          {/if}

          <span
            class="whitespace-nowrap text-right text-sm tabular-nums {g.totalCents < 0 ? 'text-foreground' : 'text-success'} {g.converted ? '' : 'italic'}"
            title={!g.converted
              ? 'No exchange rate reaches these rows — shown in their own currency'
              : g.unconvertedCount
                ? `${plural(g.unconvertedCount, 'row')} without an exchange rate left out of the total`
                : ''}
          >{money(g.totalCents, g.currency)}{#if g.unconvertedCount}<span class="text-muted-foreground">*</span>{/if}</span>

          <div class="flex items-center justify-end gap-0.5">
            {#if g.uncategorizedCount}
              <IconButton onclick={(e) => openKeyword(g.description, e.currentTarget.getBoundingClientRect())} title="Create a keyword from this description" aria-label="Create keyword"><Icon name="plus" /></IconButton>
            {/if}
          </div>
        </div>

        {#if open}
          {#if open.loading}
            <p class="bg-muted/30 px-3 py-2 pl-24 text-xs text-muted-foreground">Loading…</p>
          {:else if open.error}
            <p class="bg-muted/30 px-3 py-2 pl-24 text-xs text-destructive">Could not load these transactions.</p>
          {/if}
          {#each open.rows as tx (tx.id)}
            <div class="grid items-center gap-3 bg-muted/30 px-3 py-1.5 text-xs" style={groupGridStyle}>
              <span></span>
              <span class="tabular-nums text-muted-foreground">{tx.date}</span>
              <span></span>
              <span data-desc class="min-w-0 cursor-text truncate pl-6 text-muted-foreground" title={tx.description}>{tx.description}</span>
              {#if visibleColumns.account}<span class="truncate text-muted-foreground">{tx.accountName}</span>{/if}
              {#if visibleColumns.category}
                <span class="flex min-w-0 items-center gap-1.5 px-1.5">
                  {#if tx.category}
                    <CategoryIcon name={tx.category.icon} categoryId={tx.category.id} size={12} class="shrink-0" />
                    <span class="truncate">{tx.category.name}{#if tx.subcategory}<span class="text-muted-foreground"> › {tx.subcategory.name}</span>{/if}</span>
                  {:else}
                    <span class="truncate text-muted-foreground/60">Uncategorized</span>
                  {/if}
                </span>
              {/if}
              <span class="whitespace-nowrap text-right tabular-nums {tx.amountCents < 0 ? 'text-foreground' : 'text-success'}">{money(tx.amountCents, tx.currency)}</span>
              <span></span>
            </div>
          {/each}
        {/if}
      {/each}
      {:else}
      <!-- Column header: click to sort -->
      <div class="grid items-center gap-3 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground" style={gridStyle}>
        <span></span>
        {@render sortHead('date', 'Date')}
        {@render sortHead('description', 'Description')}
        {#if visibleColumns.account}{@render sortHead('account', 'Account')}{/if}
        {#if visibleColumns.category}{@render sortHead('category', 'Category')}{/if}
        {#if visibleColumns.tags}<span>Tags</span>{/if}
        {@render sortHead('amount', 'Amount', 'justify-self-end')}
        <span></span>
      </div>

      {#each rows as tx, i (tx.id)}
        {@const dp = descParts(tx)}
        <div
          class={'grid items-center gap-3 px-3 py-2 hover:bg-accent/40 ' +
            (rowIsDropTarget(tx) ? 'bg-primary/10 ring-1 ring-inset ring-primary ' : '') +
            (selIds.includes(tx.id) ? 'bg-primary/5' : '')}
          style={gridStyle}
          ondragover={(e) => onRowDragOver(e, tx)}
          ondragleave={() => { if (dropTargetId === tx.id) dropTargetId = null; }}
          ondrop={(e) => onRowDrop(e, tx)}
          role="listitem"
        >
          <input
            type="checkbox"
            class="h-3.5 w-3.5 shrink-0"
            checked={selIds.includes(tx.id)}
            onclick={(e) => toggleRow(tx, i, e.shiftKey)}
            aria-label="Select transaction"
          />

          <span class="text-xs tabular-nums text-muted-foreground">{tx.date}</span>

          <!-- Description: the one elastic column, so it takes what the rest leave -->
          <div class="flex min-w-0 items-center gap-1.5">
            <span data-desc class="min-w-0 cursor-text truncate text-sm" title={tx.description}
              >{#if dp}{dp.pre}<mark class="rounded-sm bg-warning-border/70 px-0.5 text-foreground" title="Matched keyword: {tx.matchedKeyword.text}">{dp.mark}</mark>{dp.post}{:else}{tx.description}{/if}</span
            >
            {#if tx.matchedKeyword && !dp}
              <span class="inline-flex shrink-0 items-center gap-0.5 rounded bg-warning-border/70 px-1 text-[10px] text-foreground" title="Matched keyword (fuzzy)">
                <Icon name="key" size={9} />{tx.matchedKeyword.text}
              </span>
            {/if}
            {#if tx.businessFlag !== 'personal'}<span class="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{bizLabel[tx.businessFlag]}</span>{/if}
            {#if tx.isManual}<span class="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">manual</span>{/if}
            {#if tx.isSplitChild}<span class="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">split</span>{/if}
          </div>

          {#if visibleColumns.account}
            <span class="truncate text-xs text-muted-foreground" title="{tx.accountName} · {tx.holder}">{tx.accountName}</span>
          {/if}

          {#if visibleColumns.category}
            <!-- relative, so the inline editor can overlay its neighbours
                 instead of stretching the column -->
            <div class="relative min-w-0">
              {#if editingCatId === tx.id}
                <div class="absolute left-0 top-1/2 z-30 w-72 -translate-y-1/2">
                  <CategorySelect
                    {categories}
                    bind:categoryId={editCatId}
                    bind:subcategoryId={editSubId}
                    allowNone
                    autoOpen
                    placeholder="Uncategorized"
                    onCreateCategory={createCategory}
                    onCreateSubcategory={createSubcategory}
                    onChange={(v) => commitInlineCat(tx, v)}
                    onClose={() => (editingCatId = null)}
                  />
                </div>
              {:else}
                <button
                  class="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs hover:bg-accent"
                  onclick={() => startCatEdit(tx)}
                  title={tx.category ? `${tx.category.name}${tx.subcategory ? ' › ' + tx.subcategory.name : ''} — click to change` : 'Click to categorize'}
                >
                  {#if tx.category}
                    <CategoryIcon name={tx.category.icon} categoryId={tx.category.id} size={13} class="shrink-0" />
                    <span class="truncate text-foreground">{tx.category.name}{#if tx.subcategory}<span class="text-muted-foreground"> › {tx.subcategory.name}</span>{/if}</span>
                  {:else}
                    <span class="truncate text-muted-foreground/60">Uncategorized</span>
                  {/if}
                  {#if tx.isLocked && !tx.isManual}<Icon name="key" size={11} class="ml-auto shrink-0 text-muted-foreground/60" />{/if}
                </button>
              {/if}
            </div>
          {/if}

          {#if visibleColumns.tags}
            <!-- Narrow on purpose: it scrolls rather than hiding a tag you
                 would then have no way to remove. -->
            <div class="flex min-w-0 items-center gap-1 overflow-x-auto" title={tx.hashtags.map((h) => '#' + h.name).join(' ')}>
              {#each tx.hashtags as h (h.id)}
                <span class="group/tag inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  #{h.name}
                  <button
                    class="opacity-0 transition group-hover/tag:opacity-100 hover:text-destructive"
                    onclick={() => unassignTag(h, [tx.id])}
                    title="Remove #{h.name}"
                    aria-label="Remove hashtag"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </span>
              {/each}
            </div>
          {/if}

          <span class="whitespace-nowrap text-right text-sm tabular-nums {tx.amountCents < 0 ? 'text-foreground' : 'text-success'}">{money(tx.amountCents, tx.currency)}</span>

          <div class="flex items-center justify-end gap-0.5">
            {#if !tx.category}
              <IconButton onclick={(e) => openKeyword(tx.description, e.currentTarget.getBoundingClientRect())} title="Create a keyword from this description" aria-label="Create keyword"><Icon name="plus" /></IconButton>
            {/if}
            {#if tx.isSplitChild}
              <IconButton onclick={() => removeSplit(tx.parentId)} title="Remove split" aria-label="Remove split"><Icon name="chevron-down" /></IconButton>
            {:else}
              <IconButton onclick={() => openSplit(tx)} title="Split transaction" aria-label="Split transaction"><Icon name="download" /></IconButton>
            {/if}
            <IconButton onclick={() => openEdit(tx)} title="Edit" aria-label="Edit"><Icon name="pencil" /></IconButton>
          </div>
        </div>
      {/each}
      {/if}
    </Card>

    <div class="mt-4 flex flex-wrap items-center justify-center gap-3">
      {#if fGroup ? groups.length < totalGroups : rows.length < total}
        <Button variant="outline" onclick={loadMore} disabled={loading}
          >{loading ? 'Loading…' : fGroup ? `Load more (${groups.length} of ${totalGroups} groups)` : `Load more (${rows.length} of ${total})`}</Button
        >
      {/if}
      <div class="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span>Show</span>
        {#each PAGE_SIZE_CHOICES as n (n)}
          <button
            class={'rounded-md border px-2 py-1 text-xs tabular-nums transition ' +
              (pageSize === n
                ? 'border-primary bg-primary/10 font-medium text-primary'
                : 'border-border hover:bg-accent hover:text-foreground')}
            onclick={() => setPageSize(n)}
            title={n === 0 ? 'Load every matching transaction — slow on a big database' : `${n} rows per load`}
          >
            {pageSizeLabel(n)}
          </button>
        {/each}
        <input
          type="number"
          min="1"
          bind:value={customPageSize}
          onchange={applyCustomPageSize}
          onkeydown={(e) => e.key === 'Enter' && applyCustomPageSize()}
          placeholder={PAGE_SIZE_CHOICES.includes(pageSize) ? 'n' : String(pageSize)}
          title="Any number of rows per load"
          class="w-16 rounded-md border border-input bg-card px-2 py-1 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring"
        />
        <span>at a time</span>
      </div>
    </div>
  {/if}
    </div>

    <!-- Hashtag palette (right) -->
    <aside class="w-full shrink-0 space-y-3 lg:sticky lg:top-4 lg:w-52">
      <HashtagPanel
        {hashtags}
        activeId={fHashtag}
        {selectedCount}
        onFilter={filterByHashtag}
        onCreate={createHashtag}
        onDelete={deleteHashtag}
        onApply={(h) => assignTag(h, selIds)}
        onDragStart={(h) => (dragTag = h)}
        onDragEnd={() => { dragTag = null; dropTargetId = null; dropTargetKey = null; }}
      />
    </aside>
  </div>
</div>

<TransactionDialog bind:open={editOpen} tx={editTx} {accounts} {categories} defaultAccountId={fAccount || accounts[0]?.id} onSaved={load} onCategoriesChanged={loadSupporting} />
<SplitDialog bind:open={splitOpen} tx={splitTx} {categories} onSaved={load} />

