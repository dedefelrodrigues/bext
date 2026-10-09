// CLI restore — `npm run db:restore <snapshot.db>`.
//
// A restore is itself destructive, so it says what it is about to install
// (row counts, not just a filename), snapshots the database it is replacing,
// and refuses to run while the server still holds the file — restoring under a
// live process leaves the two disagreeing about the WAL.
import { existsSync, copyFileSync, unlinkSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import Database from 'better-sqlite3';
import { DB_PATH } from '../src/db/index.js';
import { snapshot } from '../src/db/backup.js';

const [, , file] = process.argv;
if (!file) {
  console.error('Usage: node scripts/restore.js <backup-file.db>');
  process.exit(1);
}
const src = resolve(file);
if (!existsSync(src)) {
  console.error(`No such file: ${src}`);
  process.exit(1);
}

// --- What is in the snapshot? ---
const probe = new Database(src, { readonly: true });
const integrity = probe.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') {
  console.error(`This file fails SQLite's integrity check (${integrity}) — not restoring it.`);
  process.exit(1);
}
const counts = ['users', 'institutions', 'accounts', 'transactions', 'uploads', 'categories', 'keywords', 'fx_rates']
  .map((t) => {
    try {
      return `${t}: ${probe.prepare(`select count(*) n from ${t}`).get().n}`;
    } catch {
      return `${t}: (missing)`;
    }
  });
probe.close();

console.log(`About to restore ${src}`);
console.log(`  ${counts.join('\n  ')}`);
console.log(`Onto ${DB_PATH}`);

// A stale -wal beside the target means a server still has it open (or crashed
// with it open); either way the copy would be silently wrong.
if (existsSync(`${DB_PATH}-wal`)) {
  console.error('\nA -wal file is beside the database — stop the server first, then run this again.');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('\nType "restore" to continue: ');
rl.close();
if (answer.trim() !== 'restore') {
  console.log('Nothing changed.');
  process.exit(0);
}

// Keep what we are about to overwrite — a restore onto the wrong database is
// exactly the mistake this whole feature exists to survive.
if (existsSync(DB_PATH)) {
  const kept = snapshot('pre-restore');
  console.log(`Current database kept as ${kept}`);
}

copyFileSync(src, `${DB_PATH}.incoming`);
renameSync(`${DB_PATH}.incoming`, DB_PATH);
for (const stray of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(stray)) unlinkSync(stray);

console.log('Restored. Start the server.');
