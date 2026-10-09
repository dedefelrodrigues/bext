# BeXT — Implementation Plan

> **Note (2026-10):** this plan was written against real bank extracts. Before the project was shared they were moved out of the repository (to the git-ignored `samples/private/`) and replaced by synthetic files in the same formats; the counts quoted below are those of the originals. See *Samples* in `CLAUDE.md`.

## Context

`BeXT` is a multi-user tool to upload bank-extract CSVs and categorize transactions by keyword matching. This plan turned the spec in `CLAUDE.md` (full requirements + locked decisions), grounded in the real extracts under `samples/`, into a phased, checkpointed build. Phase headings below are marked as they land — see Status.

Grounding from the real samples:
- **Alior.csv** — `;`-delimited, comma decimal, **Windows-1250** (non-UTF-8), CRLF, a criteria line *before* the header (skip-rows), two amount+currency pairs (`Kwota operacji`/`Waluta operacji` vs `Kwota w walucie rachunku`/`Waluta rachunku`), `DD-MM-YYYY`.
- **Revolut_sample.csv** — `,`-delimited, dot decimal, UTF-8, `Amount`+`Fee` summed, `State=COMPLETED` filter, per-row `Currency`.
- **itau_combined.csv** — `,`-delimited, dot decimal, single `Amount`, implicit BRL, 844 rows with real noise (`SALDO FINAL`, `APL/RES APLIC AUT MAIS` auto-investment transfers, `REND PAGO`).
- **category_seed.json** — 16 top-level categories incl. `Company`, `Transfer In/Out` (with a `Withdraw` sub), `Unknown`; keywords nested under subcategories; `category_type` field present but ignored per spec.

## Status

Phases 0–7.1 and the Home dashboard are built and covered by tests (`server` `npm test` —
162 passing as of the last commit). **Phase 8 (cash LIFO pool) is the only phase from the
original plan left**; the `is_cash_withdrawal` flag and the seeded `Cash Withdrawal`
category ship already, the matcher and virtual cash entry do not.

Landed outside the original phasing, each with its own section below:

- **Settings danger zone** — clear all of the signed-in user's transactions.
- **Hashtag drag-and-drop + bulk tagging** — a tag palette beside the transaction list,
  row multi-select, and bulk assign/unassign endpoints.
- **Classification progress bar** — how much *money* is still uncategorized under the
  current filters, with a count fallback when no rate covers the rows.
- **Currency filter + sort order** — multi-select currency chips (on the transaction's own
  currency) and sorting by date or description.
- **Transactions per page** — a per-user setting, 500 by default, uncapped (`0` = all).

Each section states what was decided and why, the routes and files touched, its tests, and
how it was verified — read the section before changing that area.

## Decisions from requirements grilling (confirmed)

1. **Core-first sequencing.** Ship auth → accounts → categories → keywords+engine → upload → transaction list, with a user checkpoint before FX, graphs, and cash pool.
2. **FX = derived + uploaded table only in v1** (CSV-derived per-row rate when both amount pairs exist, plus a user-uploaded `(date,from,to)→rate` table). No live API in v1; unconvertible rows shown unconverted and visibly flagged.
3. **Cash LIFO pool deferred.** Ship the `is_cash_withdrawal` flag + seeded `Cash Withdrawal` category now; build LIFO matching / virtual cash entry later.
4. **Uncategorized = NULL** (a distinct filter state). Seed's `Unknown` category is treated as sample noise and dropped at seed time.

## Self-made assumptions (flag if wrong)

- Auth: `express-session` + SQLite-backed session store; `bcrypt` password hashes; no email/reset (CLI reset script).
- DB: Drizzle ORM over `better-sqlite3`; migrations auto-apply on boot; file at `server/data/bext.db`.
- CSV parsed server-side (`csv-parse`); Alior decoded with `iconv-lite`.
- Longest-keyword tie-break: character length desc, then lowest keyword id.
- Dedup: **per account**, occurrence-counted.
- Description columns merged with a single space.

## Architecture

- **Monorepo, no workspace tooling.** `server/` (Node + Express + Drizzle + better-sqlite3, port 3001) and `client/` (Svelte + Vite + Tailwind + shadcn-svelte, `$lib` alias). Vite proxies `/api` → 3001 in dev; in prod Express serves `client/dist`.
- Every domain table carries `user_id`; **all queries filter by the session user** (data isolation). A shared `requireAuth` middleware injects `req.userId`; a per-route helper enforces the scope so isolation is not left to individual handlers.
- Money stored as integer `amount_cents`; dates as `TEXT 'YYYY-MM-DD'`.
- `./dev.sh` runs both halves together for day-to-day work (tagged `[server]`/`[client]` logs, Ctrl-C stops the pair, killing by process group so no orphan node/vite keeps holding :3001/:5173). Written for the bash 3.2 macOS ships — no `wait -n`, no `sed -u`.

