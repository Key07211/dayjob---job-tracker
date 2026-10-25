import { BOARD_SCRAPERS, JOBSPY_SITES } from './scrapers/index.mjs';
import { fetchCompanyBoard } from './scrapers/company-boards.mjs';
import { boardQuery, companyJobMatches, passesFilters } from './matching.mjs';
import { postingId } from './normalize.mjs';

const COMPANY_DELAY_MS = 800;

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

  async function searchOne(search, detail, totals, newIds, { http, signal }) {
    const input = { keywords: boardQuery(search.keywords), location: search.location, distance: search.distance, hoursOld: search.hoursOld,
      jobType: search.jobType, isRemote: search.isRemote, resultsWanted: search.resultsWanted, country: search.country };
    for (const site of search.sites) {
      if (signal?.aborted) return;
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
          kept += 1;
          if (stored.isNew) { fresh += 1; newIds.add(stored.id); }
        }
        totals.found += kept;
        totals.newCount += fresh;
        detail.push({ source, found: kept, new: fresh, warnings: result.warnings || [] });
      } catch (error) {
        if (signal?.aborted) return;
        detail.push({ source, error: error.message, blocked: Boolean(error.blocked) });
      }
      if (progress) progress.done += 1;
    }
    repo.touchSearch(search.id);
  }

  async function companies(searches, detail, totals, newIds, { http, signal }) {
    const list = repo.listCompanies().filter(company => company.enabled);
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
          let stored;
          for (const search of matches) stored = repo.upsertPosting(item, search.id);
          kept += 1;
          if (stored.isNew) { fresh += 1; newIds.add(stored.id); }
        }
        const closed = repo.markUnseenCompanyJobsClosed(company.ats, company.slug, seenIds);
        totals.found += kept;
        totals.newCount += fresh;
        detail.push({ source, found: kept, new: fresh, listed: jobs.length, closed: closed.length });
      } catch (error) {
        if (signal?.aborted) return;
        detail.push({ source, error: error.message });
      }
      if (progress) progress.done += 1;
    }
  }

  async function execute({ trigger, searchIds, signal }) {
    const http = stoppable(sharedHttp, signal);
    const runId = repo.startRun('search', trigger);
    const detail = [];
    const totals = { found: 0, newCount: 0 };
    const newIds = new Set();
    let searches = repo.listSearches().filter(search => search.enabled);
    if (searchIds?.length) searches = searches.filter(search => searchIds.includes(search.id));
    const boards = searchIds?.length ? 0 : repo.listCompanies().filter(company => company.enabled).length;
    progress = { done: 0, total: searches.reduce((sum, search) => sum + search.sites.length, 0) + boards };
    try {
      for (const search of searches) await searchOne(search, detail, totals, newIds, { http, signal });
      if (!searchIds?.length) await companies(searches, detail, totals, newIds, { http, signal });
    } catch (error) {
      if (!signal?.aborted) detail.push({ source: 'dayjob', error: error.message });
    }
    const failures = detail.filter(entry => entry.error).length;
    let status = !detail.length ? 'succeeded' : failures === detail.length ? 'failed' : failures ? 'partial' : 'succeeded';
    if (!searches.length) detail.push({ source: 'dayjob', warning: 'No enabled searches yet.' });
    // A stopped run counts as part done, and says so.
    if (signal?.aborted) {
      detail.push({ source: 'dayjob', warning: 'Stopped before it finished.', cancelled: true });
      if (status === 'succeeded') status = 'partial';
    }
    const run = repo.finishRun(runId, { status, found: totals.found, newCount: totals.newCount, detail });
    return { run, newIds: [...newIds] };
  }

  return {
    get active() { return Boolean(active); },
    get progress() { return active && progress ? { ...progress } : null; },
    run(options = {}) {
      if (!active) active = execute({ trigger: options.trigger || 'manual', searchIds: options.searchIds, signal: options.signal }).finally(() => { active = null; progress = null; });
      return active;
    },
  };
}
