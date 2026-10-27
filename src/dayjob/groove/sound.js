import { prefs } from './prefs.js';

// Dayjob keeps time at 96 BPM: one beat is 625 ms.
export const BEAT = 625;
const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);
export const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// A score's place in the music follows its badge: strong, good, then the rest.
export const tierOf = score => (score >= 85 ? 'hi' : score >= 65 ? 'mid' : 'lo');

// Beethoven, Symphony No. 9, "Ode to Joy" (public domain): one note per score.
const ODE = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62, 64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60];
const CHORD_C = [48, 55, 60, 64];

// Each sidebar key has its own short phrase, the same each time, so a page always sounds like itself. A tune is a set of
// eight phrases on one voice, all in D major and low enough to stay gentle: nothing above D5, and higher notes play
// quieter. A step is a note, or notes that sound together. Days play 晨露, new phrases in the soft style of Japanese
// film piano; nights play Pachelbel's Canon in D (public domain).
export const TUNES = {
  // 晨露: a glass piano, a clear strike and a short tail, like drops on the keys.
  dew: { voice: 'glass', beat: 0.11, gain: 0.112,
    keys: [[62, 69], [64, 71], [66, 69], [69, 74], [71, 66], [69, 64], [71, 74], [73, 69]] },
  // 卡农: a felt piano playing the canon's eight chords D A Bm F#m G D G A, one per key, rolled up from the bottom; key
  // after key, the top notes are its melody F# E D C# B A B C#.
  canon: { voice: 'felt', beat: 0.07, gain: 0.091,
    keys: [[50, 57, 66], [57, 61, 64], [54, 59, 62], [54, 57, 61], [50, 55, 59], [50, 54, 57], [47, 55, 59], [52, 57, 61]] },
};
export const tuneFor = (choice, theme) => (choice === 'auto' || !TUNES[choice] ? (theme === 'night' ? 'canon' : 'dew') : choice);

let ctx = null;
let master = null;
let cueBus = null;
let room = null;
let lastVoice = null;
let analyser = null;
let noteIndex = 0;
let ducked = false;
const lastAt = {};
const keyGate = { phraseAt: -1e9 };

// One output chain: every voice goes through the cue bus and a limiter, then an analyser the
// listening wave can read, so a rare overlap never jumps in loudness.
export function ensureAudio() {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = 0.9;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    cueBus = ctx.createGain();
    cueBus.gain.value = ducked ? 0.32 : 1;
    cueBus.connect(master);
    // A small soft room for the sidebar's keys: a short decaying noise as its echo.
    room = ctx.createConvolver();
    const length = Math.floor(ctx.sampleRate * 1.6);
    const echo = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch += 1) {
      const d = echo.getChannelData(ch);
      for (let i = 0; i < length; i += 1) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2);
    }
    room.buffer = echo;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    room.connect(wet).connect(cueBus);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.6;
    master.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export const audio = () => ({ ctx, analyser });

// One voice at a time: a new cue fades the last one out in about 25 ms instead of stacking on it.
// force: something the user asked to hear (a preview), which plays even with the cue sound off.
function voice(force = false) {
  if (!(force || prefs.get().sound) || !ensureAudio()) return null;
  if (lastVoice) {
    const old = lastVoice;
    old.gain.cancelScheduledValues(ctx.currentTime);
    old.gain.setTargetAtTime(0, ctx.currentTime, 0.008);
    setTimeout(() => old.disconnect(), 250);
  }
  lastVoice = ctx.createGain();
  lastVoice.connect(cueBus);
  return lastVoice;
}
// True at most once per gap for each kind of sound; when false only the sound is skipped, the motion still runs.
function allow(kind, gap) {
  const now = performance.now();
  if (now - (lastAt[kind] || -1e9) < gap) return false;
  lastAt[kind] = now;
  return true;
}
// While a music app is playing, the cues drop about 10 dB so they never fight the song.
export function duck(on) {
  ducked = Boolean(on);
  if (cueBus) cueBus.gain.setTargetAtTime(ducked ? 0.32 : 1, ctx.currentTime, 0.08);
}

// A hammer-struck string: a few slightly stretched partials, the high ones dying first.
const BRIGHT = [[1, 1, 1, 'triangle'], [2, 0.42, 0.6, 'sine'], [3, 0.18, 0.4, 'sine'], [4, 0.08, 0.28, 'sine']];
function piano(midi, { at = 0, gain = 0.12, dur = 1.1 } = {}, out) {
  if (!out) return;
  const f = hz(midi);
  const t = ctx.currentTime + at;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.setValueAtTime(Math.min(12000, f * 9), t);
  tone.frequency.exponentialRampToValueAtTime(Math.max(400, f * 2), t + dur);
  tone.connect(out);
  BRIGHT.forEach(([h, level, life, wave]) => {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = wave;
    osc.frequency.value = f * h * (1 + 0.0005 * h * h);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(level * gain, t + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur * life);
    osc.connect(amp).connect(tone);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  });
}

