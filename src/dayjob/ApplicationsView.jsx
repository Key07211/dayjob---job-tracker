import { useEffect, useMemo, useState } from 'react';
import { BellRing, BriefcaseBusiness, ExternalLink, Ghost, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api.js';
import { EVENT_LABELS, FLAG_LABELS, OPEN_STATUSES, SITE_LABELS, SOURCE_LABELS, STATUS_LABELS, dateInputToIso, daysSince, formatDay, formatTime, localDateInput, relativeDay } from './format.js';

const TABS = [
  { id: 'open', label: '进行中', match: item => OPEN_STATUSES.includes(item.status) },
  { id: 'attention', label: '需要处理', match: item => OPEN_STATUSES.includes(item.status) && item.flags.length > 0 },
  { id: 'closed', label: '已结束', match: item => !OPEN_STATUSES.includes(item.status) },
  { id: 'all', label: '全部', match: () => true },
];
const FUNNEL = ['applied', 'oa', 'interview', 'offer'];
// Reaching a later stage implies the earlier ones. A closed application counts
// at the stage it closed from, which the list does not know, so only as applied.
const REACHED = { applied: 0, oa: 1, interview: 2, offer: 3, accepted: 3 };

function Funnel({ items }) {
  const reached = FUNNEL.map((_, index) => items.filter(item => (REACHED[item.status] ?? 0) >= index).length);
  const total = items.length;
  return (
    <div className="funnel">
      {FUNNEL.map((status, index) => (
        <div key={status} className="funnel-step">
          <span>{STATUS_LABELS[status]}</span>
          <strong>{index === 0 ? total : reached[index]}</strong>
          {index > 0 && total ? <small>{Math.round((reached[index] / total) * 100)}%</small> : <small>全部投递</small>}
        </div>
      ))}
      <div className="funnel-step muted"><span>未通过 / 无回音</span><strong>{items.filter(item => ['rejected', 'ghosted'].includes(item.status)).length}</strong><small>&nbsp;</small></div>
    </div>
  );
}

function NewApplication({ onCreated, onCancel }) {
  const [form, setForm] = useState({ company: '', title: '', jobUrl: '', day: localDateInput(), note: '' });
  const [error, setError] = useState('');
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  async function submit(event) {
    event.preventDefault();
    try {
      const created = await api('/api/applications', { method: 'POST', body: { company: form.company, title: form.title, jobUrl: form.jobUrl || undefined,
        appliedAt: form.day === localDateInput() ? undefined : dateInputToIso(form.day), note: form.note } });
      onCreated(created);
    } catch (failure) { setError(failure.message); }
  }
  return (
    <form className="panel-form" onSubmit={submit}>
      <div className="form-head"><h3>手动添加投递</h3><button type="button" className="icon-button" onClick={onCancel} title="关闭"><X size={16} /></button></div>
      <p className="hint">用于内推或在其他地方投递、Dayjob 没有抓到的岗位。</p>
      <div className="form-grid">
        <label>公司<input value={form.company} onChange={set('company')} required maxLength={160} /></label>
        <label>职位<input value={form.title} onChange={set('title')} required maxLength={240} /></label>
        <label>链接（可选）<input type="url" value={form.jobUrl} onChange={set('jobUrl')} placeholder="https://" /></label>
        <label>投递日期<input type="date" value={form.day} max={localDateInput()} onChange={set('day')} required /></label>
      </div>
      <label>备注<input value={form.note} onChange={set('note')} maxLength={2000} /></label>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions"><button className="button primary" type="submit"><Plus size={15} />添加</button></div>
    </form>
  );
}

function ApplicationDetail({ id, onChanged, onDeleted }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [statusDay, setStatusDay] = useState(localDateInput());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

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

  async function patch(body) {
    setBusy(true);
    setError('');
    try {
      const updated = await api(`/api/applications/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      setItem(updated);
      onChanged(updated);
      return updated;
    } catch (failure) { setError(failure.message); return null; } finally { setBusy(false); }
  }
  const changeStatus = status => {
    if (status === item.status) return;
    void patch({ status, note: note.trim(), ...(statusDay !== localDateInput() ? { statusAt: dateInputToIso(statusDay) } : {}) }).then(updated => { if (updated) setNote(''); });
  };
  async function remove() {
    if (!window.confirm(`删除对 ${item.company} 的投递记录？时间线也会一起删除。`)) return;
    try {
      await api(`/api/applications/${encodeURIComponent(id)}`, { method: 'DELETE' });
      onDeleted(id);
    } catch (failure) { setError(failure.message); }
  }

  if (!item) return <div className="detail-empty">{error || <LoaderCircle className="spin" />}</div>;
  const quiet = daysSince(item.statusChangedAt);
  return (
    <article className="application-detail">
      <header>
        <h2>{item.title}</h2>
        <p className="detail-company"><span>{item.company}</span>{item.location ? <span>{item.location}</span> : null}{item.site ? <span>{SITE_LABELS[item.site]}</span> : null}</p>
        <p className="hint">投递于 {formatDay(item.appliedAt)}（{relativeDay(item.appliedAt)}）· 当前状态已持续 {quiet} 天{item.score !== undefined && item.score !== null ? ` · 匹配度 ${item.score}` : ''}</p>
        {item.jobUrl ? <a className="button" href={item.jobUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />打开岗位页面</a> : null}
      </header>
      {item.flags.includes('follow-up-due') ? (
        <div className="banner attention"><BellRing size={16} /><span>该跟进了：可以给招聘方发一封简短的跟进邮件。</span>
          <button className="button small" onClick={() => patch({ nextFollowUpAt: new Date(Date.now() + 7 * 864e5).toISOString(), note: '已跟进' })}>已跟进，7 天后再提醒</button></div>
      ) : null}
      {item.flags.includes('ghost-suspected') ? (
        <div className="banner ghost"><Ghost size={16} /><span>{quiet} 天没有回音。</span>
          <button className="button small" onClick={() => changeStatus('ghosted')}>标记为无回音</button>
          <button className="button small" onClick={() => patch({ nextFollowUpAt: new Date(Date.now() + 7 * 864e5).toISOString() })}>继续等待</button></div>
      ) : null}
      {item.postingClosedAt ? <p className="banner closed">招聘页面在 {formatDay(item.postingClosedAt)} 下线，申请仍会继续追踪。</p> : null}
      <section className="status-editor">
        <h3>更新状态</h3>
        <div className="status-buttons">
          {Object.entries(STATUS_LABELS).map(([status, label]) => (
            <button key={status} className={`status-chip ${status}${item.status === status ? ' active' : ''}`} onClick={() => changeStatus(status)} disabled={busy}>{label}</button>
          ))}
        </div>
        <div className="form-grid">
          <label>发生日期<input type="date" value={statusDay} max={localDateInput()} onChange={event => setStatusDay(event.target.value)} /></label>
          <label className="grow">备注（随状态一起记录）<input value={note} maxLength={2000} placeholder="例如：收到 HackerRank 邀请" onChange={event => setNote(event.target.value)} /></label>
        </div>
        <div className="form-actions">
          <button className="button" disabled={!note.trim() || busy} onClick={() => patch({ note: note.trim() }).then(updated => { if (updated) setNote(''); })}>只添加备注</button>
        </div>
      </section>
      <section className="follow-up">
        <label>下次跟进
          <input type="date" value={item.nextFollowUpAt ? localDateInput(item.nextFollowUpAt) : ''}
            onChange={event => patch({ nextFollowUpAt: event.target.value ? dateInputToIso(event.target.value) : null })} />
        </label>
        <label className="grow">联系人<input defaultValue={item.contact} key={`contact-${item.id}`} maxLength={500} placeholder="招聘人员姓名或邮箱"
          onBlur={event => { if (event.target.value !== item.contact) void patch({ contact: event.target.value }); }} /></label>
      </section>
      <label className="notes">笔记
        <textarea value={notes} rows={4} maxLength={20000} onChange={event => setNotes(event.target.value)}
          onBlur={() => { if (notes !== item.notes) void patch({ notes }); }} placeholder="面试题、联系人、薪资沟通……" />
      </label>
      {error ? <p className="notice error">{error}</p> : null}
      <section className="timeline">
        <h3>时间线</h3>
        <ol>
          {item.events.map(event => (
            <li key={event.id} className={event.type}>
              <time>{formatTime(event.at)}</time>
              <div>
                <strong>{event.type === 'status' ? (event.fromStatus ? `${STATUS_LABELS[event.fromStatus]} → ${STATUS_LABELS[event.toStatus]}` : STATUS_LABELS[event.toStatus]) : EVENT_LABELS[event.type] || event.type}</strong>
                {event.note ? <p>{event.note}</p> : null}
              </div>
              <span className={`source ${event.source}`}>{SOURCE_LABELS[event.source]}</span>
            </li>
          ))}
        </ol>
      </section>
      <button className="button danger" onClick={remove}><Trash2 size={15} />删除这条投递</button>
    </article>
  );
}

export function ApplicationsView({ dataVersion, refreshStatus }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('open');
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api('/api/applications').then(value => { setItems(value); setError(''); }).catch(failure => setError(failure.message));
  }, [dataVersion]);

  const visible = useMemo(() => (items || []).filter(TABS.find(entry => entry.id === tab).match), [items, tab]);
  useEffect(() => {
    if (!visible.some(item => item.id === selected)) setSelected(visible[0]?.id || null);
  }, [visible, selected]);

  function changed(updated) {
    setItems(current => current.map(item => (item.id === updated.id ? { ...item, ...updated } : item)));
    void refreshStatus();
  }

  if (!items) return <section className="applications"><div className="list-empty">{error || <LoaderCircle className="spin" />}</div></section>;
  return (
    <section className="applications">
      <header className="view-header">
        <div><h1>投递追踪</h1><p>点“我已投递”后自动加入。Dayjob 会检查岗位是否关闭、提醒跟进、发现长时间无回复。</p></div>
        <div className="header-actions"><button className="button" onClick={() => setAdding(value => !value)}><Plus size={15} />手动添加</button></div>
      </header>
      {items.length ? <Funnel items={items} /> : null}
      {adding ? <NewApplication onCancel={() => setAdding(false)} onCreated={created => { setItems(current => [created, ...current]); setAdding(false); setTab('open'); setSelected(created.id); void refreshStatus(); }} /> : null}
      <div className="tabs">
        {TABS.map(entry => {
          const count = items.filter(entry.match).length;
          return <button key={entry.id} className={tab === entry.id ? 'active' : ''} onClick={() => setTab(entry.id)}>{entry.label}<em>{count}</em></button>;
        })}
      </div>
      <div className="split">
        <div className="posting-list">
          {!visible.length ? (
            <div className="list-empty"><BriefcaseBusiness size={28} /><p>{items.length ? '这一栏是空的。' : '还没有投递记录。在岗位详情里点“我已投递”，或手动添加。'}</p></div>
          ) : null}
          {visible.map(item => (
            <button key={item.id} className={`posting-row application-row${selected === item.id ? ' selected' : ''}`} onClick={() => setSelected(item.id)}>
              <div className="row-main">
                <strong>{item.company}</strong>
                <span className="row-company">{item.title}</span>
                <span className="row-meta">
                  <span>投递 {daysSince(item.appliedAt)} 天</span>
                  {item.status !== 'applied' ? <span>{relativeDay(item.statusChangedAt)}更新</span> : null}
                  {item.nextFollowUpAt && OPEN_STATUSES.includes(item.status) ? <span>跟进 {formatDay(item.nextFollowUpAt)}</span> : null}
                  {item.flags.map(flag => <span key={flag} className={`tag-flag ${flag}`}>{FLAG_LABELS[flag] || flag}</span>)}
                  {item.postingClosedAt ? <span className="tag-closed">岗位已下线</span> : null}
                </span>
              </div>
              <span className={`status-pill ${item.status}`}>{STATUS_LABELS[item.status]}</span>
            </button>
          ))}
        </div>
        <div className="detail-pane">
          {selected ? <ApplicationDetail id={selected} onChanged={changed}
            onDeleted={id => { setItems(current => current.filter(item => item.id !== id)); void refreshStatus(); }} />
            : <div className="detail-empty">选择一条投递查看时间线</div>}
        </div>
      </div>
    </section>
  );
}
