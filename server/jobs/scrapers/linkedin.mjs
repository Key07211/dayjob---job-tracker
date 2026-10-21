// Ported from JobSpy (MIT, github.com/speedyapply/JobSpy) jobspy/linkedin.
// LinkedIn's guest job search returns HTML cards, ten per page; each job's
// public page carries the description, pay and criteria.
import { parse } from 'node-html-parser';
import { extractEmails, guessSalary, htmlToText, posting } from '../normalize.mjs';
import { ScrapeError, jitter } from './http-client.mjs';

const BASE = 'https://www.linkedin.com';
const PER_PAGE = 10;
const MAX_RESULTS = 1000;
const EMPTY_PAGE = '<!DOCTYPE html>\n\n<!---->';
const HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
const JOB_TYPES = { fulltime: 'F', parttime: 'P', contract: 'C', temporary: 'T', internship: 'I' };
const PAY_INTERVALS = { '/hr': 'hourly', '/mo': 'monthly', '/yr': 'yearly' };
const CURRENCIES = { $: 'USD', CA$: 'CAD', '£': 'GBP', '€': 'EUR', '₹': 'INR' };
const REMOTE_WORDS = ['remote', 'work from home', 'wfh'];
const PAGE_DELAY = [3, 7];
const DETAIL_DELAY = [1, 2.5];

export function searchParams(input) {
  const params = new URLSearchParams();
  if (input.keywords) params.set('keywords', input.keywords);
  if (input.location) params.set('location', input.location);
  if (input.distance) params.set('distance', String(input.distance));
  if (input.hoursOld) params.set('f_TPR', `r${input.hoursOld * 3600}`);
  if (JOB_TYPES[input.jobType]) params.set('f_JT', JOB_TYPES[input.jobType]);
  if (input.isRemote) params.set('f_WT', '2');
  return params;
}

export function parseLocation(text) {
  const parts = (text || '').split(', ').map(part => part.trim()).filter(Boolean);
  if (parts.length === 3) return { city: parts[0], state: parts[1], country: parts[2] };
  if (parts.length === 2) {
    return /^[A-Z]{2}$/.test(parts[1]) ? { city: parts[0], state: parts[1], country: 'United States' } : { city: parts[0], country: parts[1] };
  }
  return parts.length ? { city: parts[0] } : {};
}

export function parseCards(html) {
  const root = parse(html);
  return root.querySelectorAll('.base-search-card').map(card => {
    const id = (card.getAttribute('data-entity-urn') || '').split(':').pop()
      || (card.querySelector('[data-entity-urn]')?.getAttribute('data-entity-urn') || '').split(':').pop();
    const title = card.querySelector('h3.base-search-card__title')?.text.trim();
    const companyTag = card.querySelector('h4.base-search-card__subtitle');
    const locationText = card.querySelector('.job-search-card__location')?.text.trim() || '';
    const time = card.querySelector('time')?.getAttribute('datetime') || null;
    return { id, title, company: companyTag?.text.trim(), companyUrl: companyTag?.querySelector('a')?.getAttribute('href')?.split('?')[0] || null,
      locationText, datePosted: /^\d{4}-\d\d-\d\d$/.test(time || '') ? time : null,
      logo: card.querySelector('img')?.getAttribute('data-delayed-url') || null };
  }).filter(card => card.id && card.title && card.company);
}

function criteria(root, heading) {
  for (const subheader of root.querySelectorAll('h3.description__job-criteria-subheader')) {
    if (subheader.text.includes(heading)) {
      return subheader.parentNode.querySelector('.description__job-criteria-text')?.text.trim() || null;
    }
  }
  return null;
}

export function parseSalary(text) {
  const match = /^([^\d\s]+) ?([\d,]+\.\d\d)(\/\w+) - [^\d\s]+ ?([\d,]+\.\d\d)\/\w+$/.exec((text || '').split(/\s+/).join(' ').trim());
  if (!match) return null;
  const [, currency, low, interval, high] = match;
  return { min: Number(low.replace(/,/g, '')), max: Number(high.replace(/,/g, '')), interval: PAY_INTERVALS[interval] || null,
    currency: CURRENCIES[currency] || currency, source: 'board' };
}

