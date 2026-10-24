import { useEffect, useRef, useState } from 'react';
import { BEAT, reducedMotion, tierOf } from './sound.js';
import { useGroove } from './bus.js';

const NOTE_PATH = 'M9 17V4l10-2v12';

// The record player at the bottom of the sidebar. Clicking it starts a search: the arm drops, the record spins up,
// and the stylus tracks from the outer groove inward as the run goes on. While a music app plays it shows the song
// and turns with it. Every score that lands floats a small note out of the record.
export function Turntable({ busy, progress, playing, label, title, sub, dim, onStart, disabled = busy }) {
  const vinyl = useRef(null);
  const mini = useRef(null);
  const spin = useRef({ animations: [], rest: 0 });
  const [pops, setPops] = useState([]);
  const uid = useRef(0);
  const spinning = busy || playing;

  // The record is driven with WAAPI so it can spin up and coast down from wherever it is.
  useEffect(() => {
    const targets = [vinyl.current, mini.current].filter(Boolean);
    const state = spin.current;
    if (!targets.length || reducedMotion()) return;
    const angleOf = el => {
      const m = getComputedStyle(el).transform;
      const parts = m && m !== 'none' ? m.slice(m.indexOf('(') + 1, -1).split(',').map(Number) : null;
      return parts ? (Math.atan2(parts[1], parts[0]) * 180 / Math.PI + 360) % 360 : state.rest;
    };
    if (spinning) {
      const from = state.rest;
      state.animations.forEach(animation => animation.cancel());
      state.animations = targets.map(el => {
        const up = el.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${from + 90}deg)` }],
          { duration: BEAT, easing: 'cubic-bezier(.4,0,.8,.6)', fill: 'forwards' });
        up.onfinish = () => {
          const loop = el.animate([{ transform: `rotate(${from + 90}deg)` }, { transform: `rotate(${from + 450}deg)` }], { duration: BEAT * 2, iterations: Infinity });
          state.animations.push(loop);
        };
        return up;
      });
    } else if (state.animations.length) {
      const angle = angleOf(targets[0]);
      state.animations.forEach(animation => animation.cancel());
      state.animations = targets.map(el => el.animate([{ transform: `rotate(${angle}deg)` }, { transform: `rotate(${angle + 90}deg)` }],
        { duration: BEAT, easing: 'cubic-bezier(.2,.4,.6,1)', fill: 'forwards' }));
      state.rest = angle + 90;
    }
  }, [spinning]);
  useEffect(() => () => spin.current.animations.forEach(animation => animation.cancel()), []);

  useGroove('score', ({ score }) => {
    if (reducedMotion()) return;
    const id = ++uid.current;
    setPops(list => list.concat({ id, tier: tierOf(score), x: ((id * 13) % 22) - 11 }).slice(-4));
    setTimeout(() => setPops(list => list.filter(pop => pop.id !== id)), BEAT + 60);
  });

  const armDeg = busy ? 18 + 12 * Math.min(1, progress) : playing ? 24 : -8;
  const offset = 483.8 * (1 - (busy ? Math.min(1, progress) : 0));
  const notes = pops.map(pop => (
    <svg key={pop.id} className={`deck-pop ${pop.tier}`} style={{ marginLeft: pop.x }} viewBox="0 0 24 24" aria-hidden="true">
      <path d={NOTE_PATH} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="6.5" cy="17.5" r="3" fill="currentColor" /><circle cx="16.5" cy="15.5" r="3" fill="currentColor" />
    </svg>
  ));
  return (
    <div className="turntable">
      <div className="deck-box">
        <button type="button" className="deck" onClick={onStart} disabled={disabled} aria-label={label} title={label}>
          <span className="platter" />
          <svg className="rim" viewBox="0 0 160 160" aria-hidden="true">
            <circle cx="80" cy="80" r="77" fill="none" strokeWidth="2" strokeLinecap="round" transform="rotate(-90 80 80)" strokeDasharray="483.8" style={{ strokeDashoffset: offset }} />
          </svg>
          <span className="vinyl" ref={vinyl}><b><i>{new Date().getDate()}</i></b></span>
          <span className="sheen" />
          <span className="rest-post" />
          <svg className={`tonearm${busy || playing ? '' : ' rest'}`} style={{ transform: `rotate(${armDeg}deg)` }} viewBox="0 0 40 150" aria-hidden="true">
            <rect x="14" y="0" width="12" height="11" rx="3" className="arm-weight" />
            <circle cx="20" cy="18" r="11" className="arm-base" />
            <circle cx="20" cy="18" r="4.5" className="arm-pin" />
            <path d="M20 18 L20 100 Q20 112 15 120" fill="none" strokeWidth="3" strokeLinecap="round" className="arm-tube" />
            <rect x="9" y="117" width="10" height="17" rx="2" transform="rotate(18 14 125)" className="arm-head" />
          </svg>
          <i className={`led${spinning ? ' on' : ''}`} aria-hidden="true" />
        </button>
        <div className="deck-pops">{notes}</div>
      </div>
      <button type="button" className="minirec" onClick={onStart} disabled={disabled} aria-label={label} title={label}>
        <span className="mini-disc" ref={mini} aria-hidden="true" />
        <div className="mini-pops">{notes}</div>
      </button>
      <div className={`deck-text${dim ? ' dim' : ''}`}>
        <strong>{title}</strong>
        <span>{sub}</span>
      </div>
    </div>
  );
}
