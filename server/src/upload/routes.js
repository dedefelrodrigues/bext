import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, categories, subcategories, keywords, users, csvTemplates, ofxSettings, uploads, transactions } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { snapshotQuietly } from '../db/backup.js';
import { prepareKeywords, classifyDescription } from '../engine/classify.js';
import { buildRows } from './pipeline.js';
import { parseCsv } from './parse.js';
import { buildOfxRows, accountMismatch, OfxError } from './ofx/pipeline.js';
import { looksLikeOfx } from './ofx/header.js';
import { DESCRIPTION_FIELDS, DEFAULT_DESCRIPTION_FIELDS } from './ofx/transform.js';

const DECIMALS = new Set(['.', ',']);
const MAX_FILE_BYTES = 12 * 1024 * 1024;

export const uploadRouter = Router();
uploadRouter.use(requireAuth);

function ownedAccount(accountId, userId) {
  return db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .get();
}

function getTemplate(accountId) {
  return db.select().from(csvTemplates).where(eq(csvTemplates.accountId, accountId)).get();
}

function getOfxSettings(accountId) {
  return db.select().from(ofxSettings).where(eq(ofxSettings.accountId, accountId)).get();
}

function publicOfxSettings(s, accountId) {
  // OFX needs no setup, so an account without a row still gets the defaults —
  // the client can render the card either way.
  return {
    accountId,
    descriptionFields: s?.descriptionFields?.length ? s.descriptionFields : DEFAULT_DESCRIPTION_FIELDS,
    bankId: s?.bankId ?? null,
    acctId: s?.acctId ?? null,
    available: DESCRIPTION_FIELDS,
  };
}

function publicTemplate(t) {
  if (!t) return null;
  return {
    id: t.id,
    accountId: t.accountId,
    delimiter: t.delimiter,
    decimalSeparator: t.decimalSeparator,
    encoding: t.encoding,
    headerRow: t.headerRow,
    dateFormat: t.dateFormat,
    dateColumn: t.dateColumn,
    descriptionColumns: t.descriptionColumns ?? [],
    amountColumns: t.amountColumns ?? [],
    currencyColumn: t.currencyColumn,
    foreignAmountColumn: t.foreignAmountColumn,
    foreignCurrencyColumn: t.foreignCurrencyColumn,
    filters: t.filters ?? [],
  };
}

// Validate/normalize a template body into a column patch. Returns { value } or { error }.
function parseTemplate(body) {
  const strArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  const nullableStr = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

  if (!DECIMALS.has(String(body?.decimalSeparator))) return { error: 'Decimal separator must be "." or ",".' };
  const delimiter = String(body?.delimiter ?? ',');
  if (!delimiter || delimiter.length > 4) return { error: 'Delimiter is required.' };
  const headerRow = Number(body?.headerRow);
  if (!Number.isInteger(headerRow) || headerRow < 0) return { error: 'Header row must be a non-negative integer.' };
  const dateColumn = String(body?.dateColumn ?? '').trim();
  if (!dateColumn) return { error: 'Choose the date column.' };
  const dateFormat = String(body?.dateFormat ?? '').trim();
  if (!dateFormat) return { error: 'Date format is required.' };
  const descriptionColumns = strArray(body?.descriptionColumns);
  if (descriptionColumns.length === 0) return { error: 'Choose at least one description column.' };
  const amountColumns = strArray(body?.amountColumns);
  if (amountColumns.length === 0) return { error: 'Choose at least one amount column.' };

  const filters = Array.isArray(body?.filters)
    ? body.filters
        .filter((f) => f && typeof f.column === 'string' && f.column.trim())
        .map((f) => ({
          column: f.column.trim(),
          op: String(f.op),
          value: String(f.value ?? ''),
          // Missing mode = include (preserves pre-mode templates on re-save).
          mode: f.mode === 'exclude' ? 'exclude' : 'include',
        }))
    : [];

  return {
    value: {
      delimiter,
      decimalSeparator: String(body.decimalSeparator),
      encoding: String(body?.encoding ?? 'utf-8').trim() || 'utf-8',
      headerRow,
      dateFormat,
      dateColumn,
      descriptionColumns,
      amountColumns,
      currencyColumn: nullableStr(body?.currencyColumn),
      foreignAmountColumn: nullableStr(body?.foreignAmountColumn),
      foreignCurrencyColumn: nullableStr(body?.foreignCurrencyColumn),
      filters,
    },
  };
}

