export const SITE_LABELS = { linkedin: 'LinkedIn', indeed: 'Indeed', glassdoor: 'Glassdoor', zip_recruiter: 'ZipRecruiter', google: 'Google Jobs',
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', manual: '手动添加' };
export const STATUS_LABELS = { applied: '已投递', oa: '在线测评', interview: '面试中', offer: 'Offer', accepted: '已接受', rejected: '未通过',
  withdrawn: '已撤回', ghosted: '无回音' };
export const OPEN_STATUSES = ['applied', 'oa', 'interview', 'offer'];
export const VERDICT_LABELS = { strong: '高度匹配', good: '匹配', stretch: '有差距', weak: '不太匹配' };
export const JOB_TYPE_LABELS = { fulltime: '全职', parttime: '兼职', internship: '实习', contract: '合同', temporary: '临时' };
export const FLAG_LABELS = { 'follow-up-due': '该跟进了', 'ghost-suspected': '可能无回音' };
export const EVENT_LABELS = { status: '状态', note: '备注', 'posting-closed': '岗位关闭', 'posting-reopened': '岗位重新开放',
  'follow-up-due': '跟进提醒', 'ghost-suspected': '长时间无回复' };
export const SOURCE_LABELS = { user: '你', auto: '自动', mcp: 'Claude' };

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
  if (days <= 0) return days < 0 ? formatDay(value) : '今天';
  if (days === 1) return '昨天';
  if (days < 14) return `${days} 天前`;
  if (days < 60) return `${Math.round(days / 7)} 周前`;
  return `${Math.round(days / 30)} 个月前`;
}

export function formatDay(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
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

const INTERVALS = { yearly: '年', monthly: '月', weekly: '周', daily: '天', hourly: '小时' };
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
  const per = INTERVALS[salary.interval] ? ` /${INTERVALS[salary.interval]}` : '';
  return `${range}${per}${salary.source === 'estimate' ? '（估算）' : salary.source === 'description' ? '（职位描述）' : ''}`;
}

export function jobTypeText(value) {
  return (value || '').split(',').map(part => JOB_TYPE_LABELS[part.trim().replace(/[\s-]/g, '').toLowerCase()] || part.trim()).filter(Boolean).join(' · ');
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
