import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { detectCommand, runInTempFolder, runOnce, stopProcess } from './cli-process.mjs';
import { effortFor } from './models.mjs';
import { SCORE_SCHEMA, SYSTEM_PROMPT, buildUserPrompt, normalizeScore, parseJsonText } from './prompt.mjs';

const TIMEOUT_MS = 6 * 60 * 1000;
const MODEL_ID = /^[\w.:[\]-]+$/;

// Codex installs through npm (codex.cmd on Windows) or its own installer.
export function codexCandidates(configured, env = process.env, platform = process.platform) {
  const list = [configured, env.CODEX_BIN].filter(Boolean);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (platform === 'win32') {
    if (env.APPDATA) list.push(path.win32.join(env.APPDATA, 'npm', 'codex.cmd'));
    list.push(path.win32.join(home, '.local', 'bin', 'codex.exe'), 'codex.exe', 'codex.cmd');
  } else {
    list.push(path.join(home, '.local', 'bin', 'codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex', 'codex');
  }
  return [...new Set(list)];
}

export function detectCodex(configured, { run = execFile, exists = fs.existsSync, env = process.env, platform = process.platform } = {}) {
  return detectCommand(codexCandidates(configured, env, platform), { run, exists });
}

// The schema and the reply are files in the working folder, named relative
// to it, so no argument carries a path with spaces through cmd.exe. Without
// the user's config, Codex starts none of their MCP servers for a score.
export function codexArgs({ model, effort = '', basic = false }) {
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'];
  if (!basic) args.push('--ephemeral', '--ignore-user-config', '--color', 'never', '--output-schema', 'schema.json');
  args.push('--output-last-message', 'reply.txt');
  if (model && MODEL_ID.test(model)) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  args.push('-');
  return args;
}

const SIGNED_OUT_REPLY = /not logged in|codex login|please log ?in|401 unauthorized/i;
const SIGNED_OUT = 'Codex is not signed in. Run codex in a terminal and choose Sign in with ChatGPT, then check again.';
const NOT_FOUND = 'Codex was not found. Install it and sign in with ChatGPT, or set its path in Settings.';
const NO_TOOLS = 'Answer from the text below alone. Do not run commands, read files or browse; reply with the JSON object only.';

// Asks through the user's signed-in Codex CLI (a ChatGPT plan), so no API key
// is needed. The sandbox is read-only and the folder is empty.
export function createCodexCliProvider({ getSettings, spawn = nodeSpawn, detect = detectCodex, run = execFile, timeoutMs = TIMEOUT_MS, stop = stopProcess }) {
  let cached = null;
  let signedOut = 0;
  async function info(refresh = false) {
    const configured = getSettings().ai.codexCommand || '';
    if (!cached || refresh || cached.configured !== configured) {
      const result = await detect(configured);
      // `codex login status` exits non-zero when signed out; older releases
      // without it are left to the first score to find out.
      if (result.available) {
        const login = await runOnce(result.command, ['login', 'status'], run);
        if (!login.ok && SIGNED_OUT_REPLY.test(login.stdout + login.stderr)) signedOut = Date.now();
        else if (login.ok) signedOut = 0;
      }
      cached = { configured, result };
    }
    return cached.result;
  }
  const execute = (command, args, { input, schema, signal }) => runInTempFolder({ spawn, stop, timeoutMs },
    { command, args, input, signal, files: { 'schema.json': JSON.stringify(schema) }, read: 'reply.txt' });
  return {
    id: 'codex-cli',
    async status(refresh = false) {
      if (refresh) signedOut = 0;
      const found = await info(refresh);
      if (found.available && signedOut && Date.now() - signedOut < 30 * 60 * 1000) return { available: false, detail: SIGNED_OUT, signedOut: true };
      const { model } = getSettings().ai;
      return { available: found.available, detail: found.available ? `Codex ${found.version.replace(/^codex(-cli)?\s*/i, '')}${model ? ` · ${model}` : ''}` : NOT_FOUND };
    },
    // One prompt in, one JSON object (matching schema) out.
    async ask({ system, prompt, schema, signal }) {
      const found = await info();
      if (!found.available) throw new Error(NOT_FOUND);
      const { ai } = getSettings();
      const effort = effortFor('codex-cli', ai.model, ai.effort);
      const input = `${system}\n\n${NO_TOOLS}\n\n${prompt}`;
      let result = await execute(found.command, codexArgs({ model: ai.model, effort }), { input, schema, signal });
      // Older Codex releases lack some of these flags; retry with the basics.
      if (result.code !== 0 && /unexpected argument|unknown option|unrecognized/i.test(result.stderr)) {
        result = await execute(found.command, codexArgs({ model: ai.model, effort, basic: true }), { input, schema, signal });
      }
      const reply = result.output.trim() || (result.code === 0 ? result.stdout.trim() : '');
      if (!reply) {
        if (SIGNED_OUT_REPLY.test(result.stderr)) { signedOut = Date.now(); throw new Error(SIGNED_OUT); }
        const last = result.stderr.trim().split('\n').filter(Boolean).pop() || 'no output';
        throw new Error(`Codex exited with ${result.code}: ${last}`.slice(0, 400));
      }
      signedOut = 0;
      return { value: parseJsonText(reply), provider: 'codex-cli', model: ai.model || null };
    },
    async score({ resume, posting, signal }) {
      const { ai } = getSettings();
      const reply = await this.ask({ system: SYSTEM_PROMPT, prompt: buildUserPrompt({ resume, posting, language: ai.language }), schema: SCORE_SCHEMA, signal });
      return { ...normalizeScore(reply.value), provider: reply.provider, model: reply.model };
    },
  };
}
