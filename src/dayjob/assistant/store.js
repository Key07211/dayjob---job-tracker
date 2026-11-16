import { useSyncExternalStore } from 'react';
import { api, apiLines } from '../../api.js';

// The assistant's state for the window: the open conversation, what the gramophone is doing, and the list of kept
// conversations. It lives outside the pane so a reply carries on while the pane is closed, and so the chat keeps
// its place (and what is half typed) when it moves between the side of the window and the whole of it.
//
// form: closed | side (a pane at the right edge) | full (the whole page); open is true for the last two.
// phase: idle | thinking | speaking | tool | compacting (the gramophone's four looks; compacting looks like thinking).
// failure: what went wrong outside a reply, as text or as { code, message } when the pane has its own words for it.
// runs: 同时申请, the applications that have a conversation of their own ({ id, postingId, job, state, outcome, … }).
// They go on in the background whatever the pane shows; the pane looks in on one (follow) and leaves again.
const FORMS = ['closed', 'side', 'full'];
const saved = read();
const firstForm = saved === 'open' ? 'side' : FORMS.includes(saved) ? saved : 'closed';
let state = { form: firstForm, open: firstForm !== 'closed', info: null, conversation: null, busy: false, phase: 'idle', failure: '', draft: '', runs: [] };
const listeners = new Set();
const effects = new Set();
const hearers = new Set();
let flight = null;
let poll = 0;
const RUNS_EVERY = 2500;

function read() { try { return sessionStorage.getItem('dayjob-assistant'); } catch { return null; } }
function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const useAssistant = () => useSyncExternalStore(subscribe, () => state, () => state);
// What a finished tool call should set off in the window (a note to a key, a refresh, a page change).
export function onAssistantEffect(listener) { effects.add(listener); return () => effects.delete(listener); }
const effect = detail => effects.forEach(listener => listener(detail));
// Each piece of a reply as it arrives, for the gramophone, which sends out notes as fast as the words come.
export function onAssistantWords(listener) { hearers.add(listener); return () => hearers.delete(listener); }

const keepMemory = result => { if (state.info) set({ info: { ...state.info, memory: result.memory } }); };
const lastTurn = conversation => conversation.turns[conversation.turns.length - 1];
// The reply being written is the last turn; every change makes a new conversation object for React.
function writing(change) {
  const conversation = state.conversation;
  if (!conversation) return;
  const turns = conversation.turns.slice();
  turns[turns.length - 1] = change({ ...lastTurn(conversation) });
  set({ conversation: { ...conversation, turns } });
}

// The list of applications as the server has it. One that has just ended lets the lists in the window catch up;
// the one the pane is on is looked in on once it starts, and read again once it is over.
function takeRuns(runs) {
  const before = state.runs;
  set({ runs });
  if (runs.some(run => run.state === 'done' && before.some(was => was.id === run.id && was.state !== 'done'))) effect({ changed: true });
  const open = state.conversation?.id ? runs.find(run => run.id === state.conversation.id) : null;
  if (open && !state.busy && !flight) {
    const was = before.find(run => run.id === open.id);
    if (open.state === 'working') void follow(open.id);
    else if (was && was.state !== open.state) api(`/api/assistant/conversations/${open.id}`).then(conversation => { if (!state.busy && state.conversation?.id === open.id) set({ conversation }); }).catch(() => {});
  }
  clearTimeout(poll);
  // Asked again only while something is waiting or at work; a quiet list is left alone.
  if (runs.some(run => run.state !== 'done')) poll = setTimeout(() => void assistant.refreshRuns(), RUNS_EVERY);
}
// Leaves the reply the pane is following without stopping it (an application goes on in the background).
function detach() {
  const leaving = flight;
  flight = null;
  leaving?.abort();
  set({ busy: false, phase: 'idle' });
}
// Looks in on a conversation: how it stands now, and, while a reply is being made there, the reply as it goes on.
async function follow(id) {
  const controller = new AbortController();
  flight = controller;
  set({ busy: true, phase: 'thinking' });
  try {
    await apiLines(`/api/assistant/conversations/${id}/live`, { signal: controller.signal, onEvent(event) { if (flight === controller) handle(event); } });
  } catch (failure) {
    if (failure.name !== 'AbortError' && flight === controller) set({ failure: failure.message });
  }
  if (flight !== controller) return;
  flight = null;
  set({ busy: false, phase: 'idle' });
  void assistant.refreshRuns();
}

