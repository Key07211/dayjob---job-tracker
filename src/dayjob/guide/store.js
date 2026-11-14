import { useSyncExternalStore } from 'react';
import { GUIDE_VERSION } from './steps.js';

// Whether a guide is on the window, which one, and whether this computer has seen the first one. That one (tour
// 'app': the greeting and every page) shows by itself once: the first time Dayjob opens here, after the opening has
// played. After that a guide is only shown when asked for. The other (tour 'settings') explains the Settings page
// group by group; `at` is the group it starts at, and scrollY is how far down the window was when it was asked for
// (the page is laid out differently while that guide is up, and takes over from there).
const SEEN = 'dayjob-guide';
const OFF = { on: false, auto: false, tour: 'app', at: null, scrollY: 0 };
let state = OFF;
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
  start({ auto = false, tour = 'app', at = null } = {}) { if (!state.on) set({ on: true, auto, tour, at, scrollY: typeof window === 'undefined' ? 0 : window.scrollY }); },
  stop() { if (state.on) set(OFF); },
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
