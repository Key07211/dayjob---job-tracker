const { app, BrowserWindow, Menu, Tray, Notification, nativeImage, dialog, shell, ipcMain, session, desktopCapturer, safeStorage, powerMonitor } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createClaudeConnection } = require('./claude-connection.cjs');
const { createBrowser } = require('./browser.cjs');
const { createVault, readPasswordCsv, VaultError } = require('./vault.cjs');
const { createUpdater } = require('./updater.cjs');
const { freeInstallFolder } = require('./install-lock.cjs');
const nowPlaying = require('./now-playing.cjs');

app.setName('Dayjob');
app.setAppUserModelId('com.dayjob.tracker');
const smokeArg = process.argv.indexOf('--smoke-test');
const smokeOutput = smokeArg >= 0 ? process.argv[smokeArg + 1] : null;
if (smokeArg >= 0 && (!smokeOutput || !path.isAbsolute(smokeOutput))) {
  console.error('--smoke-test requires an absolute JSON output path.');
  app.exit(1);
}
const smoke = Boolean(smokeOutput);
const profileDir = smoke ? path.join(path.dirname(smokeOutput), 'dayjob-smoke-profile') : path.join(app.getPath('appData'), 'Dayjob');
app.setPath('userData', profileDir);
const dataDir = path.join(profileDir, 'data');
const parsedPort = Number(process.env.DAYJOB_PORT || 4318);
const port = Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535 ? parsedPort : 4318;
const icon = path.join(__dirname, 'assets', 'icon.png');
// On Windows the window and the tray take the .ico, which has a plainer drawing (no record grooves, a bolder note) for the small sizes.
const windowIcon = process.platform === 'win32' ? path.join(__dirname, 'assets', 'icon.ico') : icon;
// What the updater did (update.log), and what happened to the window and to quitting (app.log), so a failed update
// or a Dayjob that would not open can be looked into afterwards.
function writeLog(name, message) {
  const file = path.join(profileDir, 'logs', name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > 512 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch { /* logging never stops Dayjob */ }
}
const logUpdate = message => writeLog('update.log', String(message).replace(/^\[dayjob\] update: /, ''));
const logApp = message => writeLog('app.log', message);
// How long quitting may wait for the local service, and then for the quit itself, before Dayjob ends anyway.
const QUIT_WAIT_MS = 5000;
let service;
let window;
let tray;
let origin;
let claude;
let browser;
let vault;
// The password file last imported, kept here (never in the interface) so that it can be moved to the Recycle Bin.
let importedFile = null;
let updates;
let music;
let quitting = false;
// How many system sound requests got past the permission check, for the smoke test.
let soundRequests = 0;
let shutdownStarted = false;
let language = null;
// Renderer errors during a smoke test, so a failed check says what broke.
const smokeLog = [];

// Desktop copy follows the interface language (a Dayjob setting); before the
// service starts, the system language decides.
const TEXT = {
  zh: { title: 'Dayjob · 求职追踪', tooltip: 'Dayjob · 每日岗位抓取与投递追踪', open: '打开 Dayjob', run: '立即抓取新岗位', data: '打开数据文件夹', quit: '退出 Dayjob',
    portable: '请先安装 Dayjob，再添加稳定的 Claude MCP 连接。', cannotStart: 'Dayjob 无法启动',
    portInUse: port => `本地端口 ${port} 已被占用。请先关闭已运行的 Dayjob（npm start）或占用该端口的程序，然后重新打开。`, failed: message => `Dayjob 启动失败：${message}`,
    approval: ({ action, name, site }) => ({ title: 'Claude 请你确认一下', body: action === 'enter' ? `在 ${site} 的“${name}”里按回车` : `在 ${site} 上点击“${name}”` }),
    browser: { openTab: '在新标签页打开链接', openExternal: '用系统浏览器打开链接', copyLink: '复制链接地址', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选', back: '后退', forward: '前进', reload: '重新加载' } },
  en: { title: 'Dayjob · Job tracker', tooltip: 'Dayjob · daily job search and application tracking', open: 'Open Dayjob', run: 'Search for new jobs now', data: 'Open data folder', quit: 'Quit Dayjob',
    portable: 'Install Dayjob before adding a lasting Claude MCP connection.', cannotStart: 'Dayjob cannot start',
    portInUse: port => `Local port ${port} is in use. Close the Dayjob already running (npm start) or the program using that port, then open Dayjob again.`, failed: message => `Dayjob failed to start: ${message}`,
    approval: ({ action, name, site }) => ({ title: 'Claude is asking first', body: action === 'enter' ? `Press Enter in “${name}” on ${site}` : `Click “${name}” on ${site}` }),
    browser: { openTab: 'Open link in new tab', openExternal: 'Open link in your browser', copyLink: 'Copy link address', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all', back: 'Back', forward: 'Forward', reload: 'Reload' } },
};
const text = () => TEXT[language || (app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en')];

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// Links in Dayjob's own pages open in the user's browser; the Dayjob browser
// (browser.cjs) has separate tabs that never load Dayjob itself.
function externalLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.origin !== origin;
  } catch { return false; }
}
const localUrl = value => { try { return new URL(value).origin === origin; } catch { return false; } };

function verifiedSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !localUrl(event.senderFrame.url)) {
    throw new Error('This desktop action is available only inside Dayjob.');
  }
}

function desktopNotification(item) {
  if (smoke || !Notification.isSupported()) return;
  const toast = new Notification({ title: item.title, body: item.body, icon, silent: false });
  toast.on('click', showWindow);
  toast.show();
}

function setupIpc() {
  ipcMain.handle('dayjob:get-info', event => {
    verifiedSender(event);
    return { version: app.getVersion(), dataPath: dataDir, isPackaged: app.isPackaged, portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR) };
  });
  ipcMain.handle('dayjob:open-data-folder', async event => {
    verifiedSender(event);
    const error = await shell.openPath(dataDir);
    if (error) throw new Error(error);
  });
  ipcMain.handle('dayjob:claude-status', event => { verifiedSender(event); return claude.getStatus(); });
  ipcMain.handle('dayjob:check-claude', event => { verifiedSender(event); return claude.check(); });
  ipcMain.handle('dayjob:connect-claude', event => {
    verifiedSender(event);
    if (process.env.PORTABLE_EXECUTABLE_DIR) throw new Error(text().portable);
    return claude.ensure();
  });
  const handle = (channel, work) => ipcMain.handle(channel, (event, ...args) => { verifiedSender(event); return work(...args); });
  handle('dayjob:browser-state', () => browser.state());
  handle('dayjob:browser-bounds', rect => browser.setBounds(rect));
  handle('dayjob:browser-open', url => browser.show(String(url)));
  handle('dayjob:browser-go', url => browser.go(String(url)));
  handle('dayjob:browser-command', (name, id) => browser.command(String(name), typeof id === 'string' ? id : undefined));
  handle('dayjob:browser-answer', (id, allowed) => browser.answer(String(id), allowed === true));
  handle('dayjob:browser-agent-control', value => browser.setAgentControl(value === true));
  handle('dayjob:browser-auto-submit', value => browser.setAutoSubmit(value === true));
  handle('dayjob:browser-autofill', options => browser.autofill({ submit: options?.submit === true, resume: options?.resume }));
  handle('dayjob:browser-resume-for', choice => browser.resumeFor(choice));
  handle('dayjob:browser-upload-resume', choice => browser.uploadResume(choice));
  handle('dayjob:browser-extract', () => browser.extract());
  handle('dayjob:browser-clear', () => browser.clearData());
  handle('dayjob:browser-login-fill', id => browser.fillLogin(String(id)));
  handle('dayjob:browser-login-offer', answer => browser.answerOffer(answer && typeof answer === 'object'
    ? { keep: answer.keep === true, username: String(answer.username ?? ''), unlock: String(answer.unlock ?? '') } : answer === true));
  handle('dayjob:browser-login-retry', () => browser.retryLogin());
  handle('dayjob:browser-login-dismiss', () => browser.dismissLogin());
  handle('dayjob:browser-auto-login', value => browser.setAutoLogin(value === true));
  handle('dayjob:browser-auto-track', value => browser.setAutoTrack(value === true));
  handle('dayjob:browser-applied-answer', answer => browser.answerApplied(answer && typeof answer === 'object'
    ? { title: String(answer.title ?? ''), company: String(answer.company ?? '') } : null));
  // The password vault: the interface sends passwords in (to keep, or the vault's own to open it), and gets them
  // back only from the open vault, when the user asks Settings to show them.
  const vaultChanged = result => { browser.refreshLogin(); if (window && !window.isDestroyed()) window.webContents.send('dayjob:vault-changed'); return result; };
  handle('dayjob:vault-list', () => vault.list());
  handle('dayjob:vault-save', entry => vaultChanged(vault.save(entry && typeof entry === 'object' ? entry : {})));
  handle('dayjob:vault-delete', id => { vault.remove(String(id)); return vaultChanged(vault.list()); });
  handle('dayjob:vault-clear', () => vaultChanged(vault.clear()));
  handle('dayjob:vault-reveal', () => vault.reveal());
  handle('dayjob:vault-unlock', async password => vaultChanged(await vault.unlock(String(password ?? ''))));
  handle('dayjob:vault-close', () => vaultChanged(vault.close()));
  handle('dayjob:vault-set-lock', async input => vaultChanged(await vault.setLock({ current: String(input?.current ?? ''), next: String(input?.next ?? '') })));
  handle('dayjob:vault-remove-lock', async current => vaultChanged(await vault.removeLock(String(current ?? ''))));
  handle('dayjob:vault-reset', () => vaultChanged(vault.reset()));
  // A browser's password export, chosen here and read here: the interface gets the counts and the file's name.
  handle('dayjob:vault-import', async () => {
    if (vault.locked()) throw new VaultError('Open the password vault with its password first.');
    const zh = text() === TEXT.zh;
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: zh ? '选择浏览器导出的密码文件（CSV）' : 'Choose the passwords file your browser exported (CSV)',
      filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'] });
    if (canceled || !filePaths[0]) return null;
    const result = importPasswords(filePaths[0]);
    importedFile = filePaths[0];
    return vaultChanged(result);
  });
  // The export holds every password in plain text, so after importing it can go to the Recycle Bin (and back).
  handle('dayjob:vault-trash-import', async () => {
    if (!importedFile) return false;
    await shell.trashItem(importedFile);
    importedFile = null;
    return true;
  });
  handle('dayjob:update-state', () => updates.state());
  handle('dayjob:update-check', () => updates.check());
  handle('dayjob:update-download', () => updates.download());
  handle('dayjob:update-install', () => updates.install());
  handle('dayjob:music-follow', value => music.setFollow(value === true));
  handle('dayjob:music-state', () => music.current());
}

// Reads a password export (UTF-8, or UTF-16 from some tools) into the vault.
function importPasswords(file) {
  if (fs.statSync(file).size > 10 * 1024 * 1024) throw new VaultError('That file is too big to be a password export.');
  const data = fs.readFileSync(file);
  const content = data[0] === 0xff && data[1] === 0xfe ? data.toString('utf16le') : data.toString('utf8');
  const rows = readPasswordCsv(content);
  return { ...vault.importMany(rows), rows: rows.length, file: path.basename(file) };
}

function buildTray() {
  if (!tray || tray.isDestroyed()) return;
  const copy = text();
  tray.setToolTip(copy.tooltip);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: copy.open, click: showWindow },
    { label: copy.run, click: () => service?.scheduler.runNow().catch(console.error) },
    { label: copy.data, click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: copy.quit, click: () => app.quit() },
  ]));
}

