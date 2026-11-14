// Finds the job board a company keeps on Greenhouse, Lever or Ashby, which Dayjob can then follow every day:
// from a link to the board or to one of its jobs, from the careers page on the company's own website (the page
// names the board it uses), or from the company's name.
import { BOARDS, parseCompanyBoard } from './scrapers/company-boards.mjs';
import { companyJobMatches, titleMatches } from './matching.mjs';

const ATS = Object.keys(BOARDS);
const HEADERS = { accept: 'application/json', 'user-agent': 'Dayjob/0.1 (personal job tracker)' };
const PAGE_HEADERS = { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Dayjob/0.1 (personal job tracker)' };
const PAGE_CAP = 1500000;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// Words of a board's address that are not a company.
const NOT_A_SLUG = new Set(['embed', 'v0', 'v1', 'api', 'js', 'jobs', 'job_board', 'postings', 'posting-api', 'job-board', 'boards', 'careers', 'static', 'assets', 'www']);
const SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'ag', 'sa', 'bv', 'pbc', 'lp', 'llp', 'holdings']);
const BOARD_HOSTS = /^(?:(?:job-)?boards(?:-api)?(?:\.eu)?\.greenhouse\.io|(?:jobs|api)(?:\.eu)?\.lever\.co|(?:jobs|api)\.ashbyhq\.com)$/i;
export const BOARD_LINKS = { greenhouse: slug => `https://job-boards.greenhouse.io/${slug}`, lever: slug => `https://jobs.lever.co/${slug}`, ashby: slug => `https://jobs.ashbyhq.com/${slug}` };

// "Scale AI, Inc." -> scaleai, scale-ai, scale: the ids a board for that company usually has.
export function slugCandidates(name) {
  const words = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’`.]/g, '').replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/).filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words.at(-1))) words.pop();
  if (!words.length) return [];
  const list = [words.join(''), words.join('-')];
  if (words.includes('and')) list.push(words.filter(word => word !== 'and').join(''));
  if (words.length > 1 && words[0].length >= 3) list.push(words[0]);
  return [...new Set(list)].filter(slug => SLUG.test(slug)).slice(0, 4);
}

// A page on the open web: https or http, a named host, and nothing on this computer or the local network.
export function publicPage(link) {
  let url;
  try { url = new URL(/^[a-z][\w+.-]*:\/\//i.test(link) ? link : `https://${link}`); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || /^[\d.]+$/.test(host) || host.includes(':') || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)) return null;
  return url;
}

