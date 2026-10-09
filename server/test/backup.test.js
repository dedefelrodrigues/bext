import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startTestClient, loginAsAdmin, createUser } from './helpers.js';
import { db } from '../src/db/index.js';
import { institutions, accounts, transactions } from '../src/db/schema.js';

// Snapshots go to a temp folder, never the project's own data/backups — the
// env var is read per call, so setting it here is enough even though loading
// the app has already pulled the backup module in.
const dir = mkdtempSync(join(tmpdir(), 'bext-backups-'));
process.env.BEXT_BACKUP_DIR = dir;
const { snapshot, listBackups, prune, KEEP } = await import('../src/db/backup.js');

let alice;
let aliceId;
let accountId;

beforeAll(async () => {
  const admin = await startTestClient();
  await loginAsAdmin(admin);
  aliceId = (await createUser(admin, 'backupuser', 'password1')).id;
  admin.close();

  alice = await startTestClient();
  await alice.post('/api/auth/login', { username: 'backupuser', password: 'password1' });

  const inst = db.insert(institutions).values({ userId: aliceId, name: 'Bank' }).returning().get();
  accountId = db
    .insert(accounts)
    .values({ userId: aliceId, institutionId: inst.id, name: 'Checking', currency: 'PLN', holder: 'andre' })
    .returning()
    .get().id;
  db.insert(transactions)
    .values({
      userId: aliceId,
      accountId,
      date: '2026-01-01',
      description: 'BACKUP ME',
      amountCents: -1234,
      currency: 'PLN',
      dedupKey: 'backup|1',
    })
    .run();
});

afterAll(() => {
  alice.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('snapshots', () => {
  test('a snapshot is a complete, openable database — not a copy of a stale file', () => {
    const file = snapshot('manual');
    expect(existsSync(file)).toBe(true);

    // The point of VACUUM INTO: what is in memory is in the file, with no WAL
    // beside it to carry along.
    expect(existsSync(`${file}-wal`)).toBe(false);
    const copy = new Database(file, { readonly: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(copy.prepare('select count(*) n from transactions').get().n).toBe(1);
    expect(copy.prepare('select description from transactions').get().description).toBe('BACKUP ME');
    copy.close();
  });

  test('the label lands in the filename, and two in one second do not collide', () => {
    const a = snapshot('before-rollback');
    const b = snapshot('before-rollback');
    expect(a).toMatch(/bext-\d{8}-\d{6}-before-rollback(-\d+)?\.db$/);
    expect(b).not.toBe(a);
    expect(listBackups()[0].label).toBe('before-rollback');
  });

  test('a junk label cannot escape the folder', () => {
    const file = snapshot('../../etc/passwd');
    expect(file.startsWith(dir)).toBe(true);
    expect(file).toMatch(/-etc-passwd\.db$/);
  });

  test('only the newest KEEP survive', () => {
    for (let i = 0; i < KEEP + 3; i++) snapshot(`fill-${i}`);
    expect(readdirSync(dir).filter((f) => f.endsWith('.db')).length).toBe(KEEP);
    // Newest first, so the oldest are the ones that went.
    const names = listBackups().map((b) => b.name);
    expect(names).toEqual([...names].sort().reverse());
    expect(prune(KEEP)).toEqual([]);
  });
});

describe('the settings endpoints', () => {
  test('list and create, without ever handing the file over HTTP', async () => {
    const before = (await alice.get('/api/settings/backups')).body;
    expect(before.keep).toBe(KEEP);
    expect(before.dir).toBe(dir);

    const created = await alice.post('/api/settings/backups', {});
    expect(created.status).toBe(201);
    expect(created.body.created).toMatch(/-manual\.db$/);
    expect(created.body.backups[0].name).toBe(created.body.created);
    expect(created.body.backups.length).toBeLessThanOrEqual(KEEP);
    // A snapshot holds every user's data, so the API describes the files and
    // never carries them: names, sizes and reasons only, no bytes and not even
    // a path to fetch them from.
    expect(Object.keys(created.body.backups[0]).sort()).toEqual(['bytes', 'label', 'name', 'takenAt']);
  });

  test('the destructive operations snapshot first', async () => {
    const before = listBackups().length;
    const res = await alice.post('/api/settings/clear-transactions', { confirm: true });
    expect(res.status).toBe(200);

    const newest = listBackups()[0];
    expect(newest.label).toBe('before-clear');
    expect(before).toBeGreaterThan(0);

    // And the snapshot still holds the row the clear just destroyed.
    const copy = new Database(join(dir, newest.name), { readonly: true });
    expect(copy.prepare('select count(*) n from transactions').get().n).toBe(1);
    copy.close();
    expect(db.select().from(transactions).all()).toEqual([]);
  });
});
