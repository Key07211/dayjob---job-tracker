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

let state = { track: null, browser: false };
const listeners = new Set();
let capture = null;
let armed = false;

function publish(next) {
  state = next || { track: null, browser: false };
  // While a song plays, Dayjob's own cues drop about 10 dB so they never fight it.
  duck(Boolean(state.track));
  attach();
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
}

async function startCapture() {
  if (capture || !navigator.mediaDevices?.getDisplayMedia) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach(track => track.stop());
    if (!stream.getAudioTracks().length) return;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.6;
    // Only to the analyser: never to the speakers.
    capture = { stream, source: ctx.createMediaStreamSource(stream), analyser, on: false };
    attach();
  } catch { /* the wave falls back to Dayjob's own cues */ }
}
// Capturing needs a click, so when following was already on at start the first click anywhere starts it.
function armCapture() {
  if (armed || capture) return;
  armed = true;
  window.addEventListener('pointerdown', () => { armed = false; if (prefs.get().followMusic) void startCapture(); }, { once: true, capture: true });
}
function stopCapture() {
  if (!capture) return;
  capture.stream.getTracks().forEach(track => track.stop());
  capture.source.disconnect();
  capture = null;
}

export function setFollow(on, { gesture = false } = {}) {
  if (!bridge) return;
  bridge.setFollow(on).then(publish).catch(() => {});
  if (!on) { stopCapture(); return; }
  if (gesture) void startCapture(); else armCapture();
}

export const listenAnalyser = () => (capture?.on ? capture.analyser : null);
