import { sql } from 'drizzle-orm';
import { sqliteTable, integer, real, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Users are admin-managed (no public self-registration). The first boot seeds a
// default admin (admin/admin) with passwordIsDefault=true so the UI can nudge a
// password change. Every domain table added in later phases carries a `userId`
// FK for data isolation.
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  passwordIsDefault: integer('password_is_default', { mode: 'boolean' })
    .notNull()
    .default(false),
  theme: text('theme').notNull().default('light'), // 'light' | 'dark'
  defaultCurrency: text('default_currency').notNull().default('PLN'),
  globalFuzzyDistance: integer('global_fuzzy_distance').notNull().default(0),
  // Rows the transaction list loads per page (and per "load more").
  transactionsPageSize: integer('transactions_page_size').notNull().default(100),
  // --- AI categorization (the engine, not the key: keys live in `aiKeys`) ---
  // `aiProvider`+`aiModel` together are the *engine identity* recorded on every
  // proposal, so switching either one makes already-analyzed merchants eligible
  // again. `aiWebSearch` is ignored by engines that cannot search (DeepSeek).
  aiProvider: text('ai_provider').notNull().default('anthropic'),
  aiModel: text('ai_model').notNull().default(''), // '' = the provider's default model
  aiWebSearch: integer('ai_web_search', { mode: 'boolean' }).notNull().default(true),
  aiBatchSize: integer('ai_batch_size').notNull().default(25), // merchants analyzed per run
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// Application-wide defaults, a single row (id = 1). New users inherit these
// values as their initial per-user settings at creation time (a snapshot —
// later edits to app defaults do not retroactively change existing users).
export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey(),
  defaultCurrency: text('default_currency').notNull().default('PLN'),
  globalFuzzyDistance: integer('global_fuzzy_distance').notNull().default(0),
});

