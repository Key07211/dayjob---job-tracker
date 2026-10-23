import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Bot, ExternalLink, Globe, LoaderCircle, Plus, RotateCw, ShieldAlert, Square, X } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';

const desktop = typeof window !== 'undefined' ? window.dayjobDesktop?.browser : undefined;
export const hasBrowser = Boolean(desktop);

const START = [
  { name: 'LinkedIn Jobs', url: 'https://www.linkedin.com/jobs/' },
  { name: 'Indeed', url: 'https://www.indeed.com/' },
  { name: 'Glassdoor', url: 'https://www.glassdoor.com/Job/' },
  { name: 'Handshake', url: 'https://app.joinhandshake.com/' },
];
const JOB_TYPES = { FULL_TIME: 'fulltime', PART_TIME: 'parttime', INTERN: 'internship', INTERNSHIP: 'internship', CONTRACTOR: 'contract', CONTRACT: 'contract', TEMPORARY: 'temporary' };

// An address, a bare domain, or words to search for.
export function addressUrl(value) {
  const text = value.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };

// Opens a job page in the Dayjob browser when the desktop app has one.
export function openInBrowser(url, setView) {
  if (!desktop) { window.open(url, '_blank', 'noopener'); return; }
  desktop.open(url).catch(() => window.open(url, '_blank', 'noopener'));
  setView('browser');
}

export function useBrowserState(setView) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!desktop) return undefined;
    let live = true;
    desktop.getState().then(value => { if (live) setState(value); }).catch(() => {});
    const stopState = desktop.onState(value => setState(value));
    // Claude opened or is using a page: show it.
    const stopReveal = desktop.onReveal(() => setView('browser'));
    return () => { live = false; stopState(); stopReveal(); };
  }, [setView]);
  return state;
}

function Approval({ approval }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const answer = allowed => { setBusy(true); desktop.answer(approval.id, allowed).catch(() => {}); };
  const site = approval.site || t('这个网站', 'this site');
  return (
    <div className="browser-approval" role="alertdialog" aria-live="assertive">
      <ShieldAlert size={18} />
      <p>
        <strong>{t('Claude 想先征得你同意', 'Claude is asking first')}</strong>
        {approval.action === 'enter'
          ? t(`在 ${site} 的“${approval.name}”里按回车，这可能会提交表单。`, `Press Enter in “${approval.name}” on ${site}. This may submit the form.`)
          : t(`在 ${site} 上点击“${approval.name}”，这可能会提交或发送内容。`, `Click “${approval.name}” on ${site}. This may submit or send something.`)}
        <span>{t('允许前可以先看一下页面上填写的内容。', 'You can check what is filled in on the page first.')}</span>
      </p>
      <div className="form-actions">
        <button className="button" onClick={() => answer(false)} disabled={busy}>{t('拒绝', 'Deny')}</button>
        <button className="button primary" onClick={() => answer(true)} disabled={busy}>{t('允许', 'Allow')}</button>
      </div>
    </div>
  );
}

