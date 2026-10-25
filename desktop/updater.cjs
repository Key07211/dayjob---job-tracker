// Looks for a newer Dayjob on GitHub Releases, by default once a day and
// whenever the user asks. The installed app downloads and installs it itself
// (electron-updater, with the latest.yml each release publishes); the portable
// app cannot replace itself, so its new download opens in the user's browser.
// Each install is remembered, so that one which did not happen is reported on
// the next start instead of going unnoticed.
const RELEASES = 'https://github.com/Key07211/dayjob---job-tracker/releases';
const DAY = 24 * 60 * 60 * 1000;
const BUSY = ['checking', 'downloading', 'downloaded', 'installing'];

const reason = error => String(error?.message || error || 'Unknown error').split('\n')[0].slice(0, 300);
const newer = (a, b) => {
  const [x, y] = [a, b].map(value => String(value).split('.').map(Number));
  const at = [0, 1, 2].find(index => x[index] !== y[index]);
  return at !== undefined && x[at] > y[at];
};

// problem: 'in-use' when something still runs from Dayjob's folder and the
// install cannot start; 'not-installed' when the last install did not happen.
function createUpdater({ updater, version, portable = false, openExternal, autoCheck, lastCheck, saveLastCheck, onState = () => {},
  installOnQuit = true, freeInstall = async () => [], lastAttempt = () => null, saveAttempt = () => {}, installWaitMs = 30 * 1000, log = console.warn, now = () => Date.now() }) {
  let state = { status: updater ? 'idle' : 'unsupported', version, latest: null, progress: null, checkedAt: lastCheck() || null, error: null, problem: null, portable };
  let timer = null;
  let retry = false;
  const attempt = updater ? lastAttempt() : null;
  if (attempt?.version) {
    if (newer(attempt.version, version)) {
      log(`[dayjob] update: the install of ${attempt.version} did not happen; still on ${version}`);
      state = { ...state, latest: attempt.version, problem: 'not-installed', error: `The update to ${attempt.version} was not installed.` };
      retry = !portable;
    } else log(`[dayjob] update: now on ${version}`);
    saveAttempt(null);
  }
  const set = patch => {
    state = { ...state, ...patch };
    onState(state);
    return state;
  };

  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = installOnQuit;
    const note = message => log(`[dayjob] update: ${message}`);
    updater.logger = { info: note, debug() {}, warn: note, error: note };
    // Failures also reject the call that caused them; this only keeps an
    // 'error' event from going unhandled.
    updater.on('error', () => {});
    updater.on('download-progress', progress => set({ status: 'downloading', progress: Math.max(0, Math.min(100, Math.floor(progress.percent || 0))) }));
  }

  async function check() {
    if (!updater || BUSY.includes(state.status)) return state;
    set({ status: 'checking', error: null });
    try {
      const result = await updater.checkForUpdates();
      const checkedAt = new Date(now()).toISOString();
      saveLastCheck(checkedAt);
      if (!result) return set({ status: 'unsupported', checkedAt });
      return result.isUpdateAvailable
        ? set({ status: 'available', latest: result.updateInfo.version, checkedAt })
        : set({ status: 'latest', latest: null, checkedAt, problem: null, error: null });
    } catch (error) {
      log(`[dayjob] update: check failed: ${reason(error)}`);
      return set({ status: 'error', error: reason(error) });
    }
  }

  async function download() {
    if (!updater || state.status !== 'available') return state;
    if (portable) {
      await openExternal(`${RELEASES}/download/v${state.latest}/Dayjob-Portable-${state.latest}.exe`);
      return state;
    }
    set({ status: 'downloading', progress: 0, error: null });
    try {
      await updater.downloadUpdate();
      return set({ status: 'downloaded', progress: 100 });
    } catch (error) {
      log(`[dayjob] update: download failed: ${reason(error)}`);
      return set({ status: 'available', progress: null, error: reason(error) });
    }
  }

  // Quits Dayjob, runs the new installer silently and starts Dayjob again,
  // once nothing else runs from Dayjob's folder.
  async function install() {
    if (!updater || state.status !== 'downloaded') return state;
    set({ status: 'installing', problem: null, error: null });
    let left = [];
    try { left = await freeInstall(); } catch (error) { log(`[dayjob] update: could not look for processes in the install folder: ${reason(error)}`); }
    if (left.length) {
      return set({ status: 'downloaded', problem: 'in-use', error: `${left.length} Dayjob process(es) started by another program, such as Claude's MCP bridge, still run from the install folder.` });
    }
    saveAttempt({ version: state.latest, from: version, at: new Date(now()).toISOString() });
    log(`[dayjob] update: installing ${state.latest} over ${version}`);
    updater.quitAndInstall(true, true);
    // Dayjob quits once the installer starts; if it is still here, it did not.
    const stuck = setTimeout(() => {
      if (state.status !== 'installing') return;
      log('[dayjob] update: the installer did not start');
      set({ status: 'downloaded', problem: 'not-installed', error: 'The installer did not start.' });
    }, installWaitMs);
    stuck.unref?.();
    return state;
  }

  function due() {
    if (!autoCheck() || BUSY.includes(state.status) || state.status === 'available') return false;
    const last = Date.parse(lastCheck() || '');
    return !Number.isFinite(last) || now() - last >= DAY;
  }

  // Shortly after start, then hourly: check when the last check is a day old.
  // After an install that did not happen, it gets that update ready again at
  // once (the download is usually still there), since the user already chose it.
  function start({ delayMs = 30 * 1000, everyMs = 60 * 60 * 1000 } = {}) {
    if (!updater || timer) return;
    const tick = () => {
      if (retry) {
        retry = false;
        void check().then(() => (state.status === 'available' ? download() : state));
      } else if (due()) void check();
      timer = setTimeout(tick, everyMs);
    };
    timer = setTimeout(tick, delayMs);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  return { state: () => state, check, download, install, start, stop, due };
}

module.exports = { createUpdater, RELEASES };
