import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUpdater } = require('../desktop/updater.cjs');
const { blockers, freeInstallFolder } = require('../desktop/install-lock.cjs');

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
  const attempts = [];
  const logs = [];
  let attempt = options.attempt ?? null;
  const control = createUpdater({ updater, version: '0.3.0', portable: options.portable, openExternal: async url => { opened.push(url); },
    autoCheck: () => auto, lastCheck: () => last, saveLastCheck: at => { last = at; saved.push(at); }, onState: state => states.push(state.status),
    freeInstall: options.freeInstall, lastAttempt: () => attempt, saveAttempt: value => { attempt = value; attempts.push(value); },
    installWaitMs: options.installWaitMs, now: () => Date.parse('2026-10-23T08:00:00Z'), log: message => logs.push(message) });
  return { control, updater, saved, states, opened, attempts, logs, setAuto: value => { auto = value; }, setLast: value => { last = value; } };
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
  await control.install();
  assert.deepEqual(updater.calls, ['check', 'download', ['install', true, true]]);
  assert.equal(control.state().status, 'installing');
});

test('an install waits until nothing else runs from the folder, and says why when something does', async () => {
  let left = [{ pid: 4242, bridge: true }];
  const busy = setup({ freeInstall: async () => left });
  await busy.control.check();
  await busy.control.download();
  const blocked = await busy.control.install();
  assert.deepEqual([blocked.status, blocked.problem], ['downloaded', 'in-use']);
  assert.match(blocked.error, /MCP bridge/);
  assert.ok(!busy.updater.calls.some(call => Array.isArray(call)), 'the installer does not start while the files are in use');
  assert.deepEqual(busy.attempts, []);

  left = [];
  await busy.control.install();
  assert.deepEqual(busy.updater.calls.at(-1), ['install', true, true]);
  assert.deepEqual(busy.attempts, [{ version: '0.4.0', from: '0.3.0', at: '2026-10-23T08:00:00.000Z' }], 'the install is remembered');
  assert.ok(busy.logs.some(line => /installing 0\.4\.0 over 0\.3\.0/.test(line)));

  // The installer never started, so Dayjob is still running.
  const stuck = setup({ installWaitMs: 10 });
  await stuck.control.check();
  await stuck.control.download();
  await stuck.control.install();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual([stuck.control.state().status, stuck.control.state().problem], ['downloaded', 'not-installed']);
});

test('an update that did not install is reported on the next start and made ready again', async () => {
  const failed = setup({ attempt: { version: '0.4.0', from: '0.3.0', at: '2026-10-23T07:00:00Z' }, last: '2026-10-23T07:00:00Z' });
  assert.deepEqual([failed.control.state().problem, failed.control.state().latest], ['not-installed', '0.4.0']);
  assert.deepEqual(failed.attempts, [null], 'reported once');
  failed.control.start({ delayMs: 5, everyMs: 60000 });
  await new Promise(resolve => setTimeout(resolve, 40));
  failed.control.stop();
  assert.deepEqual(failed.updater.calls, ['check', 'download'], 'checked and downloaded again although the daily check is not due');
  assert.deepEqual([failed.control.state().status, failed.control.state().problem], ['downloaded', 'not-installed']);

  const done = setup({ attempt: { version: '0.3.0', from: '0.2.0', at: '2026-10-23T07:00:00Z' } });
  assert.equal(done.control.state().problem, null);
  assert.deepEqual(done.attempts, [null]);
  assert.ok(done.logs.some(line => /now on 0\.3\.0/.test(line)));
});

test('only what runs from this install, other than Dayjob and its helpers, is stopped', async () => {
  const dir = 'C:\\Users\\Yuanjin Li\\AppData\\Local\\Programs\\Dayjob';
  const exe = `${dir}\\Dayjob.exe`;
  const processes = [
    { pid: 10, parent: 1, path: exe, command: `"${exe}"` },
    { pid: 11, parent: 10, path: exe, command: `"${exe}" --type=renderer --user-data-dir=x` },
    { pid: 12, parent: 10, path: exe, command: `"${exe}" --type=gpu-process` },
    { pid: 20, parent: 900, path: exe, command: `"${exe}" "${dir}\\resources\\app.asar\\integrations\\mcp-server.mjs"` },
    { pid: 21, parent: 901, path: exe.toLowerCase(), command: `"${exe}" --type=renderer` },
    { pid: 30, parent: 902, path: 'C:\\Users\\x\\AppData\\Local\\Temp\\2abc\\Dayjob.exe', command: 'portable' },
    { pid: 31, parent: 903, path: `${dir}-old\\Dayjob.exe`, command: '' },
    { pid: 32, parent: 904, path: null, command: '' },
  ];
  assert.deepEqual(blockers(processes, { dir, pid: 10 }), [{ pid: 20, bridge: true }, { pid: 21, bridge: false }]);

  let running = [...processes];
  const killed = [];
  const list = async () => running;
  const kill = pid => { killed.push(pid); running = running.filter(item => item.pid !== pid); };
  assert.deepEqual(await freeInstallFolder({ dir, pid: 10, list, kill, stepMs: 1 }), []);
  assert.deepEqual(killed, [20, 21]);

  running = [...processes];
  const stubborn = await freeInstallFolder({ dir, pid: 10, list, kill: () => { throw new Error('Access is denied'); }, waitMs: 5, stepMs: 1 });
  assert.deepEqual(stubborn.map(item => item.pid), [20, 21], 'what cannot be stopped is returned');
  assert.deepEqual(await freeInstallFolder({ dir, pid: 10, list: async () => processes.slice(0, 3), kill }), []);
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
