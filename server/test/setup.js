// Runs before each test file's modules are imported. Points the DB at an
// in-memory SQLite instance and applies migrations so tests never touch the
// real data/bext.db and stay isolated per file.
process.env.BEXT_DB_PATH = ':memory:';
process.env.BEXT_SESSION_SECRET = 'test-secret';
// Destructive routes snapshot the database before they run. Send those files to
// a temp folder: a test must never write into (or prune) the real backups.
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
process.env.BEXT_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'bext-test-backups-'));

const { runMigrations } = await import('../src/db/index.js');
runMigrations();

// Seed the app-settings singleton and the default admin so admin-managed flows
// are testable exactly as they run in production.
const { seedDefaults } = await import('../src/db/seed.js');
await seedDefaults();
