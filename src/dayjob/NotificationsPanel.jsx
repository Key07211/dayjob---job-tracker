import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing, CalendarX, Ghost, LoaderCircle, Sparkles, TriangleAlert, X } from 'lucide-react';
import { api } from '../api.js';
import { formatTime } from './format.js';
import { useI18n } from '../i18n.jsx';
import { reducedMotion } from './groove/sound.js';
import { Q, leave } from './groove/fx.js';

const ICONS = { daily: Sparkles, scored: Sparkles, 'follow-up': BellRing, ghost: Ghost, 'posting-closed': CalendarX, error: TriangleAlert };
const TARGET = { daily: 'feed', scored: 'feed', 'follow-up': 'applications', ghost: 'applications', 'posting-closed': 'applications' };

export function NotificationsPanel({ onClose, onChanged, setView }) {
  const { t } = useI18n();
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const panel = useRef(null);
  // The panel goes back the way it came, towards the sidebar.
  const close = useRef(null);
  close.current = () => leave(panel.current, 'left', onClose);
  useEffect(() => {
    api('/api/notifications?limit=60').then(setItems).catch(failure => setError(failure.message));
  }, []);
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape') close.current(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  // The unread dots go out from the top down, one after another, like a wave.
  async function markAll() {
    let wave = 0;
    setItems(current => current.map(item => (item.read ? item : { ...item, read: true, wave: Math.min(wave++, 12) })));
    await api('/api/notifications/read', { method: 'POST', body: {} }).catch(() => {});
    void onChanged();
  }
  // The dot shrinks away and the item fades, then the page it is about opens.
  async function open(item) {
    if (!item.read) {
      setItems(current => current.map(entry => (entry.id === item.id ? { ...entry, read: true } : entry)));
      await api('/api/notifications/read', { method: 'POST', body: { id: item.id } }).catch(() => {});
      void onChanged();
    }
    setTimeout(() => {
      if (TARGET[item.kind]) setView(TARGET[item.kind]);
      onClose();
    }, reducedMotion() || item.read ? 0 : Q);
  }
  return (
    <div className="notifications" ref={panel} role="dialog" aria-label={t('通知', 'Notifications')}>
      <header><h2>{t('通知', 'Notifications')}</h2><div>{items?.some(item => !item.read) ? <button className="link" onClick={markAll}>{t('全部标为已读', 'Mark all as read')}</button> : null}
        <button className="icon-button" title={t('关闭', 'Close')} onClick={() => close.current()}><X size={16} /></button></div></header>
      {!items ? <div className="list-empty">{error || <LoaderCircle className="spin" />}</div> : null}
      {items && !items.length ? <div className="list-empty"><Bell size={24} /><p>{t('还没有通知。每日抓取、跟进提醒和岗位关闭都会出现在这里。', 'No notifications yet. Daily results, follow-up reminders and closed postings show up here.')}</p></div> : null}
      <ul>
        {items?.map(item => {
          const Icon = ICONS[item.kind] || Bell;
          return (
            <li key={item.id}>
              <button className={item.read ? '' : 'unread'} style={item.wave !== undefined ? { '--i': item.wave } : undefined} onClick={() => open(item)}>
                <Icon size={16} />
                <div><strong>{item.title}</strong><p>{item.body}</p><time>{formatTime(item.createdAt)}</time></div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
