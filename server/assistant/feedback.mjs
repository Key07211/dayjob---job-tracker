import fs from 'node:fs';
import path from 'node:path';

// 问题反馈文件: one file on this computer that gathers how each application the assistant worked on went. After a
// reply that worked on an application is over, Dayjob adds an entry: the job, how it ended, where it stopped and
// why, the problems on the way (what the assistant reported, and the tool calls Dayjob saw fail), how long it took
// and what it used in tokens. The entry is written by Dayjob, so there is one even when the model reports nothing.
//
// The file is Markdown, newest entry last, at <data folder>/feedback/apply-feedback.md. It never holds a password
// or what was typed into a form: what the model reports is cut short and has addresses and long numbers taken out.
// A file that has grown past ROTATE_AT is put aside under a dated name and a new one begun.
export const FEEDBACK_FILE = 'apply-feedback.md';
const ROTATE_AT = 2 * 1024 * 1024;
const READ_MAX = 300000;

const OUTCOMES = {
  submitted: ['已投递', 'Sent'],
  unconfirmed: ['助手说已提交，但 Dayjob 没有看到确认页', 'The assistant says it was sent, but Dayjob saw no confirmation page'],
  'needs-user': ['没投出去：需要你来处理', 'Not sent: it needs you'],
  failed: ['没投出去：失败', 'Not sent: failed'],
  skipped: ['没有投：跳过了', 'Not sent: skipped'],
  stopped: ['没投出去：被你停止了', 'Not sent: you stopped it'],
  error: ['没投出去：助手出错了', 'Not sent: the assistant ran into an error'],
  unclear: ['没有投出去，助手也没有说明原因', 'Not sent, and the assistant gave no reason'],
};
const STEPS = { open: ['打开页面', 'Opening the page'], login: ['登录', 'Signing in'], fill: ['填写表单', 'Filling in the form'], resume: ['附简历', 'Attaching the resume'],
  questions: ['回答问题', 'Answering questions'], confirm: ['确认提交', 'Confirming'], record: ['记录', 'Recording'] };
const ENGINES = { 'claude-cli': 'Claude Code', 'anthropic-api': 'Claude API' };

// Nothing that looks like an address, a number of six digits or more (a code, a phone number) or a line break goes
// into the file; text is cut to `max`.
export function scrub(text, max = 300) {
  const line = String(text ?? '').replace(/\s+/g, ' ').replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]').replace(/\+?\d[\d\s().-]{4,}\d/g, '[number]').replace(/\|/g, '/').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
// A job's or a site's name is no secret: only its shape is tidied.
const plain = (text, max) => { const line = String(text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim(); return line.length > max ? `${line.slice(0, max)}…` : line; };
const grouped = value => String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const money = value => (value === null || value === undefined ? null : `$${value >= 0.995 ? value.toFixed(2) : value.toFixed(3)}`);
const pad = value => String(value).padStart(2, '0');
const stamp = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

// What the steps of a reply used together. cost is null when no step had a price.
export function sumSteps(steps = []) {
  const total = { steps: steps.length, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: null };
  for (const step of steps) {
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) total[key] += Number(step[key]) || 0;
    if (typeof step.cost === 'number') total.cost = (total.cost || 0) + step.cost;
  }
  return total;
}

