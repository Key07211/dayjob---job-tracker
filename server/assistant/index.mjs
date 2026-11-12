import { randomUUID } from 'node:crypto';
import { HttpError, readJson, respond } from '../http.mjs';
import { CLAUDE_MODELS, PROVIDERS } from '../jobs/scoring/models.mjs';
import { createApiEngine } from './engine-api.mjs';
import { createCliEngine } from './engine-cli.mjs';
import { handleMcp } from './mcp-http.mjs';
import { AssistantError, SYSTEM_PROMPT, transcript, withNotes } from './prompt.mjs';
import { createConversationStore } from './store.mjs';
import { createTools } from './tools.mjs';

export const ENGINES = ['claude-cli', 'anthropic-api'];
const MAX_LIVE = 8;
const MAX_TEXT = 8000;
const RESULT_CAP = 60000;
const SUMMARY_CAP = 1500;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}… [cut]` : text);
const titleOf = text => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > 40 ? `${line.slice(0, 40)}…` : line; };

// The assistant in the Dayjob window: conversations, the two engines that can run them, and the tools they share.
//
// A conversation lives in memory. It is written to the database only while the user has "keep this conversation"
// on; switching that off, or deleting the conversation, removes it again. Each engine holds its own working copy
// while it runs (a Claude Code process, or the message list for the Claude API); whenever that copy is missing
// (a kept conversation reopened, the engine switched, the process gone) the turns kept here are handed over as text.
export function createAssistant({ db, repo, scheduler, goals, dashboard, status, scoreIfSaved, baseUrl, engines, now = () => new Date(), log = console.warn }) {
  const tools = createTools({ db, repo, scheduler, goals, dashboard, status, scoreIfSaved, now });
  const store = createConversationStore(db);
  const getSettings = () => repo.getSettings();
  const available = engines || {
    'claude-cli': createCliEngine({ getSettings, mcpUrl: () => `${baseUrl()}/api/assistant/mcp` }),
    'anthropic-api': createApiEngine({ getSettings }),
  };
  const conversations = new Map();
  const iso = () => now().toISOString();
  const need = (value, label = 'Conversation') => {
    if (!value) throw new HttpError(404, `${label} not found.`);
    return value;
  };

  function settings() {
    const saved = repo.getMeta('assistant') || {};
    const model = id => (typeof saved.models?.[id] === 'string' ? saved.models[id] : '');
    return { engine: ENGINES.includes(saved.engine) ? saved.engine : 'claude-cli', models: Object.fromEntries(ENGINES.map(id => [id, model(id)])) };
  }
  function saveSettings(input) {
    const current = settings();
    if (input.engine !== undefined && !ENGINES.includes(input.engine)) throw new HttpError(400, `Engine must be one of: ${ENGINES.join(', ')}.`);
    const models = { ...current.models };
    if (input.models !== undefined) {
      if (!input.models || typeof input.models !== 'object' || Array.isArray(input.models)) throw new HttpError(400, 'models must be an object.');
      for (const [id, value] of Object.entries(input.models)) {
        if (!ENGINES.includes(id)) throw new HttpError(400, `Unknown engine ${id}.`);
        if (typeof value !== 'string' || value.length > 100 || (value && !/^[\w.:[\]-]+$/.test(value))) throw new HttpError(400, 'Model must be a model id such as claude-opus-5-5.');
        models[id] = value;
      }
    }
    repo.setMeta('assistant', { engine: input.engine ?? current.engine, models });
    return settings();
  }

  // ---------- conversations ----------
  const revive = row => ({ ...row, kept: true, actions: new Map(), notes: [], flight: null, live: null, engine: null, model: '', usedAt: Date.now() });
  function release(conversation) {
    conversation.flight?.abort();
    for (const engine of Object.values(available)) engine.close(conversation.id);
    conversations.delete(conversation.id);
  }
  // Only a handful stay in memory; the one used longest ago makes room (a kept one is still in the database).
  function trim() {
    const idle = [...conversations.values()].filter(item => !item.flight).sort((a, b) => a.usedAt - b.usedAt);
    while (conversations.size > MAX_LIVE && idle.length) release(idle.shift());
  }
  function create() {
    const at = iso();
    const conversation = { id: randomUUID(), title: '', createdAt: at, updatedAt: at, turns: [], kept: false, actions: new Map(), notes: [], flight: null, live: null, engine: null, model: '', usedAt: Date.now() };
    conversations.set(conversation.id, conversation);
    trim();
    return conversation;
  }
  function load(id) {
    let conversation = conversations.get(id);
    if (!conversation) {
      const row = store.get(id);
      if (!row) return null;
      conversation = revive(row);
      conversations.set(id, conversation);
      trim();
    }
    conversation.usedAt = Date.now();
    return conversation;
  }
  const stored = conversation => ({ id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, turns: conversation.turns });
  const persist = conversation => { if (conversation.kept && conversation.turns.length) store.save(stored(conversation)); };
  // What the pane gets: no tool inputs or results, and whether each change can still be undone.
  const toolView = (conversation, tool) => ({ id: tool.id, name: tool.name, tier: tool.tier, view: tool.view, ok: tool.ok, label: tool.label, error: tool.error, offset: tool.offset,
    undone: Boolean(tool.undone), undoable: Boolean(conversation.actions.get(tool.id) && !tool.undone) });
  const view = conversation => ({ id: conversation.id, title: conversation.title, kept: conversation.kept, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    busy: Boolean(conversation.flight),
    turns: conversation.turns.map(turn => (turn.role === 'user' ? { role: 'user', text: turn.text, at: turn.at }
      : { role: 'assistant', text: turn.text, at: turn.at, engine: turn.engine, model: turn.model || null, stopped: Boolean(turn.stopped), error: turn.error || null, errorCode: turn.errorCode || null,
        usage: turn.usage || null, tools: turn.tools.map(tool => toolView(conversation, tool)) })) });

  // ---------- tools ----------
  async function runTool(conversation, name, input) {
    const live = conversation.live;
    if (!live) return { ok: false, content: JSON.stringify({ error: 'No reply is in progress.' }) };
    const callId = randomUUID().slice(0, 12);
    const tier = tools.get(name)?.tier || 'read';
    live.emit({ type: 'tool', phase: 'start', id: callId, name, tier });
    let outcome;
    try { outcome = await tools.run(name, input); } catch (error) {
      log(`[dayjob] assistant tool ${name}: ${error.stack || error.message}`);
      outcome = { ok: false, error: 'Dayjob could not do that.', tier, view: null };
    }
    const content = clip(JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }), RESULT_CAP);
    const record = { id: callId, name, tier: outcome.tier, view: outcome.view, ok: outcome.ok, label: outcome.label || null, error: outcome.ok ? null : outcome.error,
      input: input ?? {}, summary: clip(content, SUMMARY_CAP), offset: live.turn.text.length, undone: false };
    if (outcome.ok && outcome.undo) conversation.actions.set(callId, outcome.undo);
    live.turn.tools.push(record);
    live.emit({ type: 'tool', phase: 'done', id: callId, tool: toolView(conversation, record), changed: Boolean(outcome.changed), applied: Boolean(outcome.applied), ui: outcome.ui || null });
    return { ok: outcome.ok, content };
  }

  async function undo(conversationId, actionId) {
    const conversation = need(conversations.get(conversationId));
    const record = conversation.turns.flatMap(turn => turn.tools || []).find(tool => tool.id === actionId);
    const action = conversation.actions.get(actionId);
    if (!record || !action || record.undone) throw new HttpError(409, 'This can no longer be undone.');
    await action();
    record.undone = true;
    conversation.actions.delete(actionId);
    conversation.notes.push(`The user has undone this change: ${record.label?.[1] || record.name}.`);
    persist(conversation);
    return view(conversation);
  }

  // ---------- a message and its reply ----------
  // Checks the message before any reply starts, so a bad request is an ordinary error and not half a stream.
  function begin({ conversationId, text }) {
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Type a message first.');
    if (text.length > MAX_TEXT) throw new HttpError(400, `A message can be up to ${MAX_TEXT} characters.`);
    if (conversationId !== undefined && conversationId !== null && typeof conversationId !== 'string') throw new HttpError(400, 'conversationId must be text.');
    const conversation = conversationId ? need(load(conversationId)) : create();
    if (conversation.flight) throw new HttpError(409, 'The assistant is still answering.');
    const controller = new AbortController();
    conversation.flight = controller;
    return { conversation, controller, run: emit => reply(conversation, text.trim(), emit, controller) };
  }

  async function reply(conversation, text, emit, controller) {
    const { engine: engineId, models } = settings();
    const engine = available[engineId];
    const at = iso();
    const earlier = [...conversation.turns];
    conversation.turns.push({ role: 'user', text, at });
    if (!conversation.title) conversation.title = titleOf(text);
    const turn = { role: 'assistant', text: '', tools: [], at, engine: engineId, model: null };
    conversation.turns.push(turn);
    conversation.live = { turn, emit };
    emit({ type: 'start', conversation: { id: conversation.id, title: conversation.title, kept: conversation.kept }, engine: engineId });
    // An engine's copy is dropped when the engine or its model was switched; the new one starts from the turns kept here.
    if (conversation.engine && (conversation.engine !== engineId || conversation.model !== models[engineId])) available[conversation.engine]?.close(conversation.id);
    conversation.engine = engineId;
    conversation.model = models[engineId];
    let message = withNotes(text, conversation.notes.splice(0));
    if (!engine.live(conversation.id) && earlier.length) message = `${transcript(earlier)}\n\n${message}`;
    // Text from separate rounds (before and after a tool) is set apart by a blank line.
    let mark = 0;
    let gap = false;
    const started = Date.now();
    try {
      const outcome = await engine.send({
        id: conversation.id, text: message, system: SYSTEM_PROMPT, model: models[engineId], tools: tools.definitions(), signal: controller.signal,
        callTool: (name, input) => runTool(conversation, name, input),
        onRound() { mark = turn.text.length; gap = turn.text.length > 0; },
        onThinking() { emit({ type: 'thinking' }); },
        onText(delta) {
          const piece = gap ? `\n\n${delta}` : delta;
          gap = false;
          turn.text += piece;
          emit({ type: 'text', delta: piece });
        },
        onDiscard() { turn.text = turn.text.slice(0, mark); emit({ type: 'rewind', text: turn.text }); },
      });
      turn.model = outcome.model || null;
      turn.usage = outcome.usage || null;
      // Counted with the rest of the AI usage where Dayjob records it.
      try { repo.logUsage?.({ kind: 'assistant', provider: engineId, model: outcome.model, usage: outcome.usage, turns: outcome.rounds, durationMs: Date.now() - started }); } catch { /* optional */ }
    } catch (error) {
      if (controller.signal.aborted) {
        turn.stopped = true;
        // Whatever the engine held of the half-made reply is dropped; the next message starts from the turns kept here.
        engine.close(conversation.id);
        conversation.notes.push('The user stopped your previous reply before it finished.');
      } else {
        const known = error instanceof AssistantError;
        if (!known) log(`[dayjob] assistant: ${error.stack || error.message}`);
        turn.error = known ? error.message : 'The assistant ran into a problem. Try again.';
        turn.errorCode = known ? error.code : 'internal';
      }
    } finally {
      conversation.flight = null;
      conversation.live = null;
      conversation.updatedAt = iso();
      conversation.usedAt = Date.now();
      try { persist(conversation); } catch (error) { log(`[dayjob] assistant: could not save the conversation: ${error.message}`); }
    }
    emit({ type: 'end', conversation: view(conversation) });
  }

  // ---------- HTTP ----------
  async function state() {
    const [cli, api] = await Promise.all(ENGINES.map(id => available[id].status()));
    return { settings: settings(), engines: { 'claude-cli': cli, 'anthropic-api': api },
      models: CLAUDE_MODELS.map(model => ({ id: model.id, name: model.name, tag: model.tag || null })),
      defaultModels: Object.fromEntries(ENGINES.map(id => [id, PROVIDERS[id].defaultModel])), kept: store.list(),
      tools: tools.list.map(tool => ({ name: tool.name, tier: tool.tier })) };
  }

  // The reply as lines of JSON, one event each, written as they happen. Closing the request stops the reply.
  async function stream(response, input) {
    const { controller, run } = begin(input);
    let finished = false;
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    response.on('close', () => { if (!finished) controller.abort(); });
    const emit = event => { if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
    try { await run(emit); } finally {
      finished = true;
      response.end();
    }
  }

  // Tool calls from a conversation's Claude Code process. The token was handed to that process alone.
  async function mcp(request, response) {
    const rpcError = (code, message) => respond(response, code, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
    if (request.method !== 'POST') return rpcError(405, 'Method not allowed.');
    const token = /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1] || '';
    const conversation = conversations.get(available['claude-cli'].conversationFor?.(token) || '');
    if (!token || !conversation) return rpcError(401, 'Unknown assistant session.');
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024 * 1024) return rpcError(413, 'The request body is too large.');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return rpcError(400, 'Request body must contain valid JSON.'); }
    return handleMcp({ request, response, body, tools, callTool: (name, input) => runTool(conversation, name, input) });
  }

  async function http({ request, response, pathname, method, authorize }) {
    if (pathname === '/api/assistant/mcp') return mcp(request, response);
    if (request.headers['x-dayjob-client'] === 'mcp') throw new HttpError(403, 'The in-app assistant is used from the Dayjob window only.');
    const match = pathname.match(/^\/api\/assistant\/conversations\/([^/]+)(\/undo|\/keep|\/close)?$/);
    if (method === 'GET') {
      if (pathname === '/api/assistant') return respond(response, 200, await state());
      if (match && !match[2]) return respond(response, 200, view(need(load(match[1]))));
      throw new HttpError(404, 'API endpoint not found.');
    }
    authorize();
    const input = await readJson(request);
    if (pathname === '/api/assistant/chat' && method === 'POST') return stream(response, input);
    if (pathname === '/api/assistant/settings' && method === 'PATCH') return respond(response, 200, saveSettings(input));
    if (match && method === 'POST' && match[2] === '/undo') {
      if (typeof input.actionId !== 'string') throw new HttpError(400, 'actionId is required.');
      return respond(response, 200, await undo(match[1], input.actionId));
    }
    if (match && method === 'POST' && match[2] === '/keep') {
      if (typeof input.keep !== 'boolean') throw new HttpError(400, 'keep must be true or false.');
      const conversation = need(load(match[1]));
      conversation.kept = input.keep;
      if (input.keep) persist(conversation); else store.remove(conversation.id);
      return respond(response, 200, { conversation: view(conversation), kept: store.list() });
    }
    // Leaving a conversation: one that is not kept is forgotten, a kept one only leaves memory.
    if (match && method === 'POST' && match[2] === '/close') {
      const conversation = conversations.get(match[1]);
      if (conversation) release(conversation);
      return respond(response, 200, { ok: true });
    }
    if (match && !match[2] && method === 'DELETE') {
      const conversation = conversations.get(match[1]);
      if (conversation) release(conversation);
      const removed = store.remove(match[1]);
      return respond(response, 200, { ok: Boolean(conversation) || removed, kept: store.list() });
    }
    throw new HttpError(404, 'API endpoint not found.');
  }

  return {
    http, tools, store, settings,
    // For tests and the desktop shell.
    conversations,
    close() {
      for (const conversation of [...conversations.values()]) release(conversation);
      for (const engine of Object.values(available)) engine.closeAll?.();
    },
  };
}
