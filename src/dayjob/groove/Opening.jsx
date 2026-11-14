import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { prefs } from './prefs.js';
import { reducedMotion } from './sound.js';
import { BEAT, OPENING_TOKENS, OUT, T_OUT, buildAssets, fitStage, outTime, paintOpening, pickOpening } from './opening-scenes.js';

// The opening: when Dayjob's window first shows, one of three short pixel pictures plays over the page (the
// gramophone plays, sheets become a wave, sheets go into the briefcase; see opening-scenes.js), a different one from
// last time, and then gives way to the page a few pixels at a time.
//
// It draws on one canvas of big square pixels that covers the window. Its first frame is painted before the window
// is, so there is never an empty cover. It starts the moment the page is visible, however the page comes to know of
// that (the window is shown just as the page first renders, and the event for it can be missed), lasts four beats,
// and holds for whole beats more while the first data is still on its way. It always ends by a timer, since a window
// that is not drawn gets no frames.
// A click or a key skips it. It plays once per window (not after a reload, nor when the window comes back from the
// tray), only when the window is shown soon after it loads, and never when Windows asks for reduced motion.
const WAIT = 2500;       // how long the window may take to be shown before the opening gives up
const PATIENCE = 8;      // beats it holds for data that is slow to come
const SEEN = 'dayjob-opened';
const LAST = 'dayjob-opening-last';

function firstOpen() {
  if (typeof window === 'undefined' || reducedMotion() || prefs.get().opening === false) return false;
  try {
    if (sessionStorage.getItem(SEEN)) return false;
    sessionStorage.setItem(SEEN, '1');
    return true;
  } catch { return false; }
}
let playing = firstOpen();
// Whether the opening is (still) covering the page, so the sidebar's logo skips its own arrival under it.
export const openingPlays = () => playing;

// Which of the three this window plays: chosen once, and remembered only when it really starts.
let chosen = null;
function chosenOpening() {
  if (!chosen) {
    let last = null;
    try { last = localStorage.getItem(LAST); } catch { /* optional */ }
    chosen = pickOpening(last);
  }
  return chosen;
}

// ready: the first data has arrived; failed: it could not arrive (the page under the opening says so).
// onEnd: called once when it has given way to the page (never when no opening plays; see openingPlays).
export function Opening({ ready, failed, onEnd }) {
  const [on, setOn] = useState(playing);
  const cover = useRef(null);
  const canvas = useRef(null);
  const run = useRef(null);
  const ended = useRef(onEnd);
  ended.current = onEnd;

  // Ends it at once: the cover goes, wherever the picture was.
  const close = useCallback(() => {
    if (!playing) return;
    playing = false;
    run.current?.stop();
    setOn(false);
    ended.current?.();
  }, []);

  useLayoutEffect(() => {
    if (!on || !cover.current || !canvas.current) return undefined;
    const shown = canvas.current;
    const ctx = shown.getContext('2d');
    const buffer = document.createElement('canvas');
    const g = buffer.getContext('2d');
    if (!ctx || !g) { close(); return undefined; }
    const style = getComputedStyle(cover.current);
    const colors = Object.fromEntries(Object.entries(OPENING_TOKENS).map(([name, token]) => [name, style.getPropertyValue(token).trim() || '#888888']));
    const assets = buildAssets(colors, (width, height) => Object.assign(document.createElement('canvas'), { width, height }));
    const id = chosenOpening();
    let stage = null;
    let started = null;      // performance.now() when it began; null while the window is not shown yet
    let readyAt = null;      // when the first data came, on the opening's own clock
    let tOut = Infinity;     // when it starts to give way, once that is known
    let raf = 0;
    let stopped = false;
    const timers = [];
    const later = (work, ms) => { const timer = setTimeout(work, ms); timers.push(timer); return timer; };
    const clock = () => (started === null ? 0 : performance.now() - started);

    const fit = () => {
      const ratio = window.devicePixelRatio || 1;
      const next = fitStage(window.innerWidth, window.innerHeight, ratio);
      if (stage && next.k === stage.k && next.W === stage.W && next.H === stage.H) return;
      stage = next;
      shown.width = next.W * next.k;
      shown.height = next.H * next.k;
      shown.style.width = `${shown.width / ratio}px`;
      shown.style.height = `${shown.height / ratio}px`;
      buffer.width = next.W;
      buffer.height = next.H;
    };
    const paint = t => {
      paintOpening(g, id, t, tOut, stage.W, stage.H, colors, assets);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, shown.width, shown.height);
      ctx.drawImage(buffer, 0, 0, shown.width, shown.height);
    };
    // Fixes the moment it gives way as soon as that can be known, and sets the timer that ends it then.
    const plan = () => {
      if (stopped || started === null || tOut !== Infinity) return;
      const out = outTime(readyAt, clock(), PATIENCE);
      if (out === Infinity) return;
      tOut = out;
      later(close, Math.max(0, tOut + OUT - clock()) + 40);
    };
    const tick = () => {
      if (stopped) return;
      const t = clock();
      if (t >= tOut + OUT) { close(); return; }
      paint(t);
      raf = requestAnimationFrame(tick);
    };
    const begin = () => {
      if (stopped || started !== null || document.visibilityState !== 'visible') return;
      started = performance.now();
      try { localStorage.setItem(LAST, id); } catch { /* optional */ }
      clearInterval(poll);
      later(plan, T_OUT + PATIENCE * BEAT + 20);
      plan();
      raf = requestAnimationFrame(tick);
    };
    const resize = () => { fit(); paint(clock()); };
    // A key skips it too (it covers the page, so nothing under it is waiting for the key).
    const key = event => { if (!event.repeat) close(); };

    run.current = {
      settle() { if (readyAt === null) readyAt = clock(); plan(); },
      stop() {
        stopped = true;
        cancelAnimationFrame(raf);
        clearInterval(poll);
        timers.forEach(clearTimeout);
        document.removeEventListener('visibilitychange', begin);
        window.removeEventListener('resize', resize);
        window.removeEventListener('keydown', key, true);
      },
    };
    fit();
    paint(0);
    document.addEventListener('visibilitychange', begin);
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', key, true);
    // The event alone is not enough: the window can turn visible between the first render and this line. So look
    // now, and keep looking for as long as the opening is willing to wait.
    const poll = setInterval(begin, 120);
    later(() => { if (started === null) close(); }, WAIT);
    begin();
    return () => { run.current?.stop(); run.current = null; };
  }, [on, close]);

  const settled = Boolean(ready || failed);
  useEffect(() => { if (on && settled) run.current?.settle(); }, [on, settled]);

  if (!on) return null;
  return <div ref={cover} className="opening" onClick={close} aria-hidden="true"><canvas ref={canvas} /></div>;
}
