import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { runMigrations } from './db/index.js';
import { seedDefaults } from './db/seed.js';

// Secrets belong in the environment, and `server/.env` is where a single-machine
// install keeps them (gitignored; see .env.example). Loaded before anything
// reads process.env, and only when the file exists — the deployed case sets the
// variables itself and has no file. Real environment variables always win.
const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
if (existsSync(ENV_FILE)) {
  const before = { ...process.env };
  process.loadEnvFile(ENV_FILE);
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
}

const PORT = process.env.PORT ?? 3001;

runMigrations();
await seedDefaults();

const app = createApp();
app.listen(PORT, () => {
  console.log(`bext-server listening on http://localhost:${PORT}`);
});
