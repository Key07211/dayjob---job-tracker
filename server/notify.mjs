import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Source mode (npm start) on Windows: a toast through PowerShell. The desktop
// app passes Electron's own notifications instead.
export function nativeNotification(notification) {
  if (process.platform !== 'win32') return;
  const script = fileURLToPath(new URL('./notify.ps1', import.meta.url));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Title', notification.title.slice(0, 200), '-Body', notification.body.slice(0, 500)],
  { windowsHide: true, shell: false, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// Every notification is kept in the app; a desktop toast is extra and optional.
export function createNotifier({ repo, desktop = nativeNotification }) {
  return item => {
    const saved = repo.addNotification(item);
    if (repo.getSettings().notifications.desktop) {
      try { desktop(saved); } catch { /* A toast must never stop a run. */ }
    }
    return saved;
  };
}
