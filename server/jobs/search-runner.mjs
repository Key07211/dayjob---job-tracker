import { BOARD_SCRAPERS, JOBSPY_SITES, SITE_IDS } from './scrapers/index.mjs';
import { fetchCompanyBoard } from './scrapers/company-boards.mjs';
import { boardQuery, companyJobMatches, passesFilters } from './matching.mjs';
import { postingId } from './normalize.mjs';
import { sourcePlan } from './source-quota.mjs';

const COMPANY_DELAY_MS = 800;

// A board answers with its best matches first, and those are much the same from one day to the next. So the jobs
// Dayjob already holds, and those the search's own filters turn away, do not count toward the number a search asks
// for: the search reads on past them, this far at most, until it has that many jobs it did not have.
export const lookPast = wanted => Math.min(200, Math.max(50, wanted * 3));

// Where the jobs a run found went, each job once however many searches found it.
const OUTCOME = { new: 'listed', saved: 'saved', dismissed: 'removed', applied: 'applied' };
const emptyTotals = () => ({ seen: new Set(), outcome: { new: 0, listed: 0, saved: 0, removed: 0, applied: 0, duplicates: 0 } });
function tally(totals, stored) {
  if (totals.seen.has(stored.id)) return;
  totals.seen.add(stored.id);
  totals.outcome[stored.isNew ? 'new' : stored.duplicate ? 'duplicates' : OUTCOME[stored.was] || 'listed'] += 1;
}

// The shared HTTP client, for one run: its requests and its waits end as soon as the run is stopped.
function stoppable(http, signal) {
  if (!signal) return http;
  return {
    request: (url, options = {}) => http.request(url, { ...options, signal }),
    sleep: ms => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
      http.sleep(ms).then(() => { signal.removeEventListener('abort', stop); resolve(); });
    }),
  };
}

