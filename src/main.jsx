import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bell, Bookmark, BriefcaseBusiness, FileUser, Globe, Inbox, LayoutDashboard, Pause, Play, Search, Settings, Volume2, VolumeX } from 'lucide-react';
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
import { PianoNav } from './dayjob/groove/PianoNav.jsx';
import { BrandNote, NoteLoader, Wordmark } from './dayjob/groove/BrandNote.jsx';
import { Turntable } from './dayjob/groove/Turntable.jsx';
import { WeekBars } from './dayjob/groove/WeekBars.jsx';
import { Metronome } from './dayjob/groove/Metronome.jsx';
import { emit, useGroove } from './dayjob/groove/bus.js';
import { prefs, usePrefs, useTheme } from './dayjob/groove/prefs.js';
import { BEAT, cue, playApply, playBatchEnd, playHello, playNeedle, playScore } from './dayjob/groove/sound.js';
import { installClickFx, pop, rings, wiggle } from './dayjob/groove/fx.js';
import { appName, setFollow, useNowPlaying } from './dayjob/groove/music.js';
import { startThemeClock } from './dayjob/theme.js';
import '@fontsource-variable/nunito/wght.css';
import './dayjob/fonts/fonts.css';
import './dayjob/dayjob.css';
import './dayjob/groove/groove.css';
import './dayjob/groove/keys.css';
import './dayjob/groove/fx.css';

// note: which of the tune's eight phrases the page's key plays, the same with or without the browser.
const VIEWS = [
  { id: 'home', label: ['主页', 'Home'], icon: LayoutDashboard, note: 0 },
  { id: 'feed', label: ['今日岗位', 'Today'], icon: Inbox, note: 1 },
  { id: 'saved', label: ['已收藏', 'Saved'], icon: Bookmark, note: 2 },
  { id: 'applications', label: ['投递追踪', 'Applications'], icon: BriefcaseBusiness, note: 3 },
  ...(hasBrowser ? [{ id: 'browser', label: ['浏览器', 'Browser'], icon: Globe, note: 4 }] : []),
  { id: 'searches', label: ['搜索与公司', 'Searches'], icon: Search, note: 5 },
  { id: 'resume', label: ['简历与 AI', 'Resume & AI'], icon: FileUser, note: 6 },
  { id: 'settings', label: ['设置', 'Settings'], icon: Settings, note: 7 },
];
const WEEKDAYS = { zh: ['一', '二', '三', '四', '五', '六', '日'], en: ['M', 'T', 'W', 'T', 'F', 'S', 'S'] };
// The browser opens beside the current view; below this window width it fills the window.
const SIDE_MIN_WINDOW = 1000;
const SIDEBAR = 216;
const PANE_MIN = 420;
const VIEW_MIN = 360;
const paneLimits = windowWidth => [PANE_MIN, Math.max(PANE_MIN, windowWidth - SIDEBAR - VIEW_MIN)];
const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
const keep = (storage, key, value) => { try { storage.setItem(key, value); } catch { /* optional */ } };

function nextRunText(value) {
  if (!value) return tr('点唱片开始抓取', 'Click the record to search');
  const date = new Date(value);
  if (date - Date.now() < 90 * 1000) return tr('马上开始每日抓取', 'Daily search starts shortly');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.toDateString() === new Date().toDateString() ? tr('今天', 'today') : date.toDateString() === tomorrow.toDateString() ? tr('明天', 'tomorrow') : formatDay(value);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return tr(`下次 ${day} ${time}`, `Next ${day} ${time}`);
}

// The language is also a server setting, so notifications and the tray follow it.
const saveLanguage = language => { api('/api/settings', { method: 'PATCH', body: { language } }).catch(() => {}); };

