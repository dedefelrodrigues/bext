import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlite, DB_PATH } from './index.js';

// Snapshots of the whole database file.
//
// `VACUUM INTO` is the only correct way to copy a live SQLite database: it
// writes a single self-contained file with the WAL already folded in. Copying
// `bext.db` on its own gives whatever was last checkpointed — which can be
// hours stale, and looks like a perfectly good database until you open it.
//
// A snapshot is taken on demand from the settings page, and automatically just
// before anything that destroys transactions (an import, a rollback, a clear,
// a deleted account or institution). Only the newest KEEP survive; a snapshot
// is roughly the size of the database, so the folder stays bounded.

export const KEEP = 5;

// Beside the database by default (`server/data/backups`), so a backup travels
// with the project. BEXT_BACKUP_DIR moves them somewhere a machine-level backup
// can reach, which is the one thing this cannot do for itself. Read per call
// rather than frozen at import time — the module is loaded as a side effect of
// loading the app, long before a test (or a script) gets to say where it wants
// its files.
export function backupDir() {
  if (process.env.BEXT_BACKUP_DIR) return resolve(process.env.BEXT_BACKUP_DIR);
  if (DB_PATH === ':memory:') return resolve(dirname(fileURLToPath(import.meta.url)), '../../data/backups');
  return join(dirname(DB_PATH), 'backups');
}

const LABEL_RE = /[^a-z0-9-]/g;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// The label is part of the filename because a backup is only useful if you can
// tell at a glance what it stands in front of ("before-rollback" vs "manual").
export function snapshot(label = 'manual') {
  const clean = String(label).toLowerCase().replace(LABEL_RE, '-').replace(/^-+|-+$/g, '') || 'manual';
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });

  let file = join(dir, `bext-${stamp()}-${clean}.db`);
  // Two snapshots inside one second (a rollback of several uploads, say) must
  // not overwrite each other.
  for (let n = 2; existsSync(file); n++) file = join(dir, `bext-${stamp()}-${clean}-${n}.db`);

  sqlite.prepare('VACUUM INTO ?').run(file);
  prune();
  return file;
}

// Never let a backup failure take down the operation it was protecting: a
// missing snapshot is worth a log line, not a failed import.
export function snapshotQuietly(label) {
  try {
    return snapshot(label);
  } catch (err) {
    console.error(`[backup] could not snapshot before ${label}:`, err.message);
    return null;
  }
}

export function listBackups() {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('bext-') && f.endsWith('.db'))
    .map((name) => {
      const s = statSync(join(dir, name));
      const m = name.match(/^bext-\d{8}-\d{6}-(.+)\.db$/);
      return {
        name,
        bytes: s.size,
        takenAt: s.mtime.toISOString(),
        mtimeMs: s.mtimeMs,
        label: m ? m[1].replace(/-\d+$/, '') : 'manual',
      };
    })
    // Newest first. Within one second the filenames sort by label rather than
    // by age, so the clock decides and the name is only the tiebreak.
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .map(({ mtimeMs, ...b }) => b);
}

export function prune(keep = KEEP) {
  const extra = listBackups().slice(keep);
  for (const b of extra) {
    try {
      unlinkSync(join(backupDir(), b.name));
    } catch (err) {
      console.error(`[backup] could not remove ${b.name}:`, err.message);
    }
  }
  return extra.map((b) => b.name);
}
