import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../server/jobs/db.mjs';
import { createConversationStore } from '../server/assistant/store.mjs';
import { createDailyBackups } from '../server/jobs/backup.mjs';
import { listMigrations, openPg, PG_SCHEMA_VERSION } from '../server/db/pg.mjs';
import { acquireLock } from '../server/db/lock.mjs';
import { IMPORT_ORDER, importSqlite } from '../server/db/import-sqlite.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-pg-'));
const at = '2026-11-21T10:00:00.000Z';

// A SQLite database at the current schema with rows in every table, made the way Dayjob makes it.
function sqliteWithData(directory, { postings = 30 } = {}) {
  const { db, filename } = openDatabase(directory);
  createConversationStore(db);
  const insert = (sql, ...values) => db.prepare(sql).run(...values);
  insert('INSERT INTO settings (key, value) VALUES (?, ?)', 'settings', JSON.stringify({ language: 'zh', profile: { name: '测试' } }));
  insert(`INSERT INTO searches (id, name, keywords, sites, created_at, updated_at) VALUES ('s1', 'Data', '["data analyst"]', '["indeed"]', ?, ?)`, at, at);
  insert(`INSERT INTO companies (id, name, ats, slug, created_at) VALUES ('c1', 'Acme', 'greenhouse', 'acme', ?)`, at);
  insert(`INSERT INTO resumes (id, name, mime, size, text, uploaded_at, file) VALUES ('r1', 'cv.pdf', 'application/pdf', 4, 'Resume text', ?, ?)`, at, new Uint8Array([37, 80, 68, 0]));
  for (let i = 0; i < postings; i += 1) {
    insert(`INSERT INTO postings (id, site, external_id, title, company, description, job_url, first_seen_at, last_seen_at, is_remote, salary_min, resume_id, resume_overlap)
      VALUES (?, 'indeed', ?, ?, 'Acme', ?, 'https://example.com/j', ?, ?, ?, ?, 'r1', 0.5)`,
    `p${i}`, `e${i}`, `Analyst ${i}`, i === 3 ? 'has a NUL\u0000inside' : `描述 ${i}`, at, at, i % 2, 100000.5 + i);
    insert('INSERT INTO posting_searches (posting_id, search_id, matched_at) VALUES (?, ?, ?)', `p${i}`, 's1', at);
  }
  insert(`INSERT INTO runs (id, kind, trigger, started_at, status) VALUES ('run1', 'search', 'manual', ?, 'succeeded')`, at);
  insert(`INSERT INTO scores (posting_id, resume_id, score, verdict, summary, provider, created_at) VALUES ('p1', 'r1', 81, 'good', 'ok', 'claude-code', ?)`, at);
  insert(`INSERT INTO applications (id, posting_id, company, title, status, applied_at, status_changed_at, created_at, updated_at) VALUES ('a1', 'p1', 'Acme', 'Analyst 1', 'applied', ?, ?, ?, ?)`, at, at, at, at);
  insert(`INSERT INTO application_events (id, application_id, at, type, to_status, source) VALUES ('ev1', 'a1', ?, 'status', 'applied', 'user')`, at);
  insert(`INSERT INTO notifications (id, kind, title, body, created_at) VALUES ('n1', 'run', 'Done', 'Found 30', ?)`, at);
  insert(`INSERT INTO goals (id, month, metric, target, created_at) VALUES ('g1', '2026-11', 'applications', 20, ?)`, at);
  insert(`INSERT INTO goal_logs (id, goal_id, at, amount) VALUES ('gl1', 'g1', ?, 1)`, at);
  for (let i = 0; i < 3; i += 1) insert(`INSERT INTO ai_usage (at, kind, provider, input_tokens, cost_usd) VALUES (?, 'score', 'anthropic', 1200, 0.012)`, at);
  insert(`INSERT INTO assistant_steps (at, conversation_id, reply_at, step, kind, provider) VALUES (?, 'conv1', ?, 1, 'chat', 'anthropic')`, at, at);
  insert(`INSERT INTO cover_letters (id, posting_id, text, created_at, updated_at) VALUES ('cl1', 'p1', 'Dear Acme', ?, ?)`, at, at);
  insert(`INSERT INTO assistant_conversations (id, title, created_at, updated_at, turns) VALUES ('conv1', '对话', ?, ?, '[]')`, at, at);
  db.close();
  return filename;
}

