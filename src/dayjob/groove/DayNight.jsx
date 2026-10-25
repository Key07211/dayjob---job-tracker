import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n.jsx';
import { holdEndsAt, toggleTheme, useThemeSettings } from '../theme.js';
import { useTheme } from './prefs.js';
import { cue, reducedMotion, BEAT } from './sound.js';

// The day/night switch beside the clock. By day it is a small sky with two clouds and the sun on the left; by
// night a dusk sky with three stars and the moon on the right. Turning it, the sun rolls across in three quarters
// of a beat while a shadow slides over it into a crescent, the clouds sink away and the stars come out one after
// another (and back: the shadow slides off, the sun's rays flash once, the clouds drift in). Then the page sweeps
// into the other theme. A switch that opens with a page shows its state as it is, without playing the turn.
export function DayNight() {
  const { t } = useI18n();
  const theme = useTheme();
  const settings = useThemeSettings();
  const night = theme === 'night';
  const seen = useRef(theme);
  const [turning, setTurning] = useState(false);
  useEffect(() => {
    if (seen.current === theme) return undefined;
    seen.current = theme;
    if (reducedMotion()) return undefined;
    setTurning(true);
    const timer = setTimeout(() => setTurning(false), BEAT * 1.25);
    return () => clearTimeout(timer);
  }, [theme]);
  const until = holdEndsAt();
  const clock = settings.choice === 'time';
  const goal = night ? t('换成白天', 'Switch to day') : t('换成夜晚', 'Switch to night');
  const title = !clock ? goal : until ? t(`${goal}，到 ${until} 再按时间切换`, `${goal} until ${until}, then by the clock again`) : t(`${goal}，回到按时间`, `${goal}, back to the clock`);
  return (
    <button type="button" role="switch" aria-checked={night} aria-label={t('夜晚模式', 'Night mode')} title={title}
      className={`daynight ${night ? 'night' : 'day'}${turning ? ' turning' : ''}`}
      onClick={() => cue(toggleTheme() ? 'dusk' : 'dawn')}>
      <span className="dn-sky" aria-hidden="true">
        <i className="dn-cloud c1" /><i className="dn-cloud c2" />
        <i className="dn-star s1" /><i className="dn-star s2" /><i className="dn-star s3" />
      </span>
      <span className="dn-knob" aria-hidden="true"><i className="dn-rays" /><i className="dn-disc" /></span>
    </button>
  );
}
