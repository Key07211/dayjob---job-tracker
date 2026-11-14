import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { builtInJobspy, createJobspyBridge, detectJobspy, searchFailure } from '../server/jobs/scrapers/jobspy-bridge.mjs';
import { settingsPatch } from '../server/validation.mjs';
import { JOBSPY, PYTHON, dropped, pathFile, wantedFromPython } from '../scripts/build-jobspy.mjs';

const exe = process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3');
// A folder shaped like the JobSpy the Windows app carries. Nothing in it is ever started here.
function runtimeDir({ manifest = { python: '3.12.10', jobspy: '1.4.1' }, python = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-jobspy-'));
  if (manifest) fs.writeFileSync(path.join(dir, 'runtime.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (python) {
    fs.mkdirSync(path.dirname(path.join(dir, exe)), { recursive: true });
    fs.writeFileSync(path.join(dir, exe), '');
  }
  return dir;
}

test('the JobSpy inside the app is found by its folder, and only when it is whole', () => {
  const dir = runtimeDir();
  assert.deepEqual(builtInJobspy(dir), { command: path.join(dir, exe), version: '1.4.1', python: '3.12.10' });
  assert.equal(builtInJobspy(undefined), null);
  assert.equal(builtInJobspy(path.join(dir, 'nowhere')), null);
  assert.equal(builtInJobspy(runtimeDir({ python: false })), null, 'no python');
  assert.equal(builtInJobspy(runtimeDir({ manifest: null })), null, 'no runtime.json');
  assert.equal(builtInJobspy(runtimeDir({ manifest: '{broken' })), null);
  assert.equal(builtInJobspy(runtimeDir({ manifest: { python: '3.12.10' } })), null, 'a manifest that names no JobSpy');
});

async function start(options) {
  const detected = [];
  const bridges = [];
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {},
    detectJobspy: async command => { detected.push(command); return { available: command === 'my-python', version: command === 'my-python' ? '1.3.0' : null }; },
    createBridge: made => { bridges.push(made); return { search: async () => ({ postings: [], warnings: [] }) }; },
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }), score: async () => { throw new Error('No scoring here.'); } } },
    ...options });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, boot, call, detected, bridges };
}
const jobspySites = sites => sites.filter(site => site.engine === 'jobspy').map(site => [site.id, site.available, site.builtIn, site.using, site.detail]);

test('Dayjob uses the JobSpy it carries, without starting Python to ask, until the user picks their own', async t => {
  const dir = runtimeDir();
  const { app, boot, call, detected, bridges } = await start({ jobspyDir: dir });
  t.after(() => app.close());
  assert.equal(boot.settings.jobspy.runner, 'builtin');
  assert.deepEqual(jobspySites(boot.sites), [['glassdoor', true, true, 'builtin', 'JobSpy 1.4.1'], ['zip_recruiter', true, true, 'builtin', 'JobSpy 1.4.1'], ['google', true, true, 'builtin', 'JobSpy 1.4.1']]);
  assert.deepEqual(detected, [], 'opening Dayjob starts no Python');
  assert.deepEqual(boot.sites.filter(site => site.engine === 'native').map(site => [site.available, site.builtIn]), [[true, undefined], [true, undefined]]);

  // A search goes to that Python, and a failure to start it is not answered with "pip install".
  app.repo.saveSearch({ name: 'A', keywords: 'analyst', sites: ['glassdoor'] });
  await app.scheduler.runNow();
  assert.deepEqual(bridges, [{ command: path.join(dir, exe), builtIn: true }]);

  // "Save settings" asks for a real check, which starts it.
  const checked = await call('/api/sites?refresh=1');
  assert.deepEqual(detected, [path.join(dir, exe)]);
  assert.deepEqual(jobspySites(checked.body)[0], ['glassdoor', false, true, 'builtin', 'The JobSpy inside Dayjob did not start.']);
  assert.deepEqual(await app.jobspy(), { command: path.join(dir, exe), builtIn: true, available: false, version: null });

  // The user's own Python instead.
  assert.equal((await call('/api/settings', { method: 'PATCH', body: { jobspy: { runner: 'mine' } } })).status, 400);
  const own = await call('/api/settings', { method: 'PATCH', body: { jobspy: { runner: 'own', pythonCommand: 'my-python' } } });
  assert.deepEqual(own.body.jobspy, { runner: 'own', pythonCommand: 'my-python' });
  assert.deepEqual(jobspySites((await call('/api/sites')).body)[0], ['glassdoor', true, true, 'own', 'JobSpy 1.3.0']);
  assert.equal(detected.at(-1), 'my-python');
  await app.scheduler.runNow();
  assert.deepEqual(bridges.at(-1), { command: 'my-python', builtIn: false });
  await call('/api/settings', { method: 'PATCH', body: { jobspy: { runner: 'builtin' } } });
  assert.deepEqual(jobspySites((await call('/api/sites')).body)[0], ['glassdoor', true, true, 'builtin', 'JobSpy 1.4.1']);
});

