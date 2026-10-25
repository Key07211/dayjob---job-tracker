import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { reducedMotion } from './sound.js';
import { listenAnalyser, retryCapture, useNowPlaying } from './music.js';
import { usePrefs, useTheme } from './prefs.js';
import { emit } from './bus.js';

// How long the wave takes to lie down once the song stops.
const SETTLE = 900;
// Bars 3 px wide, 6 px apart; the dots style stacks 3 px dots 5 px apart.
const BAR = 3;
const PITCH = 6;
const DOT_STEP = 5;
// From deep bass to the top of the treble, on a log scale as the ear hears it.
const LOW_HZ = 35;
const HIGH_HZ = 14000;
// Treble carries less power than bass, so each octave above 1 kHz is lifted a little and each below lowered.
const TILT_DB = 3.5;
// How far below the loudest band a band still shows. The loudest sets the top, and the top lets go slowly.
const RANGE_DB = 46;
const SILENT_DB = -100;
// A loud band lifts its neighbours, each one this many times less, so the bars stand in hills rather than a comb.
const SPREAD = 1.5;
// Bars jump up at once and fall under gravity; the caps above them wait a moment, then drop more slowly.
const RISE = 30;
const GRAVITY = 7;
const CAP_HOLD = 420;
const CAP_GRAVITY = 2.4;

// Kept between mounts. Each page has its own header, so a page switch mounts a new wave, and it carries on from
// where the last one was instead of starting again.
const live = { bars: [], fall: [], caps: [], capFall: [], capAt: [], edges: null, edgesHz: 0, freq: null, ceiling: -40, lowAvg: undefined, lastBeat: 0, pulse: 0, last: 0 };

function fit(n) {
  if (live.bars.length === n) return;
  const resample = from => Array.from({ length: n }, (_, i) => {
    if (!from.length) return 0;
    const at = n > 1 ? (i * (from.length - 1)) / (n - 1) : 0;
    const k = Math.floor(at);
    return from[k] + ((from[k + 1] ?? from[k]) - from[k]) * (at - k);
  });
  live.bars = resample(live.bars);
  live.caps = resample(live.caps);
  live.fall = new Array(n).fill(0);
  live.capFall = new Array(n).fill(0);
  live.capAt = new Array(n).fill(0);
  live.edges = null;
}

// Which FFT bins each band covers, and its tilt.
function edgesFor(n, hzPerBin, bins) {
  const ratio = HIGH_HZ / LOW_HZ;
  return Array.from({ length: n }, (_, k) => {
    const lo = LOW_HZ * ratio ** (k / n);
    const hi = LOW_HZ * ratio ** ((k + 1) / n);
    const mid = Math.sqrt(lo * hi);
    return { from: Math.ceil(lo / hzPerBin), to: Math.min(bins - 1, Math.floor(hi / hzPerBin)), at: Math.min(bins - 2, mid / hzPerBin), tilt: TILT_DB * Math.log2(mid / 1000) };
  });
}