test('PostgreSQL opens with every table, in memory', async () => {
  const pg = await openPg(':memory:');
  try {
    assert.equal(PG_SCHEMA_VERSION, listMigrations().length);
    const tables = (await pg.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).map(row => row.table_name);
    for (const table of [...IMPORT_ORDER, 'schema_migrations']) assert.ok(tables.includes(table), table);
    const version = await pg.get('SELECT max(version) AS v FROM schema_migrations');
    assert.equal(version.v, PG_SCHEMA_VERSION);
  } finally {
    await pg.close();
  }
});

test('every column of the SQLite schema has a PostgreSQL column', async () => {
  const sqlite = openDatabase(':memory:').db;
  createConversationStore(sqlite);
  const pg = await openPg(':memory:');
  try {
    for (const table of IMPORT_ORDER) {
      const theirs = new Set((await pg.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])).map(row => row.column_name));
      for (const column of sqlite.prepare(`PRAGMA table_info(${table})`).all()) assert.ok(theirs.has(column.name), `${table}.${column.name}`);
    }
  } finally {
    sqlite.close();
    await pg.close();
  }
});

test('the SQLite database is imported whole: every row, ids, files and counters', async () => {
  const directory = tempDir();
  const file = sqliteWithData(directory);
  const before = fs.readFileSync(file);
  const pg = await openPg(':memory:');
  try {
    const report = await importSqlite({ sqliteFile: file, pg });
    assert.equal(report.sqliteVersion, SCHEMA_VERSION);
    assert.equal(report.nulStripped, 1);
    const rows = Object.fromEntries(report.tables.map(entry => [entry.table, entry.rows]));
    assert.equal(rows.postings, 30);
    assert.equal(rows.posting_searches, 30);
    assert.equal(rows.ai_usage, 3);
    assert.equal(rows.assistant_conversations, 1);

    const resume = await pg.get("SELECT file FROM resumes WHERE id = 'r1'");
    assert.deepEqual([...resume.file], [37, 80, 68, 0]);
    const posting = await pg.get("SELECT description, is_remote, salary_min FROM postings WHERE id = 'p3'");
    // Dayjob itself reads only 'has a NUL' from SQLite; the import keeps the rest of the text.
    assert.equal(posting.description, 'has a NULinside');
    assert.equal(posting.is_remote, 1);
    assert.equal(posting.salary_min, 100003.5);
    assert.equal((await pg.get("SELECT title FROM assistant_conversations WHERE id = 'conv1'")).title, '对话');
    // New rows carry on after the imported ids.
    const next = await pg.get("INSERT INTO ai_usage (at, kind, provider) VALUES ($1, 'score', 'anthropic') RETURNING id", [at]);
    assert.equal(next.id, 4);
    // Foreign keys came along.
    await assert.rejects(pg.run("INSERT INTO scores (posting_id, resume_id, score, verdict, summary, provider, created_at) VALUES ('nope', 'r1', 1, 'x', 'x', 'x', $1)", [at]));
  } finally {
    await pg.close();
  }
  // The SQLite file is left exactly as it was.
  assert.ok(before.equals(fs.readFileSync(file)));
});

test('an import that cannot be complete is undone and changes nothing', async () => {
  const directory = tempDir();
  const file = sqliteWithData(directory, { postings: 3 });
  const extra = new DatabaseSync(file);
  extra.exec('CREATE TABLE something_new (id TEXT PRIMARY KEY)');
  extra.close();
  const pg = await openPg(':memory:');
  try {
    await assert.rejects(importSqlite({ sqliteFile: file, pg }), /cannot import: something_new/);
    assert.equal((await pg.get('SELECT count(*)::integer AS n FROM postings')).n, 0);

    const other = sqliteWithData(tempDir(), { postings: 3 });
    const column = new DatabaseSync(other);
    column.exec('ALTER TABLE postings ADD COLUMN future TEXT');
    column.close();
    await assert.rejects(importSqlite({ sqliteFile: other, pg }), /no column postings\.future/);
    assert.equal((await pg.get('SELECT count(*)::integer AS n FROM settings')).n, 0);

    const fine = sqliteWithData(tempDir(), { postings: 3 });
    await importSqlite({ sqliteFile: fine, pg });
    await assert.rejects(importSqlite({ sqliteFile: fine, pg }), /only goes into an empty database/);
    assert.equal((await pg.get('SELECT count(*)::integer AS n FROM postings')).n, 3);
  } finally {
    await pg.close();
  }
});