// A financial institution (bank) registered by a user. Deleting the user
// cascades to their institutions.
export const institutions = sqliteTable('institutions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// An account under an institution. Mandatory currency; a free-text account
// holder (defaults to the owning user's username). Deleting the user or the
// parent institution cascades to accounts.
export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  institutionId: integer('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  holder: text('holder').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// A top-level spending category owned by a user. `businessDefault` seeds the
// business/personal flag of new transactions landing here. `isHidden` excludes
// the category from lists/graphs/totals (e.g. internal transfers). Expense vs.
// income is NOT stored — it is derived from the transaction amount sign.
export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // Name of a curated SVG glyph from the client icon pool (client/src/lib/
  // categoryIcons.js). Nullable = no icon chosen.
  icon: text('icon'),
  businessDefault: text('business_default').notNull().default('personal'), // 'business' | 'personal' | 'mixed'
  isHidden: integer('is_hidden', { mode: 'boolean' }).notNull().default(false),
  isCashWithdrawal: integer('is_cash_withdrawal', { mode: 'boolean' }).notNull().default(false),
  // The Budget P&L line this category's money lands on (a subcategory may override).
  budgetLineId: integer('budget_line_id').references(() => budgetLines.id, { onDelete: 'set null' }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// An optional subcategory under a category. Deleting the category cascades.
export const subcategories = sqliteTable('subcategories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  categoryId: integer('category_id')
    .notNull()
    .references(() => categories.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icon: text('icon'),
  budgetLineId: integer('budget_line_id').references(() => budgetLines.id, { onDelete: 'set null' }), // null = the category's line
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// A classification keyword tied to a category and optionally a subcategory. A
// null `distance` falls back to the user's global fuzzy distance. Full keyword
// CRUD and the classification engine arrive in Phase 4; the table exists now so
// the first-run seeder can persist the seed's nested keywords.
export const keywords = sqliteTable('keywords', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  categoryId: integer('category_id')
    .notNull()
    .references(() => categories.id, { onDelete: 'cascade' }),
  subcategoryId: integer('subcategory_id').references(() => subcategories.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  distance: integer('distance'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// A reusable CSV parsing template, one per account. Captures everything needed
// to turn a bank's raw export into canonical transactions: encoding/delimiter/
// decimal separator, how many lines precede the header, which column holds the
// date (and its format), which columns merge into the description, which columns
// sum into the signed amount, an optional currency column (else the account
// currency), optional foreign amount/currency metadata for the FX toggle, and
// saved row filters applied on every upload. Column references are by header
// name. Deleting the account cascades. See the CSV template model in CLAUDE.md.
export const csvTemplates = sqliteTable('csv_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: integer('account_id')
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  delimiter: text('delimiter').notNull().default(','),
  decimalSeparator: text('decimal_separator').notNull().default('.'),
  encoding: text('encoding').notNull().default('utf-8'),
  headerRow: integer('header_row').notNull().default(0), // 0-based line index of the header
  dateFormat: text('date_format').notNull().default('YYYY-MM-DD'),
  dateColumn: text('date_column').notNull().default(''),
  descriptionColumns: text('description_columns', { mode: 'json' }).notNull().default([]),
  amountColumns: text('amount_columns', { mode: 'json' }).notNull().default([]),
  currencyColumn: text('currency_column'),
  foreignAmountColumn: text('foreign_amount_column'),
  foreignCurrencyColumn: text('foreign_currency_column'),
  filters: text('filters', { mode: 'json' }).notNull().default([]), // [{column, op, value}]
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// One bank-extract upload (the archive record). Deleting an upload cascades to
// the transactions it imported (rollback). Populated by the Phase 5 pipeline;
// the table exists now so transactions can carry a real `uploadId` FK.
export const uploads = sqliteTable('uploads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  format: text('format').notNull().default('csv'), // 'csv' | 'ofx'
  totalRows: integer('total_rows').notNull().default(0),
  importedCount: integer('imported_count').notNull().default(0),
  uploadedAt: text('uploaded_at').notNull().default(sql`(datetime('now'))`),
});

// A single transaction. Canonical money is the signed integer `amountCents`
// (amount<0 = expense, >0 = income — derived, never stored). Imported rows keep
// date/description/amount immutable for dedup stability; only classification,
// business flag, hashtags, and splits are editable. `uploadId` NULL = a manual
// entry. `parentId` set = a split child (the parent becomes a container counted
// only through its children). The classification engine assigns
// category/subcategory/`matchedKeywordId`; `isLocked` protects a manual
// categorization from re-runs. Category/subcategory/keyword deletes set the
// respective FK to NULL (a recompute then reclassifies).
export const transactions = sqliteTable('transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  uploadId: integer('upload_id').references(() => uploads.id, { onDelete: 'cascade' }),
  date: text('date').notNull(), // 'YYYY-MM-DD'
  description: text('description').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  foreignAmountCents: integer('foreign_amount_cents'),
  foreignCurrency: text('foreign_currency'),
  categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
  subcategoryId: integer('subcategory_id').references(() => subcategories.id, { onDelete: 'set null' }),
  businessFlag: text('business_flag').notNull().default('personal'), // 'business' | 'personal' | 'mixed'
  isManual: integer('is_manual', { mode: 'boolean' }).notNull().default(false),
  isLocked: integer('is_locked', { mode: 'boolean' }).notNull().default(false),
  matchedKeywordId: integer('matched_keyword_id').references(() => keywords.id, { onDelete: 'set null' }),
  parentId: integer('parent_id').references(() => transactions.id, { onDelete: 'cascade' }),
  dedupKey: text('dedup_key').notNull(),
  // Budget: a pin to one P&L line (beats hashtags and the category mapping), and
  // how many months the amount is spread over from the month it was paid (null
  // or 1 = counted when paid). Neither changes the transaction itself.
  budgetLineId: integer('budget_line_id').references(() => budgetLines.id, { onDelete: 'set null' }),
  spreadMonths: integer('spread_months'),
  fitid: text('fitid'), // OFX bank-assigned transaction id (provenance; the dedup key itself is in dedupKey)
  occurrenceIndex: integer('occurrence_index').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// A free-text hashtag used to cluster ad-hoc activity (a trip, a renovation).
// Unique per user by name; attached to transactions via the join table.
export const hashtags = sqliteTable(
  'hashtags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Budget: a tag that sends its rows to a P&L line (a trip, a renovation),
    // ranked by `budgetOrder` when one row carries two of them.
    budgetLineId: integer('budget_line_id').references(() => budgetLines.id, { onDelete: 'set null' }),
    budgetOrder: integer('budget_order').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ userName: uniqueIndex('hashtags_user_name_unique').on(t.userId, t.name) }),
);

// Many-to-many between transactions and hashtags. Deleting either side cascades.
export const transactionHashtags = sqliteTable(
  'transaction_hashtags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    hashtagId: integer('hashtag_id')
      .notNull()
      .references(() => hashtags.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pair: uniqueIndex('transaction_hashtags_pair_unique').on(t.transactionId, t.hashtagId) }),
);

// A user-uploaded exchange rate: 1 unit of `fromCcy` = `rate` units of `toCcy`
// on `date`. Level 2 of the FX fallback chain (level 1 is the rate derived from
// a transaction's own amount pair; level 3 — a live daily-rate API — is
// deferred). Unique per user per (date, from, to) so re-uploading a table
// overwrites rather than duplicates.
export const fxRates = sqliteTable(
  'fx_rates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: text('date').notNull(), // 'YYYY-MM-DD'
    fromCcy: text('from_ccy').notNull(),
    toCcy: text('to_ccy').notNull(),
    rate: real('rate').notNull(),
    source: text('source').notNull().default('upload'), // 'upload' | 'manual'
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ userPair: uniqueIndex('fx_rates_user_pair_unique').on(t.userId, t.date, t.fromCcy, t.toCcy) }),
);

// Optional per-account OFX import settings. OFX is self-describing — the file
// already names its own dates, amounts, currencies and descriptions — so unlike
// `csv_templates` this row is never required: an account without one imports OFX
// on the defaults. It only records (a) which OFX fields merge into the
// description, in join order, and (b) the bank/account identity seen in the
// first imported file, so a later file from a different account can be flagged.
// A separate table from `csv_templates` on purpose: that one is unique per
// account, and an account may legitimately receive both CSV and OFX exports.
export const ofxSettings = sqliteTable('ofx_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: integer('account_id')
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  descriptionFields: text('description_fields', { mode: 'json' }).notNull().default(['NAME', 'MEMO']),
  bankId: text('bank_id'),
  acctId: text('acct_id'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});


// --- AI categorization ------------------------------------------------------
//
// A per-user API key for one AI provider. Stored encrypted (AES-256-GCM, see
// `src/ai/crypto.js`) because a plaintext key in bext.db would be readable by
// anyone holding a backup snapshot — and snapshots hold every user's data. The
// API never serves `secret` back; `hint` (last 4 characters) is what the
// settings page shows so you can tell which key is saved.
export const aiKeys = sqliteTable(
  'ai_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'anthropic' | 'openai' | 'gemini' | 'deepseek'
    secret: text('secret').notNull(), // encrypted, never returned by the API
    hint: text('hint').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ userProvider: uniqueIndex('ai_keys_user_provider_unique').on(t.userId, t.provider) }),
);

// One batch of AI analysis. The run is what the review page polls while the
// engine works through its merchants; it exists so a run survives a page reload
// and so a failed provider call is reported somewhere other than a lost HTTP
// response.
export const aiRuns = sqliteTable('ai_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  engineKey: text('engine_key').notNull(), // `${provider}:${model}` — the identity a proposal is logged under
  webSearch: integer('web_search', { mode: 'boolean' }).notNull().default(false),
  status: text('status').notNull().default('running'), // 'running' | 'done' | 'failed' | 'canceled'
  requested: integer('requested').notNull().default(0),
  completed: integer('completed').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  error: text('error'),
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  finishedAt: text('finished_at'),
});

// One AI proposal: a keyword → category/subcategory mapping for one *merchant
// group* (a set of transactions whose descriptions normalize to the same
// `groupKey`), not for one transaction — which is what a keyword rule is.
//
// The unique index on (userId, engineKey, groupKey) is the "never run the same
// transactions twice" rule, and it is enforced by the database rather than by a
// query the runner might forget: an engine gets one answer per merchant, whether
// you accepted it or not. Switching provider or model changes `engineKey`, which
// is the deliberate escape hatch for a second opinion.
//
// `categoryId` may be NULL — an engine that cannot place a merchant says so, the
// proposal is still logged (so it is not re-analyzed), and the review page lets
// you pick a category by hand before accepting.
export const aiProposals = sqliteTable(
  'ai_proposals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runId: integer('run_id').references(() => aiRuns.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    engineKey: text('engine_key').notNull(),
    webSearch: integer('web_search', { mode: 'boolean' }).notNull().default(false),
    groupKey: text('group_key').notNull(),
    sampleDescription: text('sample_description').notNull(),
    merchant: text('merchant'), // what the engine thinks the business is
    keyword: text('keyword').notNull(),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    subcategoryId: integer('subcategory_id').references(() => subcategories.id, { onDelete: 'set null' }),
    confidence: integer('confidence'), // 0–100, as reported by the engine
    rationale: text('rationale'),
    sources: text('sources', { mode: 'json' }).notNull().default([]), // [{title, url}] from the web lookup
    status: text('status').notNull().default('pending'), // 'pending' | 'accepted' | 'accepted_once' | 'rejected'
    txCount: integer('tx_count').notNull().default(0), // transactions covered when proposed
    createdKeywordId: integer('created_keyword_id').references(() => keywords.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    decidedAt: text('decided_at'),
  },
  (t) => ({ userEngineGroup: uniqueIndex('ai_proposals_user_engine_group_unique').on(t.userId, t.engineKey, t.groupKey) }),
);

// Which transactions a proposal covered. The group key alone would answer "has
// this merchant been analyzed"; this table answers "has *this transaction* been
// analyzed, and what was proposed for it" — the log the review page reads to
// mark a row, and the reason a later import of the same merchant is still
// covered by the group key rather than silently re-analyzed per row.
export const aiProposalTransactions = sqliteTable(
  'ai_proposal_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    proposalId: integer('proposal_id')
      .notNull()
      .references(() => aiProposals.id, { onDelete: 'cascade' }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pair: uniqueIndex('ai_proposal_transactions_pair_unique').on(t.proposalId, t.transactionId) }),
);


