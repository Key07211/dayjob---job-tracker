// Ported from JobSpy (MIT, github.com/speedyapply/JobSpy) jobspy/indeed.
// Indeed's mobile app GraphQL API answers a full search, descriptions
// included, in pages of up to 100 jobs.
import { extractEmails, htmlToText, posting } from '../normalize.mjs';
import { ScrapeError, jitter } from './http-client.mjs';

const API = 'https://apis.indeed.com/graphql';
const PER_PAGE = 100;
const RETRY_DELAY = [3, 6];
const HEADERS = {
  'content-type': 'application/json',
  'indeed-api-key': '161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8',
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Indeed App 193.1',
  'indeed-app-info': 'appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone',
};

// country key -> [Indeed country code, subdomain, language]
export const COUNTRIES = {
  usa: ['US', 'www', 'en'], canada: ['CA', 'ca', 'en'], uk: ['GB', 'uk', 'en'], australia: ['AU', 'au', 'en'],
  singapore: ['SG', 'sg', 'en'], 'hong kong': ['HK', 'hk', 'en'], china: ['CN', 'cn', 'zh'], taiwan: ['TW', 'tw', 'zh'],
  japan: ['JP', 'jp', 'ja'], 'south korea': ['KR', 'kr', 'ko'], india: ['IN', 'in', 'en'], germany: ['DE', 'de', 'de'],
  france: ['FR', 'fr', 'fr'], netherlands: ['NL', 'nl', 'nl'], ireland: ['IE', 'ie', 'en'], switzerland: ['CH', 'ch', 'de'],
  spain: ['ES', 'es', 'es'], italy: ['IT', 'it', 'it'], sweden: ['SE', 'se', 'sv'], 'new zealand': ['NZ', 'nz', 'en'],
};
const JOB_TYPE_CODES = { fulltime: ['CF3CP'], parttime: ['75GKK'], contract: ['NJXCK', 'T9BXE', 'T65DZ'], internship: ['VDTG7'], temporary: ['4HKF7', 'CJWTS'] };
const JOB_TYPES_BY_CODE = Object.fromEntries(Object.entries(JOB_TYPE_CODES).flatMap(([type, codes]) => codes.map(code => [code, type])));
const REMOTE_KEY = 'DSQF7';
const HYBRID_KEY = 'PAXZC';
const PAY_INTERVALS = { HOUR: 'hourly', DAY: 'daily', WEEK: 'weekly', MONTH: 'monthly', YEAR: 'yearly' };
const RANGE = '... on Range { min max } ... on AtLeast { min } ... on AtMost { max } ... on Exactly { value }';

export function buildFilters(input) {
  const attribute = (key, match = '') => `{ keyword: { field: "attributes", keys: ["${key}"]${match} } }`;
  const filters = [];
  if (input.hoursOld) filters.push(`{ date: { field: "dateOnIndeed", start: "${Number(input.hoursOld)}h" } }`);
  const keys = JOB_TYPE_CODES[input.jobType] || [];
  if (keys.length > 1) filters.push(`{ composite: { filters: [${keys.map(key => attribute(key)).join(', ')}], operation: OR } }`);
  else if (keys.length) filters.push(attribute(keys[0]));
  if (input.isRemote) {
    filters.push(attribute(REMOTE_KEY));
    filters.push(attribute(HYBRID_KEY, ', match: MUST_NOT'));
  }
  return filters.length ? `filters: [${filters.join(', ')}]` : '';
}

export function buildQuery(input, cursor) {
  const what = input.keywords ? `what: ${JSON.stringify(input.keywords)}` : '';
  const where = input.location ? `location: {where: ${JSON.stringify(input.location)}, radius: ${Number(input.distance || 50)}, radiusUnit: MILES}` : '';
  return `query GetJobData {
    jobSearch(${what} ${where} limit: ${PER_PAGE} ${cursor ? `cursor: ${JSON.stringify(cursor)}` : ''} sort: RELEVANCE ${buildFilters(input)}) {
      pageInfo { nextCursor }
      results { job {
        key title sourceEmployerName dateOnIndeed
        description { html }
        location { countryCode admin1Code city }
        compensation {
          estimated { currencyCode baseSalary { unitOfWork range { ${RANGE} } } }
          baseSalary { unitOfWork range { ${RANGE} } }
          currencyCode
        }
        attributes { key }
        employer { relativeCompanyPageUrl name dossier { images { squareLogoUrl } links { corporateWebsite } } }
        recruit { viewJobUrl }
      } }
    }
  }`;
}

