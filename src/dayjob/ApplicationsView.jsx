import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BellRing, BriefcaseBusiness, ExternalLink, Ghost, Globe, Hourglass, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api.js';
import { OPEN_STATUSES, dateInputToIso, daysSince, formatDay, formatTime, label, labels, localDateInput, relativeDay } from './format.js';
import { useI18n } from '../i18n.jsx';
import { hasBrowser, openInBrowser } from './BrowserView.jsx';
import { ViewDate } from './ViewDate.jsx';
import { ListenWave } from './groove/ListenWave.jsx';
import { emit } from './groove/bus.js';
import { BEAT, cue } from './groove/sound.js';
import { burst, flipIn, flipList, leave, leaveThen, pop, rings, rise, stamp, tint, underline, wiggle } from './groove/fx.js';
import { NoteLoader } from './groove/BrandNote.jsx';

const TABS = [
  { id: 'open', label: ['进行中', 'Active'], match: item => OPEN_STATUSES.includes(item.status) },
  { id: 'attention', label: ['需要处理', 'Needs action'], match: item => OPEN_STATUSES.includes(item.status) && item.flags.length > 0 },
  { id: 'closed', label: ['已结束', 'Closed'], match: item => !OPEN_STATUSES.includes(item.status) },
  { id: 'all', label: ['全部', 'All'], match: () => true },
];
const FUNNEL = ['applied', 'oa', 'interview', 'offer'];
// Reaching a later stage implies the earlier ones. A closed application counts
// at the stage it closed from, which the list does not know, so only as applied.
const REACHED = { applied: 0, oa: 1, interview: 2, offer: 3, accepted: 3 };
const step = status => document.querySelector(`.funnel-step[data-status="${status}"]`);
// What a new status does to the card, with its own sound: the offer is the biggest moment, a rejection the quietest.
const STATUS_FX = {
  applied: () => rise(step('applied')),
  oa: () => rise(step('oa')),
  interview: card => { tint(card, 'lit'); rise(step('interview')); },
  offer: card => { burst(card); rise(step('offer')); },
  accepted: (card, t) => stamp(card, t('已接受', 'Accepted')),
  rejected: card => tint(card, 'grey'),
  ghosted: card => tint(card, 'ghost'),
};
const CUE_OF = { applied: 'stApplied', oa: 'stOA', interview: 'stInterview', offer: 'stOffer', accepted: 'stAccepted', rejected: 'stRejected', withdrawn: 'stWithdrawn', ghosted: 'stGhosted' };

function Funnel({ items }) {
  const { t } = useI18n();
  const reached = FUNNEL.map((_, index) => items.filter(item => (REACHED[item.status] ?? 0) >= index).length);
  const total = items.length;
  return (
    <div className="funnel">
      {FUNNEL.map((status, index) => (
        <div key={status} className="funnel-step" data-status={status}>
          <span>{label('status', status)}</span>
          <strong>{index === 0 ? total : reached[index]}</strong>
          {index > 0 && total ? <small>{Math.round((reached[index] / total) * 100)}%</small> : <small>{t('全部投递', 'All applications')}</small>}
        </div>
      ))}
      <div className="funnel-step muted"><span>{t('未通过 / 无回音', 'Rejected / ghosted')}</span><strong>{items.filter(item => ['rejected', 'ghosted'].includes(item.status)).length}</strong><small>&nbsp;</small></div>
    </div>
  );
}