function SaveForm({ draft, onCancel, onSaved }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ title: draft.title || '', company: draft.company || '', location: draft.location || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const jobType = draft.employmentType.map(item => JOB_TYPES[String(item).toUpperCase()]).find(Boolean);
      const day = /^\d{4}-\d\d-\d\d/.exec(draft.datePosted || '')?.[0];
      const saved = await api('/api/postings', { method: 'POST', body: {
        title: form.title, company: form.company, location: form.location || undefined, jobUrl: draft.url,
        description: draft.description || undefined, datePosted: day || undefined, jobType, isRemote: draft.remote || undefined, status: 'saved',
      } });
      onSaved(saved);
    } catch (failure) { setError(failure.message); setBusy(false); }
  }
  return (
    <form className="browser-save" onSubmit={save}>
      <label>{t('职位', 'Title')}<input value={form.title} maxLength={240} required onChange={event => set('title', event.target.value)} /></label>
      <label>{t('公司', 'Company')}<input value={form.company} maxLength={160} required onChange={event => set('company', event.target.value)} /></label>
      <label>{t('地点', 'Location')}<input value={form.location} maxLength={160} onChange={event => set('location', event.target.value)} /></label>
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>{t('取消', 'Cancel')}</button>
        <button type="submit" className="button primary" disabled={busy}><Bookmark size={15} />{t('收藏到 Dayjob', 'Save to Dayjob')}</button>
      </div>
      <p className="hint">{draft.structured
        ? t(`已从网页读取岗位信息和 ${draft.description.length} 字的职位描述，保存后可以 AI 打分和追踪。`, `Read the job details and a ${draft.description.length}-character description from the page. Once saved, Dayjob can score and track it.`)
        : t('这个网页没有标准的岗位数据，请确认职位和公司；职位描述取自网页正文。', 'This page has no standard job data, so check the title and company. The description is taken from the page text.')}</p>
      {error ? <p className="notice error">{error}</p> : null}
    </form>
  );
}

