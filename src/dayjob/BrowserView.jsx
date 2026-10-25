import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Bot, BriefcaseBusiness, ChevronsLeft, ChevronsRight, CircleCheck, ExternalLink, FileUp, Globe, LoaderCircle, Maximize2,
  Minimize2, Plus, RotateCw, ShieldAlert, Square, WandSparkles, X } from 'lucide-react';
import { api } from '../api.js';
import { formatDay } from './format.js';
import { useI18n } from '../i18n.jsx';
import { emit } from './groove/bus.js';
import { cue, reducedMotion } from './groove/sound.js';
import { Q, flyTo, holdToConfirm, leave, shake } from './groove/fx.js';
import { NoteLoader } from './groove/BrandNote.jsx';

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

// Opens a job page in the Dayjob browser (beside the current view) when the
// desktop app has one.
export function openInBrowser(url, setView) {
  if (!desktop) { window.open(url, '_blank', 'noopener'); return; }
  desktop.open(url).catch(() => window.open(url, '_blank', 'noopener'));
  setView('browser');
}
const read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional */ } };
// The desktop bridge's errors read "Error invoking remote method '…': Error: <message>".
const bridgeMessage = failure => String(failure?.message || '').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

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
  const bar = useRef(null);
  // Allowed: a ✓ pops and the bar folds away. Denied: the bar shakes a little first.
  const answer = allowed => {
    setBusy(true);
    const send = () => desktop.answer(approval.id, allowed).catch(() => {});
    if (allowed) { cue('success'); leave(bar.current, 'up', send); return; }
    shake(bar.current);
    setTimeout(() => leave(bar.current, 'up', send), reducedMotion() ? 0 : Q * 2.4);
  };
  const site = approval.site || t('这个网站', 'this site');
  return (
    <div className="browser-approval" ref={bar} role="alertdialog" aria-live="assertive">
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
        <button className="button primary" data-fx="pop" onClick={() => answer(true)} disabled={busy}><CircleCheck size={15} />{t('允许', 'Allow')}</button>
      </div>
    </div>
  );
}

function SaveForm({ draft, apply, onCancel, onSaved }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ title: draft.title || '', company: draft.company || '', location: draft.location || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const own = useRef(null);
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
      const application = apply ? await api(`/api/postings/${saved.id}/apply`, { method: 'POST', body: {} }) : null;
      if (application) emit('apply', { postingId: saved.id });
      // The page shrinks to a card and flies into the sidebar key it now belongs to.
      flyTo(own.current.querySelector('[type="submit"]'), application ? 'applications' : 'saved', 'page');
      cue('fav');
      onSaved(saved, application);
    } catch (failure) { setError(failure.message); setBusy(false); }
  }
  return (
    <form className="browser-save" ref={own} onSubmit={save}>
      <label>{t('职位', 'Title')}<input value={form.title} maxLength={240} required onChange={event => set('title', event.target.value)} /></label>
      <label>{t('公司', 'Company')}<input value={form.company} maxLength={160} required onChange={event => set('company', event.target.value)} /></label>
      <label>{t('地点', 'Location')}<input value={form.location} maxLength={160} onChange={event => set('location', event.target.value)} /></label>
      <p className="hint">{draft.structured
        ? t(`已从网页读取岗位信息和 ${draft.description.length} 字的职位描述，保存后可以 AI 打分和追踪。`, `Read the job details and a ${draft.description.length}-character description from the page. Once saved, Dayjob can score and track it.`)
        : t('这个网页没有标准的岗位数据，请确认职位和公司；职位描述取自网页正文。', 'This page has no standard job data, so check the title and company. The description is taken from the page text.')}</p>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button small" onClick={() => leave(own.current, 'up', onCancel)}>{t('取消', 'Cancel')}</button>
        <button type="submit" className="button small primary" disabled={busy}>
          {apply ? <><CircleCheck size={14} />{t('保存并标记已投递', 'Save and mark applied')}</> : <><Bookmark size={14} />{t('收藏到 Dayjob', 'Save to Dayjob')}</>}
        </button>
      </div>
    </form>
  );
}

