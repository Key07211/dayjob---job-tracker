import { BOARD_SCRAPERS, JOBSPY_SITES } from './scrapers/index.mjs';
import { fetchCompanyBoard } from './scrapers/company-boards.mjs';
import { boardQuery, companyJobMatches, passesFilters } from './matching.mjs';
import { postingId } from './normalize.mjs';

const COMPANY_DELAY_MS = 800;

// Runs every enabled search on its boards, then every followed company board,
// and stores what it finds. One run at a time; a second request joins it.
export function createSearchRunner({ repo, http, bridge, now = () => new Date(), log = console.warn }) {
  let active = null;
  // Sources searched so far in the running search: each search on each site, then each company board.
  let progress = null;

  async function searchOne(search, detail, totals, newIds) {
    const input = { keywords: boardQuery(search.keywords), location: search.location, distance: search.distance, hoursOld: search.hoursOld,
      jobType: search.jobType, isRemote: search.isRemote, resultsWanted: search.resultsWanted, country: search.country };
    for (const site of search.sites) {
      const source = `${search.name} · ${site}`;
      try {
        let result;
        if (BOARD_SCRAPERS[site]) result = await BOARD_SCRAPERS[site].search(input, { http, log: message => log(`[dayjob] ${message}`) });
        else if (JOBSPY_SITES.includes(site)) result = await bridge().search(site, input, { log: message => log(`[dayjob] ${message}`) });
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
        detail.push({ source, error: error.message, blocked: Boolean(error.blocked) });
      }
      if (progress) progress.done += 1;
    }
    repo.touchSearch(search.id);
  }

  async function companies(searches, detail, totals, newIds) {
    const list = repo.listCompanies().filter(company => company.enabled);
    for (const [index, company] of list.entries()) {
      if (index) await http.sleep(COMPANY_DELAY_MS);
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
        detail.push({ source, error: error.message });
      }
      if (progress) progress.done += 1;
    }
  }

  async function execute({ trigger, searchIds }) {
    const runId = repo.startRun('search', trigger);
    const detail = [];
    const totals = { found: 0, newCount: 0 };
    const newIds = new Set();
    let searches = repo.listSearches().filter(search => search.enabled);
    if (searchIds?.length) searches = searches.filter(search => searchIds.includes(search.id));
    const boards = searchIds?.length ? 0 : repo.listCompanies().filter(company => company.enabled).length;
    progress = { done: 0, total: searches.reduce((sum, search) => sum + search.sites.length, 0) + boards };
    try {
      for (const search of searches) await searchOne(search, detail, totals, newIds);
      if (!searchIds?.length) await companies(searches, detail, totals, newIds);
    } catch (error) {
      detail.push({ source: 'dayjob', error: error.message });
    }
    const failures = detail.filter(entry => entry.error).length;
    const status = !detail.length ? 'succeeded' : failures === detail.length ? 'failed' : failures ? 'partial' : 'succeeded';
    if (!searches.length) detail.push({ source: 'dayjob', warning: 'No enabled searches yet.' });
    const run = repo.finishRun(runId, { status, found: totals.found, newCount: totals.newCount, detail });
    return { run, newIds: [...newIds] };
  }

  return {
    get active() { return Boolean(active); },
    get progress() { return active && progress ? { ...progress } : null; },
    run(options = {}) {
      if (!active) active = execute({ trigger: options.trigger || 'manual', searchIds: options.searchIds }).finally(() => { active = null; progress = null; });
      return active;
    },
  };
}
