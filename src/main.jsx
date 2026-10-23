import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bell, Bookmark, BriefcaseBusiness, FileUser, Globe, Inbox, LayoutDashboard, LoaderCircle, Pause, Play, Search, Settings } from 'lucide-react';
import { api, setToken } from './api.js';
import { I18nProvider, LanguageSwitch, tr, useI18n } from './i18n.jsx';
import { formatDay } from './dayjob/format.js';
import { HomeView } from './dayjob/HomeView.jsx';
import { FeedView } from './dayjob/FeedView.jsx';
import { ApplicationsView } from './dayjob/ApplicationsView.jsx';
import { SearchesView } from './dayjob/SearchesView.jsx';
import { ResumeView } from './dayjob/ResumeView.jsx';
import { SettingsView } from './dayjob/SettingsView.jsx';
import { NotificationsPanel } from './dayjob/NotificationsPanel.jsx';
import { BrowserView, hasBrowser, useBrowserState } from './dayjob/BrowserView.jsx';
import { UpdateItem, useUpdateState } from './dayjob/UpdateButton.jsx';
import './dayjob/dayjob.css';

const VIEWS = [
  { id: 'home', label: ['主页', 'Home'], icon: LayoutDashboard },
  { id: 'feed', label: ['今日岗位', 'Today'], icon: Inbox },
  { id: 'saved', label: ['已收藏', 'Saved'], icon: Bookmark },
  { id: 'applications', label: ['投递追踪', 'Applications'], icon: BriefcaseBusiness },
  ...(hasBrowser ? [{ id: 'browser', label: ['浏览器', 'Browser'], icon: Globe }] : []),
  { id: 'searches', label: ['搜索与公司', 'Searches'], icon: Search },
  { id: 'resume', label: ['简历与 AI', 'Resume & AI'], icon: FileUser },
  { id: 'settings', label: ['设置', 'Settings'], icon: Settings },
];
// The browser opens beside the current view; below this window width it fills the window.
const SIDE_MIN_WINDOW = 1000;
const SIDEBAR = 216;
const PANE_MIN = 420;
const VIEW_MIN = 360;
const paneLimits = windowWidth => [PANE_MIN, Math.max(PANE_MIN, windowWidth - SIDEBAR - VIEW_MIN)];
const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
const keep = (storage, key, value) => { try { storage.setItem(key, value); } catch { /* optional */ } };
const PHASES = { search: ['正在抓取岗位…', 'Fetching jobs…'], score: ['AI 正在打分…', 'AI is scoring…'], track: ['正在更新投递状态…', 'Updating applications…'] };

function nextRunText(value) {
  if (!value) return tr('每日抓取已关闭', 'Daily search is off');
  const date = new Date(value);
  if (date - Date.now() < 90 * 1000) return tr('马上开始每日抓取', 'Daily search starts shortly');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.toDateString() === new Date().toDateString() ? tr('今天', 'today') : date.toDateString() === tomorrow.toDateString() ? tr('明天', 'tomorrow') : formatDay(value);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return tr(`下次抓取：${day} ${time}`, `Next search: ${day} ${time}`);
}

// The language is also a server setting, so notifications and the tray follow it.
const saveLanguage = language => { api('/api/settings', { method: 'PATCH', body: { language } }).catch(() => {}); };

