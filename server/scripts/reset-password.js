// CLI password reset — the only password-recovery path (no email flow).
// Usage: node scripts/reset-password.js <username> <new-password>
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/password.js';

const [, , username, newPassword] = process.argv;

if (!username || !newPassword) {
  console.error('Usage: node scripts/reset-password.js <username> <new-password>');
  process.exit(1);
}
if (newPassword.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

runMigrations();

const row = db.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
if (!row) {
  console.error(`No user named "${username}".`);
  process.exit(1);
}

const passwordHash = await hashPassword(newPassword);
db.update(users).set({ passwordHash }).where(eq(users.id, row.id)).run();

console.log(`Password reset for "${username}".`);
