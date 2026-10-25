import { useEffect, useRef, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { reducedMotion } from './sound.js';
import { listenAnalyser, retryCapture, useNowPlaying } from './music.js';
import { usePrefs } from './prefs.js';
import { emit } from './bus.js';

// How long the wave takes to lie down once the song stops.
const SETTLE = 900;
// One column of the waveform per 25 ms, 2 px wide with a 1 px gap.
const STEP_MS = 25;
const PITCH = 3;
const BAR = 2;

// The listening wave in the header band, between the page title and the buttons on the right. While a music app
// plays it draws the song's own waveform: each column is how loud the sound was in 25 ms (its peak, light, and
// its average power, strong), mirrored around the middle like an audio editor shows it. The newest sound is in
// the middle and flows out to both sides, so the last two or so seconds are on show and fade at the ends. Each
// beat is also told to the logo's note. When the song stops the wave lies down and fades. Until the system sound
// is reached it stays a still line, and a small button offers to connect it.
export function ListenWave() {
  const { t } = useI18n();
  const groove = usePrefs();
  const { track, browser, capture, captureError } = useNowPlaying();
  const on = groove.followMusic && Boolean(track) && !browser;
  const canvas = useRef(null);
  const live = useRef({ frame: 0, last: 0, due: 0, cols: [], gain: 0.05, lowAvg: undefined, lastBeat: 0, time: null, freq: null, level: 0 });
  const [drawing, setDrawing] = useState(on);

  useEffect(() => {
    if (on) { setDrawing(true); return undefined; }
    const timer = setTimeout(() => setDrawing(false), SETTLE);
    return () => clearTimeout(timer);
  }, [on]);

  useEffect(() => {
    const el = canvas.current;
    const s = live.current;
    if (!drawing || !el || reducedMotion()) return undefined;
    const draw = now => {
      const analyser = on ? listenAnalyser() : null;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(el.clientWidth * dpr);
      const h = Math.round(el.clientHeight * dpr);
      if (!w || !h) return;
      if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
      const g = el.getContext('2d');
      const css = getComputedStyle(el);
      const line = css.getPropertyValue('--green').trim();
      const soft = css.getPropertyValue('--step-mid').trim();
      g.clearRect(0, 0, w, h);
      const dt = s.last ? Math.min(0.1, (now - s.last) / 1000) : 0;
      s.last = now;
      s.level += ((analyser ? 1 : 0) - s.level) * Math.min(1, dt * 4);
      const half = Math.ceil(el.clientWidth / 2 / PITCH) + 1;
      if (analyser) {
        if (!s.freq || s.freq.length !== analyser.frequencyBinCount) s.freq = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(s.freq);
        const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
        const from = Math.round(40 / hzPerBin);
        const to = Math.round(90 / hzPerBin);
        let low = 0;
        for (let i = from; i <= to; i += 1) low += s.freq[i];
        low /= to - from + 1;
        // A beat: the 40–90 Hz band jumping over its recent average.
        s.lowAvg = s.lowAvg === undefined ? low : s.lowAvg * 0.9 + low * 0.1;
        if (low > 90 && low > s.lowAvg * 1.25 && now - s.lastBeat > 330) {
          s.lastBeat = now;
          emit('beat', { strength: Math.min(1, low / 200) });
        }
      }
      // New columns at a steady pace, read from the newest 25 ms of the sound; silence once it stops.
      if (!s.due || now - s.due > 500) s.due = now;
      while (now >= s.due) {
        let peak = 0;
        let power = 0;
        if (analyser) {
          if (!s.time || s.time.length !== analyser.fftSize) s.time = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(s.time);
          const count = Math.min(s.time.length, Math.round(analyser.context.sampleRate * STEP_MS / 1000));
          for (let i = s.time.length - count; i < s.time.length; i += 1) {
            const sample = Math.abs(s.time[i]);
            if (sample > peak) peak = sample;
            power += sample * sample;
          }
          power = Math.sqrt(power / count);
        }
        s.cols.unshift([peak, power]);
        s.due += STEP_MS;
      }
      if (s.cols.length > half) s.cols.length = half;
      // The loudest of what is on show sets the scale, so a quiet player still fills the band; it lets go slowly.
      let loudest = 0;
      for (const [peak] of s.cols) if (peak > loudest) loudest = peak;
      s.gain = loudest > s.gain ? loudest : Math.max(0.05, s.gain - (s.gain - loudest) * Math.min(1, dt * 0.6));
      const mid = h / 2;
      const room = h * 0.46;
      const bar = BAR * dpr;
      const pitch = PITCH * dpr;
      const center = w / 2;
      // The still line underneath, so the band never looks empty between sounds.
      g.fillStyle = line;
      g.globalAlpha = 0.3;
      g.fillRect(0, mid - dpr / 2, w, dpr);
      for (const [layer, color, alpha] of [[0, soft, 0.55], [1, line, 0.95]]) {
        g.fillStyle = color;
        g.globalAlpha = alpha;
        g.beginPath();
        s.cols.forEach((column, k) => {
          const height = Math.min(room, (column[layer] / s.gain) * room) * s.level;
          if (height < dpr) return;
          for (const x of k ? [center - bar / 2 - k * pitch, center - bar / 2 + k * pitch] : [center - bar / 2]) {
            g.roundRect(x, mid - height, bar, height * 2, bar / 2);
          }
        });
        g.fill();
      }
      g.globalAlpha = 1;
    };
    const loop = now => { draw(now); s.frame = requestAnimationFrame(loop); };
    s.frame = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(s.frame); s.frame = 0; s.last = 0; s.due = 0; s.cols = []; };
  }, [drawing, on]);

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
