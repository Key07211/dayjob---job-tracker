import { LANGUAGES } from './messages.mjs';
import { createHash } from 'node:crypto';
import { HttpError } from './http.mjs';
import { SITE_IDS } from './jobs/scrapers/index.mjs';
import { COUNTRIES } from './jobs/scrapers/indeed.mjs';
import { APPLICATION_STATUSES, POSTING_STATUSES, SCORE_MODES } from './jobs/repository.mjs';
import { posting } from './jobs/normalize.mjs';
import { GOAL_METRICS, MAX_GOALS } from './jobs/goals.mjs';
import { APPLICANT_FIELDS, LINK_FIELDS } from './jobs/applicant.mjs';

export const JOB_TYPES = ['fulltime', 'parttime', 'internship', 'contract', 'temporary'];
const PROVIDERS = ['claude-cli', 'anthropic-api'];
const EFFORTS = ['low', 'medium', 'high'];

const fail = message => { throw new HttpError(400, message); };
const has = (input, key) => Object.prototype.hasOwnProperty.call(input, key);

function text(value, label, { min = 0, max = 200, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return '';
    fail(`${label} is required.`);
  }
  if (typeof value !== 'string') fail(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length < min) fail(min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`);
  if (trimmed.length > max) fail(`${label} must be ${max} characters or fewer.`);
  return trimmed;
}
function integer(value, label, min, max, { nullable = false } = {}) {
  if ((value === null || value === '') && nullable) return null;
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
}
function oneOf(value, list, label, { nullable = false } = {}) {
  if ((value === null || value === '') && nullable) return null;
  if (!list.includes(value)) fail(`${label} must be one of: ${list.join(', ')}.`);
  return value;
}
function words(value, label) {
  if (value === undefined || value === null) return [];
  const list = typeof value === 'string' ? value.split(/[,，\n]/) : value;
  if (!Array.isArray(list) || list.length > 30) fail(`${label} must be a list of up to 30 words.`);
  return [...new Set(list.map(item => text(item, label, { max: 60 })).filter(Boolean))];
}
export function isoDate(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO date.`);
  return new Date(value).toISOString();
}
export function httpUrl(value, label) {
  const raw = text(value, label, { min: 1, max: 2048 });
  let url;
  try { url = new URL(raw); } catch { fail(`${label} must be a full http(s) link.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`${label} must be a full http(s) link.`);
  return url.href;
}

export function searchInput(input, current = null) {
  const value = { ...(current || {}), ...input };
  const sites = Array.isArray(value.sites) ? [...new Set(value.sites)] : fail('Sites must be a list.');
  if (!sites.length || sites.some(site => !SITE_IDS.includes(site))) fail(`Choose at least one site from: ${SITE_IDS.join(', ')}.`);
  return {
    name: text(value.name || value.keywords, 'Name', { min: 1, max: 80 }),
    keywords: text(value.keywords, 'Keywords', { min: 1, max: 200 }),
    location: text(value.location, 'Location', { max: 120, optional: true }),
    distance: integer(value.distance ?? null, 'Distance', 0, 200, { nullable: true }),
    sites,
    hoursOld: integer(value.hoursOld ?? null, 'Posted within (hours)', 1, 24 * 60, { nullable: true }),
    jobType: oneOf(value.jobType ?? null, JOB_TYPES, 'Job type', { nullable: true }),
    isRemote: boolean(value.isRemote ?? false, 'Remote'),
    resultsWanted: integer(value.resultsWanted ?? 25, 'Results per site', 1, 200),
    country: oneOf(value.country ?? 'usa', Object.keys(COUNTRIES), 'Country'),
    titleInclude: words(value.titleInclude, 'Title must include'),
    excludeKeywords: words(value.excludeKeywords, 'Exclude words'),
    enabled: boolean(value.enabled ?? true, 'Enabled'),
  };
}

const LINK_LABELS = { linkedin: 'LinkedIn link', github: 'GitHub link', website: 'Website link' };
// A profile link may be typed without https://.
function profileLink(value, label) {
  const link = text(value, label, { max: 300, optional: true });
  if (!link) return '';
  if (/^[a-z][\w+.-]*:/i.test(link) && !/^https?:\/\//i.test(link)) fail(`${label} must be a web link.`);
  return httpUrl(/^https?:\/\//i.test(link) ? link : `https://${link}`, label);
}

export function settingsPatch(input) {
  const patch = {};
  const section = (key, build) => {
    if (!has(input, key)) return;
    if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key])) fail(`${key} must be an object.`);
    patch[key] = build(input[key]);
  };
  const pick = (source, rules) => Object.fromEntries(Object.entries(rules).filter(([key]) => has(source, key)).map(([key, rule]) => [key, rule(source[key])]));
  section('schedule', value => pick(value, {
    enabled: item => boolean(item, 'Daily search'),
    time: item => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(item || '') ? item.padStart(5, '0') : fail('Time must look like 08:30.')),
  }));
  section('ai', value => pick(value, {
    provider: item => oneOf(item, PROVIDERS, 'AI provider'),
    claudeCommand: item => text(item, 'Claude Code path', { max: 1024, optional: true }),
    model: item => {
      const model = text(item, 'Model', { max: 100, optional: true });
      if (model && !/^[\w.:[\]-]+$/.test(model)) fail('Model must be a model id such as claude-opus-5-5.');
      return model;
    },
    apiKey: item => (item === null ? '' : text(item, 'API key', { max: 400 })),
    scoreMode: item => oneOf(item, SCORE_MODES, 'Scoring mode'),
    language: item => oneOf(item, ['zh', 'en'], 'Language'),
    maxPerRun: item => integer(item, 'Scores per run', 1, 200),
    effort: item => oneOf(item, EFFORTS, 'Effort'),
  }));
  section('updates', value => pick(value, {
    autoCheck: item => boolean(item, 'Daily update check'),
  }));
  section('desktop', value => pick(value, {
    closeToTray: item => boolean(item, 'Keep running after closing the window'),
  }));
  section('tracking', value => pick(value, {
    followUpDays: item => integer(item, 'Follow-up days', 0, 90),
    ghostDays: item => integer(item, 'No-reply days', 0, 180),
    checkClosed: item => boolean(item, 'Check closed postings'),
  }));
  section('notifications', value => pick(value, {
    desktop: item => boolean(item, 'Desktop notifications'),
    minScore: item => integer(item, 'High-match score', 0, 100),
  }));
  section('jobspy', value => pick(value, { pythonCommand: item => text(item, 'Python command', { max: 1024, optional: true }) }));
  section('applicant', value => pick(value, {
    ...Object.fromEntries(Object.entries(APPLICANT_FIELDS).map(([key, rule]) => [key, item => {
      if (!Array.isArray(rule)) return LINK_FIELDS.includes(key) ? profileLink(item, LINK_LABELS[key]) : text(item, key, { max: rule, optional: true });
      if (!rule.includes(item ?? '')) fail(`${key} must be yes, no or empty.`);
      return item ?? '';
    }])),
    email: item => {
      const email = text(item, 'email', { max: 200, optional: true });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Email must look like name@example.com.');
      return email;
    },
    declineEeo: item => boolean(item, 'Decline voluntary self-identification'),
  }));
  if (has(input, 'language')) patch.language = oneOf(input.language, LANGUAGES, 'Language');
  if (has(input, 'retentionDays')) patch.retentionDays = integer(input.retentionDays, 'Keep postings (days)', 7, 365);
  if (!Object.keys(patch).length) fail('Provide at least one setting.');
  return patch;
}