const STATUS = { new: ['新岗位', 'New'], saved: ['已收藏', 'Saved'], dismissed: ['已忽略', 'Dismissed'], applied: ['已投递', 'Applied'] };
const APPLICATION = { applied: ['已投递', 'Applied'], oa: ['测评', 'Assessment'], interview: ['面试', 'Interview'], offer: ['Offer', 'Offer'], accepted: ['已接受', 'Accepted'],
  rejected: ['被拒', 'Rejected'], withdrawn: ['已撤回', 'Withdrawn'], ghosted: ['无回音', 'Ghosted'] };

// The side panel: what Dayjob knows about this page, 自动填写 and 自动提交,
// and whether Claude may use the browser.
function Assistant({ state, active, boot, dataVersion, openItem, collapsed, onCollapse }) {
  const { t } = useI18n();
  const url = active && /^https?:/i.test(active.url) ? active.url : '';
  const [lookup, setLookup] = useState(null);
  const [lookupKey, setLookupKey] = useState(0);
  const [draft, setDraft] = useState(null);
  const [filling, setFilling] = useState(false);
  const [fill, setFill] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  // With auto-submit on, the button must be held for 0.6 s; letting go early cancels.
  const hold = useRef(() => {});
  const profile = boot.settings.applicant || {};
  const profileEmpty = !['firstName', 'lastName', 'email', 'phone'].some(key => String(profile[key] || '').trim());

  // A submitted form moves to its thank-you page; its result stays until the user browses on.
  useEffect(() => {
    setDraft(null);
    setError('');
    setFill(current => (current?.urls.includes(url) ? current : null));
  }, [active?.id, url]);
  useEffect(() => {
    if (!url) { setLookup(null); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      api(`/api/postings/lookup?url=${encodeURIComponent(url)}`).then(value => { if (live) setLookup({ url, posting: value.posting }); }).catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [url, lookupKey, dataVersion]);
  const posting = lookup?.url === url ? lookup.posting : undefined;

  async function startSave(apply) {
    setError('');
    try { setDraft({ ...(await desktop.extract()), apply }); } catch { setError(t('没能读取这个网页，等它加载完再试一次。', 'Could not read this page. Try again once it has loaded.')); }
  }
  async function apply(target) {
    const application = await api(`/api/postings/${target.id}/apply`, { method: 'POST', body: {} });
    emit('apply', { postingId: target.id });
    setLookupKey(key => key + 1);
    return application;
  }
  async function markApplied() {
    setError('');
    if (!posting) { await startSave(true); return; }
    try { await apply(posting); } catch (failure) { setError(failure.message); }
  }
  // After an automatic submit the page is the thank-you page, so the job is
  // the one the form belonged to.
  async function markSubmitted() {
    setError('');
    const { posting: target, draft: captured } = fill.from;
    try {
      if (target) {
        const application = await apply(target);
        setFill(current => current && { ...current, marked: application });
      } else if (captured) setDraft({ ...captured, apply: true });
      else await startSave(true);
    } catch (failure) { setError(failure.message); }
  }
  async function autofill() {
    setError('');
    setFill(null);
    setFilling(true);
    try {
      const from = { posting, draft: null };
      if (state.autoSubmit && !posting) from.draft = await desktop.extract().catch(() => null);
      const result = await desktop.autofill({ submit: state.autoSubmit });
      setFill({ ...result, from, urls: [url, result.page?.url] });
      if (result.filled.length) cue('type');
    }
    catch (failure) {
      const message = bridgeMessage(failure);
      setError(/no form/i.test(message) ? t('这个页面上没有可以填写的表单。先打开申请表（通常要先点“Apply”）。', 'There is no form on this page to fill in. Open the application form first (often behind an “Apply” button).')
        : /profile/i.test(message) ? t('申请资料还是空的，先去填一下。', 'Your application profile is empty; fill it in first.')
          : t('没能填写这个页面，等它加载完再试一次。', 'Could not fill in this page. Try again once it has loaded.'));
    } finally { setFilling(false); }
  }
  function setAutoSubmit(value) {
    setConfirming(false);
    desktop.setAutoSubmit(value).catch(() => {});
  }
  const startHold = event => {
    if (event.type === 'keydown' && (event.repeat || (event.key !== 'Enter' && event.key !== ' '))) return;
    if (event.type === 'keydown') event.preventDefault();
    hold.current();
    hold.current = holdToConfirm(event.currentTarget, () => { hold.current = () => {}; void autofill(); });
  };
  const stopHold = () => { hold.current(); hold.current = () => {}; };
  const holdProps = state.autoSubmit ? { onPointerDown: startHold, onPointerUp: stopHold, onPointerLeave: stopHold, onKeyDown: startHold, onKeyUp: stopHold, onClick: undefined } : { onClick: autofill };
  const viewPosting = () => {
    if (posting.application) openItem('applications', posting.application.id);
    else openItem(posting.status === 'saved' ? 'saved' : 'feed', posting.id);
  };

  if (collapsed) {
    return (
      <aside className="browser-assist collapsed" aria-label={t('浏览器助手', 'Browser assistant')}>
        <button className="icon-button" title={t('展开侧栏', 'Show the side panel')} onClick={() => onCollapse(false)}><ChevronsLeft size={16} /></button>
        <button className="icon-button" title={state.autoSubmit ? t('自动填写并提交', 'Autofill and submit') : t('自动填写', 'Autofill')} disabled={!url || filling || profileEmpty}
          onClick={() => { onCollapse(false); if (!state.autoSubmit) void autofill(); }}><WandSparkles size={16} /></button>
        <button className="icon-button" title={t('加入 Dayjob', 'Add to Dayjob')} disabled={!url || Boolean(posting)} onClick={() => { onCollapse(false); void startSave(false); }}><Bookmark size={16} /></button>
        {state.autoSubmit ? <span className="assist-dot" title={t('自动提交已开启', 'Auto-submit is on')} /> : null}
        {state.agentBusy ? <Bot size={16} className="assist-busy" aria-label={t('Claude 正在操作', 'Claude is working')} /> : null}
      </aside>
    );
  }
  return (
    <aside className="browser-assist" aria-label={t('浏览器助手', 'Browser assistant')}>
      <div className="assist-head">
        <strong>{t('助手', 'Assistant')}</strong>
        <button className="icon-button" title={t('收起侧栏', 'Hide the side panel')} onClick={() => onCollapse(true)}><ChevronsRight size={16} /></button>
      </div>

      <section className="assist-section">
        <h3>{t('这个页面', 'This page')}</h3>
        {!url ? <p className="hint">{t('打开一个岗位页面后，这里会显示它在 Dayjob 里的状态。', 'Open a job page to see where it stands in Dayjob.')}</p>
          : posting === undefined ? <p className="hint"><LoaderCircle size={13} className="spin" /></p>
            : posting ? (
              <div className="assist-posting">
                <strong>{posting.title}</strong>
                <span>{posting.company}{posting.score !== null ? ` · ${t(`${posting.score} 分`, `score ${posting.score}`)}` : ''}</span>
                <span className="chip">{posting.application
                  ? `${t(...APPLICATION[posting.application.status])} · ${formatDay(posting.application.appliedAt)}`
                  : t(...(STATUS[posting.status] || STATUS.new))}</span>
                <button className="link" onClick={viewPosting}>{posting.application ? t('查看投递', 'View the application') : t('在 Dayjob 里查看', 'View in Dayjob')}</button>
              </div>
            ) : <p className="hint">{t('还没加入 Dayjob。', 'Not in Dayjob yet.')}</p>}
        {url && !draft ? (
          <div className="assist-actions">
            {!posting ? <button className="button small" onClick={() => startSave(false)} disabled={posting === undefined}><Bookmark size={14} />{t('加入 Dayjob', 'Add to Dayjob')}</button> : null}
            {!posting?.application ? <button className="button small" onClick={markApplied} disabled={posting === undefined}><BriefcaseBusiness size={14} />{t('标记已投递', 'Mark applied')}</button> : null}
          </div>
        ) : null}
        {draft ? <SaveForm draft={draft} apply={draft.apply} onCancel={() => setDraft(null)} onSaved={(_saved, application) => {
          setDraft(null);
          setLookupKey(key => key + 1);
          if (application) setFill(current => current && { ...current, marked: application });
        }} /> : null}
      </section>

      <section className="assist-section">
        <h3>{t('申请表', 'Application form')}</h3>
        <button className="button primary block" data-fx={state.autoSubmit ? undefined : 'sparkle'} {...holdProps} disabled={!url || filling || profileEmpty}>
          {filling ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}
          {state.autoSubmit ? t('按住：自动填写并提交', 'Hold: autofill and submit') : t('自动填写', 'Autofill')}
        </button>
        {profileEmpty ? <p className="hint">{t('先填好申请资料（姓名、邮箱、电话等），自动填写才知道填什么。', 'Fill in your application profile (name, email, phone…) so autofill knows what to put in.')}</p> : null}
        {fill ? (
          <div className="assist-result">
            <p><CircleCheck size={14} />{fill.filled.length ? t(`已填写 ${fill.filled.length} 项`, `Filled ${fill.filled.length} ${fill.filled.length === 1 ? 'field' : 'fields'}`) : t('没有能自动填的空格了', 'Nothing left that autofill can fill')}</p>
            {fill.filled.length ? <details><summary>{t('看看填了哪些', 'Show which')}</summary><ul>{fill.filled.map((item, index) => <li key={index} style={{ '--i': Math.min(index, 12) }}>{item.label}</li>)}</ul></details> : null}
            {fill.left.length ? (
              <>
                <p className="warn">{t('还需要你来填：', 'Still yours to fill in:')}</p>
                <ul>{fill.left.map((item, index) => <li key={index}>{item.kind === 'file' ? <FileUp size={12} /> : null}{item.label || t('（没有名字的必填项）', '(an unnamed required field)')}</li>)}</ul>
              </>
            ) : null}
            {fill.optionalLeft ? <small>{t(`另有 ${fill.optionalLeft} 个选填项空着。`, `${fill.optionalLeft} optional ${fill.optionalLeft === 1 ? 'field is' : 'fields are'} still empty.`)}</small> : null}
            {state.autoSubmit && !fill.submitted && fill.left.length ? <small>{t('还有必填项空着，所以没有自动提交。', 'Required fields are still empty, so it was not submitted.')}</small> : null}
            {fill.noButton ? <small>{t('没找到提交按钮，请自己点提交。', 'No submit button was found; submit it yourself.')}</small> : null}
            {fill.submitted ? (
              <p className={fill.confirmed ? 'ok' : 'warn'}>{fill.confirmed ? t('已提交，页面显示申请已收到。', 'Submitted. The page says the application was received.')
                : t(`已点击“${fill.button}”。看一眼页面，确认提交成功。`, `Clicked “${fill.button}”. Check the page to make sure it went through.`)}</p>
            ) : null}
            {fill.submitted && !fill.marked && !fill.from.posting?.application
              ? <button className="button small primary" onClick={markSubmitted}><BriefcaseBusiness size={14} />{t('标记已投递', 'Mark applied')}</button> : null}
            {fill.marked ? <p className="ok">{t('已加入投递追踪。', 'Added to Applications.')}
              <button className="link" onClick={() => openItem('applications', fill.marked.id)}>{t('查看', 'View')}</button></p> : null}
          </div>
        ) : null}
        <label className="check assist-switch">
          <input type="checkbox" checked={state.autoSubmit} onChange={event => (event.target.checked ? setConfirming(true) : setAutoSubmit(false))} />
          {t('自动提交', 'Auto-submit')}
        </label>
        {confirming ? (
          <div className="assist-confirm" role="alertdialog">
            <p>{t('开启后，自动填写会在必填项都填好时直接点提交；Claude 点提交时也不再先问你。每次打开 Dayjob 都会恢复为关闭。',
              'When on, autofill clicks submit as soon as every required field is filled, and Claude no longer asks before submitting. It turns off again every time Dayjob opens.')}</p>
            <div className="form-actions">
              <button className="button small" onClick={event => leave(event.currentTarget.closest('.assist-confirm'), 'up', () => setConfirming(false))}>{t('取消', 'Cancel')}</button>
              <button className="button small primary" onClick={() => setAutoSubmit(true)}>{t('开启', 'Turn on')}</button>
            </div>
          </div>
        ) : <small>{state.autoSubmit ? t('已开启：填好就提交，Claude 提交时也不再询问。', 'On: forms are submitted once filled, and Claude no longer asks first.')
          : t('关闭时，提交前总会先让你确认。', 'While off, you always confirm before anything is submitted.')}</small>}
        <button className="link" onClick={() => openItem('resume', 'applicant')}>{t('编辑申请资料', 'Edit the application profile')}</button>
      </section>

      <section className="assist-section">
        <h3>Claude</h3>
        {state.agentBusy ? <span className="agent-pill"><Bot size={14} />{t('Claude 正在操作', 'Claude is working')}</span> : null}
        <label className="check assist-switch" title={t('关闭后 Claude 不能打开或操作这个浏览器', 'When off, Claude cannot open or use this browser')}>
          <input type="checkbox" checked={state.agentControl} onChange={event => desktop.setAgentControl(event.target.checked)} />
          {t('允许 Claude 使用', 'Let Claude use it')}
        </label>
        <small>{t('Claude 可以打开网页、读取内容、帮你填写；密码和文件上传始终由你来。', 'Claude can open and read pages and help fill them in; passwords and file uploads are always yours.')}</small>
      </section>

      {error ? <p className="notice error" onClick={() => setError('')}>{error}</p> : null}
      <button className="button small assist-external" data-fx="external" disabled={!url} onClick={() => desktop.command('external')}><ExternalLink size={14} />{t('用系统浏览器打开', 'Open in your browser')}</button>
    </aside>
  );
}

export function BrowserView({ state, covered, boot, dataVersion, openItem, wide, canSide, onWide, onClose }) {
  const { t } = useI18n();
  const frame = useRef(null);
  const address = useRef(null);
  const [typed, setTyped] = useState(null);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(() => read('dayjob-browser-assist', 'open') === 'collapsed');
  // The browser slides in from the right and out to the right; the page itself is a native view, so it waits until the slide is done.
  const [arriving, setArriving] = useState(() => !reducedMotion());
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (!arriving) return undefined;
    const timer = setTimeout(() => setArriving(false), Q * 1.5);
    return () => clearTimeout(timer);
  }, [arriving]);
  // Tabs opened after the browser appeared slide out of the ＋.
  const seenTabs = useRef(null);
  if (state && !seenTabs.current) seenTabs.current = new Set(state.tabs.map(tab => tab.id));
  useEffect(() => {
    const fresh = (state?.tabs || []).map(tab => tab.id).filter(id => !seenTabs.current?.has(id));
    if (!fresh.length) return undefined;
    const timer = setTimeout(() => fresh.forEach(id => seenTabs.current.add(id)), Q * 2);
    return () => clearTimeout(timer);
  });
  const active = state?.tabs.find(tab => tab.id === state.activeId) || null;
  const shownUrl = active && active.url !== 'about:blank' ? active.url : '';

  // The page is a native view that Dayjob places over this box.
  const last = useRef('');
  const sync = useRef(() => {});
  sync.current = () => {
    const node = frame.current;
    if (!node || !desktop) return;
    const rect = node.getBoundingClientRect();
    const next = covered || arriving || closing || !active || rect.width < 40 || rect.height < 40 ? null
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

  const command = (name, id) => desktop.command(name, id).catch(failure => setError(bridgeMessage(failure)));
  function go(event) {
    event.preventDefault();
    const url = addressUrl(typed ?? shownUrl);
    if (!url) return;
    setTyped(null);
    address.current?.blur();
    desktop.go(url).catch(() => setError(t('这个地址打不开。', 'That address cannot be opened.')));
  }
  const close = event => {
    const page = event.currentTarget.closest('.browser-page');
    setClosing(true);
    leave(page, 'right', onClose);
  };
  function collapse(value) {
    setCollapsed(value);
    keep('dayjob-browser-assist', value ? 'collapsed' : 'open');
  }

  if (!state) return <div className="browser-page"><div className="detail-empty"><NoteLoader /></div></div>;
  return (
    <section className={`browser-page${arriving ? ' arriving' : ''}`}>
      <div className="browser-tabs">
        <div className="browser-tab-list">
          {state.tabs.map(tab => (
            <div key={tab.id} className={`browser-tab${tab.id === state.activeId ? ' active' : ''}${seenTabs.current?.has(tab.id) ? '' : ' fresh'}`} title={tab.url}>
              <button className="browser-tab-main" onClick={() => command('switch', tab.id)}>
                {tab.loading ? <LoaderCircle size={13} className="spin" /> : tab.favicon ? <img src={tab.favicon} alt="" referrerPolicy="no-referrer" /> : <Globe size={13} />}
                <span>{tab.title || hostOf(tab.url) || t('新标签页', 'New tab')}</span>
              </button>
              <button className="browser-tab-close" title={t('关闭标签页', 'Close tab')} onClick={event => leave(event.currentTarget.closest('.browser-tab'), 'narrow', () => command('close', tab.id))}><X size={12} /></button>
            </div>
          ))}
          <button className="icon-button" data-fx="pop" title={t('新标签页', 'New tab')} onClick={() => command('new')}><Plus size={15} /></button>
        </div>
        <div className="browser-window">
          {state.agentBusy ? <span className="agent-pill" title={t('Claude 正在操作', 'Claude is working')}><Bot size={14} /></span> : null}
          {canSide ? <button className="icon-button" data-fx="pop" title={wide ? t('和当前页面并排显示', 'Show beside the current page') : t('铺满窗口', 'Fill the window')} onClick={() => onWide(!wide)}>
            {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button> : null}
          <button className="icon-button" title={t('收起浏览器（标签页会保留）', 'Hide the browser (tabs stay open)')} onClick={close}><X size={16} /></button>
        </div>
      </div>
      <form className="browser-bar" onSubmit={go}>
        <button type="button" className="icon-button" data-fx="back" title={t('后退', 'Back')} disabled={!active?.canGoBack} onClick={() => command('back')}><ArrowLeft size={16} /></button>
        <button type="button" className="icon-button" data-fx="forward" title={t('前进', 'Forward')} disabled={!active?.canGoForward} onClick={() => command('forward')}><ArrowRight size={16} /></button>
        {active?.loading
          ? <button type="button" className="icon-button" data-fx="stop" title={t('停止', 'Stop')} onClick={() => command('stop')}><Square size={13} /></button>
          : <button type="button" className="icon-button" data-fx="refresh" title={t('刷新', 'Reload')} disabled={!active} onClick={() => command('reload')}><RotateCw size={15} /></button>}
        <input ref={address} className="browser-address" value={typed ?? shownUrl} spellCheck={false} placeholder={t('输入网址或搜索', 'Enter an address or search')}
          onChange={event => setTyped(event.target.value)} onBlur={() => setTyped(null)} onFocus={event => event.target.select()} />
      </form>
      {state.approval ? <Approval key={state.approval.id} approval={state.approval} /> : null}
      {error ? <p className="notice error browser-notice" onClick={() => setError('')}>{error}</p> : null}
      <div className="browser-body">
        <div className="browser-frame" ref={frame}>
          {!active ? (
            <div className="browser-start">
              <Globe size={30} />
              <h2>{t('Dayjob 浏览器', 'Dayjob browser')}</h2>
              <p className="hint">{t('在这里登录 LinkedIn、Indeed 或公司招聘网站，登录状态只保存在这台电脑上。看到合适的岗位，在右边点“加入 Dayjob”就能收藏、打分和追踪；打开申请表后点“自动填写”。',
                'Sign in to LinkedIn, Indeed or company career sites here; the sign-ins stay on this computer. When you find a good job, click “Add to Dayjob” on the right to save, score and track it; on an application form, click “Autofill”.')}</p>
              <p className="hint">{t('连接 Claude 后，Claude 也能在这里打开和阅读网页、帮你填写申请表。需要提交或发送时，会先在这里请你确认；密码和文件上传始终由你自己来。',
                'With Claude connected, Claude can open and read pages here and help fill in applications. Before anything is submitted or sent, it asks you here first; passwords and file uploads are always left to you.')}</p>
              <div className="browser-links">{START.map(link => <button key={link.url} className="button" data-fx="open" onClick={() => desktop.open(link.url)}>{link.name}</button>)}</div>
            </div>
          ) : null}
        </div>
        <Assistant state={state} active={active} boot={boot} dataVersion={dataVersion} openItem={openItem} collapsed={collapsed} onCollapse={collapse} />
      </div>
    </section>
  );
}
