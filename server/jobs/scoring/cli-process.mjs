import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Shared by the Claude Code and Codex providers: both run a signed-in CLI
// once per question from an empty temporary folder.

// .cmd shims only start through cmd.exe; arguments here are fixed flags, and
// the prompt itself always travels over stdin.
export const needsShell = command => /\.(cmd|bat)$/i.test(command);

// Through cmd.exe, killing the shell would leave the CLI running, so on
// Windows the whole process tree goes.
export function stopProcess(child, { platform = process.platform, run = execFile } = {}) {
  if (platform === 'win32' && child.pid) run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else child.kill();
}

export function runOnce(command, args, run = execFile, timeout = 10000) {
  return new Promise(resolve => {
    try {
      run(command, args, { timeout, windowsHide: true, shell: needsShell(command) }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch { resolve({ ok: false, stdout: '', stderr: '' }); }
  });
}

// The first candidate that answers --version.
export async function detectCommand(candidates, { run = execFile, exists = fs.existsSync } = {}) {
  for (const command of candidates) {
    if (path.isAbsolute(command) && !exists(command)) continue;
    const result = await runOnce(command, ['--version'], run);
    if (result.ok) return { available: true, command, version: result.stdout.trim().slice(0, 120) };
  }
  return { available: false, command: null, version: null };
}

// files are written into the folder first, and read names the file whose
// contents come back as `output` once the process exits.
export function runInTempFolder({ spawn, stop, timeoutMs }, { command, args, input, signal, files = {}, read = null }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-score-'));
    const cleanup = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* still in use; the OS temp folder clears it */ } };
    const collect = () => {
      if (!read) return '';
      try { return fs.readFileSync(path.join(cwd, read), 'utf8'); } catch { return ''; }
    };
    let stdout = '';
    let stderr = '';
    let child;
    try {
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), text);
      child = spawn(command, args, { cwd, windowsHide: true, shell: needsShell(command) });
    } catch (error) { cleanup(); reject(error); return; }
    let settled = false;
    const timer = setTimeout(() => stop(child), timeoutMs);
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle(value);
    };
    // A paused score ends now: a child process of the CLI can keep the
    // output open for a while after it is stopped.
    const abort = () => { stop(child); finish(reject, signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { cleanup(); finish(reject, error); });
    child.on('close', code => { const output = collect(); cleanup(); finish(resolve, { code, stdout, stderr, output }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
