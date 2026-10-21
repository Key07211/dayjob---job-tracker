import { useEffect, useState } from 'react';
import { CheckCircle2, FolderOpen, Link2, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { LanguageSwitch, useI18n } from '../i18n.jsx';
import { serverText } from './server-text.js';

const desktop = typeof window !== 'undefined' ? window.dayjobDesktop : undefined;
const CLAUDE_STATES = { ready: ['已连接', 'Connected'], missing: ['未连接', 'Not connected'], conflict: ['已有同名连接（未改动）', 'Another Dayjob connection exists (left as is)'],
  error: ['连接异常', 'Connection problem'], unavailable: ['没有找到 Claude Code 或 Claude Desktop', 'Claude Code or Claude Desktop not found'] };

function ClaudeConnection() {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { desktop?.getClaudeStatus().then(setStatus).catch(() => {}); }, []);
  if (!desktop) {
    return (
      <section className="card-section">
        <h2><Link2 size={18} />{t('连接 Claude（MCP）', 'Connect Claude (MCP)')}</h2>
        <p className="hint">{t('在桌面版里可以一键连接。源码运行时，在终端执行：', 'The desktop app connects in one click. When running from source, run this in a terminal:')}</p>
        <pre className="code">{`claude mcp add dayjob -s user -e DAYJOB_URL=http://127.0.0.1:4318 -- node <${t('Dayjob 文件夹', 'Dayjob folder')}>/integrations/mcp-server.mjs`}</pre>
      </section>
    );
  }
  async function run(work) {
    setBusy(true);
    setError('');
    try { setStatus(await work()); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return (
    <section className="card-section">
      <h2><Link2 size={18} />{t('连接 Claude（MCP）', 'Connect Claude (MCP)')}</h2>
      <p className="hint">{t('连接后，在 Claude Code 或 Claude Desktop 里可以说“看看今天高匹配的岗位”“对照我的简历分析这个岗位”“根据 Gmail 更新我的投递状态”。Claude 需要 Dayjob 保持运行。',
        'Once connected, ask Claude Code or Claude Desktop things like “show today\'s strong matches”, “analyse this job against my resume” or “update my applications from Gmail”. Dayjob needs to be running.')}</p>
      <p className={`status-line ${status?.state === 'ready' ? 'ok' : 'off'}`}>
        {status?.state === 'ready' ? <CheckCircle2 size={15} /> : null}
        {status ? t(...(CLAUDE_STATES[status.state] || [status.state, status.state])) : t('检查中…', 'Checking…')}
        {status?.clients?.filter(client => client.state !== 'unavailable').map(client => <span key={client.id} className="muted"> · {client.label}</span>)}
      </p>
      {status?.message && status.state !== 'ready' ? <p className="hint">{serverText(status.message)}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions">
        <button className="button" onClick={() => run(() => desktop.checkClaude())} disabled={busy}><RefreshCw size={15} />{t('重新检查', 'Check again')}</button>
        {status?.state !== 'ready' ? <button className="button primary" onClick={() => run(() => desktop.connectClaude())} disabled={busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Link2 size={15} />}{t('连接到 Claude', 'Connect to Claude')}</button> : null}
      </div>
      <p className="hint">{t('会写入 Claude Code 的 ~/.claude.json 和 Claude Desktop 的配置文件（改之前自动备份）。Claude Desktop 需要重启后才会看到新工具。',
        'Writes Claude Code\'s ~/.claude.json and Claude Desktop\'s config file, backing each up first. Restart Claude Desktop to see the new tools.')}</p>
    </section>
  );
}

export function SettingsView({ boot, reload }) {
  const { t } = useI18n();
  const settings = boot.settings;
  const [form, setForm] = useState({ scheduleEnabled: settings.schedule.enabled, time: settings.schedule.time,
    followUpDays: settings.tracking.followUpDays, ghostDays: settings.tracking.ghostDays, checkClosed: settings.tracking.checkClosed,
    desktop: settings.notifications.desktop, minScore: settings.notifications.minScore, pythonCommand: settings.jobspy.pythonCommand,
    retentionDays: settings.retentionDays });
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('dayjob-theme') || 'system'; } catch { return 'system'; } });
  const [sites, setSites] = useState(boot.sites);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  useEffect(() => { desktop?.getInfo().then(setInfo).catch(() => {}); }, []);

  function applyTheme(value) {
    setTheme(value);
    try { localStorage.setItem('dayjob-theme', value); } catch { /* optional */ }
    const dark = value === 'dark' || (value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'night' : 'day';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }
  async function save(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      await api('/api/settings', { method: 'PATCH', body: {
        schedule: { enabled: form.scheduleEnabled, time: form.time },
        tracking: { followUpDays: Number(form.followUpDays), ghostDays: Number(form.ghostDays), checkClosed: form.checkClosed },
        notifications: { desktop: form.desktop, minScore: Number(form.minScore) },
        jobspy: { pythonCommand: form.pythonCommand },
        retentionDays: Number(form.retentionDays),
      } });
      await reload();
      setSites(await api('/api/sites?refresh=1'));
      setMessage(t('已保存。', 'Saved.'));
    } catch (failure) { setError(failure.message); }
  }
  const jobspy = sites.find(site => site.engine === 'jobspy');

  return (
    <section className="settings-page">
      <header className="view-header"><div><h1>{t('设置', 'Settings')}</h1><p>{t('所有数据保存在本机的 SQLite 数据库里。', 'All data stays in a SQLite database on this computer.')}</p></div></header>
      <form className="card-section" onSubmit={save}>
        <h2>{t('每日抓取', 'Daily search')}</h2>
        <div className="form-grid">
          <label className="check-line"><input type="checkbox" checked={form.scheduleEnabled} onChange={event => set('scheduleEnabled', event.target.checked)} />{t('每天自动抓取', 'Search every day')}</label>
          <label>{t('时间', 'Time')}<input type="time" value={form.time} onChange={event => set('time', event.target.value)} required /><small>{t('电脑关机错过时，下次打开 Dayjob 会补上当天的抓取。', 'If the computer was off, Dayjob catches up when it next opens that day.')}</small></label>
          <label>{t('岗位保留天数', 'Keep jobs (days)')}<input type="number" min={7} max={365} value={form.retentionDays} onChange={event => set('retentionDays', event.target.value)} /><small>{t('未收藏、未投递的旧岗位到期清理。', 'Old jobs you did not save or apply to are cleared after this.')}</small></label>
        </div>
        <h2>{t('投递追踪', 'Application tracking')}</h2>
        <div className="form-grid">
          <label>{t('跟进提醒（天）', 'Follow-up reminder (days)')}<input type="number" min={0} max={90} value={form.followUpDays} onChange={event => set('followUpDays', event.target.value)} /><small>{t('投递或状态变化后多少天提醒你跟进；0 为关闭。', 'Days after applying or a status change before Dayjob reminds you; 0 turns it off.')}</small></label>
          <label>{t('无回音提示（天）', 'No-reply flag (days)')}<input type="number" min={0} max={180} value={form.ghostDays} onChange={event => set('ghostDays', event.target.value)} /><small>{t('“已投递”状态超过这么多天没有变化时提示。', 'Flag an application still at “Applied” after this many days.')}</small></label>
          <label className="check-line"><input type="checkbox" checked={form.checkClosed} onChange={event => set('checkClosed', event.target.checked)} />{t('每天检查已投递和已收藏的岗位是否关闭', 'Check daily whether applied and saved jobs have closed')}</label>
        </div>
        <h2>{t('通知', 'Notifications')}</h2>
        <div className="form-grid">
          <label className="check-line"><input type="checkbox" checked={form.desktop} onChange={event => set('desktop', event.target.checked)} />{t('Windows 桌面通知', 'Windows desktop notifications')}</label>
          <label>{t('高匹配分数线', 'Strong-match score')}<input type="number" min={0} max={100} value={form.minScore} onChange={event => set('minScore', event.target.value)} /><small>{t('每日汇总里单独列出高于这个分数的新岗位。', 'The daily summary lists new jobs scoring at least this.')}</small></label>
        </div>
        <h2>{t('JobSpy（可选）', 'JobSpy (optional)')}</h2>
        <p className="hint">{t('Glassdoor、ZipRecruiter、Google Jobs 需要 Python 版 JobSpy：安装 Python 后运行 ', 'Glassdoor, ZipRecruiter and Google Jobs need the Python JobSpy: install Python, then run ')}<code>pip install python-jobspy</code>
          {t('。LinkedIn、Indeed 和公司招聘页不需要。', '. LinkedIn, Indeed and company boards do not need it.')}</p>
        <div className="form-grid">
          <label>{t('Python 命令', 'Python command')}<input value={form.pythonCommand} onChange={event => set('pythonCommand', event.target.value)} maxLength={1024} placeholder="python" /></label>
        </div>
        <p className={`status-line ${jobspy?.available ? 'ok' : 'off'}`}>{jobspy?.available ? <CheckCircle2 size={15} /> : null}{jobspy?.available ? jobspy.detail : t('未检测到 JobSpy。装好后点“保存设置”会重新检测。', 'JobSpy was not found. Install it, then click “Save settings” to check again.')}</p>
        {error ? <p className="notice error">{error}</p> : null}
        {message ? <p className="notice">{message}</p> : null}
        <div className="form-actions"><button className="button primary" type="submit">{t('保存设置', 'Save settings')}</button></div>
      </form>
      <ClaudeConnection />
      <section className="card-section">
        <h2>{t('语言、外观与数据', 'Language, look and data')}</h2>
        <div className="option-row">
          <span>{t('界面语言', 'Language')}</span>
          <LanguageSwitch />
          <small>{t('通知和托盘菜单也会跟着切换。AI 分析的语言在“简历与 AI”里设置。', 'Notifications and the tray menu follow it. Set the AI analysis language under Resume & AI.')}</small>
        </div>
        <div className="option-row">
          <span>{t('外观', 'Appearance')}</span>
          <div className="segmented">
            {[['system', '跟随系统', 'System'], ['light', '浅色', 'Light'], ['dark', '深色', 'Dark']].map(([value, zh, en]) => (
              <button key={value} className={theme === value ? 'active' : ''} onClick={() => applyTheme(value)}>{t(zh, en)}</button>
            ))}
          </div>
        </div>
        <p className="hint">{t('数据库：', 'Database: ')}{boot.dataFile} · Dayjob {boot.version}</p>
        {desktop ? <button className="button" onClick={() => desktop.openDataFolder().catch(failure => setError(failure.message))}><FolderOpen size={15} />{t('打开数据文件夹', 'Open data folder')}</button> : null}
        {info?.portable ? <p className="hint">{t('便携版不会写入 Claude 配置；安装版才能稳定连接 MCP。', 'The portable version does not write Claude\'s config; install Dayjob for a lasting MCP connection.')}</p> : null}
      </section>
    </section>
  );
}