// The boards a web page links to or embeds.
export function boardLinks(html) {
  const text = String(html || '').slice(0, PAGE_CAP).replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
  const found = new Map();
  for (const match of text.matchAll(/(?:https?:)?\/\/([a-z0-9.-]*(?:greenhouse\.io|lever\.co|ashbyhq\.com))(\/[^\s"'<>\\)]*)?/gi)) {
    // The hosts that carry boards; the vendors' own sites (www.greenhouse.io, lever.co) are not one.
    if (!BOARD_HOSTS.test(match[1])) continue;
    const board = parseCompanyBoard(`https://${match[1]}${match[2] || ''}`);
    if (!board?.slug || !SLUG.test(board.slug) || NOT_A_SLUG.has(board.slug.toLowerCase())) continue;
    const key = `${board.ats}:${board.slug.toLowerCase()}`;
    found.set(key, { ...board, count: (found.get(key)?.count || 0) + 1 });
  }
  // The board the page names most often first.
  return [...found.values()].sort((a, b) => b.count - a.count).map(({ ats, slug }) => ({ ats, slug })).slice(0, 4);
}

const jobCard = item => ({ title: item.title, location: item.location || [item.city, item.state].filter(Boolean).join(', ') || null,
  ...(item.isRemote ? { remote: true } : {}), url: item.jobUrl, posted: item.datePosted ? String(item.datePosted).slice(0, 10) : null });

// One board, read: null when there is no such board.
async function readBoard({ ats, slug }, name, { http }) {
  const response = await http.request(BOARDS[ats].url(slug), { headers: HEADERS, expect: 'text', allowStatus: [400, 404, 410] });
  if (response.status !== 200) return null;
  let body;
  try { body = JSON.parse(response.body); } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  const jobs = BOARDS[ats].parse({ ats, slug, name: name || slug }, body);
  // Greenhouse says whose board it is; the others are known by their address only.
  const own = ats === 'greenhouse' ? body.jobs?.find(job => job.company_name)?.company_name : null;
  return { ats, slug, name: own || name || slug, jobs };
}

// input: { company?, url?, keywords?, limit? }; at least one of company and url.
// -> { boards: [{ ats, slug, name, link, open, matchingSearches, matchingKeywords?, jobs, followed }], looked: [...], note? }
// searches: the enabled saved searches (a followed board's jobs are kept when they match one of them).
export async function findCompanyBoards(input, { http, searches = [], companies = [], log = () => {} }) {
  const limit = input.limit || 8;
  const looked = [];
  const notes = [];
  let targets = [];
  let name = String(input.company || '').trim();
  if (input.url) {
    const direct = parseCompanyBoard(input.url);
    if (direct?.slug && SLUG.test(direct.slug) && !NOT_A_SLUG.has(direct.slug.toLowerCase())) targets = [[direct]];
    else {
      const page = publicPage(input.url);
      if (!page) notes.push('That link is not a web page Dayjob can read.');
      else {
        try {
          const response = await http.request(page.href, { headers: PAGE_HEADERS, expect: 'text' });
          const links = boardLinks(response.body);
          looked.push(`${page.host}: ${links.length ? links.map(link => `${link.ats}/${link.slug}`).join(', ') : 'no board link in the page'}`);
          targets = links.map(link => [link]);
        } catch (error) {
          looked.push(`${page.host}: ${error.message}`);
        }
        // The site's own name is the next guess: careers.acme.com -> acme.
        if (!name) name = page.hostname.replace(/^(www|careers|jobs|boards|work|join)\./, '').split('.')[0];
      }
    }
  }
  // By name: each kind of board, trying the usual ids in turn until one exists.
  if (!targets.length && name) targets = ATS.map(ats => slugCandidates(name).map(slug => ({ ats, slug })));
  const boards = (await Promise.all(targets.map(async candidates => {
    for (const candidate of candidates) {
      try {
        const board = await readBoard(candidate, name, { http });
        looked.push(`${candidate.ats}/${candidate.slug}: ${board ? `${board.jobs.length} open` : 'no such board'}`);
        if (board) return board;
      } catch (error) {
        looked.push(`${candidate.ats}/${candidate.slug}: ${error.message}`);
        log(`[dayjob] board ${candidate.ats}/${candidate.slug}: ${error.message}`);
      }
    }
    return null;
  }))).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const board of boards) {
    const key = `${board.ats}:${board.slug.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const matching = board.jobs.filter(job => searches.some(search => companyJobMatches(job, search)));
    const wanted = input.keywords ? board.jobs.filter(job => titleMatches(job.title, input.keywords)) : null;
    const followed = companies.find(company => company.ats === board.ats && company.slug.toLowerCase() === board.slug.toLowerCase());
    out.push({ ats: board.ats, slug: board.slug, name: board.name, link: BOARD_LINKS[board.ats](board.slug), open: board.jobs.length,
      matchingSearches: matching.length, ...(wanted ? { matchingKeywords: wanted.length } : {}),
      jobs: (wanted || (matching.length ? matching : board.jobs)).slice(0, limit).map(jobCard),
      followed: Boolean(followed), ...(followed ? { companyId: followed.id, enabled: followed.enabled } : {}) });
  }
  // A board with jobs before an empty one: an unused board under the same name is common.
  out.sort((a, b) => b.open - a.open);
  if (!out.length) {
    notes.push(`No Greenhouse, Lever or Ashby board was found${name ? ` for ${name}` : ''}. The company may keep its jobs in another system (Workday, SmartRecruiters, iCIMS, its own site), `
      + 'which Dayjob cannot follow; a saved search with the company\'s name in its keywords finds its jobs on LinkedIn and Indeed instead. '
      + 'A link to the company\'s careers page, or to one of its job postings, may still lead to a board.');
  }
  return { boards: out, looked, ...(notes.length ? { note: notes.join(' ') } : {}) };
}
