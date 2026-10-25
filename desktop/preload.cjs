const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('dayjobDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('dayjob:get-info'),
  openDataFolder: () => ipcRenderer.invoke('dayjob:open-data-folder'),
  getClaudeStatus: () => ipcRenderer.invoke('dayjob:claude-status'),
  checkClaude: () => ipcRenderer.invoke('dayjob:check-claude'),
  connectClaude: () => ipcRenderer.invoke('dayjob:connect-claude'),
  browser: Object.freeze({
    getState: () => ipcRenderer.invoke('dayjob:browser-state'),
    onState: callback => listen('dayjob:browser-state', callback),
    onReveal: callback => listen('dayjob:browser-reveal', callback),
    onFocusAddress: callback => listen('dayjob:browser-focus-address', callback),
    setBounds: rect => ipcRenderer.invoke('dayjob:browser-bounds', rect),
    open: url => ipcRenderer.invoke('dayjob:browser-open', url),
    go: url => ipcRenderer.invoke('dayjob:browser-go', url),
    command: (name, id) => ipcRenderer.invoke('dayjob:browser-command', name, id),
    answer: (id, allowed) => ipcRenderer.invoke('dayjob:browser-answer', id, allowed),
    setAgentControl: value => ipcRenderer.invoke('dayjob:browser-agent-control', value),
    setAutoSubmit: value => ipcRenderer.invoke('dayjob:browser-auto-submit', value),
    autofill: options => ipcRenderer.invoke('dayjob:browser-autofill', options),
    extract: () => ipcRenderer.invoke('dayjob:browser-extract'),
    clearData: () => ipcRenderer.invoke('dayjob:browser-clear'),
    fillLogin: id => ipcRenderer.invoke('dayjob:browser-login-fill', id),
    answerOffer: answer => ipcRenderer.invoke('dayjob:browser-login-offer', answer),
    // 自动登录: on or off, and after a sign-in that did not go through, try again or let it be.
    setAutoLogin: value => ipcRenderer.invoke('dayjob:browser-auto-login', value),
    retryLogin: () => ipcRenderer.invoke('dayjob:browser-login-retry'),
    dismissLogin: () => ipcRenderer.invoke('dayjob:browser-login-dismiss'),
  }),
  // Saved passwords: in to be kept, never back out; the list has sites and user names only.
  vault: Object.freeze({
    list: () => ipcRenderer.invoke('dayjob:vault-list'),
    save: entry => ipcRenderer.invoke('dayjob:vault-save', entry),
    remove: id => ipcRenderer.invoke('dayjob:vault-delete', id),
    // The vault's own password: open, close, set or change, take off, or (forgotten) empty the vault.
    unlock: password => ipcRenderer.invoke('dayjob:vault-unlock', password),
    close: () => ipcRenderer.invoke('dayjob:vault-close'),
    setLock: input => ipcRenderer.invoke('dayjob:vault-set-lock', input),
    removeLock: current => ipcRenderer.invoke('dayjob:vault-remove-lock', current),
    reset: () => ipcRenderer.invoke('dayjob:vault-reset'),
    // A browser's password export: Dayjob asks for the file and reads it; only the counts come back.
    importCsv: () => ipcRenderer.invoke('dayjob:vault-import'),
    trashImport: () => ipcRenderer.invoke('dayjob:vault-trash-import'),
    onChanged: callback => listen('dayjob:vault-changed', callback),
  }),
  music: Object.freeze({
    // Following music reads the Windows media controls, so it exists only on Windows.
    supported: process.platform === 'win32',
    setFollow: value => ipcRenderer.invoke('dayjob:music-follow', value),
    getState: () => ipcRenderer.invoke('dayjob:music-state'),
    onNowPlaying: callback => listen('dayjob:now-playing', callback),
  }),
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke('dayjob:update-state'),
    onState: callback => listen('dayjob:update-state', callback),
    check: () => ipcRenderer.invoke('dayjob:update-check'),
    download: () => ipcRenderer.invoke('dayjob:update-download'),
    install: () => ipcRenderer.invoke('dayjob:update-install'),
  }),
}));