// The sidebar's voices: a few sine partials under a filter that closes as the note dies, the high partials going first.
// Higher notes play quieter, so the top never feels sharp. glass: a clear strike and a short tail; felt: slower to
// speak, rounder and longer.
const KEY_VOICES = {
  glass: { parts: [[1, 1], [2, 0.18], [3.01, 0.06]], dur: 0.55, attack: 0.004, open: 4 },
  felt: { parts: [[1, 1], [2, 0.22], [3, 0.07], [4, 0.03]], dur: 1.1, attack: 0.012, open: 2.2 },
};
function keyNote(kind, midi, { at = 0, gain = 0.14 } = {}, out) {
  if (!out) return;
  const v = KEY_VOICES[kind];
  const f = hz(midi);
  const t = ctx.currentTime + at;
  const g = gain * Math.pow(261.6 / f, 0.45);
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.setValueAtTime(Math.min(2400, f * v.open), t);
  tone.frequency.exponentialRampToValueAtTime(Math.max(260, f * 1.2), t + v.dur);
  tone.connect(out);
  v.parts.forEach(([ratio, level]) => {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f * ratio;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(g * level, t + v.attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + v.dur * (ratio > 2 ? 0.45 : 1));
    osc.connect(amp).connect(tone);
    osc.start(t);
    osc.stop(t + v.dur + 0.05);
  });
}

// Karplus-Strong: a burst of noise fed back through a short delay rings like a plucked steel string.
const plucks = {};
function pluckBuffer(midi) {
  if (plucks[midi]) return plucks[midi];
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 1.8);
  const period = Math.max(2, Math.round(sr / hz(midi)));
  const buffer = ctx.createBuffer(1, length, sr);
  const d = buffer.getChannelData(0);
  for (let i = 0; i < period; i += 1) d[i] = Math.random() * 2 - 1;
  for (let i = 1; i < period; i += 1) d[i] = 0.6 * d[i] + 0.4 * d[i - 1];
  for (let i = period; i < length; i += 1) d[i] = 0.996 * 0.5 * (d[i - period] + (i - period - 1 >= 0 ? d[i - period - 1] : 0));
  plucks[midi] = buffer;
  return buffer;
}
function guitar(midi, { at = 0, gain = 0.3 } = {}, out) {
  if (!out) return;
  const src = ctx.createBufferSource();
  src.buffer = pluckBuffer(midi);
  const warm = ctx.createBiquadFilter();
  warm.type = 'lowpass';
  warm.frequency.value = 3200;
  const amp = ctx.createGain();
  amp.gain.value = gain;
  src.connect(warm).connect(amp).connect(out);
  src.start(ctx.currentTime + at);
}

// A tuned microwave "ding": one strike on a small steel bell, pitched to C so it resolves the E–D–D cadence.
function ding({ at = 0, gain = 0.09, root = hz(84) } = {}, out) {
  if (!out) return;
  const t = ctx.currentTime + at;
  // Bell partials: a soft body an octave down, the ringing C, a twin 0.2% sharp so it shimmers, and two thin metallic overtones.
  [[0.5, 0.3, 1.4], [1, 1, 2.6], [1.002, 0.45, 2.2], [2.76, 0.12, 0.5], [5.4, 0.04, 0.18]].forEach(([ratio, level, life]) => {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = root * ratio;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(level * gain, t + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + life);
    osc.connect(amp).connect(out);
    osc.start(t);
    osc.stop(t + life + 0.05);
  });
  // The tap of the striker: a few milliseconds of bright noise.
  const len = Math.floor(ctx.sampleRate * 0.02);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const tap = ctx.createBufferSource();
  const band = ctx.createBiquadFilter();
  const tapAmp = ctx.createGain();
  tap.buffer = buf;
  band.type = 'bandpass';
  band.frequency.value = root * 4;
  band.Q.value = 2;
  tapAmp.gain.value = gain * 0.5;
  tap.connect(band).connect(tapAmp).connect(out);
  tap.start(t);
}