// How high each band should stand now (0–1), from the system sound; each beat is also told to the logo's note.
function hear(analyser, n, now, dt) {
  const s = live;
  const bins = analyser.frequencyBinCount;
  if (!s.freq || s.freq.length !== bins) s.freq = new Float32Array(bins);
  analyser.getFloatFrequencyData(s.freq);
  const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
  if (!s.edges || s.edges.length !== n || s.edgesHz !== hzPerBin) { s.edges = edgesFor(n, hzPerBin, bins); s.edgesHz = hzPerBin; }
  const db = i => Math.max(-160, s.freq[i]);

  // A beat: the 40–90 Hz band jumping over its recent average, on the 0–255 scale the threshold was tuned on.
  const from = Math.round(40 / hzPerBin);
  const to = Math.round(90 / hzPerBin);
  let low = 0;
  for (let i = from; i <= to; i += 1) low += db(i);
  low = Math.max(0, Math.min(255, (255 * (low / (to - from + 1) - analyser.minDecibels)) / (analyser.maxDecibels - analyser.minDecibels)));
  s.lowAvg = s.lowAvg === undefined ? low : s.lowAvg * 0.9 + low * 0.1;
  if (low > 90 && low > s.lowAvg * 1.25 && now - s.lastBeat > 330) {
    s.lastBeat = now;
    s.pulse = Math.min(1, low / 200);
    emit('beat', { strength: s.pulse });
  }

  const level = new Array(n);
  let loudest = -Infinity;
  s.edges.forEach((band, k) => {
    let value = -Infinity;
    for (let i = band.from; i <= band.to; i += 1) value = Math.max(value, db(i));
    // A band narrower than one bin (the deep bass) reads between its two neighbours.
    if (value === -Infinity) { const i = Math.floor(band.at); value = db(i) + (db(i + 1) - db(i)) * (band.at - i); }
    level[k] = value + band.tilt;
    loudest = Math.max(loudest, level[k]);
  });
  s.ceiling = loudest > s.ceiling ? s.ceiling + (loudest - s.ceiling) * Math.min(1, dt * 20) : Math.max(-80, s.ceiling - 5 * dt);
  const target = level.map(value => (loudest < SILENT_DB ? 0 : 0.94 * Math.max(0, Math.min(1, (value - s.ceiling + RANGE_DB) / RANGE_DB)) ** 1.6));
  for (let k = 1; k < n; k += 1) target[k] = Math.max(target[k], target[k - 1] / SPREAD);
  for (let k = n - 2; k >= 0; k -= 1) target[k] = Math.max(target[k], target[k + 1] / SPREAD);
  return target;
}

function move(target, now, dt) {
  const s = live;
  s.pulse *= Math.exp(-dt * 6);
  for (let k = 0; k < s.bars.length; k += 1) {
    const goal = target ? target[k] : 0;
    if (goal >= s.bars[k]) { s.bars[k] += (goal - s.bars[k]) * Math.min(1, dt * RISE); s.fall[k] = 0; }
    else { s.fall[k] += GRAVITY * dt; s.bars[k] = Math.max(goal, s.bars[k] - s.fall[k] * dt); }
    if (s.bars[k] >= s.caps[k]) { s.caps[k] = s.bars[k]; s.capFall[k] = 0; s.capAt[k] = now; }
    else if (now - s.capAt[k] > CAP_HOLD) { s.capFall[k] += CAP_GRAVITY * dt; s.caps[k] = Math.max(s.bars[k], s.caps[k] - s.capFall[k] * dt); }
  }
}

const rgba = (hex, alpha) => {
  const value = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!value) return hex;
  const number = parseInt(value[1], 16);
  return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
};

