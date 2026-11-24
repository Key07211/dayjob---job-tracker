import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bell, Bookmark, Bot, BriefcaseBusiness, ChevronsLeft, FileUser, Globe, Inbox, LayoutDashboard, Pause, Play, Search, Settings, Volume2, VolumeX } from 'lucide-react';
import { api, setToken } from './api.js';
import { I18nProvider, LanguageSwitch, currentLanguage, tr, useI18n } from './i18n.jsx';
import { inOrder } from './dayjob/in-order.js';
import { formatDay } from './dayjob/format.js';
import { HomeView } from './dayjob/HomeView.jsx';
import { FeedView } from './dayjob/FeedView.jsx';
import { ApplicationsView } from './dayjob/ApplicationsView.jsx';
import { SearchesView } from './dayjob/SearchesView.jsx';
import { ResumeView } from './dayjob/ResumeView.jsx';
import { SettingsView } from './dayjob/SettingsView.jsx';
import { paneLimits, panesFor } from './dayjob/panes.js';
import { NotificationsPanel } from './dayjob/NotificationsPanel.jsx';
import { BrowserView, hasBrowser, useBrowserState } from './dayjob/BrowserView.jsx';
import { UpdateItem, useUpdateState } from './dayjob/UpdateButton.jsx';
import { AssistantCard } from './dayjob/assistant/AssistantCard.jsx';
import { AssistantPane } from './dayjob/assistant/AssistantPane.jsx';
import { runResult } from './dayjob/run-outcome.js';
import { assistant, onAssistantEffect, useAssistant } from './dayjob/assistant/store.js';
import { Guide } from './dayjob/guide/Guide.jsx';
import { guide, useGuide } from './dayjob/guide/store.js';
import { PianoNav } from './dayjob/groove/PianoNav.jsx';
import { BeatLoader, BrandMark, Wordmark } from './dayjob/groove/BrandMark.jsx';
import { Opening, openingPlays } from './dayjob/groove/Opening.jsx';
import { Turntable } from './dayjob/groove/Turntable.jsx';
import { Metronome } from './dayjob/groove/Metronome.jsx';
import { emit, useGroove } from './dayjob/groove/bus.js';
import { prefs, usePrefs, useTheme } from './dayjob/groove/prefs.js';
import { BEAT, cue, playBatchEnd, playHello, playKey, playLift, playNeedle, playScore } from './dayjob/groove/sound.js';
import { flyTo, installClickFx, pop, rings, wiggle } from './dayjob/groove/fx.js';
import { appName, setFollow, useNowPlaying } from './dayjob/groove/music.js';
import { startThemeClock } from './dayjob/theme.js';
import '@fontsource-variable/nunito/wght.css';
import './dayjob/fonts/fonts.css';
import './dayjob/dayjob.css';
import './dayjob/groove/groove.css';
import './dayjob/groove/keys.css';
import './dayjob/groove/fx.css';
import './dayjob/groove/picker.css';
import './dayjob/groove/opening.css';
import './dayjob/assistant/assistant.css';
import './dayjob/guide/guide.css';
import './dayjob/frame.css';

// note: the page's key, 0–7 from the top, so its phrase stays the same with or without the browser.
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
const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
const keep = (storage, key, value) => { try { storage.setItem(key, value); } catch { /* optional */ } };

