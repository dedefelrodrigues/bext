import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import BetterSqlite3StoreFactory from 'better-sqlite3-session-store';
import { sqlite } from './db/index.js';
import { authRouter } from './auth/routes.js';
import { settingsRouter } from './settings/routes.js';
import { adminRouter } from './admin/routes.js';
import { institutionsRouter } from './institutions/routes.js';
import { accountsRouter } from './accounts/routes.js';
import { categoriesRouter, subcategoriesRouter } from './categories/routes.js';
import { keywordsRouter } from './keywords/routes.js';
import { uploadRouter } from './upload/routes.js';
import { transactionsRouter, hashtagsRouter } from './transactions/routes.js';
import { fxRouter } from './fx/routes.js';
import { reportsRouter } from './reports/routes.js';
import { aiRouter } from './ai/routes.js';
import { budgetRouter } from './budget/routes.js';
import { healthRouter } from './health/routes.js';
import { transfersRouter } from './transfers/routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = resolve(__dirname, '../../client/dist');

const SqliteStore = BetterSqlite3StoreFactory(session);

// Builds the Express app. Kept separate from the server bootstrap so tests can
// import the app without binding a port.
export function createApp() {
  const app = express();
  // Uploaded CSVs ride in as base64 JSON, so allow a larger body than the default.
  app.use(express.json({ limit: '16mb' }));

  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) app.set('trust proxy', 1);

  app.use(
    session({
      name: 'bext.sid',
      store: new SqliteStore({
        client: sqlite,
        expired: { clear: true, intervalMs: 15 * 60 * 1000 },
      }),
      secret: process.env.BEXT_SESSION_SECRET ?? 'dev-insecure-secret-change-me',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'bext-server' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/institutions', institutionsRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/subcategories', subcategoriesRouter);
  app.use('/api/keywords', keywordsRouter);
  app.use('/api', uploadRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/hashtags', hashtagsRouter);
  app.use('/api/fx', fxRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/budget', budgetRouter);
  app.use('/api/data-health', healthRouter);
  app.use('/api/transfers', transfersRouter);

  // In production the server serves the built client (one process on :3001).
  if (existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(resolve(CLIENT_DIST, 'index.html'));
    });
  }

  return app;
}
