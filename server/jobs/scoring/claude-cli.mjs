import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { SCORE_SCHEMA, SYSTEM_PROMPT, buildUserPrompt, normalizeScore, parseScoreText } from './prompt.mjs';

const TIMEOUT_MS = 4 * 60 * 1000;

// Claude Code installs to ~/.local/bin (native installer) or the npm global
// folder. A desktop app does not always inherit the shell PATH, so look there too.
export function claudeCandidates(configured, env = process.env, platform = process.platform) {
  const list = [configured, env.CLAUDE_BIN].filter(Boolean);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (platform === 'win32') {
    list.push(path.win32.join(home, '.local', 'bin', 'claude.exe'));
    if (env.APPDATA) list.push(path.win32.join(env.APPDATA, 'npm', 'claude.cmd'));
    list.push('claude.exe', 'claude.cmd');
  } else {
    list.push(path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude', 'claude');
  }
  return [...new Set(list)];
}

// .cmd shims only start through cmd.exe; arguments here are fixed flags, and
// the prompt itself always travels over stdin.
const needsShell = command => /\.(cmd|bat)$/i.test(command);

function version(command, run = execFile) {
  return new Promise(resolve => {
    try {
      run(command, ['--version'], { timeout: 10000, windowsHide: true, shell: needsShell(command) }, (error, stdout) => {
        resolve(error ? null : String(stdout).trim().slice(0, 120));
      });
    } catch { resolve(null); }
  });
}

export async function detectClaude(configured, { run = execFile, exists = fs.existsSync, env = process.env, platform = process.platform } = {}) {
  for (const command of claudeCandidates(configured, env, platform)) {
    if (path.isAbsolute(command) && !exists(command)) continue;
    const found = await version(command, run);
    if (found) return { available: true, command, version: found };
  }
  return { available: false, command: null, version: null };
}

// Through cmd.exe (a .cmd shim) arguments are not quoted for us, so long text
// such as the system prompt goes over stdin and only plain flags stay here.
export function cliArgs({ model, shell = false, basic = false }) {
  const args = ['-p', '--output-format', 'json'];
  if (!basic) {
    args.push('--tools', shell ? '""' : '', '--no-session-persistence');
    if (!shell) args.push('--system-prompt', SYSTEM_PROMPT, '--json-schema', JSON.stringify(SCORE_SCHEMA));
  }
  if (model && /^[\w.:\[\]-]+$/.test(model)) args.push('--model', model);
  return args;
}

// Reads the --output-format json envelope. structured_output is present when
// the CLI supports --json-schema; otherwise the reply text holds the JSON.
export function parseCliOutput(stdout) {
  const text = String(stdout || '').trim();
  let envelope;
  try { envelope = JSON.parse(text); } catch { return { score: parseScoreText(text), model: null }; }
  if (Array.isArray(envelope)) envelope = envelope.findLast(item => item?.type === 'result') || {};
  if (envelope.is_error) throw new Error(`Claude Code: ${String(envelope.result || envelope.subtype || 'error').slice(0, 300)}`);
  const model = Object.keys(envelope.modelUsage || {})[0] || null;
  if (envelope.structured_output && typeof envelope.structured_output === 'object') return { score: normalizeScore(envelope.structured_output), model };
  return { score: parseScoreText(envelope.result), model };
}

// Scores through the user's signed-in Claude Code, so no API key is needed.
// Tools are off and the working folder is an empty temp folder.
const SIGNED_OUT_REPLY = /not logged in|\/login/i;

export function createClaudeCliProvider({ getSettings, spawn = nodeSpawn, detect = detectClaude, timeoutMs = TIMEOUT_MS }) {
  let cached = null;
  let signedOut = 0;
  const SIGNED_OUT = 'Claude Code is not signed in. Run claude in a terminal and type /login, then check again.';
  async function info(refresh = false) {
    const configured = getSettings().ai.claudeCommand || '';
    if (!cached || refresh || cached.configured !== configured) cached = { configured, result: await detect(configured) };
    return cached.result;
  }
  function execute(command, args, input) {
    return new Promise((resolve, reject) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-score-'));
      const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawn(command, args, { cwd, windowsHide: true, shell: needsShell(command) });
      } catch (error) { cleanup(); reject(error); return; }
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', error => { clearTimeout(timer); cleanup(); reject(error); });
      child.on('close', code => { clearTimeout(timer); cleanup(); resolve({ code, stdout, stderr }); });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  return {
    id: 'claude-cli',
    async status(refresh = false) {
      if (refresh) signedOut = 0;
      const found = await info(refresh);
      if (found.available && signedOut && Date.now() - signedOut < 30 * 60 * 1000) return { available: false, detail: SIGNED_OUT, signedOut: true };
      return { available: found.available, detail: found.available ? `Claude Code ${found.version}` : 'Claude Code was not found. Install it and sign in, or set its path in Settings.' };
    },
    async score({ resume, posting }) {
      const found = await info();
      if (!found.available) throw new Error('Claude Code was not found. Install it and sign in, or set its path in Settings.');
      const { ai } = getSettings();
      const shell = needsShell(found.command);
      const prompt = buildUserPrompt({ resume, posting, language: ai.language });
      const withSystem = `${SYSTEM_PROMPT}\n\n${prompt}`;
      let result = await execute(found.command, cliArgs({ model: ai.model, shell }), shell ? withSystem : prompt);
      // Older Claude Code releases lack --json-schema or --tools; retry with the basics.
      if (result.code !== 0 && /unknown option|unexpected argument/i.test(result.stderr)) {
        result = await execute(found.command, cliArgs({ model: ai.model, shell, basic: true }), withSystem);
      }
      if (result.code !== 0 && !result.stdout.trim()) {
        if (SIGNED_OUT_REPLY.test(result.stderr)) { signedOut = Date.now(); throw new Error(SIGNED_OUT); }
        throw new Error(`Claude Code exited with ${result.code}: ${result.stderr.trim().split('\n').pop() || 'no output'}`.slice(0, 400));
      }
      let parsed;
      try { parsed = parseCliOutput(result.stdout); } catch (error) {
        if (SIGNED_OUT_REPLY.test(error.message)) { signedOut = Date.now(); throw new Error(SIGNED_OUT); }
        throw error;
      }
      signedOut = 0;
      return { ...parsed.score, provider: 'claude-cli', model: parsed.model || ai.model || null };
    },
  };
}