export function parseDetail(html) {
  const root = parse(html);
  const markup = root.querySelector('.show-more-less-html__markup');
  const descriptionHtml = markup ? markup.innerHTML : null;
  const description = htmlToText(descriptionHtml);
  const employment = criteria(root, 'Employment type');
  const salary = parseSalary(root.querySelector('.compensation__salary')?.text) || guessSalary(description);
  const closed = /No longer accepting applications/i.test(root.text);
  return {
    description,
    emails: extractEmails(descriptionHtml),
    salary,
    jobType: employment ? employment.toLowerCase().replace(/-/g, '') : null,
    jobLevel: criteria(root, 'Seniority level')?.toLowerCase() || null,
    jobFunction: criteria(root, 'Job function'),
    industry: criteria(root, 'Industries'),
    companyLogo: root.querySelector('img.artdeco-entity-image')?.getAttribute('data-delayed-url') || null,
    closed,
  };
}

export const linkedin = {
  id: 'linkedin',
  label: 'LinkedIn',
  async search(input, { http, log = () => {} }) {
    const wanted = Math.min(input.resultsWanted || 25, MAX_RESULTS);
    const params = searchParams(input);
    const results = [];
    const warnings = [];
    const seen = new Set();
    let start = 0;
    while (results.length < wanted && start < MAX_RESULTS) {
      if (start > 0) await http.sleep(jitter(PAGE_DELAY));
      params.set('start', String(start));
      const page = await http.request(`${BASE}/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`, { headers: HEADERS });
      const cards = parseCards(page.body);
      if (!cards.length) {
        if (page.body.trim() !== EMPTY_PAGE.trim() && page.body.trim() && start === 0) {
          throw new ScrapeError('LinkedIn returned a page without jobs (it may be limiting requests).', { blocked: true });
        }
        break;
      }
      const fresh = cards.filter(card => !seen.has(card.id));
      fresh.forEach(card => seen.add(card.id));
      for (const card of fresh) {
        if (results.length >= wanted) break;
        let detail = {};
        if (input.fetchDescription !== false) {
          try {
            if (results.length) await http.sleep(jitter(DETAIL_DELAY));
            const response = await http.request(`${BASE}/jobs/view/${card.id}`, { headers: HEADERS });
            if (new URL(response.url).pathname.startsWith('/jobs/view/')) detail = parseDetail(response.body);
            else log(`linkedin ${card.id}: redirected away from the job page`);
          } catch (error) {
            log(`linkedin ${card.id}: ${error.message}`);
            if (error.blocked && !warnings.length) warnings.push('LinkedIn limited the job-page requests; some descriptions are missing.');
          }
        }
        const location = parseLocation(card.locationText);
        const display = [card.title, card.locationText].join(' ').toLowerCase();
        results.push(posting({
          site: 'linkedin', externalId: card.id, title: card.title, company: card.company, companyUrl: card.companyUrl,
          companyLogo: detail.companyLogo || card.logo, location: card.locationText, ...location,
          isRemote: REMOTE_WORDS.some(word => display.includes(word)),
          jobType: detail.jobType, jobLevel: detail.jobLevel, jobFunction: detail.jobFunction, department: detail.industry,
          salary: detail.salary, description: detail.description, emails: detail.emails,
          jobUrl: `${BASE}/jobs/view/${card.id}`, datePosted: card.datePosted,
        }));
      }
      if (!fresh.length || cards.length < PER_PAGE) break;
      start += PER_PAGE;
    }
    return { postings: results, warnings };
  },
  // true: still open; false: closed; null: could not tell (blocked, login wall).
  async checkOpen(item, { http }) {
    const response = await http.request(`${BASE}/jobs/view/${item.externalId}`, { headers: HEADERS, allowStatus: [404, 410] });
    if (response.status === 404 || response.status === 410) return false;
    if (!new URL(response.url).pathname.startsWith('/jobs/view/')) return null;
    const detail = parseDetail(response.body);
    if (detail.closed) return false;
    return detail.description ? true : null;
  },
};
