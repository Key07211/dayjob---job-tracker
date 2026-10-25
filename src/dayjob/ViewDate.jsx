import { useEffect, useRef } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useI18n } from '../i18n.jsx';
import { dateLine } from './format.js';
import { useMinute } from './theme.js';
import { useTheme } from './groove/prefs.js';
import { Roll } from './groove/Fx.jsx';

// What the clock showed last. Each page has its own header, and a page that opens shows the time already there
// as it is, without rolling it in again.
const shown = { hh: null, mm: null, theme: null };

// The date and the time above each page's title. The minutes roll in as they change, and the sun or the moon
// beside the time turns over when the theme does.
export function ViewDate({ children }) {
  const { locale } = useI18n();
  const minute = useMinute();
  const theme = useTheme();
  const now = new Date(minute * 60000);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const Sky = theme === 'night' ? Moon : Sun;
  // What this header found on show when it opened stays still; anything that changes after that moves.
  const still = useRef(null);
  still.current ??= { ...shown };
  for (const [name, value] of Object.entries({ hh, mm, theme })) if (still.current[name] !== value) still.current[name] = null;
  useEffect(() => { Object.assign(shown, { hh, mm, theme }); });
  return (
    <p className="view-date">
      <span>{dateLine(locale)}</span>
      <span aria-hidden="true">·</span>
      <time className="clock" dateTime={`${hh}:${mm}`}>
        <Sky key={theme} size={13} className={still.current.theme ? 'still' : undefined} />
        <span><Roll value={hh} still={Boolean(still.current.hh)} />:<Roll value={mm} still={Boolean(still.current.mm)} /></span>
      </time>
      {children}
    </p>
  );
}
