// CLI snapshot — `npm run db:backup [label]`.
// Same mechanism the app uses (VACUUM INTO), so a backup taken here and one
// taken from the settings page are the same kind of file.
import { snapshot, listBackups, KEEP, backupDir } from '../src/db/backup.js';

const label = process.argv[2] ?? 'manual';

try {
  const file = snapshot(label);
  console.log(`Backed up to ${file}`);
  const kept = listBackups();
  console.log(`${kept.length} of ${KEEP} kept in ${backupDir()}:`);
  for (const b of kept) console.log(`  ${b.name}  ${(b.bytes / 1024 / 1024).toFixed(1)} MB`);
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
}
