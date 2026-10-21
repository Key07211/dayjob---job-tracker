import { parse } from 'node-html-parser';

// Every scraper returns postings in this one shape so storage, scoring and the
// interface never need to know which board a job came from.
export function posting(fields) {
  const value = {
    site: fields.site,
    externalId: String(fields.externalId),
    title: clean(fields.title),
    company: clean(fields.company) || null,
    companyUrl: fields.companyUrl || null,
    companyLogo: fields.companyLogo || null,
    location: clean(fields.location) || null,
    city: clean(fields.city) || null,
    state: clean(fields.state) || null,
    country: clean(fields.country) || null,
    isRemote: typeof fields.isRemote === 'boolean' ? fields.isRemote : null,
    jobType: list(fields.jobType).join(', ') || null,
    jobLevel: clean(fields.jobLevel) || null,
    jobFunction: clean(fields.jobFunction) || null,
    department: clean(fields.department) || null,
    salary: salary(fields.salary),
    description: fields.description ? String(fields.description).trim() || null : null,
    emails: fields.emails?.length ? [...new Set(fields.emails)] : [],
    jobUrl: fields.jobUrl,
    applyUrl: fields.applyUrl || null,
    datePosted: isoDay(fields.datePosted),
  };
  if (!value.title) throw new Error('A posting needs a title.');
  if (!value.jobUrl || !/^https?:\/\//.test(value.jobUrl)) throw new Error('A posting needs an http(s) job URL.');
  if (!value.location) value.location = [value.city, value.state, value.country].filter(Boolean).join(', ') || null;
  return value;
}

export function postingId(item) {
  const prefix = { linkedin: 'li', indeed: 'in', glassdoor: 'gd', zip_recruiter: 'zr', google: 'go',
    greenhouse: 'gh', lever: 'lv', ashby: 'ab', manual: 'mn' }[item.site] || item.site;
  return `${prefix}-${item.externalId}`;
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function list(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map(clean).filter(Boolean);
}

function salary(value) {
  if (!value) return null;
  const min = Number.isFinite(value.min) ? value.min : null;
  const max = Number.isFinite(value.max) ? value.max : null;
  if (min === null && max === null) return null;
  return { min, max, interval: value.interval || null, currency: value.currency || 'USD', source: value.source || 'board' };
}

// Boards give dates as YYYY-MM-DD, ISO timestamps or Unix milliseconds. Keep a
// calendar day (the posting's "open since" date) unless a precise time exists.
export function isoDay(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
  const text = String(value).trim();
  if (/^\d{4}-\d\d-\d\d$/.test(text)) return text;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function dedupeKey(item) {
  const normal = text => (text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
  const company = normal(item.company).replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology)\b/g, '').trim();
  return [company, normal(item.title), normal(item.city || item.location)].join('|');
}

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'ul', 'ol', 'table', 'tr', 'blockquote', 'br', 'hr']);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// Turns board HTML into light Markdown (headings, bullets, bold). The interface
// renders that as text, so no board HTML ever reaches the page.
export function htmlToText(html) {
  if (!html) return null;
  let source = String(html);
  if (/&lt;\/?[a-z]/i.test(source) && !/<\/?[a-z]/i.test(source)) source = parse(source).text;
  const root = parse(source, { blockTextElements: { script: false, style: false, noscript: false } });
  const out = [];
  const walk = node => {
    if (node.nodeType === 3) { out.push(node.text.replace(/\s+/g, ' ')); return; }
    const tag = node.rawTagName?.toLowerCase();
    if (tag === 'script' || tag === 'style') return;
    if (tag === 'br') { out.push('\n'); return; }
    if (HEADING.has(tag)) {
      out.push('\n\n## ');
      node.childNodes.forEach(walk);
      out.push('\n\n');
      return;
    }
    if (tag === 'li') {
      out.push('\n- ');
      node.childNodes.forEach(walk);
      out.push('\n');
      return;
    }
    if (tag === 'strong' || tag === 'b') {
      const inner = node.text.replace(/\s+/g, ' ').trim();
      if (inner) out.push(` **${inner}** `);
      return;
    }
    const block = BLOCK.has(tag);
    if (block) out.push('\n\n');
    node.childNodes.forEach(walk);
    if (block) out.push('\n\n');
  };
  walk(root);
  return out.join('')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\*\* +([,.;:!?])/g, '**$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|\n)- \n/g, '$1')
    .trim() || null;
}

export function extractEmails(text) {
  if (!text) return [];
  return [...new Set(String(text).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])];
}

const SALARY_RANGE = /\$(\d+(?:,\d+)?(?:\.\d+)?)([kK]?)\s*[-—–]\s*(?:\$)?(\d+(?:,\d+)?(?:\.\d+)?)([kK]?)/;
const ANNUAL = { hourly: 2080, daily: 260, weekly: 52, monthly: 12, yearly: 1 };

// Ported from JobSpy's LinkedIn salary guess: the first "$min - $max" in the
// text, with the pay interval inferred from the size of the amounts.
export function guessSalary(text) {
  const match = SALARY_RANGE.exec(text || '');
  if (!match) return null;
  let low = Math.trunc(Number(match[1].replace(/,/g, '')));
  let high = Math.trunc(Number(match[3].replace(/,/g, '')));
  if (match[2] || match[4]) { low *= 1000; high *= 1000; }
  let interval;
  let below;
  if (low < 350) { interval = 'hourly'; below = 350; }
  else if (low < 30000) { interval = 'monthly'; below = 30000; }
  else { interval = 'yearly'; below = 700001; }
  const factor = ANNUAL[interval];
  if (high >= below || !(1000 <= low * factor && low * factor < high * factor && high * factor <= 700000)) return null;
  return { min: low, max: high, interval, currency: 'USD', source: 'description' };
}

export function annualFactor(interval) {
  return ANNUAL[interval] || 1;
}