function compensation(raw = {}) {
  let pay = raw.baseSalary;
  let currency = raw.currencyCode;
  if (!pay && raw.estimated) { pay = raw.estimated.baseSalary; currency = raw.estimated.currencyCode; }
  const interval = pay?.unitOfWork ? PAY_INTERVALS[pay.unitOfWork] : null;
  if (!pay || !interval) return null;
  const range = pay.range || {};
  const min = range.min ?? range.value ?? null;
  const max = range.max ?? range.value ?? null;
  return { min: min === null ? null : Math.round(min * 100) / 100, max: max === null ? null : Math.round(max * 100) / 100,
    interval, currency: currency || 'USD', source: raw.baseSalary ? 'board' : 'estimate' };
}

export function toPosting(job, base) {
  const keys = new Set((job.attributes || []).map(item => item.key));
  const types = [...new Set([...keys].map(key => JOB_TYPES_BY_CODE[key]).filter(Boolean))];
  let applyUrl = job.recruit?.viewJobUrl || null;
  try { if (applyUrl && `.${new URL(applyUrl).hostname}`.endsWith('.indeed.com')) applyUrl = null; } catch { applyUrl = null; }
  const employer = job.employer || {};
  const html = job.description?.html || null;
  return posting({
    site: 'indeed', externalId: job.key, title: job.title, company: employer.name || job.sourceEmployerName,
    companyUrl: employer.relativeCompanyPageUrl ? `${base}${employer.relativeCompanyPageUrl}` : employer.dossier?.links?.corporateWebsite,
    companyLogo: employer.dossier?.images?.squareLogoUrl,
    city: job.location?.city, state: job.location?.admin1Code, country: job.location?.countryCode,
    isRemote: keys.has(REMOTE_KEY) && !keys.has(HYBRID_KEY), jobType: types,
    salary: compensation(job.compensation), description: htmlToText(html), emails: extractEmails(html),
    jobUrl: `${base}/viewjob?jk=${job.key}`, applyUrl, datePosted: job.dateOnIndeed || null,
  });
}

export const indeed = {
  id: 'indeed',
  label: 'Indeed',
  async search(input, { http, log = () => {} }) {
    const [code, subdomain, language] = COUNTRIES[input.country || 'usa'] || COUNTRIES.usa;
    const base = `https://${subdomain}.indeed.com`;
    const headers = { ...HEADERS, 'indeed-co': code, 'indeed-locale': `${language}-${code}` };
    const wanted = input.resultsWanted || 25;
    const results = [];
    const seen = new Set();
    let cursor = null;
    while (results.length < wanted) {
      const body = JSON.stringify({ query: buildQuery(input, cursor) });
      let response;
      try {
        response = await http.request(API, { method: 'POST', headers, body, expect: 'json' });
      } catch (error) {
        // The app API now and then answers 401 to a valid request; a second try usually works.
        if (error.status !== 401) throw error;
        await http.sleep(jitter(RETRY_DELAY));
        try { response = await http.request(API, { method: 'POST', headers, body, expect: 'json' }); } catch (again) {
          if (again.status === 401) throw new ScrapeError('Indeed refused the request (HTTP 401); it usually works again on the next run.', { status: 401, blocked: true });
          throw again;
        }
      }
      const search = response.body?.data?.jobSearch;
      if (!search) throw new ScrapeError(`Indeed API error: ${JSON.stringify(response.body?.errors || 'no results').slice(0, 300)}`);
      const fresh = (search.results || []).map(result => result.job).filter(job => job?.key && !seen.has(job.key));
      fresh.forEach(job => seen.add(job.key));
      for (const job of fresh) {
        if (results.length >= wanted) break;
        try { results.push(toPosting(job, base)); } catch (error) { log(`indeed ${job.key}: ${error.message}`); }
      }
      cursor = search.pageInfo?.nextCursor;
      if (!fresh.length || !cursor) break;
    }
    return { postings: results, warnings: [] };
  },
  async checkOpen(item, { http }) {
    const response = await http.request(item.jobUrl, { headers: { 'user-agent': HEADERS['user-agent'] }, allowStatus: [404, 410] });
    if (response.status === 404 || response.status === 410) return false;
    if (/This job has expired|job you were looking for is no longer available/i.test(response.body)) return false;
    return /jobsearch-JobComponent|jobDescriptionText/.test(response.body) ? true : null;
  },
};
