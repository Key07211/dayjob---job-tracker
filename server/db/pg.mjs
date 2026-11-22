import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { acquireLock } from './lock.mjs';

// Dayjob's PostgreSQL. By default it is PostgreSQL built into Dayjob (PGlite): no install, no service, no port;
// its files are in <data>/pg. Business code sees only this small interface (query, get, run, exec, transaction,
// close), so a real PostgreSQL server can be put behind it later without changing the code that uses it.
//
// Not used by the app yet: Dayjob still runs on SQLite (server/jobs/db.mjs) until the switch.

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
export const PG_FOLDER = 'pg';

// The numbered schema files, in order: 001_init.sql, 002_….sql. A file's number is its version.
export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .map(name => /^(\d{3})_[\w-]+\.sql$/.exec(name))
    .filter(Boolean)
    .map(match => ({ version: Number(match[1]), name: match[0], sql: fs.readFileSync(path.join(dir, match[0]), 'utf8') }))
    .sort((a, b) => a.version - b.version);
}

export const PG_SCHEMA_VERSION = listMigrations().at(-1)?.version ?? 0;

// directory: the Dayjob data folder, or ':memory:' for a database that lives only in this process (tests).
export async function openPg(directory, { migrations = listMigrations(), lock = true } = {}) {
  const memory = directory === ':memory:';
  const dataDir = memory ? null : path.join(directory, PG_FOLDER);
  const held = memory || !lock ? null : acquireLock(directory);
  let client;
  try {
    client = memory ? await PGlite.create() : await PGlite.create({ dataDir });
    const db = wrap(client, () => held?.release());
    await migrate(db, migrations);
    return Object.assign(db, { dataDir });
  } catch (error) {
    try { await client?.close(); } catch { /* Not open. */ }
    held?.release();
    throw error;
  }
}

function wrap(client, onClose) {
  const api = runner => ({
    async query(sql, params = []) { return (await runner.query(sql, params)).rows; },
    async get(sql, params = []) { return (await runner.query(sql, params)).rows[0]; },
    async run(sql, params = []) { const result = await runner.query(sql, params); return { changes: result.affectedRows ?? 0, rows: result.rows }; },
    async exec(sql) { await runner.exec(sql); },
  });
  let closed = false;
  return {
    ...api(client),
    // work(tx) gets the same interface; everything it does is kept together or undone together.
    transaction(work) { return client.transaction(tx => work(api(tx))); },
    async close() {
      if (closed) return;
      closed = true;
      try { await client.close(); } finally { onClose(); }
    },
    get closed() { return closed; },
  };
}

// Runs the schema files not yet run, each in its own transaction, and records them in schema_migrations.
export async function migrate(db, migrations = listMigrations()) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const done = new Set((await db.query('SELECT version FROM schema_migrations')).map(row => row.version));
  const newest = Math.max(0, ...done);
  const known = Math.max(0, ...migrations.map(m => m.version));
  if (newest > known) {
    throw new Error(`This database was created by a newer Dayjob (schema ${newest}). Update Dayjob before opening it.`);
  }
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    await db.transaction(async tx => {
      await tx.exec(migration.sql);
      await tx.run('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
    });
  }
}
