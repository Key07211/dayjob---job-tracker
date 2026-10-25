import { useSyncExternalStore } from 'react';
import { duck, ensureAudio } from './sound.js';
import { prefs } from './prefs.js';

// Following the music a music app plays (desktop only, off by default). The desktop side reads the song from the
// Windows media controls; here the sound itself is analysed for the listening wave, on this computer only, and
// never played back or recorded. Browsers never count, so a video in a web page leaves everything still.
const bridge = typeof window !== 'undefined' ? window.dayjobDesktop?.music : null;
export const canFollow = Boolean(bridge?.supported);

const APP_NAMES = {
  qqmusic: ['QQ音乐', 'QQ Music'], cloudmusic: ['网易云音乐', 'NetEase Cloud Music'], kugou: ['酷狗音乐', 'Kugou'], kuwo: ['酷我音乐', 'Kuwo'],
  spotify: ['Spotify', 'Spotify'], applemusic: ['Apple Music', 'Apple Music'], itunes: ['iTunes', 'iTunes'], foobar2000: ['foobar2000', 'foobar2000'],
  musicbee: ['MusicBee', 'MusicBee'], aimp: ['AIMP', 'AIMP'], zunemusic: ['媒体播放器', 'Media Player'],
};
export const appName = (app, t) => (APP_NAMES[app] ? t(...APP_NAMES[app]) : '');

// capture: how the system sound reaches the wave. off (not following), waiting (needs a click, which browsers ask
// for), starting, on, or failed (Windows refused; the next click or the retry button in the header tries again).
let state = { track: null, browser: false, capture: 'off' };
const listeners = new Set();
let capture = null;
let armed = false;
let starting = false;

function publish(next) {
  state = { ...state, track: next?.track || null, browser: Boolean(next?.browser) };
  // While a song plays, Dayjob's own cues drop about 10 dB so they never fight it.
  duck(Boolean(state.track));
  attach();
  listeners.forEach(listener => listener());
}
function setCapture(value) {
  if (state.capture === value) return;
  state = { ...state, capture: value };
  listeners.forEach(listener => listener());
}
bridge?.onNowPlaying(publish);

export function useNowPlaying() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => state, () => state);
}

// The system sound reaches the wave only while a music app is playing and no browser is, so web pages never move it.
function attach() {
  if (!capture) return;
  const want = Boolean(state.track) && !state.browser;
  if (want && !capture.on) capture.source.connect(capture.analyser);
  if (!want && capture.on) capture.source.disconnect();
  capture.on = want;
  // A context the browser suspended reads silence, which would leave the wave flat.
  if (want && capture.analyser.context.state === 'suspended') capture.analyser.context.resume().catch(() => {});
}

async function startCapture() {
  if (capture || starting || !navigator.mediaDevices?.getDisplayMedia) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  starting = true;
  setCapture('starting');
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach(track => track.stop());
    const [sound] = stream.getAudioTracks();
    if (!sound) { stream.getTracks().forEach(track => track.stop()); throw new Error('no system sound'); }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.6;
    // Only to the analyser: never to the speakers.
    capture = { stream, source: ctx.createMediaStreamSource(stream), analyser, on: false };
    // Windows can end the capture (a display change, the device going away): listen again from the next click.
    sound.addEventListener('ended', () => { stopCapture(); if (prefs.get().followMusic) { setCapture('failed'); armCapture(); } });
    setCapture('on');
    attach();
  } catch {
    setCapture('failed');
    armCapture();
  } finally {
    starting = false;
  }
}
// Capturing needs a click, so when following was already on at start (or the last try failed) the next click
// anywhere starts it.
function armCapture() {
  if (armed || capture) return;
  armed = true;
  if (state.capture !== 'failed') setCapture('waiting');
  window.addEventListener('pointerdown', () => { armed = false; if (prefs.get().followMusic) void startCapture(); }, { once: true, capture: true });
}
function stopCapture() {
  if (!capture) return;
  capture.stream.getTracks().forEach(track => track.stop());
  capture.source.disconnect();
  capture = null;
}

export async function setFollow(on, { gesture = false } = {}) {
  if (!bridge) return;
  if (!on) {
    stopCapture();
    setCapture('off');
    bridge.setFollow(false).then(publish).catch(() => {});
    return;
  }
  // The desktop side allows the capture only once it is following, so it must hear about it first.
  try { publish(await bridge.setFollow(true)); } catch { return; }
  if (gesture) void startCapture(); else armCapture();
}

// The retry button in the header: a click, so it can start listening right away.
export const retryCapture = () => { if (prefs.get().followMusic) void startCapture(); };

export const listenAnalyser = () => (capture?.on ? capture.analyser : null);
