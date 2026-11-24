import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, MailSearch, RotateCcw, Square } from 'lucide-react';
import { api } from '../../api.js';
import { useI18n } from '../../i18n.jsx';
import { label, recentTime, usd } from '../format.js';
import { serverText } from '../server-text.js';
import { Markdown } from '../Markdown.jsx';
import { assistant, useAssistant } from './store.js';
import { Tip } from '../Tip.jsx';

const desktop = typeof window !== 'undefined' ? window.dayjobDesktop : null;

// How the last check stood with the mail, in a few words.
const MAIL = {
  read: ['读了邮件', 'mail read'],
  unread: ['没有去读邮件', 'mail not read'],
  refused: ['邮件没读到', 'mail could not be read'],
  off: ['没有读邮件（已关闭）', 'mail not read (switched off)'],
  missing: ['Claude Code 里没有 Gmail 连接器', 'no Gmail connector in Claude Code'],
  'needs-auth': ['Gmail 连接器需要重新登录', 'the Gmail connector is signed out'],
  failed: ['Gmail 连接器没有连上', 'the Gmail connector did not connect'],
};
// What to do about a mail connector that is not there, shown under a check that could not read mail.
const MAIL_HELP = {
  missing: ['在 claude.ai 的“连接器”里连接 Gmail（claude.ai/customize/connectors），再在这台电脑的 Claude Code 里输入 /mcp，看到“claude.ai Gmail”就可以了。Claude Code 要用 claude.ai 账号登录。',
    'Connect Gmail under Connectors on claude.ai (claude.ai/customize/connectors), then type /mcp in Claude Code on this computer: “claude.ai Gmail” should be listed. Claude Code has to be signed in with your claude.ai account.'],
  'needs-auth': ['在这台电脑的 Claude Code 里输入 /mcp，选“claude.ai Gmail”重新连接；或者到 claude.ai 的“连接器”里重新登录 Gmail。',
    'Type /mcp in Claude Code on this computer and reconnect “claude.ai Gmail”, or sign in to Gmail again under Connectors on claude.ai.'],
  failed: ['在这台电脑的 Claude Code 里输入 /mcp，看看“claude.ai Gmail”为什么没有连上。', 'Type /mcp in Claude Code on this computer to see why “claude.ai Gmail” did not connect.'],
  refused: ['搜索邮件的请求没有成功：可能是 Claude Code 不让这个连接器在后台运行，也可能是 Gmail 连接器出了错。点“看助手是怎么查的”能看到助手怎么说；也可以在 Claude Code 里输入 /mcp 看看“claude.ai Gmail”。',
    'The mail search did not go through: Claude Code may not let this connector run in the background, or the Gmail connector failed. “See how the assistant checked” shows what the assistant said; you can also type /mcp in Claude Code and look at “claude.ai Gmail”.'],
};
const STATE = { done: ['查完了', 'done'], stopped: ['被停下了', 'stopped'], failed: ['没有查成', 'did not finish'], nothing: ['没有在进行中的申请，没有查', 'no open applications, nothing to check'] };

