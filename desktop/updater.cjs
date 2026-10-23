// Looks for a newer Dayjob on GitHub Releases, by default once a day and
// whenever the user asks. The installed app downloads and installs it itself
// (electron-updater, with the latest.yml each release publishes); the portable
// app cannot replace itself, so its new download opens in the user's browser.
const RELEASES = 'https://github.com/Key07211/dayjob---job-tracker/releases';
const DAY = 24 * 60 * 60 * 1000;
const BUSY = ['checking', 'downloading', 'downloaded'];

const reason = error => String(error?.message || error || 'Unknown error').split('\n')[0].slice(0, 300);

function createUpdater({ updater, version, portable = false, openExternal, autoCheck, lastCheck, saveLastCheck, onState = () => {},
  installOnQuit = true, log = console.warn, now = () => Date.now() }) {
  let state = { status: updater ? 'idle' : 'unsupported', version, latest: null, progress: null, checkedAt: lastCheck() || null, error: null, portable };
  let timer = null;
  const set = patch => {
    state = { ...state, ...patch };
    onState(state);
    return state;
  };

  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = installOnQuit;
    updater.logger = { info() {}, debug() {}, warn: message => log(`[dayjob] update: ${message}`), error: message => log(`[dayjob] update: ${message}`) };
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
        : set({ status: 'latest', latest: null, checkedAt });
    } catch (error) {
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
      return set({ status: 'available', progress: null, error: reason(error) });
    }
  }

  // Quits Dayjob, runs the new installer silently and starts Dayjob again.
  function install() {
    if (state.status === 'downloaded') updater.quitAndInstall(true, true);
  }

  function due() {
    if (!autoCheck() || BUSY.includes(state.status) || state.status === 'available') return false;
    const last = Date.parse(lastCheck() || '');
    return !Number.isFinite(last) || now() - last >= DAY;
  }

  // Shortly after start, then hourly: check when the last check is a day old.
  function start({ delayMs = 30 * 1000, everyMs = 60 * 60 * 1000 } = {}) {
    if (!updater || timer) return;
    const tick = () => {
      if (due()) void check();
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
