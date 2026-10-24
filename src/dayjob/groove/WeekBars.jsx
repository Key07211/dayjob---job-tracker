import { useRef, useState } from 'react';
import { BEAT, reducedMotion } from './sound.js';
import { useGroove } from './bus.js';

// Seven bars in the sidebar: this week's applications per day, Monday first. Applying bumps today's bar and
// floats a "+1"; the bars breathe gently only while something is running or music plays.
export function WeekBars({ week, days, title, total, breathe }) {
  const [bump, setBump] = useState(0);
  const [pluses, setPluses] = useState([]);
  const uid = useRef(0);
  const today = (new Date().getDay() + 6) % 7;
  const max = Math.max(3, ...week);
  useGroove('apply', () => {
    setBump(value => value + 1);
    if (reducedMotion()) return;
    const id = ++uid.current;
    setPluses(list => list.concat(id).slice(-3));
    setTimeout(() => setPluses(list => list.filter(item => item !== id)), BEAT + 40);
  });
  return (
    <div className="week-bars">
      <div className="week-head"><strong>{title}</strong><span>{total}</span></div>
      <div className={`bars${breathe ? ' breathe' : ''}`} aria-hidden="true">
        {week.map((count, index) => (
          <i key={`${index}-${index === today ? bump : 0}`}
            className={`bar${index === today ? ` today${bump ? ' bump' : ''}` : ''}${index > today ? ' future' : ''}`}
            style={{ height: `${Math.max(8, Math.round(count / max * 100))}%` }} />
        ))}
      </div>
      <div className="bar-days" aria-hidden="true">{days.map((day, index) => <span key={index} className={index === today ? 'today' : undefined}>{day}</span>)}</div>
      {pluses.map(id => <span key={id} className="plus" style={{ left: `${(today + 0.5) / 7 * 100}%` }}>+1</span>)}
    </div>
  );
}