// 申请状态检查: the card above the list of applications. One line says how the last check went; opened, it has
// the switches, what the check changed (each change can be taken back while Dayjob stays open) and its summary.
export function StatusCheck({ boot, reload }) {
  const { t } = useI18n();
  const { check } = useAssistant();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void assistant.refreshCheck(); }, []);
  if (!check) return null;
  const { settings, last, running } = check;
  const act = work => async () => {
    setError('');
    try { await work(); } catch (failure) { setError(serverText(failure.message)); }
  };
  const toggle = key => act(() => assistant.saveCheck({ [key]: !settings[key] }));
  const loginItem = desktop && boot?.settings?.desktop;
  const startWithComputer = act(async () => {
    await api('/api/settings', { method: 'PATCH', body: { desktop: { openAtLogin: !boot.settings.desktop.openAtLogin } } });
    await reload();
  });
  const moved = (last?.changes || []).filter(change => !change.undone);
  const when = last ? recentTime(last.at) : '';
  const line = running ? t('正在查邮件和申请页面…', 'Checking mail and application pages…')
    : !last ? t('还没有查过。', 'Not run yet.')
      : last.state === 'done' ? `${t('上次', 'Last')} ${when} · ${last.mail && MAIL[last.mail] ? `${t(...MAIL[last.mail])} · ` : ''}${moved.length ? t(`${moved.length} 处变化`, `${moved.length} ${moved.length === 1 ? 'change' : 'changes'}`) : t('没有新进展', 'no news')}`
        : `${t('上次', 'Last')} ${when} · ${t(...(STATE[last.state] || STATE.failed))}`;
  return (
    <section className={`status-check${open ? ' open' : ''}`} aria-label={t('申请状态检查', 'Status check')}>
      <div className="status-check-line">
        <MailSearch size={17} />
        <strong>{t('申请状态检查', 'Status check')}</strong>
        <span className="status-check-last">{line}</span>
        <div className="status-check-actions">
          {running
            ? <button type="button" className="button" onClick={act(() => assistant.stopCheck())}><Square size={13} />{t('停下', 'Stop')}</button>
            : <button type="button" className="button" data-fx="pop" onClick={act(() => assistant.runCheck())}><MailSearch size={14} />{t('现在查一次', 'Check now')}</button>}
          <button type="button" className="icon-button" aria-expanded={open} title={open ? t('收起', 'Fold') : t('展开', 'More')} onClick={() => setOpen(value => !value)}>{open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
        </div>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      {open ? (
        <div className="status-check-body">
          <Tip>{t('助手用这台电脑上的 Claude Code 去查：通过你在 claude.ai 连好的 Gmail 连接器搜索并读和申请有关的邮件（只能搜索和读，不能发、删或改），再到投递用的网站上看申请状态（只看，不提交任何东西）。查到的进展记到对应申请的时间线上。每次都会用 Claude Code 的额度；读到的邮件内容会交给 Claude。',
            'The assistant checks with the Claude Code on this computer: through the Gmail connector you set up on claude.ai it searches and reads mail about your applications (it can only search and read, never send, delete or change), then looks at the sites you applied through (it only looks and submits nothing). What it finds goes on the application\'s timeline. Each check draws on your Claude Code allowance, and the mail it reads is given to Claude.')}</Tip>
          <div className="status-check-options">
            <label className="check-line"><input type="checkbox" checked={settings.enabled} onChange={toggle('enabled')} />{t('每天第一次打开 Dayjob 时自动查一次', 'Check by itself the first time Dayjob starts each day')}</label>
            {loginItem ? <label className="check-line"><input type="checkbox" checked={Boolean(boot.settings.desktop.openAtLogin)} onChange={startWithComputer} />{t('开机时启动 Dayjob（留在托盘里）', 'Start Dayjob with the computer (in the tray)')}</label> : null}
            <label className="check-line"><input type="checkbox" checked={settings.mail} onChange={toggle('mail')} />{t('读邮件', 'Read mail')}</label>
            <label className="check-line"><input type="checkbox" checked={settings.pages} disabled={!check.browser} onChange={toggle('pages')} />{t('查看申请页面（每次最多 3 个）', 'Look at application pages (3 at most each time)')}</label>
          </div>
          {last && MAIL_HELP[last.mail] ? <p className="notice">{t(...MAIL[last.mail])}{t('。', '. ')}{t(...MAIL_HELP[last.mail])}</p> : null}
          {last?.error && !MAIL_HELP[last.mail] ? <p className="notice error">{serverText(last.error)}</p> : null}
          {last?.changes?.length ? (
            <ul className="status-check-changes">
              {last.changes.map(change => (
                <li key={change.id} className={change.undone ? 'undone' : ''}>
                  <div><strong>{change.company}</strong> <span>{change.title}</span>{change.status ? <em data-status={change.status}>{label('status', change.status)}</em> : null}</div>
                  {change.note ? <p>{change.note}</p> : null}
                  {change.undone ? <small>{t('已撤销', 'Undone')}</small>
                    : change.undoable ? <button type="button" className="button" onClick={act(() => assistant.undoCheck(last.conversationId, change.id))}><RotateCcw size={13} />{t('撤销', 'Undo')}</button> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {last?.summary ? <div className="status-check-summary"><Markdown text={last.summary} /></div> : null}
          {last && (last.tokens || last.conversationId) ? (
            <p className="hint status-check-foot">
              {last.tokens ? t(`这次用了约 ${last.tokens.toLocaleString()} 个 token${typeof last.cost === 'number' ? `（按 API 价格约 ${usd(last.cost)}）` : ''}。`, `This check used about ${last.tokens.toLocaleString()} tokens${typeof last.cost === 'number' ? ` (about ${usd(last.cost)} at API prices)` : ''}.`) : null}
              {(running?.conversationId || last.conversationId) ? <button type="button" className="link" onClick={() => assistant.openCheck(running?.conversationId || last.conversationId)}>{t('看助手是怎么查的', 'See how the assistant checked')}</button> : null}
            </p>
          ) : running ? <p className="hint status-check-foot"><button type="button" className="link" onClick={() => assistant.openCheck(running.conversationId)}>{t('看助手正在做什么', 'See what the assistant is doing')}</button></p> : null}
        </div>
      ) : null}
    </section>
  );
}
