import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { cue, reducedMotion } from './sound.js';
import { E8, flipIn, press } from './fx.js';

// Dropdowns, dates and times drawn by Dayjob itself, so that their open panels wear the theme like the rest of the
// window: the system draws its own panels square, grey and blue, whatever the theme. Each one opens as a card under
// its box, or above it when the room below is short. It unfolds in a quarter beat and folds away in an eighth.
// The keyboard works as with the system's controls, and focus stays on the box. A new choice presses the box like a
// key; a new date or time flips over to its value.

const GAP = 6;
const EDGE = 8;

// Where the card goes. It keeps inside the page beside a docked browser, whose page is drawn over the window.
function placeFor(box, panel) {
  const rect = box.getBoundingClientRect();
  const right = Math.min(window.innerWidth, box.closest('.main-view')?.getBoundingClientRect().right ?? window.innerWidth) - EDGE;
  const below = window.innerHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const up = panel.scrollHeight > below && above > below;
  const width = Math.max(rect.width, panel.offsetWidth);
  return {
    up,
    style: {
      left: Math.max(EDGE, Math.min(rect.left, right - width)),
      minWidth: rect.width,
      maxHeight: Math.max(120, up ? above : below),
      ...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
    },
  };
}

// The box and its card: open, then closing for an eighth of a beat, then gone. A press outside, a resize or the
// window losing focus closes it; scrolling the page moves it along with its box.
function usePopover() {
  const box = useRef(null);
  const panel = useRef(null);
  const [phase, setPhase] = useState('closed');
  const [place, setPlace] = useState(null);
  const open = phase === 'open';
  const hide = (refocus = true) => {
    setPhase(now => (now === 'open' ? (reducedMotion() ? 'closed' : 'closing') : now));
    if (refocus) box.current?.focus();
  };
  const show = () => { setPlace(null); setPhase('open'); };
  useEffect(() => {
    if (phase !== 'closing') return undefined;
    const timer = setTimeout(() => setPhase('closed'), E8);
    return () => clearTimeout(timer);
  }, [phase]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => { if (box.current && panel.current) setPlace(placeFor(box.current, panel.current)); };
    const away = event => { if (!box.current?.contains(event.target) && !panel.current?.contains(event.target)) hide(false); };
    const scrolled = event => { if (!panel.current?.contains(event.target)) update(); };
    const left = () => hide(false);
    update();
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', left);
    window.addEventListener('blur', left);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', left);
      window.removeEventListener('blur', left);
    };
  }, [open]);
  const card = (className, props, content) => (phase === 'closed' ? null : createPortal(
    <div ref={panel} className={`picker-panel ${className}${place?.up ? ' up' : ''}${phase === 'closing' ? ' closing' : ''}`}
      style={{ ...place?.style, visibility: place ? 'visible' : 'hidden' }} onPointerDown={event => event.preventDefault()} {...props}>
      {content}
    </div>, document.body));
  return { box, panel, open, show, hide, card };
}

// A ref from outside (React 19 passes it as a prop) and the box's own.
const joinRefs = (own, outer) => node => {
  own.current = node;
  if (typeof outer === 'function') outer(node);
  else if (outer) outer.current = node;
};
const scrollTo = (panel, id) => { if (id) panel.current?.ownerDocument.getElementById(id)?.scrollIntoView({ block: 'nearest' }); };

const textOf = node => (node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(textOf).join('')
  : isValidElement(node) ? textOf(node.props.children) : String(node));
const optionsOf = children => Children.toArray(children).flatMap(child => {
  if (!isValidElement(child)) return [];
  if (child.type === Fragment) return optionsOf(child.props.children);
  if (child.type !== 'option') return [];
  const { value, children: label, disabled } = child.props;
  return [{ value: String(value ?? textOf(label)), label, text: textOf(label).toLowerCase(), disabled: Boolean(disabled) }];
});

