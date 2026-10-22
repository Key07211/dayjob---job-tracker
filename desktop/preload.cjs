const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dayjobDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('dayjob:get-info'),
  openDataFolder: () => ipcRenderer.invoke('dayjob:open-data-folder'),
  getClaudeStatus: () => ipcRenderer.invoke('dayjob:claude-status'),
  checkClaude: () => ipcRenderer.invoke('dayjob:check-claude'),
  connectClaude: () => ipcRenderer.invoke('dayjob:connect-claude'),
}));
