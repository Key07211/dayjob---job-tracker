import { useSyncExternalStore } from 'react';
import { DEFAULT_HOURS, nightAt, parseHours } from './daynight.js';

// Day or night: by the clock (the default), following Windows, or chosen outright. The clock's minute tick also
// drives the time shown in each page's header. When the clock turns the theme, the new one sweeps over the
// page slowly (night falls from the top, day rises from the bottom); a choice in Settings sweeps quickly.
export const THEME_CHOICES = ['time', 'system', 'light', 'dark'];
const CHOICE_KEY = 'dayjob-theme';
const HOURS_KEY = 'dayjob-theme-hours';
const SLOW = 2400;
const QUICK = 900;

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const keep = (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional */ } };
const readChoice = () => (THEME_CHOICES.includes(read(CHOICE_KEY)) ? read(CHOICE_KEY) : 'time');
const readHours = () => { try { return parseHours(JSON.parse(read(HOURS_KEY) || 'null')); } catch { return { ...DEFAULT_HOURS }; } };
const systemDark = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
const reduced = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

let state = typeof window === 'undefined'
  ? { choice: 'time', hours: { ...DEFAULT_HOURS }, minute: 0 }
  : { choice: readChoice(), hours: readHours(), minute: Math.floor(Date.now() / 60000) };
const listeners = new Set();
const publish = patch => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };

function wantsNight(now = new Date()) {
  if (state.choice === 'dark') return true;
  if (state.choice === 'light') return false;
  if (state.choice === 'system') return systemDark();
  return nightAt(now, state.hours);
}

let sweeping = 0;
function apply(night, duration) {
  const root = document.documentElement;
  const next = night ? 'night' : 'day';
  if (root.dataset.theme === next) return;
  const set = () => { root.dataset.theme = next; root.style.colorScheme = night ? 'dark' : 'light'; };
  if (!duration || reduced() || !document.startViewTransition || document.hidden) { set(); return; }
  clearTimeout(sweeping);
  root.style.setProperty('--theme-sweep', `${duration}ms`);
  root.classList.add(night ? 'to-night' : 'to-day');
  const done = () => root.classList.remove('to-night', 'to-day');
  try {
    document.startViewTransition(set).finished.then(done, done);
  } catch { set(); done(); }
  // A transition that never settles still gives the classes back.
  sweeping = setTimeout(done, duration + 400);
}

export const themeSettings = { get: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
export const useThemeSettings = () => useSyncExternalStore(themeSettings.subscribe, themeSettings.get, themeSettings.get);

export function setThemeChoice(choice) {
  if (!THEME_CHOICES.includes(choice)) return;
  keep(CHOICE_KEY, choice);
  publish({ choice });
  apply(wantsNight(), QUICK);
}

export function setThemeHours(hours) {
  const next = parseHours({ ...state.hours, ...hours });
  keep(HOURS_KEY, JSON.stringify(next));
  publish({ hours: next });
  apply(wantsNight(), QUICK);
}

// The minute tick: the header clocks move, and by the clock the theme turns when its time comes. After the computer
// sleeps the timer is late, so coming back to the window checks again at once.
let started = false;
export function startThemeClock() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const tick = () => {
    publish({ minute: Math.floor(Date.now() / 60000) });
    apply(wantsNight(), SLOW);
  };
  const schedule = () => setTimeout(() => { tick(); schedule(); }, 60000 - (Date.now() % 60000) + 50);
  schedule();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (state.choice === 'system') apply(wantsNight(), SLOW); });
  apply(wantsNight(), 0);
}

export const useMinute = () => useThemeSettings().minute;
