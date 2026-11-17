import { createHash } from 'node:crypto';

// Jobs read from a web page in the Dayjob browser (Handshake and other sites the daily fetch does not ask): which
// site a job's link belongs to, and the id that makes the same job the same posting however it reached Dayjob.
//
// - A LinkedIn or Indeed link carries the id the daily fetch uses, so a job read from the page is that very posting.
// - Handshake has ids of its own, in the path of a job's link.
// - Any other link is told apart by its address, the way "Add to Dayjob" does: on an unknown site that is the same
//   posting as the one the button adds.

// Boards the daily fetch does not ask, named so the Source filter can tell their jobs apart. job: where a job's id
// sits in its link, for a board whose links differ from visit to visit.
export const WEB_BOARDS = [
  { id: 'handshake', label: 'Handshake', host: 'joinhandshake.com', job: [/^\/(?:stu\/)?jobs\/(\d+)/, /^\/job-search\/(\d+)/, /^\/(?:stu\/)?postings\/(\d+)/] },
  { id: 'wellfound', label: 'Wellfound', host: 'wellfound.com' },
  { id: 'wayup', label: 'WayUp', host: 'wayup.com' },
  { id: 'simplify', label: 'Simplify', host: 'simplify.jobs' },
  { id: 'builtin', label: 'Built In', host: 'builtin.com' },
  { id: 'workatastartup', label: 'Work at a Startup', host: 'workatastartup.com' },
  { id: 'dice', label: 'Dice', host: 'dice.com' },
  { id: 'usajobs', label: 'USAJOBS', host: 'usajobs.gov' },
];
export const WEB_SITE_IDS = WEB_BOARDS.map(board => board.id);

const on = (hostname, host) => hostname === host || hostname.endsWith(`.${host}`);
// What a link carries for whoever counts clicks says nothing about the job.
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|mc_[ce]id)$/i;
const hashed = text => createHash('sha256').update(text).digest('hex').slice(0, 24);

// url: a job's link, as the page gave it. -> { site, externalId, jobUrl } for a posting, or null for anything that
// is not an http(s) link.
export function webJob(url) {
  let link;
  try { link = new URL(String(url)); } catch { return null; }
  if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password) return null;
  link.hash = '';
  for (const name of [...link.searchParams.keys()]) if (TRACKING.test(name)) link.searchParams.delete(name);
  const host = link.hostname.toLowerCase();
  if (on(host, 'linkedin.com')) {
    const id = /^\d{6,}$/.exec(link.searchParams.get('currentJobId') || '')?.[0] || /^\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})(?:\/|$)/.exec(link.pathname)?.[1];
    if (id) return { site: 'linkedin', externalId: id, jobUrl: `https://www.linkedin.com/jobs/view/${id}` };
  }
  if (on(host, 'indeed.com')) {
    const key = /^[0-9a-f]{16}$/i.exec(link.searchParams.get('jk') || link.searchParams.get('vjk') || '')?.[0];
    if (key) return { site: 'indeed', externalId: key.toLowerCase(), jobUrl: `${link.origin}/viewjob?jk=${key.toLowerCase()}` };
  }
  const board = WEB_BOARDS.find(item => on(host, item.host));
  for (const pattern of board?.job || []) {
    const match = pattern.exec(link.pathname);
    if (match) return { site: board.id, externalId: match[1], jobUrl: `${link.origin}${match[0]}` };
  }
  return { site: board?.id || 'manual', externalId: hashed(link.href), jobUrl: link.href };
}

// The site a page belongs to, in a word, for telling the user where jobs were read: "handshake", else the host.
export function siteName(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return WEB_BOARDS.find(item => on(host, item.host))?.label || host.replace(/^www\./, '');
  } catch { return ''; }
}

const words = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9一-鿿]+/g, ' ').trim().split(' ').filter(word => word.length > 1);

// Whether a page Dayjob opened for a job is about that job: its text names the company, or most of the title's
// words. A link can lead to a sign-in page, a search, or a job that is gone; what such a page says is not the
// job's description.
export function pageIsAbout(job, seen) {
  const text = ` ${words(`${seen?.title || ''} ${String(seen?.description || '').slice(0, 6000)}`).join(' ')} `;
  if (text.trim().length < 3) return false;
  const company = words(job.company).filter(word => !['inc', 'llc', 'ltd', 'corp', 'co', 'company', 'the'].includes(word));
  if (company.length && text.includes(` ${company.join(' ')} `)) return true;
  const title = words(job.title);
  return title.length > 0 && title.filter(word => text.includes(` ${word} `)).length >= Math.ceil(title.length * 0.6);
}

// A title or a company as the page's own data has it and as the model read it from a card: when one is the other
// cut short ("Data Analyst Intern, Summ…"), the longer is the whole one.
export function fuller(read, own) {
  const plain = text => String(text || '').replace(/[…\s.]+$/, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const [a, b] = [plain(read), plain(own)];
  if (!b) return read;
  if (!a) return own;
  return b.length > a.length && b.startsWith(a) ? own : read;
}

// What a page's own data calls the kind of job (FULL_TIME, INTERN, …), in Dayjob's words.
const JOB_TYPE = { FULL_TIME: 'fulltime', PART_TIME: 'parttime', CONTRACTOR: 'contract', CONTRACT: 'contract', INTERN: 'internship', INTERNSHIP: 'internship', TEMPORARY: 'temporary' };
export const jobTypeOf = types => [].concat(types || []).map(type => JOB_TYPE[String(type).toUpperCase().replace(/[\s-]+/g, '_')]).find(Boolean) || null;