// Runs every enabled search on its boards, then every followed company board,
// and stores what it finds. One run at a time; a second request joins it.
// Stopping a run (its signal) keeps what was already found.
export function createSearchRunner({ repo, http: sharedHttp, bridge, now = () => new Date(), log = console.warn }) {
  let active = null;
  // Sources searched so far in the running search: each search on each site, then each company board.
  let progress = null;

  // wanted: how many results this search asks of each of its boards in this run (source-quota.mjs). A board with 0 is left out.
  // LinkedIn and Indeed are told which jobs Dayjob already holds, so they read past those (JobSpy's sites are asked as before).
  async function searchOne(search, wanted, detail, totals, newIds, { http, signal }) {
    const base = { keywords: boardQuery(search.keywords), location: search.location, distance: search.distance, hoursOld: search.hoursOld,
      jobType: search.jobType, isRemote: search.isRemote, country: search.country };
    for (const site of search.sites) {
      if (signal?.aborted) return;
      if (!wanted[site]) continue;
      const input = { ...base, resultsWanted: wanted[site], known: id => repo.holdsPosting(site, id),
        rejects: item => !passesFilters(item, search), lookPast: lookPast(wanted[site]) };
      const source = `${search.name} · ${site}`;
      try {
        let result;
        if (BOARD_SCRAPERS[site]) result = await BOARD_SCRAPERS[site].search(input, { http, log: message => log(`[dayjob] ${message}`) });
        else if (JOBSPY_SITES.includes(site)) result = await bridge().search(site, input, { log: message => log(`[dayjob] ${message}`), signal });
        else throw new Error(`Unknown site ${site}.`);
        let kept = 0;
        let fresh = 0;
        for (const item of result.postings) {
          if (!passesFilters(item, search)) continue;
          const stored = repo.upsertPosting(item, search.id);
          tally(totals, stored);
          kept += 1;
          if (stored.isNew) { fresh += 1; newIds.add(stored.id); }
        }
        detail.push({ source, found: kept, new: fresh, asked: wanted[site], warnings: result.warnings || [] });
      } catch (error) {
        if (signal?.aborted) return;
        detail.push({ source, error: error.message, blocked: Boolean(error.blocked) });
      }
      if (progress) progress.done += 1;
    }
    repo.touchSearch(search.id);
  }

  async function companies(list, searches, detail, totals, newIds, { http, signal }) {
    for (const [index, company] of list.entries()) {
      if (signal?.aborted) return;
      if (index) { try { await http.sleep(COMPANY_DELAY_MS); } catch { return; } }
      const source = `${company.name} · ${company.ats}`;
      try {
        const jobs = await fetchCompanyBoard(company, { http, log: message => log(`[dayjob] ${message}`) });
        let kept = 0;
        let fresh = 0;
        const seenIds = [];
        for (const item of jobs) {
          seenIds.push(postingId(item));
          const matches = searches.filter(search => companyJobMatches(item, search, now()));
          if (!matches.length) continue;
          // The first search to store it says whether the job is new; the others only add their name to it.
          const [stored] = matches.map(search => repo.upsertPosting(item, search.id));
          tally(totals, stored);
          kept += 1;
          if (stored.isNew) { fresh += 1; newIds.add(stored.id); }
        }
        const closed = repo.markUnseenCompanyJobsClosed(company.ats, company.slug, seenIds);
        detail.push({ source, found: kept, new: fresh, listed: jobs.length, closed: closed.length });
      } catch (error) {
        if (signal?.aborted) return;
        detail.push({ source, error: error.message });
      }
      if (progress) progress.done += 1;
    }
  }

  // searchIds, companyIds: only these searches and these followed companies; with neither, everything that is switched on.
  async function execute({ trigger, searchIds, companyIds, signal }) {
    const http = stoppable(sharedHttp, signal);
    const runId = repo.startRun('search', trigger);
    const detail = [];
    const totals = emptyTotals();
    const newIds = new Set();
    const enabled = repo.listSearches().filter(search => search.enabled);
    // Each board's number is divided among every enabled search, so a search run on its own asks for what it asks for in the daily run.
    const plan = sourcePlan(repo.getSettings().sources, enabled, SITE_IDS);
    const some = Boolean(searchIds?.length || companyIds?.length);
    const searches = some ? enabled.filter(search => searchIds?.includes(search.id)) : enabled;
    const boards = repo.listCompanies().filter(company => company.enabled && (!some || companyIds?.includes(company.id)));
    const asking = search => search.sites.filter(site => plan.forSearch(search.id)[site]).length;
    progress = { done: 0, total: searches.reduce((sum, search) => sum + asking(search), 0) + boards.length };
    try {
      for (const search of searches) await searchOne(search, plan.forSearch(search.id), detail, totals, newIds, { http, signal });
      // A company's jobs are kept when they match any enabled search, whichever searches this run asked the boards for.
      await companies(boards, enabled, detail, totals, newIds, { http, signal });
    } catch (error) {
      if (!signal?.aborted) detail.push({ source: 'dayjob', error: error.message });
    }
    const failures = detail.filter(entry => entry.error).length;
    let status = !detail.length ? 'succeeded' : failures === detail.length ? 'failed' : failures ? 'partial' : 'succeeded';
    if (!enabled.length) detail.push({ source: 'dayjob', warning: 'No enabled searches yet.' });
    // A stopped run counts as part done, and says so.
    if (signal?.aborted) {
      detail.push({ source: 'dayjob', warning: 'Stopped before it finished.', cancelled: true });
      if (status === 'succeeded') status = 'partial';
    }
    // found: the different jobs this run came across; a job two searches found counts once.
    const run = repo.finishRun(runId, { status, found: totals.seen.size, newCount: totals.outcome.new, detail, outcome: totals.outcome });
    return { run, newIds: [...newIds] };
  }

  return {
    get active() { return Boolean(active); },
    get progress() { return active && progress ? { ...progress } : null; },
    run(options = {}) {
      if (!active) active = execute({ trigger: options.trigger || 'manual', searchIds: options.searchIds, companyIds: options.companyIds, signal: options.signal }).finally(() => { active = null; progress = null; });
      return active;
    },
  };
}
