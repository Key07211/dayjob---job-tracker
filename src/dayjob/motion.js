import { useLayoutEffect, useRef, useState } from 'react';

// The motion tokens live in dayjob.css (:root); "reduce" sets every duration to 0.
export const MOTION_KEY = 'dayjob-motion';
const ms = value => {
  const text = String(value).trim();
  const number = parseFloat(text) || 0;
  return text.endsWith('ms') ? number : number * 1000;
};

export function motion() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const token = name => style.getPropertyValue(name).trim();
  return {
    reduced: root.dataset.motion === 'reduce',
    fast: ms(token('--dur-fast')), base: ms(token('--dur-base')), slow: ms(token('--dur-slow')), stagger: ms(token('--stagger')),
    easeOut: token('--ease-out') || 'ease-out', spring: token('--ease-spring') || 'ease-out',
  };
}

// "system" follows Windows' Animation effects setting (prefers-reduced-motion); public/theme-init.js does the same before paint.
export function applyMotion(choice) {
  const reduce = choice === 'reduce' || (choice !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  document.documentElement.dataset.motion = reduce ? 'reduce' : 'full';
}

export function useCountUp(value, play) {
  const [shown, setShown] = useState(value);
  useLayoutEffect(() => {
    const { slow } = motion();
    if (!play || typeof value !== 'number' || !slow) { setShown(value); return undefined; }
    const duration = slow * 2;
    const start = performance.now();
    let frame = 0;
    const step = now => {
      const progress = Math.min(1, (now - start) / duration);
      setShown(Math.round(value * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    setShown(0);
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, play]);
  return shown;
}

export function CountUp({ value, play }) {
  return useCountUp(value, play);
}

// Rows of a list, marked with data-key: a row that moved slides from where it
// was (FLIP), and rows that join a list that kept others fade in one after
// another. Only rows in view move; a list replaced wholesale just shows.
export function useListMotion(listRef, keys) {
  const last = useRef(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rows = [...list.querySelectorAll(':scope > [data-key]')];
    const positions = new Map(rows.map(row => [row.dataset.key, row.offsetTop]));
    const before = last.current;
    last.current = { keys, positions };
    if (!before || before.keys === keys) return;
    const { base, slow, stagger, easeOut, spring } = motion();
    if (!slow) return;
    const top = list.scrollTop;
    const bottom = top + list.clientHeight;
    const shown = rows.filter(row => {
      const y = positions.get(row.dataset.key);
      return y + row.offsetHeight > top && y < bottom;
    });
    const entering = shown.filter(row => !before.positions.has(row.dataset.key));
    if (entering.length === shown.length) return;
    for (const row of shown) {
      const was = before.positions.get(row.dataset.key);
      const now = positions.get(row.dataset.key);
      if (was !== undefined && was !== now) row.animate([{ transform: `translateY(${was - now}px)` }, { transform: 'none' }], { duration: slow, easing: easeOut });
    }
    entering.slice(0, 15).forEach((row, index) => {
      const delay = index * stagger;
      row.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: base, delay, easing: easeOut, fill: 'backwards' });
      row.querySelector('.tag-new')?.animate([{ transform: 'scale(1.5)' }, { transform: 'none' }], { duration: slow, delay: delay + base / 2, easing: spring, fill: 'backwards' });
    });
  });
}
