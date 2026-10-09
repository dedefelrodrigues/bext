import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DB_PATH } from '../db/index.js';

// Encryption for the per-user provider API keys.
//
// The keys are the user's own money: a plaintext column would be readable in
// every backup snapshot (and a snapshot holds every user's data), so they are
// sealed with AES-256-GCM before they ever reach the database.
//
// Where the encryption key comes from, in order:
//   1. BEXT_AI_KEY_SECRET — set this in production (server/.env is read on
//      boot). Rotating it makes every stored provider key undecryptable, which
//      surfaces as "re-enter your key" rather than as a crash.
//   2. A random 32-byte key generated once and kept beside the database file
//      (`.ai-key`, mode 0600, gitignored with the rest of data/). Zero setup for
//      a single-machine install; it travels with the database, so a restore of
//      the snapshot onto another machine needs the file too.
//   3. An in-process random key when the database is :memory: (tests).
//
// Either source may be a passphrase rather than 32 hex bytes: whatever is not
// exactly 64 hex characters is hashed to 32 bytes. This file is the one thing
// here a person is likely to open and edit by hand, and a hand-written value
// must not turn "save my API key" into a 500 — `Buffer.from(x, 'hex')` happily
// returns one byte for a word beginning "BE" and `createCipheriv` then throws.

const ALGORITHM = 'aes-256-gcm';

// A stored value → a 32-byte key. Accepts the generated form (64 hex chars) and
// anything else a person might have typed, including a `NAME=value` line copied
// from an env file and a quoted value.
function deriveKey(raw) {
  let value = String(raw).trim();
  const assignment = value.match(/^[A-Z0-9_]+=(.*)$/s);
  if (assignment) value = assignment[1].trim();
  value = value.replace(/^["']|["']$/g, '');
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  return createHash('sha256').update(value).digest();
}

function loadKey() {
  const fromEnv = process.env.BEXT_AI_KEY_SECRET;
  if (fromEnv) return deriveKey(fromEnv);
  if (DB_PATH === ':memory:') return randomBytes(32);

  const keyFile = resolve(dirname(DB_PATH), '.ai-key');
  if (existsSync(keyFile)) return deriveKey(readFileSync(keyFile, 'utf8'));

  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600); // an existing umask does not apply to the mode above on every platform
  } catch {
    /* best effort — the file is inside the gitignored data directory either way */
  }
  return key;
}

let cachedKey = null;
const key = () => (cachedKey ??= loadKey());

// iv:tag:ciphertext, all hex — self-describing enough to decrypt without a
// second column, and distinguishable from a plaintext key at a glance.
export function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

// Returns null rather than throwing when the stored value cannot be opened —
// a rotated BEXT_AI_KEY_SECRET is a "your saved key is unreadable, enter it
// again" message, not a 500 on a page that merely lists engines.
export function decryptSecret(stored) {
  try {
    const [ivHex, tagHex, dataHex] = String(stored).split(':');
    if (!ivHex || !tagHex || !dataHex) return null;
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// What the settings page shows instead of the key itself.
export function keyHint(plaintext) {
  const s = String(plaintext);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}
