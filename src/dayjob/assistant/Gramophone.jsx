import { useEffect, useRef } from 'react';
import { reducedMotion } from '../groove/sound.js';
import { BAYER, COLORS, H, NOTES, OX, OY, W, frame, mouth } from './gramophone.js';
import { countTokens, createHorn } from './horn.js';
import { onAssistantWords } from './store.js';

// The assistant's face: a pixel gramophone. It only moves while something is happening (see horn.js), and while it
// answers, its horn pushes notes out as fast as the words come; each note drifts off and goes a few pixels at a time.
//
//   strip   the one in the pane's header: the canvas runs the whole width of the header, behind the title, so the
//           notes can drift along its top edge. It tells the header how tall and wide the gramophone is.
//   live    the small one on the sidebar's card: it moves with the reply like the header's, inside its own frame.
//   (none)  a still picture, for the empty conversation.
//
// The art is drawn at sprite size and enlarged by a whole number of screen pixels, so it stays sharp at any display
// scaling; that is why its size on the page can differ a little from scale x sprite size.

const RGB = COLORS.map(hex => (hex ? [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)) : null));
const sprites = new Map();
function sprite(grow, spin, crank) {
  const key = `${grow}|${spin}|${crank}`;
  let canvas = sprites.get(key);
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d'), image = g.createImageData(W, H), pixels = frame(grow, spin, crank);
  for (let i = 0; i < pixels.length; i += 1) {
    const colour = RGB[pixels[i]];
    if (!colour) continue;
    image.data[i * 4] = colour[0]; image.data[i * 4 + 1] = colour[1]; image.data[i * 4 + 2] = colour[2]; image.data[i * 4 + 3] = 255;
  }
  g.putImageData(image, 0, 0);
  sprites.set(key, canvas);
  return canvas;
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const MAX_NOTES = 9;               // in the air at once
const NOTE_GAP = 110;              // ms between two notes, so quick speech does not smear into a line
const STRIP_TOP = 4, STRIP_BOTTOM = 15;   // the band the notes keep to, above the title

function startStage(host, canvas, { scale, strip, live, phaseOf }) {
  const ctx = canvas.getContext('2d');
  const buffer = document.createElement('canvas'), g = buffer.getContext('2d');
  const horn = createHorn();
  let width = 0, unit = scale, k = 0, colours = ['#34719F', '#B5760A'], notes = [], look = { grow: 0, spin: 0, crank: -1 }, raf = 0, last = 0, lastNote = 0, stopped = false;

  function palette() {
    const style = getComputedStyle(host);
    colours = [style.getPropertyValue('--gram-note-a').trim() || colours[0], style.getPropertyValue('--gram-note-b').trim() || colours[1]];
  }
  function fit() {
    const ratio = window.devicePixelRatio || 1;
    const nextK = Math.max(1, Math.round(scale * ratio)), nextUnit = nextK / ratio;
    const room = strip ? host.parentElement.clientWidth : W * nextUnit;
    const nextWidth = strip ? Math.max(W, Math.floor(room / nextUnit)) : W;
    if (nextWidth === width && nextK === k) return;
    width = nextWidth; k = nextK; unit = nextUnit;
    canvas.width = width * k; canvas.height = H * k;
    canvas.style.width = `${width * unit}px`; canvas.style.height = `${H * unit}px`;
    buffer.width = width; buffer.height = H;
    if (strip) {
      const head = host.parentElement.style;
      head.setProperty('--gram-w', `${W * unit}px`);
      head.setProperty('--gram-h', `${H * unit}px`);
      host.style.setProperty('--gram-mouth-x', `${(OX + mouth(0).cx) * unit}px`);
      host.style.setProperty('--gram-mouth-y', `${(OY + mouth(0).cy) * unit}px`);
    }
    draw();
  }
  function throwNote(grow, boost) {
    const now = performance.now();
    if (notes.length >= MAX_NOTES || now - lastNote < NOTE_GAP) return;
    lastNote = now;
    const from = mouth(grow), angle = -0.08 + (Math.random() - 0.5) * 0.22, speed = (64 + Math.random() * 30) * boost;
    notes.push({ x: OX + from.cx + 2 + Math.random() * 3, y: OY + from.cy - 4 + (Math.random() - 0.5) * 6, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      age: 0, life: 1 + Math.random() * 0.4, kind: (Math.random() * NOTES.length) | 0, colour: Math.random() < 0.62 ? 0 : 1, sway: Math.random() * 6.28, seed: (Math.random() * 16) | 0 });
  }
  function moveNotes(dt) {
    const drag = Math.exp(-dt);
    notes = notes.filter(note => {
      note.age += dt;
      if (note.age >= note.life) return false;
      note.vx *= drag; note.vy *= drag;
      note.x += note.vx * dt;
      note.y = clamp(note.y + (note.vy + Math.sin(note.age * 6 + note.sway) * 4) * dt, STRIP_TOP, STRIP_BOTTOM);
      return note.x < width + 4;
    });
  }
  function paintNote(note) {
    const t = note.age / note.life, glyph = NOTES[note.kind];
    // It comes in over a few frames, holds, then goes a few pixels at a time.
    const cover = t < 0.45 ? Math.min(1, note.age / 0.08) : 1 - (t - 0.45) / 0.55;
    const x0 = Math.round(note.x - glyph.w / 2), y0 = Math.round(note.y - glyph.h / 2);
    g.fillStyle = colours[note.colour];
    g.globalAlpha = t < 0.6 ? 1 : t < 0.8 ? 0.8 : 0.6;
    for (let row = 0; row < glyph.h; row += 1) for (let col = 0; col < glyph.w; col += 1) {
      if (!glyph.on[row][col]) continue;
      if ((BAYER[(row + note.seed) & 3][(col + (note.seed >> 2)) & 3] + 0.5) / 16 > cover) continue;
      g.fillRect(x0 + col, y0 + row, 1, 1);
    }
    g.globalAlpha = 1;
  }
  function draw() {
    if (!width) return;
    g.clearRect(0, 0, width, H);
    g.drawImage(sprite(look.grow, look.spin, look.crank), 0, 0);
    for (const note of notes) paintNote(note);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buffer, 0, 0, canvas.width, canvas.height);
  }
  function tick(ms) {
    raf = 0;
    if (stopped) return;
    const dt = clamp((ms - last) / 1000, 0, 0.05);
    last = ms;
    const now = horn.step(dt, phaseOf());
    for (let i = 0; i < now.notes; i += 1) throwNote(now.grow, now.boost);
    moveNotes(dt);
    look = now;
    draw();
    if (now.moving || notes.length) raf = requestAnimationFrame(tick);
  }
  // Runs the frame loop until everything has come to rest again. With motion reduced it never starts.
  function wake() {
    if (raf || stopped || !(strip || live) || reducedMotion()) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  palette();
  fit();
  const offWords = strip || live ? onAssistantWords(text => { if (!reducedMotion()) { horn.hear(countTokens(text)); wake(); } }) : () => {};
  const onResize = () => fit();
  window.addEventListener('resize', onResize);
  const sizes = strip && 'ResizeObserver' in window ? new ResizeObserver(onResize) : null;
  sizes?.observe(host.parentElement);
  const theme = new MutationObserver(() => { palette(); draw(); });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return {
    wake,
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      offWords();
      window.removeEventListener('resize', onResize);
      sizes?.disconnect();
      theme.disconnect();
    },
  };
}

export function Gramophone({ phase = 'idle', scale = 2, strip = false, live = false, label }) {
  const host = useRef(null);
  const canvas = useRef(null);
  const stage = useRef(null);
  const current = useRef(phase);
  current.current = phase;
  useEffect(() => {
    stage.current = startStage(host.current, canvas.current, { scale, strip, live, phaseOf: () => current.current });
    stage.current.wake();
    return () => { stage.current.stop(); stage.current = null; };
  }, [scale, strip, live]);
  useEffect(() => { stage.current?.wake(); }, [phase]);
  return (
    <span ref={host} className={`gramophone${strip ? ' strip' : ''}`} role="img" aria-label={label}>
      <canvas ref={canvas} aria-hidden="true" />
      {strip ? <i className="gram-mouth" aria-hidden="true" /> : null}
    </span>
  );
}
