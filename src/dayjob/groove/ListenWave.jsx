import { useEffect, useRef } from 'react';
import { audio, reducedMotion } from './sound.js';
import { listenAnalyser } from './music.js';

// The listening wave along the bottom of the page, behind the content. Three soft waves ride on the music: bass
// (long and strong), mids, treble (short and faint), with a faint spectrum behind them. They flow one cycle per
// two beats and follow the song's own tempo once a few beats are heard. Without the system sound it follows
// Dayjob's own cues.
export function ListenWave({ on }) {
  const canvas = useRef(null);
  const live = useRef({ frame: 0, phase: 0, last: 0, pulse: 0, lowAvg: undefined, lastBeat: 0, beats: [], data: null, freq: null });

  useEffect(() => {
    const el = canvas.current;
    const s = live.current;
    if (!on || reducedMotion()) return undefined;
    const draw = now => {
      const analyser = listenAnalyser() || audio().analyser;
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
      const mid = h * 0.52;
      if (!analyser) {
        g.strokeStyle = line;
        g.globalAlpha = 0.35;
        g.lineWidth = 1.5 * dpr;
        g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
        g.globalAlpha = 1;
        return;
      }
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
      }
      s.pulse *= 0.88;
      const sorted = s.beats.slice().sort((x, y) => x - y);
      const tempo = sorted.length >= 3 ? 60000 / sorted[Math.floor(sorted.length / 2)] : 96;
      const dt = s.last ? Math.min(0.1, (now - s.last) / 1000) : 0;
      s.last = now;
      s.phase += dt * Math.PI * tempo / 60;
      g.fillStyle = soft;
      g.globalAlpha = 0.22;
      const count = 48;
      const barW = w / count;
      for (let k = 0; k < count; k += 1) {
        const f0 = 60 * Math.pow(100, k / count);
        const f1 = 60 * Math.pow(100, (k + 1) / count);
        let peak = 0;
        for (let i = bin(f0); i <= Math.max(bin(f0), bin(f1)); i += 1) peak = Math.max(peak, fd[i] || 0);
        const bh = Math.pow(peak / 255, 1.6) * h * 0.7;
        g.fillRect(k * barW + barW * 0.25, h - bh, barW * 0.5, bh);
      }
      const waves = [
        { amp: Math.min(1, band(40, 250) * 1.3 + s.pulse * 0.35), freq: 1.2, speed: 1, color: line, width: 2.2, alpha: 1 },
        { amp: Math.min(1, band(250, 2000) * 1.6), freq: 2.6, speed: -1.5, color: soft, width: 1.6, alpha: 0.85 },
        { amp: Math.min(1, band(2000, 6000) * 2.6), freq: 5.2, speed: 2.2, color: warm, width: 1.2, alpha: 0.7 },
      ];
      g.lineJoin = 'round';
      waves.reverse().forEach(wave => {
        g.strokeStyle = wave.color;
        g.globalAlpha = wave.alpha;
        g.lineWidth = wave.width * dpr;
        g.beginPath();
        for (let p = 0; p <= 160; p += 1) {
          const x = p / 160 * 4 - 2;
          const taper = Math.pow(4 / (4 + Math.pow(x, 4)), 4);
          const y = mid + wave.amp * h * 0.44 * taper * Math.sin(x * wave.freq * Math.PI + s.phase * wave.speed);
          if (p) g.lineTo(p / 160 * w, y); else g.moveTo(0, y);
        }
        g.stroke();
      });
      g.globalAlpha = 1;
    };
    const loop = now => { draw(now); s.frame = requestAnimationFrame(loop); };
    s.frame = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(s.frame); s.frame = 0; s.last = 0; };
  }, [on]);

  return <div className={`listen-wave${on ? ' on' : ''}`} aria-hidden="true"><canvas ref={canvas} /></div>;
}
