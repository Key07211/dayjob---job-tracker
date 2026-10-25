import { Moon, Sun } from 'lucide-react';
import { useI18n } from '../i18n.jsx';
import { dateLine } from './format.js';
import { useMinute } from './theme.js';
import { useTheme } from './groove/prefs.js';
import { Roll } from './groove/Fx.jsx';

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
  return (
    <p className="view-date">
      <span>{dateLine(locale)}</span>
      <span aria-hidden="true">·</span>
      <time className="clock" dateTime={`${hh}:${mm}`}><Sky key={theme} size={13} /><span><Roll value={hh} />:<Roll value={mm} /></span></time>
      {children}
    </p>
  );
}
