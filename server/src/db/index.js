import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.BEXT_DB_PATH ?? resolve(__dirname, '../../data/bext.db');
const MIGRATIONS_DIR = resolve(__dirname, '../../drizzle');

// Ensure the data directory exists (DB file is gitignored and created on boot).
if (DB_PATH !== ':memory:') {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// Migrations auto-apply on boot. No-op when the folder has no migrations yet.
export function runMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return;
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

export { sqlite };