// In place of <select>, with the same <option> children, value and onChange (event.target.value is the option's
// value as text).
export function Select({ value, onChange, children, disabled = false, name, className = '', ref, ...rest }) {
  const options = optionsOf(children);
  const id = useId();
  const pop = usePopover();
  const current = String(value ?? '');
  const selected = options.findIndex(option => option.value === current);
  const [active, setActive] = useState(-1);
  const typed = useRef({ text: '', at: 0 });
  const keyed = useRef(false);
  const next = (from, by) => {
    for (let i = from + by; i >= 0 && i < options.length; i += by) if (!options[i].disabled) return i;
    return from;
  };
  const optionId = index => (index >= 0 ? `${id}-${index}` : undefined);
  useEffect(() => { if (pop.open) scrollTo(pop.panel, optionId(active)); }, [active, pop.open]);

  function openAt(index) {
    setActive(index >= 0 ? index : next(-1, 1));
    pop.show();
  }
  function choose(index) {
    const option = options[index];
    if (!option || option.disabled) return;
    pop.hide();
    if (option.value === current) return;
    cue('pick');
    press(pop.box.current);
    onChange?.({ target: { value: option.value, name }, currentTarget: { value: option.value, name } });
  }
  // Typing letters goes to the next option that starts with them.
  function typeTo(letter) {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + letter.toLowerCase(), at: now };
    const from = pop.open ? active : selected;
    const order = options.map((_, i) => (from + 1 + i) % options.length);
    const found = order.find(i => !options[i].disabled && options[i].text.startsWith(typed.current.text));
    if (found === undefined) return;
    if (pop.open) setActive(found); else choose(found);
  }
  function onKeyDown(event) {
    const { key } = event;
    if (!pop.open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') { event.preventDefault(); keyed.current = true; openAt(selected); }
      else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) typeTo(key);
      return;
    }
    if (key === 'ArrowDown') setActive(i => next(i, 1));
    else if (key === 'ArrowUp') setActive(i => next(i, -1));
    else if (key === 'Home') setActive(next(-1, 1));
    else if (key === 'End') setActive(next(options.length, -1));
    else if (key === 'Enter' || key === ' ') { keyed.current = true; choose(active); }
    else if (key === 'Escape') { event.stopPropagation(); pop.hide(); }
    else if (key === 'Tab') { pop.hide(false); return; }
    else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) typeTo(key);
    else return;
    event.preventDefault();
  }
  return (
    <>
      <button type="button" ref={joinRefs(pop.box, ref)} className={`picker${className ? ` ${className}` : ''}${pop.open ? ' open' : ''}`} role="combobox"
        aria-haspopup="listbox" aria-expanded={pop.open} aria-controls={pop.open ? `${id}-list` : undefined} aria-activedescendant={pop.open ? optionId(active) : undefined}
        disabled={disabled} onKeyDown={onKeyDown} onKeyUp={event => { if (event.key === ' ') event.preventDefault(); }}
        onClick={() => { if (keyed.current) { keyed.current = false; return; } if (pop.open) pop.hide(); else openAt(selected); }} {...rest}>
        <span className="picker-value">{selected >= 0 ? options[selected].label : ''}</span>
        <ChevronDown size={15} className="picker-chev" />
      </button>
      {pop.card('picker-list', { role: 'listbox', id: `${id}-list`, 'aria-label': rest['aria-label'] }, options.map((option, index) => (
        <div key={index} id={optionId(index)} role="option" aria-selected={index === selected} aria-disabled={option.disabled || undefined} style={{ '--i': Math.min(index, 10) }}
          className={`picker-option${index === selected ? ' on' : ''}${index === active ? ' active' : ''}`} onPointerEnter={() => setActive(index)} onClick={() => choose(index)}>
          <span>{option.label}</span>{index === selected ? <Check size={14} /> : null}
        </div>
      )))}
    </>
  );
}

// Dates are YYYY-MM-DD, as <input type="date"> gives them.
const pad = n => String(n).padStart(2, '0');
const dayText = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseDay = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
};
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const monthStart = date => new Date(date.getFullYear(), date.getMonth(), 1);
const addMonths = (date, months) => {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
};

