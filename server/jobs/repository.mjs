import { randomUUID } from 'node:crypto';
import { dedupeKey, postingId } from './normalize.mjs';
import { transaction } from './db.mjs';
import { rankResumes, resumeTerms } from './keywords.mjs';
import { splitCompanyId } from './scrapers/company-boards.mjs';
import { DEFAULT_APPLICANT } from './applicant.mjs';

export const POSTING_STATUSES = ['new', 'saved', 'dismissed', 'applied'];
export const APPLICATION_STATUSES = ['applied', 'oa', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted'];
export const OPEN_APPLICATION_STATUSES = ['applied', 'oa', 'interview', 'offer'];
// Set by the tracker; a status change by the user clears them.
export const AUTO_FLAGS = ['ghost-suspected', 'follow-up-due'];
export const MAX_RESUMES = 3;
// auto: after each search; saved: the jobs the user saves; manual: only on request.
export const SCORE_MODES = ['auto', 'saved', 'manual'];

export const DEFAULT_SETTINGS = {
  language: 'zh',
  schedule: { enabled: true, time: '08:30' },
  ai: { provider: 'claude-cli', claudeCommand: '', model: '', apiKey: '', scoreMode: 'auto', language: 'zh', maxPerRun: 40, effort: 'medium' },
  tracking: { followUpDays: 7, ghostDays: 21, checkClosed: true },
  notifications: { desktop: true, minScore: 75 },
  jobspy: { pythonCommand: process.platform === 'win32' ? 'python' : 'python3' },
  updates: { autoCheck: true },
  desktop: { closeToTray: true },
  applicant: DEFAULT_APPLICANT,
  retentionDays: 45,
};

const json = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const bool = value => (value === null || value === undefined ? null : Boolean(value));
const int = value => (value === true ? 1 : value === false ? 0 : value ?? null);

function merge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object'
      ? merge(base[key], value) : value;
  }
  return out;
}

