import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bell, Bookmark, BriefcaseBusiness, FileUser, Inbox, LoaderCircle, Play, Search, Settings } from 'lucide-react';
import { api, setToken } from './api.js';
import { formatDay } from './dayjob/format.js';
import { FeedView } from './dayjob/FeedView.jsx';
import { ApplicationsView } from './dayjob/ApplicationsView.jsx';
import { SearchesView } from './dayjob/SearchesView.jsx';
import { ResumeView } from './dayjob/ResumeView.jsx';
import { SettingsView } from './dayjob/SettingsView.jsx';
import { NotificationsPanel } from './dayjob/NotificationsPanel.jsx';
import './dayjob/dayjob.css';

const VIEWS = [
  { id: 'feed', label: '今日岗位', icon: Inbox },
  { id: 'saved', label: '已收藏', icon: Bookmark },
  { id: 'applications', label: '投递追踪', icon: BriefcaseBusiness },
  { id: 'searches', label: '搜索与公司', icon: Search },
  { id: 'resume', label: '简历与 AI', icon: FileUser },
  { id: 'settings', label: '设置', icon: Settings },
];
const PHASES = { search: '正在抓取岗位…', score: 'AI 正在打分…', track: '正在更新投递状态…' };

function nextRunText(value) {
  if (!value) return '每日抓取已关闭';
  const date = new Date(value);
  if (date - Date.now() < 90 * 1000) return '马上开始每日抓取';
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.toDateString() === new Date().toDateString() ? '今天' : date.toDateString() === tomorrow.toDateString() ? '明天' : formatDay(value);
  return `下次抓取：${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function App() {
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState(() => { try { return sessionStorage.getItem('dayjob-view') || 'feed'; } catch { return 'feed'; } });
  const [status, setStatus] = useState(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [runMessage, setRunMessage] = useState('');
  const [dataVersion, setDataVersion] = useState(0);
  const wasRunning = useRef(false);

  const reload = useCallback(async () => {
    try {
      const value = await api('/api/bootstrap');
      setToken(value.csrfToken);
      setBoot(value);
      setStatus({ stats: value.stats, scheduler: value.scheduler, scoring: value.scoring, runs: value.runs });
      setError('');
      return value;
    } catch (failure) { setError(failure.message); return null; }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { try { sessionStorage.setItem('dayjob-view', view); } catch { /* optional */ } }, [view]);

  // Poll quickly while a run is in progress, slowly otherwise.
  const busy = Boolean(status?.scheduler?.running || status?.scheduler?.scoringBatch);
  useEffect(() => {
    if (!boot) return undefined;
    const timer = setInterval(async () => {
      try { setStatus(await api('/api/status')); } catch { /* the next poll retries */ }
    }, busy ? 3000 : 30000);
    return () => clearInterval(timer);
  }, [boot, busy]);
  useEffect(() => {
    if (wasRunning.current && !busy) {
      setDataVersion(version => version + 1);
      const run = status?.runs?.[0];
      if (run) setRunMessage(run.status === 'failed' ? '这次抓取没有成功，详情见“搜索与公司”。' : `抓取完成：${run.found} 个岗位，其中 ${run.newCount} 个是新的。`);
    }
    wasRunning.current = busy;
  }, [busy, status]);

  async function runNow() {
    setRunMessage('');
    try {
      await api('/api/runs', { method: 'POST', body: {} });
      setStatus(await api('/api/status'));
    } catch (failure) { setRunMessage(failure.message); }
  }

  if (!boot) {
    return (
      <div className="boot-screen">
        {error ? <><p>{error}</p><button className="button primary" onClick={reload}>重试</button></> : <LoaderCircle className="spin" />}
      </div>
    );
  }

  const stats = status?.stats || boot.stats;
  const scheduler = status?.scheduler || boot.scheduler;
  const openApplications = ['applied', 'oa', 'interview', 'offer'].reduce((sum, key) => sum + (stats.applications[key] || 0), 0);
  const badges = { feed: stats.newPostings, saved: stats.savedPostings, applications: openApplications };
  const shared = { boot, reload, setView, dataVersion, refreshStatus: async () => setStatus(await api('/api/status')) };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <div><strong>Dayjob</strong><span>求职追踪</span></div>
        </div>
        <nav>
          {VIEWS.map(item => (
            <button key={item.id} className={`nav-item${view === item.id ? ' active' : ''}`} onClick={() => setView(item.id)}>
              <item.icon size={18} />
              <span>{item.label}</span>
              {badges[item.id] ? <em>{badges[item.id] > 999 ? '999+' : badges[item.id]}</em> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className={`nav-item${showNotifications ? ' active' : ''}`} onClick={() => setShowNotifications(value => !value)}>
            <Bell size={18} /><span>通知</span>{stats.unreadNotifications ? <em>{stats.unreadNotifications}</em> : null}
          </button>
          <div className="run-card">
            {scheduler.running || scheduler.scoringBatch
              ? <p className="run-phase"><LoaderCircle size={15} className="spin" />{PHASES[scheduler.phase] || 'AI 正在打分…'}</p>
              : <p>{nextRunText(scheduler.nextRunAt)}</p>}
            {runMessage ? <p className="run-message">{runMessage}</p> : null}
            <button className="button primary block" onClick={runNow} disabled={scheduler.running}>
              <Play size={15} />{scheduler.running ? '抓取中' : '立即抓取'}
            </button>
          </div>
        </div>
      </aside>
      {showNotifications ? <NotificationsPanel onClose={() => setShowNotifications(false)} onChanged={shared.refreshStatus} setView={setView} /> : null}
      <main className="main">
        {view === 'feed' ? <FeedView key="feed" mode="active" {...shared} /> : null}
        {view === 'saved' ? <FeedView key="saved" mode="saved" {...shared} /> : null}
        {view === 'applications' ? <ApplicationsView {...shared} /> : null}
        {view === 'searches' ? <SearchesView {...shared} status={status} /> : null}
        {view === 'resume' ? <ResumeView {...shared} status={status} /> : null}
        {view === 'settings' ? <SettingsView {...shared} /> : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