// The API key never leaves the server; the interface only learns whether one is set.
export function publicSettings(settings) {
  const { apiKey, ...ai } = settings.ai;
  return { ...settings, ai: { ...ai, hasApiKey: Boolean(apiKey), apiKeyFromEnv: !apiKey && Boolean(process.env.ANTHROPIC_API_KEY) } };
}

export function recommendInput(input) {
  return { preference: text(input.preference, 'Preferences', { max: 500, optional: true }) };
}

export function postingStatus(input) {
  return oneOf(input.status, POSTING_STATUSES.filter(status => status !== 'applied'), 'Status');
}

export function applicationPatch(input) {
  const patch = {};
  if (has(input, 'status')) patch.status = oneOf(input.status, APPLICATION_STATUSES, 'Status');
  if (has(input, 'note')) patch.note = text(input.note, 'Note', { max: 2000, optional: true });
  if (has(input, 'notes')) patch.notes = text(input.notes, 'Notes', { max: 20000, optional: true });
  if (has(input, 'contact')) patch.contact = text(input.contact, 'Contact', { max: 500, optional: true });
  if (has(input, 'nextFollowUpAt')) patch.nextFollowUpAt = isoDate(input.nextFollowUpAt, 'Follow-up date', { nullable: true });
  if (has(input, 'appliedAt')) patch.appliedAt = isoDate(input.appliedAt, 'Applied date');
  if (has(input, 'statusAt')) patch.statusAt = isoDate(input.statusAt, 'Status date');
  if (!Object.keys(patch).length) fail('Provide at least one field to update.');
  return patch;
}

export function applyInput(input) {
  return {
    appliedAt: has(input, 'appliedAt') && input.appliedAt !== null ? isoDate(input.appliedAt, 'Applied date') : null,
    note: text(input.note, 'Note', { max: 2000, optional: true }),
  };
}

export function manualApplication(input) {
  return {
    company: text(input.company, 'Company', { min: 1, max: 160 }),
    title: text(input.title, 'Title', { min: 1, max: 240 }),
    jobUrl: input.jobUrl ? httpUrl(input.jobUrl, 'Job link') : null,
    ...applyInput(input),
  };
}