function handle(event) {
  if (event.type === 'start') set({ conversation: { ...state.conversation, ...event.conversation }, phase: 'thinking' });
  // How a conversation stands when the pane looks in on it. A reply still being made is its last turn.
  else if (event.type === 'snapshot') {
    const conversation = event.conversation;
    const turns = conversation.busy && conversation.turns.at(-1)?.role === 'assistant' ? [...conversation.turns.slice(0, -1), { ...conversation.turns.at(-1), writing: true }] : conversation.turns;
    set({ conversation: { ...conversation, turns }, phase: conversation.busy ? 'thinking' : 'idle' });
  }
  // What one request to the model used, as each one ends.
  else if (event.type === 'step') writing(turn => ({ ...turn, steps: [...(turn.steps || []), event.step] }));
  else if (event.type === 'thinking') { if (state.phase !== 'thinking') set({ phase: 'thinking' }); }
  else if (event.type === 'text') {
    writing(turn => ({ ...turn, text: turn.text + event.delta }));
    if (state.phase !== 'speaking') set({ phase: 'speaking' });
    hearers.forEach(listener => listener(event.delta));
  }
  else if (event.type === 'rewind') writing(turn => ({ ...turn, text: event.text }));
  else if (event.type === 'tool' && event.phase === 'start') {
    writing(turn => ({ ...turn, tools: [...turn.tools, { id: event.id, name: event.name, tier: event.tier, running: true, offset: turn.text.length }] }));
    set({ phase: 'tool' });
  } else if (event.type === 'tool' && event.phase === 'done') {
    // A tool that was already running when the pane looked in is first heard of when it is done.
    writing(turn => ({ ...turn, tools: turn.tools.some(tool => tool.id === event.id) ? turn.tools.map(tool => (tool.id === event.id ? event.tool : tool)) : [...turn.tools, event.tool] }));
    effect({ tool: event.tool, changed: event.changed, applied: event.applied, ui: event.ui });
    // The assistant noted or dropped something: the list under Settings follows.
    if (event.ui?.memory) void assistant.refresh();
    // It started applications of their own: their list follows.
    if (event.ui?.runs) void assistant.refreshRuns();
  } else if (event.type === 'compacting') set({ phase: 'compacting' });
  // The conversation was compacted: a marker takes its place among the turns, where the summary now stands in.
  else if (event.type === 'compact') {
    const conversation = state.conversation;
    if (conversation) set({ conversation: { ...conversation, turns: [...conversation.turns.slice(0, event.index), event.turn, ...conversation.turns.slice(event.index)] } });
  } else if (event.type === 'end') set({ conversation: event.conversation, ...(event.failure ? { failure: event.failure } : {}) });
}