// One entry as Markdown. entry: { at (Date), job, site, outcome, stoppedAt, reason, problems: [{ at, what, why }],
// failures: [{ tool, error, count }], engine, model, durationMs, steps: [...], again }.
export function entryText(entry, english = false) {
  const t = (zh, en) => (english ? en : zh);
  const pair = pairOf => (pairOf ? pairOf[english ? 1 : 0] : '');
  const total = sumSteps(entry.steps);
  const seconds = Math.max(0, Math.round((entry.durationMs || 0) / 1000));
  const took = seconds >= 60 ? t(`${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`, `${Math.floor(seconds / 60)} min ${seconds % 60} s`) : t(`${seconds} 秒`, `${seconds} s`);
  const input = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens;
  const cost = money(total.cost);
  const lines = [
    `## ${stamp(entry.at)} · ${plain(entry.job || t('（没有岗位名）', '(no job name)'), 160)}${entry.again ? t('（接着上一次）', ' (continued)') : ''}`,
    '',
    `- ${t('结果', 'Result')}: ${pair(OUTCOMES[entry.outcome] || OUTCOMES.unclear)}`,
    ...(entry.stoppedAt && entry.outcome !== 'submitted' ? [`- ${t('停在', 'Stopped at')}: ${pair(STEPS[entry.stoppedAt]) || entry.stoppedAt}`] : []),
    ...(entry.reason ? [`- ${t('原因', 'Why')}: ${scrub(entry.reason)}`] : []),
    ...(entry.site ? [`- ${t('网站', 'Site')}: ${plain(entry.site, 80)}`] : []),
    `- ${t('引擎和模型', 'Engine and model')}: ${ENGINES[entry.engine] || entry.engine || '?'}${entry.model ? ` · ${entry.model}` : ''}`,
    `- ${t('用时', 'Time')}: ${took}${t(`，共 ${total.steps} 步`, `, ${total.steps} ${total.steps === 1 ? 'step' : 'steps'}`)}`,
    `- Token: ${t(`输入 ${grouped(input)}（其中读缓存 ${grouped(total.cacheReadTokens)}，写缓存 ${grouped(total.cacheWriteTokens)}），输出 ${grouped(total.outputTokens)}`,
      `input ${grouped(input)} (${grouped(total.cacheReadTokens)} read from the cache, ${grouped(total.cacheWriteTokens)} written to it), output ${grouped(total.outputTokens)}`)}`
      + (cost ? t(`；约 ${cost}${entry.engine === 'claude-cli' ? '（Claude Code 走订阅，这是按 API 价格折算的参考数）' : ''}`, `; about ${cost}${entry.engine === 'claude-cli' ? ' (Claude Code runs on a subscription; this is what it would cost at API prices)' : ''}`) : ''),
  ];
  // The three steps that used the most, so the costly part of an application can be told at a glance.
  const weight = step => (typeof step.cost === 'number' ? step.cost : ((step.inputTokens || 0) + (step.cacheWriteTokens || 0) * 1.25 + (step.cacheReadTokens || 0) * 0.05 + (step.outputTokens || 0) * 5) / 1e6);
  const heavy = [...(entry.steps || [])].sort((a, b) => weight(b) - weight(a)).slice(0, 3).filter(step => weight(step) > 0);
  if (heavy.length && total.steps > 3) {
    lines.push(`- ${t('用得最多的几步', 'The steps that used the most')}: ${heavy.map(step => {
      const what = step.kind === 'compact' ? t('压缩上文', 'compacting') : (step.tools || []).join(', ') || t('只回答', 'answer only');
      const used = grouped((step.inputTokens || 0) + (step.cacheReadTokens || 0) + (step.cacheWriteTokens || 0));
      return t(`第 ${step.n} 步（${what}）输入 ${used}、输出 ${grouped(step.outputTokens)}${money(step.cost) ? `，${money(step.cost)}` : ''}`,
        `step ${step.n} (${what}) input ${used}, output ${grouped(step.outputTokens)}${money(step.cost) ? `, ${money(step.cost)}` : ''}`);
    }).join(t('；', '; '))}`);
  }
  const problems = [
    ...(entry.problems || []).map(problem => `${problem.at && STEPS[problem.at] ? `[${pair(STEPS[problem.at])}] ` : ''}${scrub(problem.what, 200)}${problem.why ? t(`：${scrub(problem.why)}`, `: ${scrub(problem.why)}`) : ''}`),
    ...(entry.failures || []).map(failure => t(`${failure.tool} 没做成${failure.count > 1 ? ` ${failure.count} 次` : ''}：${scrub(failure.error, 200)}（Dayjob 记录）`,
      `${failure.tool} did not work${failure.count > 1 ? ` ${failure.count} times` : ''}: ${scrub(failure.error, 200)} (noted by Dayjob)`)),
  ];
  lines.push('');
  if (problems.length) lines.push(t('遇到的问题：', 'Problems on the way:'), '', ...problems.map((problem, index) => `${index + 1}. ${problem}`));
  else lines.push(t('没有记录到问题。', 'No problems were noted.'));
  return `${lines.join('\n')}\n`;
}

// dir: the folder the file lives in, or null to keep the entries in memory only (tests, a database in memory).
// english: () => whether the entries are written in English (the language of the window when they are written).
export function createFeedback({ dir = null, english = () => false, now = () => new Date(), log = console.warn } = {}) {
  const file = dir ? path.join(dir, FEEDBACK_FILE) : null;
  const kept = [];
  const head = () => (english()
    ? '# Dayjob: how the assistant\'s applications went\n\nDayjob adds an entry here after each application the assistant worked on: how it ended, the problems on the way, and what it used. Newest last.\n\n'
    : '# Dayjob 申请问题反馈\n\n助手每做完一次申请，Dayjob 就在这里加一条：结果怎样、过程中遇到了什么问题、用了多少。最新的在最后。\n\n');
  function add(entry) {
    const text = entryText({ ...entry, at: entry.at || now() }, english());
    if (!file) { kept.push(text); return text; }
    try {
      fs.mkdirSync(dir, { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* a first entry */ }
      if (size > ROTATE_AT) {
        const at = now();
        fs.renameSync(file, path.join(dir, `apply-feedback-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.md`));
        size = 0;
      }
      fs.appendFileSync(file, `${size ? '\n' : head()}${text}`, 'utf8');
    } catch (error) { log(`[dayjob] assistant: could not write the feedback file: ${error.message}`); }
    return text;
  }
  // The file as it stands (its end, when it is long), and how many entries it holds.
  function read() {
    let text = kept.join('\n');
    if (file) {
      try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
    }
    const entries = (text.match(/^## /gm) || []).length;
    const cut = text.length > READ_MAX;
    if (cut) text = text.slice(text.indexOf('\n## ', text.length - READ_MAX) + 1 || text.length - READ_MAX);
    return { file, folder: dir, entries, cut, text };
  }
  return { file, folder: dir, add, read };
}
