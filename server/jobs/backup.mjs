import fs from 'node:fs';
import path from 'node:path';

// Copies of the database in <data>/backups: one a day (the newest 14 are kept) and one before each schema
// upgrade (the newest 5 are kept). VACUUM INTO writes a complete, consistent copy while the database is in use.
export const BACKUP_FOLDER = 'backups';
const DAILY = /^dayjob-(\d{4}-\d{2}-\d{2})\.sqlite$/;
const UPGRADE = /^dayjob-before-schema-\d+-\d{8}T\d{6}Z\.sqlite$/;

export function backupFile(db, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.part`;
  fs.rmSync(temporary, { force: true });
  db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
  fs.renameSync(temporary, file);
  return file;
}

export function backupBeforeUpgrade(db, directory, fromVersion, at = new Date()) {
  const dir = path.join(directory, BACKUP_FOLDER);
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = backupFile(db, path.join(dir, `dayjob-before-schema-${fromVersion}-${stamp}.sqlite`));
  prune(dir, UPGRADE, 5);
  return file;
}

const localDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// Makes today's copy if there is none yet. Checked at start and then every hour, so a Dayjob left open over
// midnight still gets the next day's copy.
export function createDailyBackups({ db, directory, now = () => new Date(), keep = 14, log = console.warn, everyMs = 60 * 60 * 1000 }) {
  const dir = path.join(directory, BACKUP_FOLDER);
  function runOnce() {
    const file = path.join(dir, `dayjob-${localDay(now())}.sqlite`);
    if (fs.existsSync(file)) return null;
    try {
      backupFile(db, file);
      prune(dir, DAILY, keep);
      return file;
    } catch (error) {
      log(`[dayjob] backup: ${error.message}`);
      return null;
    }
  }
  let timer = null;
  return {
    folder: dir,
    runOnce,
    start() {
      runOnce();
      timer = setInterval(runOnce, everyMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

function prune(dir, pattern, keep) {
  const files = fs.readdirSync(dir).filter(name => pattern.test(name)).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, name), { force: true });
}