## Data model (`server/src/db/schema.js`)

- `users` — id, username, password_hash, default_currency, global_fuzzy_distance (default 0), transactions_page_size (default 500), created_at.
- `sessions` — session-store table.
- `institutions` — id, user_id, name.
- `accounts` — id, user_id, institution_id, name, currency (mandatory), holder (free text, default = username).
- `csv_templates` — id, user_id, account_id, delimiter, decimal_sep, encoding, skip_rows, header_row_index, date_format, date_column, description_columns (JSON), amount_columns (JSON), currency_column (nullable), foreign_amount_column/foreign_currency_column (nullable, for FX metadata), filters (JSON list of `{column, op, value}`).
- `categories` — id, user_id, name, business_default (`business|personal|mixed`), is_hidden, is_cash_withdrawal, sort_order.
- `subcategories` — id, user_id, category_id, name.
- `keywords` — id, user_id, category_id, subcategory_id (nullable), text, distance (nullable → falls back to user global).
- `uploads` — id, user_id, account_id, filename, uploaded_at, total_rows, imported_count.
- `transactions` — id, user_id, account_id, upload_id (nullable = manual), date, description, amount_cents, currency, foreign_amount_cents/foreign_currency (nullable), category_id/subcategory_id (nullable), business_flag, is_manual, is_locked (manual categorization), matched_keyword_id (nullable), parent_id (nullable = split child; parent becomes container), dedup_key, occurrence_index, created_at.
- `hashtags` — id, user_id, name; `transaction_hashtags` — join.
- `fx_rates` (Phase 7) — id, user_id, date, from_ccy, to_ccy, rate, source.
- `ofx_settings` (Phase 7.1) — id, user_id, account_id (unique), description_fields (JSON, default `["NAME","MEMO"]`), bank_id, acct_id. Optional: an account with no row still imports OFX on the defaults. Phase 7.1 also adds `transactions.fitid` and `uploads.format`.

## Phased steps

### Phase 0 — Scaffold — DONE
- Init `server/` (Express, Drizzle, better-sqlite3, `npm run dev`/`test`/`db:generate`) and `client/` (Vite + Svelte + Tailwind + shadcn-svelte, `$lib` alias). `/api/health` route; boot-time migration apply; prod static serving of `client/dist`. Vitest wired.

### Phase 1 — Auth + user settings (+ admin) — DONE
- Login/logout; bcrypt; session cookie + SQLite session store; `requireAuth`.
- **Admin model:** `requireAdmin`; admin-only user management (create/delete/reset-password/grant-revoke admin) and application-default settings (singleton seeding new users at creation). Default `admin`/`admin` seeded on first boot with a change-password nudge (`passwordIsDefault`). No public self-registration. Guards: no self-delete, last-admin protected.
- Per-user settings page: default_currency, global_fuzzy_distance, change password.
- CLI password-reset script (`server/scripts/reset-password.js`).

### Phase 2 — Institutions + Accounts — DONE
- CRUD for institutions and accounts (account currency mandatory, holder free text defaulting to username). All user-scoped, with FK cascade on user/institution delete; institution deletion blocked while it has accounts. Combined Accounts page (institutions with nested accounts) + reusable Dialog primitive.

### Phase 3 — Categories + Subcategories — DONE
- CRUD with `business_default`, `is_hidden`, `is_cash_withdrawal`; bulk "mark whole category business".
- **Seeder** (first run per user): import `samples/category_seed.json`, ignore `category_type`, `Company`→business_default=business, `Transfer In/Out`→hidden, **append** a `Cash Withdrawal` category with `is_cash_withdrawal=true`, **drop** `Unknown`. Nested seed keywords become `keywords` rows.
- JSON export/import round-tripping the seed shape.

### Phase 4 — Keywords + classification engine — DONE
- Keyword CRUD; CSV export/import (`keyword,category,subcategory,distance`).
- **Engine** (`server/src/engine/classify.js`) — pure function `classify(transactions, keywords, globalDistance) → assignments`:
  - Normalize description: lowercase, strip diacritics, tokenize.
  - For a keyword of N tokens, slide an N-token window; each token matches within its effective distance (per-keyword override else global). **Tokens < 5 chars require exact match** regardless of distance.
  - Among all matching keywords, **longest by char length wins**; tie → lowest keyword id.
  - Assign category/subcategory + `matched_keyword_id`; unmatched → NULL.
  - **Never touches** `is_locked=true` or split children/containers. Deterministic and re-runnable.
- **Recompute trigger:** any keyword add/edit/delete re-runs the engine over all non-locked imported transactions of the user.

