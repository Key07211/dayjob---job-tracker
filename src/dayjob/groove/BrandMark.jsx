import { useEffect, useRef } from 'react';
import { useGroove } from './bus.js';
import { BEAT, cue } from './sound.js';
import { EASE, E8, Q, animate, floatNote } from './fx.js';
import { MarkGlyph } from './MarkGlyph.jsx';
import { openingPlays } from './Opening.jsx';

// A ripple through the wordmark's letters, one after another.
function ripple() {
  document.querySelectorAll('.wordmark > span').forEach((letter, i) => animate(letter, [{ transform: 'none' }, { transform: 'translateY(-3px)', offset: 0.4 }, { transform: 'none' }],
    { duration: Q * 3, delay: i * 52, easing: EASE.inout }));
}

// The logo. Its bars rise one after another when Dayjob opens (unless the opening brings it in), bounce under the
// pointer, the tile hops when clicked (which goes home), the bars nod on each beat while a music app plays, and it
// hops twice when a batch of scores is done.
export function BrandMark({ label, onClick }) {
  const box = useRef(null);
  const busy = useRef(null);
  const bars = () => [...(box.current?.querySelectorAll('.mk-bar') || [])];
  const bounce = (lift = 0.22, times = 1) => bars().map((bar, i) => animate(bar, [
    { transform: 'scaleY(1)' }, { transform: `scaleY(${1 + lift})`, offset: 0.35 }, { transform: `scaleY(${1 - lift * 0.6})`, offset: 0.7 }, { transform: 'scaleY(1)' },
  ], { duration: BEAT * 0.8, delay: i * E8, iterations: times, easing: EASE.inout }));
  const hop = (times = 1) => {
    busy.current?.cancel();
    busy.current = animate(box.current?.querySelector('.mark-glyph'), [
      { transform: 'none' }, { transform: 'translateY(-6px)', offset: 0.35 }, { transform: 'translateY(0) scale(1.1, .9)', offset: 0.6 }, { transform: 'none' },
    ], { duration: BEAT * 0.8, iterations: times, easing: EASE.inout });
    bounce(0.22, times);
  };

  useEffect(() => {
    if (openingPlays()) return;
    bars().forEach((bar, i) => animate(bar, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: Q * 1.5, delay: E8 + i * E8, easing: EASE.spring, fill: 'backwards' }));
  }, []);
  useGroove('beat', ({ strength = 0.5 }) => {
    if (busy.current?.playState === 'running') return;
    // The bars move by different amounts, like a meter, the lit one most.
    const share = [0.5, 0.8, 1, 0.65];
    busy.current = bars().map((bar, i) => animate(bar, [{ transform: 'scaleY(1)' }, { transform: `scaleY(${1 + strength * 0.3 * share[i]})`, offset: 0.3 }, { transform: 'scaleY(1)' }],
      { duration: Q * 1.4, easing: EASE.out }))[2];
  });
  useGroove('batch-end', () => hop(2));

  function hover() {
    ripple();
    if (busy.current?.playState !== 'running') bounce(0.14);
  }
  function click() {
    hop();
    floatNote(box.current);
    cue('note');
    onClick?.();
  }
  return (
    <button ref={box} type="button" className="brand-mark" aria-label={label} title={label} onClick={click} onPointerEnter={hover}>
      <MarkGlyph />
    </button>
  );
}

// "dayjob" with its letters rising one after another when Dayjob opens, and a ripple through them under the pointer.
export function Wordmark({ text = 'dayjob' }) {
  return <strong className="wordmark" aria-label={text} onPointerEnter={ripple}>{[...text].map((letter, i) => <span key={i} aria-hidden="true" style={{ '--i': i }}>{letter}</span>)}</strong>;
}

// The meter's bars rising and falling on the beat, for a page or a list that is still loading.
export const BeatLoader = ({ className = '' }) => <span className={`beat-loader ${className}`} role="status"><MarkGlyph /></span>;
