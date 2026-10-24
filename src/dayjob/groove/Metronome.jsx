import { useEffect, useRef } from 'react';
import { BEAT, reducedMotion } from './sound.js';
import { useGroove } from './bus.js';

const TOP = 16;
const X = 14;

// While a batch is scored, the sidebar's edge becomes a line that fills from the top. It stays straight; before a
// score lands the head pulls back and the line tightens into a ripple (charging), then it dashes forward with a small
// spring bounce and a surge runs down it, and it settles straight again.
export function Metronome({ active, done, total }) {
  const svg = useRef(null);
  const parts = useRef({});
  const m = useRef({ y: TOP, v: 0, target: TOP, surge: 0, surgeAt: 0, charge: 0, charging: false, chargeAt: 0, pullTo: TOP, pulse: 0, last: 0, frame: 0, len: 0, live: false });
  const fill = useRef(() => TOP);

  const draw = now => {
    const p = parts.current;
    const s = m.current;
    if (!p.line) return false;
    const dt = s.last ? Math.min(0.05, (now - s.last) / 1000) : 0;
    s.last = now;
    // An underdamped spring (about 15% overshoot) carries the head, so every dash lands with a small bounce.
    s.v += (170 * (s.target - s.y) - 13 * s.v) * dt;
    s.y += s.v * dt;
    if (s.charging && now >= s.chargeAt) {
      s.target = s.pullTo;
      s.charge = Math.min(1, (now - s.chargeAt) / (BEAT / 2));
      if (s.charge >= 1) {
        s.charging = false;
        s.target = fill.current();
        s.surge = 1;
        s.surgeAt = now;
        s.pulse = 1;
      }
    } else if (!s.charging) s.charge *= Math.exp(-dt * 10);
    s.pulse *= Math.exp(-dt * 7);
    s.surge *= Math.exp(-dt * 7);
    const settled = !s.charging && s.surge < 0.02 && s.charge < 0.02 && Math.abs(s.v) < 0.3 && Math.abs(s.target - s.y) < 0.3;
    if (settled) s.y = s.target;
    const tip = Math.max(TOP, s.y);
    const len = tip - TOP;
    const k = 0.3 + 0.18 * s.charge;
    const calm = s.charge < 0.01 && s.surge < 0.01;
    const yc = TOP + len * Math.min(1, (now - s.surgeAt) / 320);
    let d = `M${X} ${TOP}`;
    if (!settled && !calm && len > 4) {
      for (let y = TOP + 2; y < tip; y += 2) {
        const env = Math.pow(Math.sin(Math.PI * (y - TOP) / len), 0.7);
        const a = 3 * s.charge * env + (2.5 + 7 * Math.exp(-Math.pow((y - yc) / 12, 2))) * s.surge * env;
        d += ` L${(X + a * Math.sin(k * y - now * 0.011)).toFixed(2)} ${y}`;
      }
    }
    d += ` L${X} ${tip.toFixed(1)}`;
    // Fully retracted and idle, nothing is drawn (a zero-length line would still show its round cap as a dot).
    if (!s.live && len < 0.5) d = '';
    p.line.setAttribute('d', d);
    p.glow.setAttribute('d', d);
    p.glow.setAttribute('opacity', settled ? '0' : (0.3 * s.charge + 0.3 * s.surge).toFixed(3));
    const live = s.live;
    p.head.setAttribute('cy', tip.toFixed(1));
    p.head.setAttribute('r', live ? (4.5 + 1.2 * s.pulse - 0.9 * s.charge).toFixed(2) : '0');
    p.halo.setAttribute('cy', tip.toFixed(1));
    p.halo.setAttribute('r', live ? (7 + 6 * s.charge + 4 * s.pulse).toFixed(2) : '0');
    p.halo.setAttribute('opacity', live ? (0.12 + 0.3 * s.charge + 0.2 * s.pulse).toFixed(3) : '0');
    const streak = live ? Math.min(46, Math.max(0, s.v) * 0.09) : 0;
    p.trail.setAttribute('y', (tip - streak).toFixed(1));
    p.trail.setAttribute('height', streak.toFixed(1));
    return !settled;
  };
  const run = () => {
    const s = m.current;
    if (reducedMotion()) {
      Object.assign(s, { y: s.target, v: 0, surge: 0, charge: 0, charging: false, pulse: 0 });
      draw(performance.now());
      return;
    }
    if (s.frame) return;
    s.last = 0;
    const loop = now => { s.frame = draw(now) ? requestAnimationFrame(loop) : 0; };
    s.frame = requestAnimationFrame(loop);
  };

  useEffect(() => {
    const el = svg.current;
    parts.current = { line: el.querySelector('.mw-line'), glow: el.querySelector('.mw-glow'), head: el.querySelector('.mw-head'), halo: el.querySelector('.mw-halo'), trail: el.querySelector('.mw-trail') };
    const measure = () => { m.current.len = Math.max(40, el.getBoundingClientRect().height - TOP * 2); run(); };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => { observer.disconnect(); cancelAnimationFrame(m.current.frame); m.current.frame = 0; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  fill.current = () => TOP + Math.round((total ? Math.min(done, total) / total : 0) * m.current.len);
  useEffect(() => {
    const s = m.current;
    s.live = active;
    if (!s.charging) s.target = active ? fill.current() : TOP;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, done, total]);

  // A score landed: charge for half a beat, then dash to the new fill.
  useGroove('score', () => {
    const s = m.current;
    if (!s.live) return;
    Object.assign(s, { charging: true, charge: 0, chargeAt: performance.now(), pullTo: Math.max(10, s.y - 7) });
    run();
  });

  return (
    <svg ref={svg} className={`metronome${active ? ' live' : ''}`} aria-hidden="true">
      <defs><linearGradient id="mw-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0" /><stop offset="1" stopColor="currentColor" stopOpacity="0.6" /></linearGradient></defs>
      <line className="mw-rail" x1={X} y1={TOP} x2={X} y2="100%" />
      <path className="mw-glow" d={`M${X} ${TOP}`} fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" opacity="0" />
      <path className="mw-line" d={`M${X} ${TOP}`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect className="mw-trail" x={X - 3} y={TOP} width="6" height="0" rx="3" fill="url(#mw-grad)" />
      <circle className="mw-halo" cx={X} cy={TOP} r="0" fill="currentColor" opacity="0" />
      <circle className="mw-head" cx={X} cy={TOP} r="0" fill="currentColor" />
    </svg>
  );
}