function NewApplication({ onCreated, onCancel }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ company: '', title: '', jobUrl: '', day: localDateInput(), note: '' });
  const [error, setError] = useState('');
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const own = useRef(null);
  async function submit(event) {
    event.preventDefault();
    try {
      const created = await api('/api/applications', { method: 'POST', body: { company: form.company, title: form.title, jobUrl: form.jobUrl || undefined,
        appliedAt: form.day === localDateInput() ? undefined : dateInputToIso(form.day), note: form.note } });
      emit('apply', { postingId: created.postingId || null });
      onCreated(created);
    } catch (failure) { setError(failure.message); }
  }
  return (
    <form className="panel-form" ref={own} onSubmit={submit}>
      <div className="form-head"><h3>{t('手动添加投递', 'Add an application')}</h3><button type="button" className="icon-button" onClick={() => leave(own.current, 'up', onCancel)} title={t('关闭', 'Close')}><X size={16} /></button></div>
      <p className="hint">{t('用于内推或在其他地方投递、Dayjob 没有抓到的岗位。', 'For referrals and jobs you applied to elsewhere that Dayjob did not find.')}</p>
      <div className="form-grid">
        <label>{t('公司', 'Company')}<input value={form.company} onChange={set('company')} required maxLength={160} /></label>
        <label>{t('职位', 'Title')}<input value={form.title} onChange={set('title')} required maxLength={240} /></label>
        <label>{t('链接（可选）', 'Link (optional)')}<input type="url" value={form.jobUrl} onChange={set('jobUrl')} placeholder="https://" /></label>
        <label>{t('投递日期', 'Applied on')}<input type="date" value={form.day} max={localDateInput()} onChange={set('day')} required /></label>
      </div>
      <label>{t('备注', 'Note')}<input value={form.note} onChange={set('note')} maxLength={2000} /></label>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions"><button className="button primary" type="submit"><Plus size={15} />{t('添加', 'Add')}</button></div>
    </form>
  );
}

