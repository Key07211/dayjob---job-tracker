import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, CircleCheck, FileText, FolderOpen, Hourglass, ShieldAlert, Square, TriangleAlert, X } from 'lucide-react';
import { api } from '../../api.js';
import { useI18n } from '../../i18n.jsx';
import { Select } from '../groove/Picker.jsx';
import { assistant, useAssistant } from './store.js';
import { Gramophone } from './Gramophone.jsx';

// 同时申请: the applications that have a conversation of their own, as the window shows them. A button at the top of
// a job's details starts one; the pane lists them and looks in on any of them; a reply shows what each of its steps
// used; and Settings has how many run at once and the feedback file.

const desktop = typeof window !== 'undefined' ? window.dayjobDesktop : undefined;

// How an application stands: waiting its turn, at work, waiting for the user's answer before something is sent, or
// how it ended (sent; handed over to the user, who has something to do first; said to be sent with no confirmation
// page seen; stopped; not sent).
// approvals: the questions the Dayjob browser has open, each with the conversation (run) it belongs to.
export function runStatus(run, approvals = []) {
  if (run.state === 'queued') return 'queued';
  if (run.state === 'working') return approvals.some(item => item.run === run.id) ? 'asking' : 'working';
  return { submitted: 'sent', stopped: 'stopped', 'needs-user': 'handover', unconfirmed: 'unsure' }[run.outcome] || 'unsent';
}
export const RUN_STATUS = { queued: ['排队中', 'Waiting'], working: ['申请中', 'Applying'], asking: ['等你确认', 'Confirm'], sent: ['已投递', 'Sent'], stopped: ['已停止', 'Stopped'], handover: ['等你处理', 'Your turn'],
  unsure: ['待核实', 'Check it'], unsent: ['没投成', 'Not sent'] };
const OUTCOMES = { unconfirmed: ['助手说已提交，但没有看到确认页', 'It says it was sent, but no confirmation page was seen'], 'needs-user': ['需要你来处理', 'It needs you'], failed: ['失败了', 'It failed'], skipped: ['跳过了', 'Skipped'],
  stopped: ['你停止了它', 'You stopped it'], error: ['助手出错了', 'The assistant ran into an error'], unclear: ['没有投出去', 'It was not sent'] };
const StatusIcon = ({ status, size = 13 }) => (status === 'queued' ? <Hourglass size={size} /> : status === 'working' ? <i className="asst-dots" aria-hidden="true"><b /><b /><b /></i>
  : status === 'asking' || status === 'handover' ? <ShieldAlert size={size} /> : status === 'sent' ? <CircleCheck size={size} /> : status === 'stopped' ? <Square size={size - 2} /> : <TriangleAlert size={size} />);

