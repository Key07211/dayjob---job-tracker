import { currentLanguage, tr } from '../i18n.jsx';

const LABELS = {
  site: {
    zh: { linkedin: 'LinkedIn', indeed: 'Indeed', glassdoor: 'Glassdoor', zip_recruiter: 'ZipRecruiter', google: 'Google Jobs',
      greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', manual: '手动添加' },
    en: { linkedin: 'LinkedIn', indeed: 'Indeed', glassdoor: 'Glassdoor', zip_recruiter: 'ZipRecruiter', google: 'Google Jobs',
      greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', manual: 'Added by hand' },
  },
  status: {
    zh: { applied: '已投递', oa: '在线测评', interview: '面试中', offer: 'Offer', accepted: '已接受', rejected: '未通过', withdrawn: '已撤回', ghosted: '无回音' },
    en: { applied: 'Applied', oa: 'Assessment', interview: 'Interviewing', offer: 'Offer', accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn', ghosted: 'Ghosted' },
  },
  verdict: {
    zh: { strong: '高度匹配', good: '匹配', stretch: '有差距', weak: '不太匹配' },
    en: { strong: 'Strong match', good: 'Good match', stretch: 'Stretch', weak: 'Weak match' },
  },
  jobType: {
    zh: { fulltime: '全职', parttime: '兼职', internship: '实习', contract: '合同', temporary: '临时' },
    en: { fulltime: 'Full-time', parttime: 'Part-time', internship: 'Internship', contract: 'Contract', temporary: 'Temporary' },
  },
  flag: {
    zh: { 'follow-up-due': '该跟进了', 'ghost-suspected': '可能无回音' },
    en: { 'follow-up-due': 'Follow up', 'ghost-suspected': 'Possibly ghosted' },
  },
  event: {
    zh: { status: '状态', note: '备注', 'posting-closed': '岗位关闭', 'posting-reopened': '岗位重新开放', 'follow-up-due': '跟进提醒', 'ghost-suspected': '长时间无回复' },
    en: { status: 'Status', note: 'Note', 'posting-closed': 'Posting closed', 'posting-reopened': 'Posting reopened', 'follow-up-due': 'Follow-up reminder', 'ghost-suspected': 'No reply for a while' },
  },
  source: {
    zh: { user: '你', auto: '自动', mcp: 'Claude' },
    en: { user: 'You', auto: 'Auto', mcp: 'Claude' },
  },
};

// labels('status') -> { applied: '已投递', … } in the current language.
export function labels(group) { return LABELS[group][currentLanguage()] || LABELS[group].zh; }
export function label(group, key) { return labels(group)[key] ?? key; }
export const OPEN_STATUSES = ['applied', 'oa', 'interview', 'offer'];

const DAY = 864e5;

// "2026-10-21" is a calendar day in the board's own sense; read it as local.
export function toDate(value) {
  if (!value) return null;
  const date = /^\d{4}-\d\d-\d\d$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function relativeDay(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return '';
  const start = day => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / DAY);
  if (days <= 0) return days < 0 ? formatDay(value) : tr('今天', 'today');
  if (days === 1) return tr('昨天', 'yesterday');
  if (days < 14) return tr(`${days} 天前`, `${days} days ago`);
  if (days < 60) { const weeks = Math.round(days / 7); return tr(`${weeks} 周前`, `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`); }
  const months = Math.round(days / 30);
  return tr(`${months} 个月前`, `${months} ${months === 1 ? 'month' : 'months'} ago`);
}

export function formatDay(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  if (currentLanguage() === 'en') return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatTime(value) {
  const date = toDate(value);
  if (!date) return '';
  return `${formatDay(value)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function daysSince(value, now = new Date()) {
  const date = toDate(value);
  return date ? Math.max(0, Math.floor((now - date) / DAY)) : null;
}

const INTERVALS = { zh: { yearly: '年', monthly: '月', weekly: '周', daily: '天', hourly: '小时' }, en: { yearly: 'yr', monthly: 'mo', weekly: 'wk', daily: 'day', hourly: 'hr' } };
function money(amount, currency) {
  if (amount === null || amount === undefined) return null;
  const symbol = { USD: '$', CAD: 'CA$', GBP: '£', EUR: '€', INR: '₹' }[currency] ?? `${currency || ''} `;
  if (amount >= 10000) return `${symbol}${Math.round(amount / 1000)}k`;
  return `${symbol}${amount % 1 ? amount.toFixed(2) : amount}`;
}
export function salaryText(salary) {
  if (!salary || (salary.min === null && salary.max === null)) return '';
  const low = money(salary.min, salary.currency);
  const high = money(salary.max, salary.currency);
  const range = low && high && low !== high ? `${low}–${high}` : low || high;
  const unit = INTERVALS[currentLanguage()][salary.interval];
  const per = unit ? ` /${unit}` : '';
  const note = salary.source === 'estimate' ? tr('（估算）', ' (estimate)') : salary.source === 'description' ? tr('（职位描述）', ' (from description)') : '';
  return `${range}${per}${note}`;
}

export function jobTypeText(value) {
  const names = labels('jobType');
  return (value || '').split(',').map(part => names[part.trim().replace(/[\s-]/g, '').toLowerCase()] || part.trim()).filter(Boolean).join(' · ');
}

export function scoreTone(score) {
  if (score === null || score === undefined) return 'none';
  if (score >= 85) return 'strong';
  if (score >= 65) return 'good';
  if (score >= 40) return 'stretch';
  return 'weak';
}

export function localDateInput(value = new Date()) {
  const date = toDate(value) || new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
// A date picked in the form means that local day; store noon to stay on it in any timezone.
export function dateInputToIso(value) {
  return value ? new Date(`${value}T12:00:00`).toISOString() : null;
}

// The date above a page title, like "10.24 · 周六".
export const dateLine = locale => {
  const now = new Date();
  return `${now.getMonth() + 1}.${String(now.getDate()).padStart(2, '0')} · ${now.toLocaleDateString(locale, { weekday: 'short' })}`;
};