// In place of <input type="date">: the box shows the day, and a month calendar opens under it.
export function DateField({ value, onChange, max, min, required = false, disabled = false, className = '', ref, ...rest }) {
  const { t, lang, locale } = useI18n();
  const id = useId();
  const pop = usePopover();
  const picked = parseDay(value);
  const today = new Date();
  const latest = parseDay(max);
  const earliest = parseDay(min);
  const allowed = date => (!latest || date <= latest) && (!earliest || date >= earliest);
  const clamp = date => (latest && date > latest ? latest : earliest && date < earliest ? earliest : date);
  const [focus, setFocus] = useState(() => clamp(picked || today));
  const [shift, setShift] = useState('');
  const keyed = useRef(false);
  const mondayFirst = lang !== 'en';
  const shown = monthStart(focus);
  const lead = (shown.getDay() + (mondayFirst ? 6 : 0)) % 7;
  const days = Array.from({ length: 42 }, (_, i) => addDays(shown, i - lead));
  const weekdays = Array.from({ length: 7 }, (_, i) => days[i].toLocaleDateString(locale, { weekday: 'narrow' }));
  const cellId = date => `${id}-${dayText(date)}`;
  useEffect(() => { if (pop.open) scrollTo(pop.panel, cellId(focus)); }, [focus, pop.open]);

  const moveTo = target => {
    const next = clamp(target);
    if (next.getMonth() !== focus.getMonth() || next.getFullYear() !== focus.getFullYear()) setShift(next > focus ? 'from-next' : 'from-prev');
    setFocus(next);
  };
  function openNow() { setShift(''); setFocus(clamp(picked || today)); pop.show(); }
  function choose(date) {
    if (date && !allowed(date)) return;
    pop.hide();
    const text = date ? dayText(date) : '';
    if (text === (value || '')) return;
    cue('pick');
    flipIn(pop.box.current?.querySelector('.picker-value'));
    onChange?.({ target: { value: text }, currentTarget: { value: text } });
  }
  function onKeyDown(event) {
    const { key } = event;
    if (!pop.open) {
      if (key === 'ArrowDown' || key === 'Enter' || key === ' ') { event.preventDefault(); keyed.current = true; openNow(); }
      return;
    }
    const weekStart = addDays(focus, -((focus.getDay() + (mondayFirst ? 6 : 0)) % 7));
    const moves = { ArrowLeft: addDays(focus, -1), ArrowRight: addDays(focus, 1), ArrowUp: addDays(focus, -7), ArrowDown: addDays(focus, 7),
      PageUp: addMonths(focus, -1), PageDown: addMonths(focus, 1), Home: weekStart, End: addDays(weekStart, 6) };
    if (moves[key]) moveTo(moves[key]);
    else if (key === 'Enter' || key === ' ') { keyed.current = true; choose(focus); }
    else if (key === 'Escape') { event.stopPropagation(); pop.hide(); }
    else if (key === 'Tab') { pop.hide(false); return; }
    else return;
    event.preventDefault();
  }
  const label = picked ? (lang === 'en' ? picked.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : `${picked.getFullYear()}年${picked.getMonth() + 1}月${picked.getDate()}日`) : t('选择日期', 'Pick a date');
  const canBack = !earliest || addMonths(shown, -1) >= monthStart(earliest);
  const canOn = !latest || addMonths(shown, 1) <= latest;
  return (
    <>
      <button type="button" ref={joinRefs(pop.box, ref)} className={`picker picker-date${className ? ` ${className}` : ''}${pop.open ? ' open' : ''}`} role="combobox"
        aria-haspopup="grid" aria-expanded={pop.open} aria-controls={pop.open ? `${id}-grid` : undefined} aria-activedescendant={pop.open ? cellId(focus) : undefined}
        aria-required={required || undefined} disabled={disabled} onKeyDown={onKeyDown} onKeyUp={event => { if (event.key === ' ') event.preventDefault(); }}
        onClick={() => { if (keyed.current) { keyed.current = false; return; } if (pop.open) pop.hide(); else openNow(); }} {...rest}>
        <span className={`picker-value${picked ? '' : ' empty'}`}>{label}</span>
        <CalendarDays size={15} />
      </button>
      {pop.card('picker-calendar', { role: 'dialog', 'aria-label': t('选择日期', 'Pick a date') }, (
        <>
          <div className="cal-head">
            <button type="button" tabIndex={-1} disabled={!canBack} aria-label={t('上个月', 'Previous month')} onClick={() => moveTo(addMonths(focus, -1))}><ChevronLeft size={16} /></button>
            <strong key={dayText(shown)} className={shift}>{shown.toLocaleDateString(locale, { year: 'numeric', month: 'long' })}</strong>
            <button type="button" tabIndex={-1} disabled={!canOn} aria-label={t('下个月', 'Next month')} onClick={() => moveTo(addMonths(focus, 1))}><ChevronRight size={16} /></button>
          </div>
          <div className="cal-week" aria-hidden="true">{weekdays.map((day, i) => <span key={i}>{day}</span>)}</div>
          <div key={dayText(shown)} id={`${id}-grid`} role="grid" className={`cal-grid ${shift}`}>
            {days.map(date => {
              const text = dayText(date);
              const on = picked && text === dayText(picked);
              return (
                <button key={text} id={cellId(date)} type="button" tabIndex={-1} role="gridcell" aria-selected={Boolean(on)} disabled={!allowed(date)}
                  className={`cal-day${date.getMonth() !== shown.getMonth() ? ' out' : ''}${text === dayText(today) ? ' today' : ''}${on ? ' on' : ''}${text === dayText(focus) ? ' active' : ''}`}
                  onPointerEnter={() => { if (allowed(date) && date.getMonth() === shown.getMonth()) setFocus(date); }} onClick={() => choose(date)}>
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="cal-foot">
            <button type="button" tabIndex={-1} className="link" disabled={!allowed(today)} onClick={() => choose(today)}>{t('今天', 'Today')}</button>
            {required ? null : <button type="button" tabIndex={-1} className="link" disabled={!picked} onClick={() => choose(null)}>{t('清除', 'Clear')}</button>}
          </div>
        </>
      ))}
    </>
  );
}

// In place of <input type="time">: HH:MM on a 24-hour clock, picked from a column of hours and one of minutes
// (every five, plus the one already set).
export function TimeField({ value, onChange, disabled = false, className = '', ref, ...rest }) {
  const { t } = useI18n();
  const id = useId();
  const pop = usePopover();
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  const hour = match ? Number(match[1]) : null;
  const minute = match ? Number(match[2]) : null;
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = [...new Set([...Array.from({ length: 12 }, (_, i) => i * 5), ...(minute === null ? [] : [minute])])].sort((a, b) => a - b);
  const [column, setColumn] = useState('h');
  const keyed = useRef(false);
  const cellId = (col, n) => `${id}-${col}${n}`;
  useLayoutEffect(() => {
    if (!pop.open) return;
    for (const [col, n] of [['h', hour ?? 8], ['m', minute ?? 0]]) pop.panel.current?.ownerDocument.getElementById(cellId(col, n))?.scrollIntoView({ block: 'center' });
  }, [pop.open]);
  useEffect(() => { if (pop.open) scrollTo(pop.panel, cellId(column, column === 'h' ? hour ?? 0 : minute ?? 0)); }, [hour, minute, column, pop.open]);

  function set(h, m, close = false) {
    const text = `${pad(h)}:${pad(m)}`;
    if (close) pop.hide();
    if (text === value) return;
    cue('knob');
    flipIn(pop.box.current?.querySelector('.picker-value'));
    onChange?.({ target: { value: text }, currentTarget: { value: text } });
  }
  function onKeyDown(event) {
    const { key } = event;
    if (!pop.open) {
      if (key === 'ArrowDown' || key === 'Enter' || key === ' ') { event.preventDefault(); keyed.current = true; setColumn('h'); pop.show(); }
      return;
    }
    const h = hour ?? 0;
    const m = minute ?? 0;
    const at = minutes.indexOf(m);
    if (key === 'ArrowLeft' || key === 'ArrowRight') setColumn(key === 'ArrowLeft' ? 'h' : 'm');
    else if (key === 'ArrowUp' || key === 'ArrowDown') {
      const by = key === 'ArrowUp' ? -1 : 1;
      if (column === 'h') set((h + by + 24) % 24, m);
      else set(h, minutes[(at + by + minutes.length) % minutes.length]);
    } else if (key === 'Enter' || key === ' ' || key === 'Escape') { keyed.current = key !== 'Escape'; event.stopPropagation(); pop.hide(); }
    else if (key === 'Tab') { pop.hide(false); return; }
    else return;
    event.preventDefault();
  }
  return (
    <>
      <button type="button" ref={joinRefs(pop.box, ref)} className={`picker picker-time${className ? ` ${className}` : ''}${pop.open ? ' open' : ''}`} role="combobox"
        aria-haspopup="listbox" aria-expanded={pop.open} aria-activedescendant={pop.open ? cellId(column, column === 'h' ? hour ?? 0 : minute ?? 0) : undefined}
        disabled={disabled} onKeyDown={onKeyDown} onKeyUp={event => { if (event.key === ' ') event.preventDefault(); }}
        onClick={() => { if (keyed.current) { keyed.current = false; return; } if (pop.open) pop.hide(); else { setColumn('h'); pop.show(); } }} {...rest}>
        <span className={`picker-value${match ? '' : ' empty'}`}>{match ? value : '--:--'}</span>
        <Clock3 size={15} />
      </button>
      {pop.card('picker-clock', { role: 'dialog', 'aria-label': t('选择时间', 'Pick a time') }, (
        <>
          <div className={`time-col${column === 'h' ? ' focused' : ''}`} role="listbox" aria-label={t('时', 'Hour')}>
            {hours.map(h => <button key={h} id={cellId('h', h)} type="button" tabIndex={-1} role="option" aria-selected={h === hour} className={h === hour ? 'on' : ''}
              onClick={() => { setColumn('m'); set(h, minute ?? 0); }}>{pad(h)}</button>)}
          </div>
          <div className={`time-col${column === 'm' ? ' focused' : ''}`} role="listbox" aria-label={t('分', 'Minute')}>
            {minutes.map(m => <button key={m} id={cellId('m', m)} type="button" tabIndex={-1} role="option" aria-selected={m === minute} className={m === minute ? 'on' : ''}
              onClick={() => set(hour ?? 0, m, true)}>{pad(m)}</button>)}
          </div>
        </>
      ))}
    </>
  );
}