function setLanguage(next) {
  if (!TEXT[next] || next === language) return;
  language = next;
  buildTray();
}

async function createWindow() {
  const image = nativeImage.createFromPath(windowIcon);
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640,
    title: text().title, backgroundColor: '#F4F8FB', icon: image,
    show: false, paintWhenInitiallyHidden: smoke, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      backgroundThrottling: !smoke, devTools: !app.isPackaged,
    },
  });
  window.removeMenu();
  if (smoke) {
    window.webContents.on('console-message', event => {
      if (event.level === 'error' && smokeLog.length < 20) smokeLog.push(`${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    window.webContents.on('render-process-gone', (_event, details) => smokeLog.push(`renderer gone: ${details.reason}`));
  }
  // A page that crashed is loaded again (at most once a minute), so the window never stays blank.
  let reloadedAt = 0;
  window.webContents.on('render-process-gone', (_event, details) => {
    logApp(`page gone: ${details.reason} (exit code ${details.exitCode})`);
    if (quitting || window.isDestroyed() || Date.now() - reloadedAt < 60000) return;
    reloadedAt = Date.now();
    window.webContents.reload();
  });
  window.on('unresponsive', () => logApp('window not responding'));
  window.on('responsive', () => logApp('window responding again'));
  window.on('closed', () => logApp(quitting ? 'window closed to quit' : 'window closed while Dayjob kept running'));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (externalLink(url)) shell.openExternal(url).catch(console.error);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!localUrl(url)) {
      event.preventDefault();
      if (externalLink(url)) shell.openExternal(url).catch(console.error);
    }
  });
  window.webContents.on('will-redirect', (event, url) => { if (!localUrl(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // Closing the window keeps Dayjob in the tray for the daily search, unless
  // the user turned that off in Settings; then it quits.
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (!shutdownStarted && tray && service.repo.getSettings().desktop.closeToTray) window.hide();
    else app.quit();
  });

  // Run from source on Linux with no keyring, there would be no vault to try out: Electron's built-in key stands in.
  // It changes nothing on Windows and macOS, and an installed Dayjob never asks for it.
  if (!app.isPackaged && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
  vault = createVault({ file: path.join(profileDir, 'vault.json'), safeStorage });
  browser = createBrowser({ window, appOrigin: origin, settingsFile: path.join(profileDir, 'browser.json'), copy: () => text().browser,
    getProfile: () => service.repo.getSettings().applicant, vault,
    resumes: { pick: input => service.repo.pickResumeFile(input), file: id => service.repo.getResumeFile(id) },
    track: { applied: input => service.trackApplied(input) },
    onApproval: request => desktopNotification(text().approval(request)), devTools: !app.isPackaged });
  // A vault with its own password closes again when the computer locks or goes to sleep.
  const closeVault = () => {
    if (!vault.locked() && vault.list().lock) { vault.close(); browser.refreshLogin(); if (!window.isDestroyed()) window.webContents.send('dayjob:vault-changed'); }
  };
  powerMonitor.on('lock-screen', closeVault);
  powerMonitor.on('suspend', closeVault);

  tray = new Tray(process.platform === 'win32' ? windowIcon : image.resize({ width: 32, height: 32 }));
  buildTray();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  await window.loadURL(origin);
  // The window's own colour shows for an instant before the page's first frame, so it takes the page's ground: a
  // night window then opens dark at once (the page has picked its theme by now, in public/theme-init.js).
  try {
    const night = await Promise.race([
      window.webContents.executeJavaScript("document.documentElement.dataset.theme === 'night'"),
      new Promise(resolve => setTimeout(() => resolve(false), 500)),
    ]);
    if (night && !window.isDestroyed()) window.setBackgroundColor('#23201C');
  } catch { /* the day ground stays */ }
  if (!smoke && !process.argv.includes('--hidden')) showWindow();
}

// A job page with an application form, served on this computer and driven
// through the same local API Claude uses.
const SMOKE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Data Analyst · Smoke Co</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Data Analyst","datePosted":"2026-10-20",
"hiringOrganization":{"@type":"Organization","name":"Smoke Co"},"employmentType":"FULL_TIME",
"jobLocation":{"@type":"Place","address":{"addressLocality":"Berkeley","addressRegion":"CA","addressCountry":"US"}},
"description":"&lt;p&gt;Analyse data with SQL.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Dashboards&lt;/li&gt;&lt;/ul&gt;"}</script></head>
<body><h1>Data Analyst</h1><p>Analyse data with SQL.</p><form action="/submitted" method="get">
<label>Full name <input name="name" required></label> <label>Email <input name="email" type="email"></label> <label>Phone <input name="phone"></label>
<label for="source">How did you hear about us?</label> <select id="source" name="source"><option>LinkedIn</option><option>Referral</option></select>
<button>Submit application</button></form></body></html>`;

// An application form with part of it embedded from another site (another
// port is another origin), for autofill.
const APPLY_PAGE = embedPort => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Apply · Smoke Co</title></head>
<body><h1>Apply for Data Analyst</h1><form action="/applied" method="get">
<label>First name <input name="first" required></label> <label>Last name <input name="last"></label> <label>Email <input name="email" type="email"></label>
<label>Are you legally authorized to work in the United States?</label> <select name="auth"><option value="">Select…</option><option>Yes</option><option>No</option></select>
<button>Submit application</button></form><iframe src="http://127.0.0.1:${embedPort}/embed" width="500" height="200"></iframe></body></html>`;
const EMBED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embedded form</title></head>
<body><label>Phone <input name="phone" type="tel"></label> <label>LinkedIn profile <input name="linkedin" required></label> <label>Desired salary <input name="salary"></label></body></html>`;

// An application form that takes files: a cover letter on the page, and the resume inside the form embedded from
// another site, in a field hidden behind a button (as most application forms have it). The embedded page writes
// down what it was handed.
const UPLOAD_PAGE = embedPort => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Upload · Smoke Co</title></head>
<body><h1>Apply for Data Analyst</h1><form action="/applied" method="get"><label>First name <input name="first"></label>
<div><label for="cover">Cover letter</label> <input id="cover" name="cover_letter" type="file"></div></form>
<iframe src="http://127.0.0.1:${embedPort}/embed-upload" width="500" height="200"></iframe></body></html>`;
const EMBED_UPLOAD_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embedded upload</title></head>
<body><div><div>Resume/CV *</div><button type="button" onclick="document.getElementById('file').click()">Attach</button>
<input id="file" name="resume" type="file" accept=".pdf,.docx,.txt" style="display:none"><p id="got"></p></div>
<script>document.getElementById('file').addEventListener('change', async event => { const file = event.target.files[0];
document.getElementById('got').textContent = file ? file.name + '|' + file.size + '|' + (await file.text()).slice(0, 24) : 'none'; });</script></body></html>`;

// Questions with choices, drawn the ways application forms draw them: the real radio button see-through and stretched
// over its own label; shrunk to a dot beside a label that stands in for it; lying under a picture of itself; and a
// checkbox under its label. Then two ordinary fields that carry a hint meant for passwords and codes (sites put it
// there to keep the browser's own autofill away), and a real box for a code.
const CHOICE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Questions · Smoke Co</title><style>
fieldset{border:0;margin:14px 0;padding:0}.opt{position:relative;display:block;width:260px;padding:10px 14px;margin:6px 0;border:1px solid #888;border-radius:8px}
.opt input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0}.dot{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.pill{display:inline-block;padding:8px 14px;margin:4px 0;border:1px solid #888;border-radius:20px}.under{position:relative;width:260px;height:38px;margin:6px 0}
.under input{position:absolute;left:8px;top:10px}.under .face{position:absolute;inset:0;z-index:2;padding:8px 14px;background:#fff;border:1px solid #888;border-radius:8px}</style></head>
<body><h1>Application questions</h1><form action="/answered" method="get">
<fieldset><legend>Will you now or in the future require sponsorship for employment visa status?</legend>
<label class="opt"><input type="radio" name="sponsor" value="yes"><span>Yes</span></label><label class="opt"><input type="radio" name="sponsor" value="no"><span>No</span></label></fieldset>
<fieldset><legend>Veteran status</legend>
<input class="dot" type="radio" name="veteran" value="is" id="vet-is"><label class="pill" for="vet-is">I am a protected veteran</label><br>
<input class="dot" type="radio" name="veteran" value="not" id="vet-not"><label class="pill" for="vet-not">I am not a protected veteran</label></fieldset>
<fieldset><legend>Gender</legend><div class="under"><input type="radio" name="gender" value="decline" aria-label="Decline to self-identify"><div class="face">Decline to self-identify</div></div></fieldset>
<label class="opt"><input type="checkbox" name="certify" value="yes"><span>I certify that my answers are true</span></label>
<p><label>LinkedIn profile <input name="linkedin" type="text" autocomplete="one-time-code"></label></p>
<p><label>Preferred first name <input name="preferred" type="text" autocomplete="new-password"></label></p>
<p><label>Verification code <input name="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label></p>
<button type="button">Save answers</button></form></body></html>`;

// A second job at the same company, and an application form that never says which job or company it is for.
const SECOND_JOB_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Research Analyst · Smoke Co</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Research Analyst","hiringOrganization":{"@type":"Organization","name":"Smoke Co"},
"description":"Read the market and write it up."}</script></head><body><h1>Research Analyst</h1><p>Read the market and write it up.</p><a href="/apply">Apply for this job</a></body></html>`;
const QUIET_APPLY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Application</title></head>
<body><h1>Your application</h1><form action="/applied" method="get"><label>First name <input name="first" required></label>
<label>Email <input name="email" type="email"></label> <label>Phone <input name="phone"></label> <button>Submit application</button></form></body></html>`;

// A login form and a sign-up form, for the password vault. Signing in posts,
// so the password never shows in an address.
const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in · Smoke Co</title></head>
<body><h1>Sign in</h1><form action="/signed-in" method="post"><label>Email <input name="email" type="email" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label> <button>Sign in</button></form></body></html>`;
const SIGNUP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Create account · Smoke Co</title></head>
<body><h1>Create account</h1><form action="/signed-in" method="post"><label>Email <input name="email" type="email"></label>
<label>Password <input name="password" type="password"></label> <label>Confirm password <input name="confirm" type="password"></label> <button>Create account</button></form></body></html>`;
// A two-step sign-in: the user name on one page, the password on the next.
const STEP_ONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in · Smoke Co</title></head>
<body><h1>Sign in</h1><form action="/login-step2" method="get"><label>Email <input name="email" type="email" autocomplete="username"></label> <button>Next</button></form></body></html>`;
const STEP_TWO_PAGE = email => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Enter password · Smoke Co</title></head>
<body><h1>Welcome back, ${email}</h1><form action="/signed-in" method="post"><input type="hidden" name="email" value="${email}">
<label>Password <input name="password" type="password" autocomplete="current-password"></label> <button>Sign in</button></form></body></html>`;

async function until(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function smokeBrowser(token) {
  const escape = value => String(value ?? '').replace(/[<>&"]/g, character => `&#${character.charCodeAt(0)};`);
  const embed = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url.startsWith('/embed-upload') ? EMBED_UPLOAD_PAGE : EMBED_PAGE);
  });
  await new Promise(resolve => embed.listen(0, '127.0.0.1', resolve));
  const site = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const form = new URLSearchParams(body);
        response.end(`<!doctype html><title>Signed in</title><h1>Signed in as ${escape(form.get('email'))}</h1><p>${(form.get('password') || '').length}-character password</p>`);
      });
      return undefined;
    }
    if (url.pathname === '/login') return response.end(LOGIN_PAGE);
    if (url.pathname === '/signup') return response.end(SIGNUP_PAGE);
    if (url.pathname === '/login-step1') return response.end(STEP_ONE_PAGE);
    if (url.pathname === '/login-step2') return response.end(STEP_TWO_PAGE(escape(url.searchParams.get('email'))));
    if (url.pathname === '/apply') return response.end(APPLY_PAGE(embed.address().port));
    if (url.pathname === '/choices') return response.end(CHOICE_PAGE);
    if (url.pathname === '/jobs/9') return response.end(SECOND_JOB_PAGE);
    if (url.pathname === '/quiet-apply') return response.end(QUIET_APPLY_PAGE);
    if (url.pathname === '/upload') return response.end(UPLOAD_PAGE(embed.address().port));
    if (url.pathname === '/applied') return response.end(`<!doctype html><title>Applied</title><h1>Thank you for applying, ${escape(url.searchParams.get('first'))}</h1>`);
    return response.end(url.pathname === '/submitted'
      ? `<!doctype html><title>Submitted</title><h1>Thanks ${escape(url.searchParams.get('name'))}</h1><p>Source: ${escape(url.searchParams.get('source'))}</p>`
      : SMOKE_PAGE);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const post = (action, body = {}) => fetch(`${origin}/api/browser/${action}`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Dayjob-Token': token, 'X-Dayjob-Client': 'mcp' } });
  const call = async (action, body) => {
    const response = await post(action, body);
    const value = await response.json();
    if (!response.ok) throw new Error(`${action}: ${value.error}`);
    return value;
  };
  const steps = {};
  try {
    steps.refusesDayjob = (await post('open', { url: `${origin}/` })).status === 400;
    steps.opened = (await call('open', { url: `${base}/jobs/7` })).page.title === 'Data Analyst · Smoke Co';
    const page = await call('read');
    const ref = name => page.elements.find(item => item.name === name)?.ref;
    steps.jobPosting = page.jobPosting?.title === 'Data Analyst' && page.jobPosting.company === 'Smoke Co' && page.jobPosting.description.includes('• Dashboards');
    steps.typed = (await call('type', { ref: ref('Full name'), text: 'Smoke Test' })).typed.value === 'Smoke Test'
      && (await call('type', { ref: ref('Email'), text: 'smoke@example.com' })).typed.value === 'smoke@example.com';
    steps.selected = (await call('select', { ref: ref('How did you hear about us?'), option: 'referral' })).selected.value === 'Referral';
    // Submitting waits for the user; answer in the banner as a user would.
    const submitting = call('click', { ref: ref('Submit application') });
    steps.askedFirst = await until(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.browser-approval'))"), 10000);
    if (steps.askedFirst) await window.webContents.executeJavaScript("document.querySelector('.browser-approval .button.primary').click()");
    await submitting;
    const after = await call('read');
    steps.submitted = after.page.url.startsWith(`${base}/submitted?name=Smoke+Test`) && after.text.includes('Thanks Smoke Test') && after.text.includes('Referral');
    const shot = await call('screenshot');
    steps.screenshot = shot.image.length > 1000;
    fs.writeFileSync(smokeOutput.replace(/\.json$/i, '') + '-browser.jpg', Buffer.from(shot.image, 'base64'));

    // 自动填写 fills the page and the embedded form from the application profile;
    // with auto-submit on it sends the form, and Claude's submit click goes ahead
    // without asking.
    service.repo.updateSettings({ applicant: { firstName: 'Smoke', lastName: 'Tester', email: 'smoke@example.com', phone: '+1 510 555 0100',
      linkedin: 'https://www.linkedin.com/in/smoke', workAuthorized: 'yes' } });
    await call('open', { url: `${base}/apply` });
    const filled = await browser.autofill({ submit: true });
    steps.autofillKeys = filled.filled.map(item => item.key).sort().join(',');
    const form = await call('read');
    const valueOf = name => form.elements.find(item => item.name === name)?.value;
    steps.autofilled = steps.autofillKeys === 'email,firstName,lastName,linkedin,phone,workAuthorized' && !filled.left.length && filled.optionalLeft === 1
      && !filled.submitted && valueOf('First name') === 'Smoke' && valueOf('Email') === 'smoke@example.com';
    steps.autofillRepeat = (await browser.autofill({})).filled.length === 0;
    browser.setAutoSubmit(true);
    const sent = await browser.autofill({ submit: true });
    steps.autoSubmitted = sent.submitted && sent.confirmed && sent.page.url.startsWith(`${base}/applied?first=Smoke&last=Tester&email=smoke%40example.com&auth=Yes`);
    // 自动收录: the page said the application went through, so Dayjob tracks it by itself, for the job whose page
    // this tab came from (a posting made from what that page said, since Dayjob had none), and says so in the window.
    const tracked = () => service.repo.listApplications();
    const fromPage = service.repo.getApplication(sent.recorded?.applicationId || '');
    steps.autoRecorded = sent.recorded?.title === 'Data Analyst' && sent.recorded.company === 'Smoke Co' && tracked().length === 1
      && fromPage?.events?.[0]?.source === 'auto' && fromPage.jobUrl === `${base}/jobs/7`
      && browser.state().applied?.state === 'recorded' && browser.state().applied.applicationId === fromPage.id && browser.state().applied.by === 'user';
    steps.autoRecordedShown = await until(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.browser-applied'))"), 5000);
    await browser.answerApplied(null);
    // An application the user sends by hand is recorded the same way. Another job's page was opened in the tab
    // since, so it is that job, and the form (which names the company) bears it out.
    const tabPage = () => window.contentView.children.find(child => child.webContents?.getURL().startsWith(base))?.webContents;
    const sendByHand = first => tabPage().executeJavaScript(`document.querySelector('[name="first"]').value = ${JSON.stringify(first)}; document.querySelector('form').requestSubmit(); true`);
    await call('open', { url: `${base}/jobs/9` });
    await call('open', { url: `${base}/apply` });
    await sendByHand('Hand');
    steps.userRecorded = await until(() => browser.state().applied?.state === 'recorded', 8000) && browser.state().applied.title === 'Research Analyst'
      && browser.state().applied.by === 'user' && tracked().length === 2;
    await browser.answerApplied(null);
    // A form that names neither the job nor the company: Dayjob will not guess from the pages before it. It asks,
    // offering the last job page as a start, and records what the user answers as a job of its own.
    await call('open', { url: `${base}/quiet-apply` });
    await sendByHand('Quiet');
    steps.askedWhichJob = await until(() => browser.state().applied?.state === 'ask', 8000) && browser.state().applied.title === 'Research Analyst' && tracked().length === 2;
    await browser.answerApplied({ title: 'Field Analyst', company: 'Quiet Co' });
    const namedJob = tracked().find(item => item.title === 'Field Analyst');
    steps.namedRecorded = browser.state().applied?.state === 'recorded' && tracked().length === 3 && namedJob?.company === 'Quiet Co' && namedJob.jobUrl === `${base}/quiet-apply`;
    await browser.answerApplied(null);
    // Sending the same job's form again records nothing new; switched off, nothing is recorded at all.
    steps.autoTrackSwitch = browser.setAutoTrack(false).autoTrack === false && JSON.parse(fs.readFileSync(path.join(profileDir, 'browser.json'), 'utf8')).autoTrack === false
      && browser.setAutoTrack(true).autoTrack === true;
    for (const item of tracked()) service.repo.deleteApplication(item.id);

    // 选择题: Claude's click answers a radio button or a checkbox however the page draws it, and says how it stands
    // after; a field is refused only when it really is for a password or a code.
    await call('open', { url: `${base}/choices` });
    const questions = await call('read');
    const option = (role, name) => questions.elements.find(item => item.role === role && item.name === name)?.ref;
    const answer = () => tabPage().executeJavaScript("new URLSearchParams(new FormData(document.querySelector('form'))).toString()");
    const yes = await call('click', { ref: option('radio', 'Yes') });
    const no = await call('click', { ref: option('radio', 'No') });
    steps.choiceUnderLabel = yes.clicked.checked === true && no.clicked.checked === true && (await answer()).includes('sponsor=no');
    steps.choiceBesideLabel = (await call('click', { ref: option('radio', 'I am not a protected veteran') })).clicked.checked === true && (await answer()).includes('veteran=not');
    steps.choiceCovered = (await call('click', { ref: option('radio', 'Decline to self-identify') })).clicked.checked === true && (await answer()).includes('gender=decline');
    const certify = option('checkbox', 'I certify that my answers are true');
    steps.choiceCheckbox = (await call('click', { ref: certify })).clicked.checked === true && (await answer()).includes('certify=yes')
      && (await call('click', { ref: certify })).clicked.checked === false && !(await answer()).includes('certify');
    // Reading the page tells an option's state and the question it answers ("No" alone says nothing).
    const chosen = (await call('read')).elements.find(item => item.name === 'No' && item.role === 'radio');
    steps.choiceRead = chosen?.checked === true && /require sponsorship/.test(chosen.group || '');
    steps.plainFieldTyped = (await call('type', { ref: option('textbox', 'LinkedIn profile'), text: 'https://www.linkedin.com/in/smoke' })).typed.value === 'https://www.linkedin.com/in/smoke'
      && (await call('type', { ref: option('textbox', 'Preferred first name'), text: 'Smokey' })).typed.value === 'Smokey';
    const refusedCode = await post('type', { ref: option('textbox', 'Verification code'), text: '123456' });
    steps.codeRefused = refusedCode.status === 409 && /one-time codes, and e\d+ \(“Verification code”\)/.test((await refusedCode.json()).error) && !(await answer()).includes('123456');
    await call('open', { url: `${base}/jobs/7` });
    const job = await call('read');
    await call('type', { ref: job.elements.find(item => item.name === 'Full name').ref, text: 'Auto Submit' });
    const clicked = await call('click', { ref: job.elements.find(item => item.name === 'Submit application').ref });
    steps.autoAllowed = /Auto-submit is on/.test(clicked.note || '') && clicked.page.url.startsWith(`${base}/submitted?name=Auto+Submit`);

    // 上传简历: Dayjob keeps a resume's own file and puts it into the form's resume field, here a hidden one in a
    // form embedded from another site; the cover letter field is left alone, and a field that has a file is not
    // given another.
    const resumeText = `Smoke Tester\nData analyst: SQL, Python, dashboards and experiments.\n${'Built weekly reporting for the growth team and kept it running. '.repeat(4)}`;
    const send = (route, method, body) => fetch(`${origin}${route}`, { method, body: JSON.stringify(body || {}), headers: { 'Content-Type': 'application/json', 'X-Dayjob-Token': token } });
    const kept = await (await send('/api/resumes', 'POST', { name: 'Smoke Resume.txt', mime: 'text/plain', data: Buffer.from(resumeText).toString('base64') })).json();
    await call('open', { url: `${base}/upload` });
    const uploaded = await call('upload');
    const uploadPage = window.contentView.children.find(child => child.webContents?.getURL().startsWith(`${base}/upload`)).webContents;
    const embedded = uploadPage.mainFrame.framesInSubtree.find(frame => frame.url.includes('/embed-upload'));
    const expected = `Smoke Resume.txt|${Buffer.byteLength(resumeText)}|${resumeText.slice(0, 24)}`;
    steps.resumeUploaded = kept.hasFile === true && uploaded.uploaded.resume === 'Smoke Resume.txt' && uploaded.uploaded.field.includes('Resume/CV')
      && await until(async () => (await embedded.executeJavaScript("document.getElementById('got').textContent")) === expected, 5000)
      && (await uploadPage.executeJavaScript("document.getElementById('cover').files.length")) === 0;
    steps.resumeOnce = (await post('upload')).status === 409;
    // 助手投递: a cover letter the assistant wrote goes into the form's cover letter field as a PDF that Dayjob
    // makes. Neither that nor signing in is offered to Claude over MCP.
    const letter = await browser.agent('letter', { text: 'Dear Smoke Co team,\n\nI build dashboards that people use every week.\n\nSmoke Tester' }, { by: 'assistant' });
    const cover = await uploadPage.executeJavaScript("(async () => { const file = document.getElementById('cover').files[0]; return file ? file.name + '|' + file.type + '|' + (await file.text()).slice(0, 5) : 'none'; })()");
    steps.letterAttached = letter.letter.as === 'file' && cover === 'Cover Letter - Smoke Tester.pdf|application/pdf|%PDF-';
    steps.assistantOnly = (await post('letter', { text: 'x'.repeat(60) })).status === 404 && (await post('signin')).status === 404;
    await send(`/api/resumes/${kept.id}`, 'DELETE');

    // 密码保管: a saved sign-in is filled into its site's login form, where
    // Claude's read only sees that the password box is filled; it is kept
    // encrypted on disk; a password typed into a sign-up form is offered for
    // keeping once the page moves on. The interface never gets a password. 自动登录 waits until the end.
    browser.setAutoLogin(false);
    vault.reset();
    vault.save({ site: '127.0.0.1', username: 'smoke@example.com', password: 'Sm0ke-pass!' });
    steps.vaultEncrypted = !fs.readFileSync(path.join(profileDir, 'vault.json'), 'utf8').includes('Sm0ke-pass!');
    await call('open', { url: `${base}/login` });
    steps.vaultFilled = await until(() => Boolean(browser.state().login?.filled), 6000);
    const signIn = await call('read');
    steps.vaultHidden = !JSON.stringify(signIn).includes('Sm0ke-pass!') && signIn.elements.find(item => item.name === 'Email')?.value === 'smoke@example.com';
    const signedIn = await call('click', { ref: signIn.elements.find(item => item.name === 'Sign in').ref });
    const welcome = (await call('read')).text;
    steps.vaultSubmitted = welcome.includes('Signed in as smoke@example.com') && welcome.includes('11-character password') && !signedIn.page.url.includes('Sm0ke');
    await call('open', { url: `${base}/signup` });
    const view = window.contentView.children.find(child => child.webContents?.getURL().startsWith(`${base}/signup`));
    await view.webContents.executeJavaScript(`for (const [name, value] of [['email', 'new@example.com'], ['password', 'N3w-pass!'], ['confirm', 'N3w-pass!']]) {
      const box = document.querySelector('[name="' + name + '"]'); box.value = value; box.dispatchEvent(new Event('input', { bubbles: true })); } true`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const signup = await call('read');
    await call('click', { ref: signup.elements.find(item => item.name === 'Create account').ref });
    steps.vaultOffered = await until(() => browser.state().login?.offer?.username === 'new@example.com', 6000);
    steps.vaultNoSecrets = !/Sm0ke-pass!|N3w-pass!/.test(JSON.stringify(browser.state()) + JSON.stringify(vault.list()));
    await browser.answerOffer(true);
    steps.vaultKept = vault.list().entries.some(entry => entry.site === '127.0.0.1' && entry.username === 'new@example.com') && !browser.state().login.offer;
    // With a vault password, the closed vault lists, shows and deletes nothing, but still fills the login form;
    // opened, it shows the passwords when Settings asks.
    const refused = action => { try { action(); return false; } catch { return true; } };
    await vault.setLock({ next: 'Sm0keVault1' });
    vault.close();
    browser.refreshLogin();
    steps.vaultClosed = vault.list().locked && !vault.list().entries.length && !fs.readFileSync(path.join(profileDir, 'vault.json'), 'utf8').includes('Sm0keVault1')
      && refused(() => vault.reveal()) && refused(() => vault.clear());
    await call('open', { url: `${base}/login` });
    steps.vaultClosedFills = await until(() => Boolean(browser.state().login?.filled), 6000) && browser.state().login.closed === true && browser.state().login.locked === false;
    await vault.unlock('Sm0keVault1');
    browser.refreshLogin();
    steps.vaultOpened = !vault.locked() && Object.values(vault.reveal()).includes('Sm0ke-pass!');
    browser.setAutoSubmit(false);

    // A password export from Edge (UTF-8 with a BOM, quoted fields): new sign-ins are added, a saved one with
    // the same password is left, phone apps and rows without a user name are skipped, and only counts come back.
    const exported = path.join(path.dirname(smokeOutput), 'smoke-passwords.csv');
    fs.writeFileSync(exported, '\uFEFFname,url,username,password,note\r\n'
      + 'jobs.example.com,https://jobs.example.com/login,ana@example.com,"An@, ""quoted"" pass",\r\n'
      + '127.0.0.1,http://127.0.0.1/login,smoke@example.com,Sm0ke-pass!,same as saved\r\n'
      + 'app,android://key@com.example.app/,ana,Andr0id-pass,\r\n'
      + 'nouser.example.com,https://nouser.example.com/,,N0-user-pass,\r\n'
      + 'board.example.org,https://www.board.example.org/,ana,"Two\nlines",note\r\n');
    const imported = importPasswords(exported);
    const importedEntry = vault.list().entries.find(entry => entry.site === 'jobs.example.com' && entry.username === 'ana@example.com');
    steps.vaultImported = imported.rows === 5 && imported.added === 2 && imported.same === 1 && imported.updated === 0 && imported.skipped.site === 1 && imported.skipped.username === 1
      && Boolean(importedEntry) && vault.password(importedEntry.id) === 'An@, "quoted" pass' && vault.list().entries.some(entry => entry.site === 'board.example.org')
      && !/An@|Sm0ke-pass|Andr0id|N0-user|Two/.test(JSON.stringify(imported) + JSON.stringify(vault.list())) && !fs.readFileSync(path.join(profileDir, 'vault.json'), 'utf8').includes('An@');

    // 自动登录: the open vault fills the login form and sends it. When the login page comes straight back (as after
    // a wrong password) it is not sent again and the user is told; 再试一次 sends it once more.
    const pageAt = start => window.contentView.children.find(child => child.webContents?.getURL().startsWith(start))?.webContents;
    const signedInAs = async (who, start = `${base}/signed-in`) => (await pageAt(start)?.executeJavaScript('document.body.innerText').catch(() => ''))?.includes(`Signed in as ${who}`);
    browser.setAutoLogin(true);
    await browser.go(`${base}/login?auto=1`);
    steps.autoLoggedIn = await until(() => signedInAs('smoke@example.com'), 10000);
    steps.autoNoted = browser.state().login?.auto?.state === 'sent' && browser.state().login.auto.username === 'smoke@example.com';
    await browser.go(`${base}/login?again=1`);
    steps.autoGuarded = await until(() => browser.state().login?.auto?.state === 'failed', 10000) && !browser.state().login.filled
      && Boolean(pageAt(`${base}/login?again=1`)) && !JSON.stringify(browser.state()).includes('Sm0ke-pass!');
    await browser.retryLogin();
    steps.autoRetried = await until(() => signedInAs('smoke@example.com'), 10000);
    // 助手登录: asked by the assistant, Dayjob signs in with the vault's sign-in for the site and answers with how it
    // went and nothing else. A login form that comes straight back is not sent a second time. (Its own site name,
    // so the sign-ins sent above do not count against it.)
    vault.save({ site: 'asst.localhost', username: 'asst@example.com', password: 'Asst-pass!' });
    const asst = `http://asst.localhost:${site.address().port}`;
    const byAssistant = { by: 'assistant' };
    await browser.agent('open', { url: `${asst}/login` }, byAssistant);
    const signedByAssistant = await browser.agent('signin', {}, byAssistant);
    steps.assistantSignedIn = signedByAssistant.status === 'signed-in' && await until(() => signedInAs('asst@example.com', `${asst}/signed-in`), 5000)
      && !/Asst-pass|asst@example/.test(JSON.stringify(signedByAssistant));
    await browser.agent('open', { url: `${asst}/login?again=1` }, byAssistant);
    steps.assistantNoRetry = (await browser.agent('signin', {}, byAssistant)).status === 'failed' && Boolean(pageAt(`${asst}/login?again=1`));
    // A two-step sign-in: the user name, Next, then the password and Sign in.
    vault.save({ site: 'localhost', username: 'two@example.com', password: 'Tw0-step!' });
    const local = `http://localhost:${site.address().port}`;
    await browser.go(`${local}/login-step1`);
    steps.autoTwoStep = await until(() => signedInAs('two@example.com', `${local}/signed-in`), 12000);
    browser.setAutoLogin(false);
    // The assistant's click on a button that sends: it waits on a question marked as the assistant's, a "no" stops
    // it, and under full takeover it goes through without the question.
    await browser.agent('open', { url: `${base}/jobs/7` }, byAssistant);
    const jobAgain = await browser.agent('read', {}, byAssistant);
    await browser.agent('type', { ref: jobAgain.elements.find(item => item.name === 'Full name').ref, text: 'Asked First' }, byAssistant);
    const sendRef = jobAgain.elements.find(item => item.name === 'Submit application').ref;
    const asked = browser.agent('click', { ref: sendRef }, byAssistant).then(() => 'clicked', error => error.status);
    steps.assistantAsked = await until(() => browser.state().approval?.by === 'assistant', 5000);
    browser.answer(browser.state().approval?.id, false);
    steps.assistantDeclined = (await asked) === 409 && Boolean(pageAt(`${base}/jobs/7`));
    const taken = await browser.agent('click', { ref: sendRef }, { by: 'assistant', takeover: true });
    steps.takeover = taken.allowed === 'auto' && /full takeover/.test(taken.note || '') && taken.page.url.startsWith(`${base}/submitted?name=Asked+First`);
    // 全部删除: every saved password goes, the vault password stays.
    steps.vaultCleared = vault.clear().count === 0 && vault.list().lock && !fs.readFileSync(path.join(profileDir, 'vault.json'), 'utf8').includes('two@example.com');
  } catch (error) {
    steps.error = error.message;
  } finally {
    site.close();
    embed.close();
  }
  steps.ok = !steps.error && ['refusesDayjob', 'opened', 'jobPosting', 'typed', 'selected', 'askedFirst', 'submitted', 'screenshot',
    'autofilled', 'autofillRepeat', 'autoSubmitted', 'autoAllowed', 'vaultEncrypted', 'vaultFilled', 'vaultHidden', 'vaultSubmitted', 'vaultOffered',
    'vaultNoSecrets', 'vaultKept', 'vaultClosed', 'vaultClosedFills', 'vaultOpened', 'vaultImported', 'autoLoggedIn', 'autoNoted', 'autoGuarded', 'autoRetried',
    'autoTwoStep', 'vaultCleared', 'resumeUploaded', 'resumeOnce', 'letterAttached', 'assistantOnly', 'assistantSignedIn', 'assistantNoRetry', 'assistantAsked',
    'assistantDeclined', 'takeover', 'autoRecorded', 'autoRecordedShown', 'userRecorded', 'askedWhichJob', 'namedRecorded', 'autoTrackSwitch',
    'choiceUnderLabel', 'choiceBesideLabel', 'choiceCovered', 'choiceCheckbox', 'choiceRead', 'plainFieldTyped', 'codeRefused'].every(step => steps[step] === true);
  return steps;
}

// The installed app finds a "9.9.9" release on a local feed (the installer
// that was just built, under a newer version number), shows the round
// download button, and downloads and verifies it. It does not install it.
async function smokeUpdate() {
  const steps = { item: await window.webContents.executeJavaScript("Boolean(document.querySelector('.update-item'))") };
  const feed = process.env.DAYJOB_SMOKE_UPDATE_FEED;
  if (!feed) {
    steps.ok = steps.item;
    return steps;
  }
  const latest = fs.readFileSync(path.join(feed, 'latest.yml'), 'utf8').replace(/^version: .*$/m, 'version: 9.9.9');
  const site = http.createServer((request, response) => {
    const name = path.basename(decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname));
    if (name === 'latest.yml') {
      response.writeHead(200, { 'Content-Type': 'text/yaml' });
      return response.end(latest);
    }
    const file = path.join(feed, name);
    if (!/\.exe$/i.test(name) || !fs.existsSync(file)) {
      response.writeHead(404);
      return response.end();
    }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
    return fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${site.address().port}` });
    const checked = await updates.check();
    steps.found = checked.status === 'available' && checked.latest === '9.9.9';
    steps.roundButton = await until(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.update-item.available .update-circle'))"), 5000);
    if (steps.roundButton) await window.webContents.executeJavaScript("document.querySelector('.update-item.available').click()");
    steps.downloaded = await until(() => updates.state().status === 'downloaded', 180000);
    steps.restartButton = await until(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.update-item.downloaded'))"), 5000);
    if (updates.state().error) steps.error = updates.state().error;
    // A process left running from Dayjob's folder, as Claude's MCP bridge is,
    // is stopped before the installer starts.
    if (process.platform === 'win32') {
      const bridge = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(app.getAppPath(), 'integrations', 'mcp-server.mjs')],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true });
      const exited = new Promise(resolve => bridge.once('exit', () => resolve(true)));
      await new Promise(resolve => setTimeout(resolve, 1500));
      const left = await freeInstallFolder({ dir: path.dirname(process.execPath), log: logUpdate });
      steps.freed = left.length === 0 && await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    }
    steps.logged = /Checking for update|stopping/i.test(fs.readFileSync(path.join(profileDir, 'logs', 'update.log'), 'utf8'));
  } catch (error) {
    steps.error = error.message;
  } finally {
    site.close();
  }
  steps.ok = !steps.error && ['item', 'found', 'roundButton', 'downloaded', 'restartButton', 'logged', ...(process.platform === 'win32' ? ['freed'] : [])].every(step => steps[step] === true);
  return steps;
}

async function runSmoke() {
  const started = Date.now();
  const timings = {};
  // A freshly built app on a cold Windows runner can take over ten seconds to draw.
  const ready = "['主页', '今日岗位', '投递追踪', '搜索与公司'].every(item => document.body.innerText.includes(item))";
  await until(() => window.webContents.executeJavaScript(ready), 45000);
  timings.ready = Date.now() - started;
  const renderer = await window.webContents.executeJavaScript(`(async () => ({
    title: document.title,
    content: document.body.innerText.slice(0, 2000),
    info: await window.dayjobDesktop.getInfo(),
    nodeUnavailable: typeof window.require === 'undefined' && typeof window.process === 'undefined',
    bridgeMethods: Object.keys(window.dayjobDesktop),
  }))()`);
  const response = await fetch(`${origin}/api/bootstrap`);
  const state = await response.json();
  const rendererLoaded = ['主页', '今日岗位', '投递追踪', '搜索与公司'].every(item => renderer.content.includes(item));
  await window.webContents.executeJavaScript("document.querySelector('.language-toggle').click()");
  let english = false;
  for (let attempt = 0; attempt < 50 && !english; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    english = await window.webContents.executeJavaScript("['Home', 'Today', 'Applications', 'Searches'].every(item => document.body.innerText.includes(item)) && document.documentElement.lang === 'en' && document.title === 'Dayjob · Job tracker'");
  }
  const englishTitle = window.getTitle();
  let languageSaved = false;
  for (let attempt = 0; attempt < 30 && !languageSaved; attempt += 1) {
    languageSaved = service.repo.getSettings().language === 'en' && language === 'en';
    if (!languageSaved) await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Let the first frame paint; a hidden window can otherwise capture the boot spinner. Its arrival motions
  // barely move while it is hidden, so they are run to their end for the screenshot.
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))');
  await window.webContents.executeJavaScript('document.getAnimations().forEach(animation => { try { animation.finish(); } catch { /* one that never ends */ } }); new Promise(resolve => setTimeout(resolve, 100))');
  // Run to its end like that, the opening takes its cover away, so the screenshot shows the page under it.
  let openingClosed = false;
  for (let attempt = 0; attempt < 30 && !openingClosed; attempt += 1) {
    openingClosed = await window.webContents.executeJavaScript("!document.querySelector('.opening')");
    if (!openingClosed) await new Promise(resolve => setTimeout(resolve, 100));
  }
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))');
  const screenshotPath = smokeOutput.replace(/\.json$/i, '') + '.png';
  fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
  timings.english = Date.now() - started;
  const browserCheck = await smokeBrowser(state.csrfToken);
  timings.browser = Date.now() - started;
  const updateCheck = await smokeUpdate();
  timings.update = Date.now() - started;
  const musicCheck = await nowPlaying.probe();
  // Hearing the system sound for the wave: while following is on, Dayjob's page asks to capture it and nothing
  // refuses that on the way. (The capture itself needs Windows and a sound device.)
  const asked = soundRequests;
  music.setFollow(true);
  musicCheck.capture = await window.webContents.executeJavaScript(`navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    .then(stream => { const kinds = stream.getTracks().map(track => track.kind).sort().join(','); stream.getTracks().forEach(track => track.stop()); return kinds; }, error => error.name)`, true);
  music.setFollow(false);
  musicCheck.asked = soundRequests > asked;
  musicCheck.ok = musicCheck.ok && musicCheck.asked;
  timings.music = Date.now() - started;
  // By default closing the window only hides it.
  window.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  const closeKeepsRunning = !window.isDestroyed();
  const ok = response.ok && Boolean(state.csrfToken) && rendererLoaded && english && languageSaved && renderer.nodeUnavailable && Boolean(renderer.info.dataPath)
    && openingClosed && browserCheck.ok && updateCheck.ok && musicCheck.ok && closeKeepsRunning;
  fs.writeFileSync(smokeOutput, JSON.stringify({ ok, origin, rendererLoaded, english, englishTitle, languageSaved, openingClosed, browser: browserCheck, update: updateCheck, music: musicCheck, closeKeepsRunning, ...renderer, screenshotPath, trayAvailable: Boolean(tray),
    windowSecurity: window.webContents.getLastWebPreferences(), version: app.getVersion(), executable: process.execPath, timings, log: smokeLog }, null, 2));
  if (!ok) throw Object.assign(new Error('Desktop smoke assertions failed.'), { reported: true });
  // With "keep running" turned off, closing the window quits Dayjob: the
  // build check fails if the app is still running after this.
  const off = await fetch(`${origin}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Dayjob-Token': state.csrfToken },
    body: JSON.stringify({ desktop: { closeToTray: false } }) });
  if (!off.ok) throw new Error(`Could not turn off "keep running": ${off.status}`);
  window.close();
}

async function boot() {
  await app.whenReady();
  const { createApp } = await import(pathToFileURL(path.join(app.getAppPath(), 'server', 'app.mjs')).href);
  service = await createApp({ dataDir, distDir: path.join(app.getAppPath(), 'dist'), notify: desktopNotification,
    allowedOrigins: [], startScheduler: !smoke, onSettings: settings => setLanguage(settings.language),
    browser: { run: (action, input, context) => (browser ? browser.agent(action, input, context) : Promise.reject(Object.assign(new Error('The Dayjob window is still opening.'), { status: 503 }))) } });
  language = service.repo.getSettings().language;
  origin = await service.listen(port);
  const bridge = path.join(app.getAppPath(), 'integrations', 'mcp-server.mjs');
  claude = createClaudeConnection({ command: process.execPath, args: [bridge], env: { ELECTRON_RUN_AS_NODE: '1', DAYJOB_URL: origin } });
  // Everything is refused, except that while "follow music" is on (Settings, off by default) Dayjob's own page may
  // hear the system sound, for the listening wave; it is analysed in the page and never recorded or sent anywhere.
  const capture = (contents, permission, url, mediaTypes) => nowPlaying.soundPermission(permission, mediaTypes) && Boolean(music?.following) && Boolean(window)
    && contents === window.webContents && localUrl(url);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(capture(contents, permission, details?.requestingUrl, details?.mediaTypes)));
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => capture(contents, permission, requestingOrigin));
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    soundRequests += 1;
    if (process.platform !== 'win32' || !music?.following || !window || !request.audioRequested || !localUrl(request.frame?.url)) { callback(null); return; }
    // No thumbnails: only the sound is wanted, and a failed try may be repeated on the next click.
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then(sources => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : null))
      .catch(() => callback(null));
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!localUrl(details.url)) return callback({});
    callback({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"],
    } });
  });
  updates = createUpdater({
    updater: app.isPackaged ? require('electron-updater').autoUpdater : null,
    version: app.getVersion(), portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR), installOnQuit: !smoke,
    openExternal: url => shell.openExternal(url),
    autoCheck: () => service.repo.getSettings().updates.autoCheck,
    lastCheck: () => service.repo.getMeta('lastUpdateCheck'),
    saveLastCheck: at => service.repo.setMeta('lastUpdateCheck', at),
    // Claude Code runs the MCP bridge from Dayjob's folder; it has to stop
    // before the installer can replace the files there.
    freeInstall: () => (process.platform === 'win32' && !smoke ? freeInstallFolder({ dir: path.dirname(process.execPath), log: logUpdate }) : []),
    lastAttempt: () => (smoke ? null : service.repo.getMeta('updateAttempt')),
    saveAttempt: value => { if (!smoke) service.repo.setMeta('updateAttempt', value); },
    log: logUpdate,
    onState: state => { if (window && !window.isDestroyed()) window.webContents.send('dayjob:update-state', state); },
  });
  music = nowPlaying.createNowPlaying({ onChange: state => { if (window && !window.isDestroyed()) window.webContents.send('dayjob:now-playing', state); } });
  setupIpc();
  await createWindow();
  if (smoke) await runSmoke();
  else {
    void claude.check();
    updates.start();
  }
}