test('closing Dayjob ends a JobSpy search that is still going, so its Python does not stay behind', async () => {
  let stopped = null;
  let asked;
  const waiting = new Promise(resolve => { asked = resolve; });
  // A board that never answers: only a stop ends it, as it ends the real Python process.
  const createBridge = () => ({ search: (site, input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { stopped = site; reject(signal.reason); }, { once: true });
    asked();
  }) });
  const { app, call } = await start({ jobspyDir: runtimeDir(), createBridge });
  assert.equal((await call('/api/searches', { method: 'POST', body: { name: 'Slow', keywords: 'analyst', sites: ['glassdoor'] } })).status, 201);
  assert.equal((await call('/api/runs', { method: 'POST' })).status, 202);
  await waiting;
  assert.equal(stopped, null);
  await app.close();
  assert.equal(stopped, 'glassdoor');
});

test('without a JobSpy inside (a run from the source folder), the user\'s Python is asked as before', async t => {
  const { app, boot, detected, bridges } = await start({ jobspyDir: runtimeDir({ python: false }) });
  t.after(() => app.close());
  const command = process.platform === 'win32' ? 'python' : 'python3';
  assert.deepEqual(detected, [command]);
  assert.deepEqual(jobspySites(boot.sites)[0], ['glassdoor', false, false, 'own', 'Needs Python with: pip install python-jobspy']);
  app.repo.saveSearch({ name: 'A', keywords: 'analyst', sites: ['google'] });
  await app.scheduler.runNow();
  assert.deepEqual(bridges, [{ command, builtIn: false }]);
  assert.deepEqual(settingsPatch({ jobspy: { runner: 'own' } }), { jobspy: { runner: 'own' } });
});

test('JobSpy is asked for its version in UTF-8 mode, and a Python that cannot start says which one it was', async () => {
  const seen = [];
  const child = code => { const made = new EventEmitter(); made.stdout = new EventEmitter(); made.stderr = new EventEmitter(); made.kill = () => {}; setImmediate(() => { made.stdout.emit('data', '1.4.1\r\n'); made.emit('close', code); }); return made; };
  assert.deepEqual(await detectJobspy('C:\\Dayjob\\resources\\jobspy\\python.exe', (command, args) => { seen.push([command, ...args]); return child(0); }), { available: true, version: '1.4.1' });
  assert.deepEqual(seen, [['C:\\Dayjob\\resources\\jobspy\\python.exe', '-X', 'utf8', '-m', 'jobspy', '--version']]);
  assert.deepEqual(await detectJobspy('python', () => child(1)), { available: false, version: null });

  const failing = () => { const made = new EventEmitter(); made.stdout = new EventEmitter(); made.stderr = new EventEmitter(); made.kill = () => {}; setImmediate(() => made.emit('error', new Error('spawn ENOENT'))); return made; };
  await assert.rejects(createJobspyBridge({ command: 'x', builtIn: true, spawn: failing }).search('google', { keywords: 'a' }),
    { message: 'The JobSpy inside Dayjob did not start (spawn ENOENT). Installing Dayjob again puts it back.' });
  await assert.rejects(createJobspyBridge({ command: 'python', spawn: failing }).search('google', { keywords: 'a' }),
    { message: 'JobSpy is not available (spawn ENOENT). Install Python and run: pip install python-jobspy' });
});