// The next note of the theme for a score, at most one per beat, so scores that land together share a note.
export function playScore(score) {
  if (!prefs.get().sound || !allow('cue', BEAT)) return;
  const level = tierOf(score);
  const midi = ODE[noteIndex % ODE.length] + (level === 'lo' ? -12 : 0);
  noteIndex += 1;
  piano(midi, { gain: level === 'lo' ? 0.08 : level === 'hi' ? 0.15 : 0.11, dur: level === 'lo' ? 0.7 : 1.1 }, voice());
}
// A whole batch scored: E–D–D on the piano, then the bell lands on C.
export function playBatchEnd() {
  if (!prefs.get().sound || !allow('cadence', BEAT * 2)) return;
  const e = BEAT / 2000;
  const out = voice();
  [[64, 0], [62, e], [62, e * 2]].forEach(([midi, at]) => piano(midi, { at: 0.1 + at, dur: 0.8 }, out));
  ding({ at: 0.1 + e * 4 }, out);
}
// The needle drop when a search starts: two rising notes.
export function playNeedle() {
  if (!prefs.get().sound || !allow('fetch', 1000)) return;
  const out = voice();
  piano(67, { at: 0.02, gain: 0.1, dur: 0.4 }, out);
  piano(72, { at: 0.2, gain: 0.11, dur: 0.9 }, out);
}
// A search stopped: the needle lifts, the same two notes falling.
export function playLift() {
  if (!prefs.get().sound || !allow('fetch', 1000)) return;
  const out = voice();
  piano(72, { at: 0.02, gain: 0.09, dur: 0.4 }, out);
  piano(67, { at: 0.2, gain: 0.08, dur: 0.8 }, out);
}
// An application: one strum of C major on the guitar.
export function playApply() {
  if (!prefs.get().sound || !allow('chord', BEAT * 2)) return;
  const out = voice();
  CHORD_C.forEach((midi, i) => guitar(midi, { at: i * 0.018, gain: 0.24 }, out));
}
// The sound switch answers with one soft note.
export function playHello() {
  piano(64, { gain: 0.09, dur: 0.6 }, voice(true));
}

// A short burst of shaped noise through one filter: a palm-muted thump, a wood tick, a brush.
function noise({ at = 0, dur = 0.06, gain = 0.2, type = 'lowpass', freq = 400, q = 1, to = null } = {}, out) {
  if (!out) return;
  const t = ctx.currentTime + at;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const src = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();
  src.buffer = buf;
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  if (to) filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  filter.Q.value = q;
  amp.gain.value = gain;
  src.connect(filter).connect(amp).connect(out);
  src.start(t);
}
// A soft sine that slides between two notes, like a record slowing down or a key lifting back up.
function glide(from, to, { at = 0, dur = 0.32, gain = 0.08 } = {}, out) {
  if (!out) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(hz(from), t);
  osc.frequency.exponentialRampToValueAtTime(hz(to), t + dur);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
  osc.connect(amp).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.2);
}
// A piano note played backwards: it swells in and stops, the sound of a tape rewinding.
function swell(midi, { at = 0, dur = 0.22, gain = 0.1 } = {}, out) {
  if (!out) return;
  const t = ctx.currentTime + at;
  [[1, 1, 'triangle'], [2, 0.35, 'sine']].forEach(([h, level, wave]) => {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = wave;
    osc.frequency.value = hz(midi) * h;
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(level * gain, t + dur);
    amp.gain.linearRampToValueAtTime(0, t + dur + 0.015);
    osc.connect(amp).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  });
}
const wood = (at, out, gain = 0.16) => noise({ at, dur: 0.03, gain, type: 'bandpass', freq: 1800, q: 6 }, out);
const notes = (list, step, out, opts = {}) => list.forEach((midi, i) => piano(midi, { at: 0.02 + i * step, gain: 0.1, dur: 0.6, ...opts }, out));
const E8S = BEAT / 8000;

