import { useSyncExternalStore } from 'react';
import { api, apiLines } from '../../api.js';

// The assistant's state for the window: the open conversation, what the gramophone is doing, and the list of kept
// conversations. It lives outside the pane so a reply carries on while the pane is closed.
//
// phase: idle | thinking | speaking | tool (the gramophone's four looks).
let state = { open: read() === 'open', info: null, conversation: null, busy: false, phase: 'idle', failure: '' };
const listeners = new Set();
const effects = new Set();
const hearers = new Set();
let flight = null;

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

const lastTurn = conversation => conversation.turns[conversation.turns.length - 1];
// The reply being written is the last turn; every change makes a new conversation object for React.
function writing(change) {
  const conversation = state.conversation;
  if (!conversation) return;
  const turns = conversation.turns.slice();
  turns[turns.length - 1] = change({ ...lastTurn(conversation) });
  set({ conversation: { ...conversation, turns } });
}

function handle(event) {
  if (event.type === 'start') set({ conversation: { ...state.conversation, ...event.conversation }, phase: 'thinking' });
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
    writing(turn => ({ ...turn, tools: turn.tools.map(tool => (tool.id === event.id ? event.tool : tool)) }));
    effect({ tool: event.tool, changed: event.changed, applied: event.applied, ui: event.ui });
  } else if (event.type === 'end') set({ conversation: event.conversation });
}

export const assistant = {
  get: () => state,
  setOpen(open) {
    try { sessionStorage.setItem('dayjob-assistant', open ? 'open' : 'closed'); } catch { /* optional */ }
    set({ open });
    if (open && !state.info) void assistant.refresh();
  },
  // Which engines can run, the chosen one, and the kept conversations.
  async refresh() {
    try { set({ info: await api('/api/assistant') }); } catch (failure) { set({ failure: failure.message }); }
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
        onEvent(event) { if (event.type === 'end') ended = true; handle(event); } });
    } catch (failure) {
      // Refused before any reply started (still answering, too long, not found): the message is taken back.
      if (failure.name !== 'AbortError' && !state.conversation?.id) set({ conversation: base.turns.length ? base : null, failure: failure.message });
      else if (failure.name !== 'AbortError') writing(turn => ({ ...turn, error: failure.message, errorCode: 'http', writing: false }));
    }
    flight = null;
    set({ busy: false, phase: 'idle' });
    const id = state.conversation?.id;
    // A stopped or broken stream has no last word from the server: ask for the conversation as it now stands.
    if (!ended && id) {
      writing(turn => (turn.role === 'assistant' ? { ...turn, writing: false, stopped: !turn.error } : turn));
      setTimeout(() => { if (!state.busy && state.conversation?.id === id) api(`/api/assistant/conversations/${id}`).then(conversation => { if (!state.busy && state.conversation?.id === id) set({ conversation }); }).catch(() => {}); }, 600);
    }
    if (state.conversation?.kept) void assistant.refresh();
  },
  stop() { flight?.abort(); },
  // A new conversation: the one left behind is forgotten unless it was kept.
  async reset() {
    flight?.abort();
    const id = state.conversation?.id;
    set({ conversation: null, failure: '', phase: 'idle' });
    if (id) await api(`/api/assistant/conversations/${id}/close`, { method: 'POST' }).catch(() => {});
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
    if (state.busy || state.conversation?.id === id) return;
    const leaving = state.conversation?.id;
    try {
      const conversation = await api(`/api/assistant/conversations/${id}`);
      set({ conversation, failure: '' });
      if (leaving) api(`/api/assistant/conversations/${leaving}/close`, { method: 'POST' }).catch(() => {});
    } catch (failure) { set({ failure: failure.message }); }
  },
  async remove(id) {
    try {
      if (state.conversation?.id === id) flight?.abort();
      const result = await api(`/api/assistant/conversations/${id}`, { method: 'DELETE' });
      set({ info: state.info && { ...state.info, kept: result.kept }, ...(state.conversation?.id === id ? { conversation: null } : {}) });
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