// --- Template CRUD (one per account) ---

// All of the user's templates (used by the Accounts page to show which accounts
// already have one and to deep-link into the upload flow).
uploadRouter.get('/templates', (req, res) => {
  const rows = db.select().from(csvTemplates).where(eq(csvTemplates.userId, req.userId)).all();
  res.json(rows.map(publicTemplate));
});

uploadRouter.get('/accounts/:accountId/template', (req, res) => {
  const account = ownedAccount(Number(req.params.accountId), req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  res.json(publicTemplate(getTemplate(account.id)));
});

uploadRouter.put('/accounts/:accountId/template', (req, res) => {
  const account = ownedAccount(Number(req.params.accountId), req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  const parsed = parseTemplate(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const existing = getTemplate(account.id);
  const saved = existing
    ? db.update(csvTemplates).set(parsed.value).where(eq(csvTemplates.id, existing.id)).returning().get()
    : db.insert(csvTemplates).values({ userId: req.userId, accountId: account.id, ...parsed.value }).returning().get();
  res.json(publicTemplate(saved));
});

// Copy another owned account's template onto this account.
uploadRouter.post('/accounts/:accountId/template/copy', (req, res) => {
  const account = ownedAccount(Number(req.params.accountId), req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const from = ownedAccount(Number(req.body?.fromAccountId), req.userId);
  if (!from) return res.status(404).json({ error: 'Source account not found.' });
  const source = getTemplate(from.id);
  if (!source) return res.status(400).json({ error: 'That account has no template to copy.' });

  const value = publicTemplate(source);
  delete value.id;
  delete value.accountId;

  const existing = getTemplate(account.id);
  const saved = existing
    ? db.update(csvTemplates).set(value).where(eq(csvTemplates.id, existing.id)).returning().get()
    : db.insert(csvTemplates).values({ userId: req.userId, accountId: account.id, ...value }).returning().get();
  res.json(publicTemplate(saved));
});

// --- OFX settings (optional, one per account) ---

uploadRouter.get('/accounts/:accountId/ofx-settings', (req, res) => {
  const account = ownedAccount(Number(req.params.accountId), req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  res.json(publicOfxSettings(getOfxSettings(account.id), account.id));
});

uploadRouter.put('/accounts/:accountId/ofx-settings', (req, res) => {
  const account = ownedAccount(Number(req.params.accountId), req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  const fields = Array.isArray(req.body?.descriptionFields)
    ? req.body.descriptionFields.map((f) => String(f).trim().toUpperCase()).filter((f) => DESCRIPTION_FIELDS.includes(f))
    : [];
  if (fields.length === 0) return res.status(400).json({ error: 'Choose at least one description field.' });
  const unique = [...new Set(fields)];
  // `forget: true` clears the remembered bank/account identity so the next
  // import re-learns it instead of warning forever.
  const identity = req.body?.forget === true ? { bankId: null, acctId: null } : {};

  const existing = getOfxSettings(account.id);
  const saved = existing
    ? db.update(ofxSettings).set({ descriptionFields: unique, ...identity }).where(eq(ofxSettings.id, existing.id)).returning().get()
    : db.insert(ofxSettings).values({ userId: req.userId, accountId: account.id, descriptionFields: unique }).returning().get();
  res.json(publicOfxSettings(saved, account.id));
});

// Detect a file's column headers (and a few sample rows) so the template editor
// can offer real column dropdowns. Only the low-level parsing settings matter
// here, so a full template isn't required.
uploadRouter.post('/accounts/:accountId/template/detect', (req, res) => {
  const account = ownedAccount(Number(req.params.accountId), req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const decoded = decodeUploadBody(req.body);
  if (decoded.error) return res.status(400).json({ error: decoded.error });

  const settings = {
    encoding: String(req.body?.encoding ?? 'utf-8'),
    delimiter: String(req.body?.delimiter ?? ','),
    headerRow: Number(req.body?.headerRow) || 0,
  };
  try {
    const { headers, rows } = parseCsv(decoded.buffer, settings);
    res.json({ headers, sampleRows: rows.slice(0, 5) });
  } catch (err) {
    res.status(400).json({ error: `Could not read the file: ${err.message}` });
  }
});

// --- Upload preview / confirm ---

// Shared classification + name-resolution context for a user.
function classificationContext(userId) {
  const user = db.select({ d: users.globalFuzzyDistance }).from(users).where(eq(users.id, userId)).get();
  const kws = db
    .select({ id: keywords.id, categoryId: keywords.categoryId, subcategoryId: keywords.subcategoryId, text: keywords.text, distance: keywords.distance })
    .from(keywords)
    .where(eq(keywords.userId, userId))
    .all();
  const cats = db.select().from(categories).where(eq(categories.userId, userId)).all();
  const subs = db.select().from(subcategories).where(eq(subcategories.userId, userId)).all();
  return {
    prepared: prepareKeywords(kws, user?.d ?? 0),
    catById: new Map(cats.map((c) => [c.id, c])),
    subById: new Map(subs.map((s) => [s.id, s])),
  };
}

// Count existing transactions per dedup key for an account (dedup is per account).
function existingDedupCounts(accountId) {
  const rows = db
    .select({ k: transactions.dedupKey, n: sql`count(*)` })
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .groupBy(transactions.dedupKey)
    .all();
  return new Map(rows.map((r) => [r.k, Number(r.n)]));
}

// Decode the { filename, contentBase64 } body into a Buffer, or return { error }.
function decodeUploadBody(body) {
  if (typeof body?.contentBase64 !== 'string' || !body.contentBase64) return { error: 'No file content provided.' };
  let buffer;
  try {
    buffer = Buffer.from(body.contentBase64, 'base64');
  } catch {
    return { error: 'File content is not valid base64.' };
  }
  if (buffer.length === 0) return { error: 'The file is empty.' };
  if (buffer.length > MAX_FILE_BYTES) return { error: 'File is too large (max 12 MB).' };
  return { buffer, filename: String(body?.filename ?? 'upload.csv').slice(0, 255) };
}

// Annotate pipeline rows with dedup-against-DB status and the proposed category.
// Returns { rows, summary }.
function annotate(pipelineRows, existing, ctx) {
  const counts = new Map(existing); // consume as we walk to mark later occurrences new
  let filtered = 0;
  let errored = 0;
  let duplicates = 0;
  let toImport = 0;

  const rows = pipelineRows.map((r) => {
    if (r.status === 'filtered') {
      filtered++;
      return { index: r.index, status: 'filtered', reason: r.reason };
    }
    if (r.status === 'error') {
      errored++;
      return { index: r.index, status: 'error', reason: r.reason };
    }
    const existingCount = counts.get(r.dedupKey) ?? 0;
    const duplicate = r.occurrence < existingCount;
    if (duplicate) duplicates++;
    else toImport++;

    const match = classifyDescription(r.canonical.description, ctx.prepared);
    const cat = match ? ctx.catById.get(match.categoryId) : null;
    const sub = match && match.subcategoryId ? ctx.subById.get(match.subcategoryId) : null;

    return {
      index: r.index,
      status: 'ok',
      duplicate,
      ...r.canonical,
      category: cat ? { id: cat.id, name: cat.name, icon: cat.icon } : null,
      subcategory: sub ? { id: sub.id, name: sub.name, icon: sub.icon } : null,
    };
  });

  return {
    rows,
    summary: { total: pipelineRows.length, toImport, duplicates, filtered, errors: errored },
  };
}

// Build the pipeline rows for a file in whichever format it actually is.
// Format is decided by *content*, not by the file extension, so `.ofx`, `.qfx`
// and a mislabeled `.txt` all import correctly. Returns { format, built,
// warning } or { error, status }.
function buildForUpload(buffer, account) {
  if (looksLikeOfx(buffer)) {
    const settings = getOfxSettings(account.id);
    let built;
    try {
      built = buildOfxRows(buffer, settings, account);
    } catch (err) {
      if (err instanceof OfxError) return { error: err.message, status: 400 };
      return { error: `Could not parse the OFX file: ${err.message}`, status: 400 };
    }
    return { format: 'ofx', built, settings, warning: accountMismatch(built.meta, settings) };
  }

  const template = getTemplate(account.id);
  if (!template) return { error: 'Configure a CSV template for this account first.', status: 400 };
  try {
    return { format: 'csv', built: buildRows(buffer, template, account) };
  } catch (err) {
    return { error: `Could not parse the file: ${err.message}`, status: 400 };
  }
}

uploadRouter.post('/accounts/:accountId/upload/preview', (req, res) => {
  const account = ownedAccount(Number(req.params.accountId), req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  const decoded = decodeUploadBody(req.body);
  if (decoded.error) return res.status(400).json({ error: decoded.error });

  const prepared = buildForUpload(decoded.buffer, account);
  if (prepared.error) return res.status(prepared.status).json({ error: prepared.error });

  const ctx = classificationContext(req.userId);
  const { rows, summary } = annotate(prepared.built.rows, existingDedupCounts(account.id), ctx);
  res.json({
    filename: decoded.filename,
    format: prepared.format,
    headers: prepared.built.headers,
    accountWarning: prepared.warning ?? null,
    meta: prepared.built.meta ?? null,
    rows,
    summary,
  });
});

uploadRouter.post('/accounts/:accountId/upload/confirm', (req, res) => {
  const account = ownedAccount(Number(req.params.accountId), req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  // An import is where a template mistake shows up — snapshot the state you
  // could otherwise only get back by deleting the upload again.
  snapshotQuietly('before-upload');

  const decoded = decodeUploadBody(req.body);
  if (decoded.error) return res.status(400).json({ error: decoded.error });
  const excluded = new Set(Array.isArray(req.body?.excluded) ? req.body.excluded.map(Number) : []);

  const prepared = buildForUpload(decoded.buffer, account);
  if (prepared.error) return res.status(prepared.status).json({ error: prepared.error });
  const built = prepared.built;

  const ctx = classificationContext(req.userId);
  const counts = existingDedupCounts(account.id);

  // Select the rows that will actually be inserted (ok, not a duplicate, not
  // excluded by the user), classifying and defaulting the business flag now.
  const toInsert = [];
  for (const r of built.rows) {
    if (r.status !== 'ok' || excluded.has(r.index)) continue;
    if (r.occurrence < (counts.get(r.dedupKey) ?? 0)) continue; // duplicate
    const match = classifyDescription(r.canonical.description, ctx.prepared);
    const cat = match ? ctx.catById.get(match.categoryId) : null;
    toInsert.push({
      ...r.canonical,
      dedupKey: r.dedupKey,
      occurrence: r.occurrence,
      categoryId: match ? match.categoryId : null,
      subcategoryId: match ? match.subcategoryId : null,
      matchedKeywordId: match ? match.id : null,
      businessFlag: cat ? cat.businessDefault : 'personal',
    });
  }

  const result = db.transaction(() => {
    const upload = db
      .insert(uploads)
      .values({ userId: req.userId, accountId: account.id, filename: decoded.filename, format: prepared.format, totalRows: built.rows.length, importedCount: toInsert.length })
      .returning()
      .get();

    for (const row of toInsert) {
      db.insert(transactions)
        .values({
          userId: req.userId,
          accountId: account.id,
          uploadId: upload.id,
          date: row.date,
          description: row.description,
          amountCents: row.amountCents,
          currency: row.currency,
          foreignAmountCents: row.foreignAmountCents,
          foreignCurrency: row.foreignCurrency,
          categoryId: row.categoryId,
          subcategoryId: row.subcategoryId,
          matchedKeywordId: row.matchedKeywordId,
          businessFlag: row.businessFlag,
          isManual: false,
          isLocked: false,
          dedupKey: row.dedupKey,
          fitid: row.fitid ?? null,
          occurrenceIndex: row.occurrence,
        })
        .run();
    }

    // Learn this account's OFX identity from the first file imported into it,
    // so a later file from a different account can be flagged in the preview.
    if (prepared.format === 'ofx' && built.meta?.acctId && !prepared.settings?.acctId) {
      const identity = { bankId: built.meta.bankId, acctId: built.meta.acctId };
      if (prepared.settings) {
        db.update(ofxSettings).set(identity).where(eq(ofxSettings.id, prepared.settings.id)).run();
      } else {
        db.insert(ofxSettings).values({ userId: req.userId, accountId: account.id, ...identity }).run();
      }
    }
    return upload;
  });

  res.status(201).json({ uploadId: result.id, imported: toInsert.length, format: prepared.format });
});

// --- Upload archive + rollback ---

uploadRouter.get('/uploads', (req, res) => {
  const rows = db
    .select({
      id: uploads.id,
      filename: uploads.filename,
      format: uploads.format,
      uploadedAt: uploads.uploadedAt,
      totalRows: uploads.totalRows,
      importedCount: uploads.importedCount,
      accountId: uploads.accountId,
      accountName: accounts.name,
    })
    .from(uploads)
    .innerJoin(accounts, eq(uploads.accountId, accounts.id))
    .where(eq(uploads.userId, req.userId))
    .orderBy(sql`${uploads.uploadedAt} desc`, sql`${uploads.id} desc`)
    .all();

  // Live per-upload transaction stats (current count, locked, split) for the
  // rollback warning — computed from a single scan of the user's transactions.
  const txns = db
    .select({ id: transactions.id, uploadId: transactions.uploadId, isLocked: transactions.isLocked, parentId: transactions.parentId })
    .from(transactions)
    .where(eq(transactions.userId, req.userId))
    .all();
  const parentIds = new Set(txns.map((t) => t.parentId).filter((p) => p != null));
  const stats = new Map();
  for (const t of txns) {
    if (t.uploadId == null) continue;
    let s = stats.get(t.uploadId);
    if (!s) stats.set(t.uploadId, (s = { current: 0, locked: 0, split: 0 }));
    s.current++;
    if (t.isLocked) s.locked++;
    if (t.parentId != null || parentIds.has(t.id)) s.split++;
  }

  res.json(
    rows.map((u) => ({
      ...u,
      currentCount: stats.get(u.id)?.current ?? 0,
      lockedCount: stats.get(u.id)?.locked ?? 0,
      splitCount: stats.get(u.id)?.split ?? 0,
    })),
  );
});

uploadRouter.delete('/uploads/:id', (req, res) => {
  const upload = db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, Number(req.params.id)), eq(uploads.userId, req.userId)))
    .get();
  if (!upload) return res.status(404).json({ error: 'Upload not found.' });

  // FK cascade removes the imported transactions (and any split children).
  snapshotQuietly('before-rollback');
  db.delete(uploads).where(eq(uploads.id, upload.id)).run();
  res.status(204).end();
});
