const path = require('node:path');
const { execFile } = require('node:child_process');

// The installer replaces the files in Dayjob's folder, so nothing may still be
// running from there when it starts. Besides Dayjob itself (which quits for the
// update), that is usually the MCP bridge: Claude Code runs it as Dayjob.exe
// from this folder, and it stays running as long as Claude does. The silent
// installer then gives up without a word, so Dayjob stops those processes
// first, and says so when it cannot.

const inside = (dir, file) => typeof file === 'string' && file.toLowerCase().startsWith(`${dir.toLowerCase().replace(/[\\/]+$/, '')}${path.win32.sep}`);

// Dayjob.exe processes from this install other than this Dayjob and its own
// helpers (renderer, GPU and the like: started by it, with a --type switch).
const helper = (item, pid) => item.parent === pid && /(^|\s)--type=/.test(item.command || '');
function blockers(processes, { dir, pid }) {
  return processes.filter(item => item.pid !== pid && !helper(item, pid) && inside(dir, item.path))
    .map(item => ({ pid: item.pid, bridge: /[\\/]integrations[\\/]mcp-server\.mjs/i.test(item.command || '') }));
}

// Every Dayjob.exe on the computer, with its path and command line (Windows).
function listProcesses(exe = 'Dayjob.exe') {
  const script = `Get-CimInstance Win32_Process -Filter "Name='${exe.replace(/'/g, "''")}'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      const text = stdout.trim();
      const rows = text ? [].concat(JSON.parse(text)) : [];
      resolve(rows.map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, path: row.ExecutablePath || null, command: row.CommandLine || '' })));
    });
  });
}

// Stops what would keep the installer from replacing Dayjob's files and returns
// what is still running afterwards (empty when the install can go ahead).
async function freeInstallFolder({ dir, pid = process.pid, list = listProcesses, kill = id => process.kill(id), waitMs = 4000, stepMs = 250, log = () => {} }) {
  let found = blockers(await list(), { dir, pid });
  if (!found.length) return [];
  log(`stopping ${found.length} process(es) running from the install folder: ${found.map(item => `${item.pid}${item.bridge ? ' (MCP bridge)' : ''}`).join(', ')}`);
  for (const item of found) {
    try { kill(item.pid); } catch (error) { log(`could not stop ${item.pid}: ${error.message}`); }
  }
  for (let waited = 0; waited < waitMs; waited += stepMs) {
    await new Promise(resolve => setTimeout(resolve, stepMs));
    const running = new Set((await list()).map(item => item.pid));
    found = found.filter(item => running.has(item.pid));
    if (!found.length) return [];
  }
  log(`still running: ${found.map(item => item.pid).join(', ')}`);
  return found;
}

module.exports = { blockers, listProcesses, freeInstallFolder };
