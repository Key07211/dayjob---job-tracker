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

// What each sidebar key plays: two notes, one pair per page from top to bottom (all public domain).
// Morning Mood (Grieg) stays in the C pentatonic scale, so any keys in any order sound fine; it follows the day theme.
// Moonlight (Beethoven, first movement, in A minor) is slow and low for the night theme. Für Elise is the third choice.
export const TUNES = {
  morning: { gap: 0.19, gain: 0.13, ring: 1.1, keys: [[67, 64], [62, 60], [62, 64], [67, 64], [67, 69], [64, 69], [67, 64], [62, 60]] },
  moon: { gap: 0.3, gain: 0.1, ring: 1.6, keys: [[64, 69], [69, 72], [65, 69], [62, 65], [68, 71], [64, 68], [60, 64], [57, 64]] },
  elise: { gap: 0.15, gain: 0.12, ring: 1.1, keys: [[76, 75], [76, 75], [76, 71], [74, 72], [60, 64], [69, 71], [64, 68], [71, 72]] },
};
export const tuneFor = (choice, theme) => (choice === 'auto' || !TUNES[choice] ? (theme === 'night' ? 'moon' : 'morning') : choice);

let ctx = null;
let master = null;
let cueBus = null;
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

function piano(midi, { at = 0, gain = 0.12, dur = 1.1 } = {}, out) {
  if (!out) return;
  const f = hz(midi);
  const t = ctx.currentTime + at;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.setValueAtTime(Math.min(12000, f * 9), t);
  tone.frequency.exponentialRampToValueAtTime(Math.max(400, f * 2), t + dur);
  tone.connect(out);
  // A hammer-struck string: a few slightly stretched partials, the high ones dying first.
  [[1, 1, 1, 'triangle'], [2, 0.42, 0.6, 'sine'], [3, 0.18, 0.4, 'sine'], [4, 0.08, 0.28, 'sine']].forEach(([h, level, life, wave]) => {
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
  const t = TUNES[tuneFor(tune, theme)];
  const [first, second] = t.keys[index % t.keys.length];
  piano(first, { at: 0.02, gain: t.gain, dur: 0.5 }, out);
  piano(second, { at: 0.02 + t.gap, gain: t.gain, dur: t.ring }, out);
  piano(second - 12, { at: 0.02 + t.gap, gain: t.gain * 0.35, dur: t.ring }, out);
  return true;
}
// Picking a tune previews it: the keys top to bottom as one phrase, outside the click window.
export function previewTune(choice, theme) {
  const out = voice(true);
  if (!out) return 0;
  const t = TUNES[tuneFor(choice, theme)];
  t.keys.forEach(([first, second], i) => {
    const at = 0.05 + i * 0.52;
    piano(first, { at, gain: t.gain, dur: 0.5 }, out);
    piano(second, { at: at + t.gap, gain: t.gain, dur: i === t.keys.length - 1 ? t.ring : 0.6 }, out);
  });
  keyGate.phraseAt = performance.now() + t.keys.length * 520;
  return t.keys.length;
}
// Today's scores as a melody, on the staff behind the Today title.
export function playMelody(scores, onNote) {
  const out = voice(true);
  if (!out) return 0;
  scores.forEach((score, i) => {
    piano(staffMidi(score), { at: 0.05 + i * (BEAT / 2000), gain: 0.13 }, out);
    if (onNote) setTimeout(() => onNote(i), 50 + i * (BEAT / 2));
  });
  if (onNote) setTimeout(() => onNote(-1), 250 + scores.length * (BEAT / 2));
  return scores.length;
}
// A score's note on the staff: C major from E4 (40) up to F5 (100), so higher scores sit higher.
const SCALE = [64, 65, 67, 69, 71, 72, 74, 76, 77];
export const staffStep = score => Math.max(0, Math.min(SCALE.length - 1, Math.round((Math.max(40, Math.min(100, score)) - 40) / 60 * (SCALE.length - 1))));
export const staffMidi = score => SCALE[staffStep(score)];