### Phase 5 — CSV templates + upload pipeline — DONE
- Template editor per account; "copy template from account".
- **Upload pipeline** (`server/src/upload/`):
  1. Decode (iconv-lite) → skip rows → parse (csv-parse, template delimiter/decimal).
  2. Apply saved row filters.
  3. Build canonical rows: merge description columns (space-join); sum amount columns (empty = 0) → signed `amount_cents`; pick date column, parse via `date_format`, truncate to date; currency from column else account currency; capture foreign amount/currency metadata.
  4. **Dedup:** key = `date|description|amount_cents` per account, occurrence-counted (compare in-file occurrence index against existing DB count).
  5. Run engine → **preview** (per-row: included/excluded, dedup status, proposed category). User can exclude individual rows.
  6. Confirm → persist transactions + `uploads` record.
- **Upload archive** page; **rollback** delete (warn with counts of locked/split txns destroyed).

### Phase 6 — Transaction list — DONE
- Filterable list: category, subcategory, holder, account, business/personal, hashtag, date range, expense/income (derived from amount sign), **uncategorized**.
- **Inline keyword creation:** select text in a description → create keyword + category/subcategory → auto-classify all matches (triggers recompute).
- Hashtags (attach/detach, free text). Manual transactions (fully editable). Imported txns immutable in date/description/amount; only category/business/hashtags/splits editable.
- **Splits:** children must sum to parent; each child has own category/subcategory/business/hashtags; parent becomes container (only children counted in reports). Hidden categories excluded from list/totals.

### — CHECKPOINT — (user review before Phases 7–8) — PASSED

