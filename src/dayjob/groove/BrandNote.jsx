import { useEffect, useRef } from 'react';
import { useGroove } from './bus.js';
import { BEAT, cue } from './sound.js';
import { EASE, E8, Q, animate, floatNote } from './fx.js';

// The note drawn as a "d": its round head is the d's bowl, the stem its rise, and a small flag makes it a quaver.
export function NoteGlyph({ className = '' }) {
  return (
    <svg className={`note-glyph ${className}`} viewBox="0 0 32 32" aria-hidden="true">
      <g className="bn-note">
        <g className="bn-head"><ellipse cx="13" cy="21.6" rx="6.3" ry="4.9" transform="rotate(-20 13 21.6)" /></g>
        <path className="bn-stem" d="M19.2 20.2V5.6" />
        <g className="bn-flag"><path d="M19.2 5.6c.7 2.9 5.3 3.7 5.1 8.7" /></g>
      </g>
    </svg>
  );
}

// A ripple through the wordmark's letters, one after another.
function ripple() {
  document.querySelectorAll('.wordmark > span').forEach((letter, i) => animate(letter, [{ transform: 'none' }, { transform: 'translateY(-3px)', offset: 0.4 }, { transform: 'none' }],
    { duration: Q * 3, delay: i * 52, easing: EASE.inout }));
}

// The logo. It draws itself in when Dayjob opens, waggles its flag under the pointer, hops when clicked (which goes
// home), nods on each beat while a music app plays, and hops twice when a batch of scores is done.
export function BrandNote({ label, onClick }) {
  const box = useRef(null);
  const busy = useRef(null);
  const part = name => box.current?.querySelector(`.bn-${name}`);
  const hop = (times = 1) => {
    busy.current?.cancel();
    busy.current = animate(part('note'), [
      { transform: 'none' }, { transform: 'translateY(-6px)', offset: 0.35 }, { transform: 'translateY(0) scale(1.12, .86)', offset: 0.6 }, { transform: 'none' },
    ], { duration: BEAT * 0.8, iterations: times, easing: EASE.inout });
    animate(part('flag'), [0, -24, 12, 0].map(deg => ({ transform: `rotate(${deg}deg)` })), { duration: BEAT * 0.8, iterations: times, easing: EASE.inout });
  };

  useEffect(() => {
    animate(part('stem'), [{ strokeDashoffset: 15 }, { strokeDashoffset: 0 }], { duration: Q * 1.5, easing: EASE.out, fill: 'backwards' });
    animate(part('head'), [{ transform: 'translateY(-7px) scale(.3)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: Q * 1.5, delay: E8, easing: EASE.spring, fill: 'backwards' });
    animate(part('flag'), [{ transform: 'rotate(-80deg) scale(.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: Q * 1.5, delay: Q, easing: EASE.spring, fill: 'backwards' });
  }, []);
  useGroove('beat', ({ strength = 0.5 }) => {
    if (busy.current?.playState === 'running') return;
    busy.current = animate(part('note'), [{ transform: 'none' }, { transform: `translateY(${-1 - strength * 1.5}px) scale(${1 + strength * 0.06})`, offset: 0.3 }, { transform: 'none' }],
      { duration: Q * 1.4, easing: EASE.out });
  });
  useGroove('batch-end', () => hop(2));

  function waggle() {
    ripple();
    animate(part('flag'), [0, 18, -10, 7, 0].map(deg => ({ transform: `rotate(${deg}deg)` })), { duration: BEAT * 0.75, easing: EASE.inout });
  }
  function click() {
    hop();
    floatNote(box.current);
    cue('note');
    onClick?.();
  }
  return (
    <button ref={box} type="button" className="brand-mark" aria-label={label} title={label} onClick={click} onPointerEnter={waggle}>
      <NoteGlyph />
    </button>
  );
}

// "dayjob" with its letters rising one after another when Dayjob opens, and a ripple through them under the pointer.
export function Wordmark({ text = 'dayjob' }) {
  return <strong className="wordmark" aria-label={text} onPointerEnter={ripple}>{[...text].map((letter, i) => <span key={i} aria-hidden="true" style={{ '--i': i }}>{letter}</span>)}</strong>;
}

// A note hopping on the beat, for a page or a list that is still loading.
export const NoteLoader = ({ className = '' }) => <span className={`note-loader ${className}`} role="status"><NoteGlyph /></span>;
