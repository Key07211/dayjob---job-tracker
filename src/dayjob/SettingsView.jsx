import { useEffect, useState } from 'react';
import { CheckCircle2, FolderOpen, Link2, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from '../api.js';

const desktop = typeof window !== 'undefined' ? window.dayjobDesktop : undefined;
const CLAUDE_STATES = { ready: '已连接', missing: '未连接', conflict: '已有同名连接（未改动）', error: '连接异常', unavailable: '没有找到 Claude Code 或 Claude Desktop' };

function ClaudeConnection() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { desktop?.getClaudeStatus().then(setStatus).catch(() => {}); }, []);
  if (!desktop) {
    return (
      <section className="card-section">
        <h2><Link2 size={18} />连接 Claude（MCP）</h2>
        <p className="hint">在桌面版里可以一键连接。源码运行时，在 Claude Code 中执行：</p>
        <pre className="code">claude mcp add dayjob -s user -e DAYJOB_URL=http://127.0.0.1:4318 -- node &lt;Dayjob 文件夹&gt;/integrations/mcp-server.mjs</pre>
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
      <h2><Link2 size={18} />连接 Claude（MCP）</h2>
      <p className="hint">连接后，在 Claude Code 或 Claude Desktop 里可以说“看看今天高匹配的岗位”“对照我的简历分析这个岗位”“根据 Gmail 更新我的投递状态”。Claude 需要 Dayjob 保持运行。</p>
      <p className={`status-line ${status?.state === 'ready' ? 'ok' : 'off'}`}>
        {status?.state === 'ready' ? <CheckCircle2 size={15} /> : null}
        {status ? CLAUDE_STATES[status.state] || status.state : '检查中…'}
        {status?.clients?.filter(client => client.state !== 'unavailable').map(client => <span key={client.id} className="muted"> · {client.label}</span>)}
      </p>
      {status?.message && status.state !== 'ready' ? <p className="hint">{status.message}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions">
        <button className="button" onClick={() => run(() => desktop.checkClaude())} disabled={busy}><RefreshCw size={15} />重新检查</button>
        {status?.state !== 'ready' ? <button className="button primary" onClick={() => run(() => desktop.connectClaude())} disabled={busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Link2 size={15} />}连接到 Claude</button> : null}
      </div>
      <p className="hint">会写入 Claude Code 的 ~/.claude.json 和 Claude Desktop 的配置文件（改之前自动备份）。Claude Desktop 需要重启后才会看到新工具。</p>
    </section>
  );
}

export function SettingsView({ boot, reload }) {
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
      setMessage('已保存。');
    } catch (failure) { setError(failure.message); }
  }
  const jobspy = sites.find(site => site.engine === 'jobspy');

  return (
    <section className="settings-page">
      <header className="view-header"><div><h1>设置</h1><p>所有数据保存在本机的 SQLite 数据库里。</p></div></header>
      <form className="card-section" onSubmit={save}>
        <h2>每日抓取</h2>
        <div className="form-grid">
          <label className="check-line"><input type="checkbox" checked={form.scheduleEnabled} onChange={event => set('scheduleEnabled', event.target.checked)} />每天自动抓取</label>
          <label>时间<input type="time" value={form.time} onChange={event => set('time', event.target.value)} required /><small>电脑关机错过时，下次打开 Dayjob 会补上当天的抓取。</small></label>
          <label>岗位保留天数<input type="number" min={7} max={365} value={form.retentionDays} onChange={event => set('retentionDays', event.target.value)} /><small>未收藏、未投递的旧岗位到期清理。</small></label>
        </div>
        <h2>投递追踪</h2>
        <div className="form-grid">
          <label>跟进提醒（天）<input type="number" min={0} max={90} value={form.followUpDays} onChange={event => set('followUpDays', event.target.value)} /><small>投递或状态变化后多少天提醒你跟进；0 为关闭。</small></label>
          <label>无回音提示（天）<input type="number" min={0} max={180} value={form.ghostDays} onChange={event => set('ghostDays', event.target.value)} /><small>“已投递”状态超过这么多天没有变化时提示。</small></label>
          <label className="check-line"><input type="checkbox" checked={form.checkClosed} onChange={event => set('checkClosed', event.target.checked)} />每天检查已投递和已收藏的岗位是否关闭</label>
        </div>
        <h2>通知</h2>
        <div className="form-grid">
          <label className="check-line"><input type="checkbox" checked={form.desktop} onChange={event => set('desktop', event.target.checked)} />Windows 桌面通知</label>
          <label>高匹配分数线<input type="number" min={0} max={100} value={form.minScore} onChange={event => set('minScore', event.target.value)} /><small>每日汇总里单独列出高于这个分数的新岗位。</small></label>
        </div>
        <h2>JobSpy（可选）</h2>
        <p className="hint">Glassdoor、ZipRecruiter、Google Jobs 需要 Python 版 JobSpy：安装 Python 后运行 <code>pip install python-jobspy</code>。LinkedIn、Indeed 和公司招聘页不需要。</p>
        <div className="form-grid">
          <label>Python 命令<input value={form.pythonCommand} onChange={event => set('pythonCommand', event.target.value)} maxLength={1024} placeholder="python" /></label>
        </div>
        <p className={`status-line ${jobspy?.available ? 'ok' : 'off'}`}>{jobspy?.available ? <CheckCircle2 size={15} /> : null}{jobspy?.available ? jobspy.detail : '未检测到 JobSpy。装好后点“保存设置”会重新检测。'}</p>
        {error ? <p className="notice error">{error}</p> : null}
        {message ? <p className="notice">{message}</p> : null}
        <div className="form-actions"><button className="button primary" type="submit">保存设置</button></div>
      </form>
      <ClaudeConnection />
      <section className="card-section">
        <h2>外观与数据</h2>
        <div className="segmented">
          {[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([value, label]) => (
            <button key={value} className={theme === value ? 'active' : ''} onClick={() => applyTheme(value)}>{label}</button>
          ))}
        </div>
        <p className="hint">数据库：{boot.dataFile} · Dayjob {boot.version}</p>
        {desktop ? <button className="button" onClick={() => desktop.openDataFolder().catch(failure => setError(failure.message))}><FolderOpen size={15} />打开数据文件夹</button> : null}
        {info?.portable ? <p className="hint">便携版不会写入 Claude 配置；安装版才能稳定连接 MCP。</p> : null}
      </section>
    </section>
  );
}