app.on('window-all-closed', () => { /* The tray keeps daily searches running. */ });
app.on('activate', showWindow);
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  logApp('quitting');
  updates?.stop();
  music?.stop();
  // A quit must never leave Dayjob running without its window or tray: the local service gets a few seconds to close,
  // and if the quit itself is still held up after that, the process ends.
  const waited = new Promise(resolve => setTimeout(resolve, QUIT_WAIT_MS, 'late'));
  Promise.race([Promise.resolve(service?.close()), waited]).then(result => {
    if (result === 'late') logApp('the local service did not close in time');
  }, console.error).finally(() => {
    tray?.destroy();
    quitting = true;
    app.quit();
    setTimeout(() => { logApp('the quit did not finish: ending the process'); app.exit(0); }, QUIT_WAIT_MS).unref();
  });
});

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  // Opening Dayjob again shows its window. An instance that is quitting, or was left without a window (its quit got
  // stuck partway), makes way instead: Dayjob starts afresh once this one has ended, so the launch still opens it.
  let relaunching = false;
  app.on('second-instance', () => {
    if (!shutdownStarted && !window?.isDestroyed()) { showWindow(); return; }
    if (relaunching) return;
    // A quit that installs an update is left alone: the installer is replacing Dayjob's files.
    if (shutdownStarted && ['downloaded', 'installing'].includes(updates?.state().status)) { logApp('opened again while an update installs'); return; }
    relaunching = true;
    logApp(shutdownStarted ? 'opened again while quitting: starting afresh after the quit' : 'opened again with no window left: starting afresh');
    app.relaunch({ args: process.argv.slice(1).filter(arg => arg !== '--hidden') });
    // The new launch hears back first and closes; then this one exits and the fresh Dayjob starts.
    if (!shutdownStarted) setTimeout(() => app.exit(0), 200);
  });
  boot().catch(async error => {
    const copy = text();
    const message = error.code === 'EADDRINUSE' ? copy.portInUse(port) : copy.failed(error.message);
    // A failed assertion already wrote the full report; keep it.
    if (smoke) {
      if (!error.reported) fs.writeFileSync(smokeOutput, JSON.stringify({ ok: false, error: message, log: smokeLog }, null, 2));
    } else dialog.showErrorBox(copy.cannotStart, message);
    await service?.close().catch(() => {});
    quitting = true;
    app.exit(1);
  });
}
