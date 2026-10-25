import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { playMelody, staffStep, tierOf } from './sound.js';

const GAP = 22;

// A faint five-line staff beside the Today title: every score that lands today adds a note, higher scores sit
// higher, and the play button plays today's notes as a melody.
export function Staff({ scores, label }) {
  const box = useRef(null);
  const [fit, setFit] = useState(12);
  const [now, setNow] = useState(-1);
  useEffect(() => {
    const el = box.current;
    const observer = new ResizeObserver(() => setFit(Math.max(4, Math.floor((el.clientWidth - 40) / GAP))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(0, scores.length - fit);
  const shown = scores.slice(first);
  return (
    <div className="staff" ref={box}>
      <span className="staff-lines" aria-hidden="true"><i /><i /><i /><i /><i /></span>
      {shown.map((score, index) => (
        <span key={first + index} className={`nt ${tierOf(score)}${first + index === now ? ' now' : ''}`}
          style={{ left: index * GAP + 4, top: 32 - staffStep(score) * 4 }} aria-hidden="true"><i /><s /></span>
      ))}
      {scores.length ? (
        <button type="button" className="staff-play" title={label} aria-label={label} style={{ left: shown.length * GAP + 10 }}
          onClick={() => playMelody(shown, index => setNow(index < 0 ? -1 : first + index))}><Play size={12} /></button>
      ) : null}
    </div>
  );
}
