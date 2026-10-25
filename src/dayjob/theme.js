import { useSyncExternalStore } from 'react';
import { DEFAULT_HOURS, nextTurn, nightAt, parseHours } from './daynight.js';

// Day or night: by the clock (the default), following Windows, or chosen outright. The clock's minute tick also
// drives the time shown in each page's header. When the clock turns the theme, the new one sweeps over the
// page slowly (night falls from the top, day rises from the bottom); a choice in Settings sweeps quickly.
// The day/night switch in the header turns it at once. By the clock, what it chose holds until the clock's next
// turn (switching night to day at 21:00 holds until 07:00, when it is day anyway), and then the clock leads again.
export const THEME_CHOICES = ['time', 'system', 'light', 'dark'];
const CHOICE_KEY = 'dayjob-theme';
const HOURS_KEY = 'dayjob-theme-hours';
const HOLD_KEY = 'dayjob-theme-hold';
const SLOW = 2400;
const QUICK = 900;

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const keep = (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional */ } };
const readChoice = () => (THEME_CHOICES.includes(read(CHOICE_KEY)) ? read(CHOICE_KEY) : 'time');
const readHours = () => { try { return parseHours(JSON.parse(read(HOURS_KEY) || 'null')); } catch { return { ...DEFAULT_HOURS }; } };
// { night, until }: the switch's choice and the time (ms) of the clock's next turn, when it ends.
const readHold = () => {
  try {
    const hold = JSON.parse(read(HOLD_KEY) || 'null');
    return hold && typeof hold.night === 'boolean' && Number.isFinite(hold.until) && hold.until > Date.now() ? { night: hold.night, until: hold.until } : null;
  } catch { return null; }
};
const forget = key => { try { localStorage.removeItem(key); } catch { /* optional */ } };
const systemDark = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
const reduced = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

let state = typeof window === 'undefined'
  ? { choice: 'time', hours: { ...DEFAULT_HOURS }, hold: null, minute: 0 }
  : { choice: readChoice(), hours: readHours(), hold: readHold(), minute: Math.floor(Date.now() / 60000) };
const listeners = new Set();
const publish = patch => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };

function wantsNight(now = new Date()) {
  if (state.choice === 'dark') return true;
  if (state.choice === 'light') return false;
  if (state.choice === 'system') return systemDark();
  if (state.hold && now.getTime() < state.hold.until) return state.hold.night;
  return nightAt(now, state.hours);
}

function setHold(hold) {
  if (hold) keep(HOLD_KEY, JSON.stringify(hold)); else forget(HOLD_KEY);
  publish({ hold });
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
  setHold(null);
  publish({ choice });
  apply(wantsNight(), QUICK);
}

export function setThemeHours(hours) {
  const next = parseHours({ ...state.hours, ...hours });
  keep(HOURS_KEY, JSON.stringify(next));
  setHold(null);
  publish({ hours: next });
  apply(wantsNight(), QUICK);
}

// The header switch: day to night or back. By the clock it holds until the next turn; switching back to what the
// clock says lets go of the hold. With a fixed theme, or one following Windows, it picks light or dark outright.
// Returns whether it is now night.
export function toggleTheme() {
  const night = document.documentElement.dataset.theme !== 'night';
  if (state.choice !== 'time') {
    setThemeChoice(night ? 'dark' : 'light');
    return night;
  }
  const now = new Date();
  setHold(night === nightAt(now, state.hours) ? null : { night, until: (Math.floor(now.getTime() / 60000) + nextTurn(now, state.hours)) * 60000 });
  apply(night, QUICK);
  return night;
}

// When a switch made now would hold until, as HH:MM, or null when it would simply follow the clock again.
export function holdEndsAt(now = new Date()) {
  if (state.choice !== 'time') return null;
  if (state.hold && now.getTime() < state.hold.until) return null;
  const at = new Date((Math.floor(now.getTime() / 60000) + nextTurn(now, state.hours)) * 60000);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

export const releaseThemeHold = () => { setHold(null); apply(wantsNight(), QUICK); };

// The minute tick: the header clocks move, and by the clock the theme turns when its time comes. After the computer
// sleeps the timer is late, so coming back to the window checks again at once.
let started = false;
export function startThemeClock() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const tick = () => {
    if (state.hold && Date.now() >= state.hold.until) setHold(null);
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