function ApplicationDetail({ id, onChanged, onDeleted, setView }) {
  const { t } = useI18n();
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [statusDay, setStatusDay] = useState(localDateInput());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  // Timeline entries that just arrived drop in at the top.
  const [fresh, setFresh] = useState(() => new Set());
  const card = useRef(null);
  const noteInput = useRef(null);
  const followInput = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    api(`/api/applications/${encodeURIComponent(id)}`).then(value => {
      if (cancelled) return;
      setItem(value);
      setNotes(value.notes || '');
      setNote('');
      setStatusDay(localDateInput());
    }).catch(failure => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [id]);

  // A status that ends the application lets its moment play on the card before the list moves it to Closed.
  async function patch(body, { linger = 0 } = {}) {
    setBusy(true);
    setError('');
    try {
      const updated = await api(`/api/applications/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      setFresh(new Set(updated.events.filter(event => !item.events.some(old => old.id === event.id)).map(event => event.id)));
      setItem(updated);
      if (linger) setTimeout(() => onChanged(updated), linger); else onChanged(updated);
      return updated;
    } catch (failure) { setError(failure.message); return null; } finally { setBusy(false); }
  }
  const changeStatus = async status => {
    if (status === item.status) return;
    const closing = OPEN_STATUSES.includes(item.status) && !OPEN_STATUSES.includes(status);
    const body = { status, note: note.trim(), ...(statusDay !== localDateInput() ? { statusAt: dateInputToIso(statusDay) } : {}) };
    // Withdrawn: the card slides aside, then folds into Closed.
    if (status === 'withdrawn') {
      cue(CUE_OF.withdrawn);
      const anim = leave(card.current, 'aside', async () => {
        const updated = await patch(body);
        anim?.cancel();
        if (updated) setNote('');
      });
      return;
    }
    const updated = await patch(body, { linger: closing ? BEAT * (status === 'accepted' ? 2.4 : 1.6) : 0 });
    if (!updated) return;
    setNote('');
    cue(CUE_OF[status]);
    STATUS_FX[status]?.(card.current, t);
  };
  // Followed up: the bell rings, the reminder folds away and the next follow-up date turns seven pages on.
  const followed = event => {
    const banner = event.currentTarget.closest('.banner');
    cue('knock');
    wiggle(banner.querySelector('svg'), 18);
    leaveThen(banner, 'up', async () => {
      const updated = await patch({ nextFollowUpAt: new Date(Date.now() + 7 * 864e5).toISOString(), note: t('已跟进', 'Followed up') });
      if (updated) requestAnimationFrame(() => flipIn(followInput.current));
      return Boolean(updated);
    });
  };
  const keepWaiting = event => {
    const banner = event.currentTarget.closest('.banner');
    leaveThen(banner, 'up', async () => Boolean(await patch({ nextFollowUpAt: new Date(Date.now() + 7 * 864e5).toISOString() })));
  };
  const addNote = () => patch({ note: note.trim() }).then(updated => {
    if (!updated) return;
    setNote('');
    underline(noteInput.current);
    cue('note');
  });
  async function remove() {
    if (!window.confirm(t(`删除对 ${item.company} 的投递记录？时间线也会一起删除。`, `Delete your application to ${item.company}? Its timeline is deleted too.`))) return;
    // It shrinks away first; if the delete fails it comes back.
    leaveThen(card.current, 'shrink', async () => {
      try {
        await api(`/api/applications/${encodeURIComponent(id)}`, { method: 'DELETE' });
        onDeleted(id);
        return true;
      } catch (failure) { setError(failure.message); return false; }
    });
  }

  if (!item) return <div className="detail-empty">{error || <NoteLoader />}</div>;
  const quiet = daysSince(item.statusChangedAt);
  return (
    <article className="application-detail" ref={card}>
      <header>
        <h2>{item.title}</h2>
        <p className="detail-company"><span>{item.company}</span>{item.location ? <span>{item.location}</span> : null}{item.site ? <span>{label('site', item.site)}</span> : null}</p>
        <p className="hint">{t(`投递于 ${formatDay(item.appliedAt)}（${relativeDay(item.appliedAt)}）· 当前状态已持续 ${quiet} 天`,
          `Applied ${formatDay(item.appliedAt)} (${relativeDay(item.appliedAt)}) · in this stage for ${quiet} ${quiet === 1 ? 'day' : 'days'}`)}
          {item.score !== undefined && item.score !== null ? t(` · 匹配度 ${item.score}`, ` · match ${item.score}`) : ''}</p>
        {item.jobUrl && hasBrowser ? <button className="button" data-fx="open" onClick={() => openInBrowser(item.jobUrl, setView)}><Globe size={15} />{t('打开岗位页面', 'Open posting')}</button> : null}
        {item.jobUrl && !hasBrowser ? <a className="button" data-fx="external" href={item.jobUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />{t('打开岗位页面', 'Open posting')}</a> : null}
      </header>
      {item.flags.includes('follow-up-due') ? (
        <div className="banner attention"><BellRing size={16} /><span>{t('该跟进了：可以给招聘方发一封简短的跟进邮件。', 'Time to follow up: a short email to the recruiter helps.')}</span>
          <button className="button small" onClick={followed} disabled={busy}>{t('已跟进，7 天后再提醒', 'Done, remind me in 7 days')}</button></div>
      ) : null}
      {item.flags.includes('ghost-suspected') ? (
        <div className="banner ghost"><Ghost size={16} /><span>{t(`${quiet} 天没有回音。`, `No reply for ${quiet} days.`)}</span>
          <button className="button small" onClick={() => changeStatus('ghosted')}>{t('标记为无回音', 'Mark as ghosted')}</button>
          <button className="button small" data-fx="hourglass" onClick={keepWaiting} disabled={busy}><Hourglass size={14} />{t('继续等待', 'Keep waiting')}</button></div>
      ) : null}
      {item.postingClosedAt ? <p className="banner closed">{t(`招聘页面在 ${formatDay(item.postingClosedAt)} 下线，申请仍会继续追踪。`, `The posting was taken down on ${formatDay(item.postingClosedAt)}. Dayjob keeps tracking the application.`)}</p> : null}
      <section className="status-editor">
        <h3>{t('更新状态', 'Update status')}</h3>
        <div className="status-buttons">
          {Object.entries(labels('status')).map(([status, name]) => (
            <button key={status} className={`status-chip ${status}${item.status === status ? ' active' : ''}`} onClick={() => changeStatus(status)} disabled={busy}>{name}</button>
          ))}
        </div>
        <div className="form-grid">
          <label>{t('发生日期', 'Date')}<input type="date" value={statusDay} max={localDateInput()} onChange={event => setStatusDay(event.target.value)} /></label>
          <label className="grow">{t('备注（随状态一起记录）', 'Note (saved with the status)')}<input ref={noteInput} value={note} maxLength={2000} placeholder={t('例如：收到 HackerRank 邀请', 'e.g. got a HackerRank invite')} onChange={event => setNote(event.target.value)} /></label>
        </div>
        <div className="form-actions">
          <button className="button" disabled={!note.trim() || busy} onClick={addNote}>{t('只添加备注', 'Add note only')}</button>
        </div>
      </section>
      <section className="follow-up">
        <label>{t('下次跟进', 'Next follow-up')}
          <input type="date" ref={followInput} value={item.nextFollowUpAt ? localDateInput(item.nextFollowUpAt) : ''}
            onChange={event => { void patch({ nextFollowUpAt: event.target.value ? dateInputToIso(event.target.value) : null }); }} />
        </label>
        <label className="grow">{t('联系人', 'Contact')}<input defaultValue={item.contact} key={`contact-${item.id}`} maxLength={500} placeholder={t('招聘人员姓名或邮箱', 'Recruiter name or email')}
          onBlur={event => { if (event.target.value !== item.contact) void patch({ contact: event.target.value }); }} /></label>
      </section>
      <label className="notes">{t('笔记', 'Notes')}
        <textarea value={notes} rows={4} maxLength={20000} onChange={event => setNotes(event.target.value)}
          onBlur={() => { if (notes !== item.notes) void patch({ notes }); }} placeholder={t('面试题、联系人、薪资沟通……', 'Interview questions, contacts, pay talks…')} />
      </label>
      {error ? <p className="notice error">{error}</p> : null}
      <section className="timeline">
        <h3>{t('时间线', 'Timeline')}</h3>
        <ol>
          {item.events.map(event => (
            <li key={event.id} className={`${event.type}${fresh.has(event.id) ? ' fresh' : ''}`}>
              <time>{formatTime(event.at)}</time>
              <div>
                <strong>{event.type === 'status' ? (event.fromStatus ? `${label('status', event.fromStatus)} → ${label('status', event.toStatus)}` : label('status', event.toStatus)) : label('event', event.type)}</strong>
                {event.note ? <p>{event.note}</p> : null}
              </div>
              <span className={`source ${event.source}`}>{label('source', event.source)}</span>
            </li>
          ))}
        </ol>
      </section>
      <button className="button danger" onClick={remove}><Trash2 size={15} />{t('删除这条投递', 'Delete application')}</button>
    </article>
  );
}

export function ApplicationsView({ dataVersion, refreshStatus, setView, focus = null }) {
  const { t } = useI18n();
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('open');
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  // A row added by hand drops in at the top with a yellow ring; a deleted one leaves the others to slide up.
  const [arrived, setArrived] = useState(null);
  const list = useRef(null);
  const flip = useMemo(() => flipList({ get children() { return list.current?.children; } }), []);

  useEffect(() => {
    api('/api/applications').then(value => { setItems(value); setError(''); }).catch(failure => setError(failure.message));
  }, [dataVersion]);

  const visible = useMemo(() => (items || []).filter(TABS.find(entry => entry.id === tab).match), [items, tab]);
  useEffect(() => {
    if (items && !visible.some(item => item.id === selected)) setSelected(visible[0]?.id || null);
  }, [items, visible, selected]);
  // Opened from Home: show the application in the tab it belongs to. Runs after
  // the effect above, so its selection wins.
  const focused = useRef(focus);
  useEffect(() => {
    if (!items || !focused.current) return;
    const item = items.find(entry => entry.id === focused.current);
    focused.current = null;
    if (item) { setTab(OPEN_STATUSES.includes(item.status) ? 'open' : 'closed'); setSelected(item.id); }
  }, [items]);

  function changed(updated) {
    flip.measure();
    setItems(current => current.map(item => (item.id === updated.id ? { ...item, ...updated } : item)));
    void refreshStatus();
  }
  useLayoutEffect(() => { flip.play(); }, [visible, flip]);
  useEffect(() => {
    if (!arrived) return;
    const row = list.current?.querySelector(`[data-id="${CSS.escape(arrived)}"]`);
    rings(row, { tone: 'yellow', scale: 4 });
    setArrived(null);
  }, [arrived]);
  // The open form folds back into the button that opened it.
  const toggleAdding = () => {
    if (!adding) { setAdding(true); return; }
    leave(document.querySelector('.applications > .panel-form'), 'up', () => setAdding(false));
  };
  const switchTab = id => { setTab(id); pop(document.querySelector(`.tabs [data-tab="${id}"] em`), 1.25); };

  if (!items) return <section className="applications"><div className="list-empty">{error || <NoteLoader />}</div></section>;
  return (
    <section className="applications">
      <header className="view-header">
        <ListenWave />
        <div className="title-block"><ViewDate /><h1>{t('投递追踪', 'Applications')}</h1></div>
        <div className="header-actions"><button className="button" onClick={toggleAdding}><Plus size={15} />{t('手动添加', 'Add manually')}</button></div>
      </header>
      {items.length ? <Funnel items={items} /> : null}
      {adding ? <NewApplication onCancel={() => setAdding(false)} onCreated={created => { flip.measure(); setItems(current => [created, ...current]); setAdding(false); setTab('open'); setSelected(created.id); setArrived(created.id); cue('note'); void refreshStatus(); }} /> : null}
      <div className="tabs">
        {TABS.map(entry => {
          const count = items.filter(entry.match).length;
          return <button key={entry.id} data-tab={entry.id} className={tab === entry.id ? 'active' : ''} onClick={() => switchTab(entry.id)}>{t(...entry.label)}<em>{count}</em></button>;
        })}
      </div>
      <div className="split">
        <div className="posting-list tabbed" key={tab} ref={list}>
          {!visible.length ? (
            <div className="list-empty"><BriefcaseBusiness size={28} /><p>{items.length ? t('这一栏是空的。', 'Nothing here.') : t('还没有投递记录。在岗位详情里点“我已投递”，或手动添加。', 'No applications yet. Click “I applied” on a job, or add one by hand.')}</p></div>
          ) : null}
          {visible.map(item => (
            <button key={item.id} data-id={item.id} data-fx="select" className={`posting-row application-row${selected === item.id ? ' selected' : ''}`} onClick={() => setSelected(item.id)}>
              <div className="row-main">
                <strong>{item.company}</strong>
                <span className="row-company">{item.title}</span>
                <span className="row-meta">
                  <span>{t(`投递 ${daysSince(item.appliedAt)} 天`, `Applied ${daysSince(item.appliedAt)}d ago`)}</span>
                  {item.status !== 'applied' ? <span>{t(`${relativeDay(item.statusChangedAt)}更新`, `Updated ${relativeDay(item.statusChangedAt)}`)}</span> : null}
                  {item.nextFollowUpAt && OPEN_STATUSES.includes(item.status) ? <span>{t(`跟进 ${formatDay(item.nextFollowUpAt)}`, `Follow up ${formatDay(item.nextFollowUpAt)}`)}</span> : null}
                  {item.flags.map(flag => <span key={flag} className={`tag-flag ${flag}`}>{label('flag', flag)}</span>)}
                  {item.postingClosedAt ? <span className="tag-closed">{t('岗位已下线', 'Posting closed')}</span> : null}
                </span>
              </div>
              <span className={`status-pill ${item.status}`}>{label('status', item.status)}</span>
            </button>
          ))}
        </div>
        <div className="detail-pane">
          {selected ? <ApplicationDetail key={selected} id={selected} onChanged={changed} setView={setView}
            onDeleted={id => { flip.measure(); setItems(current => current.filter(item => item.id !== id)); void refreshStatus(); }} />
            : <div className="detail-empty">{t('选择一条投递查看时间线', 'Pick an application to see its timeline')}</div>}
        </div>
      </div>
    </section>
  );
}