export const compact = tokens => (tokens >= 1e6 ? `${(tokens / 1e6).toFixed(tokens >= 1e7 ? 0 : 1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens || 0));
const grouped = value => Math.round(value || 0).toLocaleString('en-US');
export const dollars = cost => (typeof cost === 'number' ? `$${cost >= 0.995 ? cost.toFixed(2) : cost.toFixed(3)}` : '');

// The gramophone on the button plays while its application is at work, and takes no notes from other conversations.
const silent = () => () => {};

// At the top of a job's details, beside its title: has the assistant apply to it. Once started it says how the
// application stands, and a press opens its conversation. approvals: see runStatus. onError: where a refusal is shown.
export function ApplyButton({ item, approvals = [], onError = () => {} }) {
  const { t } = useI18n();
  const { runs } = useAssistant();
  const [starting, setStarting] = useState(false);
  const run = runs.find(entry => entry.postingId === item.id);
  const job = [item.company, item.title].filter(Boolean).join(' · ');
  async function start() {
    setStarting(true);
    onError('');
    try { await assistant.apply(item.id); } catch (failure) { onError(failure.message); } finally { setStarting(false); }
  }
  if (run) {
    const status = runStatus(run, approvals);
    const why = ['unsent', 'handover', 'unsure'].includes(status) ? [t(...(OUTCOMES[run.outcome] || OUTCOMES.unclear)), run.reason].filter(Boolean).join(t('：', ': ')) : '';
    return (
      <button type="button" className={`detail-apply ${status}`} onClick={() => assistant.openRun(run.id)}
        title={why || t('打开这次申请的对话', 'Open this application\'s conversation')} aria-label={t(`${job}：${RUN_STATUS[status][0]}，打开对话`, `${job}: ${RUN_STATUS[status][1]}, open the conversation`)}>
        <Gramophone phase={status === 'working' ? 'thinking' : 'idle'} scale={1} live={status === 'working'} voice={silent} />
        <span className="detail-apply-text"><small>{t('助手', 'Assistant')}</small><strong><StatusIcon status={status} size={14} />{t(...RUN_STATUS[status])}</strong></span>
      </button>
    );
  }
  return (
    <button type="button" className="detail-apply" disabled={starting} onClick={start}
      title={t('让助手在 Dayjob 浏览器里申请这个岗位，可以同时让它申请几个', 'Have the assistant apply to this job in the Dayjob browser; several can run at once')} aria-label={t(`让助手申请：${job}`, `Have the assistant apply: ${job}`)}>
      <Gramophone scale={1} />
      <span className="detail-apply-text"><strong>{t('让助手申请', 'Apply for me')}</strong></span>
    </button>
  );
}

// On a job in the list, once the assistant has an application for it: how it stands. A press opens its conversation.
export function RunChip({ item, approvals = [] }) {
  const { t } = useI18n();
  const { runs } = useAssistant();
  const run = runs.find(entry => entry.postingId === item.id);
  if (!run) return null;
  const status = runStatus(run, approvals);
  const job = [item.company, item.title].filter(Boolean).join(' · ');
  const why = ['unsent', 'handover', 'unsure'].includes(status) ? [t(...(OUTCOMES[run.outcome] || OUTCOMES.unclear)), run.reason].filter(Boolean).join(t('：', ': ')) : '';
  return (
    <button type="button" className={`row-apply ${status}`} onClick={() => assistant.openRun(run.id)}
      title={why || t('打开这次申请的对话', 'Open this application\'s conversation')} aria-label={t(`${job}：${RUN_STATUS[status][0]}，打开对话`, `${job}: ${RUN_STATUS[status][1]}, open the conversation`)}>
      <StatusIcon status={status} /><span>{t(...RUN_STATUS[status])}</span>
    </button>
  );
}

// In the pane: every application, with how it stands and what it has used. A press opens its conversation; one at
// work or waiting can be stopped, one that is over taken off the list.
export function RunsStrip({ approvals = [], currentId = null }) {
  const { t } = useI18n();
  const { runs } = useAssistant();
  const [folded, setFolded] = useState(false);
  if (!runs.length) return null;
  const count = status => runs.filter(run => runStatus(run, approvals) === status).length;
  const parts = [count('asking') ? t(`${count('asking')} 个等你确认`, `${count('asking')} to confirm`) : '', count('working') ? t(`${count('working')} 个进行中`, `${count('working')} applying`) : '',
    count('queued') ? t(`${count('queued')} 个排队`, `${count('queued')} waiting`) : ''].filter(Boolean);
  return (
    <section className={`asst-runs${count('asking') ? ' asking' : ''}`} aria-label={t('助手正在做的申请', 'Applications the assistant is working on')}>
      <button type="button" className={`asst-runs-head${folded ? '' : ' open'}`} aria-expanded={!folded} onClick={() => setFolded(value => !value)}>
        <ChevronRight size={14} /><strong>{t(`申请 ${runs.length}`, `Applications ${runs.length}`)}</strong>{parts.length ? <small>{parts.join(' · ')}</small> : null}
      </button>
      {folded ? null : (
        <ul>
          {runs.map(run => {
            const status = runStatus(run, approvals);
            const used = run.steps ? t(`${run.steps} 步 · ${compact(run.tokens)}`, `${run.steps} ${run.steps === 1 ? 'step' : 'steps'} · ${compact(run.tokens)}`) + (dollars(run.cost) ? ` · ${dollars(run.cost)}` : '') : '';
            const over = run.state === 'done';
            return (
              <li key={run.id} className={`${status}${run.id === currentId ? ' current' : ''}`}>
                <button type="button" className="asst-run-open" onClick={() => assistant.openRun(run.id)} title={over && run.reason ? run.reason : run.job}>
                  <StatusIcon status={status} />
                  <span className="asst-run-job">{run.job}</span>
                  <small>{t(...RUN_STATUS[status])}{used ? ` · ${used}` : ''}</small>
                </button>
                {over ? <button type="button" className="icon-button" title={t('从列表里拿掉', 'Take off the list')} aria-label={t(`从列表里拿掉：${run.job}`, `Take off the list: ${run.job}`)} onClick={() => assistant.dismissRun(run.id)}><X size={14} /></button>
                  : <button type="button" className="icon-button" title={t('停止这个申请', 'Stop this application')} aria-label={t(`停止：${run.job}`, `Stop: ${run.job}`)} onClick={() => assistant.stopRun(run.id)}><Square size={12} /></button>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Under a reply: what it used, and, unfolded, each step by itself (a step is one request to the model, with the
// tools it then ran). Claude Code runs on a subscription, so its dollars are only what the tokens would have cost.
export function StepUsage({ turn }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const list = useRef(null);
  useEffect(() => { if (open) list.current?.scrollIntoView({ block: 'nearest' }); }, [open]);
  const steps = turn.steps || [];
  if (!steps.length) return null;
  const sum = key => steps.reduce((total, step) => total + (step[key] || 0), 0);
  const input = sum('inputTokens') + sum('cacheReadTokens') + sum('cacheWriteTokens');
  const priced = steps.filter(step => typeof step.cost === 'number');
  const cost = priced.length ? priced.reduce((total, step) => total + step.cost, 0) : null;
  const plan = turn.engine === 'claude-cli';
  const money = value => (dollars(value) ? `${plan ? '≈ ' : ''}${dollars(value)}` : '');
  return (
    <div className="asst-usage">
      <button type="button" className={open ? 'open' : ''} aria-expanded={open} onClick={() => setOpen(value => !value)}
        title={plan ? t('Claude Code 走订阅，金额是按 API 价格折算的参考数', 'Claude Code runs on a subscription; the dollars are what it would cost at API prices') : undefined}>
        <ChevronRight size={12} />
        {t(`${steps.length} 步 · 输入 ${compact(input)}（读缓存 ${compact(sum('cacheReadTokens'))}）· 输出 ${compact(sum('outputTokens'))}`,
          `${steps.length} ${steps.length === 1 ? 'step' : 'steps'} · in ${compact(input)} (${compact(sum('cacheReadTokens'))} cached) · out ${compact(sum('outputTokens'))}`)}{money(cost) ? ` · ${money(cost)}` : ''}
      </button>
      {open ? (
        <ol className="asst-usage-steps" ref={list} aria-label={t('每一步的 token', 'Tokens for each step')}>
          {steps.map(step => (
            <li key={step.n}>
              <b>{step.n}</b>
              <span>{step.kind === 'compact' ? t('压缩上文', 'Compacting') : (step.tools || []).join(', ') || t('只回答', 'Answer only')}</span>
              <i>{money(step.cost)}</i>
              <small>{t(`输入 ${grouped(step.inputTokens)} · 读缓存 ${grouped(step.cacheReadTokens)} · 写缓存 ${grouped(step.cacheWriteTokens)} · 输出 ${grouped(step.outputTokens)}`,
                `in ${grouped(step.inputTokens)} · cache read ${grouped(step.cacheReadTokens)} · cache write ${grouped(step.cacheWriteTokens)} · out ${grouped(step.outputTokens)}`)}</small>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

// Settings → Assistant: how many applications run at once, and the feedback file Dayjob keeps about them.
export function ApplyingSettings() {
  const { t } = useI18n();
  const { info } = useAssistant();
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const load = () => api('/api/assistant/feedback').then(setFeedback).catch(failure => setError(failure.message));
  useEffect(() => { void load(); }, []);
  if (!info?.browser) return null;
  const { min, max } = info.parallel || { min: 1, max: 5 };
  const choices = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  return (
    <>
      <div className="option-row" data-guide="assistant">
        <span>{t('同时申请', 'At the same time')}</span>
        <Select value={String(info.settings.parallel)} onChange={event => assistant.saveSettings({ parallel: Number(event.target.value) })} aria-label={t('助手同时进行几个申请', 'How many applications the assistant works on at once')}>
          {choices.map(count => <option key={count} value={count}>{t(`${count} 个`, String(count))}</option>)}
        </Select>
        <small>{t('岗位详情右上角的“让助手申请”各开一个自己的对话和浏览器标签页。同时进行的不超过这个数，多出来的排队。每个申请都在单独花 token，数越大花得越快。',
          '“Apply for me” at the top of a job’s details gives it a conversation and a browser tab of its own. No more than this many run at once; the rest wait in line. Each application spends tokens of its own, so a higher number spends them faster.')}</small>
      </div>
      <div className="option-row feedback-row" data-guide="assistant">
        <span>{t('问题反馈文件', 'Feedback file')}</span>
        <div className="form-actions">
          <button type="button" className="button" aria-expanded={reading} onClick={() => { if (!reading) void load(); setReading(value => !value); }}><FileText size={15} />{reading ? t('收起', 'Hide') : t('查看', 'Read')}</button>
          {desktop?.openDataFolder && feedback?.folder ? <button type="button" className="button" data-fx="folder" onClick={() => desktop.openDataFolder('feedback').catch(failure => setError(failure.message))}><FolderOpen size={15} />{t('打开文件夹', 'Open folder')}</button> : null}
        </div>
        <small>{t('助手每做完一次申请，Dayjob 自动在这个文件里记一条：结果、停在哪一步、为什么没投成、过程中遇到的问题、用了多少 token。不记密码，也不记表单里填的内容。',
          'After each application the assistant works on, Dayjob adds an entry to this file: how it ended, where it stopped, why it was not sent, the problems on the way, and the tokens it used. No passwords, and nothing that was typed into a form.')}
          {feedback ? ` ${t(`现在有 ${feedback.entries} 条。`, `${feedback.entries} ${feedback.entries === 1 ? 'entry' : 'entries'} so far.`)}` : ''}
          {feedback?.file ? <code className="feedback-path">{feedback.file}</code> : null}</small>
        {error ? <p className="notice error" onClick={() => setError('')}>{error}</p> : null}
        {reading && feedback ? (feedback.text
          ? <pre className="feedback-text" tabIndex={0} aria-label={t('问题反馈文件的内容', 'What the feedback file says')}>{feedback.cut ? t('（文件很长，这里是最后一部分）\n\n', '(The file is long; this is its last part.)\n\n') : ''}{feedback.text}</pre>
          : <p className="hint"><Check size={14} />{t('还没有记录。助手做完第一次申请后，这里就会有内容。', 'Nothing yet. There will be an entry after the first application the assistant works on.')}</p>) : null}
      </div>
    </>
  );
}
