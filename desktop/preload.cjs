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
    extract: () => ipcRenderer.invoke('dayjob:browser-extract'),
    clearData: () => ipcRenderer.invoke('dayjob:browser-clear'),
  }),
}));