// The sidebar holds its keys, the assistant's card and the record in smaller forms as it gets shorter (groove.css,
// assistant.css). What counts is the room those have: the window's height less what the lines under the record take
// (a search's result, the paused line, the pause button), which come and go. Each step is a class on the sidebar.
const SIDE_STEPS = [909, 879, 729, 690, 599];
const EXTRA_GAP = 8;
function useSidebarRoom() {
  const [extra, setExtra] = useState(null);
  const [room, setRoom] = useState(() => window.innerHeight);
  useLayoutEffect(() => {
    const measure = () => setRoom(window.innerHeight - (extra ? extra.offsetHeight + EXTRA_GAP : 0));
    measure();
    window.addEventListener('resize', measure);
    const watch = extra && typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    watch?.observe(extra);
    return () => { window.removeEventListener('resize', measure); watch?.disconnect(); };
  }, [extra]);
  return { room, extraRef: setExtra, steps: SIDE_STEPS.filter(step => room <= step).map(step => ` h${step}`).join('') };
}

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
// One save after another: two quick switches must not overtake each other on the way, or the language clicked
// first would be the one the next launch opens in.
const saveLanguage = inOrder(language => api('/api/settings', { method: 'PATCH', body: { language } }));

function App() {
  const { t, setLang } = useI18n();
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
  // With no room for the browser beside what is open, it is a thin bar at the window's edge (true) or was opened
  // from there and has the page's place (false). It only counts while there is no room (panes.js).
  const [browserFolded, setBrowserFolded] = useState(false);
  const [paneWidth, setPaneWidth] = useState(() => Number(read(localStorage, 'dayjob-browser-width')) || null);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  // A job or application picked on Home or in the browser, for its view to
  // open with; any other way of changing views clears it. "browser" opens the
  // browser beside the current view.
  const [focus, setFocus] = useState(null);
  // Going to a page while the assistant has the whole one: the page comes forward and the chat docks at the side.
  const dockAssistant = () => { if (assistant.get().form === 'full') assistant.setForm('side'); };
  // The browser, asked for by the user: it opens, and comes out of its bar if it was folded there.
  const showBrowser = useCallback(() => { setBrowserOpen(true); setBrowserFolded(false); }, []);
  // Claude or the assistant started on a page: a closed browser opens so the work can be looked at. With no room
  // beside the page it opens as its bar, and one already folded stays folded: the page the user is on is not
  // taken away from them.
  const browserIsOpen = useRef(browserOpen);
  browserIsOpen.current = browserOpen;
  const revealBrowser = useCallback(() => { if (!browserIsOpen.current) setBrowserFolded(true); setBrowserOpen(true); }, []);
  // Going to a page brings it forward: a browser that had its place folds into its bar.
  const goTo = useCallback(target => {
    if (target === 'browser') { showBrowser(); return; }
    setFocus(null);
    setView(target);
    setBrowserWide(false);
    setBrowserFolded(true);
    dockAssistant();
  }, [showBrowser]);
  const openItem = useCallback((target, id) => {
    if (target === 'browser') { showBrowser(); return; }
    setFocus({ view: target, id });
    setView(target);
    setBrowserWide(false);
    setBrowserFolded(true);
    dockAssistant();
  }, [showBrowser]);
  const chat = useAssistant();
  // Who stands where (panes.js): the page, then the assistant's side chat, then the browser at the window's edge.
  // The assistant as a full page stands where the view does; when the browser takes the page instead (made wide,
  // or opened from its bar in a window too narrow for both), the chat goes to the side so it stays in sight.
  const { assistantFull, assistantOpen, beside, canSide, tight, folded, wide, width, minPane, maxPane } = panesFor({
    windowWidth, browserOpen, browserWide, browserFolded, chatOpen: chat.open, chatForm: chat.form, paneWidth });
  // The room beside the page went away under an open browser (the window was made smaller, or the chat opened;
  // also a browser kept from last time, at the start): it folds into its bar by itself. One the user opens when
  // there is no room is left open.
  const before = useRef({ tight: false, open: browserOpen });
  useLayoutEffect(() => {
    if (tight && !before.current.tight && before.current.open) setBrowserFolded(true);
    before.current = { tight, open: browserOpen };
  }, [tight, browserOpen]);
  const [status, setStatus] = useState(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [runMessage, setRunMessage] = useState('');
  const side = useSidebarRoom();
  // Stopping a search: while it winds down, then what it kept, for a few seconds under the record.
  const [stopping, setStopping] = useState(false);
  const [deckNote, setDeckNote] = useState('');
  const startedAt = useRef(0);
  const [dataVersion, setDataVersion] = useState(0);
  const wasRunning = useRef(false);
  const wasSearching = useRef(false);
  const adopted = useRef(false);
  // Scores that landed since the last poll play one per beat, so a batch sounds like a melody, not a chord.
  const feed = useRef({ seq: null, queue: [], timer: 0, batch: 0, busy: false });
  const [pending, setPending] = useState(0);
  const browser = useBrowserState(revealBrowser);
  const update = useUpdateState();
  // The user guide. The first time Dayjob opens on this computer, once the opening has given way and the first
  // data is here, the assistant steps out and shows the user around; later it comes only when asked for.
  const tour = useGuide();
  // The Settings guide keeps a column at the right of the window for its card, and the page gets narrower.
  const tourDocked = tour.on && tour.tour === 'settings';
  const [opened, setOpened] = useState(() => !openingPlays());
  const openingEnded = useCallback(() => setOpened(true), []);
  const booted = Boolean(boot);
  useEffect(() => (booted && opened ? guide.firstTime(BEAT / 2) : undefined), [booted, opened]);
  useEffect(() => { if (tour.on) setShowNotifications(false); }, [tour.on]);

  const reload = useCallback(async () => {
    try {
      const value = await api('/api/bootstrap');
      setToken(value.csrfToken);
      // A language saved earlier wins. Before one has been, the window already speaks the system's (i18n.jsx); it is
      // saved here as the choice, so the tray and the notifications speak it too.
      if (!adopted.current) {
        if (value.languageChosen) setLang(value.settings.language, { adopt: true });
        else setLang(currentLanguage());
      }
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
  // The sidebar's browser key, pressed while the browser is open: the browser closes as its own × does, asking first.
  const [closeAsked, setCloseAsked] = useState(0);
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
      if (run) setRunMessage(runResult(run, tr));
    }
    wasRunning.current = busy;
    wasSearching.current = Boolean(status?.scheduler?.running);
  }, [busy, status]);

  // A search was just asked for, here or on the Searches page. It can be over before the next look at the status (a
  // short one ends within seconds); noted here, it still ends with its result said and the lists read again.
  const runStarted = useCallback(async () => {
    wasRunning.current = true;
    wasSearching.current = true;
    const next = await api('/api/status');
    setStatus(next);
    return next;
  }, []);

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
  // An application anywhere: the week bars catch up. It makes no sound of its own: the row's rings show it.
  useGroove('apply', () => {
    api('/api/status').then(setStatus).catch(() => {});
  });
  // 自动收录: an application the Dayjob browser saw go through is recorded by Dayjob itself. The lists catch up, and it
  // shows like any other; they catch up again when the note is taken back.
  const appliedNote = browser?.applied?.state === 'recorded' ? browser.applied : null;
  const appliedSeen = useRef(null);
  useEffect(() => {
    const id = appliedNote?.id || null;
    if (id === appliedSeen.current) return;
    appliedSeen.current = id;
    setDataVersion(version => version + 1);
    if (id) emit('apply', { postingId: appliedNote.postingId });
    else api('/api/status').then(setStatus).catch(() => {});
  }, [appliedNote?.id]);
  useEffect(() => installClickFx(), []);
  // What the assistant does shows in the window: a note flies from the gramophone's horn to the page's key, which sounds;
  // lists catch up with a change; and "show me" brings the page forward.
  useEffect(() => onAssistantEffect(({ tool, changed, applied, ui }) => {
    const key = tool?.ok ? VIEWS.find(item => item.id === tool.view) : null;
    if (key) {
      flyTo(document.querySelector('.assistant-pane .asst-head .gram-mouth') || document.querySelector('.assistant-card .gramophone'), key.id);
      playKey(key.note, theme);
    }
    if (changed) {
      setDataVersion(version => version + 1);
      api('/api/status').then(setStatus).catch(() => {});
    }
    if (applied) emit('apply', {});
    if (ui?.open) openItem(ui.open, ui.id);
  }), [theme, openItem]);
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

  useEffect(() => {
    if (!deckNote) return undefined;
    const timer = setTimeout(() => setDeckNote(''), 6000);
    return () => clearTimeout(timer);
  }, [deckNote]);

  async function runNow() {
    setRunMessage('');
    setDeckNote('');
    startedAt.current = Date.now();
    playNeedle();
    emit('fetch');
    try {
      await api('/api/runs', { method: 'POST', body: {} });
      await runStarted();
    } catch (failure) { setRunMessage(failure.message); }
  }

  // Clicking the record again while it searches stops the search, keeping what it found. A click within a second
  // of starting is taken as the second half of a double click.
  async function stopRun() {
    if (stopping || Date.now() - startedAt.current < 1000) return;
    setStopping(true);
    playLift();
    try {
      const result = await api('/api/runs/cancel', { method: 'POST', body: {} });
      setStatus(await api('/api/status'));
      if (result.run) setDeckNote(t(`已停止，留下 ${result.run.newCount} 个新岗位`, `Stopped; kept ${result.run.newCount} new ${result.run.newCount === 1 ? 'job' : 'jobs'}`));
    } catch (failure) { setRunMessage(failure.message); }
    finally { setStopping(false); }
  }

  // The opening plays over the page when the window first shows. It is the first child of the root div in both trees
  // below, so it carries on when the first data arrives.
  const opening = <Opening ready={Boolean(boot)} failed={Boolean(error) && !boot} onEnd={openingEnded} />;
  if (!boot) {
    return (
      <div className="boot-screen">
        {opening}
        {error ? <><p>{error}</p><button className="button primary" onClick={reload}>{t('重试', 'Retry')}</button></> : <BeatLoader />}
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
  const halting = scheduler.running && (stopping || scheduler.stopping);
  const runText = halting ? t('正在停止…', 'Stopping…') : scoringNow ? t(`AI 正在打分 ${step}`, `AI is scoring ${step}`)
    : scheduler.running ? (scheduler.phase === 'track' ? t('正在更新投递状态…', 'Updating applications…') : t(`正在抓取 ${Math.round(deckProgress * 100)}%`, `Fetching ${Math.round(deckProgress * 100)}%`)) : '';
  const track = groove.followMusic ? nowPlaying.track : null;
  const trackSub = track ? [track.artist, appName(track.app, t)].filter(Boolean).join(' · ') : '';
  const openApplications = ['applied', 'oa', 'interview', 'offer'].reduce((sum, key) => sum + (stats.applications[key] || 0), 0);
  const badges = { feed: stats.newPostings, saved: stats.savedPostings, applications: openApplications, browser: browser?.approval ? '!' : null };
  const shared = { boot, reload, setView: goTo, dataVersion, refreshStatus: async () => setStatus(await api('/api/status')), runStarted };
  const focusFor = target => (focus?.view === target ? focus.id : null);
  const assistantForm = assistantFull ? 'full' : assistantOpen ? 'side' : 'closed';
  const browserPages = (browser?.tabs || []).filter(tab => tab.url && tab.url !== 'about:blank').length;
  // A question from the assistant waits for the user (several can, one for each application it works on).
  const asking = (browser?.approvals || (browser?.approval ? [browser.approval] : [])).some(item => item.by === 'assistant');
  const pianoKeys = VIEWS.map(item => ({
    id: item.id, icon: item.icon, label: t(...item.label), note: item.note, alert: item.id === 'browser',
    active: item.id === 'browser' ? browserOpen : view === item.id && !wide && !assistantFull,
    badge: badges[item.id] ? (badges[item.id] > 999 ? '999+' : badges[item.id]) : null,
    // The browser's key: it opens the browser (out of its bar too); pressed while the browser is in sight, it closes it.
    onSelect: () => (item.id === 'browser' ? (browserOpen && !folded ? setCloseAsked(count => count + 1) : showBrowser()) : goTo(item.id)),
  }));
  // On: sound waves grow out of the button and it turns yellow. Off: the waves draw back.
  function toggleSound(event) {
    const next = !groove.sound;
    prefs.set({ sound: next });
    if (next) { playHello(); rings(event.currentTarget, { count: 2, tone: 'yellow', scale: 2.4 }); }
    pop(event.currentTarget.querySelector('svg'), next ? 1.25 : 0.8);
  }
  // Dragging the divider: the page (a native view) is hidden meanwhile so it
  // does not swallow the pointer.
  function startResize(event) {
    event.preventDefault();
    setResizing(true);
    let last = width;
    // The browser is at the window's edge: its width is what lies right of the pointer.
    const move = moved => {
      const [low, high] = paneLimits(window.innerWidth - beside);
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
    <div className={`app-shell${tour.on ? ' guiding' : ''}`}>
      {opening}
      <aside className={`sidebar${side.steps}`} inert={tour.on}>
        <div className="brand">
          <BrandMark label={t('回到主页', 'Back to Home')} onClick={() => goTo('home')} />
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
          <AssistantCard form={assistantForm} asking={asking} onForm={assistant.setForm} large={side.room > 729} />
          <button ref={bell} className={`nav-item${showNotifications ? ' active' : ''}`} data-fx="bell" onClick={() => setShowNotifications(value => !value)}>
            <Bell size={18} /><span>{t('通知', 'Notifications')}</span>{stats.unreadNotifications ? <em key={stats.unreadNotifications}>{stats.unreadNotifications}</em> : null}
          </button>
          <Turntable busy={deckBusy} disabled={halting} progress={deckProgress} playing={Boolean(track)} onStart={scheduler.running ? stopRun : runNow}
            label={scheduler.running ? (halting ? t('正在停止…', 'Stopping…') : t('再点一下停止抓取', 'Click again to stop the search')) : t('点唱片开始抓取', 'Click the record to search now')}
            title={track ? track.title : t('每日推荐', 'Daily picks')}
            sub={runText || deckNote || trackSub || nextRunText(scheduler.nextRunAt)} dim={scoring.paused && !deckBusy} />
          {scoring.paused || runMessage || scoringNow ? (
            <div className="run-extra" ref={side.extraRef}>
              {scoring.paused ? <p className="run-paused"><Pause size={14} />{scoring.held ? t(`AI 打分已暂停，${scoring.held} 个岗位等着打分`, `AI scoring is paused; ${scoring.held} ${scoring.held === 1 ? 'job is' : 'jobs are'} waiting`) : t('AI 打分已暂停', 'AI scoring is paused')}</p> : null}
              {runMessage ? <p className="run-message" title={runMessage}>{runMessage}</p> : null}
              {scoringNow ? <button className="button block" data-fx="morph" onClick={() => setScoringPaused(true)}><Pause size={15} />{t('暂停打分', 'Pause scoring')}</button>
                : scoring.paused ? <button className="button block" data-fx="morph" onClick={() => setScoringPaused(false)}><Play size={15} />{t('继续打分', 'Resume scoring')}</button> : null}
            </div>
          ) : null}
        </div>
      </aside>
      <Metronome active={scoringNow} done={scoring.progress?.done || 0} total={scoring.progress?.total || 0} />
      {showNotifications ? <NotificationsPanel onClose={() => setShowNotifications(false)} onChanged={shared.refreshStatus} setView={goTo} openItem={openItem} /> : null}
      <main inert={tour.on} className={`main${browserOpen ? ` with-browser${wide ? ' wide' : ''}${folded ? ' folded' : ''}` : ''}${assistantOpen ? ' with-assistant' : ''}${assistantFull ? ' assistant-full' : ''}${tourDocked ? ' with-guide' : ''}`}>
        <div className="main-view">
          {assistantFull ? <AssistantPane form="full" onForm={assistant.setForm} onClose={() => assistant.setForm('closed')} openItem={openItem} browser={browser} /> : (
            <>
              {view === 'home' ? <HomeView {...shared} openItem={openItem} /> : null}
              {view === 'feed' ? <FeedView key={`feed-${focusFor('feed')}`} mode="active" focus={focusFor('feed')} {...shared} browser={browser} lastRun={status?.runs?.find(run => run.finishedAt) || null} /> : null}
              {view === 'saved' ? <FeedView key={`saved-${focusFor('saved')}`} mode="saved" focus={focusFor('saved')} {...shared} browser={browser} /> : null}
              {view === 'applications' ? <ApplicationsView key={`applications-${focusFor('applications')}`} focus={focusFor('applications')} {...shared} /> : null}
              {view === 'searches' ? <SearchesView {...shared} status={status} /> : null}
              {view === 'resume' ? <ResumeView key={`resume-${focusFor('resume')}`} focus={focusFor('resume')} {...shared} status={status} openItem={openItem} /> : null}
              {view === 'settings' ? <SettingsView key={`settings-${focusFor('settings')}`} focus={focusFor('settings')} {...shared} update={update} /> : null}
            </>
          )}
        </div>
        {/* The side chat stands left of the browser: the browser is always the one at the window's edge. */}
        {assistantOpen ? <AssistantPane form="side" onForm={assistant.setForm} onClose={() => assistant.setForm('closed')} openItem={openItem} browser={browser} /> : null}
        {browserOpen ? (
          <>
            {!wide && !folded ? <div className="pane-resizer" role="separator" aria-orientation="vertical" aria-label={t('拖动调整浏览器宽度', 'Drag to resize the browser')} tabIndex={0}
              onPointerDown={startResize} onKeyDown={nudge} onDoubleClick={() => { setPaneWidth(null); keep(localStorage, 'dayjob-browser-width', ''); }} /> : null}
            {/* No room beside the page: the browser is a bar at the window's edge until it is opened from there. */}
            {folded ? (
              <button className="browser-fold" data-fx="pop" title={t('展开浏览器', 'Open the browser')} aria-label={t(`展开浏览器，${browserPages} 个网页`, `Open the browser, ${browserPages} page${browserPages === 1 ? '' : 's'}`)} onClick={showBrowser}>
                <ChevronsLeft size={16} aria-hidden="true" />
                <Globe size={16} aria-hidden="true" />
                <span className="browser-fold-name">{t('浏览器', 'Browser')}</span>
                {browserPages ? <span className="browser-fold-count" aria-hidden="true">{browserPages}</span> : null}
                {browser?.agentBusy ? <Bot size={15} className="browser-fold-busy" aria-label={t('Claude 正在操作', 'Claude is working')} /> : null}
                {browser?.approval ? <span className="browser-fold-alert" aria-label={t('有一步等你确认', 'A step is waiting for you')}>!</span> : null}
              </button>
            ) : null}
            <div className={`browser-pane${folded ? ' folded' : ''}`} style={wide || folded ? undefined : { width }}>
              <BrowserView state={browser} covered={showNotifications || resizing || tour.on} folded={folded} boot={boot} dataVersion={dataVersion} openItem={openItem}
                wide={wide} canSide={canSide} onWide={setBrowserWide} onFold={tight ? () => setBrowserFolded(true) : null} onClose={() => setBrowserOpen(false)} closeAsked={closeAsked} />
            </div>
          </>
        ) : null}
        {tourDocked ? <div className="guide-dock" aria-hidden="true" /> : null}
      </main>
      {tour.on ? <Guide views={VIEWS} startView={view} goTo={goTo} openItem={openItem} theme={theme} hasBrowser={hasBrowser} /> : null}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><I18nProvider onChange={saveLanguage}><App /></I18nProvider></StrictMode>);
