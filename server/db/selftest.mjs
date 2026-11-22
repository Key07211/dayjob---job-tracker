// Checks that PostgreSQL built into Dayjob runs where it is: opens a database in an empty folder, writes, searches
// the text, closes, opens it again and reads the rows back, then removes the folder. Prints one line of JSON.
// The Windows build runs it with the packaged Dayjob.exe in Node mode, from inside app.asar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPg } from './pg.mjs';

const folder = fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), 'dayjob-pg-check-'));
const started = performance.now();
const result = { ok: false };
try {
  let pg = await openPg(folder);
  result.firstOpenMs = Math.round(performance.now() - started);
  result.version = (await pg.get('SHOW server_version')).server_version;
  const at = new Date().toISOString();
  await pg.transaction(async tx => {
    for (let i = 0; i < 200; i += 1) {
      await tx.run(`INSERT INTO postings (id, site, external_id, title, company, description, job_url, first_seen_at, last_seen_at)
        VALUES ($1, 'check', $1, $2, 'Acme', $3, 'https://example.com', $4, $4)`, [`p${i}`, `Data analyst ${i}`, i % 10 ? 'SQL and dashboards' : 'Python 数据分析 pipelines', at]);
    }
  });
  const found = await pg.get("SELECT count(*)::integer AS n FROM postings WHERE to_tsvector('simple', description) @@ to_tsquery('simple', 'python')");
  if (found.n !== 20) throw new Error(`text search found ${found.n} rows, not 20`);
  await pg.close();
  const reopened = performance.now();
  pg = await openPg(folder);
  result.reopenMs = Math.round(performance.now() - reopened);
  const kept = await pg.get('SELECT count(*)::integer AS n FROM postings');
  if (kept.n !== 200) throw new Error(`${kept.n} rows after reopening, not 200`);
  await pg.close();
  result.rssMb = Math.round(process.memoryUsage().rss / 1048576);
  result.ok = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
