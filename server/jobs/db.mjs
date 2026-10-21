import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Each entry upgrades the schema by one version. Never edit a released entry;
// append a new one so existing databases migrate forward in place.
const migrations = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE searches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    keywords TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    distance INTEGER,
    sites TEXT NOT NULL,
    hours_old INTEGER,
    job_type TEXT,
    is_remote INTEGER NOT NULL DEFAULT 0,
    results_wanted INTEGER NOT NULL DEFAULT 25,
    country TEXT NOT NULL DEFAULT 'usa',
    title_include TEXT NOT NULL DEFAULT '[]',
    exclude_keywords TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_run_at TEXT
  );

  CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ats TEXT NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby')),
    slug TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (ats, slug)
  );

  CREATE TABLE postings (
    id TEXT PRIMARY KEY,
    site TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT,
    company_url TEXT,
    company_logo TEXT,
    location TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    is_remote INTEGER,
    job_type TEXT,
    job_level TEXT,
    job_function TEXT,
    department TEXT,
    salary_min REAL,
    salary_max REAL,
    salary_interval TEXT,
    salary_currency TEXT,
    salary_source TEXT,
    description TEXT,
    emails TEXT,
    job_url TEXT NOT NULL,
    apply_url TEXT,
    date_posted TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    closed_at TEXT,
    last_checked_at TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'saved', 'dismissed', 'applied')),
    dedupe_key TEXT,
    duplicate_of TEXT,
    UNIQUE (site, external_id)
  );
  CREATE INDEX postings_status ON postings (status, first_seen_at);
  CREATE INDEX postings_dedupe ON postings (dedupe_key);

  CREATE TABLE posting_searches (
    posting_id TEXT NOT NULL REFERENCES postings (id) ON DELETE CASCADE,
    search_id TEXT NOT NULL,
    matched_at TEXT NOT NULL,
    PRIMARY KEY (posting_id, search_id)
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    found INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0,
    scored INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE resumes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    text TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE scores (
    posting_id TEXT NOT NULL REFERENCES postings (id) ON DELETE CASCADE,
    resume_id TEXT NOT NULL REFERENCES resumes (id) ON DELETE CASCADE,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    verdict TEXT NOT NULL,
    summary TEXT NOT NULL,
    strengths TEXT NOT NULL DEFAULT '[]',
    gaps TEXT NOT NULL DEFAULT '[]',
    missing_keywords TEXT NOT NULL DEFAULT '[]',
    provider TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (posting_id, resume_id)
  );

  CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    posting_id TEXT UNIQUE REFERENCES postings (id) ON DELETE SET NULL,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    job_url TEXT,
    status TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    status_changed_at TEXT NOT NULL,
    next_follow_up_at TEXT,
    resume_id TEXT,
    contact TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    flags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE application_events (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('user', 'auto', 'mcp'))
  );
  CREATE INDEX events_application ON application_events (application_id, at);

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    ref_id TEXT,
    created_at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );
  `,
];

export const SCHEMA_VERSION = migrations.length;

export function openDatabase(directory) {
  let filename = ':memory:';
  if (directory !== ':memory:') {
    fs.mkdirSync(directory, { recursive: true });
    filename = path.join(directory, 'dayjob.sqlite');
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > migrations.length) {
    db.close();
    throw new Error(`This database was created by a newer Dayjob (schema ${current}). Update Dayjob before opening it.`);
  }
  for (let version = current; version < migrations.length; version += 1) {
    transaction(db, () => {
      db.exec(migrations[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return { db, filename };
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
