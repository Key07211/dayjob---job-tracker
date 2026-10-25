import { useEffect, useRef, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { reducedMotion } from './sound.js';
import { listenAnalyser, retryCapture, useNowPlaying } from './music.js';
import { usePrefs } from './prefs.js';
import { emit } from './bus.js';

const SETTLE = 900;

// The listening wave across the top of every page, in the band the sidebar colour runs along. While a music app
// plays, three waves ride on the song: bass (long and strong), mids, treble (short and faint), with a faint
// spectrum standing on the band's lip. They flow one cycle per two beats and follow the song's own tempo once a
// few beats are heard; each beat is also told to the logo's note. When the song stops they settle flat and fade.
// Until the system sound is reached the wave only breathes, and a small button offers to connect it.
export function ListenWave() {
  const { t } = useI18n();
  const groove = usePrefs();
  const { track, browser, capture } = useNowPlaying();
  const on = groove.followMusic && Boolean(track) && !browser;
  const canvas = useRef(null);
  const live = useRef({ frame: 0, phase: 0, last: 0, pulse: 0, lowAvg: undefined, lastBeat: 0, beats: [], freq: null, level: 0, offAt: 0 });
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
      const warm = css.getPropertyValue('--step-hi').trim();
      g.clearRect(0, 0, w, h);
      const dt = s.last ? Math.min(0.1, (now - s.last) / 1000) : 0;
      s.last = now;
      // Everything eases toward silence once the song stops, so the waves lie down instead of vanishing mid-swing.
      s.level += ((on ? 1 : 0) - s.level) * Math.min(1, dt * 5);
      let bands = [0, 0, 0];
      let peaks = null;
      let tempo = 96;
      if (analyser) {
        if (!s.freq || s.freq.length !== analyser.frequencyBinCount) s.freq = new Uint8Array(analyser.frequencyBinCount);
        const fd = s.freq;
        analyser.getByteFrequencyData(fd);
        const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
        const bin = f => Math.round(f / hzPerBin);
        const band = (f0, f1) => { let total = 0; for (let i = bin(f0); i <= bin(f1); i += 1) total += fd[i]; return total / ((bin(f1) - bin(f0) + 1) * 255); };
        // A beat: the 40–90 Hz band jumping over its recent average.
        const low = band(40, 90) * 255;
        s.lowAvg = s.lowAvg === undefined ? low : s.lowAvg * 0.9 + low * 0.1;
        if (low > 90 && low > s.lowAvg * 1.25 && now - s.lastBeat > 330) {
          if (s.lastBeat) s.beats = s.beats.concat(now - s.lastBeat).slice(-6);
          s.lastBeat = now;
          s.pulse = 1;
          emit('beat', { strength: Math.min(1, low / 200) });
        }
        const sorted = s.beats.slice().sort((x, y) => x - y);
        if (sorted.length >= 3) tempo = 60000 / sorted[Math.floor(sorted.length / 2)];
        bands = [Math.min(1, band(40, 250) * 1.3 + s.pulse * 0.35), Math.min(1, band(250, 2000) * 1.6), Math.min(1, band(2000, 6000) * 2.6)];
        peaks = [];
        const count = 64;
        for (let k = 0; k < count; k += 1) {
          const f0 = 60 * Math.pow(100, k / count);
          const f1 = 60 * Math.pow(100, (k + 1) / count);
          let peak = 0;
          for (let i = bin(f0); i <= Math.max(bin(f0), bin(f1)); i += 1) peak = Math.max(peak, fd[i] || 0);
          peaks.push(peak / 255);
        }
      } else if (on) {
        // Breathing at Dayjob's own 96 BPM until the sound itself is reached.
        const breath = 0.5 + 0.5 * Math.sin(now / 1250 * Math.PI);
        bands = [0.12 + 0.06 * breath, 0.06, 0.03];
      }
      s.pulse *= 0.88;
      s.phase += dt * Math.PI * tempo / 60;
      if (peaks) {
        g.fillStyle = soft;
        g.globalAlpha = 0.2 * s.level;
        const barW = w / peaks.length;
        peaks.forEach((peak, k) => {
          const bh = Math.pow(peak, 1.6) * h * 0.62 * s.level;
          if (bh > 0.5) g.fillRect(k * barW + barW * 0.3, h - bh, barW * 0.4, bh);
        });
      }
      const mid = h * 0.5;
      const waves = [
        { amp: bands[0], freq: 1.2, speed: 1, color: line, width: 2.2, alpha: 0.9 },
        { amp: bands[1], freq: 2.6, speed: -1.5, color: soft, width: 1.6, alpha: 0.8 },
        { amp: bands[2], freq: 5.2, speed: 2.2, color: warm, width: 1.3, alpha: 0.75 },
      ];
      g.lineJoin = 'round';
      waves.reverse().forEach(wave => {
        g.strokeStyle = wave.color;
        g.globalAlpha = wave.alpha * Math.max(0.25, s.level);
        g.lineWidth = wave.width * dpr;
        g.beginPath();
        for (let p = 0; p <= 200; p += 1) {
          const x = p / 200 * 4 - 2;
          const taper = Math.pow(4 / (4 + Math.pow(x, 4)), 4);
          const y = mid + wave.amp * s.level * h * 0.42 * taper * Math.sin(x * wave.freq * Math.PI + s.phase * wave.speed);
          if (p) g.lineTo(p / 200 * w, y); else g.moveTo(0, y);
        }
        g.stroke();
      });
      g.globalAlpha = 1;
    };
    const loop = now => { draw(now); s.frame = requestAnimationFrame(loop); };
    s.frame = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(s.frame); s.frame = 0; s.last = 0; };
  }, [drawing, on]);

  const offer = on && (capture === 'waiting' || capture === 'failed');
  return (
    <>
      <div className={`listen-wave${on ? ' on' : ''}`} aria-hidden="true">{drawing ? <canvas ref={canvas} /> : null}</div>
      {offer ? (
        <button type="button" className={`wave-hint${capture === 'failed' ? ' failed' : ''}`} onClick={retryCapture}>
          <AudioLines size={13} />{capture === 'failed' ? t('没读到系统声音，点这里重试', 'Could not hear the system sound; click to retry') : t('点一下，让声浪跟上音乐', 'Click to let the wave hear the music')}
        </button>
      ) : null}
    </>
  );
}