function App() {
  const { t, setLang } = useI18n();
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState(() => {
    const saved = read(sessionStorage, 'dayjob-view');
    return saved !== 'browser' && VIEWS.some(item => item.id === saved) ? saved : 'home';
  });
  const [browserOpen, setBrowserOpen] = useState(() => hasBrowser && (read(sessionStorage, 'dayjob-browser') === 'open' || read(sessionStorage, 'dayjob-view') === 'browser'));
  const [browserWide, setBrowserWide] = useState(false);
  const [paneWidth, setPaneWidth] = useState(() => Number(read(localStorage, 'dayjob-browser-width')) || null);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  // A job or application picked on Home or in the browser, for its view to
  // open with; any other way of changing views clears it. "browser" opens the
  // browser beside the current view.
  const [focus, setFocus] = useState(null);
  const goTo = useCallback(target => {
    if (target === 'browser') { setBrowserOpen(true); return; }
    setFocus(null);
    setView(target);
    setBrowserWide(false);
  }, []);
  const [status, setStatus] = useState(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [runMessage, setRunMessage] = useState('');
  const [dataVersion, setDataVersion] = useState(0);
  const wasRunning = useRef(false);
  const wasSearching = useRef(false);
  const adopted = useRef(false);
  const browser = useBrowserState(goTo);
  const update = useUpdateState();

  const reload = useCallback(async () => {
    try {
      const value = await api('/api/bootstrap');
      setToken(value.csrfToken);
      if (!adopted.current && value.settings.language) setLang(value.settings.language, { adopt: true });
      adopted.current = true;
      setBoot(value);
      setStatus({ stats: value.stats, scheduler: value.scheduler, scoring: value.scoring, runs: value.runs });
      setError('');
      return value;
    } catch (failure) { setError(failure.message); return null; }
  }, [setLang]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { keep(sessionStorage, 'dayjob-view', view); }, [view]);
  useEffect(() => { keep(sessionStorage, 'dayjob-browser', browserOpen ? 'open' : 'closed'); }, [browserOpen]);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

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
      // Only a search has a result to report; a scoring batch just refreshes the list.
      const run = wasSearching.current ? status?.runs?.[0] : null;
      if (run) setRunMessage(run.status === 'failed' ? tr('这次抓取没有成功，详情见“搜索与公司”。', 'This search did not succeed. See Searches for details.')
        : tr(`抓取完成：${run.found} 个岗位，其中 ${run.newCount} 个是新的。`, `Done: ${run.found} jobs, ${run.newCount} new.`));
    }
    wasRunning.current = busy;
    wasSearching.current = Boolean(status?.scheduler?.running);
  }, [busy, status]);

  // Pausing stops the job being scored right away; resuming scores what was left.
  async function setScoringPaused(pause) {
    setRunMessage('');
    try {
      await api(`/api/scoring/${pause ? 'pause' : 'resume'}`, { method: 'POST', body: {} });
      setStatus(await api('/api/status'));
      if (!pause) setDataVersion(version => version + 1);
    } catch (failure) { setRunMessage(failure.message); }
  }

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
        {error ? <><p>{error}</p><button className="button primary" onClick={reload}>{t('重试', 'Retry')}</button></> : <LoaderCircle className="spin" />}
      </div>
    );
  }

  const stats = status?.stats || boot.stats;
  const scheduler = status?.scheduler || boot.scheduler;
  const scoring = status?.scoring || boot.scoring;
  const scoringNow = !scoring.paused && (scheduler.running ? scheduler.phase === 'score' : scheduler.scoringBatch);
  const progress = scoringNow && scoring.progress?.total ? ` ${Math.min(scoring.progress.done + 1, scoring.progress.total)}/${scoring.progress.total}` : '';
  const openApplications = ['applied', 'oa', 'interview', 'offer'].reduce((sum, key) => sum + (stats.applications[key] || 0), 0);
  const badges = { feed: stats.newPostings, saved: stats.savedPostings, applications: openApplications, browser: browser?.approval ? '!' : null };
  const shared = { boot, reload, setView: goTo, dataVersion, refreshStatus: async () => setStatus(await api('/api/status')) };
  const openItem = (target, id) => { setFocus({ view: target, id }); setView(target); setBrowserWide(false); };
  const focusFor = target => (focus?.view === target ? focus.id : null);
  const canSide = windowWidth >= SIDE_MIN_WINDOW;
  const wide = browserOpen && (browserWide || !canSide);
  const [minPane, maxPane] = paneLimits(windowWidth);
  const width = Math.min(maxPane, Math.max(minPane, paneWidth || Math.round((windowWidth - SIDEBAR) * 0.58)));
  // Dragging the divider: the page (a native view) is hidden meanwhile so it
  // does not swallow the pointer.
  function startResize(event) {
    event.preventDefault();
    setResizing(true);
    let last = width;
    const move = moved => {
      const [low, high] = paneLimits(window.innerWidth);
      last = Math.min(high, Math.max(low, window.innerWidth - moved.clientX));
      setPaneWidth(last);
    };
    const stop = () => {
      setResizing(false);
      keep(localStorage, 'dayjob-browser-width', String(last));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }
  function nudge(event) {
    const step = { ArrowLeft: 40, ArrowRight: -40 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = Math.min(maxPane, Math.max(minPane, width + step));
    setPaneWidth(next);
    keep(localStorage, 'dayjob-browser-width', String(next));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <div><strong>Dayjob</strong><span>{t('求职追踪', 'Job tracker')}</span></div>
          <LanguageSwitch compact />
        </div>
        <nav>
          {VIEWS.map(item => (
            <button key={item.id} className={`nav-item${(item.id === 'browser' ? browserOpen : view === item.id && !wide) ? ' active' : ''}`}
              onClick={() => (item.id === 'browser' ? setBrowserOpen(open => !open) : goTo(item.id))}>
              <item.icon size={18} />
              <span>{t(...item.label)}</span>
              {badges[item.id] ? <em className={item.id === 'browser' ? 'alert' : undefined}>{badges[item.id] > 999 ? '999+' : badges[item.id]}</em> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <UpdateItem state={update} />
          <button className={`nav-item${showNotifications ? ' active' : ''}`} onClick={() => setShowNotifications(value => !value)}>
            <Bell size={18} /><span>{t('通知', 'Notifications')}</span>{stats.unreadNotifications ? <em>{stats.unreadNotifications}</em> : null}
          </button>
          <div className="run-card">
            {scoringNow ? <p className="run-phase"><LoaderCircle size={15} className="spin" />{t('AI 正在打分', 'AI is scoring')}{progress}</p>
              : scheduler.running ? <p className="run-phase"><LoaderCircle size={15} className="spin" />{t(...(PHASES[scheduler.phase] || PHASES.score))}</p>
                : <p>{nextRunText(scheduler.nextRunAt)}</p>}
            {scoring.paused ? <p className="run-paused"><Pause size={14} />{scoring.held ? t(`AI 打分已暂停，${scoring.held} 个岗位等着打分`, `AI scoring is paused; ${scoring.held} ${scoring.held === 1 ? 'job is' : 'jobs are'} waiting`) : t('AI 打分已暂停', 'AI scoring is paused')}</p> : null}
            {runMessage ? <p className="run-message">{runMessage}</p> : null}
            {scoringNow ? <button className="button block" onClick={() => setScoringPaused(true)}><Pause size={15} />{t('暂停打分', 'Pause scoring')}</button>
              : scoring.paused ? <button className="button block" onClick={() => setScoringPaused(false)}><Play size={15} />{t('继续打分', 'Resume scoring')}</button> : null}
            <button className="button primary block" onClick={runNow} disabled={scheduler.running}>
              <Play size={15} />{scheduler.running ? t('抓取中', 'Searching') : t('立即抓取', 'Search now')}
            </button>
          </div>
        </div>
      </aside>
      {showNotifications ? <NotificationsPanel onClose={() => setShowNotifications(false)} onChanged={shared.refreshStatus} setView={goTo} /> : null}
      <main className={`main${browserOpen ? ` with-browser${wide ? ' wide' : ''}` : ''}`}>
        <div className="main-view">
          {view === 'home' ? <HomeView {...shared} openItem={openItem} /> : null}
          {view === 'feed' ? <FeedView key={`feed-${focusFor('feed')}`} mode="active" focus={focusFor('feed')} {...shared} /> : null}
          {view === 'saved' ? <FeedView key={`saved-${focusFor('saved')}`} mode="saved" focus={focusFor('saved')} {...shared} /> : null}
          {view === 'applications' ? <ApplicationsView key={`applications-${focusFor('applications')}`} focus={focusFor('applications')} {...shared} /> : null}
          {view === 'searches' ? <SearchesView {...shared} status={status} /> : null}
          {view === 'resume' ? <ResumeView key={`resume-${focusFor('resume')}`} focus={focusFor('resume')} {...shared} status={status} /> : null}
          {view === 'settings' ? <SettingsView {...shared} update={update} /> : null}
        </div>
        {browserOpen ? (
          <>
            {!wide ? <div className="pane-resizer" role="separator" aria-orientation="vertical" aria-label={t('拖动调整浏览器宽度', 'Drag to resize the browser')} tabIndex={0}
              onPointerDown={startResize} onKeyDown={nudge} onDoubleClick={() => { setPaneWidth(null); keep(localStorage, 'dayjob-browser-width', ''); }} /> : null}
            <div className="browser-pane" style={wide ? undefined : { width }}>
              <BrowserView state={browser} covered={showNotifications || resizing} boot={boot} dataVersion={dataVersion} openItem={openItem}
                wide={wide} canSide={canSide} onWide={setBrowserWide} onClose={() => setBrowserOpen(false)} />
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><I18nProvider onChange={saveLanguage}><App /></I18nProvider></StrictMode>);
