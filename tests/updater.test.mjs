import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const { createUpdater } = createRequire(import.meta.url)('../desktop/updater.cjs');

function fakeUpdater({ latest = '0.4.0', fail = null } = {}) {
  const updater = new EventEmitter();
  updater.calls = [];
  updater.checkForUpdates = async () => {
    updater.calls.push('check');
    if (fail) throw new Error(`${fail}\n    at stack line`);
    return { isUpdateAvailable: latest !== '0.3.0', updateInfo: { version: latest } };
  };
  updater.downloadUpdate = async () => {
    updater.calls.push('download');
    for (const percent of [12.5, 64.2, 100]) updater.emit('download-progress', { percent });
    return ['Dayjob-Setup.exe'];
  };
  updater.quitAndInstall = (...args) => updater.calls.push(['install', ...args]);
  return updater;
}

function setup(options = {}, updater = fakeUpdater()) {
  const saved = [];
  const states = [];
  const opened = [];
  let last = options.last ?? null;
  let auto = options.auto ?? true;
  const control = createUpdater({ updater, version: '0.3.0', portable: options.portable, openExternal: async url => { opened.push(url); },
    autoCheck: () => auto, lastCheck: () => last, saveLastCheck: at => { last = at; saved.push(at); }, onState: state => states.push(state.status),
    now: () => Date.parse('2026-10-23T08:00:00Z'), log: () => {} });
  return { control, updater, saved, states, opened, setAuto: value => { auto = value; }, setLast: value => { last = value; } };
}

test('a newer release becomes a download, then a restart', async () => {
  const { control, updater, saved, states } = setup();
  assert.equal(updater.autoDownload, false, 'nothing downloads until the user clicks');
  assert.equal(control.state().status, 'idle');
  const found = await control.check();
  assert.deepEqual([found.status, found.latest, found.checkedAt], ['available', '0.4.0', '2026-10-23T08:00:00.000Z']);
  assert.deepEqual(saved, ['2026-10-23T08:00:00.000Z']);
  const done = await control.download();
  assert.equal(done.status, 'downloaded');
  assert.deepEqual(states, ['checking', 'available', 'downloading', 'downloading', 'downloading', 'downloading', 'downloaded']);
  assert.equal(await control.check(), control.state(), 'no new check while an update waits');
  control.install();
  assert.deepEqual(updater.calls, ['check', 'download', ['install', true, true]]);
});

test('up to date, failures and the portable app', async () => {
  const latest = setup({}, fakeUpdater({ latest: '0.3.0' }));
  assert.equal((await latest.control.check()).status, 'latest');
  assert.equal((await latest.control.download()).status, 'latest', 'nothing to download');

  const offline = setup({}, fakeUpdater({ fail: 'net::ERR_INTERNET_DISCONNECTED' }));
  const failed = await offline.control.check();
  assert.deepEqual([failed.status, failed.error], ['error', 'net::ERR_INTERNET_DISCONNECTED']);
  assert.deepEqual(offline.saved, [], 'a failed check is tried again later');

  const portable = setup({ portable: true });
  await portable.control.check();
  await portable.control.download();
  assert.deepEqual(portable.opened, ['https://github.com/Key07211/dayjob---job-tracker/releases/download/v0.4.0/Dayjob-Portable-0.4.0.exe']);
  assert.ok(!portable.updater.calls.includes('download'), 'the portable app downloads in the browser');

  const dev = createUpdater({ updater: null, version: '0.3.0', autoCheck: () => true, lastCheck: () => null, saveLastCheck: () => {} });
  assert.equal((await dev.check()).status, 'unsupported');
});

test('the daily check runs when the last one is a day old and it is on', async () => {
  const { control, updater, setAuto, setLast } = setup({ last: '2026-10-22T09:00:00Z' });
  assert.equal(control.due(), false, '23 hours ago');
  setLast('2026-10-22T07:59:00Z');
  assert.equal(control.due(), true);
  setAuto(false);
  assert.equal(control.due(), false, 'switched off in Settings');
  setAuto(true);
  setLast(null);
  control.start({ delayMs: 5, everyMs: 60000 });
  await new Promise(resolve => setTimeout(resolve, 40));
  control.stop();
  assert.deepEqual(updater.calls, ['check']);
});