### Phase 7 — Graphs + FX (derived + uploaded table) — DONE
- FX resolver: per-row derived rate (both amount pairs) → uploaded `fx_rates` table → else flag unconverted. Target = user default currency. Toggle original ↔ converted.
- v1 graph shortlist: monthly income vs expenses bars; stacked monthly expenses by category; category donut/treemap with subcategory drill-down; single-category timeline; business vs personal over time; spend-per-hashtag. All respect hidden categories + FX toggle.
- As built: `fx_rates` table + `server/src/fx/` (converter with the three-level chain — the row's own amount pair, a rate derived from another row of the same date/pair, then the uploaded table with inverse pairs as `1/rate` and the latest rate on or before the transaction date; unreachable rows returned flagged and counted). `/api/fx` does rate CRUD + a `date,from,to,rate` CSV round-trip (import merges, all-or-nothing on a bad row); rates are managed from a card on the Settings page.
- `/api/reports` (`monthly`, `by-category`, `monthly-by-category`, `business`, `hashtags`) aggregates in JS over the rows the transaction list itself selects, via a now-exported `listConditions` — leaves only, hidden categories excluded, same filter params. The stacked chart's tail folds into an "Other" series.
- Client: `GraphsPage` (one filter row: period presets, account, holder, business, converted/original + target currency) over hand-rolled SVG chart components in `client/src/lib/components/charts/` (grouped/stacked bars, line with crosshair, donut, ranked h-bars), each with hover tooltips, a legend, and a table view on the two month charts. Palette lives in `client/src/lib/charts.js` — a validated two-mode categorical set with fixed slot order, the diverging poles for income/expenses, and neutral for "Other". The unconverted count surfaces as a banner linking to the rate card.
- `BEXT_API_URL` overrides the Vite dev proxy target, so the dev client can be pointed at a scratch backend.

### Home dashboard — DONE (not in the original phasing)
- Replaces the placeholder Home page: the most recent month with activity in three figures (income / expenses / net) plus the month-over-month spend change; a "needs your attention" list (uncategorized transactions, accounts without a CSV template, transactions no rate reaches) where each row carries the action that fixes it; last-six-months chart, top categories, recent uploads, latest transactions, quick actions.
- A user with no accounts gets a three-step getting-started card instead (account → CSV template → keywords).

### Phase 7.1 — OFX / QFX import — DONE

Some banks export OFX (Open Financial Exchange) instead of, or alongside, CSV. OFX is
*self-describing* — the file already names its own date, amount, currency and description
fields — so it needs **no column mapping**: no delimiter, no decimal separator, no date
format, no header row. That makes it the better import path wherever a bank offers it, and
the goal of this phase is to make it a first-class sibling of the CSV pipeline rather than a
second, parallel importer.

**Decisions (confirmed with the user):**

1. **Dedup: FITID first, standard key as fallback.** OFX carries a bank-assigned unique
   `FITID` per transaction. When present it becomes the row's `dedup_key` (prefixed `fitid:`
   so the two key spaces can never collide); when absent, the existing
   `date|description|amount_cents` key is used. Dedup stays **per account** and
   occurrence-counted exactly as today. Known trade-off: the *same* statement imported once
   as CSV and once as OFX will not dedup against itself — the two imports produce different
   key spaces. Documented in the upload UI ("this account's OFX imports dedup by the bank's
   own transaction id"), not solved in v1.
2. **Description = `NAME` + `MEMO`, joined by a space**, with `MEMO` dropped when it merely
   repeats `NAME` (case-insensitively, after trimming). Which fields are used is
   **configurable per account**, mirroring the CSV template's "merge description columns" —
   the selectable set is `NAME`, `MEMO`, `PAYEE.NAME`, `CHECKNUM`, `TRNTYPE`, and the order
   of selection is the join order.
3. **Scope: bank + credit card.** `STMTRS` (checking/savings) and `CCSTMTRS` (credit cards),
   which covers consumer exports including Quicken-flavoured `.qfx`. `INVSTMTRS`
   (investment) is **out of scope** — its buy/sell/units model does not map onto this app's
   single signed amount; such a file is rejected with an explicit message. Deferred, listed
   under "What is deferred".
4. **Account identity: warn, never block.** The first OFX imported into an account records
   its `BANKID`/`ACCTID`; a later file carrying a different pair shows a warning banner in
   the preview and imports anyway on confirm.

**Data model changes**

- `ofx_settings` — id, user_id, account_id (**unique**), description_fields (JSON, default
  `["NAME","MEMO"]`), bank_id (nullable), acct_id (nullable), created_at. A *separate* table
  from `csv_templates` on purpose: `csv_templates.account_id` is unique, and an account may
  legitimately receive both CSV and OFX files. An account with no row imports OFX on the
  defaults — **OFX import never requires setup**.
- `transactions.fitid` (nullable TEXT) — the raw bank id, kept for provenance and for
  future re-matching; the dedup key itself still lives in `dedup_key`.
- `uploads.format` (TEXT, default `'csv'`) — so the archive can label each import and the
  rollback warning stays accurate.

**Parsing (`server/src/upload/ofx/`)**

- `header.js` — read the OFX 1.x preamble (`OFXHEADER:100 … ENCODING:USASCII
  CHARSET:1252`) and decode the body accordingly via `iconv-lite` (reusing
  `parse.js`'s encoding normalization); OFX 2.x is XML with an `<?xml … encoding=?>`
  declaration, defaulting to UTF-8. A UTF-8 BOM is stripped either way.
- `tokenize.js` — one tolerant tag reader covering **both** dialects: OFX 1.x is SGML with
  *unclosed* leaf tags (`<TRNAMT>-12.34` with no `</TRNAMT>`), OFX 2.x is well-formed XML.
  A leaf's value is the text run up to the next `<`; an explicit close tag pops the stack.
  Produces a plain nested object tree, so both dialects converge on one shape.
- `statement.js` — walk the tree to the statement(s): `BANKMSGSRSV1 → STMTTRNRS → STMTRS`
  and `CREDITCARDMSGSRSV1 → CCSTMTTRNRS → CCSTMTRS`. Extracts `CURDEF`, the account block
  (`BANKACCTFROM`/`CCACCTFROM` → `BANKID`, `ACCTID`), and the `BANKTRANLIST → STMTTRN`
  list. Also surfaces `<CODE>` / `<SEVERITY>ERROR` from `STATUS` as a parse error rather
  than importing an empty statement. Multiple statements in one file are concatenated, with
  the account-mismatch check applied to each.
- `transform.js` — one `STMTTRN` → the same canonical shape `buildCanonical` returns:
  - `date` ← `DTPOSTED` (`YYYYMMDD[HHMMSS[.sss]][±h:TZ]`), **truncated to the date as
    written**; the bracketed timezone is parsed but not applied, so the date matches what
    the bank displays. `DTAVAIL`/`DTUSER` ignored.
  - `amountCents` ← `TRNAMT` × 100, rounded on the string to avoid float drift (reuse
    `amounts.js`'s parser with a `.` separator). OFX's sign convention is already
    **negative = outflow**, matching every CSV template.
  - `description` ← the configured fields, joined per decision 2; a transaction with no
    usable text is an `error` row ("Empty description"), consistent with CSV.
  - `currency` ← per-transaction `CURRENCY` else statement `CURDEF` else the account
    currency.
  - `foreignAmountCents` / `foreignCurrency` ← from `ORIGCURRENCY` + `CURRATE` when the
    bank sends them, so Phase 7's FX chain gets a per-row derived rate for free.
  - `fitid` ← `FITID`, trimmed; empty/missing falls back to the standard dedup key.
- `pipeline.js` — `buildOfxRows(buffer, settings, account)` returns **exactly** the
  `{ headers, rows }` shape `buildRows` already returns (`index`, `status`, `reason`,
  `canonical`, `dedupKey`, `occurrence`), plus a `meta` block (`bankId`, `acctId`,
  `curdef`, `statementCount`). Everything downstream — `annotate`, dedup-against-DB,
  classification, business-flag defaulting, the confirm insert, the archive, rollback — is
  reused unchanged. `headers` is the synthetic list of OFX fields actually seen, so the
  preview table renders with no client special-casing.

**Routes (`server/src/upload/routes.js`)**

- `detectFormat(buffer)` — sniff the decoded head: `OFXHEADER`, `<OFX>`, or an XML
  declaration followed by `<OFX>` ⇒ `ofx`; else `csv`. **Content-based, not extension-based**
  (`.qfx`, `.ofx` and mislabeled `.txt` all work). The client may pass a `format` hint; a
  hint that contradicts the content loses to the content.
- `POST /accounts/:id/upload/preview` and `/confirm` branch on the detected format: OFX skips
  the "configure a CSV template first" guard entirely and goes through `buildOfxRows`. The
  preview response gains `format` and, for OFX, `accountWarning` (the ACCTID-mismatch
  message) — both ignored by the CSV path.
- On confirm of an OFX file, `uploads.format='ofx'` is stored and `ofx_settings.bank_id` /
  `acct_id` are recorded when the account has none yet.
- `GET`/`PUT /accounts/:id/ofx-settings` — read/write `description_fields` (and clear the
  remembered account identity). Small, and optional to ever touch.

**Client**

- `UploadsPage.svelte`: the file input accepts `.csv,.ofx,.qfx,text/csv` and the picked
  file's format is shown as a badge; when it is OFX the "this account needs a CSV template"
  gate disappears and the template-editor link is replaced with a one-line "OFX needs no
  mapping" note. The ACCTID warning renders as a dismissible banner above the preview table;
  the preview table itself is unchanged.
- `TemplateEditor.svelte` gains a sibling `OfxSettingsCard.svelte` (description-field
  multi-select in join order + the remembered `BANKID`/`ACCTID` with a "forget" button),
  shown on the same account settings surface.
- Upload archive rows show a `CSV`/`OFX` chip from `uploads.format`.

**Tests (`server/test/upload-ofx.test.js`)**

- Fixtures under `server/test/fixtures/` (`samples/` stays for real bank exports):
  `card_v1.ofx` (SGML 1.0.2, unclosed tags, CHARSET:1252, a credit-card statement) and
  `bank_v2.ofx` (XML 2.x, bank statement, `ORIGCURRENCY` on one row). Hand-written from the
  spec — no real account data. The real Itaú OFX in `samples/` covers the end-to-end path.
- Both dialects parse to identical canonical rows (the tokenizer's whole point).
- `DTPOSTED` with time + timezone truncates to the written date; `TRNAMT` signs land as
  negative = outflow; cents are exact for `-0.01`, `-1234.56`, `1e3`-ish values.
- Re-upload of the same file → every row deduped **by FITID**; a file whose descriptions
  were reworded between exports still dedups (the FITID case the standard key would miss);
  a statement with no FITIDs falls back to `date|desc|amount` and dedups correctly.
- Two `STMTTRN` entries sharing a FITID inside one file → both imported (occurrence index),
  matching the CSV "two identical rows in one file" rule.
- Classification, business-flag default, hidden categories and rollback behave identically
  to a CSV import of the same rows.
- An `INVSTMTRS`-only file and a `STATUS/SEVERITY=ERROR` file each return a 400 with a
  clear message; a truncated/garbage file does not throw a 500.
- Isolation: user B cannot read or write user A's `ofx_settings`.

**Verification:** `server` `npm test`, then a dry run of the real Itaú OFX against a copy of
the dev database — preview, confirm, re-upload to see full dedup, roll the upload back from
the archive.

**As built**

- `server/src/upload/ofx/` — `header.js` (encoding sniff from either preamble + a content-based `looksLikeOfx`), `tokenize.js` (the one tolerant reader; the leaf/aggregate rule alone covers both dialects — a unit test asserts the two produce identical trees), `statement.js` (`STMTRS`/`CCSTMTRS` extraction, `INVSTMTRS` and `SEVERITY=ERROR` rejection), `transform.js` (canonical row, `parseOfxDate`, `parseOfxAmount`, `buildDescription`), `pipeline.js` (`buildOfxRows` + `accountMismatch`).
- `buildForUpload` in `upload/routes.js` picks the format from the buffer and hands both paths to the *same* `annotate` / confirm code; `uploads.format`, `transactions.fitid` and the `ofx_settings` identity are written on confirm. `GET`/`PUT /api/accounts/:id/ofx-settings` manage the description fields and a `forget: true` reset of the remembered account id. Migration `drizzle/0011_volatile_annihilus.sql`.
- Client: `OfxSettingsCard.svelte` (click-order field picker with a live description preview); `UploadsPage` sniffs the picked file's first bytes the same way the server does, so an OFX skips the template gate entirely, shows a CSV/OFX badge, renders the account-mismatch banner, and labels archive rows by format. The Home dashboard no longer flags an OFX-importing account as "no CSV template".
- `parseOfxAmount` also rescues a stray decimal comma (`-12,34`) that the spec forbids but some European exports emit.
- Tests: `server/test/upload-ofx.test.js` (14) over `server/test/fixtures/` — `card_v1.ofx` (SGML, CCSTMTRS, windows-1252, a repeated FITID, a FITID-less row, a description-less error row), `card_v1_reworded.ofx` (same FITIDs, reworded text — the case the standard key would miss), `bank_v2.ofx` (XML 2.x, `ORIGCURRENCY`, `CURRENCY`, `PAYEE`), `investment.ofx`, `error.ofx` — plus the real Itaú extract in `samples/` end to end.
- Dry run against a copy of the real dev DB: migration applied to the existing database, all 203 rows of the real Itaú OFX previewed → imported → classified by the existing keywords → re-upload showed 203 duplicates → archive labeled OFX → rollback clean.

### Settings danger zone — clear all transactions — DONE (not in the original phasing)

A way to empty a database of transaction data and start importing again from a clean slate,
without losing the setup (accounts, templates, categories, keywords) that is slow to rebuild.

**Decisions (confirmed with the user):**

1. **Per-user, own data only.** The action clears the *signed-in* user's data and nothing
   else — no cross-user reach, consistent with the isolation rule every other route follows.
2. **It lives on the Settings page, not the admin page.** Asked for as an admin button, but
   the "own data only" scope makes it a per-user action, and the real dev database's data
   belongs to a **non-admin** user (`andre`) while the `admin` account owns nothing — an
   admin-gated button would have been unusable for the person who wanted it. So the routes
   sit under `/api/settings` behind plain `requireAuth`.
3. **What goes:** transactions (split children follow via the self-FK cascade),
   `transaction_hashtags` links, the hashtag names themselves, and the `uploads` archive
   rows. The archive goes on purpose — keeping it would leave the Uploads page listing
   imports whose transactions no longer exist.
4. **What stays:** institutions, accounts, `csv_templates`, `ofx_settings` (including the
   remembered BANKID/ACCTID), categories, subcategories, keywords and `fx_rates`.

**Routes (`server/src/settings/routes.js`)**

- `GET /api/settings/clear-transactions` — a dry-run count: `{transactions, locked, split,
  uploads, hashtags}`. `locked` and `split` are the same warning surface an upload rollback
  shows, because manual categorizations and splits are the work re-importing does not recreate.
- `POST /api/settings/clear-transactions` — requires `{confirm: true}` in the body (400
  otherwise); deletes inside one `sqlite.transaction()` so the archive can never outlive the
  rows it imported, and returns the counts it removed. Idempotent on an empty database.
  Transactions are deleted explicitly rather than relying on the `uploads` cascade, since
  manual entries carry no `upload_id`.

**Client**

- `ClearTransactionsCard.svelte` under a "Danger zone" heading on `SettingsPage`. The
  confirm dialog fetches the live counts on open, warns in a destructive-tinted block when
  locked/split rows would be destroyed, spells out what is kept, and requires typing
  `DELETE` before the button enables. A user with nothing to clear gets a short message and
  no confirm button.

**Tests (`server/test/settings-clear.test.js`, 10)**

- Preview counts imported + split children + manual rows, and reports locked/split totals.
- The wipe empties transactions, uploads, hashtags and the join table; accounts,
  institutions, categories, keywords and FX rates all survive.
- A second user's rows and hashtags are untouched; a non-admin can clear their own data; an
  anonymous caller gets 401; missing confirmation is a 400 that deletes nothing; running it
  twice is a no-op.

**Verification:** `server` `npm test` (148), plus a run against a `.backup` copy of the real
dev database (a plain file copy would have missed a 4 MB WAL) — 1068 transactions and 3
uploads deleted, 6 accounts / 3 institutions / 33 categories / 136 subcategories / 745
keywords / 4 CSV templates / 1 ofx_settings intact, and the transactions, uploads and all
five report endpoints still 200 on the emptied database.

### Hashtag drag-and-drop + bulk tagging — DONE (not in the original phasing)

Tagging one transaction at a time through the edit dialog did not scale to clustering a
trip or a renovation, so the transactions page grew a hashtag palette and a row selection.

**Server (`server/src/transactions/routes.js`, `hashtagsRouter`)**

- `POST /api/hashtags` creates a tag on its own — the palette needs a tag to exist *before*
  it is attached to anything. Re-posting an existing name returns that tag rather than a
  duplicate (the `(user_id, name)` unique index).
- `DELETE /api/hashtags/:id` removes a tag and, through the join-table cascade, its links.
- `POST /api/hashtags/assign` / `unassign` take `{transactionIds, hashtagId | name}`.
  `assign` accepts a bare `name` and creates it on the fly, so dropping a brand-new tag is
  one round trip. Ids that are not the caller's are silently skipped (isolation), and
  already-linked rows are a no-op — the call is idempotent, which matters because a drop
  and a bulk click can overlap. Both return the affected rows' fresh hashtag lists so the
  client patches its rows without a full reload.

**Client**

- `HashtagPanel.svelte` — the right-hand palette: create, delete, click to filter, and
  `draggable` tag rows. While rows are selected each tag also gets a "+" to apply it.
- `TransactionsPage.svelte` — a checkbox per row (shift-click extends a range,
  "select all loaded" in the list header) plus a selection bar with a free-text
  "Tag selected" input backed by a datalist of existing names. A drop lands on the row
  under the pointer, or on the *whole selection* when that row is part of it — the gesture
  that tags many rows at once. Row hashtag chips gained an × to detach.
- Selections never survive a filter change (`load(true)` clears them), so a bulk action can
  only ever hit rows the user can see.
- The panel costs the list ~200px, so the per-row split/keyword actions moved up next to the
  amount — in the metadata row they wrapped onto a line of their own.

**Tests (`server/test/transactions.test.js`, +4)**

- Standalone create is idempotent by name; delete removes the tag and its links.
- Bulk assign tags many rows, reports `added`, is idempotent on a repeat, and `uses` counts
  follow; unassign detaches.
- Another user's ids are skipped rather than tagged; empty selections are 400 and an unknown
  tag name on unassign is 404.

**Verification:** `server` `npm test` (152), plus the real app in-browser — created a tag,
selected two rows, dropped the tag on one of them and saw both tagged and the palette count
follow, then deleted the test tag.

### Classification progress bar — DONE (not in the original phasing)

The transaction list said *how many* rows were uncategorized; it never said how much
**money** was still unaccounted for, which is the number that decides whether the
categorization work is nearly done.

**Server — `GET /api/reports/classification`**

- Runs `loadRows` (same rows, filters and FX chain as every other report) and sums
  `|amount|` per row, split by `categoryId IS NULL`. Absolute value on purpose: an income
  row costs the same effort to classify as an expense one.
- **The category selection is stripped from the filters** (`categoryIds`,
  `subcategoryIds`, `uncategorized`, and the legacy singulars). Asking "how much is left"
  while the list is filtered to *uncategorized only* would otherwise always answer 0%.
  Every other filter — account, period, holder, type, hashtag, business, hidden — still
  applies, so the bar tracks whatever slice is being worked on.
- Rows no rate can reach are **left out of the money totals and counted apart**
  (`unconvertedCount` / `unconvertedPending`), never converted at a guessed rate — the same
  rule the graphs follow. They still count in `totalCount`/`pendingCount`: the work exists
  even when its value cannot be stated in one currency.

**Client — `ClassificationProgress.svelte`**

- A bar under the income/expense summary: "X left to classify", the percentage of the
  filtered total, and the row counts. When rows are missing a rate, a subtle line under the
  bar says how many (and how many of those are still uncategorized) rather than letting the
  total quietly under-report.
- Refetched with every filtered load, and again right after an inline categorization so the
  bar moves as the work is done.

**Tests (`server/test/reports.test.js`, +3)** — value split by category over a private
month window; the category selection ignored while `type=expense` still narrows it; and an
unconvertible row counted apart, folding into the totals only once a rate is uploaded.

**Verification:** `server` `npm test` (155), plus the real dev database in-browser — 73% of
709,795.39 PLN with 465 rate-less rows flagged; picking 2024 *and* "uncategorized only"
still reported that year's real 66%, not 0%.

### Currency filter + sort order — DONE (not in the original phasing)

**Server (`server/src/transactions/routes.js`)**

- `?currencies=PLN,EUR` filters on the **transaction's** currency, not the account's — a
  Revolut account holds several, so filtering by account would have been the wrong knob.
  Codes are uppercased and anything that is not a 3-letter code is dropped, so a junk
  parameter narrows nothing rather than emptying the list.
- `/facets` gained `currencies: [{currency, count}]` (same filters as the rest of the
  facets), so the UI only offers codes that actually occur.
- `?sort=` — `date_desc` (default), `date_asc`, `description`. Description sorts
  `collate nocase`, which puts "Zabka" next to "ZABKA": the point is to see repeats of one
  merchant together while working through an uncategorized tail. Every order ends on `id`
  so paging can neither repeat nor skip a row. An unknown value falls back to `date_desc`.
- The progress bar picks the currency filter up for free (it shares `listConditions`), so
  it re-scopes to the selected currencies.

**Client**

- A currency chip row under the filter bar (shown only when more than one currency exists),
  multi-select with per-currency counts and an "All" reset, plus a sort `<select>`.
- The summary names a currency only when the rows can be in just one — a single selected
  currency, or a single account.
- `ClassificationProgress` gained a **count fallback**: filtering to a currency with no rate
  on file made every row unconvertible, so the money total was 0 and the bar read
  "0.00 PLN left to classify" while 130 rows were still uncategorized. It now switches to
  counting rows and says so under the bar.

**Tests (`server/test/transactions.test.js`, +5)** — currency facets with counts; filtering
on the transaction currency inside a mixed-currency account, multi-code and junk-code
handling; description sort across cases; both date directions and the unknown-sort fallback;
and a paged description sort that neither repeats nor skips.

**Verification:** `server` `npm test` (160), plus the real database in-browser — PLN 6583 /
EUR 465 chips, the EUR slice summarised in EUR with its Airbnb rows adjacent under
Description A–Z, and the progress bar switching to its count basis for the rate-less EUR
slice.

### Transactions per page — DONE (not in the original phasing)

The list loaded 100 rows at a time, which is a lot of "Load more" against a 7,000-row
database. The page size is now **500 by default and a per-user setting**.

- `users.transactions_page_size`, default 500 (migration `0012`), so existing users get the
  new default too — the column default applies to the `ALTER TABLE`. It is *not* part of the
  admin app-defaults singleton: nothing about it needs to be seeded per user.
- Exposed on `/api/settings` and `/api/auth/me` (so the page has it at first paint, with no
  extra request). **No upper bound**: `0` means "load every matching transaction at once",
  which the settings page offers as *All transactions* behind a warning. Only a floor is
  enforced (10), so a typo cannot turn the list into a one-row-per-request pager.
- The list endpoint's old `MAX_LIMIT = 500` clamp is gone. `?limit=all` (or `0`) skips
  `.limit()/.offset()` entirely; an unparseable limit falls back to the 100-row default
  rather than loading everything by accident.
- The transactions page derives its limit (and its "Load more" step) from
  `auth.user.transactionsPageSize`; the Settings page offers 50 / 100 / 200 / 500 / 1,000 /
  2,000 / All. From 1,000 up, an amber note says what it costs — the list renders every row
  it holds, so the whole 7,048-row database takes ten seconds or more *per filter change*.

**Tests (`server/test/auth.test.js` +1, `transactions.test.js` +1, plus the login shape)** —
the 500 default, a round-trip through `/api/settings` and `/api/auth/me`, 5,000 and 0
accepted while 5 / -100 / 50.5 are rejected without changing the stored value; and
`limit=all` / `limit=0` returning every row while a junk limit falls back to the default.

**Verification:** `server` `npm test` (162), plus the real database in-browser — the
migration applied on boot, the list loaded 500 rows, switching to 100 gave 100-row pages and
"Load more" steps, and *All transactions* loaded all 7,048 with no "Load more" button (and
visibly slowly, which is what the warning promises).

### Phase 8 — Cash LIFO pool
- Virtual cash spend entry; LIFO matching against `is_cash_withdrawal` transactions per currency (most-recent withdrawal on/before spend date; split across earlier withdrawals; may go negative). Net-withdrawn reporting with drill-down into matched spends.

## Edge cases explicitly handled

- Alior criteria line before header (skip_rows); Windows-1250 decode; comma decimals; pre-signed amounts.
- Itaú noise rows (`SALDO FINAL`, auto-investment) handled via row filters + hidden `Transfer In/Out`.
- Multi-currency within one account (Revolut currency column) — stored per-transaction; per-currency until FX phase.
- Re-upload of an identical file → all rows deduped; two identical rows in one file → both kept (occurrence_index).
- OFX (Phase 7.1): both SGML 1.x (unclosed tags, CHARSET:1252) and XML 2.x dialects; `DTPOSTED` with time+timezone truncated to the written date; dedup by `FITID` when the bank sends one; an OFX and a CSV export of the *same* statement do **not** dedup against each other (different key spaces).
- Locked manual categorizations survive every recompute; deleting a keyword reverts its matched (non-locked) txns to NULL unless another keyword matches.

## Verification

- **Per phase:** Vitest unit tests + run `server` `npm run dev` and `client` `npm run dev`, exercise the flow in-browser.
- **Engine (Phase 4):** unit tests for diacritics/fuzzy (`żabka`≈`zapka` at d≤1), the <5-char exact-match guard (`zus`≉`bus`), longest-keyword tie-break, lock preservation, delete-revert, determinism (run twice = identical).
- **OFX (Phase 7.1):** unit tests for the two dialects, encoding sniffing, `DTPOSTED` truncation, signs/cents, description merging; integration tests importing the real Itaú OFX and the synthetic fixtures end to end (FITID dedup, rewording, mismatch warning, rejection paths, isolation).
- **Upload (Phase 5):** integration tests importing each real sample (`Alior.csv`, `Revolut_sample.csv`, `itau_combined.csv`) end-to-end — assert row counts, filters, dedup on re-upload, correct signed cents, date parsing.
- **Clear all transactions (danger zone):** unit/integration tests for the dry-run counts, the confirmation guard, what survives the wipe, cross-user isolation and idempotency; plus a run against a `.backup` copy of the real dev database to confirm the counts and the survivors on real data.
- **Isolation:** test that user B cannot read/mutate user A's entities on every resource.