// A job the user found elsewhere (or Claude found for them); stored like any other.
export function manualPosting(input) {
  const jobUrl = httpUrl(input.jobUrl, 'Job link');
  try {
    return posting({
      site: 'manual', externalId: createHash('sha256').update(jobUrl).digest('hex').slice(0, 24),
      title: text(input.title, 'Title', { min: 1, max: 240 }), company: text(input.company, 'Company', { min: 1, max: 160 }),
      location: text(input.location, 'Location', { max: 160, optional: true }),
      isRemote: has(input, 'isRemote') ? boolean(input.isRemote, 'Remote') : null,
      jobType: input.jobType ? oneOf(input.jobType, JOB_TYPES, 'Job type') : null,
      description: text(input.description, 'Description', { max: 100000, optional: true }),
      jobUrl, datePosted: !input.datePosted ? null : /^\d{4}-\d\d-\d\d$/.test(input.datePosted) ? input.datePosted : isoDate(input.datePosted, 'Posted date'),
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(error.message);
  }
}

export function monthParam(value, { optional = true } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) fail('Month must look like 2026-10.');
  return value;
}
function goalItem(item, { allowZero = false } = {}) {
  if (!item || typeof item !== 'object') fail('Each goal needs a metric and a target.');
  const metric = oneOf(item.metric, GOAL_METRICS, 'Goal');
  return {
    ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
    metric,
    name: metric === 'custom' ? text(item.name, 'Goal name', { min: 1, max: 60 }) : '',
    target: integer(item.target, 'Monthly target', allowZero ? 0 : 1, 1000),
  };
}
// The whole set of a month's goals, as the goal editor saves it.
export function goalsInput(input) {
  if (!Array.isArray(input.goals) || input.goals.length > MAX_GOALS) fail(`Goals must be a list of up to ${MAX_GOALS}.`);
  const goals = input.goals.map(item => goalItem(item));
  const keys = goals.map(goal => (goal.metric === 'custom' ? `custom:${goal.name.toLowerCase()}` : goal.metric));
  if (new Set(keys).size !== keys.length) fail('Each goal can appear only once in a month.');
  return { month: monthParam(input.month, { optional: false }), goals };
}
export function goalInput(input) {
  return { month: monthParam(input.month), goal: goalItem(input, { allowZero: true }) };
}
export function goalLogInput(input) {
  const amount = input.amount ?? 1;
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100) fail('Amount must be a whole number from -100 to 100, not 0.');
  return { amount };
}

// What Claude asks the Dayjob browser to do (desktop/browser.cjs carries it out).
export const BROWSER_ACTIONS = ['open', 'read', 'screenshot', 'click', 'type', 'select', 'key', 'scroll', 'navigate', 'autofill', 'tabs'];
export const BROWSER_KEYS = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'];

export function browserInput(action, input) {
  const flag = key => (has(input, key) && input[key] !== null ? boolean(input[key], key) : false);
  const ref = () => {
    if (typeof input.ref !== 'string' || !/^e\d{1,7}$/.test(input.ref)) fail('ref must be an element ref from dayjob_browser_read, such as e12.');
    return input.ref;
  };
  switch (action) {
    case 'open': return { url: httpUrl(input.url, 'url'), newTab: flag('newTab') };
    case 'read': return { query: text(input.query, 'query', { max: 200, optional: true }),
      maxChars: has(input, 'maxChars') && input.maxChars !== null ? integer(input.maxChars, 'maxChars', 500, 60000) : 15000 };
    case 'screenshot': return {};
    case 'click': return { ref: ref() };
    case 'type':
      if (typeof input.text !== 'string' || input.text.length > 10000) fail('text must be text of up to 10000 characters.');
      return { ref: ref(), text: input.text, append: flag('append'), pressEnter: flag('pressEnter') };
    case 'select': return { ref: ref(), option: text(input.option, 'option', { min: 1, max: 200 }) };
    case 'key': return { key: oneOf(input.key, BROWSER_KEYS, 'key') };
    case 'scroll': return { direction: input.direction == null ? 'down' : oneOf(input.direction, ['up', 'down'], 'direction'), ref: input.ref == null ? null : ref() };
    case 'navigate': return { action: oneOf(input.action, ['back', 'forward', 'reload'], 'action') };
    case 'autofill': return {};
    case 'tabs': {
      const chosen = input.action == null ? 'list' : oneOf(input.action, ['list', 'switch', 'close'], 'action');
      if (chosen !== 'list' && (typeof input.tabId !== 'string' || !/^tab-\d{1,6}$/.test(input.tabId))) fail('tabId is required; list the tabs to get it.');
      return { action: chosen, tabId: chosen === 'list' ? null : input.tabId };
    }
    default: return fail('Unknown browser action.');
  }
}
