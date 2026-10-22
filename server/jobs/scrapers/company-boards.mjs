// Companies' own applicant-tracking boards publish every open job as public
// JSON. These are official endpoints, so they are the most reliable source.
import { extractEmails, htmlToText, posting } from '../normalize.mjs';

const HEADERS = { accept: 'application/json', 'user-agent': 'Dayjob/0.1 (personal job tracker)' };

function greenhouse(company, body) {
  return (body.jobs || []).map(job => {
    const html = job.content || '';
    return posting({
      site: 'greenhouse', externalId: `${company.slug}-${job.id}`, title: job.title, company: job.company_name || company.name,
      companyUrl: `https://job-boards.greenhouse.io/${company.slug}`, location: job.location?.name,
      isRemote: /remote/i.test(job.location?.name || '') ? true : null,
      department: job.departments?.map(item => item.name).join(', '),
      description: htmlToText(html), emails: extractEmails(html), jobUrl: job.absolute_url,
      datePosted: job.first_published || job.updated_at,
    });
  });
}

function lever(company, body) {
  return (Array.isArray(body) ? body : []).map(job => {
    const sections = [job.description || '', ...(job.lists || []).map(list => `<h3>${list.text}</h3><ul>${list.content}</ul>`), job.additional || ''].join('');
    const range = job.salaryRange;
    return posting({
      site: 'lever', externalId: `${company.slug}-${job.id}`, title: job.text, company: company.name,
      companyUrl: `https://jobs.lever.co/${company.slug}`, location: job.categories?.location, country: job.country,
      isRemote: job.workplaceType === 'remote' ? true : job.workplaceType ? false : null,
      jobType: job.categories?.commitment, department: [job.categories?.department, job.categories?.team].filter(Boolean).join(' · '),
      salary: range ? { min: range.min, max: range.max, currency: range.currency, interval: { 'per-year-salary': 'yearly', 'per-month-salary': 'monthly', 'per-hour-wage': 'hourly' }[range.interval] || null } : null,
      description: htmlToText(sections), emails: extractEmails(sections), jobUrl: job.hostedUrl, applyUrl: job.applyUrl,
      datePosted: job.createdAt,
    });
  });
}

function ashby(company, body) {
  return (body.jobs || []).filter(job => job.isListed !== false).map(job => {
    const pay = job.compensation?.summaryComponents?.find(item => item.compensationType === 'Salary');
    const address = job.address?.postalAddress || {};
    return posting({
      site: 'ashby', externalId: `${company.slug}-${job.id}`, title: job.title, company: company.name,
      companyUrl: `https://jobs.ashbyhq.com/${company.slug}`, location: job.location,
      city: address.addressLocality, state: address.addressRegion, country: address.addressCountry,
      isRemote: typeof job.isRemote === 'boolean' ? job.isRemote : null,
      jobType: { FullTime: 'fulltime', PartTime: 'parttime', Intern: 'internship', Contract: 'contract', Temporary: 'temporary' }[job.employmentType] || job.employmentType,
      department: [job.department, job.team].filter(Boolean).join(' · '),
      salary: pay ? { min: pay.minValue, max: pay.maxValue, currency: pay.currencyCode, interval: /YEAR/.test(pay.interval || '') ? 'yearly' : /HOUR/.test(pay.interval || '') ? 'hourly' : /MONTH/.test(pay.interval || '') ? 'monthly' : null } : null,
      description: job.descriptionHtml ? htmlToText(job.descriptionHtml) : job.descriptionPlain, emails: extractEmails(job.descriptionHtml),
      jobUrl: job.jobUrl, applyUrl: job.applyUrl, datePosted: job.publishedAt,
    });
  });
}

export const BOARDS = {
  greenhouse: { label: 'Greenhouse', url: slug => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`, parse: greenhouse },
  lever: { label: 'Lever', url: slug => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`, parse: lever },
  ashby: { label: 'Ashby', url: slug => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`, parse: ashby },
};

export async function fetchCompanyBoard(company, { http, log = () => {} }) {
  const board = BOARDS[company.ats];
  if (!board) throw new Error(`Unknown board type ${company.ats}.`);
  const response = await http.request(board.url(company.slug), { headers: HEADERS, expect: 'json' });
  const postings = [];
  for (const item of board.parse(company, response.body)) postings.push(item);
  if (!postings.length) log(`${company.ats}/${company.slug}: no open jobs`);
  return postings;
}

// Accepts a careers-page link (or a bare "ats:slug") and works out the board.
export function parseCompanyBoard(input) {
  const text = String(input || '').trim();
  const shorthand = /^(greenhouse|lever|ashby):([A-Za-z0-9._-]+)$/i.exec(text);
  if (shorthand) return { ats: shorthand[1].toLowerCase(), slug: shorthand[2] };
  let url;
  try { url = new URL(text.startsWith('http') ? text : `https://${text}`); } catch { return null; }
  const first = url.pathname.split('/').filter(Boolean)[0];
  const host = url.hostname.toLowerCase();
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    if (host === 'boards-api.greenhouse.io') return { ats: 'greenhouse', slug: url.pathname.split('/').filter(Boolean)[2] || null };
    const slug = url.searchParams.get('for') || first;
    return slug ? { ats: 'greenhouse', slug } : null;
  }
  if (/(^|\.)lever\.co$/.test(host)) return first ? { ats: 'lever', slug: host.startsWith('api.') ? url.pathname.split('/').filter(Boolean)[2] : first } : null;
  if (/(^|\.)ashbyhq\.com$/.test(host)) return first ? { ats: 'ashby', slug: host.startsWith('api.') ? url.pathname.split('/').filter(Boolean)[2] : first } : null;
  return null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// externalId is "<slug>-<job id>"; slugs may contain dashes, ids never do
// (Greenhouse ids are numbers, Lever and Ashby ids are UUIDs).
export function splitCompanyId(site, externalId) {
  const match = new RegExp(site === 'greenhouse' ? '^(.+)-(\\d+)$' : `^(.+)-(${UUID})$`, 'i').exec(externalId || '');
  return match ? { slug: match[1], id: match[2] } : null;
}

// true: still listed; false: removed from the board; null: could not tell.
export async function checkCompanyJob(item, { http, cache = new Map() }) {
  const parts = splitCompanyId(item.site, item.externalId);
  if (!parts) return null;
  const { slug, id } = parts;
  if (item.site === 'greenhouse' || item.site === 'lever') {
    const url = item.site === 'greenhouse'
      ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${id}`
      : `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${id}`;
    const response = await http.request(url, { headers: HEADERS, expect: 'text', allowStatus: [404, 410] });
    return response.status === 200;
  }
  if (item.site === 'ashby') {
    // Ashby has no single-job endpoint; one board fetch answers every job of that company.
    if (!cache.has(slug)) {
      const response = await http.request(BOARDS.ashby.url(slug), { headers: HEADERS, expect: 'json' });
      cache.set(slug, new Set((response.body.jobs || []).filter(job => job.isListed !== false).map(job => String(job.id))));
    }
    return cache.get(slug).has(id);
  }
  return null;
}
