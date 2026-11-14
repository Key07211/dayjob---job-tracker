import { useSyncExternalStore } from 'react';
import { GUIDE_VERSION } from './steps.js';

// Whether the user guide is on the window, and whether this computer has seen it. The guide shows by itself once:
// the first time Dayjob opens here, after the opening has played. After that it is only shown when asked for.
const SEEN = 'dayjob-guide';
let state = { on: false, auto: false };
const listeners = new Set();
const set = patch => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const useGuide = () => useSyncExternalStore(subscribe, () => state, () => state);

// What the assistant says in the guide goes to the guide's own gramophone, the way a reply's words go to the pane's.
const hearers = new Set();
export const guideVoice = listener => { hearers.add(listener); return () => hearers.delete(listener); };
export const say = text => hearers.forEach(listener => listener(text));

export const guide = {
  get: () => state,
  // Without storage there is no telling a first time from a later one, so the guide never shows by itself.
  seen() { try { return Boolean(localStorage.getItem(SEEN)); } catch { return true; } },
  markSeen() { try { localStorage.setItem(SEEN, String(GUIDE_VERSION)); } catch { /* it is asked for by hand then */ } },
  // auto: it came by itself (the first time), not because the user asked.
  start({ auto = false } = {}) { if (!state.on) set({ on: true, auto }); },
  stop() { if (state.on) set({ on: false, auto: false }); },
  // The first time: starts once the window is in sight (a window opened to the tray waits until it is shown), a
  // moment after the opening has given way. Returns what cancels the wait.
  firstTime(delay = 0) {
    if (guide.seen() || state.on) return () => {};
    let timer = 0;
    const begin = () => {
      if (document.visibilityState !== 'visible' || timer) return;
      document.removeEventListener('visibilitychange', begin);
      timer = setTimeout(() => { if (!guide.seen()) guide.start({ auto: true }); }, delay);
    };
    document.addEventListener('visibilitychange', begin);
    begin();
    return () => { document.removeEventListener('visibilitychange', begin); clearTimeout(timer); };
  },
};