export function BrowserView({ state, covered, setView }) {
  const { t } = useI18n();
  const frame = useRef(null);
  const address = useRef(null);
  const [typed, setTyped] = useState(null);
  const [draft, setDraft] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState('');
  const active = state?.tabs.find(tab => tab.id === state.activeId) || null;
  const shownUrl = active && active.url !== 'about:blank' ? active.url : '';

  // The page is a native view that Dayjob places over this box.
  const last = useRef('');
  const sync = useRef(() => {});
  sync.current = () => {
    const node = frame.current;
    if (!node || !desktop) return;
    const rect = node.getBoundingClientRect();
    const next = covered || !active || rect.width < 40 || rect.height < 40 ? null
      : { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    const key = JSON.stringify(next);
    if (key === last.current) return;
    last.current = key;
    desktop.setBounds(next).catch(() => {});
  };
  useLayoutEffect(() => sync.current());
  useEffect(() => {
    const update = () => sync.current();
    const observer = new ResizeObserver(update);
    if (frame.current) observer.observe(frame.current);
    window.addEventListener('resize', update);
    const stopFocus = desktop?.onFocusAddress(() => address.current?.select());
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      stopFocus?.();
      last.current = '';
      desktop?.setBounds(null).catch(() => {});
    };
  }, []);
  useEffect(() => { setDraft(null); setMessage(null); }, [active?.id, active?.url]);

  const command = (name, id) => desktop.command(name, id).catch(failure => setError(failure.message));
  function go(event) {
    event.preventDefault();
    const url = addressUrl(typed ?? shownUrl);
    if (!url) return;
    setTyped(null);
    address.current?.blur();
    desktop.go(url).catch(() => setError(t('这个地址打不开。', 'That address cannot be opened.')));
  }
  async function startSave() {
    setError('');
    setMessage(null);
    try { setDraft(await desktop.extract()); } catch { setError(t('没能读取这个网页，等它加载完再试一次。', 'Could not read this page. Try again once it has loaded.')); }
  }

  if (!state) return <div className="browser-page"><div className="detail-empty"><LoaderCircle className="spin" /></div></div>;
  return (
    <section className="browser-page">
      <div className="browser-tabs">
        {state.tabs.map(tab => (
          <div key={tab.id} className={`browser-tab${tab.id === state.activeId ? ' active' : ''}`} title={tab.url}>
            <button className="browser-tab-main" onClick={() => command('switch', tab.id)}>
              {tab.loading ? <LoaderCircle size={13} className="spin" /> : tab.favicon ? <img src={tab.favicon} alt="" referrerPolicy="no-referrer" /> : <Globe size={13} />}
              <span>{tab.title || hostOf(tab.url) || t('新标签页', 'New tab')}</span>
            </button>
            <button className="browser-tab-close" title={t('关闭标签页', 'Close tab')} onClick={() => command('close', tab.id)}><X size={12} /></button>
          </div>
        ))}
        <button className="icon-button" title={t('新标签页', 'New tab')} onClick={() => command('new')}><Plus size={15} /></button>
        <div className="browser-agent">
          {state.agentBusy ? <span className="agent-pill"><Bot size={14} />{t('Claude 正在操作', 'Claude is working')}</span> : null}
          <label className="check" title={t('关闭后 Claude 不能打开或操作这个浏览器', 'When off, Claude cannot open or use this browser')}>
            <input type="checkbox" checked={state.agentControl} onChange={event => desktop.setAgentControl(event.target.checked)} />
            {t('允许 Claude 使用', 'Let Claude use it')}
          </label>
        </div>
      </div>
      <form className="browser-bar" onSubmit={go}>
        <button type="button" className="icon-button" title={t('后退', 'Back')} disabled={!active?.canGoBack} onClick={() => command('back')}><ArrowLeft size={16} /></button>
        <button type="button" className="icon-button" title={t('前进', 'Forward')} disabled={!active?.canGoForward} onClick={() => command('forward')}><ArrowRight size={16} /></button>
        {active?.loading
          ? <button type="button" className="icon-button" title={t('停止', 'Stop')} onClick={() => command('stop')}><Square size={13} /></button>
          : <button type="button" className="icon-button" title={t('刷新', 'Reload')} disabled={!active} onClick={() => command('reload')}><RotateCw size={15} /></button>}
        <input ref={address} className="browser-address" value={typed ?? shownUrl} spellCheck={false} placeholder={t('输入网址或搜索', 'Enter an address or search')}
          onChange={event => setTyped(event.target.value)} onBlur={() => setTyped(null)} onFocus={event => event.target.select()} />
        <button type="button" className="button small" onClick={startSave} disabled={!shownUrl}><Bookmark size={14} />{t('加入 Dayjob', 'Add to Dayjob')}</button>
        <button type="button" className="icon-button" title={t('用系统浏览器打开', 'Open in your browser')} disabled={!shownUrl} onClick={() => command('external')}><ExternalLink size={15} /></button>
      </form>
      {state.approval ? <Approval key={state.approval.id} approval={state.approval} /> : null}
      {draft ? <SaveForm draft={draft} onCancel={() => setDraft(null)} onSaved={saved => { setDraft(null); setMessage(saved); }} /> : null}
      {message ? (
        <p className="notice browser-notice">{t(`已收藏“${message.title}”。`, `Saved “${message.title}”.`)}
          <button className="link" onClick={() => setView('saved')}>{t('查看', 'View')}</button>
          <button className="link" onClick={() => setMessage(null)}>{t('关闭', 'Dismiss')}</button></p>
      ) : null}
      {error ? <p className="notice error browser-notice" onClick={() => setError('')}>{error}</p> : null}
      <div className="browser-frame" ref={frame}>
        {!active ? (
          <div className="browser-start">
            <Globe size={30} />
            <h2>{t('Dayjob 浏览器', 'Dayjob browser')}</h2>
            <p className="hint">{t('在这里登录 LinkedIn、Indeed 或公司招聘网站，登录状态只保存在这台电脑上。看到合适的岗位，点“加入 Dayjob”就能收藏、打分和追踪。',
              'Sign in to LinkedIn, Indeed or company career sites here; the sign-ins stay on this computer. When you find a good job, click “Add to Dayjob” to save, score and track it.')}</p>
            <p className="hint">{t('连接 Claude 后，Claude 也能在这里打开和阅读网页、帮你填写申请表。需要提交或发送时，会先在这里请你确认；密码和文件上传始终由你自己来。',
              'With Claude connected, Claude can open and read pages here and help fill in applications. Before anything is submitted or sent, it asks you here first; passwords and file uploads are always left to you.')}</p>
            <div className="browser-links">{START.map(link => <button key={link.url} className="button" onClick={() => desktop.open(link.url)}>{link.name}</button>)}</div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
