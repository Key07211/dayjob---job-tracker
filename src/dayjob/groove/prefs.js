import { useSyncExternalStore } from 'react';

// Sound and music choices for this computer. They only change how Dayjob sounds and moves, so they live in
// the browser storage; if that is unavailable the defaults still work for the session.
export const KEY_WINDOWS = [500, 750, 1000, 1500, 2000];
// How the header wave draws the music: glowing bars, stacked dots, or one soft line.
export const WAVE_STYLES = ['beam', 'dots', 'flow'];
const DEFAULTS = { sound: false, keyWindow: 750, tune: 'auto', followMusic: false, waveStyle: 'beam' };
const STORAGE_KEY = 'dayjob-groove';

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      sound: saved.sound === true,
      keyWindow: KEY_WINDOWS.includes(saved.keyWindow) ? saved.keyWindow : DEFAULTS.keyWindow,
      // A piece from an older Dayjob that is no longer offered goes back to following the theme.
      tune: ['auto', 'prelude', 'gymnopedie', 'traumerei'].includes(saved.tune) ? saved.tune : DEFAULTS.tune,
      followMusic: saved.followMusic === true,
      waveStyle: WAVE_STYLES.includes(saved.waveStyle) ? saved.waveStyle : DEFAULTS.waveStyle,
    };
  } catch { return { ...DEFAULTS }; }
}

let current = typeof window === 'undefined' ? { ...DEFAULTS } : load();
const listeners = new Set();

export const prefs = {
  get: () => current,
  set(patch) {
    current = { ...current, ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* optional */ }
    listeners.forEach(listener => listener());
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function usePrefs() {
  return useSyncExternalStore(prefs.subscribe, prefs.get, prefs.get);
}

// The theme the page shows now ('day' or 'night'), which picks the sidebar's tune when it follows the theme.
const themeNow = () => (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'night' ? 'night' : 'day');
function watchTheme(listener) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
export function useTheme() {
  return useSyncExternalStore(watchTheme, themeNow, themeNow);
}