// What happened on the PC this was written for: "python" was a Python 3.12 without JobSpy, while JobSpy sat in Python 3.14.
test('a Python without JobSpy, and a site that turns JobSpy away, are told apart from a JobSpy that is broken', async t => {
  const answering = (code, stderr, stdout = '') => () => {
    const made = new EventEmitter(); made.stdout = new EventEmitter(); made.stderr = new EventEmitter(); made.kill = () => {};
    setImmediate(() => { if (stdout) made.stdout.emit('data', stdout); if (stderr) made.stderr.emit('data', stderr); made.emit('close', code); });
    return made;
  };
  const noModule = 'C:\\Tools\\python.exe: No module named jobspy\r\n';
  assert.deepEqual(await detectJobspy('python', answering(1, noModule)), { available: false, version: null, reason: 'C:\\Tools\\python.exe: No module named jobspy' });
  assert.deepEqual(await detectJobspy('python', answering(1, '')), { available: false, version: null });

  const search = (stderr, options = {}) => createJobspyBridge({ command: 'python', spawn: answering(1, stderr), ...options }).search('zip_recruiter', { keywords: 'a' });
  await assert.rejects(search(noModule), /: The Python that Dayjob runs has no JobSpy in it \(C:\\Tools\\python\.exe: No module named jobspy\)\. Run: python -m pip install python-jobspy, or name the Python that has JobSpy under Settings, JobSpy\.$/);
  await assert.rejects(search('INFO: jobspy.ziprecruiter: page 1\nERROR: jobspy.ziprecruiter: no jobKeysMap in the page\n'),
    /: JobSpy got no jobs from ZipRecruiter \(no jobKeysMap in the page\)\. The site turned the request away or changed its pages; the other sources are not affected\.$/);
  await assert.rejects(search('Traceback (most recent call last):\nValueError: boom\n'), /: JobSpy zip_recruiter failed: ValueError: boom$/);
  assert.equal(searchFailure('google', '', 3, () => 'unused'), 'JobSpy google failed: exit 3');
  // A site that gave some jobs before it gave up is a result with a warning, not a failure.
  const partly = await createJobspyBridge({ command: 'python', spawn: answering(1, 'ERROR: jobspy.google: no job data returned\n', '{"site":"google","title":"Analyst","company":"Acme","job_url":"https://example.com/1"}\n') }).search('google', { keywords: 'a' });
  assert.equal(partly.postings.length, 1);
  assert.deepEqual(partly.warnings, ['ERROR: jobspy.google: no job data returned']);

  // Settings is told which Python was asked and what it answered.
  const { app, boot } = await start({ detectJobspy: async () => ({ available: false, version: null, reason: 'C:\\Tools\\python.exe: No module named jobspy' }) });
  t.after(() => app.close());
  const site = boot.sites.find(entry => entry.id === 'glassdoor');
  assert.deepEqual([site.available, site.using, site.reason, site.command], [false, 'own', 'C:\\Tools\\python.exe: No module named jobspy', process.platform === 'win32' ? 'python' : 'python3']);
});

test('what goes into the JobSpy folder: Python without its extras, exact packages, and nothing from outside', () => {
  for (const kept of ['python.exe', 'python312.dll', 'DLLs/_ssl.pyd', 'Lib/json/__init__.py', 'Lib/unittest/mock.py', 'Lib/site-packages/pip/__init__.py', 'LICENSE.txt']) assert.equal(wantedFromPython(kept), true, kept);
  for (const left of ['include/Python.h', 'libs/python312.lib', 'Lib/test/test_os.py', 'Lib/idlelib/idle.py', 'Lib/tkinter/__init__.py', 'Lib/venv/__init__.py', 'Lib/ensurepip/__init__.py']) assert.equal(wantedFromPython(left), false, left);
  for (const gone of ['pip', 'pip/__init__.py', 'pip-25.0.1.dist-info', 'bin', 'bin/f2py.exe', 'pandas/tests', 'numpy/_core/tests/test_x.py', 'numpy/__init__.pyi', 'jobspy/__pycache__', 'jobspy/__pycache__/model.cpython-312.pyc']) {
    assert.equal(dropped(gone), true, gone);
  }
  for (const stays of ['jobspy/__main__.py', 'pandas/_testing/__init__.py', 'numpy/testing/__init__.py', 'pandas/testing.py', 'python_jobspy-1.4.1.dist-info', 'python_jobspy-1.4.1.dist-info/METADATA', 'pipes.py',
    'curl_cffi.libs/libcurl.dll', 'tzdata/zoneinfo/Asia/Shanghai']) {
    assert.equal(dropped(stays), false, stays);
  }
  assert.equal(pathFile(), 'Lib\r\nLib\\site-packages\r\nDLLs\r\n');
  assert.match(PYTHON.url, /^https:\/\/api\.nuget\.org\/v3-flatcontainer\/python\/3\.12\.10\/python\.3\.12\.10\.nupkg$/);
  assert.match(PYTHON.sha256, /^[0-9a-f]{64}$/);

  // Every package is pinned to one version and one file.
  const lock = fs.readFileSync(new URL('../scripts/jobspy-requirements.txt', import.meta.url), 'utf8').replace(/\\\r?\n\s*/g, ' ');
  const entries = lock.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  assert.ok(entries.length >= 20);
  for (const entry of entries) assert.match(entry, /^[a-z0-9-]+==[\w.]+ +--hash=sha256:[0-9a-f]{64}$/, entry);
  assert.ok(entries.some(entry => entry.startsWith(`python-jobspy==${JOBSPY} `)), 'the lock installs the JobSpy the build says it carries');
});