// 光柱: a spectrum from bass on the left to treble on the right, each bar glowing, a cap above it that waits and
// falls, and a faint reflection under the line, as on a glossy desk.
function beam(g, { w, h, dpr, colors, across }) {
  const n = live.bars.length;
  const pitch = PITCH * dpr;
  const bar = BAR * dpr;
  const left = (w - n * pitch) / 2 + (pitch - bar) / 2;
  const base = Math.round(h * 0.7);
  const room = base - 5 * dpr;
  g.save();
  g.shadowColor = colors.glow;
  g.shadowBlur = (7 + 10 * live.pulse) * dpr;
  g.fillStyle = across;
  g.beginPath();
  for (let k = 0; k < n; k += 1) {
    const height = Math.max(bar, live.bars[k] * room);
    g.roundRect(left + k * pitch, base - height, bar, height, [bar / 2, bar / 2, dpr / 2, dpr / 2]);
  }
  g.fill();
  g.shadowColor = colors.peak;
  g.shadowBlur = 5 * dpr;
  g.fillStyle = colors.peak;
  g.beginPath();
  for (let k = 0; k < n; k += 1) {
    if (live.caps[k] > 0.04) g.roundRect(left + k * pitch, base - live.caps[k] * room - 4 * dpr, bar, 2 * dpr, dpr);
  }
  g.fill();
  g.restore();
  g.globalAlpha = 0.22;
  g.fillStyle = across;
  g.beginPath();
  for (let k = 0; k < n; k += 1) {
    const height = Math.min(h - base - 2 * dpr, live.bars[k] * room * 0.5);
    if (height > dpr) g.rect(left + k * pitch, base + 2 * dpr, bar, height);
  }
  g.fill();
  g.globalAlpha = 1;
  const fade = g.createLinearGradient(0, base, 0, h);
  fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  fade.addColorStop(1, 'rgba(0, 0, 0, 1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = fade;
  g.fillRect(0, base + dpr, w, h - base);
  g.globalCompositeOperation = 'source-over';
}

// 点阵: the same spectrum as columns of lit dots, like the meter on an old hi-fi, with the cap as one brighter dot.
function dots(g, { w, h, dpr, colors, across }) {
  const n = live.bars.length;
  const pitch = PITCH * dpr;
  const dot = BAR * dpr;
  const step = DOT_STEP * dpr;
  const left = (w - n * pitch) / 2 + (pitch - dot) / 2;
  const base = h - 6 * dpr;
  const rows = Math.max(1, Math.floor((base - 6 * dpr) / step));
  g.save();
  g.shadowColor = colors.glow;
  g.shadowBlur = (6 + 9 * live.pulse) * dpr;
  g.fillStyle = across;
  g.beginPath();
  for (let k = 0; k < n; k += 1) {
    const lit = Math.max(1, Math.round(live.bars[k] * rows));
    for (let r = 0; r < lit; r += 1) g.roundRect(left + k * pitch, base - r * step - dot, dot, dot, dot / 2);
  }
  g.fill();
  g.shadowColor = colors.peak;
  g.fillStyle = colors.peak;
  g.beginPath();
  for (let k = 0; k < n; k += 1) {
    const r = Math.round(live.caps[k] * rows);
    if (r > Math.round(live.bars[k] * rows) && r > 1) g.roundRect(left + k * pitch, base - r * step - dot, dot, dot, dot / 2);
  }
  g.fill();
  g.restore();
}

// 流光: one soft line over the bands, mirrored from the bass in the middle, with a glow under it and a thin line
// where the caps are.
function flow(g, { w, h, dpr, colors, around }) {
  const n = live.bars.length;
  const half = w / 2;
  const pitch = half / n;
  const base = h - 5 * dpr;
  const room = base - 8 * dpr;
  const points = values => {
    const list = [];
    for (let k = n - 1; k >= 0; k -= 1) list.push([half - (k + 0.5) * pitch, base - values[k] * room]);
    for (let k = 0; k < n; k += 1) list.push([half + (k + 0.5) * pitch, base - values[k] * room]);
    return list;
  };
  const curve = list => {
    g.moveTo(0, base);
    g.lineTo(list[0][0], list[0][1]);
    for (let i = 0; i < list.length - 1; i += 1) g.quadraticCurveTo(list[i][0], list[i][1], (list[i][0] + list[i + 1][0]) / 2, (list[i][1] + list[i + 1][1]) / 2);
    g.lineTo(list[list.length - 1][0], list[list.length - 1][1]);
    g.lineTo(w, base);
  };
  const line = points(live.bars);
  const under = g.createLinearGradient(0, base - room, 0, base);
  under.addColorStop(0, rgba(colors.low, 0.5));
  under.addColorStop(1, rgba(colors.low, 0));
  g.fillStyle = under;
  g.beginPath();
  curve(line);
  g.closePath();
  g.fill();
  g.save();
  g.shadowColor = colors.glow;
  g.shadowBlur = (8 + 10 * live.pulse) * dpr;
  g.strokeStyle = around;
  g.lineWidth = 2 * dpr;
  g.lineJoin = 'round';
  g.beginPath();
  curve(line);
  g.stroke();
  g.restore();
  g.globalAlpha = 0.5;
  g.strokeStyle = colors.peak;
  g.lineWidth = dpr;
  g.beginPath();
  curve(points(live.caps));
  g.stroke();
  g.globalAlpha = 1;
}

const STYLES = { beam, dots, flow };

// The listening wave in the header band, between the page title and the buttons on the right. While a music app
// plays it shows the song's spectrum: bass to treble on a log scale, each band jumping up with the sound and
// falling back under gravity, loud bands lifting their neighbours into hills, caps that wait and drop, and a glow
// that swells on each beat. Its colours follow the theme. When the song stops it lies down and fades; until the
// system sound is reached it rests as a still row, and a small button offers to connect it.
export function ListenWave() {
  const { t } = useI18n();
  const groove = usePrefs();
  const theme = useTheme();
  const { track, browser, capture, captureError } = useNowPlaying();
  const on = groove.followMusic && Boolean(track) && !browser;
  const style = STYLES[groove.waveStyle] || beam;
  const canvas = useRef(null);
  const frame = useRef(0);
  const [drawing, setDrawing] = useState(on);

  useEffect(() => {
    if (on) { setDrawing(true); return undefined; }
    const timer = setTimeout(() => setDrawing(false), SETTLE);
    return () => clearTimeout(timer);
  }, [on]);

  // A layout effect, so a page that opens while the music plays shows the wave in its first frame.
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!drawing || !el || reducedMotion()) return undefined;
    const css = getComputedStyle(el);
    const colors = Object.fromEntries(['low', 'high', 'peak', 'glow'].map(name => [name, css.getPropertyValue(`--wave-${name}`).trim()]));
    let sized = '';
    let across = null;
    let around = null;
    const draw = now => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(el.clientWidth * dpr);
      const h = Math.round(el.clientHeight * dpr);
      if (!w || !h) return;
      if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
      const g = el.getContext('2d');
      if (sized !== `${w}x${h}`) {
        sized = `${w}x${h}`;
        across = g.createLinearGradient(0, 0, w, 0);
        across.addColorStop(0, colors.low);
        across.addColorStop(1, colors.high);
        around = g.createLinearGradient(0, 0, w, 0);
        [[0, colors.high], [0.5, colors.low], [1, colors.high]].forEach(([at, color]) => around.addColorStop(at, color));
      }
      const dt = live.last ? Math.min(0.1, (now - live.last) / 1000) : 0;
      live.last = now;
      const n = Math.max(8, Math.floor(el.clientWidth / (style === flow ? 2 : 1) / PITCH));
      fit(n);
      const analyser = on ? listenAnalyser() : null;
      move(analyser ? hear(analyser, n, now, dt) : null, now, dt);
      g.clearRect(0, 0, w, h);
      style(g, { w, h, dpr, colors, across, around });
    };
    draw(performance.now());
    const loop = now => { draw(now); frame.current = requestAnimationFrame(loop); };
    frame.current = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(frame.current); frame.current = 0; };
  }, [drawing, on, style, theme]);

  // Once it has lain down, the next song starts from a flat row.
  useEffect(() => { if (!drawing) { live.bars = []; live.caps = []; live.last = 0; live.pulse = 0; } }, [drawing]);

  const offer = on && (capture === 'waiting' || capture === 'failed');
  return (
    <div className="wave-slot">
      <div className={`listen-wave${on ? ' on' : ''}`} aria-hidden="true">{drawing ? <canvas ref={canvas} /> : null}</div>
      {offer ? (
        <button type="button" className={`wave-hint${capture === 'failed' ? ' failed' : ''}`} onClick={retryCapture} title={capture === 'failed' ? captureError : undefined}>
          <AudioLines size={13} />{capture === 'failed' ? t('没读到系统声音，点这里重试', 'Could not hear the system sound; click to retry') : t('点一下，让声浪跟上音乐', 'Click to let the wave hear the music')}
        </button>
      ) : null}
    </div>
  );
}