// --- Budget -----------------------------------------------------------------
//
// One line of the household P&L, named by the user. Its `kind` is what the
// subtotals are built from, so lines can read in the user's words ("Housing",
// "Kids") while Net income, the normal-month result and the net result stay
// well defined:
//
//   net income    = income + tax
//   discretionary = net income + committed (the big yearly costs you know are coming)
//   normal month  = discretionary + fixed + periodic + variable (+ unassigned)
//   net result    = normal month + extraordinary
//
// `excluded` lines (internal transfers) are shown but never summed. Money is
// signed throughout, as everywhere else: costs are negative.
export const budgetLines = sqliteTable('budget_lines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // 'income' | 'tax' | 'committed' | 'fixed' | 'periodic' | 'variable' | 'extraordinary' | 'excluded'
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// A Health finding the user marked as fine. `key` names what the finding is
// about (a keyword, a category, an account's import); `fingerprint` digests
// its evidence at the time, so the finding stays hidden only while the
// evidence is unchanged — a broad keyword accepted today comes back once it
// starts catching new rows.
export const healthDismissals = sqliteTable(
  'health_dismissals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ userKey: uniqueIndex('health_dismissals_user_key_unique').on(t.userId, t.key) }),
);

// --- Transfers ----------------------------------------------------------------
//
// An account the user owns (or money is parked in) but does not import: a bank's
// currency exchange wallet, a broker, a term deposit, a loan to a friend.
// `patterns` are texts that identify its rows, matched like keywords (whole
// words, consecutive, case and accents ignored). A transfer row matching one is
// internal by definition, and the account's running balance (in − out) says
// what should be there: ~0 for an exchange wallet, your savings for a broker.
export const offbookAccounts = sqliteTable('offbook_accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('other'), // 'exchange' | 'savings' | 'loan' | 'other'
  patterns: text('patterns', { mode: 'json' }).notNull().default([]),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// A decision about one pair of transactions: `confirmed` makes it a pair
// whatever the matcher thinks, `rejected` keeps the matcher from ever proposing
// it again. Pairing itself is recomputed from the data every time, like
// classification; only what the user decided is stored.
export const transferDecisions = sqliteTable(
  'transfer_decisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    outId: integer('out_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    inId: integer('in_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    status: text('status').notNull(), // 'confirmed' | 'rejected'
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ pair: uniqueIndex('transfer_decisions_pair_unique').on(t.outId, t.inId) }),
);
