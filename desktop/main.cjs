const { app, BrowserWindow, Menu, Tray, Notification, nativeImage, dialog, shell, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createClaudeConnection } = require('./claude-connection.cjs');

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
let service;
let window;
let tray;
let origin;
let claude;
let quitting = false;
let shutdownStarted = false;
let language = null;

// Desktop copy follows the interface language (a Dayjob setting); before the
// service starts, the system language decides.
const TEXT = {
  zh: { title: 'Dayjob · 求职追踪', tooltip: 'Dayjob · 每日岗位抓取与投递追踪', open: '打开 Dayjob', run: '立即抓取新岗位', data: '打开数据文件夹', quit: '退出 Dayjob',
    portable: '请先安装 Dayjob，再添加稳定的 Claude MCP 连接。', cannotStart: 'Dayjob 无法启动',
    portInUse: port => `本地端口 ${port} 已被占用。请先关闭已运行的 Dayjob（npm start）或占用该端口的程序，然后重新打开。`, failed: message => `Dayjob 启动失败：${message}` },
  en: { title: 'Dayjob · Job tracker', tooltip: 'Dayjob · daily job search and application tracking', open: 'Open Dayjob', run: 'Search for new jobs now', data: 'Open data folder', quit: 'Quit Dayjob',
    portable: 'Install Dayjob before adding a lasting Claude MCP connection.', cannotStart: 'Dayjob cannot start',
    portInUse: port => `Local port ${port} is in use. Close the Dayjob already running (npm start) or the program using that port, then open Dayjob again.`, failed: message => `Dayjob failed to start: ${message}` },
};
const text = () => TEXT[language || (app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en')];

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// Job links point anywhere; they open in the user's browser, never in the app.
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
  const image = nativeImage.createFromPath(icon);
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640,
    title: text().title, backgroundColor: '#f6f6f2', icon: image,
    show: false, paintWhenInitiallyHidden: smoke, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      backgroundThrottling: !smoke, devTools: !app.isPackaged,
    },
  });
  window.removeMenu();
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
  window.on('close', event => {
    if (!quitting && tray) { event.preventDefault(); window.hide(); }
  });

  tray = new Tray(image.resize({ width: 32, height: 32 }));
  buildTray();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  await window.loadURL(origin);
  if (!smoke && !process.argv.includes('--hidden')) showWindow();
}

async function runSmoke() {
  const ready = "['今日岗位', '投递追踪', '搜索与公司'].every(item => document.body.innerText.includes(item))";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await window.webContents.executeJavaScript(ready)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const renderer = await window.webContents.executeJavaScript(`(async () => ({
    title: document.title,
    content: document.body.innerText.slice(0, 2000),
    info: await window.dayjobDesktop.getInfo(),
    nodeUnavailable: typeof window.require === 'undefined' && typeof window.process === 'undefined',
    bridgeMethods: Object.keys(window.dayjobDesktop),
  }))()`);
  const response = await fetch(`${origin}/api/bootstrap`);
  const state = await response.json();
  const rendererLoaded = ['今日岗位', '投递追踪', '搜索与公司'].every(item => renderer.content.includes(item));
  await window.webContents.executeJavaScript("document.querySelector('.language-toggle').click()");
  let english = false;
  for (let attempt = 0; attempt < 50 && !english; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    english = await window.webContents.executeJavaScript("['Today', 'Applications', 'Searches'].every(item => document.body.innerText.includes(item)) && document.documentElement.lang === 'en' && document.title === 'Dayjob · Job tracker'");
  }
  const englishTitle = window.getTitle();
  let languageSaved = false;
  for (let attempt = 0; attempt < 30 && !languageSaved; attempt += 1) {
    languageSaved = service.repo.getSettings().language === 'en' && language === 'en';
    if (!languageSaved) await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Let the first frame paint; a hidden window can otherwise capture the boot spinner.
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))');
  const screenshotPath = smokeOutput.replace(/\.json$/i, '') + '.png';
  fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
  const ok = response.ok && Boolean(state.csrfToken) && rendererLoaded && english && languageSaved && renderer.nodeUnavailable && Boolean(renderer.info.dataPath);
  fs.writeFileSync(smokeOutput, JSON.stringify({ ok, origin, rendererLoaded, english, englishTitle, languageSaved, ...renderer, screenshotPath, trayAvailable: Boolean(tray),
    windowSecurity: window.webContents.getLastWebPreferences(), version: app.getVersion(), executable: process.execPath }, null, 2));
  if (!ok) throw new Error('Desktop smoke assertions failed.');
  app.quit();
}

async function boot() {
  await app.whenReady();
  const { createApp } = await import(pathToFileURL(path.join(app.getAppPath(), 'server', 'app.mjs')).href);
  service = await createApp({ dataDir, distDir: path.join(app.getAppPath(), 'dist'), notify: desktopNotification,
    allowedOrigins: [], startScheduler: !smoke, onSettings: settings => setLanguage(settings.language) });
  language = service.repo.getSettings().language;
  origin = await service.listen(port);
  const bridge = path.join(app.getAppPath(), 'integrations', 'mcp-server.mjs');
  claude = createClaudeConnection({ command: process.execPath, args: [bridge], env: { ELECTRON_RUN_AS_NODE: '1', DAYJOB_URL: origin } });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!localUrl(details.url)) return callback({});
    callback({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"],
    } });
  });
  setupIpc();
  await createWindow();
  if (smoke) await runSmoke();
  else void claude.check();
}

app.on('window-all-closed', () => { /* The tray keeps daily searches running. */ });
app.on('activate', showWindow);
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  Promise.resolve(service?.close()).catch(console.error).finally(() => {
    tray?.destroy();
    quitting = true;
    app.quit();
  });
});

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', showWindow);
  boot().catch(async error => {
    const copy = text();
    const message = error.code === 'EADDRINUSE' ? copy.portInUse(port) : copy.failed(error.message);
    if (smoke) fs.writeFileSync(smokeOutput, JSON.stringify({ ok: false, error: message }, null, 2));
    else dialog.showErrorBox(copy.cannotStart, message);
    await service?.close().catch(() => {});
    quitting = true;
    app.exit(1);
  });
}
