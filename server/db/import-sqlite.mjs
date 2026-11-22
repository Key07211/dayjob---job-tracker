import { DatabaseSync } from 'node:sqlite';

// Copies Dayjob's SQLite database into an empty PostgreSQL one, table by table, keeping every id, then checks
// each table's row count and compares sample rows. The SQLite file is opened read-only and never changed. If
// anything does not match, the whole import is undone and an error says what differed, so Dayjob can stay on
// SQLite.

// Parents before children, so foreign keys hold while rows go in.
export const IMPORT_ORDER = [
  'settings', 'searches', 'companies', 'postings', 'posting_searches', 'runs', 'resumes', 'scores',
  'applications', 'application_events', 'notifications', 'goals', 'goal_logs', 'ai_usage', 'assistant_steps',
  'cover_letters', 'assistant_conversations',
];
// Made on first use, so an older database may not have it.
const OPTIONAL = new Set(['assistant_conversations']);
const IDENTITY = { ai_usage: 'id', assistant_steps: 'id' };
const SAMPLES = 10;
const PARAMS_PER_INSERT = 30000;

export async function importSqlite({ sqliteFile, pg, log = () => {} }) {
  const source = new DatabaseSync(sqliteFile, { readOnly: true });
  try {
    const sourceTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name));
    const unknown = [...sourceTables].filter(name => !IMPORT_ORDER.includes(name));
    if (unknown.length) throw importError(`the SQLite database has tables this version cannot import: ${unknown.join(', ')}.`);
    const missing = IMPORT_ORDER.filter(name => !sourceTables.has(name) && !OPTIONAL.has(name));
    if (missing.length) throw importError(`the SQLite database is missing tables: ${missing.join(', ')}.`);

    const report = { sqliteVersion: source.prepare('PRAGMA user_version').get().user_version, tables: [], nulStripped: 0 };
    await pg.transaction(async tx => {
      for (const table of IMPORT_ORDER) {
        const existing = await tx.get(`SELECT count(*)::integer AS n FROM ${table}`);
        if (existing.n) throw importError(`PostgreSQL already has rows in ${table}; the import only goes into an empty database.`);
      }
      for (const table of IMPORT_ORDER) {
        if (!sourceTables.has(table)) { report.tables.push({ table, rows: 0 }); continue; }
        const columns = await mapColumns(source, tx, table);
        const stats = { nul: 0 };
        const rows = source.prepare(`SELECT ${selectList(columns)} FROM ${quote(table)}`).all();
        const batch = Math.max(1, Math.min(500, Math.floor(PARAMS_PER_INSERT / columns.length)));
        for (let start = 0; start < rows.length; start += batch) {
          const params = [];
          const values = rows.slice(start, start + batch).map(row => `(${columns.map(column => {
            params.push(convert(row[column.name], column, table, stats));
            return `$${params.length}`;
          }).join(', ')})`);
          await tx.run(`INSERT INTO ${table} (${columns.map(c => quote(c.name)).join(', ')}) VALUES ${values.join(', ')}`, params);
        }
        if (IDENTITY[table] && rows.length) {
          const column = IDENTITY[table];
          await tx.query(`SELECT setval(pg_get_serial_sequence('${table}', '${column}'), (SELECT max(${column}) FROM ${table}))`);
        }
        report.nulStripped += stats.nul;
        report.tables.push({ table, rows: rows.length });
        log(`[dayjob] import ${table}: ${rows.length}`);
      }
      await verify(source, tx, sourceTables);
    });
    report.rows = report.tables.reduce((sum, entry) => sum + entry.rows, 0);
    return report;
  } finally {
    source.close();
  }
}

// Every SQLite column must have a PostgreSQL column of the same name; otherwise data would be left behind.
async function mapColumns(source, tx, table) {
  const target = new Map((await tx.query(
    'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [table],
  )).map(row => [row.column_name, row.data_type]));
  return source.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => {
    const type = target.get(column.name);
    if (!type) throw importError(`PostgreSQL has no column ${table}.${column.name}.`);
    return { name: column.name, type, pk: column.pk };
  });
}

// node:sqlite hands text back only up to a NUL character, so text is read as bytes: nothing after a NUL is lost.
const selectList = columns => columns.map(c => (c.type === 'text' ? `CAST(${quote(c.name)} AS BLOB) AS ${quote(c.name)}` : quote(c.name))).join(', ');

const asNumber = value => (typeof value === 'bigint' ? Number(value) : typeof value === 'string' && value.trim() !== '' ? Number(value) : value);

function convert(value, column, table, stats) {
  if (value === null || value === undefined) return null;
  const where = `${table}.${column.name}`;
  switch (column.type) {
    case 'text': {
      const text = value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value);
      // PostgreSQL text cannot hold the NUL character; scraped pages occasionally carry one.
      if (!text.includes('\u0000')) return text;
      stats.nul += 1;
      return text.replaceAll('\u0000', '');
    }
    case 'integer': case 'bigint': case 'smallint': {
      const number = asNumber(value);
      if (typeof number !== 'number' || !Number.isInteger(number)) throw importError(`${where} holds ${JSON.stringify(String(value))}, not a whole number.`);
      return number;
    }
    case 'double precision': case 'real': case 'numeric': {
      const number = asNumber(value);
      if (typeof number !== 'number' || Number.isNaN(number)) throw importError(`${where} holds ${JSON.stringify(String(value))}, not a number.`);
      return number;
    }
    case 'bytea':
      return value instanceof Uint8Array ? value : Buffer.from(String(value), 'utf8');
    default:
      throw importError(`${where} has a PostgreSQL type the import does not know (${column.type}).`);
  }
}

// Row counts for every table, then up to SAMPLES rows per table, spread across it, compared column by column.
async function verify(source, tx, sourceTables) {
  for (const table of IMPORT_ORDER) {
    if (!sourceTables.has(table)) continue;
    const expected = source.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n;
    const actual = (await tx.get(`SELECT count(*)::integer AS n FROM ${table}`)).n;
    if (expected !== actual) throw importError(`${table}: ${expected} rows in SQLite, ${actual} in PostgreSQL.`);
    if (!expected) continue;
    const columns = await mapColumns(source, tx, table);
    const keys = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk);
    const step = Math.max(1, Math.floor(expected / SAMPLES));
    const samples = source.prepare(`SELECT * FROM (SELECT ${selectList(columns)}, row_number() OVER () AS dayjob_n FROM ${quote(table)}) WHERE (dayjob_n - 1) % ? = 0 LIMIT ?`).all(step, SAMPLES);
    for (const row of samples) {
      const where = keys.map((key, index) => `${quote(key.name)} = $${index + 1}`).join(' AND ');
      const copy = await tx.get(`SELECT * FROM ${table} WHERE ${where}`, keys.map(key => convert(row[key.name], key, table, { nul: 0 })));
      const label = keys.map(key => row[key.name]).join(', ');
      if (!copy) throw importError(`${table}: a row is missing in PostgreSQL (${label}).`);
      for (const column of columns) {
        if (!same(convert(row[column.name], column, table, { nul: 0 }), copy[column.name])) {
          throw importError(`${table}.${column.name} differs after the import (${label}).`);
        }
      }
    }
  }
}

function same(a, b) {
  if (a === null || b === null) return a === b;
  if (a instanceof Uint8Array || b instanceof Uint8Array) return Buffer.from(a).equals(Buffer.from(b));
  return a === b;
}

const quote = name => `"${String(name).replaceAll('"', '""')}"`;

function importError(message) {
  const error = new Error(`Import from SQLite stopped: ${message}`);
  error.code = 'DAYJOB_IMPORT';
  return error;
}
