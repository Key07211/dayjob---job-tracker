import { useEffect, useState } from 'react';
import { CheckCircle2, Download, FolderOpen, Globe, Link2, LoaderCircle, Power, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { LanguageSwitch, useI18n } from '../i18n.jsx';
import { serverText } from './server-text.js';
import { applyMotion, MOTION_KEY } from './motion.js';

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

function BrowserData() {
  const { t } = useI18n();
  const [state, setState] = useState('');
  if (!desktop?.browser) return null;
  async function clear() {
    if (!window.confirm(t('清除 Dayjob 浏览器里所有网站的登录状态、Cookie 和缓存？打开的标签页会关闭。', 'Clear every sign-in, cookie and cache in the Dayjob browser? Open tabs are closed.'))) return;
    setState('busy');
    try { await desktop.browser.clearData(); setState('done'); } catch { setState('error'); }
  }
  return (
    <section className="card-section">
      <h2><Globe size={18} />{t('Dayjob 浏览器', 'Dayjob browser')}</h2>
      <p className="hint">{t('浏览器里的登录状态和 Cookie 只保存在这台电脑的 Dayjob 数据里，和 Chrome、Edge 分开。连接 Claude 后，Claude 能在里面打开和阅读网页、填写表单；提交或发送之前会先请你在 Dayjob 里确认，密码和文件上传不会交给 Claude。浏览器工具栏里可以随时关掉“允许 Claude 使用”。',
        'Sign-ins and cookies in the browser stay in Dayjob\'s data on this computer, separate from Chrome and Edge. With Claude connected, Claude can open and read pages there and fill in forms; before anything is submitted or sent it asks you in Dayjob, and it never gets passwords or file uploads. Turn off “Let Claude use it” in the browser toolbar at any time.')}</p>
      <div className="form-actions">
        <button className="button" onClick={clear} disabled={state === 'busy'}><Trash2 size={15} />{t('清除登录状态和缓存', 'Clear sign-ins and cache')}</button>
      </div>
      {state === 'done' ? <p className="notice">{t('已清除。', 'Cleared.')}</p> : null}
      {state === 'error' ? <p className="notice error">{t('没能清除，请重试。', 'Could not clear it. Try again.')}</p> : null}
    </section>
  );
}

function Background({ boot, reload }) {
  const { t } = useI18n();
  const [error, setError] = useState('');
  if (!desktop) return null;
  async function toggle(event) {
    setError('');
    try { await api('/api/settings', { method: 'PATCH', body: { desktop: { closeToTray: event.target.checked } } }); await reload(); }
    catch (failure) { setError(serverText(failure.message)); }
  }
  return (
    <section className="card-section">
      <h2><Power size={18} />{t('关闭窗口时', 'Closing the window')}</h2>
      <p className="hint">{t('开着这一项，关掉窗口后 Dayjob 留在任务栏右下角的托盘里，按时做每日抓取、发提醒，Claude 也能随时通过 MCP 使用它；要完全退出，在托盘图标的菜单里点“退出 Dayjob”。关掉这一项，关窗口就完全退出，不在后台运行；错过的每日抓取会在当天下次打开 Dayjob 时补上。',
        'With this on, closing the window leaves Dayjob in the tray at the bottom right of the taskbar, so the daily search and reminders still run and Claude can use it through MCP at any time; to quit completely, choose “Quit Dayjob” from the tray icon\'s menu. With it off, closing the window quits Dayjob and nothing keeps running; a daily search it missed runs when you next open Dayjob that day.')}</p>
      <div className="form-grid">
        <label className="check-line"><input type="checkbox" checked={boot.settings.desktop.closeToTray} onChange={toggle} />{t('关闭窗口后继续在后台运行', 'Keep running in the tray')}</label>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </section>
  );
}

const UPDATE_STATES = { idle: ['还没有检查', 'Not checked yet'], checking: ['正在检查…', 'Checking…'], latest: ['已是最新版本', 'Dayjob is up to date'],
  error: ['检查失败', 'The check failed'], downloading: ['正在下载新版本…', 'Downloading the new version…'], downloaded: ['新版本已下载，重启即可更新', 'Downloaded; restart to update'],
  unsupported: ['开发版不检查更新', 'Development builds do not check for updates'] };

function Updates({ boot, reload, update }) {
  const { t } = useI18n();
  const [error, setError] = useState('');
  if (!desktop?.updates || !update) return null;
  async function toggle(event) {
    setError('');
    try { await api('/api/settings', { method: 'PATCH', body: { updates: { autoCheck: event.target.checked } } }); await reload(); }
    catch (failure) { setError(serverText(failure.message)); }
  }
  const text = update.status === 'available' ? t(`有新版本 v${update.latest}`, `Version ${update.latest} is available`) : t(...(UPDATE_STATES[update.status] || [update.status, update.status]));
  return (
    <section className="card-section">
      <h2><Download size={18} />{t('更新', 'Updates')}</h2>
      <p className="hint">{t('从 GitHub Releases 检查新版本。有新版本时，左侧栏的“检查更新”会变成圆形下载按钮；下载完点“重启并更新”，数据会保留。',
        'Dayjob looks for new versions on GitHub Releases. When one is out, “Check for updates” in the sidebar turns into a round download button; once downloaded, click “Restart to update”. Your data stays.')}</p>
      <p className={`status-line ${update.status === 'error' ? 'off' : 'ok'}`}>
        {update.status === 'latest' ? <CheckCircle2 size={15} /> : null}{t(`当前 v${update.version} · `, `Current v${update.version} · `)}{text}
        {update.checkedAt ? <span className="muted">{t(` · 上次检查 ${new Date(update.checkedAt).toLocaleString('zh-CN')}`, ` · last checked ${new Date(update.checkedAt).toLocaleString('en-US')}`)}</span> : null}
      </p>
      {update.error ? <p className="notice error">{update.error}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-grid">
        <label className="check-line"><input type="checkbox" checked={boot.settings.updates.autoCheck} onChange={toggle} />{t('每天自动检查一次', 'Check once a day')}</label>
      </div>
      {update.portable ? <p className="hint">{t('免安装版不能自己替换，下载按钮会在浏览器里下载新的免安装版。', 'The portable app cannot replace itself; its download button gets the new portable app in your browser.')}</p> : null}
      <div className="form-actions">
        <button className="button" onClick={() => desktop.updates.check()} disabled={['checking', 'downloading', 'downloaded', 'unsupported'].includes(update.status)}>
          {update.status === 'checking' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{t('立即检查', 'Check now')}
        </button>
      </div>
    </section>
  );
}

export function SettingsView({ boot, reload, update }) {
  const { t } = useI18n();
  const settings = boot.settings;
  const [form, setForm] = useState({ scheduleEnabled: settings.schedule.enabled, time: settings.schedule.time,
    followUpDays: settings.tracking.followUpDays, ghostDays: settings.tracking.ghostDays, checkClosed: settings.tracking.checkClosed,
    desktop: settings.notifications.desktop, minScore: settings.notifications.minScore, pythonCommand: settings.jobspy.pythonCommand,
    retentionDays: settings.retentionDays });
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('dayjob-theme') || 'system'; } catch { return 'system'; } });
  const [motionChoice, setMotionChoice] = useState(() => { try { return localStorage.getItem(MOTION_KEY) || 'system'; } catch { return 'system'; } });
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
  function chooseMotion(value) {
    setMotionChoice(value);
    try { localStorage.setItem(MOTION_KEY, value); } catch { /* optional */ }
    applyMotion(value);
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
      <BrowserData />
      <Background boot={boot} reload={reload} />
      <Updates boot={boot} reload={reload} update={update} />
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
        <div className="option-row">
          <span>{t('动效', 'Motion')}</span>
          <div className="segmented">
            {[['system', '跟随系统', 'System'], ['full', '开启', 'On'], ['reduce', '减少', 'Reduced']].map(([value, zh, en]) => (
              <button key={value} className={motionChoice === value ? 'active' : ''} onClick={() => chooseMotion(value)}>{t(zh, en)}</button>
            ))}
          </div>
          <small>{t('“减少”会关掉页面切换、列表和打分的动画。跟随系统时，Windows 设置 › 辅助功能 › 视觉效果 › 动画效果 关闭后，Dayjob 也会减少动效。',
            '“Reduced” turns off the page, list and scoring animations. On System, Dayjob reduces motion when Windows Settings › Accessibility › Visual effects › Animation effects is off.')}</small>
        </div>
        <p className="hint">{t('数据库：', 'Database: ')}{boot.dataFile} · Dayjob {boot.version}</p>
        {desktop ? <button className="button" onClick={() => desktop.openDataFolder().catch(failure => setError(failure.message))}><FolderOpen size={15} />{t('打开数据文件夹', 'Open data folder')}</button> : null}
        {info?.portable ? <p className="hint">{t('便携版不会写入 Claude 配置；安装版才能稳定连接 MCP。', 'The portable version does not write Claude\'s config; install Dayjob for a lasting MCP connection.')}</p> : null}
      </section>
    </section>
  );
}
