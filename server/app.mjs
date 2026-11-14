import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError, readJson, respond } from './http.mjs';
import { createNotifier, nativeNotification } from './notify.mjs';
import { openDatabase } from './jobs/db.mjs';
import { APPLICATION_STATUSES, createRepository, MAX_API_KEYS, MAX_RESUMES } from './jobs/repository.mjs';
import { createHttp } from './jobs/scrapers/http-client.mjs';
import { SITES } from './jobs/scrapers/index.mjs';
import { COUNTRIES } from './jobs/scrapers/indeed.mjs';
import { builtInJobspy, createJobspyBridge, detectJobspy } from './jobs/scrapers/jobspy-bridge.mjs';
import { fetchCompanyBoard, parseCompanyBoard } from './jobs/scrapers/company-boards.mjs';
import { findCompanyBoards } from './jobs/company-finder.mjs';
import { companyJobMatches } from './jobs/matching.mjs';
import { createSearchRunner } from './jobs/search-runner.mjs';
import { createScorer } from './jobs/scoring/index.mjs';
import { createTracker } from './jobs/tracker.mjs';
import { createScheduler } from './jobs/scheduler.mjs';
import { recommend } from './jobs/recommend.mjs';
import { createGoals } from './jobs/goals.mjs';
import { createDashboard, DASHBOARD_WEEKS } from './jobs/dashboard.mjs';
import { contactFromResume, extractProfile } from './jobs/applicant.mjs';
import { extractResumeText, MAX_RESUME_BYTES, resumeFileType, sameResume } from './jobs/resume.mjs';
import { message } from './messages.mjs';
import { createAssistant } from './assistant/index.mjs';
import { normalizeScore } from './jobs/scoring/prompt.mjs';
import { checkKey } from './jobs/scoring/anthropic-key.mjs';
import { apiKeyInput, applicationPatch, applyInput, BROWSER_ACTIONS, browserInput, goalInput, goalLogInput, goalsInput, manualApplication, manualPosting, monthParam,
  companySearch, postingStatus, publicApiKey, publicSettings, recommendInput, recommendView, searchInput, settingsPatch } from './validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
export const DEFAULT_PORT = 4318;

const flag = value => value === '1' || value === 'true';
const number = value => (value === null || value === '' ? undefined : Number.isFinite(Number(value)) ? Number(value) : undefined);