function App() {
  const { t, lang, setLang } = useI18n();
  const groove = usePrefs();
  const theme = useTheme();
  const nowPlaying = useNowPlaying();
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
  // Scores that landed since the last poll play one per beat, so a batch sounds like a melody, not a chord.
  const feed = useRef({ seq: null, queue: [], timer: 0, batch: 0, busy: false });
  const [pending, setPending] = useState(0);
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

  const finishBatch = useCallback(() => {
    const f = feed.current;
    if (f.busy || f.queue.length || f.timer) return;
    // A whole batch scored: the cadence and the bell, once, when at least two scores landed.
    if (f.batch >= 2) { emit('batch-end', { scored: f.batch }); playBatchEnd(); }
    f.batch = 0;
  }, []);
  const drain = useCallback(() => {
    const f = feed.current;
    if (f.timer) return;
    const step = () => {
      const next = f.queue.shift();
      setPending(f.queue.length);
      if (!next) { f.timer = 0; finishBatch(); return; }
      f.batch += 1;
      emit('score', next);
      playScore(next.score);
      f.timer = setTimeout(step, BEAT);
    };
    step();
  }, [finishBatch]);
  useEffect(() => {
    const landed = status?.scoring?.landed;
    const f = feed.current;
    if (!f.busy && busy) f.batch = 0;
    f.busy = busy;
    if (landed) {
      const top = landed.reduce((max, item) => Math.max(max, item.seq), 0);
      // What landed before the window opened is not played again.
      if (f.seq === null) f.seq = top;
      const fresh = landed.filter(item => item.seq > f.seq).sort((a, b) => a.seq - b.seq);
      if (fresh.length) {
        f.seq = top;
        f.queue.push(...fresh);
        setPending(f.queue.length);
        drain();
      }
    }
    finishBatch();
  }, [status, busy, drain, finishBatch]);
  useEffect(() => () => { clearTimeout(feed.current.timer); feed.current.timer = 0; }, []);
  // An application anywhere: one strum, and the week bars catch up.
  useGroove('apply', () => {
    playApply();
    api('/api/status').then(setStatus).catch(() => {});
  });
  useEffect(() => installClickFx(), []);
  // A new notification rings the bell once.
  const bell = useRef(null);
  const unread = (status?.stats || boot?.stats)?.unreadNotifications || 0;
  const lastUnread = useRef(unread);
  useEffect(() => {
    if (unread > lastUnread.current) wiggle(bell.current, 18);
    lastUnread.current = unread;
  }, [unread]);
  // The clock in each header, and the theme turning by it.
  useEffect(() => startThemeClock(), []);
  // Following music was turned on before: start listening again (the sound itself waits for a first click).
  useEffect(() => { if (prefs.get().followMusic) setFollow(true); }, []);

  // Pausing stops the job being scored right away; resuming scores what was left.
  async function setScoringPaused(pause) {
    setRunMessage('');
    cue(pause ? 'pause' : 'resume');
    try {
      await api(`/api/scoring/${pause ? 'pause' : 'resume'}`, { method: 'POST', body: {} });
      setStatus(await api('/api/status'));
      if (!pause) setDataVersion(version => version + 1);
    } catch (failure) { setRunMessage(failure.message); }
  }

  async function runNow() {
    setRunMessage('');
    playNeedle();
    emit('fetch');
    try {
      await api('/api/runs', { method: 'POST', body: {} });
      setStatus(await api('/api/status'));
    } catch (failure) { setRunMessage(failure.message); }
  }

  if (!boot) {
    return (
      <div className="boot-screen">
        {error ? <><p>{error}</p><button className="button primary" onClick={reload}>{t('重试', 'Retry')}</button></> : <NoteLoader />}
      </div>
    );
  }

  const stats = status?.stats || boot.stats;
  const scheduler = status?.scheduler || boot.scheduler;
  const scoring = status?.scoring || boot.scoring;
  const scoringNow = !scoring.paused && (scheduler.running ? scheduler.phase === 'score' : scheduler.scoringBatch);
  const scoreShare = scoring.progress?.total ? Math.min(1, scoring.progress.done / scoring.progress.total) : 0;
  const searchShare = scheduler.searchProgress?.total ? Math.min(1, scheduler.searchProgress.done / scheduler.searchProgress.total) : 0;
  // The stylus tracks the whole run: most of it is the search, then scoring, then the application check.
  const deckProgress = scheduler.running ? (scheduler.phase === 'search' ? 0.7 * searchShare : scheduler.phase === 'score' ? 0.7 + 0.25 * scoreShare : 0.95) : scoreShare;
  const deckBusy = scheduler.running || scoringNow;
  const step = scoringNow && scoring.progress?.total ? `${Math.min(scoring.progress.done + 1, scoring.progress.total)}/${scoring.progress.total}` : '';
  const runText = scoringNow ? t(`AI 正在打分 ${step}`, `AI is scoring ${step}`)
    : scheduler.running ? (scheduler.phase === 'track' ? t('正在更新投递状态…', 'Updating applications…') : t(`正在抓取 ${Math.round(deckProgress * 100)}%`, `Fetching ${Math.round(deckProgress * 100)}%`)) : '';
  const track = groove.followMusic ? nowPlaying.track : null;
  const trackSub = track ? [track.artist, appName(track.app, t)].filter(Boolean).join(' · ') : '';
  const weekTotal = (stats.week || []).reduce((sum, value) => sum + value, 0);
  const openApplications = ['applied', 'oa', 'interview', 'offer'].reduce((sum, key) => sum + (stats.applications[key] || 0), 0);
  const badges = { feed: stats.newPostings, saved: stats.savedPostings, applications: openApplications, browser: browser?.approval ? '!' : null };
  const shared = { boot, reload, setView: goTo, dataVersion, refreshStatus: async () => setStatus(await api('/api/status')) };
  const openItem = (target, id) => { setFocus({ view: target, id }); setView(target); setBrowserWide(false); };
  const focusFor = target => (focus?.view === target ? focus.id : null);
  const canSide = windowWidth >= SIDE_MIN_WINDOW;
  const wide = browserOpen && (browserWide || !canSide);
  const pianoKeys = VIEWS.map(item => ({
    id: item.id, icon: item.icon, label: t(...item.label), note: item.note, alert: item.id === 'browser',
    active: item.id === 'browser' ? browserOpen : view === item.id && !wide,
    badge: badges[item.id] ? (badges[item.id] > 999 ? '999+' : badges[item.id]) : null,
    onSelect: () => (item.id === 'browser' ? setBrowserOpen(open => !open) : goTo(item.id)),
  }));
  // On: sound waves grow out of the button and it turns yellow. Off: the waves draw back.
  function toggleSound(event) {
    const next = !groove.sound;
    prefs.set({ sound: next });
    if (next) { playHello(); rings(event.currentTarget, { count: 2, tone: 'yellow', scale: 2.4 }); }
    pop(event.currentTarget.querySelector('svg'), next ? 1.25 : 0.8);
  }
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
          <BrandNote label={t('回到主页', 'Back to Home')} onClick={() => goTo('home')} />
          <Wordmark />
          <button type="button" className={`sound-button${groove.sound ? ' on' : ''}`} onClick={toggleSound} aria-pressed={groove.sound}
            title={groove.sound ? t('关闭提示音', 'Turn sounds off') : t('打开提示音', 'Turn sounds on')} aria-label={t('提示音', 'Sounds')}>
            {groove.sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>
          <LanguageSwitch compact />
        </div>
        <PianoNav items={pianoKeys} theme={theme} label={t('主导航', 'Main navigation')} />
        <div className="sidebar-foot">
          <UpdateItem state={update} />
          <button ref={bell} className={`nav-item${showNotifications ? ' active' : ''}`} data-fx="bell" onClick={() => setShowNotifications(value => !value)}>
            <Bell size={18} /><span>{t('通知', 'Notifications')}</span>{stats.unreadNotifications ? <em key={stats.unreadNotifications}>{stats.unreadNotifications}</em> : null}
          </button>
          <WeekBars week={stats.week || [0, 0, 0, 0, 0, 0, 0]} days={WEEKDAYS[lang] || WEEKDAYS.en} title={t('本周投递', 'This week')}
            total={t(`${weekTotal} 份`, `${weekTotal} applied`)} breathe={deckBusy || Boolean(track)} />
          <Turntable busy={deckBusy} disabled={scheduler.running} progress={deckProgress} playing={Boolean(track)} onStart={runNow}
            label={scheduler.running ? t('抓取中', 'Searching') : t('点唱片开始抓取', 'Click the record to search now')}
            title={track ? track.title : t('每日推荐', 'Daily picks')}
            sub={runText || trackSub || nextRunText(scheduler.nextRunAt)} dim={scoring.paused && !deckBusy} />
          {scoring.paused || runMessage || scoringNow ? (
            <div className="run-extra">
              {scoring.paused ? <p className="run-paused"><Pause size={14} />{scoring.held ? t(`AI 打分已暂停，${scoring.held} 个岗位等着打分`, `AI scoring is paused; ${scoring.held} ${scoring.held === 1 ? 'job is' : 'jobs are'} waiting`) : t('AI 打分已暂停', 'AI scoring is paused')}</p> : null}
              {runMessage ? <p className="run-message">{runMessage}</p> : null}
              {scoringNow ? <button className="button block" data-fx="morph" onClick={() => setScoringPaused(true)}><Pause size={15} />{t('暂停打分', 'Pause scoring')}</button>
                : scoring.paused ? <button className="button block" data-fx="morph" onClick={() => setScoringPaused(false)}><Play size={15} />{t('继续打分', 'Resume scoring')}</button> : null}
            </div>
          ) : null}
        </div>
      </aside>
      <Metronome active={scoringNow} done={scoring.progress?.done || 0} total={scoring.progress?.total || 0} />
      {showNotifications ? <NotificationsPanel onClose={() => setShowNotifications(false)} onChanged={shared.refreshStatus} setView={goTo} /> : null}
      <main className={`main${browserOpen ? ` with-browser${wide ? ' wide' : ''}` : ''}`}>
        <div className="main-view">
          {view === 'home' ? <HomeView {...shared} openItem={openItem} /> : null}
          {view === 'feed' ? <FeedView key={`feed-${focusFor('feed')}`} mode="active" focus={focusFor('feed')} {...shared} /> : null}
          {view === 'saved' ? <FeedView key={`saved-${focusFor('saved')}`} mode="saved" focus={focusFor('saved')} {...shared} /> : null}
          {view === 'applications' ? <ApplicationsView key={`applications-${focusFor('applications')}`} focus={focusFor('applications')} {...shared} /> : null}
          {view === 'searches' ? <SearchesView {...shared} status={status} /> : null}
          {view === 'resume' ? <ResumeView key={`resume-${focusFor('resume')}`} focus={focusFor('resume')} {...shared} status={status} /> : null}
          {view === 'settings' ? <SettingsView key={`settings-${focusFor('settings')}`} focus={focusFor('settings')} {...shared} update={update} /> : null}
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
