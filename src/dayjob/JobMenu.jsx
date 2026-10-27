import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { reducedMotion } from './groove/sound.js';
import { E8 } from './groove/fx.js';

const EDGE = 8;

// A right-click menu for one job: a themed card at the pointer (under the row when opened from the keyboard) with a
// few actions. It unfolds like the dropdowns and folds away in an eighth of a beat after a choice, Escape, a press
// outside, scrolling, resizing or the window losing focus. The arrow keys move between its items.
export function JobMenu({ at, title, items, onClose, returnFocus }) {
  const panel = useRef(null);
  const [place, setPlace] = useState(null);
  const [closing, setClosing] = useState(false);
  const done = useRef(false);
  const close = (refocus = false) => {
    if (done.current) return;
    done.current = true;
    setClosing(true);
    if (refocus) returnFocus?.focus();
    setTimeout(onClose, reducedMotion() ? 0 : E8);
  };
  const buttons = () => [...(panel.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])];

  useLayoutEffect(() => {
    const card = panel.current;
    if (!card) return;
    // It keeps inside the page beside a docked browser, whose page is drawn over the window.
    const right = Math.min(window.innerWidth, document.querySelector('.main-view')?.getBoundingClientRect().right ?? window.innerWidth) - EDGE;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const up = at.y + height > window.innerHeight - EDGE && at.y - height >= EDGE;
    setPlace({ up, left: Math.max(EDGE, Math.min(at.x, right - width)), top: up ? at.y - height : Math.max(EDGE, Math.min(at.y, window.innerHeight - EDGE - height)) });
  }, [at]);
  // Hidden while it is measured, it takes focus once it shows.
  useEffect(() => { if (place) buttons()[0]?.focus({ preventScroll: true }); }, [place]);
  useEffect(() => {
    const away = event => { if (!panel.current?.contains(event.target)) close(); };
    const left = () => close();
    const escape = event => { if (event.key === 'Escape' && !panel.current?.contains(event.target)) { event.preventDefault(); close(true); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', left, true);
    window.addEventListener('resize', left);
    window.addEventListener('blur', left);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', left, true);
      window.removeEventListener('resize', left);
      window.removeEventListener('blur', left);
    };
  }, []);

  function onKeyDown(event) {
    const list = buttons();
    const index = list.indexOf(document.activeElement);
    const go = to => { event.preventDefault(); list[(to + list.length) % list.length]?.focus(); };
    if (event.key === 'ArrowDown') go(index + 1);
    else if (event.key === 'ArrowUp') go(index < 0 ? list.length - 1 : index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(list.length - 1);
    else if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (event.key === 'Tab') { event.preventDefault(); close(true); }
  }
  return createPortal(
    <div ref={panel} role="menu" aria-label={title} className={`picker-panel job-menu${place?.up ? ' up' : ''}${closing ? ' closing' : ''}`}
      style={{ left: place?.left ?? at.x, top: place?.top ?? at.y, visibility: place ? 'visible' : 'hidden' }}
      onKeyDown={onKeyDown} onContextMenu={event => event.preventDefault()}>
      <p className="job-menu-head">{title}</p>
      {items.map((item, index) => (item === '-' ? <hr key={`gap-${index}`} /> : (
        <button key={item.id} type="button" role="menuitem" className={`picker-option${item.danger ? ' danger' : ''}`} style={{ '--i': index }}
          data-fx={item.fx} disabled={item.disabled} title={item.hint} onPointerEnter={event => event.currentTarget.focus({ preventScroll: true })}
          onClick={event => { item.run(event.currentTarget); close(); }}>
          {item.icon}<span>{item.label}</span>{item.note ? <small>{item.note}</small> : null}
        </button>
      )))}
    </div>, document.body);
}