export async function createApp(options = {}) {
  const now = options.now || (() => new Date());
  const { db, filename } = openDatabase(options.dataDir || process.env.DAYJOB_DATA_DIR || path.join(root, 'data'));
  const repo = createRepository(db, { now });
  const goals = createGoals({ db, repo, now });
  const dashboard = createDashboard({ db, now });
  repo.abandonRunningRuns();
  // Databases from before multiple resumes have postings with no matched resume.
  if (repo.countResumes()) repo.rematchPostings({ missingOnly: true });
  const distDir = path.resolve(options.distDir || path.join(root, 'dist'));
  const csrfToken = randomBytes(32).toString('hex');
  const log = options.log || console.warn;
  const httpClient = options.http || createHttp({ fetch: options.fetch });
  const notify = createNotifier({ repo, desktop: options.notify || nativeNotification });
  repo.priceUsage();
  // Every AI call goes through repo.logUsage. When one takes an API key's allowance under the line, or uses the
  // last of it, the user is told, once for each.
  const logUsage = repo.logUsage;
  repo.logUsage = entry => {
    const logged = logUsage(entry);
    if (logged.alert) {
      try { notify({ kind: 'spend', ...message(repo.getSettings().language, logged.alert.level === 'empty' ? 'allowanceEmpty' : 'allowanceLow', logged.alert), refId: logged.alert.id }); }
      catch (error) { log(`[dayjob] allowance notice: ${error.message}`); }
    }
    return logged;
  };

  // JobSpy: the one inside the app (the desktop app says where it is) unless there is none or the user chose their own Python.
  let jobspy = null;
  const jobspyBuiltIn = builtInJobspy(options.jobspyDir ?? process.env.DAYJOB_JOBSPY_DIR);
  const usesBuiltIn = () => Boolean(jobspyBuiltIn) && repo.getSettings().jobspy.runner !== 'own';
  const jobspyCommand = () => (usesBuiltIn() ? jobspyBuiltIn.command : repo.getSettings().jobspy.pythonCommand || (process.platform === 'win32' ? 'python' : 'python3'));
  async function jobspyStatus(refresh = false) {
    const command = jobspyCommand();
    if (!jobspy || refresh || jobspy.command !== command) {
      const builtIn = usesBuiltIn();
      // The one inside the app was started when Dayjob was built, so opening Dayjob does not start Python just to
      // ask its version. A check the user asks for (refresh) does start it.
      jobspy = builtIn && !refresh ? { command, builtIn, available: true, version: jobspyBuiltIn.version }
        : { command, builtIn, ...(await (options.detectJobspy || detectJobspy)(command)) };
    }
    return jobspy;
  }
  const bridge = () => (options.createBridge || createJobspyBridge)({ command: jobspyCommand(), builtIn: usesBuiltIn() });
  const runner = createSearchRunner({ repo, http: httpClient, bridge, now, log });
  const scorer = options.scorer || createScorer({ repo, providers: options.providers, log });
  const tracker = createTracker({ repo, http: httpClient, now, notify, log });
  const scheduler = createScheduler({ repo, runner, scorer, tracker, notify, now, log, intervalMs: options.intervalMs });
  const configuredOrigins = options.allowedOrigins || (process.env.DAYJOB_ALLOWED_ORIGINS || 'http://localhost:5174,http://127.0.0.1:5174').split(',').filter(Boolean);
  let scoringBatch = null;
  let recommending = null;
  let readingProfile = null;

  async function sites(refresh = false) {
    const bridgeState = await jobspyStatus(refresh);
    // builtIn: Dayjob carries a JobSpy; using: the one in use is that one.
    return SITES.map(site => ({ ...site, available: site.engine === 'native' || bridgeState.available,
      ...(site.engine === 'jobspy' ? { builtIn: Boolean(jobspyBuiltIn), using: bridgeState.builtIn ? 'builtin' : 'own',
        detail: bridgeState.available ? `JobSpy ${bridgeState.version || ''}`.trim()
          : bridgeState.builtIn ? 'The JobSpy inside Dayjob did not start.' : 'Needs Python with: pip install python-jobspy',
        // What the Python that was asked answered, and that Python: "C:\\Python312\\python.exe: No module named jobspy".
        ...(!bridgeState.available && bridgeState.reason ? { reason: bridgeState.reason, command: bridgeState.command } : {}) } : {}) }));
  }
  function schedulerState() {
    return { running: scheduler.running, stopping: scheduler.stopping, phase: scheduler.phase, nextRunAt: scheduler.nextRunAt(), lastDailyRun: repo.getMeta('lastDailyRun'),
      lastTracking: repo.getMeta('lastTracking'), scoringBatch: Boolean(scoringBatch), scoringPending: scorer.pending, searchProgress: runner.progress };
  }
  async function status() {
    return { version: VERSION, serverTime: now().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      stats: repo.stats(), scheduler: schedulerState(), scoring: await scorer.status(), runs: repo.listRuns(5) };
  }
  function startScoring(ids, limit) {
    if (!scoringBatch) {
      scoringBatch = scorer.scoreBatch(ids, { limit }).then(result => {
        const language = repo.getSettings().language;
        if (result.paused && !result.scored) return result;
        if (result.scored) notify({ kind: 'scored', ...message(language, 'scored', result) });
        else if (result.reason && result.reason !== 'no-resume') notify({ kind: 'error', ...message(language, 'scoringFailed', result) });
        return result;
      }).catch(error => log(`[dayjob] scoring: ${error.message}`)).finally(() => { scoringBatch = null; });
    }
    return scoringBatch;
  }
  // In the "saved jobs" scoring mode, saving a job is the request to score it.
  function scoreIfSaved(postingId) {
    if (repo.getSettings().ai.scoreMode !== 'saved') return;
    const posting = repo.getPosting(postingId);
    if (posting?.status !== 'saved' || !posting.resumeId || posting.score) return;
    scorer.score(postingId).catch(error => log(`[dayjob] scoring ${postingId}: ${error.message}`));
  }
  // A company's own board, checked and put on the daily list. -> the company, how many jobs its board lists now
  // (listed), how many of those the enabled searches keep (matching), and whether it was on the list already.
  async function followCompany(input) {
    const board = input.url ? parseCompanyBoard(input.url) : input.ats && input.slug ? { ats: input.ats, slug: input.slug } : null;
    if (!board?.slug || !['greenhouse', 'lever', 'ashby'].includes(board.ats)) {
      throw new HttpError(400, 'Paste a Greenhouse, Lever or Ashby careers link, for example https://jobs.lever.co/company.');
    }
    let listed = null;
    let matching = null;
    try {
      const jobs = await fetchCompanyBoard({ ...board, name: input.name || board.slug }, { http: httpClient });
      const searches = repo.listSearches().filter(search => search.enabled);
      listed = jobs.length;
      matching = jobs.filter(job => searches.some(search => companyJobMatches(job, search))).length;
    } catch (error) {
      if (error.status === 404) throw new HttpError(422, `No ${board.ats} job board named "${board.slug}" was found.`);
      log(`[dayjob] company check ${board.ats}/${board.slug}: ${error.message}`);
    }
    const already = repo.listCompanies().some(company => company.ats === board.ats && company.slug === board.slug);
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : board.slug;
    return { ...repo.addCompany({ name, ...board }), listed, matching, already };
  }
  // The board a company keeps on Greenhouse, Lever or Ashby, looked for by its name or from a link (company-finder.mjs).
  const findCompany = input => findCompanyBoards(input, { http: httpClient, log,
    searches: repo.listSearches().filter(search => search.enabled), companies: repo.listCompanies() });
  function need(value, label) {
    if (!value) throw new HttpError(404, `${label} not found.`);
    return value;
  }
  // Every write carries the token /api/bootstrap handed to this window.
  function requireToken(request) {
    const supplied = Buffer.from(request.headers['x-dayjob-token'] || '');
    const expected = Buffer.from(csrfToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(403, 'Missing or invalid Dayjob token. Reload the app and try again.');
  }

  function validateRequest(request, response) {
    const port = request.socket.localPort;
    const validHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
    if (!validHosts.has(request.headers.host)) throw new HttpError(403, 'Requests must use this local Dayjob server.');
    const allowedOrigins = new Set([...configuredOrigins, ...[...validHosts].map(host => `http://${host}`)]);
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, 'This request origin is not allowed.');
    if (request.headers['sec-fetch-site'] === 'cross-site' && (!origin || !allowedOrigins.has(origin))) throw new HttpError(403, 'Cross-site requests are not allowed.');
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
  }

  function serveStatic(request, response, pathname) {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    const relative = pathname.replace(/^[/\\]+/, '');
    let file = path.resolve(distDir, relative);
    if (file !== distDir && !file.startsWith(distDir + path.sep)) throw new HttpError(403, 'Invalid file path.');
    let stat;
    try { stat = fs.statSync(file); } catch { /* SPA routes use index.html. */ }
    if (!stat?.isFile()) {
      if (path.extname(relative)) throw new HttpError(404, 'File not found.');
      file = path.join(distDir, 'index.html');
      try { stat = fs.statSync(file); } catch { throw new HttpError(503, 'The frontend is not built yet. Run npm run build, or use npm run dev.'); }
    }
    const html = path.extname(file) === '.html';
    response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size,
      'Cache-Control': html ? 'no-cache' : 'public, max-age=3600', ...(html ? { 'Content-Security-Policy': CSP } : {}) });
    if (request.method === 'HEAD') return response.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => response.destroy());
    return stream.pipe(response);
  }

  async function get(pathname, url) {
    const params = url.searchParams;
    if (pathname === '/api/bootstrap') {
      return { csrfToken, version: VERSION, dataFile: filename, serverTime: now().toISOString(), settings: publicSettings(repo.getSettings()),
        stats: repo.stats(), searches: repo.listSearches(), companies: repo.listCompanies(), sites: await sites(), resumes: repo.listResumes(),
        scoring: await scorer.status(), scheduler: schedulerState(), runs: repo.listRuns(10), applicationStatuses: APPLICATION_STATUSES,
        countries: Object.keys(COUNTRIES) };
    }
    if (pathname === '/api/status') return status();
    if (pathname === '/api/sites') return sites(flag(params.get('refresh')));
    if (pathname === '/api/scoring/status') return scorer.status(flag(params.get('refresh')));
    if (pathname === '/api/scoring/usage') return repo.usageSummary(now());
    if (pathname === '/api/usage/spend') return repo.usageSpend(now());
    if (pathname === '/api/postings') {
      return repo.listPostings({ status: params.get('status') || 'active', site: params.get('site') || undefined, q: params.get('q') || undefined,
        minScore: number(params.get('minScore')), searchId: params.get('searchId') || undefined, sort: params.get('sort') || 'posted',
        includeDuplicates: flag(params.get('includeDuplicates')), includeClosed: params.get('includeClosed') !== '0' && params.get('includeClosed') !== 'false',
        unscored: flag(params.get('unscored')), sinceDays: number(params.get('sinceDays')),
        limit: Math.min(number(params.get('limit')) || 100, 500), offset: Math.max(number(params.get('offset')) || 0, 0) });
    }
    if (pathname === '/api/postings/lookup') {
      const found = repo.findPostingByUrl(params.get('url') || '');
      if (!found) return { posting: null };
      const application = repo.applicationForPosting(found.id);
      return { posting: { id: found.id, title: found.title, company: found.company, site: found.site, status: found.status, score: found.score?.score ?? null,
        application: application && { id: application.id, status: application.status, appliedAt: application.appliedAt } } };
    }
    // Contact details read from the resumes, to start the application profile.
    if (pathname === '/api/applicant/from-resume') {
      const found = {};
      for (const resume of repo.listResumes()) {
        for (const [key, item] of Object.entries(contactFromResume(repo.getResume(resume.id, true)?.text))) found[key] ??= item;
      }
      return found;
    }
    let match = pathname.match(/^\/api\/postings\/([^/]+)$/);
    if (match) return need(repo.getPosting(match[1]), 'Posting');
    if (pathname === '/api/searches') return repo.listSearches();
    if (pathname === '/api/companies') return repo.listCompanies();
    if (pathname === '/api/resumes') return repo.listResumes();
    match = pathname.match(/^\/api\/resumes\/([^/]+)$/);
    if (match) return need(repo.getResume(match[1], true), 'Resume');
    if (pathname === '/api/recommendations') return { result: repo.getMeta('recommendations'), running: Boolean(recommending) };
    if (pathname === '/api/goals') return goals.report(monthParam(params.get('month')));
    if (pathname === '/api/dashboard') {
      const weeks = number(params.get('weeks')) || DASHBOARD_WEEKS.default;
      return dashboard.report({ weeks: Math.min(DASHBOARD_WEEKS.max, Math.max(DASHBOARD_WEEKS.min, Math.round(weeks))) });
    }
    if (pathname === '/api/runs') return repo.listRuns(Math.min(number(params.get('limit')) || 20, 100), params.get('before') || null);
    match = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (match) return need(repo.listRuns(100).find(run => run.id === match[1]), 'Run');
    if (pathname === '/api/applications') {
      const wanted = params.get('status');
      return repo.listApplications({ status: wanted && APPLICATION_STATUSES.includes(wanted) ? wanted : undefined, open: flag(params.get('open')) });
    }
    match = pathname.match(/^\/api\/applications\/([^/]+)$/);
    if (match) return need(repo.getApplication(match[1]), 'Application');
    if (pathname === '/api/notifications') return repo.listNotifications(Math.min(number(params.get('limit')) || 50, 300));
    throw new HttpError(404, 'API endpoint not found.');
  }

  async function mutate(request, pathname, method, source) {
    const input = await readJson(request, /^\/api\/resumes(\/[^/]+\/file)?$/.test(pathname) ? Math.ceil(MAX_RESUME_BYTES * 1.4) + 4096 : undefined);
    if (pathname === '/api/settings' && method === 'PATCH') {
      const settings = repo.updateSettings(settingsPatch(input));
      options.onSettings?.(settings);
      return publicSettings(settings);
    }
    // API keys: several per service, one of them in use. A key is sent back
    // only by reveal, for the person looking at Settings; the lists never
    // carry it, and none of this is open to Claude through MCP.
    const keyList = settings => { options.onSettings?.(settings); return { keys: settings.apiKeys.map(publicApiKey) }; };
    if (pathname.startsWith('/api/keys') && source === 'mcp') throw new HttpError(403, 'API keys are managed in Dayjob\'s Settings only.');
    if (pathname === '/api/keys' && method === 'POST') {
      const entry = apiKeyInput(input);
      if (repo.getSettings().apiKeys.length >= MAX_API_KEYS) throw new HttpError(409, `Dayjob keeps up to ${MAX_API_KEYS} API keys. Remove one first.`);
      const added = repo.addApiKey(entry);
      return [201, { ...keyList(added.settings), id: added.entry.id }];
    }
    let match = pathname.match(/^\/api\/keys\/([^/]+)(\/reveal|\/check)?$/);
    if (match) {
      const entry = need(repo.getApiKey(match[1]), 'API key');
      if (match[2] === '/reveal' && method === 'POST') return { key: entry.key };
      // Whether the key can be used as it is. A Claude key that works in every workspace
      // is given its workspace here when there is only one to give it.
      if (match[2] === '/check' && method === 'POST') {
        if (entry.service !== 'anthropic') throw new HttpError(400, 'Only a Claude API key can be checked.');
        const ask = options.checkKey || checkKey;
        let result = await ask({ apiKey: entry.key, workspace: entry.workspace || '' });
        let settings = repo.getSettings();
        if (result.state === 'needs-workspace' && result.workspaces?.length === 1) {
          const [only] = result.workspaces;
          const again = await ask({ apiKey: entry.key, workspace: only.id });
          if (again.state === 'ok') {
            settings = repo.updateApiKey(entry.id, { workspace: only.id });
            result = { state: 'ok', filled: only };
          }
        }
        return { ...keyList(settings), check: result };
      }
      if (!match[2] && method === 'PATCH') {
        const patch = apiKeyInput(input, { partial: true });
        if (patch.workspace && entry.service !== 'anthropic') throw new HttpError(400, 'Only a Claude API key has a workspace.');
        return keyList(repo.updateApiKey(entry.id, patch));
      }
      if (!match[2] && method === 'DELETE') return keyList(repo.deleteApiKey(entry.id));
    }
    if (pathname === '/api/searches' && method === 'POST') return [201, repo.saveSearch(searchInput(input))];
    match = pathname.match(/^\/api\/searches\/([^/]+)$/);
    if (match) {
      const current = need(repo.getSearch(match[1]), 'Search');
      if (method === 'PATCH') return repo.saveSearch(searchInput(input, current), current.id);
      if (method === 'DELETE') return { ok: repo.deleteSearch(current.id) };
    }
    if (pathname === '/api/companies/find' && method === 'POST') return findCompany(companySearch(input));
    if (pathname === '/api/companies' && method === 'POST') return [201, await followCompany(input)];
    match = pathname.match(/^\/api\/companies\/([^/]+)$/);
    if (match) {
      need(repo.listCompanies().find(company => company.id === match[1]), 'Company');
      if (method === 'PATCH') {
        if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'Enabled must be true or false.');
        return repo.setCompanyEnabled(match[1], input.enabled);
      }
      if (method === 'DELETE') return { ok: repo.deleteCompany(match[1]) };
    }
    if (pathname === '/api/runs' && method === 'POST') {
      const ids = value => (Array.isArray(value) ? value.filter(id => typeof id === 'string').slice(0, 50) : undefined);
      const searchIds = ids(input.searchIds);
      const companyIds = ids(input.companyIds);
      if (!repo.listSearches().some(search => search.enabled) && !repo.listCompanies().some(company => company.enabled)) {
        throw new HttpError(409, 'Add a search or follow a company first.');
      }
      const already = scheduler.running;
      scheduler.runNow({ searchIds, companyIds }).catch(error => log(`[dayjob] run: ${error.message}`));
      return [202, { started: !already, scheduler: schedulerState() }];
    }
    // Stops the running search and waits a little for it to wind down, so the
    // answer can say what it kept.
    if (pathname === '/api/runs/cancel' && method === 'POST') {
      const stopping = scheduler.cancel();
      if (stopping) await Promise.race([scheduler.wait(), new Promise(resolve => setTimeout(resolve, 8000))]);
      const [run] = repo.listRuns(1);
      return { stopped: stopping, run: stopping && run?.status !== 'running' ? run : null, scheduler: schedulerState() };
    }
    if (pathname === '/api/track' && method === 'POST') {
      scheduler.track().catch(error => log(`[dayjob] tracking: ${error.message}`));
      return [202, { started: true }];
    }
    if (pathname === '/api/scoring/pause' && method === 'POST') return scorer.pause();
    if (pathname === '/api/scoring/resume' && method === 'POST') {
      const ids = await scorer.resume();
      if (scoringBatch) await scoringBatch;
      if (ids.length) void startScoring(ids, ids.length);
      return { resumed: ids.length };
    }
    if (pathname === '/api/postings/dismiss-low' && method === 'POST') {
      const below = Number.isInteger(input.below) && input.below >= 1 && input.below <= 100 ? input.below : null;
      if (below === null) throw new HttpError(400, 'below must be a whole number from 1 to 100.');
      return { dismissed: repo.dismissBelowScore(below) };
    }
    if (pathname === '/api/postings/restore' && method === 'POST') {
      const ids = Array.isArray(input.ids) ? input.ids.filter(id => typeof id === 'string').slice(0, 2000) : [];
      return { restored: repo.restoreDismissed(ids) };
    }
    if (pathname === '/api/scores' && method === 'POST') {
      if (!repo.countResumes()) throw new HttpError(409, 'Upload a resume first.');
      const ids = Array.isArray(input.postingIds) ? input.postingIds.filter(id => typeof id === 'string').slice(0, 200) : undefined;
      const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 200) : undefined;
      const already = Boolean(scoringBatch);
      void startScoring(ids, limit);
      return [202, { started: !already, paused: scorer.paused }];
    }
    if (pathname === '/api/postings' && method === 'POST') {
      const item = manualPosting(input);
      const stored = repo.upsertPosting(item);
      if (input.status === 'saved') {
        repo.setPostingStatus(stored.id, 'saved');
        scoreIfSaved(stored.id);
      }
      return [201, repo.getPosting(stored.id)];
    }
    match = pathname.match(/^\/api\/postings\/([^/]+)(\/score|\/apply)?$/);
    if (match) {
      const posting = need(repo.getPosting(match[1]), 'Posting');
      if (!match[2] && method === 'PATCH') {
        if (posting.status === 'applied') throw new HttpError(409, 'This job is already tracked as an application.');
        const updated = repo.setPostingStatus(posting.id, postingStatus(input));
        scoreIfSaved(posting.id);
        return updated;
      }
      if (match[2] === '/score' && method === 'POST') {
        if (input.result !== undefined) {
          // Claude (through MCP) did the analysis itself; store it like any other score.
          if (!posting.resumeId) throw new HttpError(409, 'Upload a resume first.');
          let result;
          try { result = normalizeScore({ ...input.result, missing_keywords: input.result?.missingKeywords ?? input.result?.missing_keywords }); }
          catch (error) { throw new HttpError(400, error.message); }
          repo.saveScore(posting.id, posting.resumeId, { ...result, provider: source === 'mcp' ? 'claude-mcp' : 'manual', model: null });
          return repo.getPosting(posting.id);
        }
        if (!posting.resumeId) throw new HttpError(409, 'Upload a resume before scoring.');
        try { await scorer.score(posting.id, { force: input.force === true }); }
        catch (error) { throw new HttpError(error.status || 502, error.message); }
        return repo.getPosting(posting.id);
      }
      if (match[2] === '/apply' && method === 'POST') {
        if (repo.applicationForPosting(posting.id)) throw new HttpError(409, 'This job is already tracked.');
        const { appliedAt, note } = applyInput(input);
        const application = repo.createApplication({ postingId: posting.id, company: posting.company || 'Unknown company', title: posting.title,
          jobUrl: posting.applyUrl || posting.jobUrl, appliedAt, note, resumeId: posting.resumeId,
          followUpDays: repo.getSettings().tracking.followUpDays, source });
        return [201, application];
      }
    }
    if (pathname === '/api/applications' && method === 'POST') {
      const fields = manualApplication(input);
      return [201, repo.createApplication({ ...fields, followUpDays: repo.getSettings().tracking.followUpDays, source })];
    }
    match = pathname.match(/^\/api\/applications\/([^/]+)$/);
    if (match) {
      need(repo.getApplication(match[1]), 'Application');
      if (method === 'PATCH') return repo.updateApplication(match[1], applicationPatch(input), source);
      if (method === 'DELETE') return { ok: repo.deleteApplication(match[1]) };
    }
    if (pathname === '/api/resumes' && method === 'POST') {
      if (repo.countResumes() >= MAX_RESUMES) throw new HttpError(409, `You can keep up to ${MAX_RESUMES} resumes. Delete one before adding another.`);
      if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(input.data)) throw new HttpError(400, 'Send the resume file as base64 data.');
      const data = Buffer.from(input.data, 'base64');
      const parsed = await extractResumeText({ name: typeof input.name === 'string' ? input.name.slice(0, 200) : '', mime: typeof input.mime === 'string' ? input.mime : '', data });
      return [201, repo.addResume({ ...parsed, file: data })];
    }
    // The file for a resume that has only its text (saved before files were kept), or a newer file for it. The
    // text stays, so matches and scores stay; a file that reads as a different resume is refused unless forced.
    match = pathname.match(/^\/api\/resumes\/([^/]+)\/file$/);
    if (match && method === 'POST') {
      const resume = need(repo.getResume(match[1], true), 'Resume');
      if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(input.data)) throw new HttpError(400, 'Send the resume file as base64 data.');
      const data = Buffer.from(input.data, 'base64');
      const parsed = await extractResumeText({ name: typeof input.name === 'string' ? input.name.slice(0, 200) : '', mime: typeof input.mime === 'string' ? input.mime : '', data });
      if (input.force !== true && !sameResume(parsed.text, resume.text)) {
        throw new HttpError(409, 'This file reads as a different resume from the saved text. Add it as a new resume, or confirm to keep it with this one.');
      }
      return repo.setResumeFile(resume.id, { name: parsed.name, mime: parsed.mime, file: data });
    }
    match = pathname.match(/^\/api\/resumes\/([^/]+)$/);
    if (match && method === 'DELETE') return { ok: need(repo.deleteResume(match[1]), 'Resume') };
    if (pathname === '/api/recommendations' && method === 'POST') {
      const { preference } = recommendInput(input);
      if (!repo.countResumes()) throw new HttpError(409, 'Upload a resume first.');
      if (recommending) throw new HttpError(409, 'The AI is already suggesting searches; wait for it to finish.');
      recommending = recommend({ repo, scorer, http: httpClient, preference, now, log });
      try {
        const result = await recommending;
        repo.setMeta('recommendations', result);
        return { result, running: false };
      } catch (error) {
        throw new HttpError(error.status || 502, error.message);
      } finally { recommending = null; }
    }
    // The application profile from the whole resume, for the user to check
    // in the form; nothing is saved here.
    if (pathname === '/api/applicant/extract' && method === 'POST') {
      const resumes = repo.listResumes().map(resume => repo.getResume(resume.id, true));
      if (!resumes.length) throw new HttpError(409, 'Upload a resume first.');
      if (readingProfile) throw new HttpError(409, 'The AI is already reading the resume; wait for it to finish.');
      readingProfile = extractProfile({ resumes, scorer, log });
      try { return await readingProfile; } finally { readingProfile = null; }
    }
    // Closing the suggestions keeps them, so they can be shown again; the
    // next suggestions start open.
    if (pathname === '/api/recommendations' && method === 'PATCH') {
      const { hidden } = recommendView(input);
      const result = need(repo.getMeta('recommendations'), 'Suggestion');
      repo.setMeta('recommendations', { ...result, hidden });
      return { result: { ...result, hidden }, running: Boolean(recommending) };
    }
    if (pathname === '/api/goals' && method === 'PUT') {
      const { month, goals: items } = goalsInput(input);
      return goals.save(month, items);
    }
    if (pathname === '/api/goals/goal' && method === 'POST') {
      const { month, goal } = goalInput(input);
      try { return goals.set(month, goal); } catch (error) { throw new HttpError(409, error.message); }
    }
    match = pathname.match(/^\/api\/goals\/([^/]+)\/log$/);
    if (match && method === 'POST') {
      const { amount } = goalLogInput(input);
      need(goals.find(match[1]), 'Goal');
      try { return goals.log(match[1], amount); } catch (error) { throw new HttpError(409, error.message); }
    }
    match = pathname.match(/^\/api\/browser\/([a-z]+)$/);
    if (match && method === 'POST' && BROWSER_ACTIONS.includes(match[1])) {
      // options.browser is the desktop app's browser; plain `npm start` has none.
      if (!options.browser) throw new HttpError(503, 'The Dayjob browser is part of the Dayjob desktop app. Ask the user to open Dayjob from the Start menu.');
      const action = browserInput(match[1], input);
      try { return await options.browser.run(match[1], action); }
      catch (error) { throw new HttpError(error.status || 500, error.status ? error.message : `The Dayjob browser failed: ${error.message}`); }
    }
    if (pathname === '/api/notifications/read' && method === 'POST') {
      repo.markNotificationsRead(typeof input.id === 'string' ? input.id : null);
      return { ok: true };
    }
    throw new HttpError(404, 'API endpoint not found.');
  }

  const assistant = createAssistant({ db, repo, scheduler, goals, dashboard, status, scoreIfSaved, now, log, engines: options.assistantEngines,
    companies: { find: findCompany, follow: followCompany },
    browser: options.browser || null, onSettings: settings => options.onSettings?.(settings),
    baseUrl: () => `http://127.0.0.1:${server.address().port}` });

  // 自动收录: an application the Dayjob browser saw go through (something was sent from an application form and the
  // page then said so). urls: the pages that tab went through, newest first; draft: what a job page there said
  // about the job. The posting is the one Dayjob has for one of those pages, else a new one made from the draft.
  // A tab passes other jobs on its way, so the job must be named (its company or its title) in words: what the
  // application form and the page after it said. named: the user typed the job, which settles it.
  //   recorded  tracked from now on (created: the posting is new too)
  //   already   this job was tracked before
  //   unsure    there is a job (guess), but neither page named it
  //   unknown   no posting, and no job page that says which job it was
  function trackApplied({ urls = [], draft = null, by = 'user', words, page = '', named = false } = {}) {
    const flat = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const said = flat(words);
    const says = value => { const wanted = flat(value); return wanted.length >= 3 && said.includes(wanted); };
    // Without the pages' words (a caller that knows the job) there is nothing to check against.
    const about = item => words === undefined || says(item.company) || says(item.title);
    const brief = application => ({ id: application.id, company: application.company, title: application.title, appliedAt: application.appliedAt });
    const already = (application, posting) => ({ status: 'already', application: brief(application), posting: { id: posting.id } });
    let posting = null;
    for (const url of urls.slice(0, 12)) {
      posting = repo.findPostingByUrl(String(url));
      if (posting) break;
    }
    let jobUrl = draft?.url;
    if (posting && named && !(flat(posting.title) === flat(draft?.title) && flat(posting.company) === flat(draft?.company))) {
      // The user named another job than the one whose page the tab went through: it gets a posting of its own,
      // under the address of the application form.
      jobUrl = [page, ...urls].find(url => url && !repo.findPostingByUrl(String(url)));
      posting = null;
    } else if (posting && !named && !about(posting)) return { status: 'unsure', guess: { title: posting.title, company: posting.company || '' } };
    let created = false;
    if (posting) {
      const existing = repo.applicationForPosting(posting.id);
      if (existing) return already(existing, posting);
    } else {
      if (!draft?.structured || !draft.title || !draft.company || !jobUrl) return { status: 'unknown' };
      if (!named && !about(draft)) return { status: 'unsure', guess: { title: String(draft.title).slice(0, 240), company: String(draft.company).slice(0, 160) } };
      let item;
      try {
        const jobType = [].concat(draft.employmentType || []).map(type => ({ FULL_TIME: 'fulltime', PART_TIME: 'parttime', CONTRACTOR: 'contract', CONTRACT: 'contract', INTERN: 'internship', INTERNSHIP: 'internship', TEMPORARY: 'temporary' })[String(type).toUpperCase()]).find(Boolean);
        const own = jobUrl === draft.url;
        item = manualPosting({ title: String(draft.title).slice(0, 240), company: String(draft.company).slice(0, 160), location: own ? String(draft.location || '').slice(0, 160) || undefined : undefined,
          jobUrl, description: own ? String(draft.description || '').slice(0, 100000) || undefined : undefined, datePosted: own ? /^\d{4}-\d\d-\d\d/.exec(draft.datePosted || '')?.[0] || undefined : undefined,
          jobType: own ? jobType || undefined : undefined, ...(own && draft.remote ? { isRemote: true } : {}) });
      } catch { return { status: 'unknown' }; }
      posting = repo.getPosting(repo.upsertPosting(item).id);
      const existing = repo.applicationForPosting(posting.id);
      if (existing) return already(existing, posting);
      created = true;
    }
    const chinese = repo.getSettings().language === 'zh';
    const who = by === 'assistant' ? (chinese ? '助手' : 'the assistant') : by === 'claude' ? 'Claude' : (chinese ? '你' : 'you');
    const note = chinese ? `自动收录：${who}在 Dayjob 浏览器里提交后，网页显示申请已收到。` : `Recorded automatically: after ${who} sent it in the Dayjob browser, the page said the application was received.`;
    const application = repo.createApplication({ postingId: posting.id, company: posting.company || 'Unknown company', title: posting.title, jobUrl: posting.applyUrl || posting.jobUrl,
      note, resumeId: posting.resumeId, followUpDays: repo.getSettings().tracking.followUpDays, source: 'auto' });
    return { status: 'recorded', created, application: brief(application), posting: { id: posting.id } };
  }

  const server = http.createServer(async (request, response) => {
    try {
      validateRequest(request, response);
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = request.method;
      if (method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Dayjob-Token, X-Dayjob-Client' });
        return response.end();
      }
      if (!pathname.startsWith('/api/')) return serveStatic(request, response, pathname);
      // The in-app assistant answers for itself: its replies are streamed, and Claude Code reaches its tools here.
      if (pathname.startsWith('/api/assistant')) return await assistant.http({ request, response, pathname, method, authorize: () => requireToken(request) });
      // A resume's own file, to look at or save. Always a download, under the type Dayjob read it as (never the
      // type the upload claimed), so it cannot open as a page of Dayjob.
      const resumeFile = method === 'GET' && pathname.match(/^\/api\/resumes\/([^/]+)\/file$/);
      if (resumeFile) {
        const file = need(repo.getResumeFile(resumeFile[1]), 'Resume file');
        response.writeHead(200, { 'Content-Type': resumeFileType(file.name, file.mime)?.mime || 'application/octet-stream', 'Content-Length': file.data.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        return response.end(file.data);
      }
      if (method === 'GET') return respond(response, 200, await get(pathname, url));
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new HttpError(405, 'Method not allowed.');
      requireToken(request);
      const result = await mutate(request, pathname, method, request.headers['x-dayjob-client'] === 'mcp' ? 'mcp' : 'user');
      const [code, value] = Array.isArray(result) ? result : [200, result];
      return respond(response, code, value);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (!(error instanceof HttpError) && !(error instanceof URIError)) console.error('[Dayjob]', error);
      respond(response, error instanceof URIError ? 400 : error.status || 500,
        { error: error instanceof URIError ? 'Malformed URL.' : error.status ? error.message : 'An unexpected server error occurred.' });
    }
  });
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 15000;
  let listening = false;
  return {
    server, repo, scheduler, scorer, assistant, filename, trackApplied,
    // Which JobSpy is in use and whether it starts: { command, builtIn, available, version }. refresh starts it to see.
    jobspy: (refresh = false) => jobspyStatus(refresh),
    async listen(port = Number(process.env.DAYJOB_PORT || DEFAULT_PORT)) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      listening = true;
      if (options.startScheduler !== false) scheduler.start();
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      scheduler.stop();
      // A search still going is stopped, as "click again to stop" does: what it found stays, and the Python that
      // JobSpy runs in ends now instead of minutes later (it would keep an update from replacing Dayjob's files).
      scheduler.cancel();
      assistant.close();
      // A request still running (a fetch or a scoring call can take minutes) or stuck halfway would hold the close
      // forever, since Node stops its request timeouts once the server closes. After a second every connection is dropped.
      if (listening) {
        await new Promise(resolve => {
          const drop = setTimeout(() => server.closeAllConnections(), 1000);
          server.close(() => { clearTimeout(drop); resolve(); });
          server.closeIdleConnections();
        });
      }
      listening = false;
      // Let an in-flight run record its result, but never hold shutdown long.
      await Promise.race([scheduler.wait(), new Promise(resolve => setTimeout(resolve, 3000))]);
      try { db.close(); } catch { /* Already closed. */ }
    },
  };
}

export async function start(options) {
  const app = await createApp(options);
  const url = await app.listen(options?.port);
  return { ...app, url };
}
