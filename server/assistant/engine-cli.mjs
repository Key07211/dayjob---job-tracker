import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { needsShell, stopProcess } from '../jobs/scoring/cli-process.mjs';
import { detectClaude } from '../jobs/scoring/claude-cli.mjs';
import { MCP_SERVER_NAME } from './mcp-http.mjs';
import { AssistantError } from './prompt.mjs';

const IDLE_MS = 10 * 60 * 1000;
const QUIET_MS = 4 * 60 * 1000;
const TOOL_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
// How long the probe waits for the user's servers to connect, and how often it asks again while some still are.
const PROBE_MS = 25000;
const PROBE_AGAIN_MS = 1500;
const SIGNED_OUT = /not logged in|\/login|invalid api key|authentication_error/i;
// Claude Code compacts a conversation by itself when it nears its auto-compact window. Dayjob's assistant runs with
// a 200,000-token window (Claude Code then compacts at about 167,000), the same line the Claude API engine keeps:
// a long conversation is read again in full with every message, so the model's whole window is not filled up.
// A window the user set for Claude Code in the environment is left as it is.
export const COMPACT_WINDOW = 200_000;
const COMPACT_LINE = 167_000;
const SUMMARY_MAX = 60000;

// The summary out of the message Claude Code goes on from after compacting. The message opens with a fixed
// sentence and a note on the tools used, then the summary (under "Summary:" when the model tagged it), then
// fixed lines on how to carry on. Whatever does not have that shape is taken whole.
export function summaryFrom(said) {
  let text = String(said || '');
  const ends = [text.indexOf('\nContinue the conversation from where it left off'), text.indexOf('\n\nThe messages after this summary')].filter(at => at >= 0);
  if (ends.length) text = text.slice(0, Math.min(...ends));
  const note = text.indexOf('</system-reminder>\n');
  text = note >= 0 ? text.slice(note + '</system-reminder>\n'.length) : text.replace(/^This session is being continued[^\n]*\n\n/, '');
  return text.replace(/^Summary:\n/, '').trim();
}

// What one conversation's Claude Code process is started with. Built-in tools are off (--tools ""), the only MCP
// server is Dayjob's own (mcp.json, in the process's empty temp folder, with --strict-mcp-config), nothing is saved
// by Claude Code (--no-session-persistence), and only Dayjob's tools may run without asking. Long text travels in
// files, because through a .cmd shim arguments are not quoted for us.
//
// open: a conversation that also uses servers the user's own Claude Code has (the status check reads mail through
// the Gmail connector). Then --strict-mcp-config is left out; the tools of theirs that may run are named beside
// Dayjob's own (--allowedTools), settings.json in the temp folder takes every other tool of theirs away (see
// openSettings), and whatever is left is refused without asking (--permission-mode dontAsk), since nobody is
// there to ask.
export function assistantArgs({ model = '', shell = false, strictMcp = true, open = null } = {}) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', shell ? '""' : '', '--no-session-persistence', '--mcp-config', 'mcp.json'];
  if (open) args.push('--settings', 'settings.json', '--permission-mode', 'dontAsk');
  else if (strictMcp) args.push('--strict-mcp-config');
  // Only plain tool names travel on the command line: nothing in them needs quoting.
  const allowed = [`mcp__${MCP_SERVER_NAME}`, ...(open?.allow || []).filter(name => /^mcp__[\w-]+$/.test(name))];
  args.push('--allowedTools', allowed.join(','), '--system-prompt-file', 'system.txt');
  if (model && /^[\w.:\[\]-]+$/.test(model)) args.push('--model', model);
  return args;
}

// The settings an open conversation's process is started with: deny rules for the tools of the user's own servers.
// A deny rule also takes the tool out of what the model is shown.
export const openSettings = ({ deny = [] } = {}) => ({ permissions: { deny: [...deny] } });

// What the probe is started with: no message is ever sent to it, so no model is called.
export const probeArgs = ({ shell = false } = {}) => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--tools', shell ? '""' : '', '--no-session-persistence', '--mcp-config', 'mcp.json'];

// This turn's token counts from a result line: per model since the last result when the CLI reports that, else the totals.
export function resultUsage(result) {
  const models = Object.values(result?.model_usage_since_last_result || {});
  if (models.length) {
    const sum = key => models.reduce((total, entry) => total + (Number(entry?.[key]) || 0), 0);
    return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadInputTokens'), cacheWriteTokens: sum('cacheCreationInputTokens') };
  }
  const usage = result?.usage;
  if (!usage) return null;
  return { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheWriteTokens: usage.cache_creation_input_tokens || 0 };
}

