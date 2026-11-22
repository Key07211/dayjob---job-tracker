import { randomUUID } from 'node:crypto';
import { HttpError, readJson, respond } from '../http.mjs';
import { CLAUDE_MODELS, PROVIDERS } from '../jobs/scoring/models.mjs';
import { costOf } from '../jobs/scoring/prices.mjs';
import { createApiEngine } from './engine-api.mjs';
import { createCliEngine } from './engine-cli.mjs';
import { handleMcp } from './mcp-http.mjs';
import { AssistantError, SUMMARISE_MAX, SYSTEM_PROMPT, compactPrompt, cutFor, handover, isMarker, lastSummary, summaryOf, withNotes } from './prompt.mjs';
import { createConversationStore } from './store.mjs';
import { createMemory, MEMORY_EMPTY } from './memory.mjs';
import { createFeedback, scrub, sumSteps } from './feedback.mjs';
import { APPLY_STEPS, createTools } from './tools.mjs';
import { CHECK_STATUSES, CHECK_TOOLS, PAGE_TOOLS, checkNote, createCheckStore, mailRules, mailSince, pagesFor } from './check.mjs';
import { localDay, scheduledAt } from '../jobs/scheduler.mjs';
import { message } from '../messages.mjs';

export const ENGINES = ['claude-cli', 'anthropic-api'];
// Sending an application: 'confirm' waits for the user on a card in the chat; 'takeover' lets the assistant send it.
export const APPLY_MODES = ['confirm', 'takeover'];
const MODE_NOTES = {
  confirm: 'Apply mode: manual confirm. A click that sends an application waits for the user on a card in the chat.',
  takeover: 'Apply mode: full takeover. The user has let you send applications without asking each time.',
};
// 同时申请: how many applications the assistant works on at the same time (the rest wait their turn), and how many
// it keeps in its list before the oldest that are over make room.
export const PARALLEL = { min: 1, max: 5, default: 3 };
const MAX_RUNS = 40;
const MAX_LIVE = 8;
const MAX_TEXT = 8000;
const MAX_FOCUS = 1000;
const RESULT_CAP = 60000;
const SUMMARY_CAP = 1500;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}… [cut]` : text);
const titleOf = text => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > 40 ? `${line.slice(0, 40)}…` : line; };

// The assistant in the Dayjob window: conversations, the two engines that can run them, and the tools they share.
//
// A conversation lives in memory. It is written to the database only while the user has "keep this conversation"
// on; switching that off, or deleting the conversation, removes it again. Archiving keeps a conversation and puts
// it away from the list of kept ones until it is taken back out. Each engine holds its own working copy
// while it runs (a Claude Code process, or the message list for the Claude API); whenever that copy is missing
// (a kept conversation reopened, the engine switched, the process gone) the turns kept here are handed over as text.
//
// A long conversation is compacted the way Claude Code does it: the model writes a summary of it, and from then on
// the engine works from the summary and what came after. The turns stay in the pane; a marker among them
// ({ role: 'compact', summary, trigger, at }) says where it happened and carries the summary. It happens
// - when the user asks (the button in the pane, or "/compact" and what to keep an eye on),
// - by itself when the engine's copy nears its limit (the Claude API engine does it between two requests, Claude
//   Code does it in its own process; both report it here),
// - by itself when a conversation with no engine copy is too long to hand over whole: the older turns are
//   summarised once, instead of being left out.
//
// 同时申请: an application can have a conversation of its own (conversation.run), started from a job in the Today
// list or by the assistant in another conversation. Such a conversation's reply runs in the background, in a
// browser tab of its own: nobody has to keep the pane on it, and the pane can look in and leave again (/live).
// Only a few are worked on at once; the others wait in line.
//
// Every request a reply makes to the model is a step of it. What each step used is kept with the reply
// (turn.steps), written to the database, and shown in the pane. After a reply that worked on an application,
// Dayjob adds an entry to the feedback file (feedback.mjs): how it ended, why, and what got in the way.
//
// browser: the desktop app's Dayjob browser ({ run(action, input, context), endRun(key, options) }), which the
// applying tools work in; without it (plain `npm start`) those tools are not offered.
// feedbackDir: the folder the feedback file lives in (none: its entries are only held in memory).
// companies: { find, follow } from the app, which look a company's own job board up and put it on the daily list.
export function createAssistant({ db, repo, scheduler, goals, dashboard, status, scoreIfSaved, scoreAdded, baseUrl, engines, browser = null, companies = null, letters = null, onSettings = () => {}, feedbackDir = null, notify = () => {}, now = () => new Date(), log = console.warn }) {
  const memory = createMemory(repo, now);
  const english = () => repo.getSettings().language === 'en';
  const feedback = createFeedback({ dir: feedbackDir, english, now, log });
  const tools = createTools({ db, repo, scheduler, goals, dashboard, status, scoreIfSaved, scoreAdded, now, browser, companies, letters, onSettings, memory, applyMode: () => settings().apply,
    applications: { start: (ids, context) => startMany(ids, context), list: () => runList().map(runView) } });
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
    return { engine: ENGINES.includes(saved.engine) ? saved.engine : 'claude-cli', models: Object.fromEntries(ENGINES.map(id => [id, model(id)])),
      apply: APPLY_MODES.includes(saved.apply) ? saved.apply : 'confirm',
      parallel: Number.isInteger(saved.parallel) && saved.parallel >= PARALLEL.min && saved.parallel <= PARALLEL.max ? saved.parallel : PARALLEL.default };
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
    if (input.apply !== undefined && !APPLY_MODES.includes(input.apply)) throw new HttpError(400, `apply must be one of: ${APPLY_MODES.join(', ')}.`);
    if (input.parallel !== undefined && !(Number.isInteger(input.parallel) && input.parallel >= PARALLEL.min && input.parallel <= PARALLEL.max)) {
      throw new HttpError(400, `parallel must be a whole number from ${PARALLEL.min} to ${PARALLEL.max}.`);
    }
    repo.setMeta('assistant', { engine: input.engine ?? current.engine, models, apply: input.apply ?? current.apply, parallel: input.parallel ?? current.parallel });
    // More room at once: the applications that were waiting for it start.
    if (input.parallel !== undefined) pump();
    return settings();
  }

  // ---------- conversations ----------
  const revive = row => ({ ...row, kept: true, actions: new Map(), notes: [], memo: {}, flight: null, live: null, engine: null, model: '', usedAt: Date.now(), run: null, check: null, pin: null, listeners: new Set() });
  function release(conversation) {
    conversation.flight?.abort();
    for (const engine of Object.values(available)) engine.close(conversation.id);
    conversations.delete(conversation.id);
    // What it had open in the Dayjob browser is the user's from here on.
    try { browser?.endRun?.(conversation.id, { forgotten: true }); } catch { /* the browser is gone */ }
  }
  // Only a handful stay in memory; the one used longest ago makes room (a kept one is still in the database).
  // The applications in the list are not counted here: they leave when they are taken off it. Nor is the last
  // status check, which stays until the next one so that what it changed can be taken back.
  function trim() {
    const plain = [...conversations.values()].filter(item => !item.run && !item.check);
    const idle = plain.filter(item => !item.flight).sort((a, b) => a.usedAt - b.usedAt);
    for (let over = plain.length - MAX_LIVE; over > 0 && idle.length; over -= 1) release(idle.shift());
  }
  function create() {
    const at = iso();
    const conversation = { id: randomUUID(), title: '', createdAt: at, updatedAt: at, archivedAt: null, turns: [], kept: false, actions: new Map(), notes: [], memo: {}, flight: null, live: null, engine: null, model: '', usedAt: Date.now(), run: null, check: null, pin: null, listeners: new Set() };
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
  const stored = conversation => ({ id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    archivedAt: conversation.archivedAt, turns: conversation.turns });
  const persist = conversation => { if (conversation.kept && conversation.turns.length) store.save(stored(conversation)); };
  // Something to compact: an answered message since the last summary.
  const compactable = conversation => conversation.turns.slice(lastSummary(conversation.turns) + 1).some(turn => turn.role === 'assistant' && (turn.text || turn.tools?.length));
  const markerView = turn => ({ role: 'compact', at: turn.at, trigger: turn.trigger, summary: turn.summary || '', before: turn.before ?? null, after: turn.after ?? null });
  // What the pane gets: no tool inputs or results, and whether each change can still be undone. An applying tool
  // also says which step of the application it was (step), a few plain facts for the card that asks before sending
  // (facts: the job, the resume's name, how many fields), and, for a cover letter, the letter itself (detail).
  const toolView = (conversation, tool) => ({ id: tool.id, name: tool.name, tier: tool.tier, view: tool.view, ok: tool.ok, label: tool.label, error: tool.error, offset: tool.offset,
    undone: Boolean(tool.undone), undoable: Boolean(conversation.actions.get(tool.id) && !tool.undone),
    ...(tool.step ? { step: tool.step } : {}), ...(tool.facts ? { facts: tool.facts } : {}), ...(tool.detail ? { detail: tool.detail } : {}), ...(tool.stepNo ? { stepNo: tool.stepNo } : {}) });
  // 同时申请: an application with a conversation of its own, as the list in the window shows it.
  // state: queued (waiting its turn) | working | done. outcome: how its last reply ended (the names in feedback.mjs),
  // reason: a line on why it was not sent. steps, tokens, cost: what it has used so far, every reply together.
  const runView = conversation => {
    const run = conversation.run;
    if (!run) return null;
    return { id: conversation.id, postingId: run.postingId, job: run.job, state: run.state, outcome: run.outcome, reason: run.reason, at: run.at, startedAt: run.startedAt, endedAt: run.endedAt,
      parent: run.parent, steps: run.used.steps, tokens: run.used.inputTokens + run.used.cacheReadTokens + run.used.cacheWriteTokens + run.used.outputTokens, cost: run.used.cost };
  };
  const runList = () => [...conversations.values()].filter(item => item.run);
  // context: how large the engine's copy was at its last reply ({ tokens, limit }, limit being the size it is
  // compacted at), or null when no engine holds the conversation.
  const view = conversation => ({ id: conversation.id, title: conversation.title, kept: conversation.kept, archivedAt: conversation.archivedAt || null,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, busy: Boolean(conversation.flight),
    context: conversation.context || null, compactable: compactable(conversation), run: runView(conversation), check: Boolean(conversation.check),
    turns: conversation.turns.map(turn => (isMarker(turn) ? markerView(turn) : turn.role === 'user' ? { role: 'user', text: turn.text, at: turn.at }
      : { role: 'assistant', text: turn.text, at: turn.at, engine: turn.engine, model: turn.model || null, stopped: Boolean(turn.stopped), error: turn.error || null, errorCode: turn.errorCode || null,
        usage: turn.usage || null, steps: turn.steps || [], tools: turn.tools.map(tool => toolView(conversation, tool)) })) });

  // ---------- tools ----------
  async function runTool(conversation, name, input) {
    const live = conversation.live;
    if (!live) return { ok: false, content: JSON.stringify({ error: 'No reply is in progress.' }) };
    const callId = randomUUID().slice(0, 12);
    const tier = tools.get(name)?.tier || 'read';
    live.emit({ type: 'tool', phase: 'start', id: callId, name, tier });
    let outcome;
    // 申请状态检查: only its own few tools, and of an application only what a check may record.
    const refused = conversation.check ? checkRefuses(conversation, name, input) : null;
    // A tool may wait on the user (the card that asks before an application is sent): the engine does not take
    // that silence for a reply gone quiet.
    const engine = available[conversation.engine];
    engine?.hold?.(conversation.id, true);
    // run: whose step in the Dayjob browser this is. An application with a conversation of its own works in a tab
    // of its own (own); any other conversation works in the tab on show.
    const context = { signal: conversation.flight?.signal, memo: conversation.memo, conversationId: conversation.id, check: Boolean(conversation.check),
      run: { key: conversation.id, own: Boolean(conversation.run || conversation.check), job: conversation.run?.job || (conversation.check ? conversation.title : '') } };
    // The step of the reply that asked for this tool: the request made last.
    const step = live.turn.steps?.at(-1) || null;
    step?.tools.push(name);
    try { outcome = refused ? { ok: false, error: refused, tier, view: null } : await tools.run(name, input, context); } catch (error) {
      log(`[dayjob] assistant tool ${name}: ${error.stack || error.message}`);
      outcome = { ok: false, error: 'Dayjob could not do that.', tier, view: null };
    } finally { engine?.hold?.(conversation.id, false); }
    const content = clip(JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }), RESULT_CAP);
    // A reading of a page comes with the line that stands for it once it is old: in the engine's copy when newer
    // readings have come, and in the turns kept here, which are what a conversation is handed over from.
    const stale = outcome.ok && outcome.stale ? JSON.stringify(outcome.stale) : null;
    const record = { id: callId, name, tier: outcome.tier, view: outcome.view, ok: outcome.ok, label: outcome.label || null, error: outcome.ok ? null : outcome.error,
      input: input ?? {}, summary: stale || clip(content, SUMMARY_CAP), offset: live.turn.text.length, undone: false, ...(step ? { stepNo: step.n } : {}),
      ...(outcome.ok && outcome.step ? { step: outcome.step } : {}), ...(outcome.ok && outcome.facts ? { facts: outcome.facts } : {}), ...(outcome.ok && outcome.detail ? { detail: outcome.detail } : {}) };
    if (outcome.ok && outcome.undo) conversation.actions.set(callId, outcome.undo);
    live.turn.tools.push(record);
    live.emit({ type: 'tool', phase: 'done', id: callId, tool: toolView(conversation, record), changed: Boolean(outcome.changed), applied: Boolean(outcome.applied), ui: outcome.ui || null });
    return { ok: outcome.ok, content, ...(stale ? { stale } : {}) };
  }

  // The groups of tools a conversation plainly needs from its first request (the others load when the model asks,
  // see engine-api.mjs): the ones its earlier turns used, and the ones the new message is about. A wrong guess
  // costs little either way: one call to load a group, or a group that came along unused.
  const WANTS = {
    apply: /投|申请|应聘|网申|浏览器|网页|网站|页面|链接|登录|注册|求职信|表单|读取|加进|加入|加到|添加|handshake|apply|application|browser|web ?page|website|\bsite\b|\bform\b|sign[ -]?(in|up)|log[ -]?in|cover letter|https?:\/\/|www\.|\badd\b.*\bjobs?\b|\bjobs? (on|from)\b/i,
    searches: /搜索|关键词|抓取|公司|关注|招聘页|search|keyword|fetch|compan|follow|job board|greenhouse|lever|ashby/i,
  };
  function preload(conversation, text) {
    const groups = tools.groups();
    const used = new Set(conversation.turns.flatMap(turn => turn.tools || []).map(tool => tool.name));
    return Object.keys(groups).filter(group => WANTS[group]?.test(text) || groups[group].tools.some(name => used.has(name)));
  }

  async function undo(conversationId, actionId) {
    const conversation = need(conversations.get(conversationId));
    const record = conversation.turns.flatMap(turn => turn.tools || []).find(tool => tool.id === actionId);
    const action = conversation.actions.get(actionId);
    if (!record || !action || record.undone) throw new HttpError(409, 'This can no longer be undone.');
    await action();
    record.undone = true;
    conversation.actions.delete(actionId);
    if (conversation.check) checkUndone(conversation, actionId);
    conversation.notes.push(`The user has undone this change: ${record.label?.[1] || record.name}.`);
    persist(conversation);
    return view(conversation);
  }

  // ---------- the engine a conversation runs on, and compacting ----------
  // The engine and model chosen in Settings. An engine's copy is dropped when the engine or its model was switched;
  // the new one starts from the turns kept here.
  function engage(conversation) {
    const { engine: chosen, models, apply } = settings();
    // A status check runs on Claude Code whatever engine is chosen: the mail connector is there.
    const engineId = conversation.pin || chosen;
    if (conversation.engine && (conversation.engine !== engineId || conversation.model !== models[engineId])) {
      available[conversation.engine]?.close(conversation.id);
      conversation.context = null;
    }
    conversation.engine = engineId;
    conversation.model = models[engineId];
    return { engineId, engine: available[engineId], model: models[engineId], apply };
  }

  // Has the model write a summary of the turns before `upto` and puts a marker with it there. An engine that holds
  // the conversation is asked in the conversation itself, so it summarises all it saw; one that does not is given
  // the turns kept here (and the summary before them). Either way the engine then lets go of the conversation, and
  // the next message starts it from the summary. While this runs no tool may be used: conversation.live is not set.
  async function compact(conversation, { trigger, focus = '', upto = conversation.turns.length, emit, signal, engineId, engine, model }) {
    const live = engine.live(conversation.id);
    const before = live ? conversation.context?.tokens ?? null : null;
    emit({ type: 'compacting', trigger });
    const started = Date.now();
    let said = '';
    let own = '';
    let outcome;
    try {
      outcome = await engine.send({
        id: conversation.id, system: SYSTEM_PROMPT, model, tools: tools.definitions(), signal, compacting: true,
        text: live ? compactPrompt(focus) : `${handover(conversation.turns.slice(0, upto), SUMMARISE_MAX)}\n\n${compactPrompt(focus)}`,
        callTool: async () => ({ ok: false, content: JSON.stringify({ error: 'Write the summary without using a tool.' }) }),
        onRound() {}, onThinking() {}, onText(delta) { said += delta; }, onDiscard() { said = ''; },
        // Claude Code may compact by itself just as the request arrives, and then answer something else: the
        // summary it wrote covers the same conversation and is used when no other comes.
        onCompacting() {},
        onCompact(compacted) { if (compacted.summary) own = compacted.summary; },
      });
    } finally {
      engine.close(conversation.id);
      conversation.context = null;
    }
    try { repo.logUsage?.({ kind: 'assistant', provider: engineId, model: outcome.model, usage: outcome.usage, turns: outcome.rounds, durationMs: Date.now() - started }); } catch { /* optional */ }
    const summary = summaryOf(said) || own;
    if (!summary) throw new AssistantError('no-summary', 'The assistant did not write a summary. Try again.');
    const marker = { role: 'compact', at: iso(), trigger, summary, engine: engineId, model: outcome.model || null, usage: outcome.usage || null, before, after: null, ...(focus ? { focus } : {}) };
    conversation.turns.splice(upto, 0, marker);
    emit({ type: 'compact', index: upto, turn: markerView(marker) });
    return marker;
  }

  // Compacting because the user asked. Checked before anything is streamed, like a message.
  function beginCompact(id, input) {
    if (input.focus !== undefined && typeof input.focus !== 'string') throw new HttpError(400, 'focus must be text.');
    const focus = (input.focus || '').trim();
    if (focus.length > MAX_FOCUS) throw new HttpError(400, `What to keep an eye on can be up to ${MAX_FOCUS} characters.`);
    const conversation = need(load(id));
    if (conversation.flight) throw new HttpError(409, 'The assistant is still answering.');
    if (!compactable(conversation)) throw new HttpError(409, 'There is nothing to compact yet.');
    const controller = new AbortController();
    conversation.flight = controller;
    return { conversation, controller, run: emit => compactNow(conversation, focus, emit, controller) };
  }

  async function compactNow(conversation, focus, emit, controller) {
    let failure = null;
    try {
      const { engineId, engine, model } = engage(conversation);
      await compact(conversation, { trigger: 'manual', focus, emit, signal: controller.signal, engineId, engine, model });
    } catch (error) {
      if (!controller.signal.aborted) {
        const known = error instanceof AssistantError;
        if (!known) log(`[dayjob] assistant: ${error.stack || error.message}`);
        failure = { code: known ? error.code : 'internal', message: known ? error.message : 'The assistant ran into a problem. Try again.' };
      }
    } finally {
      conversation.flight = null;
      conversation.updatedAt = iso();
      conversation.usedAt = Date.now();
      try { persist(conversation); } catch (error) { log(`[dayjob] assistant: could not save the conversation: ${error.message}`); }
    }
    emit({ type: 'end', conversation: view(conversation), ...(failure ? { failure } : {}) });
  }

  // ---------- a message and its reply ----------
  // Checks the message before any reply starts, so a bad request is an ordinary error and not half a stream.
  function begin({ conversationId, text }) {
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Type a message first.');
    if (text.length > MAX_TEXT) throw new HttpError(400, `A message can be up to ${MAX_TEXT} characters.`);
    if (conversationId !== undefined && conversationId !== null && typeof conversationId !== 'string') throw new HttpError(400, 'conversationId must be text.');
    const conversation = conversationId ? need(load(conversationId)) : create();
    if (conversation.flight) throw new HttpError(409, 'The assistant is still answering.');
    if (conversation.run?.state === 'queued') throw new HttpError(409, 'This application is waiting for its turn. It starts by itself.');
    const controller = new AbortController();
    conversation.flight = controller;
    return { conversation, controller, run: emit => reply(conversation, text.trim(), emit, controller) };
  }

  // ---------- 同时申请: applications with a conversation of their own ----------
  const jobName = posting => [posting.company, posting.title].filter(Boolean).join(' · ') || 'this job';
  const NO_USE = () => ({ steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: null });
  const RUN_NOTE = posting => `This conversation is one application, which the user started for posting ${posting.id} (${jobName(posting)}). It runs in the background, in a browser tab of its own: the user `
    + 'may be looking at something else, and other applications may be running at the same time in other tabs. Start with open_application for this posting and work on this one only. '
    + 'When it is sent, or when you cannot go on, call report_application, then say in a few lines how it went and what, if anything, the user has to do.';
  const ENDED = { submitted: 'it was sent, and Dayjob tracks it now', unconfirmed: 'the assistant there says it was sent, but Dayjob saw no confirmation', 'needs-user': 'it was not sent: it needs the user',
    failed: 'it was not sent: it failed', skipped: 'it was not sent: it was skipped', stopped: 'the user stopped it', error: 'it broke off with an error', unclear: 'it was not sent' };
  // Takes an application off the list. One whose conversation the user keeps stays as an ordinary conversation.
  function dismiss(conversation) {
    if (conversation.kept && !conversation.flight) {
      conversation.run = null;
      try { browser?.endRun?.(conversation.id, { forgotten: true }); } catch { /* the browser is gone */ }
      trim();
    } else release(conversation);
  }
  // Starts the applications that are waiting, as far as there is room for them.
  function pump() {
    const limit = settings().parallel;
    let working = runList().filter(item => item.flight).length;
    for (const conversation of runList()) {
      if (working >= limit) break;
      if (conversation.run.state !== 'queued' || conversation.flight) continue;
      working += 1;
      launch(conversation);
    }
  }
  function launch(conversation) {
    const controller = new AbortController();
    conversation.flight = controller;
    reply(conversation, conversation.run.text, event => cast(conversation, event), controller).catch(error => {
      log(`[dayjob] assistant: ${error.stack || error.message}`);
      // Never leave a place in the line taken by something that is not running.
      if (conversation.flight === controller) conversation.flight = null;
      if (conversation.run) Object.assign(conversation.run, { state: 'done', outcome: 'error', endedAt: iso() });
      pump();
    });
  }
  // parent: the conversation whose assistant started it, which is told how it ended.
  function startApplication(postingId, { parent = null } = {}) {
    if (!browser) throw new HttpError(409, 'Applying needs the Dayjob desktop app, which has the Dayjob browser.');
    if (typeof postingId !== 'string' || !postingId) throw new HttpError(400, 'postingId is required.');
    const posting = need(repo.getPosting(postingId), 'Posting');
    const under = runList().find(item => item.run.postingId === posting.id && item.run.state !== 'done');
    if (under) return { conversation: under, already: true };
    if (repo.applicationForPosting(posting.id)) throw new HttpError(409, 'This job is already tracked as applied.');
    if (!(posting.applyUrl || posting.jobUrl)) throw new HttpError(409, 'This posting has no link to open.');
    // An earlier try at the same job gives way to the new one, and the list keeps only the latest.
    for (const old of runList().filter(item => item.run.state === 'done' && item.run.postingId === posting.id)) dismiss(old);
    if (runList().length >= MAX_RUNS) {
      const over = runList().find(item => item.run.state === 'done');
      if (!over) throw new HttpError(409, 'Too many applications are waiting already. Let some of them finish first.');
      dismiss(over);
    }
    const conversation = create();
    const job = jobName(posting);
    const text = english() ? `Apply to this job: ${job}` : `申请这个岗位：${job}`;
    conversation.run = { postingId: posting.id, job, state: 'queued', outcome: null, reason: '', at: iso(), startedAt: null, endedAt: null, parent, text, used: NO_USE() };
    conversation.title = titleOf(text);
    conversation.notes.push(RUN_NOTE(posting));
    pump();
    return { conversation, already: false };
  }
  // For the assistant's own tool: several at once, each answered for by itself.
  function startMany(ids, context) {
    return ids.map(id => {
      try {
        const { conversation, already } = startApplication(id, { parent: context?.conversationId || null });
        return { id, job: conversation.run.job, state: conversation.run.state, ...(already ? { note: 'This one was under way already.' } : {}) };
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return { id, error: error.message };
      }
    });
  }
  // Stops an application: one at work is stopped like any reply, one still waiting never starts.
  function stop(conversation) {
    if (conversation.run?.state === 'queued') Object.assign(conversation.run, { state: 'done', outcome: 'stopped', endedAt: iso() });
    else conversation.flight?.abort();
  }

  // After a reply that worked on an application: how it ended, noted on the application and in the feedback file.
  // Dayjob writes the entry from what it saw itself (whether the application was recorded, where the tools got to,
  // which of them failed) and from what the model reported, if it did. Returns the outcome, or null when the reply
  // was about something else.
  function wrapUp(conversation, turn, { engineId, started }) {
    const memo = conversation.memo;
    const run = conversation.run;
    const report = memo.report || null;
    memo.report = null;
    const last = name => turn.tools.findLast(tool => tool.ok && tool.name === name);
    const postingId = run?.postingId || last('open_application')?.facts?.postingId || last('mark_applied')?.input?.id || memo.posting?.id || null;
    const browsed = turn.tools.some(tool => tool.tier === 'browser');
    if (!run && !report && !(postingId && browsed)) return null;
    // A later message in an application's conversation that only talked about it changes nothing.
    if (run?.replies && !report && !browsed && !turn.stopped && !turn.error) return run.outcome;
    if (run) run.replies = (run.replies || 0) + 1;
    const posting = postingId ? repo.getPosting(postingId) : null;
    const recorded = turn.tools.some(tool => tool.ok && tool.step === 'record') || Boolean(run && repo.applicationForPosting(run.postingId));
    const outcome = recorded ? 'submitted' : turn.stopped ? 'stopped' : turn.error ? 'error' : report?.outcome === 'submitted' ? 'unconfirmed' : report?.outcome || 'unclear';
    const reached = Math.max(-1, ...turn.tools.filter(tool => tool.ok && tool.step).map(tool => APPLY_STEPS.indexOf(tool.step)));
    const failures = new Map();
    for (const tool of turn.tools.filter(item => !item.ok)) {
      const key = `${tool.name}\n${tool.error}`;
      failures.set(key, { tool: tool.name, error: tool.error || '', count: (failures.get(key)?.count || 0) + 1 });
    }
    const failed = [...failures.values()].sort((a, b) => b.count - a.count).slice(0, 6);
    const reason = outcome === 'submitted' ? '' : report?.reason || (turn.error && !turn.stopped ? turn.error : '') || report?.problems?.[0]?.what || failed[0]?.error || '';
    let site = '';
    try { site = new URL(posting?.applyUrl || posting?.jobUrl || '').host; } catch { /* no link */ }
    const key = postingId || '';
    feedback.add({ at: now(), job: run?.job || (posting ? jobName(posting) : ''), site, outcome, stoppedAt: report?.stoppedAt || APPLY_STEPS[reached] || null, reason, problems: report?.problems || [], failures: failed,
      engine: engineId, model: turn.model || turn.steps.at(-1)?.model || null, durationMs: Date.now() - started, steps: turn.steps, again: Boolean(memo.entries?.has(key)) });
    memo.entries = (memo.entries || new Set()).add(key);
    if (run) Object.assign(run, { outcome, reason: scrub(reason, 200) });
    return outcome;
  }

  async function reply(conversation, text, emit, controller) {
    const { engineId, engine, model, apply } = engage(conversation);
    const at = iso();
    const run = conversation.run;
    if (run) Object.assign(run, { state: 'working', startedAt: run.startedAt || at, endedAt: null });
    const earlier = conversation.turns.length;
    conversation.turns.push({ role: 'user', text, at });
    if (!conversation.title) conversation.title = titleOf(text);
    const turn = { role: 'assistant', text: '', tools: [], steps: [], at, engine: engineId, model: null };
    conversation.turns.push(turn);
    emit({ type: 'start', conversation: { id: conversation.id, title: conversation.title, kept: conversation.kept, run: runView(conversation) }, engine: engineId });
    // 每一步的 token: a step is one request to the model, with the tools it then ran. It is written to the database
    // once the next one begins (its tools are known by then), and the last one when the reply is over.
    let written = 0;
    const writeSteps = upto => {
      for (; written < upto; written += 1) {
        const step = turn.steps[written];
        try {
          repo.logStep?.({ at: step.at, conversationId: conversation.id, replyAt: at, step: step.n, kind: step.kind || 'reply', postingId: run?.postingId || conversation.memo.posting?.id || null,
            provider: engineId, model: step.model, tools: step.tools, usage: step, cost: step.cost });
        } catch (error) { log(`[dayjob] assistant: could not log a step: ${error.message}`); }
      }
    };
    const onStep = ({ kind = 'reply', model: served = null, usage }) => {
      if (!usage) return;
      const step = { n: turn.steps.length + 1, at: iso(), ...(kind === 'reply' ? {} : { kind }), model: served || model || null, tools: [],
        inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, cacheReadTokens: usage.cacheReadTokens || 0, cacheWriteTokens: usage.cacheWriteTokens || 0 };
      step.cost = costOf(step.model, step, 1);
      turn.steps.push(step);
      if (run) {
        run.used.steps += 1;
        for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) run.used[key] += step[key];
        if (typeof step.cost === 'number') run.used.cost = (run.used.cost || 0) + step.cost;
      }
      writeSteps(turn.steps.length - 1);
      emit({ type: 'step', step });
    };
    // Whether the reply as a whole has been put down with the rest of the AI usage.
    let counted = false;
    // With the Dayjob browser at hand, each message says how the user wants applications sent just now.
    // The memory comes with the first message an engine session gets, and again whenever it has changed since.
    // An empty memory is only said once it has been emptied: the model has no notes to unlearn before that.
    const remembered = memory.note();
    const cold = !engine.live(conversation.id);
    const told = conversation.remembered ?? '';
    const mode = browser && !conversation.check ? [MODE_NOTES[apply]] : [];
    const notes = [...conversation.notes.splice(0), ...mode, ...(remembered ? (cold || told !== remembered ? [remembered] : []) : told ? [MEMORY_EMPTY] : [])];
    conversation.remembered = remembered;
    let message = withNotes(text, notes);
    // What holds for the whole conversation, for an engine to say again when it compacts in the middle of a reply.
    const standing = [...mode, ...(remembered ? [remembered] : [])];
    // Text from separate rounds (before and after a tool) is set apart by a blank line.
    let mark = 0;
    let gap = false;
    const started = Date.now();
    try {
      if (cold && earlier) {
        // Too long to hand over whole: the older turns are summarised first, and stay summarised from then on.
        // Should that not work, the conversation is handed over as before, without its oldest turns.
        const cut = cutFor(conversation.turns.slice(0, earlier));
        if (cut !== null) {
          try { await compact(conversation, { trigger: 'auto', upto: cut, emit, signal: controller.signal, engineId, engine, model }); } catch (error) {
            if (controller.signal.aborted) throw error;
            if (!(error instanceof AssistantError)) log(`[dayjob] assistant: ${error.stack || error.message}`);
          }
        }
        message = `${handover(conversation.turns.slice(0, conversation.turns.indexOf(turn) - 1))}\n\n${message}`;
      }
      conversation.live = { turn, emit };
      const outcome = await engine.send({
        id: conversation.id, text: message, system: SYSTEM_PROMPT, model, tools: tools.definitions(), signal: controller.signal,
        groups: tools.groups(), preload: preload(conversation, text), open: conversation.check?.open || null,
        onOutside(name, ok) { if (conversation.check) conversation.check.outside.push({ name, ok: Boolean(ok) }); },
        notes: standing.length ? withNotes('', standing).trim() : '',
        callTool: (name, input) => runTool(conversation, name, input), onStep,
        onRound() { mark = turn.text.length; gap = turn.text.length > 0; },
        onThinking() { emit({ type: 'thinking' }); },
        onText(delta) {
          const piece = gap ? `\n\n${delta}` : delta;
          gap = false;
          turn.text += piece;
          emit({ type: 'text', delta: piece });
        },
        onDiscard() { turn.text = turn.text.slice(0, mark); emit({ type: 'rewind', text: turn.text }); },
        onCompacting(trigger = 'auto') { emit({ type: 'compacting', trigger }); },
        // The engine compacted its copy. The marker goes in front of the message being answered: what came before
        // it is what the summary stands for. The memory is told again with the next message.
        onCompact({ trigger = 'auto', summary = '', before = null, after = null }) {
          const index = conversation.turns.indexOf(turn) - 1;
          const marker = { role: 'compact', at: iso(), trigger, summary, engine: engineId, before, after };
          conversation.turns.splice(index, 0, marker);
          conversation.remembered = '';
          emit({ type: 'compact', index, turn: markerView(marker) });
        },
      });
      turn.model = outcome.model || null;
      turn.usage = outcome.usage || null;
      conversation.context = outcome.context || null;
      // Counted with the rest of the AI usage where Dayjob records it.
      counted = true;
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
      if (!engine.live(conversation.id)) conversation.context = null;
      conversation.updatedAt = iso();
      conversation.usedAt = Date.now();
      writeSteps(turn.steps.length);
      // A reply that was stopped or broke off used what its steps used: that counts as well.
      if (!counted && turn.steps.length) {
        const total = sumSteps(turn.steps);
        turn.usage = { inputTokens: total.inputTokens, outputTokens: total.outputTokens, cacheReadTokens: total.cacheReadTokens, cacheWriteTokens: total.cacheWriteTokens };
        turn.model = turn.model || turn.steps.at(-1).model;
        try { repo.logUsage?.({ kind: 'assistant', provider: engineId, model: turn.model, usage: turn.usage, turns: turn.steps.length, durationMs: Date.now() - started }); } catch { /* optional */ }
      }
      let outcome = null;
      try { outcome = wrapUp(conversation, turn, { engineId, started }); } catch (error) { log(`[dayjob] assistant: could not note how the application went: ${error.stack || error.message}`); }
      if (run) {
        Object.assign(run, { state: 'done', endedAt: iso(), outcome: outcome || run.outcome || 'unclear' });
        // Its tab is given back: closed when the application went through, left for the user when it did not.
        try { browser?.endRun?.(conversation.id, { close: run.outcome === 'submitted' }); } catch { /* the browser is gone */ }
        const parent = run.parent ? conversations.get(run.parent) : null;
        if (parent) parent.notes.push(`The application you started for ${run.job} has ended: ${ENDED[run.outcome] || run.outcome}${run.reason ? ` (${run.reason})` : ''}.`);
      }
      if (conversation.check?.state === 'running') {
        try { finishCheck(conversation, turn); } catch (error) { log(`[dayjob] status check: ${error.stack || error.message}`); }
      }
      try { persist(conversation); } catch (error) { log(`[dayjob] assistant: could not save the conversation: ${error.message}`); }
    }
    emit({ type: 'end', conversation: view(conversation) });
    // A place in the line is free again.
    if (run) pump();
  }

  // ---------- 申请状态检查 (check.mjs) ----------
  const checks = createCheckStore({ repo, now });
  // The conversation of the check that is running, if one is.
  let checking = null;
  let checkFirst = null;
  let checkTimer = null;
  const checkTools = conversation => new Set([...CHECK_TOOLS, ...(conversation.check.pages.length ? PAGE_TOOLS : [])]);
  // Why a check may not make this call, or null when it may.
  function checkRefuses(conversation, name, input) {
    if (!checkTools(conversation).has(name)) return 'The status check cannot use this tool: it only looks, and records what it finds with update_application.';
    if (name !== 'update_application') return null;
    if (input?.status !== undefined && !CHECK_STATUSES.includes(input.status)) return `The status check sets only these statuses: ${CHECK_STATUSES.join(', ')}. Anything else is left to the user: say it in the summary.`;
    const other = Object.keys(input || {}).filter(key => !['id', 'status', 'statusAt', 'note'].includes(key));
    if (other.length) return `The status check records a status and a timeline note only (id, status, statusAt, note), not ${other.join(', ')}.`;
    if (!input?.status && !input?.note) return 'Give a status or a note.';
    return null;
  }
  const MAIL_TROUBLE = {
    missing: ['这台电脑上的 Claude Code 里没有 Gmail 连接器。', 'Claude Code on this computer has no Gmail connector.'],
    'needs-auth': ['Claude Code 里的 Gmail 连接器需要重新登录。', 'The Gmail connector in Claude Code has to be signed in to again.'],
    failed: ['Claude Code 里的 Gmail 连接器没有连上。', 'The Gmail connector in Claude Code did not connect.'],
  };
  // What the window shows: the switches, the last check (each change with whether it can still be undone), and the one running.
  function checkView() {
    const last = checks.last();
    const held = last?.conversationId ? conversations.get(last.conversationId) : null;
    return { settings: checks.settings(), browser: Boolean(browser),
      running: checking ? { conversationId: checking.id, startedAt: checking.check.at, trigger: checking.check.trigger } : null,
      last: last ? { ...last, conversationId: held ? last.conversationId : null,
        changes: (last.changes || []).map(change => ({ ...change, undoable: Boolean(held?.actions.get(change.id)) && !change.undone })) } : null };
  }
  function checkUndone(conversation, actionId) {
    const last = checks.last();
    if (last?.conversationId !== conversation.id) return;
    checks.record({ ...last, changes: (last.changes || []).map(change => (change.id === actionId ? { ...change, undone: true } : change)) });
  }
  // The check's reply is over: what it changed is put down, and the user is told when there is news.
  function finishCheck(conversation, turn) {
    const check = conversation.check;
    check.state = turn.stopped ? 'stopped' : turn.error ? 'failed' : 'done';
    if (checking === conversation) checking = null;
    try { browser?.endRun?.(conversation.id, { close: true }); } catch { /* the browser is gone */ }
    const changes = turn.tools.filter(tool => tool.ok && tool.name === 'update_application').map(tool => {
      const application = repo.getApplication(tool.input.id);
      return { id: tool.id, applicationId: tool.input.id, company: application?.company || '', title: application?.title || '', status: tool.input.status || null,
        note: clip(String(tool.input.note || ''), 300) };
    });
    const used = sumSteps(turn.steps);
    // The mail counts as read only when a search came back: one that Claude Code refused or that failed does not.
    const searches = check.outside.filter(tool => /__search_threads$/.test(tool.name));
    const readMail = searches.some(tool => tool.ok);
    if (check.state === 'done' && readMail) checks.noteMail();
    const open = new Set(repo.listApplications({ open: true }).map(item => item.id));
    if (check.pages.length && turn.tools.some(tool => tool.ok && tool.name === 'browser_open')) checks.noteLooked(check.pages, open);
    checks.record({ at: check.at, day: check.day, trigger: check.trigger, state: check.state,
      // "ready" but never searched: the model did not get to the mail, which the window should not call read.
      // Searched and nothing came back: "refused".
      mail: check.mail === 'ready' || check.mail === 'unknown' ? (readMail ? 'read' : searches.length ? 'refused' : check.state === 'done' ? 'unread' : check.mail) : check.mail,
      error: turn.error || null, errorCode: turn.errorCode || null, changes, pages: check.pages, summary: clip(turn.text.trim(), 2000),
      tokens: used.inputTokens + used.outputTokens + used.cacheReadTokens + used.cacheWriteTokens, cost: used.cost ?? null, conversationId: conversation.id });
    const language = repo.getSettings().language;
    const moved = changes.filter(change => change.status);
    try {
      if (moved.length) notify({ kind: 'status-check', ...message(language, 'statusNews', { count: moved.length, names: moved.slice(0, 3).map(change => `${change.company} ${change.title}`.trim()) }), refId: moved[0].applicationId });
      else if (check.state === 'failed' && check.trigger === 'start') notify({ kind: 'error', ...message(language, 'statusCheckFailed', { reason: turn.error }) });
    } catch (error) { log(`[dayjob] status check: ${error.message}`); }
  }
  // Starts a check, unless one is running. It goes on in the background; checkView() says how it stands.
  // trigger: 'start' (by itself, when Dayjob starts) or 'manual' (the button).
  function startCheck({ trigger = 'manual' } = {}) {
    if (checking) return { already: true };
    const at = iso();
    const stamp = { at, day: localDay(now()), trigger };
    const none = { mail: null, error: null, errorCode: null, changes: [], pages: [], summary: '', tokens: 0, cost: null, conversationId: null };
    const applications = repo.listApplications({ open: true });
    // Nothing to check costs nothing: no model is called.
    if (!applications.length) { checks.record({ ...stamp, ...none, state: 'nothing' }); return { started: false }; }
    const config = checks.settings();
    // The check before this one makes room: what it changed can no longer be taken back from here.
    for (const old of [...conversations.values()]) if (old.check && !old.flight) release(old);
    const conversation = create();
    const controller = new AbortController();
    conversation.pin = 'claude-cli';
    conversation.title = english() ? 'Status check' : '申请状态检查';
    conversation.check = { ...stamp, state: 'running', mail: 'off', pages: [], open: null, outside: [] };
    conversation.flight = controller;
    checking = conversation;
    const fail = (code, text) => {
      conversation.check.state = 'failed';
      if (conversation.flight === controller) conversation.flight = null;
      if (checking === conversation) checking = null;
      checks.record({ ...stamp, ...none, state: controller.signal.aborted ? 'stopped' : 'failed', mail: conversation.check.mail, error: text, errorCode: code });
      if (trigger === 'start' && !controller.signal.aborted) {
        try { notify({ kind: 'error', ...message(repo.getSettings().language, 'statusCheckFailed', { reason: text }) }); } catch { /* a toast is extra */ }
      }
      release(conversation);
    };
    (async () => {
      // Which servers the user's Claude Code has: asked of Claude Code itself, without a message to a model.
      const servers = await available['claude-cli'].servers?.({ signal: controller.signal }) ?? null;
      if (controller.signal.aborted) throw controller.signal.reason || new Error('Stopped.');
      const rules = mailRules(servers, { read: config.mail });
      const pages = config.pages && browser ? pagesFor(applications, checks.looked()) : [];
      Object.assign(conversation.check, { mail: rules.mail, pages: pages.map(item => item.id), open: { allow: rules.allow, deny: rules.deny } });
      const readsMail = rules.mail === 'ready' || rules.mail === 'unknown';
      if (!readsMail && !pages.length) {
        const trouble = MAIL_TROUBLE[rules.mail];
        fail(`mail-${rules.mail}`, trouble ? trouble[english() ? 1 : 0] : english() ? 'There is nothing to check: reading mail and looking at the pages are both switched off.' : '没有可查的：读邮件和查看申请页面都关着。');
        return;
      }
      conversation.notes.push(checkNote({ applications, mail: rules.mail, since: mailSince({ applications, last: checks.mailAt(), now: now() }), pages, english: english(), today: localDay(now()) }));
      await reply(conversation, english() ? 'Check my applications for news.' : '查一下我的申请有没有新进展。', event => cast(conversation, event), controller);
    })().catch(error => {
      if (!(error instanceof AssistantError) && !controller.signal.aborted) log(`[dayjob] status check: ${error.stack || error.message}`);
      fail(error instanceof AssistantError ? error.code : 'internal', error instanceof AssistantError ? error.message : 'The status check ran into a problem.');
    });
    return { started: true, conversationId: conversation.id };
  }
  // The check that runs by itself: once a day. When Dayjob starts it runs a little later (firstMs), whatever the
  // hour: that is "when the computer starts". A Dayjob that stays open over midnight runs the next day's at the
  // time of the daily search, not in the middle of the night.
  function watchChecks({ firstMs = 90000, everyMs = 10 * 60000 } = {}) {
    const tick = fresh => {
      if (checking || !checks.due()) return;
      const current = now();
      if (!fresh && current < scheduledAt(repo.getSettings().schedule.time, current)) return;
      try { startCheck({ trigger: 'start' }); } catch (error) { log(`[dayjob] status check: ${error.stack || error.message}`); }
    };
    clearTimeout(checkFirst);
    clearInterval(checkTimer);
    checkFirst = setTimeout(() => tick(true), firstMs);
    checkFirst.unref?.();
    checkTimer = setInterval(() => tick(false), everyMs);
    checkTimer.unref?.();
  }

  // ---------- HTTP ----------
  async function state() {
    const [cli, api] = await Promise.all(ENGINES.map(id => available[id].status()));
    return { settings: settings(), engines: { 'claude-cli': cli, 'anthropic-api': api },
      models: CLAUDE_MODELS.map(model => ({ id: model.id, name: model.name, tag: model.tag || null })),
      defaultModels: Object.fromEntries(ENGINES.map(id => [id, PROVIDERS[id].defaultModel])), kept: store.list(), browser: Boolean(browser), memory: memory.list(),
      runs: runList().map(runView), parallel: PARALLEL, feedback: { file: feedback.file, folder: feedback.folder }, check: checkView(),
      tools: tools.list.map(tool => ({ name: tool.name, tier: tool.tier })) };
  }

  // What a reply says goes to everyone listening to its conversation: the request that asked for it, and a pane
  // that looked in on an application later.
  const cast = (conversation, event) => { for (const listener of [...conversation.listeners]) listener(event); };
  const NDJSON = { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
  const writer = response => event => { if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
  // The reply as lines of JSON, one event each, written as they happen. Closing the request stops the reply, except
  // in an application's own conversation: that goes on in the background, and is stopped by asking (/stop).
  async function stream(response, { conversation, controller, run }) {
    let finished = false;
    response.writeHead(200, NDJSON);
    const write = writer(response);
    conversation.listeners.add(write);
    response.on('close', () => {
      conversation.listeners.delete(write);
      if (!finished && !conversation.run) controller.abort();
    });
    try { await run(event => cast(conversation, event)); } finally {
      finished = true;
      conversation.listeners.delete(write);
      response.end();
    }
  }
  // Looking in on a conversation: how it stands now (snapshot), then, while a reply is being made in it, what that
  // reply says from here on. Closing the request only stops the looking.
  async function follow(response, conversation) {
    response.writeHead(200, NDJSON);
    const write = writer(response);
    write({ type: 'snapshot', conversation: view(conversation) });
    if (conversation.flight) {
      await new Promise(resolve => {
        const listener = event => { write(event); if (event.type === 'end') done(); };
        const done = () => { conversation.listeners.delete(listener); resolve(); };
        conversation.listeners.add(listener);
        response.on('close', done);
      });
    }
    response.end();
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
    const offered = conversation.check ? { list: tools.list.filter(tool => checkTools(conversation).has(tool.name)) } : tools;
    return handleMcp({ request, response, body, tools: offered, callTool: (name, input) => runTool(conversation, name, input) });
  }

  async function http({ request, response, pathname, method, authorize }) {
    if (pathname === '/api/assistant/mcp') return mcp(request, response);
    if (request.headers['x-dayjob-client'] === 'mcp') throw new HttpError(403, 'The in-app assistant is used from the Dayjob window only.');
    const match = pathname.match(/^\/api\/assistant\/conversations\/([^/]+)(\/undo|\/keep|\/archive|\/close|\/compact|\/live|\/stop)?$/);
    const listed = pathname.match(/^\/api\/assistant\/runs\/([^/]+)$/);
    const runs = () => ({ runs: runList().map(runView), parallel: settings().parallel });
    if (method === 'GET') {
      if (pathname === '/api/assistant') return respond(response, 200, await state());
      if (pathname === '/api/assistant/check') return respond(response, 200, checkView());
      if (pathname === '/api/assistant/runs') return respond(response, 200, runs());
      if (pathname === '/api/assistant/feedback') return respond(response, 200, feedback.read());
      if (match && !match[2]) return respond(response, 200, view(need(load(match[1]))));
      throw new HttpError(404, 'API endpoint not found.');
    }
    authorize();
    const input = await readJson(request);
    if (pathname === '/api/assistant/chat' && method === 'POST') return stream(response, begin(input));
    if (pathname === '/api/assistant/settings' && method === 'PATCH') return respond(response, 200, saveSettings(input));
    // 申请状态检查: its switches, starting one now, and stopping the one that runs.
    if (pathname === '/api/assistant/check' && method === 'PATCH') { checks.save(input); return respond(response, 200, checkView()); }
    if (pathname === '/api/assistant/check/run' && method === 'POST') { startCheck({ trigger: 'manual' }); return respond(response, 202, checkView()); }
    if (pathname === '/api/assistant/check/stop' && method === 'POST') { checking?.flight?.abort(); return respond(response, 200, checkView()); }
    // 同时申请: an application of its own for a posting; and taking one off the list (one at work is stopped first).
    if (pathname === '/api/assistant/applications' && method === 'POST') {
      const { conversation, already } = startApplication(input.postingId);
      return respond(response, already ? 200 : 201, { run: runView(conversation), ...runs() });
    }
    if (listed && method === 'DELETE') {
      const conversation = conversations.get(listed[1]);
      if (conversation?.run) dismiss(conversation);
      pump();
      return respond(response, 200, runs());
    }
    if (match && method === 'POST' && match[2] === '/live') return follow(response, need(load(match[1])));
    if (match && method === 'POST' && match[2] === '/stop') {
      const conversation = need(conversations.get(match[1]));
      stop(conversation);
      pump();
      return respond(response, 200, { ok: true, run: runView(conversation) });
    }
    // 助手的记忆: the user's own notes for the assistant, read and edited under Settings.
    if (pathname === '/api/assistant/memory' && method === 'POST') { memory.add(input.text, 'user'); return respond(response, 201, { memory: memory.list() }); }
    const note = pathname.match(/^\/api\/assistant\/memory\/([^/]+)$/);
    if (note && method === 'PATCH') { memory.update(note[1], input.text); return respond(response, 200, { memory: memory.list() }); }
    if (note && method === 'DELETE') { need(memory.remove(note[1]), 'Note'); return respond(response, 200, { memory: memory.list() }); }
    if (match && method === 'POST' && match[2] === '/undo') {
      if (typeof input.actionId !== 'string') throw new HttpError(400, 'actionId is required.');
      return respond(response, 200, await undo(match[1], input.actionId));
    }
    // Compacting on request: streamed like a reply (compacting, compact, end), since the summary takes a while.
    if (match && method === 'POST' && match[2] === '/compact') return stream(response, beginCompact(match[1], input));
    if (match && method === 'POST' && match[2] === '/keep') {
      if (typeof input.keep !== 'boolean') throw new HttpError(400, 'keep must be true or false.');
      const conversation = need(load(match[1]));
      conversation.kept = input.keep;
      if (!input.keep) conversation.archivedAt = null;
      if (input.keep) persist(conversation); else store.remove(conversation.id);
      return respond(response, 200, { conversation: view(conversation), kept: store.list() });
    }
    // Archiving the open conversation also keeps it. One that is only in the database is changed there and not
    // loaded, so tidying the list never pushes the open conversation out of memory.
    if (match && method === 'POST' && match[2] === '/archive') {
      if (typeof input.archived !== 'boolean') throw new HttpError(400, 'archived must be true or false.');
      const at = input.archived ? iso() : null;
      const conversation = conversations.get(match[1]);
      if (conversation) {
        conversation.archivedAt = at;
        if (input.archived) conversation.kept = true;
        persist(conversation);
      } else need(store.archive(match[1], at));
      return respond(response, 200, { conversation: conversation ? view(conversation) : null, kept: store.list() });
    }
    // Leaving a conversation: one that is not kept is forgotten, a kept one only leaves memory.
    if (match && method === 'POST' && match[2] === '/close') {
      const conversation = conversations.get(match[1]);
      // An application stays in its list when the pane leaves it, and the last status check stays for its undo.
      if (conversation && !conversation.run && !conversation.check) release(conversation);
      return respond(response, 200, { ok: true });
    }
    if (match && !match[2] && method === 'DELETE') {
      const conversation = conversations.get(match[1]);
      // A reply that is still being written ends here; marked as not kept, it is not saved again as it stops.
      if (conversation) conversation.kept = false;
      if (conversation) release(conversation);
      const removed = store.remove(match[1]);
      return respond(response, 200, { ok: Boolean(conversation) || removed, kept: store.list() });
    }
    throw new HttpError(404, 'API endpoint not found.');
  }

  return {
    http, tools, store, settings, memory, feedback, startApplication,
    // 申请状态检查: startCheck starts one now; watchChecks starts the one that is owed when Dayjob starts, and
    // from then on once a day (see watchChecks).
    checks, startCheck, checkView, watchChecks,
    // For tests and the desktop shell.
    conversations,
    close() {
      clearTimeout(checkFirst);
      clearInterval(checkTimer);
      for (const conversation of [...conversations.values()]) release(conversation);
      for (const engine of Object.values(available)) engine.closeAll?.();
    },
  };
}
