// The three openings, as pictures of a moment: each scene paints what the window shows t milliseconds after it began,
// on a small grid of big square pixels. No page and no clock here: Opening.jsx owns the canvas and the time.
//
//   gramophone  the assistant's gramophone winds up and plays, notes fly from its horn
//   wave        sheets fly in from every side and stand up as the bars of a wave
//   briefcase   four sheets go into the briefcase, and it turns into Dayjob's icon
//
// Each lasts four beats at 96 a minute. The first two set the picture up, the third and fourth hold it on the beat,
// and it gives way to the page from the edges inwards, a few pixels at a time. A slow start holds it for whole beats
// more.
import { BAYER, COLORS, H as GRAM_H, NOTES, OX, OY, W as GRAM_W, frame, mouth } from '../assistant/gramophone.js';

export const BEAT = 625;
export const S16 = BEAT / 4;
export const HOLD = BEAT * 2;          // from here the picture is whole and only keeps time
export const OUT = 375;                // how long it takes to give way
export const T_OUT = BEAT * 4 - OUT;   // when it starts to, unless the start is slow
export const OPENINGS = ['gramophone', 'wave', 'briefcase'];

// One of the three at random, and never the one that played last time: three in a row of the same would not look
// like chance.
export function pickOpening(last, random = Math.random) {
  const pool = OPENINGS.filter(id => id !== last);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

// How big a square pixel is (in screen pixels) and how many of them cover a window: about 132 across, and never
// fewer than 72 down, which the tallest picture needs.
export function fitStage(width, height, ratio = 1) {
  const w = Math.max(1, width * ratio), h = Math.max(1, height * ratio);
  const k = Math.max(2, Math.min(Math.round(w / 132), Math.floor(h / 72)));
  return { k, W: Math.ceil(w / k), H: Math.ceil(h / k) };
}

// When the picture starts to give way: at T_OUT if the page's data was there by then, else on the first beat after
// it came (readyAt, ms; null while it has not). After `patience` more beats it goes anyway.
export function outTime(readyAt, now, patience = 8) {
  const last = T_OUT + patience * BEAT;
  if (readyAt === null || readyAt === undefined) return now >= last ? last : Infinity;
  return Math.min(last, T_OUT + Math.max(0, Math.ceil((readyAt - T_OUT) / BEAT)) * BEAT);
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lerp = (a, b, p) => a + (b - a) * p;
// A steady random number for (a, b): the same on every run, so nothing jumps between two frames.
const rnd = (a, b = 0) => { let h = (a * 374761393 + b * 668265263 + 1013904223) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const dither = (x, y) => (BAYER[y & 3][x & 3] + 0.5) / 16;

// ---------- sprites: { w, h, px[] } with a CSS colour or null for each pixel ----------
const gramCache = new Map();
function gram(grow = 0, spin = 0, crank = -1) {
  const key = `${grow}|${spin}|${crank}`;
  let sprite = gramCache.get(key);
  if (!sprite) { sprite = { w: GRAM_W, h: GRAM_H, px: Array.from(frame(grow, spin, crank), index => COLORS[index]) }; gramCache.set(key, sprite); }
  return sprite;
}
export function fromRows(rows, map) { return { w: rows[0].length, h: rows.length, px: rows.flatMap(row => [...row].map(ch => map[ch] || null)) }; }
// cover below 1 leaves pixels out in the dither's order, so a sprite arrives and goes without turning see-through.
function blit(g, sprite, x, y, cover = 1) {
  if (cover <= 0) return;
  x = Math.round(x); y = Math.round(y);
  for (let row = 0; row < sprite.h; row += 1) for (let col = 0; col < sprite.w; col += 1) {
    const colour = sprite.px[row * sprite.w + col];
    if (!colour) continue;
    if (cover < 1 && dither(x + col, y + row) > cover) continue;
    g.fillStyle = colour; g.fillRect(x + col, y + row, 1, 1);
  }
}

// The icon's three layers as pixel art: its shapes (MarkGlyph's, on a 512 grid) are drawn small and every pixel is
// snapped to the nearest colour of a short palette. Needs a real canvas, so Opening.jsx hands one in.
export const LOGO = 48;
// "#RGB", "#RRGGBB" or "rgb(r g b)" as three numbers.
const rgbOf = colour => {
  if (!colour.startsWith('#')) return (colour.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  const v = colour.slice(1), full = v.length === 3 ? [...v].map(c => c + c).join('') : v;
  return [0, 2, 4].map(at => parseInt(full.slice(at, at + 2), 16));
};
function raster(makeCanvas, palette, paint) {
  const canvas = makeCanvas(LOGO, LOGO);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.setTransform(LOGO / 512, 0, 0, LOGO / 512, 0, 0);
  paint(g);
  const data = g.getImageData(0, 0, LOGO, LOGO).data, rgb = palette.map(rgbOf), px = new Array(LOGO * LOGO).fill(null);
  for (let i = 0; i < LOGO * LOGO; i += 1) {
    if (data[i * 4 + 3] < 120) continue;
    let best = 0, nearest = Infinity;
    rgb.forEach((c, at) => { const d = (c[0] - data[i * 4]) ** 2 + (c[1] - data[i * 4 + 1]) ** 2 + (c[2] - data[i * 4 + 2]) ** 2; if (d < nearest) { nearest = d; best = at; } });
    px[i] = palette[best];
  }
  return { w: LOGO, h: LOGO, px };
}
function round(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
const sheetOf = C => fromRows(['EEEEEE.', 'EWWWWEE', 'EDWWWWE', 'EWLLLWE', 'EWWWWWE', 'EWLLLWE', 'EWWWWWE', 'EWLLWWE', 'EEEEEEE'], { E: C.sheetEdge, W: C.sheet, L: C.sheetLine, D: C.accent });
// C: the colours (see OPENING_TOKENS). makeCanvas(w, h) returns a canvas; Path2D comes with the page.
export function buildAssets(C, makeCanvas) {
  const tile = raster(makeCanvas, [C.tile], g => { round(g, 0, 0, 512, 512, 112); g.fillStyle = C.tile; g.fill(); });
  const bag = raster(makeCanvas, [C.case, C.inside], g => {
    g.strokeStyle = C.case; g.lineWidth = 26; g.stroke(new Path2D('M198 136V112a26 26 0 0 1 26-26h64a26 26 0 0 1 26 26v24'));
    round(g, 58, 128, 396, 310, 50); g.fillStyle = C.case; g.fill();
    round(g, 86, 156, 340, 254, 30); g.fillStyle = C.inside; g.fill();
  });
  const deck = raster(makeCanvas, [C.side, C.deck, C.disc, C.peak, C.arm], g => {
    round(g, 99, 374, 314, 24, 10); g.fillStyle = C.side; g.fill();
    const top = new Path2D('M136 258H376L404 374H108Z'); g.fillStyle = C.deck; g.fill(top); g.strokeStyle = C.deck; g.lineWidth = 16; g.lineJoin = 'round'; g.stroke(top);
    g.fillStyle = C.disc; g.beginPath(); g.ellipse(234, 318, 94, 54, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.peak; g.beginPath(); g.ellipse(234, 318, 30, 17, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = C.arm; g.lineWidth = 15; g.lineCap = 'round'; g.stroke(new Path2D('M366 282L360 328L322 342'));
    g.fillStyle = C.arm; g.beginPath(); g.arc(366, 282, 15, 0, Math.PI * 2); g.fill();
  });
  return { tile, bag, deck, sheet: sheetOf(C) };
}

// "dayjob" in a 5-wide pixel face, with two rows under the line for the tails of y and j.
const FONT = {
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####', '.....', '.....'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####', '.....', '.....'],
  y: ['.....', '.....', '#...#', '#...#', '#...#', '#...#', '.####', '....#', '.###.'],
  j: ['...#.', '.....', '..##.', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.', '.....', '.....'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.', '.....', '.....'],
};
const WORD = [...'dayjob'], WORD_W = WORD.length * 6 - 1;
// shown: how many letters are there yet; since(i): when letter i came, so it can hop as it lands.
function word(g, cx, y, colour, shown = 6, cover = 1, t = 0, since = null) {
  const x0 = Math.round(cx - WORD_W / 2);
  WORD.slice(0, shown).forEach((ch, i) => {
    const fresh = since && t - since(i) < 80 ? -1 : 0;
    blit(g, fromRows(FONT[ch], { '#': colour }), x0 + i * 6, y + fresh, cover);
  });
}
// A soft light behind the picture, thinning out to nothing in the dither's order.
function glow(g, cx, cy, radius, colour) {
  g.fillStyle = colour;
  for (let y = Math.floor(cy - radius); y <= cy + radius; y += 1) for (let x = Math.floor(cx - radius); x <= cx + radius; x += 1) {
    const d = Math.hypot(x - cx, (y - cy) * 1.15) / radius;
    if (d < 1 && dither(x, y) < (1 - d) * 1.05) g.fillRect(x, y, 1, 1);
  }
}
function note(g, kind, x, y, colour, cover, seed = 0) {
  const glyph = NOTES[kind % NOTES.length], x0 = Math.round(x - glyph.w / 2), y0 = Math.round(y - glyph.h / 2);
  g.fillStyle = colour;
  for (let row = 0; row < glyph.h; row += 1) for (let col = 0; col < glyph.w; col += 1) {
    if (!glyph.on[row][col]) continue;
    if (cover < 1 && dither(col + (seed >> 2), row + seed) > cover) continue;
    g.fillRect(x0 + col, y0 + row, 1, 1);
  }
}

// ---------- the scenes: (g, t, tOut, e { W, H, cx, cy }, C colours, A assets) ----------
const BIG = [-1, 2, 2, 1, 0];
const SCENES = {
  // The gramophone is wound for a beat, then its horn pushes on every half beat and lets two or three notes go.
  gramophone(g, t, tOut, e, C) {
    const gx = e.cx - 42, gy = e.cy - 23;
    glow(g, gx + 26, gy + 16, 40, C.glow);
    const crank = t >= 100 && t < 900 ? Math.floor((t - 100) / S16) % 4 : -1;
    const spin = t < 320 ? 0 : Math.floor((t - 320) / S16) % 8;
    const first = BEAT, every = BEAT / 2, length = 280;
    let grow = 0;
    if (t >= first) {
      const start = first + Math.floor((t - first) / every) * every;
      if (start < tOut && t - start < length) grow = BIG[Math.min(4, Math.floor((t - start) / length * 5))];
    }
    // the floor it stands on
    g.fillStyle = C.line;
    for (let x = gx + 6; x < gx + 38; x += 1) if ((x & 1) === 0) g.fillRect(x, gy + 39, 1, 1);
    blit(g, gram(grow, spin, crank), gx, gy, clamp(t / 280, 0, 1));
    // the notes: each on its own way up and to the right, gone after about a second
    const lastPush = Math.floor((Math.min(t, tOut - 1) - first) / every);
    for (let i = Math.max(0, lastPush - 6); i <= lastPush; i += 1) {
      const count = i % 2 ? 2 : 3;
      for (let j = 0; j < count; j += 1) {
        const born = first + i * every + 56 + j * 60, age = (t - born) / 1000, life = 1.05 + rnd(i, j) * 0.4;
        if (age < 0 || age >= life) continue;
        const m = mouth(1), angle = 0.06 - rnd(i, j + 9) * 0.46, speed = 62 + rnd(i, j + 5) * 34, reach = 1 - Math.exp(-age * 1.15);
        const x = gx + OX + m.cx + 3 + rnd(i, j + 2) * 3 + Math.cos(angle) * speed * reach;
        const y = gy + OY + m.cy - 3 + (rnd(i, j + 3) - 0.5) * 5 + Math.sin(angle) * speed * reach + Math.sin(age * 6 + i + j) * 1.2;
        const at = age / life, cover = at < 0.45 ? Math.min(1, age / 0.08) : 1 - (at - 0.45) / 0.55;
        note(g, Math.floor(rnd(i, j + 7) * 4), x, y, rnd(i, j + 11) < 0.6 ? C.noteA : C.noteB, cover, Math.floor(rnd(i, j + 13) * 16));
      }
    }
    word(g, gx + 22, gy + 44, C.ink, clamp(Math.floor((t - BEAT) / S16) + 1, 0, 6), 1, t, i => BEAT + i * S16);
  },
  // Sheets come from all round the window; each lands in its place and stands up as a bar, and the bars play.
  wave(g, t, tOut, e, C, A) {
    const count = Math.min(26, Math.floor((e.W - 28) / 3)), x0 = e.cx - Math.floor((count * 3 - 1) / 2), base = e.cy - 5;
    glow(g, e.cx, base, 44, C.glow);
    const stepped = Math.floor(t / 78) * 78, playing = clamp((t - 1000) / 250, 0, 1);
    const pulse = t >= HOLD ? 1 + 0.2 * Math.exp(-((t - HOLD) % BEAT) / 160) : 1;
    const fade = t >= tOut ? 1 - clamp((t - tOut) / OUT, 0, 1) : 1;
    for (let i = 0; i < count; i += 1) {
      const start = 30 + rnd(i, 1) * 640, flight = 400, p = (t - start) / flight;
      if (p <= 0) continue;
      const slot = x0 + i * 3;
      const shape = 4 + 15 * Math.sin(Math.PI * (i + 0.5) / count) ** 1.2 * (0.6 + 0.4 * rnd(i, 2));
      if (p < 1) {
        const turn = rnd(i, 3) * Math.PI * 2, from = { x: e.cx + Math.cos(turn) * (e.W / 2 + 14), y: e.cy + Math.sin(turn) * (e.H / 2 + 14) };
        const at = q => { const eased = clamp(q, 0, 1) ** 2.2; return { x: lerp(from.x, slot - 3, eased), y: lerp(from.y, base - 4, eased) }; };
        // its trail: two fainter copies behind it
        [[0.16, 0.25], [0.08, 0.5]].forEach(([back, cover]) => { if (p > back) { const ghost = at(p - back); blit(g, A.sheet, ghost.x, ghost.y, cover); } });
        const here = at(p);
        if (p < 0.86) blit(g, A.sheet, here.x, here.y);
        else { const narrow = Math.round(lerp(7, 2, (p - 0.86) / 0.14)); g.fillStyle = C.waveHigh; g.fillRect(Math.round(here.x + (7 - narrow) / 2), Math.round(here.y), narrow, 9); }
        continue;
      }
      const landed = t - start - flight, pop = landed < 110 ? 1.25 - 0.25 * landed / 110 : 1;
      const swing = Math.sin(stepped / BEAT * Math.PI * 2 + i * 0.55) * 0.5 + Math.sin(stepped / BEAT * Math.PI * 4 + i * 1.3) * 0.25;
      const half = Math.max(1, Math.round(shape * (0.64 + playing * 0.36 * swing / 0.75) * pulse * pop * fade));
      const middle = Math.abs(i - (count - 1) / 2) / (count / 2) < 0.5;
      g.fillStyle = middle ? C.waveLow : C.waveHigh; g.fillRect(slot, base - half, 2, half * 2 + 1);
      g.fillStyle = C.wavePeak; g.fillRect(slot, base - half, 2, 1); g.fillRect(slot, base + half, 2, 1);
    }
    word(g, e.cx, base + 27, C.ink, 6, clamp((t - HOLD) / 220, 0, 1));
  },
  // The briefcase drops in, four sheets fly into it (a bar of the meter for each), the record player shows inside,
  // and the icon's tile closes round it.
  briefcase(g, t, tOut, e, C, A) {
    const lx = e.cx - LOGO / 2, ly = e.cy - 32;
    glow(g, e.cx, ly + 26, 42, C.glow);
    const sendAt = j => 300 + j * S16, flight = 300, landAt = j => sendAt(j) + flight;
    let sink = 0;
    for (let j = 0; j < 4; j += 1) if (t >= landAt(j) && t - landAt(j) < 90) sink = 1;
    const drop = t < 220 ? Math.round((1 - t / 220) * -5) : 0;
    blit(g, A.tile, lx, ly, clamp((t - HOLD) / 220, 0, 1));
    blit(g, A.bag, lx, ly + drop + sink, clamp(t / 200, 0, 1));
    blit(g, A.deck, lx, ly + sink, clamp((t - 1090) / 160, 0, 1));
    const heights = [3, 5, 4, 2];
    for (let j = 0; j < 4; j += 1) {
      if (t < landAt(j)) continue;
      const since = t - landAt(j), bounce = t >= HOLD ? [0, 1, 0, -1][(Math.floor(t / S16) + j) % 4] : 0;
      const h = Math.max(1, heights[j] + (since < 90 ? 2 : 0) + bounce);
      g.fillStyle = j === 1 ? C.peak : C.bar; g.fillRect(lx + 16 + j * 3, ly + 22 + sink - h, 2, h);
    }
    if (t >= 1180) note(g, 2, lx + 31, ly + 19 + sink + (t - 1180 < 90 ? -2 : 0) + (t >= HOLD && (t - HOLD) % BEAT < 120 ? -1 : 0), C.peak, 1);
    for (let j = 0; j < 4; j += 1) {
      const p = (t - sendAt(j)) / flight;
      if (p <= 0 || p >= 1) continue;
      const side = j % 2 ? 1 : -1, from = { x: e.cx + side * (e.W / 2 + 6), y: ly - 8 + j * 3 }, to = { x: e.cx - 9 + j * 4, y: ly + 15 };
      const x = lerp(from.x, to.x, p), y = lerp(from.y, to.y, p * p) - Math.sin(Math.PI * p) * 14;
      blit(g, A.sheet, x - 3, y - 4, p > 0.8 ? 1 - (p - 0.8) / 0.2 * 0.8 : 1);
    }
    word(g, e.cx, ly + LOGO + 5, C.ink, 6, clamp((t - HOLD) / 220, 0, 1));
  },
};

// The whole picture at time t on a W x H grid: the ground, the scene, and from tOut on the holes through which the
// page shows, the corners first and the middle last. g is a 2D canvas context (fillStyle, fillRect, clearRect).
export function paintOpening(g, id, t, tOut, W, H, C, A) {
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  SCENES[id](g, t, tOut, { W, H, cx: W >> 1, cy: H >> 1 }, C, A);
  if (t < tOut) return;
  const p = clamp((t - tOut) / OUT, 0, 1), far = Math.hypot(W / 2, H / 2);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const d = Math.hypot(x - W / 2, y - H / 2) / far;
    if (dither(x, y) < p * 1.7 - (1 - d) * 0.7) g.clearRect(x, y, 1, 1);
  }
}

// The colours a scene uses and the custom properties (set on .opening in opening.css) they are read from.
export const OPENING_TOKENS = { bg: '--op-bg', ink: '--op-ink', glow: '--op-glow', noteA: '--op-note-a', noteB: '--op-note-b', waveLow: '--wave-low', waveHigh: '--wave-high',
  wavePeak: '--wave-peak', sheet: '--op-sheet', sheetLine: '--op-sheet-line', sheetEdge: '--op-sheet-edge', accent: '--op-accent', line: '--op-line', tile: '--op-tile',
  case: '--mark-case', inside: '--mark-inside', deck: '--mark-deck', side: '--mark-side', disc: '--mark-disc', arm: '--mark-arm', bar: '--mark-bar', peak: '--mark-peak' };