export const assistant = {
  get: () => state,
  setForm(form) {
    if (!FORMS.includes(form) || form === state.form) return;
    try { sessionStorage.setItem('dayjob-assistant', form); } catch { /* optional */ }
    set({ form, open: form !== 'closed' });
    if (form !== 'closed' && !state.info) void assistant.refresh();
  },
  setOpen(open) { assistant.setForm(open ? (state.form === 'closed' ? 'side' : state.form) : 'closed'); },
  setDraft(draft) { if (draft !== state.draft) set({ draft }); },
  // Which engines can run, the chosen one, and the kept conversations.
  async refresh() {
    try {
      const info = await api('/api/assistant');
      set({ info });
      takeRuns(info.runs || []);
    } catch (failure) { set({ failure: failure.message }); }
  },
  // 同时申请. The list of applications; asked for again by itself while one of them is waiting or at work.
  async refreshRuns() {
    try { takeRuns((await api('/api/assistant/runs')).runs); } catch { /* the next try will tell */ }
  },
  // Has the assistant apply to a posting in a conversation and a browser tab of its own. The pane opens beside the
  // page, on this application unless it is in the middle of something else. Throws what the server refused.
  async apply(postingId) {
    const result = await api('/api/assistant/applications', { method: 'POST', body: { postingId } });
    takeRuns(result.runs);
    if (state.form === 'closed') assistant.setOpen(true);
    const idle = !state.busy && !(state.conversation?.turns || []).length;
    if (idle || state.conversation?.id === result.run.id) void assistant.openRun(result.run.id);
    return result.run;
  },
  // Shows an application's conversation in the pane. A reply in an ordinary conversation is not left half way.
  async openRun(id) {
    if (state.form === 'closed') assistant.setOpen(true);
    const run = state.runs.find(item => item.id === id);
    if (!run) return;
    if (state.conversation?.id === id) { if (!state.busy && !flight && run.state === 'working') void follow(id); return; }
    if (state.busy && !state.conversation?.run) { set({ failure: { code: 'busy-here', message: 'The assistant is still answering here.' } }); return; }
    const leaving = state.conversation;
    if (flight) detach();
    set({ conversation: { id, title: run.job, kept: false, archivedAt: null, turns: [], run }, failure: '' });
    if (leaving?.id && !leaving.run) api(`/api/assistant/conversations/${leaving.id}/close`, { method: 'POST' }).catch(() => {});
    await follow(id);
  },
  // Stops an application (one that is still waiting never starts); it stays in the list.
  async stopRun(id) {
    try { await api(`/api/assistant/conversations/${id}/stop`, { method: 'POST' }); } catch (failure) { set({ failure: failure.message }); }
    void assistant.refreshRuns();
  },
  // Takes an application off the list. One that is at work is stopped; its conversation is forgotten unless kept.
  async dismissRun(id) {
    try {
      if (state.conversation?.id === id) { if (flight) detach(); set({ conversation: null }); }
      takeRuns((await api(`/api/assistant/runs/${id}`, { method: 'DELETE' })).runs);
    } catch (failure) { set({ failure: failure.message }); }
  },
  async send(text) {
    const message = text.trim();
    if (!message || state.busy) return;
    const at = new Date().toISOString();
    const base = state.conversation || { id: null, title: '', kept: false, archivedAt: null, turns: [] };
    const controller = new AbortController();
    flight = controller;
    set({ busy: true, phase: 'thinking', failure: '',
      conversation: { ...base, turns: [...base.turns, { role: 'user', text: message, at }, { role: 'assistant', text: '', tools: [], at, writing: true }] } });
    let ended = false;
    try {
      await apiLines('/api/assistant/chat', { body: { text: message, conversationId: base.id }, signal: controller.signal,
        onEvent(event) { if (flight !== controller) return; if (event.type === 'end') ended = true; handle(event); } });
    } catch (failure) {
      if (flight !== controller) return;
      // Refused before any reply started (still answering, too long, not found): the message is taken back.
      if (failure.name !== 'AbortError' && (!state.conversation?.id || base.run)) set({ conversation: base.turns.length || base.run ? base : null, failure: failure.message });
      else if (failure.name !== 'AbortError') writing(turn => ({ ...turn, error: failure.message, errorCode: 'http', writing: false }));
    }
    // The pane went to another conversation meanwhile: this one is an application and goes on by itself.
    if (flight !== controller) return;
    flight = null;
    set({ busy: false, phase: 'idle' });
    const id = state.conversation?.id;
    // A stopped or broken stream has no last word from the server: ask for the conversation as it now stands.
    if (!ended && id) {
      writing(turn => (turn.role === 'assistant' ? { ...turn, writing: false, stopped: !turn.error } : turn));
      setTimeout(() => { if (!state.busy && state.conversation?.id === id) api(`/api/assistant/conversations/${id}`).then(conversation => { if (!state.busy && state.conversation?.id === id) set({ conversation }); }).catch(() => {}); }, 600);
    }
    if (state.conversation?.kept) void assistant.refresh();
    if (state.conversation?.run) void assistant.refreshRuns();
  },
  // An application's reply goes on when nobody listens, so it is stopped by asking; any other by leaving it.
  stop() {
    const conversation = state.conversation;
    if (conversation?.run && conversation.id) api(`/api/assistant/conversations/${conversation.id}/stop`, { method: 'POST' }).catch(() => {});
    else flight?.abort();
  },
  // Compacts the open conversation: the assistant writes a summary and goes on from it. focus: what the summary
  // should keep an eye on. The turns stay on screen; a line among them marks where it happened.
  async compact(focus = '') {
    const id = state.conversation?.id;
    if (!id || state.busy) return;
    const controller = new AbortController();
    flight = controller;
    set({ busy: true, phase: 'compacting', failure: '' });
    let ended = false;
    try {
      await apiLines(`/api/assistant/conversations/${id}/compact`, { body: { focus }, signal: controller.signal,
        onEvent(event) { if (event.type === 'end') ended = true; handle(event); } });
    } catch (failure) {
      if (failure.name !== 'AbortError') set({ failure: failure.message });
    }
    flight = null;
    set({ busy: false, phase: 'idle' });
    // Stopped half way: nothing was compacted, and the conversation is asked for as it stands.
    if (!ended) setTimeout(() => { if (!state.busy && state.conversation?.id === id) api(`/api/assistant/conversations/${id}`).then(conversation => { if (!state.busy && state.conversation?.id === id) set({ conversation }); }).catch(() => {}); }, 600);
    if (state.conversation?.kept) void assistant.refresh();
  },
  // Something to tell the user that is not a reply.
  fail(failure) { set({ failure }); },
  // 助手的记忆, as edited under Settings. Each call gives back the whole list.
  memory: {
    async add(text) { keepMemory(await api('/api/assistant/memory', { method: 'POST', body: { text } })); },
    async update(id, text) { keepMemory(await api(`/api/assistant/memory/${id}`, { method: 'PATCH', body: { text } })); },
    async remove(id) { keepMemory(await api(`/api/assistant/memory/${id}`, { method: 'DELETE' })); },
  },
  // A new conversation: the one left behind is forgotten unless it was kept.
  async reset() {
    const leaving = state.conversation;
    if (leaving?.run) detach(); else flight?.abort();
    set({ conversation: null, failure: '', phase: 'idle' });
    if (leaving?.id && !leaving.run) await api(`/api/assistant/conversations/${leaving.id}/close`, { method: 'POST' }).catch(() => {});
  },
  async keep(keep) {
    const id = state.conversation?.id;
    if (!id) return;
    try {
      const result = await api(`/api/assistant/conversations/${id}/keep`, { method: 'POST', body: { keep } });
      set({ conversation: state.busy ? { ...state.conversation, kept: result.conversation.kept, archivedAt: result.conversation.archivedAt } : result.conversation, info: state.info && { ...state.info, kept: result.kept } });
    } catch (failure) { set({ failure: failure.message }); }
  },
  // Puts a kept conversation away, or takes it back out. Archiving the open one keeps it from then on.
  async archive(id, archived) {
    try {
      const result = await api(`/api/assistant/conversations/${id}/archive`, { method: 'POST', body: { archived } });
      const open = state.conversation?.id === id && result.conversation;
      set({ info: state.info && { ...state.info, kept: result.kept },
        ...(open ? { conversation: state.busy ? { ...state.conversation, kept: result.conversation.kept, archivedAt: result.conversation.archivedAt } : result.conversation } : {}) });
    } catch (failure) { set({ failure: failure.message }); }
  },
  async openKept(id) {
    if ((state.busy && !state.conversation?.run) || state.conversation?.id === id) return;
    const leaving = state.conversation;
    try {
      const conversation = await api(`/api/assistant/conversations/${id}`);
      if (flight) detach();
      set({ conversation, failure: '' });
      if (leaving?.id && !leaving.run) api(`/api/assistant/conversations/${leaving.id}/close`, { method: 'POST' }).catch(() => {});
    } catch (failure) { set({ failure: failure.message }); }
  },
  async remove(id) {
    try {
      if (state.conversation?.id === id) { if (state.conversation.run) detach(); else flight?.abort(); }
      const result = await api(`/api/assistant/conversations/${id}`, { method: 'DELETE' });
      set({ info: state.info && { ...state.info, kept: result.kept }, ...(state.conversation?.id === id ? { conversation: null } : {}) });
      if (state.runs.some(run => run.id === id)) void assistant.refreshRuns();
    } catch (failure) { set({ failure: failure.message }); }
  },
  async undo(actionId) {
    const id = state.conversation?.id;
    if (!id) return;
    try {
      await api(`/api/assistant/conversations/${id}/undo`, { method: 'POST', body: { actionId } });
      const conversation = state.conversation;
      if (conversation?.id === id) {
        set({ conversation: { ...conversation, turns: conversation.turns.map(turn => (turn.tools
          ? { ...turn, tools: turn.tools.map(tool => (tool.id === actionId ? { ...tool, undone: true, undoable: false } : tool)) } : turn)) } });
      }
      effect({ undone: true, changed: true });
      // What was taken back may have been a note in the assistant's memory.
      void assistant.refresh();
    } catch (failure) { set({ failure: failure.message }); }
  },
  async saveSettings(patch) {
    try {
      const settings = await api('/api/assistant/settings', { method: 'PATCH', body: patch });
      set({ info: state.info && { ...state.info, settings } });
      return true;
    } catch (failure) { set({ failure: failure.message }); return false; }
  },
  clearFailure() { if (state.failure) set({ failure: '' }); },
};