test('the data folder keeps its rows and is opened by one process at a time', async () => {
  const directory = tempDir();
  const first = await openPg(directory);
  await first.run("INSERT INTO settings (key, value) VALUES ('k', 'v')");
  await assert.rejects(openPg(directory), error => error.code === 'DAYJOB_DB_LOCKED');
  await first.close();
  assert.equal(fs.existsSync(path.join(directory, 'dayjob.lock')), false);

  const again = await openPg(directory);
  try {
    assert.equal((await again.get("SELECT value FROM settings WHERE key = 'k'")).value, 'v');
  } finally {
    await again.close();
  }
});

test('a lock left by a process that ended is taken over', () => {
  const directory = tempDir();
  fs.writeFileSync(path.join(directory, 'dayjob.lock'), JSON.stringify({ pid: 999999, at }));
  const lock = acquireLock(directory, { alive: () => false });
  assert.equal(JSON.parse(fs.readFileSync(lock.file, 'utf8')).pid, process.pid);
  lock.release();
  fs.writeFileSync(path.join(directory, 'dayjob.lock'), JSON.stringify({ pid: 999999, at }));
  assert.throws(() => acquireLock(directory, { alive: () => true }), /another Dayjob process \(999999\)/);
});

test('a database from a newer Dayjob is not opened', async () => {
  const directory = tempDir();
  const pg = await openPg(directory);
  await pg.run("INSERT INTO schema_migrations (version, name) VALUES (999, '999_future.sql')");
  await pg.close();
  await assert.rejects(openPg(directory), /newer Dayjob \(schema 999\)/);
  assert.equal(fs.existsSync(path.join(directory, 'dayjob.lock')), false);
});

test('a schema file that fails is undone and not recorded', async () => {
  const broken = [...listMigrations(), { version: 900, name: '900_broken.sql', sql: 'CREATE TABLE half (id text); SELECT no_such_function();' }];
  await assert.rejects(openPg(':memory:', { migrations: broken }));
  const directory = tempDir();
  await assert.rejects(openPg(directory, { migrations: broken }));
  const pg = await openPg(directory);
  try {
    assert.equal((await pg.get("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_name = 'half'")).n, 0);
    assert.equal((await pg.get('SELECT max(version) AS v FROM schema_migrations')).v, PG_SCHEMA_VERSION);
  } finally {
    await pg.close();
  }
});

test('SQLite gets one backup a day, the newest 14 kept', () => {
  const directory = tempDir();
  const { db } = openDatabase(directory);
  let day = new Date(2026, 10, 1, 9);
  const backups = createDailyBackups({ db, directory, now: () => day, log: () => {} });
  try {
    assert.ok(backups.runOnce());
    assert.equal(backups.runOnce(), null);
    for (let i = 0; i < 20; i += 1) { day = new Date(2026, 10, 2 + i, 9); backups.runOnce(); }
    const files = fs.readdirSync(backups.folder).sort();
    assert.equal(files.length, 14);
    assert.equal(files.at(-1), 'dayjob-2026-11-21.sqlite');
    const copy = new DatabaseSync(path.join(backups.folder, files[0]), { readOnly: true });
    assert.equal(copy.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    copy.close();
  } finally {
    db.close();
  }
});

test('SQLite is copied before a schema upgrade', () => {
  const directory = tempDir();
  const { db, filename } = openDatabase(directory);
  db.exec(`DROP TABLE cover_letters; PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  db.close();
  const again = openDatabase(directory);
  again.db.close();
  const files = fs.readdirSync(path.join(directory, 'backups'));
  assert.equal(files.length, 1);
  assert.match(files[0], new RegExp(`^dayjob-before-schema-${SCHEMA_VERSION - 1}-\\d{8}T\\d{6}Z\\.sqlite$`));
  assert.ok(fs.existsSync(filename));
});
