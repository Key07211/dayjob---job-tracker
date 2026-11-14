import { CircleHelp } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { guide } from './store.js';

// The question mark beside a group's title on the Settings page: the assistant explains that group (and goes on
// down the page from there, for as long as the user presses Next).
export function GuideHelp({ id }) {
  const { t } = useI18n();
  const label = t('让助手讲讲这一组设置', 'Have the assistant explain these settings');
  return <button type="button" className="guide-help" title={label} aria-label={label} onClick={() => guide.start({ tour: 'settings', at: id })}><CircleHelp size={16} /></button>;
}