// The assistant on the user's signed-in Claude Code, so no API key is needed. Each conversation gets its own
// long-running `claude -p` process that takes one JSON line per message and answers with a stream of JSON lines;
// the process holds the conversation while it runs, and Dayjob's tools reach it over MCP at mcpUrl().
export function createCliEngine({ getSettings, mcpUrl, spawn = nodeSpawn, detect = detectClaude, stop = stopProcess, idleMs = IDLE_MS, quietMs = QUIET_MS, probeMs = PROBE_MS, probeAgainMs = PROBE_AGAIN_MS, tmpdir = os.tmpdir, env = process.env }) {
  const sessions = new Map();
  // The probes that are still asking (see servers), each as the call that ends it.
  const probes = new Set();
  let cached = null;
  async function info(refresh = false) {
    const configured = getSettings().ai.claudeCommand || '';
    if (!cached || refresh || cached.configured !== configured) cached = { configured, result: await detect(configured) };
    return cached.result;
  }

  function end(id, session = sessions.get(id)) {
    if (!session) return;
    if (sessions.get(id) === session) sessions.delete(id);
    clearTimeout(session.idle);
    clearTimeout(session.quiet);
    if (!session.closed) {
      session.closed = true;
      try { session.child.stdin.end(); } catch { /* already closed */ }
      stop(session.child);
    }
    try { fs.rmSync(session.cwd, { recursive: true, force: true }); } catch { /* still in use; the OS temp folder clears it */ }
  }

  // A Dayjob that was ended by force leaves its conversations' temp folders behind. Once per run the old ones are
  // cleared: only folders with this engine's own name, a day old or more, holding nothing but the files written here.
  let swept = false;
  function sweep() {
    swept = true;
    try {
      const root = tmpdir();
      for (const name of fs.readdirSync(root)) {
        if (!/^dayjob-assistant-[A-Za-z0-9]{6}$/.test(name)) continue;
        const folder = path.join(root, name);
        const stat = fs.statSync(folder, { throwIfNoEntry: false });
        if (!stat?.isDirectory() || Date.now() - stat.mtimeMs < STALE_MS) continue;
        if ([...sessions.values()].some(session => session.cwd === folder)) continue;
        if (fs.readdirSync(folder).some(file => !['mcp.json', 'system.txt', 'settings.json'].includes(file))) continue;
        fs.rmSync(folder, { recursive: true, force: true });
      }
    } catch { /* tidying up is optional */ }
  }

  function start(id, { system, model, token, found, strictMcp = true, open = null }) {
    if (!swept) sweep();
    const cwd = fs.mkdtempSync(path.join(tmpdir(), 'dayjob-assistant-'));
    fs.writeFileSync(path.join(cwd, 'mcp.json'), JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl(), headers: { Authorization: `Bearer ${token}` } } } }));
    fs.writeFileSync(path.join(cwd, 'system.txt'), system);
    if (open) fs.writeFileSync(path.join(cwd, 'settings.json'), JSON.stringify(openSettings(open)));
    const shell = needsShell(found.command);
    // A tool call can wait on the user for minutes (the card that asks before an application is sent).
    const child = spawn(found.command, assistantArgs({ model, shell, strictMcp, open }), { cwd, windowsHide: true, shell,
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(COMPACT_WINDOW), ...env, MCP_TOOL_TIMEOUT: String(TOOL_MS) } });
    // context: the size of the conversation in tokens at its last reply; line: the size it is compacted at, when
    // the window is Dayjob's and the user's environment does not move it; boundary: a compaction Claude Code has announced, waiting for the summary that follows it.
    const session = { child, cwd, token, model, strictMcp, turn: null, buffer: '', stderr: '', closed: false, idle: null, quiet: null, served: model || null,
      context: 0, line: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ? null : COMPACT_LINE, boundary: null };
    sessions.set(id, session);
    const fail = error => {
      const turn = session.turn;
      session.turn = null;
      end(id, session);
      turn?.reject(error);
    };
    child.stdout.on('data', chunk => {
      session.buffer += chunk;
      let newline;
      while ((newline = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, newline).trim();
        session.buffer = session.buffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        try { handle(id, session, event); } catch (error) { fail(error); }
      }
    });
    child.stderr.on('data', chunk => { session.stderr = (session.stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', error => fail(new AssistantError('no-cli', `Claude Code could not be started: ${error.message}`)));
    child.on('close', code => {
      session.closed = true;
      const said = session.stderr.trim().split('\n').pop() || '';
      fail(session.strictMcp && /strict-mcp-config/i.test(session.stderr) ? Object.assign(new AssistantError('strict-mcp', said), { retryLoose: true })
        : /unknown option|unexpected argument/i.test(session.stderr) ? new AssistantError('old-cli', 'This Claude Code is too old for the assistant. Update Claude Code and try again.')
          : SIGNED_OUT.test(session.stderr) ? new AssistantError('signed-out', 'Claude Code is not signed in. Run claude in a terminal and type /login.')
            : new AssistantError('cli-exit', `Claude Code stopped (${code ?? 'no code'})${said ? `: ${said}` : ''}`.slice(0, 400)));
    });
    return session;
  }

  // A reply that goes silent for minutes is given up on, so the pane never waits forever.
  function watch(id, session) {
    clearTimeout(session.quiet);
    session.quiet = setTimeout(() => {
      const waiting = session.turn;
      session.turn = null;
      end(id, session);
      waiting?.reject(new AssistantError('quiet', 'Claude Code stopped responding.'));
    }, quietMs);
    session.quiet.unref?.();
  }

  // A compaction Claude Code announced is passed on once its summary is known (or plainly is not coming).
  function settle(session, turn, summary = '') {
    const boundary = session.boundary;
    if (!boundary) return;
    session.boundary = null;
    turn.onCompact({ ...boundary, summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}…` : summary });
  }

  // What each message of a reply used, for the step it is. The stream says it in pieces: message_start what went
  // in, message_delta what came out, and the whole message says it once more; a later line never says less.
  // A message is passed on as a step when it ends, or when the next one begins.
  const STEP_KEYS = { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_input_tokens', cacheWriteTokens: 'cache_creation_input_tokens' };
  function noteUsage(turn, id, used, model) {
    if (!id || !used) return;
    const step = turn.steps.get(id) || { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: null, sent: false };
    for (const [key, theirs] of Object.entries(STEP_KEYS)) step.usage[key] = Math.max(step.usage[key], Number(used[theirs]) || 0);
    if (model) step.model = model;
    turn.steps.set(id, step);
  }
  function passSteps(session, turn, { only = null, but = null } = {}) {
    for (const [id, step] of turn.steps) {
      if (step.sent || (only && id !== only) || id === but) continue;
      step.sent = true;
      turn.onStep({ kind: 'reply', model: step.model || session.served, usage: step.usage });
    }
  }

  // One line of the CLI's stream. Text arrives as deltas (stream_event); a whole assistant message follows each
  // one and is only used for text that never came as deltas.
  //
  // When Claude Code compacts the conversation it says so in four lines: a status "compacting", a status with how
  // it went, a compact_boundary (why, and the size before and after), and the message the conversation goes on
  // from, which holds the summary it wrote.
  function handle(id, session, event) {
    const turn = session.turn;
    if (!turn) return;
    watch(id, session);
    if (event.type === 'system') {
      if (event.subtype === 'init') {
        if (event.model) session.served = event.model;
        const server = (event.mcp_servers || []).find(item => item.name === MCP_SERVER_NAME);
        if (server && server.status === 'failed') throw new AssistantError('mcp-failed', 'Claude Code could not connect to Dayjob\'s tools.');
      } else if (event.subtype === 'status' && event.status === 'requesting') { turn.onRound(); turn.onThinking(); }
      else if (event.subtype === 'status' && event.status === 'compacting') turn.onCompacting('auto');
      else if (event.subtype === 'status' && event.compact_result && event.compact_result !== 'success') turn.onThinking();
      else if (event.subtype === 'compact_boundary') {
        const meta = event.compact_metadata || {};
        session.boundary = { trigger: meta.trigger === 'manual' ? 'manual' : 'auto', before: Number(meta.pre_tokens) || null, after: Number(meta.post_tokens) || null };
        if (session.boundary.after) session.context = session.boundary.after;
      }
      return;
    }
    if (event.type === 'user') {
      const content = event.message?.content;
      // The result of an outside tool: its name and whether it worked are passed on, nothing of what went in or
      // came back. A tool that Claude Code refused to run comes back as an error too.
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== 'tool_result' || !turn.outside.has(block.tool_use_id)) continue;
        const name = turn.outside.get(block.tool_use_id);
        turn.outside.delete(block.tool_use_id);
        turn.onOutside(name, !block.is_error);
      }
      // Besides that only the message that follows a compaction matters here: the summary sits between two fixed lines.
      if (!session.boundary) return;
      const said = typeof content === 'string' ? content : (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      settle(session, turn, summaryFrom(said));
      return;
    }
    settle(session, turn);
    if (event.type === 'stream_event') {
      const inner = event.event || {};
      if (inner.type === 'message_start') {
        turn.message = inner.message?.id || null;
        passSteps(session, turn, { but: turn.message });
        if (inner.message?.model !== '<synthetic>') noteUsage(turn, turn.message, inner.message?.usage, inner.message?.model);
      } else if (inner.type === 'message_delta') { if (turn.steps.has(turn.message)) noteUsage(turn, turn.message, inner.usage); }
      else if (inner.type === 'message_stop') passSteps(session, turn, { only: turn.message });
      else if (inner.type === 'content_block_start' && inner.content_block?.type === 'thinking') turn.onThinking();
      else if (inner.type === 'content_block_delta') {
        if (inner.delta?.type === 'text_delta' && inner.delta.text) {
          if (turn.message) turn.streamed.add(turn.message);
          turn.onText(inner.delta.text);
        } else if (inner.delta?.type === 'thinking_delta') turn.onThinking();
      }
      return;
    }
    if (event.type === 'assistant') {
      const message = event.message || {};
      if (message.model && message.model !== '<synthetic>') session.served = message.model;
      const used = message.usage;
      if (used && message.model !== '<synthetic>') session.context = (used.input_tokens || 0) + (used.cache_read_input_tokens || 0) + (used.cache_creation_input_tokens || 0) + (used.output_tokens || 0);
      if (used && message.model !== '<synthetic>') {
        // Without the stream's own lines this is all that says what a message used: the one before it is over.
        passSteps(session, turn, { but: message.id });
        if (!turn.steps.get(message.id)?.sent) noteUsage(turn, message.id, used, message.model);
      }
      // A tool of one of the user's own servers (an open conversation only): Claude Code runs it itself, so this
      // line and the one with its result are all Dayjob learns of it. Its name is kept until the result comes.
      for (const block of message.content || []) {
        if (block.type === 'tool_use' && block.id && typeof block.name === 'string' && !block.name.startsWith(`mcp__${MCP_SERVER_NAME}__`)) turn.outside.set(block.id, block.name);
      }
      if (turn.streamed.has(message.id)) return;
      for (const block of message.content || []) if (block.type === 'text' && block.text) turn.onText(block.text);
      return;
    }
    if (event.type === 'result') {
      clearTimeout(session.quiet);
      session.turn = null;
      passSteps(session, turn);
      if (event.is_error) {
        const said = String(event.result || event.subtype || 'error');
        end(id, session);
        turn.reject(SIGNED_OUT.test(said) ? new AssistantError('signed-out', 'Claude Code is not signed in. Run claude in a terminal and type /login.')
          : new AssistantError('cli-error', `Claude Code: ${said.slice(0, 300)}`));
        return;
      }
      session.idle = setTimeout(() => end(id, session), idleMs);
      session.idle.unref?.();
      turn.resolve({ usage: resultUsage(event), model: session.served, rounds: Number(event.num_turns) || 1,
        context: session.context ? { tokens: session.context, limit: session.line } : null });
    }
  }

  function ask(id, session, { text, onText, onThinking, onRound, onCompacting = () => {}, onCompact = () => {}, onStep = () => {}, onOutside = () => {}, signal }) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        session.turn = null;
        end(id, session);
        reject(signal.reason || new Error('Stopped.'));
      };
      const done = work => value => { signal?.removeEventListener('abort', abort); work(value); };
      clearTimeout(session.idle);
      session.turn = { resolve: done(resolve), reject: done(reject), onText, onThinking, onRound, onCompacting, onCompact, onStep, onOutside, message: null, streamed: new Set(), steps: new Map(), outside: new Map() };
      signal?.addEventListener('abort', abort, { once: true });
      watch(id, session);
      session.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
      onRound();
      onThinking();
    });
  }

  return {
    id: 'claude-cli',
    async status(refresh = false) {
      const found = await info(refresh);
      return found.available ? { available: true, detail: `Claude Code ${String(found.version || '').replace(/\s*\(Claude Code\)\s*$/, '')}`.trim() }
        : { available: false, detail: 'Claude Code was not found. Install it and sign in, or set its path under Resume & AI.' };
    },
    live: id => sessions.has(id),
    // While one of Dayjob's tools runs for this conversation, the quiet watch stands still: the tool may be waiting
    // on the user. It starts over when the tool is done.
    hold(id, on) {
      const session = sessions.get(id);
      if (!session?.turn) return;
      if (on) clearTimeout(session.quiet); else watch(id, session);
    },
    close: id => end(id),
    closeAll() {
      for (const id of [...sessions.keys()]) end(id);
      for (const finish of [...probes]) finish(null);
    },
    // The servers the user's own Claude Code has, each with its state and the names of its tools:
    // [{ name, status: 'connected' | 'needs-auth' | 'failed' | 'pending' | …, tools: [name] }]. Claude Code is started
    // for this and asked (a control request); no message is sent, so no model is called. null when this Claude Code
    // does not answer the question (an older one), or did not in time.
    async servers({ signal } = {}) {
      const found = await info();
      if (!found.available) throw new AssistantError('no-cli', 'Claude Code was not found. Install it and sign in, or set its path under Resume & AI.');
      if (signal?.aborted) throw signal.reason || new Error('Stopped.');
      const cwd = fs.mkdtempSync(path.join(tmpdir(), 'dayjob-assistant-'));
      fs.writeFileSync(path.join(cwd, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
      const shell = needsShell(found.command);
      const child = spawn(found.command, probeArgs({ shell }), { cwd, windowsHide: true, shell, env: { ...env } });
      return new Promise(resolve => {
        let buffer = '';
        let asked = 0;
        let last = null;
        let again = null;
        let over = false;
        const finish = value => {
          if (over) return;
          over = true;
          probes.delete(finish);
          clearTimeout(deadline);
          clearTimeout(again);
          signal?.removeEventListener('abort', stopped);
          try { child.stdin.end(); } catch { /* already closed */ }
          stop(child);
          try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* the OS temp folder clears it */ }
          resolve(value);
        };
        const stopped = () => finish(null);
        const query = () => {
          asked += 1;
          try { child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `servers-${asked}`, request: { subtype: 'mcp_status' } })}\n`); } catch { finish(last); }
        };
        const deadline = setTimeout(() => finish(last), probeMs);
        probes.add(finish);
        signal?.addEventListener('abort', stopped, { once: true });
        child.stdin.on('error', () => {});
        child.on('error', () => finish(null));
        child.on('close', () => finish(last));
        child.stdout.on('data', chunk => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            if (event.type !== 'control_response') continue;
            const list = event.response?.response?.mcpServers;
            // An answer that is no list: this Claude Code does not know the question.
            if (!Array.isArray(list)) { finish(null); return; }
            last = list.filter(item => item && typeof item.name === 'string').map(item => ({ name: item.name, status: String(item.status || ''),
              tools: (Array.isArray(item.tools) ? item.tools : []).map(tool => tool?.name).filter(name => typeof name === 'string') }));
            // Servers that are still connecting are asked about again in a moment.
            if (last.some(item => item.status === 'pending')) again = setTimeout(query, probeAgainMs); else finish(last);
          }
        });
        query();
      });
    },
    // The token in a tool request names the conversation whose process sent it.
    conversationFor(token) {
      for (const [id, session] of sessions) if (session.token === token) return id;
      return null;
    },
    // onCompacting / onCompact: Claude Code has started compacting the conversation / has done so
    // ({ trigger, summary, before, after }; the summary is empty when it did not say what it wrote).
    // onStep: what one message of the reply used ({ kind, model, usage }), as each one ends.
    // open: { allow, deny } for a conversation that also uses the user's own servers (see assistantArgs).
    // onOutside(name, ok): a tool of the user's own servers that the reply used, and whether it worked (an open conversation only).
    async send({ id, text, system, model, onText, onThinking, onRound, onCompacting, onCompact, onStep, onOutside, signal, open = null }) {
      if (signal?.aborted) throw signal.reason || new Error('Stopped.');
      const found = await info();
      if (!found.available) throw new AssistantError('no-cli', 'Claude Code was not found. Install it and sign in, or set its path under Resume & AI.');
      let session = sessions.get(id);
      const fresh = !session;
      if (fresh) session = start(id, { system, model, token: randomBytes(24).toString('hex'), found, open });
      try {
        return await ask(id, session, { text, onText, onThinking, onRound, onCompacting, onCompact, onStep, onOutside, signal });
      } catch (error) {
        // Some company-managed setups refuse --strict-mcp-config; there the conversation runs with the user's other servers present but not allowed.
        if (!fresh || !error.retryLoose || signal?.aborted) throw error;
        session = start(id, { system, model, token: session.token, found, strictMcp: false });
        return ask(id, session, { text, onText, onThinking, onRound, onCompacting, onCompact, onStep, onOutside, signal });
      }
    },
  };
}
