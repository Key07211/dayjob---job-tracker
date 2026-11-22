import fs from 'node:fs';
import path from 'node:path';

// PostgreSQL in Dayjob (PGlite) does not stop a second process from opening the same data folder: both open it
// without an error and one silently overwrites what the other wrote. This lock file keeps it to one process.
// It holds the owner's process id; a lock left by a process that has ended is taken over.
export function acquireLock(directory, { pid = process.pid, alive = isAlive } = {}) {
  const file = path.join(directory, 'dayjob.lock');
  fs.mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, at: new Date().toISOString() }), { flag: 'wx' });
      let released = false;
      return {
        file,
        release() {
          if (released) return;
          released = true;
          try { if (readOwner(file)?.pid === pid) fs.unlinkSync(file); } catch { /* Already gone. */ }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readOwner(file);
      // This same process counts too: two PGlites on one folder in one process lose data the same way.
      if (owner && alive(owner.pid)) {
        const busy = new Error(`The Dayjob database is open in another Dayjob process (${owner.pid}). Close it first.`);
        busy.code = 'DAYJOB_DB_LOCKED';
        busy.pid = owner.pid;
        throw busy;
      }
      // Left by an ended process (or unreadable): take it over.
      try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  throw new Error(`Could not take the database lock ${file}.`);
}

function readOwner(file) {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(owner?.pid) ? owner : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
