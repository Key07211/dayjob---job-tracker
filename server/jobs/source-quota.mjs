// How many results each job board is asked for in one run. Three ways, chosen under Settings:
//   search  each search's own "results per source", as it always was
//   count   a number for each board, for the whole run
//   share   one number for the whole run, divided between the boards by their shares
// In count and share a board's number is divided evenly among the enabled searches that tick the board.
// Company boards are not counted: their open jobs are always read in full.
// No imports: the Settings page works out the same numbers to show them.
export const SOURCE_MODES = ['search', 'count', 'share'];
// The most one search may ask of one board.
export const SEARCH_LIMIT = 200;
export const COUNT_MAX = 1000;
export const TOTAL_MAX = 2000;
export const SHARE_MAX = 100;
export const DEFAULT_COUNT = 25;
export const DEFAULT_SHARE = 1;
export const DEFAULT_SOURCES = { mode: 'search', total: 100, counts: {}, shares: {} };

const whole = (value, fallback, max) => (Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback);
export const countOf = (sources, site) => whole(sources?.counts?.[site], DEFAULT_COUNT, COUNT_MAX);
export const shareOf = (sources, site) => whole(sources?.shares?.[site], DEFAULT_SHARE, SHARE_MAX);
export const totalOf = sources => Math.max(1, whole(sources?.total, DEFAULT_SOURCES.total, TOTAL_MAX));

// Divides a whole number by weights. What rounding leaves over goes to the largest remainders, earlier ones first.
export function divide(total, weights) {
  const sum = weights.reduce((all, weight) => all + weight, 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map(weight => (total * weight) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((all, part) => all + part, 0);
  const order = exact.map((value, index) => [value - Math.floor(value), index]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, index] of order) {
    if (!left) break;
    parts[index] += 1;
    left -= 1;
  }
  return parts;
}

// searches: the enabled searches, in their order. siteIds: every board Dayjob knows.
// -> { mode, total, sites: { [site]: { searches, wanted, asked, percent } }, forSearch(id) -> { [site]: number } }
//    wanted: the board's number for the run; asked: what the searches really ask for (a search asks for at most 200);
//    percent: the board's part of the run, in share mode.
export function sourcePlan(sources, searches, siteIds) {
  const mode = SOURCE_MODES.includes(sources?.mode) ? sources.mode : 'search';
  const users = Object.fromEntries(siteIds.map(site => [site, searches.filter(search => search.sites.includes(site))]));
  const used = siteIds.filter(site => users[site].length);
  const wanted = {};
  const percent = {};
  if (mode === 'count') for (const site of siteIds) wanted[site] = countOf(sources, site);
  if (mode === 'share') {
    const weights = used.map(site => shareOf(sources, site));
    const sum = weights.reduce((all, weight) => all + weight, 0);
    const parts = divide(totalOf(sources), weights);
    used.forEach((site, index) => {
      wanted[site] = parts[index];
      percent[site] = sum ? Math.round((weights[index] / sum) * 100) : 0;
    });
  }
  const perSearch = new Map(searches.map(search => [search.id, {}]));
  const sites = {};
  let total = 0;
  for (const site of siteIds) {
    const each = mode === 'search' ? users[site].map(search => search.resultsWanted) : divide(wanted[site] ?? 0, users[site].map(() => 1));
    let asked = 0;
    users[site].forEach((search, index) => {
      const number = Math.min(each[index], SEARCH_LIMIT);
      perSearch.get(search.id)[site] = number;
      asked += number;
    });
    sites[site] = { searches: users[site].length, wanted: mode === 'search' ? asked : wanted[site] ?? 0, asked, ...(mode === 'share' ? { percent: percent[site] ?? 0 } : {}) };
    total += asked;
  }
  return { mode, total, sites, forSearch: id => perSearch.get(id) || {} };
}