export function createRepository(db, { now = () => new Date() } = {}) {
  const iso = () => now().toISOString();
  const q = sql => db.prepare(sql);

  // ---------- settings ----------
  function getSettings() {
    const row = q("SELECT value FROM settings WHERE key = 'app'").get();
    const stored = json(row?.value, {});
    // Up to 0.2.0 scoring was an on/off switch; off now means "only when I ask".
    if (stored.ai && typeof stored.ai === 'object') {
      if (stored.ai.scoreMode === undefined && stored.ai.autoScore === false) stored.ai.scoreMode = 'manual';
      delete stored.ai.autoScore;
    }
    return merge(DEFAULT_SETTINGS, stored);
  }
  function saveSettings(settings) {
    q("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
    return settings;
  }
  function updateSettings(patch) { return saveSettings(merge(getSettings(), patch)); }
  function getMeta(key) { return json(q('SELECT value FROM settings WHERE key = ?').get(`meta:${key}`)?.value, null); }
  function setMeta(key, value) {
    q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`meta:${key}`, JSON.stringify(value));
  }

  // ---------- searches ----------
  const searchRow = row => row && ({
    id: row.id, name: row.name, keywords: row.keywords, location: row.location, distance: row.distance,
    sites: json(row.sites, []), hoursOld: row.hours_old, jobType: row.job_type, isRemote: Boolean(row.is_remote),
    resultsWanted: row.results_wanted, country: row.country, titleInclude: json(row.title_include, []),
    excludeKeywords: json(row.exclude_keywords, []), enabled: Boolean(row.enabled),
    createdAt: row.created_at, updatedAt: row.updated_at, lastRunAt: row.last_run_at,
  });
  function listSearches() { return q('SELECT * FROM searches ORDER BY created_at').all().map(searchRow); }
  function getSearch(id) { return searchRow(q('SELECT * FROM searches WHERE id = ?').get(id)); }
  function saveSearch(input, id = randomUUID()) {
    const existing = q('SELECT id FROM searches WHERE id = ?').get(id);
    const values = [input.name, input.keywords, input.location || '', input.distance ?? null, JSON.stringify(input.sites),
      input.hoursOld ?? null, input.jobType || null, int(input.isRemote) || 0, input.resultsWanted ?? 25, input.country || 'usa',
      JSON.stringify(input.titleInclude || []), JSON.stringify(input.excludeKeywords || []), int(input.enabled ?? true)];
    if (existing) {
      q(`UPDATE searches SET name = ?, keywords = ?, location = ?, distance = ?, sites = ?, hours_old = ?, job_type = ?, is_remote = ?,
        results_wanted = ?, country = ?, title_include = ?, exclude_keywords = ?, enabled = ?, updated_at = ? WHERE id = ?`).run(...values, iso(), id);
    } else {
      q(`INSERT INTO searches (name, keywords, location, distance, sites, hours_old, job_type, is_remote, results_wanted, country,
        title_include, exclude_keywords, enabled, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values, iso(), iso(), id);
    }
    return getSearch(id);
  }
  function deleteSearch(id) {
    return transaction(db, () => {
      q('DELETE FROM posting_searches WHERE search_id = ?').run(id);
      return q('DELETE FROM searches WHERE id = ?').run(id).changes > 0;
    });
  }
  function touchSearch(id) { q('UPDATE searches SET last_run_at = ? WHERE id = ?').run(iso(), id); }

  // ---------- companies ----------
  const companyRow = row => row && ({ id: row.id, name: row.name, ats: row.ats, slug: row.slug, enabled: Boolean(row.enabled), createdAt: row.created_at });
  function listCompanies() { return q('SELECT * FROM companies ORDER BY name COLLATE NOCASE').all().map(companyRow); }
  function addCompany({ name, ats, slug }) {
    const existing = q('SELECT * FROM companies WHERE ats = ? AND slug = ?').get(ats, slug);
    if (existing) return companyRow(existing);
    const id = randomUUID();
    q('INSERT INTO companies (id, name, ats, slug, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(id, name || slug, ats, slug, iso());
    return companyRow(q('SELECT * FROM companies WHERE id = ?').get(id));
  }
  function setCompanyEnabled(id, enabled) {
    q('UPDATE companies SET enabled = ? WHERE id = ?').run(int(enabled), id);
    return companyRow(q('SELECT * FROM companies WHERE id = ?').get(id));
  }
  function deleteCompany(id) { return q('DELETE FROM companies WHERE id = ?').run(id).changes > 0; }

  // ---------- postings ----------
  const postingRow = row => row && ({
    id: row.id, site: row.site, externalId: row.external_id, title: row.title, company: row.company, companyUrl: row.company_url,
    companyLogo: row.company_logo, location: row.location, city: row.city, state: row.state, country: row.country,
    isRemote: bool(row.is_remote), jobType: row.job_type, jobLevel: row.job_level, jobFunction: row.job_function, department: row.department,
    salary: row.salary_min !== null || row.salary_max !== null ? { min: row.salary_min, max: row.salary_max, interval: row.salary_interval,
      currency: row.salary_currency, source: row.salary_source } : null,
    jobUrl: row.job_url, applyUrl: row.apply_url, datePosted: row.date_posted, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    closedAt: row.closed_at, lastCheckedAt: row.last_checked_at, status: row.status, duplicateOf: row.duplicate_of,
    resumeId: row.resume_id ?? null, resumeOverlap: row.resume_overlap ?? null,
    ...(row.description !== undefined ? { description: row.description, emails: json(row.emails, []) } : {}),
    ...(row.score !== undefined ? { score: row.score === null ? null : { score: row.score, verdict: row.verdict, summary: row.score_summary } } : {}),
    ...(row.application_id !== undefined ? { application: row.application_id ? { id: row.application_id, status: row.application_status } : null } : {}),
  });

  function upsertPosting(item, searchId = null) {
    const id = postingId(item);
    const at = iso();
    const existing = q('SELECT id, closed_at, description FROM postings WHERE id = ?').get(id);
    const salary = item.salary || {};
    let isNew = false;
    let reopened = false;
    if (existing) {
      q(`UPDATE postings SET title = ?, company = COALESCE(?, company), company_url = COALESCE(?, company_url), company_logo = COALESCE(?, company_logo),
        location = COALESCE(?, location), city = COALESCE(?, city), state = COALESCE(?, state), country = COALESCE(?, country),
        is_remote = COALESCE(?, is_remote), job_type = COALESCE(?, job_type), job_level = COALESCE(?, job_level),
        job_function = COALESCE(?, job_function), department = COALESCE(?, department),
        salary_min = COALESCE(?, salary_min), salary_max = COALESCE(?, salary_max), salary_interval = COALESCE(?, salary_interval),
        salary_currency = COALESCE(?, salary_currency), salary_source = COALESCE(?, salary_source),
        description = COALESCE(?, description), emails = CASE WHEN ? IS NULL THEN emails ELSE ? END,
        job_url = ?, apply_url = COALESCE(?, apply_url), date_posted = COALESCE(date_posted, ?), last_seen_at = ?, closed_at = NULL
        WHERE id = ?`).run(item.title, item.company, item.companyUrl, item.companyLogo, item.location, item.city, item.state, item.country,
        int(item.isRemote), item.jobType, item.jobLevel, item.jobFunction, item.department,
        salary.min ?? null, salary.max ?? null, salary.interval ?? null, salary.currency ?? null, salary.source ?? null,
        item.description, item.description ? 1 : null, JSON.stringify(item.emails || []),
        item.jobUrl, item.applyUrl, item.datePosted, at, id);
      reopened = Boolean(existing.closed_at);
    } else {
      const key = dedupeKey(item);
      const twin = q(`SELECT id FROM postings WHERE dedupe_key = ? AND duplicate_of IS NULL AND site <> ? AND closed_at IS NULL
        ORDER BY first_seen_at LIMIT 1`).get(key, item.site);
      q(`INSERT INTO postings (id, site, external_id, title, company, company_url, company_logo, location, city, state, country, is_remote,
        job_type, job_level, job_function, department, salary_min, salary_max, salary_interval, salary_currency, salary_source,
        description, emails, job_url, apply_url, date_posted, first_seen_at, last_seen_at, status, dedupe_key, duplicate_of)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`).run(
        id, item.site, item.externalId, item.title, item.company, item.companyUrl, item.companyLogo, item.location, item.city, item.state,
        item.country, int(item.isRemote), item.jobType, item.jobLevel, item.jobFunction, item.department,
        salary.min ?? null, salary.max ?? null, salary.interval ?? null, salary.currency ?? null, salary.source ?? null,
        item.description, JSON.stringify(item.emails || []), item.jobUrl, item.applyUrl, item.datePosted, at, at, key, twin?.id ?? null);
      isNew = !twin;
    }
    if (searchId) q('INSERT OR IGNORE INTO posting_searches (posting_id, search_id, matched_at) VALUES (?, ?, ?)').run(id, searchId, at);
    matchPosting(id);
    return { id, isNew, reopened };
  }

  const LIST_COLUMNS = `p.id, p.site, p.external_id, p.title, p.company, p.company_url, p.company_logo, p.location, p.city, p.state, p.country,
    p.is_remote, p.job_type, p.job_level, p.job_function, p.department, p.salary_min, p.salary_max, p.salary_interval, p.salary_currency,
    p.salary_source, p.job_url, p.apply_url, p.date_posted, p.first_seen_at, p.last_seen_at, p.closed_at, p.last_checked_at, p.status,
    p.duplicate_of, p.resume_id, p.resume_overlap, s.score, s.verdict, s.summary AS score_summary, a.id AS application_id, a.status AS application_status`;
  // A posting shows the score from the resume it was matched to.
  const LIST_JOINS = `LEFT JOIN scores s ON s.posting_id = p.id AND s.resume_id = p.resume_id
    LEFT JOIN applications a ON a.posting_id = p.id`;

  function listPostings({ status = 'active', site, q: text, minScore, searchId, sort = 'posted', includeDuplicates = false,
    includeClosed = true, unscored = false, sinceDays, limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (status === 'active') where.push("p.status IN ('new', 'saved')");
    else if (status !== 'all') { where.push('p.status = ?'); params.push(status); }
    if (site) { where.push('p.site = ?'); params.push(site); }
    if (text) { where.push('(p.title LIKE ? OR p.company LIKE ? OR p.location LIKE ?)'); params.push(`%${text}%`, `%${text}%`, `%${text}%`); }
    if (Number.isFinite(minScore)) { where.push('s.score >= ?'); params.push(minScore); }
    if (unscored) where.push('s.score IS NULL');
    if (searchId) { where.push('EXISTS (SELECT 1 FROM posting_searches ps WHERE ps.posting_id = p.id AND ps.search_id = ?)'); params.push(searchId); }
    if (!includeDuplicates) where.push('p.duplicate_of IS NULL');
    if (!includeClosed) where.push('p.closed_at IS NULL');
    if (Number.isFinite(sinceDays)) { where.push('p.first_seen_at >= ?'); params.push(new Date(now().getTime() - sinceDays * 864e5).toISOString()); }
    const order = { score: 's.score IS NULL, s.score DESC, p.first_seen_at DESC', seen: 'p.first_seen_at DESC',
      posted: 'COALESCE(p.date_posted, p.first_seen_at) DESC, p.first_seen_at DESC', company: 'p.company COLLATE NOCASE, p.title' }[sort]
      || 'COALESCE(p.date_posted, p.first_seen_at) DESC';
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = q(`SELECT ${LIST_COLUMNS} FROM postings p ${LIST_JOINS} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = q(`SELECT COUNT(*) AS n FROM postings p ${LIST_JOINS} ${clause}`).get(...params).n;
    return { items: rows.map(postingRow), total };
  }

  function getPosting(id) {
    const row = q(`SELECT p.*, s.score, s.verdict, s.summary AS score_summary, a.id AS application_id, a.status AS application_status
      FROM postings p ${LIST_JOINS} WHERE p.id = ?`).get(id);
    if (!row) return null;
    const item = postingRow(row);
    item.score = row.resume_id ? getScore(id, row.resume_id) : null;
    item.resumeMatch = resumeMatch(row);
    item.duplicates = q('SELECT id, site, job_url FROM postings WHERE duplicate_of = ?').all(row.duplicate_of || id)
      .filter(other => other.id !== id).map(other => ({ id: other.id, site: other.site, jobUrl: other.job_url }));
    if (row.duplicate_of) {
      const canonical = q('SELECT id, site, job_url FROM postings WHERE id = ?').get(row.duplicate_of);
      if (canonical) item.duplicates.unshift({ id: canonical.id, site: canonical.site, jobUrl: canonical.job_url });
    }
    item.searches = q('SELECT s.id, s.name FROM posting_searches ps JOIN searches s ON s.id = ps.search_id WHERE ps.posting_id = ?').all(id)
      .map(entry => ({ id: entry.id, name: entry.name }));
    return item;
  }
  // The posting a web page belongs to: the same link (its query may carry
  // more than the stored one), or the job a LinkedIn search page has open.
  function findPostingByUrl(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    url.hash = '';
    const linkedInJob = /(^|\.)linkedin\.com$/.test(url.hostname) && (url.searchParams.get('currentJobId') || /\/jobs\/view\/(?:[^/]*-)?(\d+)/.exec(url.pathname)?.[1]);
    const wanted = linkedInJob ? new URL(`https://www.linkedin.com/jobs/view/${linkedInJob}`) : url;
    const base = `${wanted.origin}${wanted.pathname.replace(/\/+$/, '')}`;
    const rows = q(`SELECT id, duplicate_of, job_url, apply_url FROM postings WHERE job_url LIKE ? ESCAPE '\\' OR apply_url LIKE ? ESCAPE '\\' LIMIT 50`)
      .all(...Array(2).fill(`${base.replace(/[\\%_]/g, '\\$&')}%`));
    const fits = stored => {
      let link;
      try { link = new URL(stored); } catch { return false; }
      if (`${link.origin}${link.pathname.replace(/\/+$/, '')}` !== base) return false;
      return [...link.searchParams].every(([key, item]) => wanted.searchParams.get(key) === item);
    };
    const row = rows.find(item => fits(item.job_url) || (item.apply_url && fits(item.apply_url)));
    return row ? getPosting(row.duplicate_of || row.id) : null;
  }
  function postingForScoring(id) {
    const row = q('SELECT * FROM postings WHERE id = ?').get(id);
    return row ? postingRow(row) : null;
  }
  function setPostingStatus(id, status) {
    if (!q('UPDATE postings SET status = ? WHERE id = ?').run(status, id).changes) return null;
    q('UPDATE postings SET status = ? WHERE duplicate_of = ? AND status <> ?').run(status === 'applied' ? 'applied' : status, id, 'applied');
    return getPosting(id);
  }
  // "Not interested" for every new job scored under the line; saved and
  // applied jobs stay. Returns the ids so the change can be undone.
  function dismissBelowScore(score) {
    const ids = q(`SELECT p.id FROM postings p JOIN scores s ON s.posting_id = p.id AND s.resume_id = p.resume_id
      WHERE p.status = 'new' AND p.duplicate_of IS NULL AND s.score < ?`).all(score).map(row => row.id);
    for (const id of ids) setPostingStatus(id, 'dismissed');
    return ids;
  }
  function restoreDismissed(ids) {
    return ids.filter(id => q("SELECT status FROM postings WHERE id = ?").get(id)?.status === 'dismissed' && setPostingStatus(id, 'new'));
  }
  function markChecked(id, open) {
    const at = iso();
    const row = q('SELECT closed_at FROM postings WHERE id = ?').get(id);
    if (!row) return { changed: false };
    if (open === false && !row.closed_at) { q('UPDATE postings SET closed_at = ?, last_checked_at = ? WHERE id = ?').run(at, at, id); return { changed: true, closed: true }; }
    if (open === true && row.closed_at) { q('UPDATE postings SET closed_at = NULL, last_checked_at = ? WHERE id = ?').run(at, id); return { changed: true, closed: false }; }
    q('UPDATE postings SET last_checked_at = ? WHERE id = ?').run(at, id);
    return { changed: false };
  }
  function markUnseenCompanyJobsClosed(site, slug, seenIds) {
    const at = iso();
    const seen = new Set(seenIds);
    const rows = q("SELECT id, external_id FROM postings WHERE site = ? AND closed_at IS NULL").all(site);
    const closed = rows.filter(row => splitCompanyId(site, row.external_id)?.slug === slug && !seen.has(row.id)).map(row => row.id);
    for (const id of closed) q('UPDATE postings SET closed_at = ?, last_checked_at = ? WHERE id = ?').run(at, at, id);
    return closed;
  }
  function purgeOldPostings(days) {
    const cutoff = new Date(now().getTime() - days * 864e5).toISOString();
    return q(`DELETE FROM postings WHERE status IN ('new', 'dismissed') AND last_seen_at < ?
      AND id NOT IN (SELECT posting_id FROM applications WHERE posting_id IS NOT NULL)`).run(cutoff).changes;
  }

  // ---------- runs ----------
  const runRow = row => row && ({ id: row.id, kind: row.kind, trigger: row.trigger, startedAt: row.started_at, finishedAt: row.finished_at,
    status: row.status, found: row.found, newCount: row.new_count, scored: row.scored, detail: json(row.detail, []) });
  function startRun(kind, trigger) {
    const id = randomUUID();
    q("INSERT INTO runs (id, kind, trigger, started_at, status) VALUES (?, ?, ?, ?, 'running')").run(id, kind, trigger, iso());
    return id;
  }
  function finishRun(id, { status, found = 0, newCount = 0, scored = 0, detail = [] }) {
    q('UPDATE runs SET finished_at = ?, status = ?, found = ?, new_count = ?, scored = ?, detail = ? WHERE id = ?')
      .run(iso(), status, found, newCount, scored, JSON.stringify(detail), id);
    return runRow(q('SELECT * FROM runs WHERE id = ?').get(id));
  }
  function updateRunScoring(id, { scored, status, detail }) {
    q('UPDATE runs SET scored = ?, status = ?, detail = ? WHERE id = ?').run(scored, status, JSON.stringify(detail), id);
  }
  function listRuns(limit = 20) { return q('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit).map(runRow); }
  function abandonRunningRuns() {
    q("UPDATE runs SET status = 'failed', finished_at = ?, detail = ? WHERE status = 'running'")
      .run(iso(), JSON.stringify([{ source: 'dayjob', error: 'Dayjob closed before this run finished.' }]));
  }

  // ---------- resumes ----------
  const resumeRow = (row, withText = false) => row && ({ id: row.id, name: row.name, mime: row.mime, size: row.size, uploadedAt: row.uploaded_at,
    characters: row.text.length, ...(withText ? { text: row.text } : { preview: row.text.slice(0, 600) }) });
  let resumeIndex = null;
  const resumes = () => (resumeIndex ??= q('SELECT id, name, uploaded_at, text FROM resumes').all()
    .map(row => ({ id: row.id, name: row.name, uploadedAt: row.uploaded_at, terms: resumeTerms(row.text) })));
  function matchPosting(id) {
    const index = resumes();
    const row = q('SELECT title, description FROM postings WHERE id = ?').get(id);
    if (!row) return;
    const [best] = index.length ? rankResumes(row, index) : [];
    q('UPDATE postings SET resume_id = ?, resume_overlap = ? WHERE id = ?').run(best?.id ?? null, best?.overlap ?? null, id);
  }
  // After resumes change, every posting picks its resume again; on start only
  // postings without a valid match are looked at.
  function rematchPostings({ missingOnly = false } = {}) {
    const index = resumes();
    return transaction(db, () => {
      const rows = q(`SELECT id, title, description FROM postings
        ${missingOnly ? 'WHERE resume_id IS NULL OR resume_id NOT IN (SELECT id FROM resumes)' : ''}`).all();
      const update = q('UPDATE postings SET resume_id = ?, resume_overlap = ? WHERE id = ?');
      for (const row of rows) {
        const [best] = index.length ? rankResumes(row, index) : [];
        update.run(best?.id ?? null, best?.overlap ?? null, row.id);
      }
      return rows.length;
    });
  }
  function resumeMatch(row) {
    const index = resumes();
    if (!index.length) return null;
    return { resumeId: row.resume_id, ranking: rankResumes(row, index).map(entry => ({ id: entry.id, name: index.find(resume => resume.id === entry.id).name,
      overlap: entry.overlap, matched: entry.matched })) };
  }
  function addResume({ name, mime, size, text }) {
    const id = randomUUID();
    q('INSERT INTO resumes (id, name, mime, size, text, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, mime, size, text, iso());
    resumeIndex = null;
    rematchPostings();
    return getResume(id);
  }
  function listResumes() { return q('SELECT * FROM resumes ORDER BY uploaded_at DESC, rowid DESC').all().map(row => resumeRow(row)); }
  function getResume(id, withText = false) { return resumeRow(q('SELECT * FROM resumes WHERE id = ?').get(id), withText) ?? null; }
  function countResumes() { return q('SELECT COUNT(*) AS n FROM resumes').get().n; }
  function deleteResume(id) {
    if (!q('DELETE FROM resumes WHERE id = ?').run(id).changes) return false;
    resumeIndex = null;
    rematchPostings();
    return true;
  }

  // ---------- scores ----------
  const scoreRow = row => row && ({ postingId: row.posting_id, resumeId: row.resume_id, score: row.score, verdict: row.verdict,
    summary: row.summary, strengths: json(row.strengths, []), gaps: json(row.gaps, []), missingKeywords: json(row.missing_keywords, []),
    provider: row.provider, model: row.model, createdAt: row.created_at });
  function saveScore(postingIdValue, resumeId, result) {
    q(`INSERT INTO scores (posting_id, resume_id, score, verdict, summary, strengths, gaps, missing_keywords, provider, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (posting_id, resume_id) DO UPDATE SET score = excluded.score, verdict = excluded.verdict,
      summary = excluded.summary, strengths = excluded.strengths, gaps = excluded.gaps, missing_keywords = excluded.missing_keywords,
      provider = excluded.provider, model = excluded.model, created_at = excluded.created_at`).run(
      postingIdValue, resumeId, result.score, result.verdict, result.summary, JSON.stringify(result.strengths || []),
      JSON.stringify(result.gaps || []), JSON.stringify(result.missingKeywords || []), result.provider, result.model || null, iso());
    return getScore(postingIdValue, resumeId);
  }
  function getScore(postingIdValue, resumeId) { return scoreRow(q('SELECT * FROM scores WHERE posting_id = ? AND resume_id = ?').get(postingIdValue, resumeId)) ?? null; }
  function unscoredPostingIds(limit, { savedOnly = false } = {}) {
    return q(`SELECT p.id FROM postings p WHERE p.status IN (${savedOnly ? "'saved'" : "'new', 'saved'"}) AND p.duplicate_of IS NULL AND p.closed_at IS NULL
      AND p.resume_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.posting_id = p.id AND s.resume_id = p.resume_id)
      ORDER BY p.first_seen_at DESC LIMIT ?`).all(limit).map(row => row.id);
  }

  // ---------- applications ----------
  const applicationRow = row => row && ({ id: row.id, postingId: row.posting_id, company: row.company, title: row.title, jobUrl: row.job_url,
    status: row.status, appliedAt: row.applied_at, statusChangedAt: row.status_changed_at, nextFollowUpAt: row.next_follow_up_at,
    resumeId: row.resume_id, contact: row.contact, notes: row.notes, flags: json(row.flags, []), createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.closed_at !== undefined ? { postingClosedAt: row.closed_at, site: row.site, location: row.location, datePosted: row.date_posted } : {}),
    ...(row.score !== undefined ? { score: row.score } : {}) });
  const eventRow = row => ({ id: row.id, applicationId: row.application_id, at: row.at, type: row.type, fromStatus: row.from_status,
    toStatus: row.to_status, note: row.note, source: row.source });
  function addEvent(applicationId, { type, fromStatus = null, toStatus = null, note = '', source = 'user', at = iso() }) {
    q('INSERT INTO application_events (id, application_id, at, type, from_status, to_status, note, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), applicationId, at, type, fromStatus, toStatus, note, source);
  }
  function createApplication({ postingId: posting, company, title, jobUrl, appliedAt, note = '', resumeId = null, followUpDays, source = 'user' }) {
    return transaction(db, () => {
      const id = randomUUID();
      const at = iso();
      const applied = appliedAt || at;
      const followUp = followUpDays ? new Date(Date.parse(applied) + followUpDays * 864e5).toISOString() : null;
      q(`INSERT INTO applications (id, posting_id, company, title, job_url, status, applied_at, status_changed_at, next_follow_up_at, resume_id,
        notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, posting || null, company, title, jobUrl || null, applied, applied, followUp, resumeId, note, at, at);
      addEvent(id, { type: 'status', toStatus: 'applied', note, source, at: applied });
      if (posting) q("UPDATE postings SET status = 'applied' WHERE id = ? OR duplicate_of = ?").run(posting, posting);
      return getApplication(id);
    });
  }
  function getApplication(id) {
    const row = q(`SELECT a.*, p.closed_at, p.site, p.location, p.date_posted FROM applications a LEFT JOIN postings p ON p.id = a.posting_id WHERE a.id = ?`).get(id);
    if (!row) return null;
    const item = applicationRow(row);
    item.events = q('SELECT * FROM application_events WHERE application_id = ? ORDER BY at DESC, rowid DESC').all(id).map(eventRow);
    return item;
  }
  function applicationForPosting(posting) {
    const row = q('SELECT id FROM applications WHERE posting_id = ?').get(posting);
    return row ? getApplication(row.id) : null;
  }
  function listApplications({ status, open } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('a.status = ?'); params.push(status); }
    if (open) where.push(`a.status IN (${OPEN_APPLICATION_STATUSES.map(() => '?').join(', ')})`), params.push(...OPEN_APPLICATION_STATUSES);
    const rows = q(`SELECT a.*, p.closed_at, p.site, p.location, p.date_posted, s.score FROM applications a
      LEFT JOIN postings p ON p.id = a.posting_id
      LEFT JOIN scores s ON s.posting_id = a.posting_id AND s.resume_id = p.resume_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.status_changed_at DESC`).all(...params);
    return rows.map(applicationRow);
  }
  function updateApplication(id, fields, source = 'user') {
    return transaction(db, () => {
      const current = q('SELECT * FROM applications WHERE id = ?').get(id);
      if (!current) return null;
      const at = iso();
      if (fields.status && fields.status !== current.status) {
        const changedAt = fields.statusAt || at;
        q('UPDATE applications SET status = ?, status_changed_at = ?, flags = ? WHERE id = ?')
          .run(fields.status, changedAt, JSON.stringify(json(current.flags, []).filter(flag => !AUTO_FLAGS.includes(flag))), id);
        addEvent(id, { type: 'status', fromStatus: current.status, toStatus: fields.status, note: fields.note || '', source, at: changedAt });
        // Each new open stage gets a fresh follow-up date; closed stages need none.
        const days = getSettings().tracking.followUpDays;
        const followUp = OPEN_APPLICATION_STATUSES.includes(fields.status) && days ? new Date(Date.parse(changedAt) + days * 864e5).toISOString() : null;
        q('UPDATE applications SET next_follow_up_at = ? WHERE id = ?').run(followUp, id);
      } else if (fields.note) {
        addEvent(id, { type: 'note', note: fields.note, source });
      }
      if (fields.notes !== undefined) q('UPDATE applications SET notes = ? WHERE id = ?').run(fields.notes, id);
      if (fields.contact !== undefined) q('UPDATE applications SET contact = ? WHERE id = ?').run(fields.contact, id);
      if (fields.nextFollowUpAt !== undefined) {
        const flags = json(q('SELECT flags FROM applications WHERE id = ?').get(id).flags, []).filter(flag => flag !== 'follow-up-due');
        q('UPDATE applications SET next_follow_up_at = ?, flags = ? WHERE id = ?').run(fields.nextFollowUpAt, JSON.stringify(flags), id);
      }
      if (fields.appliedAt) q('UPDATE applications SET applied_at = ? WHERE id = ?').run(fields.appliedAt, id);
      q('UPDATE applications SET updated_at = ? WHERE id = ?').run(at, id);
      return getApplication(id);
    });
  }
  function setApplicationFlags(id, flags) { q('UPDATE applications SET flags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(flags), iso(), id); }
  function deleteApplication(id) {
    return transaction(db, () => {
      const row = q('SELECT posting_id FROM applications WHERE id = ?').get(id);
      if (!row) return false;
      q('DELETE FROM applications WHERE id = ?').run(id);
      if (row.posting_id) q("UPDATE postings SET status = 'saved' WHERE id = ? OR duplicate_of = ?").run(row.posting_id, row.posting_id);
      return true;
    });
  }

  // ---------- notifications ----------
  const notificationRow = row => ({ id: row.id, kind: row.kind, title: row.title, body: row.body, refId: row.ref_id, createdAt: row.created_at, read: Boolean(row.read) });
  function addNotification({ kind, title, body, refId = null }) {
    const id = randomUUID();
    q('INSERT INTO notifications (id, kind, title, body, ref_id, created_at, read) VALUES (?, ?, ?, ?, ?, ?, 0)').run(id, kind, title, body, refId, iso());
    q('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC LIMIT 300)').run();
    return notificationRow(q('SELECT * FROM notifications WHERE id = ?').get(id));
  }
  function listNotifications(limit = 50) { return q('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(limit).map(notificationRow); }
  function markNotificationsRead(id) {
    if (id) q('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
    else q('UPDATE notifications SET read = 1').run();
  }

  function stats() {
    const count = sql => q(sql).get().n;
    const byStatus = Object.fromEntries(q('SELECT status, COUNT(*) AS n FROM applications GROUP BY status').all().map(row => [row.status, row.n]));
    return {
      newPostings: count("SELECT COUNT(*) AS n FROM postings WHERE status = 'new' AND duplicate_of IS NULL"),
      savedPostings: count("SELECT COUNT(*) AS n FROM postings WHERE status = 'saved' AND duplicate_of IS NULL"),
      totalPostings: count('SELECT COUNT(*) AS n FROM postings WHERE duplicate_of IS NULL'),
      applications: byStatus,
      unreadNotifications: count('SELECT COUNT(*) AS n FROM notifications WHERE read = 0'),
    };
  }

  return {
    getSettings, updateSettings, saveSettings, getMeta, setMeta,
    listSearches, getSearch, saveSearch, deleteSearch, touchSearch,
    listCompanies, addCompany, setCompanyEnabled, deleteCompany,
    upsertPosting, listPostings, getPosting, findPostingByUrl, postingForScoring, setPostingStatus, dismissBelowScore, restoreDismissed, markChecked, markUnseenCompanyJobsClosed, purgeOldPostings,
    startRun, finishRun, updateRunScoring, listRuns, abandonRunningRuns,
    addResume, listResumes, getResume, countResumes, deleteResume, rematchPostings,
    saveScore, getScore, unscoredPostingIds,
    createApplication, getApplication, applicationForPosting, listApplications, updateApplication, setApplicationFlags, deleteApplication, addEvent,
    addNotification, listNotifications, markNotificationsRead, stats,
  };
}
