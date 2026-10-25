import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { BEAT, cue, reducedMotion } from './sound.js';

// Scoring in progress: a small equaliser instead of a spinner.
export const Eq = () => <span className="eq" aria-hidden="true"><i /><i /><i /></span>;

// A number that rolls in from below whenever it changes; still, it just shows (a value that was already on show).
export const Roll = ({ value, still = false }) => <b className={`fx-roll${still ? ' still' : ''}`} key={value}>{value}</b>;

// A number that counts up to its value when it first shows, and from the old value to the new one when it changes.
export function CountUp({ value, suffix = '' }) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const from = useRef(reducedMotion() ? value : 0);
  useEffect(() => {
    if (reducedMotion() || from.current === value) { from.current = value; setShown(value); return undefined; }
    const start = performance.now();
    const begin = from.current;
    let frame = 0;
    const step = now => {
      const k = Math.min(1, (now - start) / BEAT);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(begin + (value - begin) * eased));
      if (k < 1) frame = requestAnimationFrame(step); else from.current = value;
    };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); from.current = value; };
  }, [value]);
  return <>{shown}{suffix}</>;
}

// Text with what was searched for lit up for a moment.
export function Hit({ text, q }) {
  const needle = (q || '').trim().toLowerCase();
  const at = needle ? (text || '').toLowerCase().indexOf(needle) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark className="fx-hit" key={needle}>{text.slice(at, at + needle.length)}</mark>{text.slice(at + needle.length)}</>;
}

// "✓ Saved" on a save button for a beat and a half, then its label again; the form itself does not flash.
export function useSaved() {
  const [saved, setSaved] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = () => {
    cue('note');
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), BEAT * 1.6);
  };
  return [saved, flash];
}
export function SavedLabel({ saved, children }) {
  const { t } = useI18n();
  return saved ? <span className="fx-roll" key="saved"><Check size={15} />{t('已保存', 'Saved')}</span> : children;
}
