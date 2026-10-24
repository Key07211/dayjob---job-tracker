import { useRef, useState } from 'react';
import { BEAT, playKey } from './sound.js';

// Black keys sit on the joins above the 2nd, 3rd, 5th, 6th and 7th white keys, like C D E | F G A B.
const BLACK_AFTER = [0, 1, 3, 4, 5];

// The sidebar as a row of piano keys coming out of the left wall: each page is a white key, the short black keys
// only divide them. A key sinks for a quarter beat when pressed and plays two notes; the sound gate keeps fast
// clicking to one phrase per window.
export function PianoNav({ items, theme, label }) {
  const [down, setDown] = useState(null);
  const timer = useRef(0);
  function press(item) {
    playKey(item.note, theme);
    setDown(item.id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDown(null), BEAT / 4);
    item.onSelect();
  }
  return (
    <nav className="keys" aria-label={label}>
      {items.map((item, index) => (
        <button key={item.id} type="button" className={`pkey${item.active ? ' on' : ''}${down === item.id ? ' down' : ''}`}
          aria-current={item.active ? 'page' : undefined} onClick={() => press(item)}>
          {BLACK_AFTER.includes(index - 1) ? <i className="bkey" aria-hidden="true" /> : null}
          <item.icon size={18} />
          <span>{item.label}</span>
          {item.badge ? <em className={item.alert ? 'alert' : undefined}>{item.badge}</em> : null}
        </button>
      ))}
    </nav>
  );
}