// The sound of each click (see the 点击动效 board): every cue is short, one voice at a time, and off unless sounds are on.
// The goal note climbs the C major scale as the week's task fills up: arg is how far along it is, 0 to 1.
const CUES = {
  fav: out => notes([67, 72], 0.09, out),
  unfav: out => { piano(67, { gain: 0.07, dur: 0.35 }, out); piano(64, { at: 0.08, gain: 0.06, dur: 0.5 }, out); },
  dismiss: out => noise({ dur: 0.09, gain: 0.32, freq: 220, q: 0.8 }, out),
  restore: out => glide(60, 67, { dur: 0.22 }, out),
  rescore: out => notes([72, 72], 0.12, out, { dur: 0.4 }),
  open: out => noise({ dur: 0.16, gain: 0.07, type: 'bandpass', freq: 2500, to: 6000, q: 0.7 }, out),
  pick: out => wood(0, out, 0.08),
  removeLow: out => notes([72, 69, 67, 64, 60], E8S, out, { gain: 0.08, dur: 0.4 }),
  undo: out => [60, 64, 67].forEach((midi, i) => swell(midi, { at: i * 0.11 }, out)),
  pause: out => glide(67, 55, { dur: 0.5 }, out),
  resume: out => glide(55, 67, { dur: 0.36 }, out),
  done: out => piano(72, { gain: 0.1, dur: 0.8 }, out),
  stApplied: out => piano(60, { gain: 0.11, dur: 0.8 }, out),
  stOA: out => wood(0, out),
  stInterview: out => notes([64, 67], 0.12, out, { dur: 0.8 }),
  stOffer: out => { notes([60, 64, 67, 72], E8S, out, { dur: 0.5 }); [60, 64, 67, 72].forEach(midi => piano(midi, { at: 0.06 + E8S * 4, gain: 0.07, dur: 1.4 }, out)); },
  stAccepted: out => { [55, 59, 62].forEach(midi => piano(midi, { at: 0.02, gain: 0.08, dur: 0.5 }, out)); [48, 52, 55, 60].forEach(midi => piano(midi, { at: 0.34, gain: 0.09, dur: 1.4 }, out)); },
  stRejected: out => piano(45, { gain: 0.08, dur: 0.9 }, out),
  stWithdrawn: out => glide(64, 57, { dur: 0.3, gain: 0.06 }, out),
  stGhosted: out => piano(57, { gain: 0.07, dur: 2.2 }, out),
  knock: out => { wood(0, out); wood(0.14, out); },
  note: out => piano(67, { gain: 0.1, dur: 0.6 }, out),
  triplet: out => notes([64, 67, 72], BEAT / 6000, out, { dur: 0.5 }),
  knob: out => noise({ dur: 0.018, gain: 0.07, type: 'highpass', freq: 3000 }, out),
  success: out => notes([67, 72], 0.1, out, { dur: 0.6 }),
  up: (out, arg = 0.5) => piano([60, 62, 64, 65, 67, 69, 71, 72][Math.round(Math.max(0, Math.min(1, arg)) * 7)], { gain: 0.1, dur: 0.6 }, out),
  down: out => { piano(60, { gain: 0.07, dur: 0.45 }, out); piano(55, { at: 0.07, gain: 0.06, dur: 0.5 }, out); },
  goal: out => { [60, 64, 67].forEach((midi, i) => piano(midi, { at: 0.02 + i * 0.06, gain: 0.09, dur: 1.2 }, out)); ding({ at: 0.3, gain: 0.06 }, out); },
  type: out => [0, 0.07, 0.15].forEach(at => noise({ at, dur: 0.012, gain: 0.05, type: 'highpass', freq: 4000 }, out)),
  error: out => noise({ dur: 0.07, gain: 0.22, freq: 160, q: 0.8 }, out),
  // The day/night switch: three notes climbing for the sunrise, the same three falling for the evening.
  dawn: out => notes([60, 64, 67], E8S, out, { gain: 0.08, dur: 0.6 }),
  dusk: out => notes([67, 64, 60], E8S, out, { gain: 0.07, dur: 0.8 }),
};
export function cue(name, arg) {
  if (!CUES[name] || !prefs.get().sound || !allow(`cue-${name}`, BEAT / 4)) return;
  const out = voice();
  if (out) CUES[name](out, arg);
}

// One key's phrase, its steps a beat apart; the room's echo follows the voice.
function phrase(t, index, at, out) {
  out.connect(room);
  t.keys[index % t.keys.length].forEach((step, i) => [step].flat().forEach(midi => keyNote(t.voice, midi, { at: at + i * t.beat, gain: t.gain }, out)));
}

// A sidebar key: one phrase per window (0.75 s unless changed), counted from the click that sounded.
// Clicks inside the window still press the key and switch the page, they just stay silent.
export function playKey(index, theme) {
  const { sound, keyWindow, tune } = prefs.get();
  if (!sound) return false;
  const now = performance.now();
  if (now - keyGate.phraseAt < keyWindow) return false;
  const out = voice();
  if (!out) return false;
  keyGate.phraseAt = now;
  phrase(TUNES[tuneFor(tune, theme)], index, 0.02, out);
  return true;
}
// Picking a tune previews it: the keys top to bottom, 0.42 s apart, outside the click window.
export function previewTune(choice, theme) {
  const out = voice(true);
  if (!out) return 0;
  const t = TUNES[tuneFor(choice, theme)];
  t.keys.forEach((_, i) => phrase(t, i, 0.05 + i * 0.42, out));
  keyGate.phraseAt = performance.now() + (0.05 + t.keys.length * 0.42) * 1000;
  return t.keys.length;
}
