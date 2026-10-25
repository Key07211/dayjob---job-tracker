import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Building2, Check, CheckCircle2, CircleStop, LoaderCircle, Pencil, Play, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '../api.js';
import { formatTime, label, labels, relativeDay } from './format.js';
import { useI18n } from '../i18n.jsx';
import { serverText } from './server-text.js';
import { BEAT, cue, playLift, playNeedle } from './groove/sound.js';
import { E8, flyTo, leave, leaveThen } from './groove/fx.js';
import { Eq } from './groove/Fx.jsx';
import { ViewDate } from './ViewDate.jsx';
import { ListenWave } from './groove/ListenWave.jsx';

// A search or company that was just added drops in like a new track on a mixing desk, its level meter jumping for a moment.
function useArrived() {
  const [arrived, setArrived] = useState(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const mark = id => {
    setArrived(id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setArrived(null), BEAT * 2);
  };
  return [arrived, mark];
}

const POSTED = [{ value: 24, label: ['24 小时内', 'Past 24 hours'] }, { value: 72, label: ['3 天内', 'Past 3 days'] }, { value: 168, label: ['7 天内', 'Past week'] },
  { value: 336, label: ['14 天内', 'Past 2 weeks'] }, { value: '', label: ['不限', 'Any time'] }];
const COUNTRY_LABELS = { usa: '美国', canada: '加拿大', uk: '英国', australia: '澳大利亚', singapore: '新加坡', 'hong kong': '香港', china: '中国大陆',
  taiwan: '台湾', japan: '日本', 'south korea': '韩国', india: '印度', germany: '德国', france: '法国', netherlands: '荷兰', ireland: '爱尔兰',
  switzerland: '瑞士', spain: '西班牙', italy: '意大利', sweden: '瑞典', 'new zealand': '新西兰' };
const COUNTRY_NAMES = { usa: 'United States', uk: 'United Kingdom' };
const countryName = (country, lang) => (lang === 'en' ? COUNTRY_NAMES[country] || country.replace(/\b\w/g, letter => letter.toUpperCase()) : COUNTRY_LABELS[country] || country);
const lastTime = value => { const date = new Date(value); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
const RUN_STATUS = { succeeded: ['成功', 'Succeeded'], partial: ['部分成功', 'Partly succeeded'], failed: ['失败', 'Failed'], running: ['进行中', 'Running'], cancelled: ['已停止', 'Stopped'] };
const EMPTY = { name: '', keywords: '', location: '', sites: ['linkedin', 'indeed'], hoursOld: 72, jobType: '', isRemote: false, resultsWanted: 25,
  country: 'usa', titleInclude: '', excludeKeywords: '', enabled: true };

// initial without an id is a draft (a suggestion) that is saved as a new search.
function SearchForm({ initial, sites, countries, onSaved, onCancel }) {
  const { t, lang } = useI18n();
  const existing = Boolean(initial?.id);
  const [form, setForm] = useState(() => initial ? { ...initial, jobType: initial.jobType || '', hoursOld: initial.hoursOld ?? '',
    titleInclude: initial.titleInclude.join(', '), excludeKeywords: initial.excludeKeywords.join(', ') } : EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const own = useRef(null);
  const close = () => leave(own.current, 'up', onCancel);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const toggleSite = site => set('sites', form.sites.includes(site) ? form.sites.filter(item => item !== site) : [...form.sites, site]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const body = { name: form.name || form.keywords, keywords: form.keywords, location: form.location, sites: form.sites,
      hoursOld: form.hoursOld === '' ? null : Number(form.hoursOld), jobType: form.jobType || null, isRemote: form.isRemote,
      resultsWanted: Number(form.resultsWanted), country: form.country, titleInclude: form.titleInclude, excludeKeywords: form.excludeKeywords, enabled: form.enabled };
    try {
      const saved = await api(existing ? `/api/searches/${encodeURIComponent(initial.id)}` : '/api/searches', { method: existing ? 'PATCH' : 'POST', body });
      onSaved(saved);
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return (
    <form className="panel-form" ref={own} onSubmit={submit}>
      <div className="form-head"><h3>{existing ? t('编辑搜索', 'Edit search') : t('新建搜索', 'New search')}</h3><button type="button" className="icon-button" title={t('关闭', 'Close')} onClick={close}><X size={16} /></button></div>
      <div className="form-grid">
        <label>{t('关键词', 'Keywords')}<input value={form.keywords} onChange={event => set('keywords', event.target.value)} required maxLength={200}
          placeholder="Data Scientist, Machine Learning Engineer" /><small>{t('用逗号分隔表示“任一”。', 'Separate with commas to match any of them.')}</small></label>
        <label>{t('地点', 'Location')}<input value={form.location} onChange={event => set('location', event.target.value)} maxLength={120} placeholder="San Francisco Bay Area" /></label>
        <label>{t('名称（可选）', 'Name (optional)')}<input value={form.name} onChange={event => set('name', event.target.value)} maxLength={80} placeholder={t('默认用关键词', 'Defaults to the keywords')} /></label>
        <label>{t('发布时间', 'Posted')}
          <select value={form.hoursOld} onChange={event => set('hoursOld', event.target.value)}>
            {POSTED.map(option => <option key={option.value} value={option.value}>{t(...option.label)}</option>)}
          </select>
        </label>
        <label>{t('工作类型', 'Job type')}
          <select value={form.jobType} onChange={event => set('jobType', event.target.value)}>
            <option value="">{t('不限', 'Any')}</option>
            {Object.entries(labels('jobType')).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
        </label>
        <label>{t('每个网站最多', 'Results per site')}
          <input type="number" min={1} max={200} value={form.resultsWanted} onChange={event => set('resultsWanted', event.target.value)} />
          <small>{t('LinkedIn 每个岗位要多请求一次，数量越大越慢。', 'LinkedIn needs one extra request per job, so more results take longer.')}</small>
        </label>
        <label>{t('Indeed 国家/地区', 'Indeed country')}
          <select value={form.country} onChange={event => set('country', event.target.value)}>
            {countries.map(country => <option key={country} value={country}>{countryName(country, lang)}</option>)}
          </select>
        </label>
        <label className="check-line"><input type="checkbox" checked={form.isRemote} onChange={event => set('isRemote', event.target.checked)} />{t('只要远程', 'Remote only')}</label>
      </div>
      <fieldset className="site-picker">
        <legend>{t('网站', 'Sites')}</legend>
        {sites.map(site => (
          <label key={site.id} className={site.available ? '' : 'unavailable'} title={serverText(site.detail || '')}>
            <input type="checkbox" checked={form.sites.includes(site.id)} onChange={() => toggleSite(site.id)} />
            {site.label}{site.engine === 'jobspy' ? <small>{site.available ? t('通过 JobSpy', 'via JobSpy') : t('需要 JobSpy', 'needs JobSpy')}</small> : null}
          </label>
        ))}
      </fieldset>
      <div className="form-grid">
        <label>{t('标题必须包含（可选）', 'Title must include (optional)')}<input value={form.titleInclude} onChange={event => set('titleInclude', event.target.value)} placeholder={t('例如：New Grad, Junior', 'e.g. New Grad, Junior')} /></label>
        <label>{t('排除词（可选）', 'Exclude words (optional)')}<input value={form.excludeKeywords} onChange={event => set('excludeKeywords', event.target.value)} placeholder={t('例如：Senior, Staff, Principal', 'e.g. Senior, Staff, Principal')} /></label>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" onClick={close}>{t('取消', 'Cancel')}</button>
        <button type="submit" className="button primary" disabled={busy || !form.sites.length}>{t('保存', 'Save')}</button>
      </div>
    </form>
  );
}

const sameSearch = (a, b) => a.keywords.trim().toLowerCase() === b.keywords.trim().toLowerCase() && (a.location || '').trim().toLowerCase() === (b.location || '').trim().toLowerCase();
const sameBoard = (a, b) => a.ats === b.ats && a.slug.toLowerCase() === b.slug.toLowerCase();
// Suggestions start on the built-in boards, posted in the past 3 days.
const draftSearch = (item, sites) => ({ name: item.name, keywords: item.keywords, location: item.location, country: item.country, isRemote: item.isRemote,
  jobType: item.jobType, titleInclude: item.titleInclude, excludeKeywords: item.excludeKeywords, hoursOld: 72, resultsWanted: 25, enabled: true,
  sites: sites.filter(site => site.engine === 'native' && site.available).map(site => site.id).filter(id => ['linkedin', 'indeed'].includes(id)) });

function Suggestions({ boot, reload, onEdit, setView, onAdded }) {
  const { t } = useI18n();
  const [state, setState] = useState({ result: null, running: false });
  const [preference, setPreference] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [adding, setAdding] = useState('');
  // The suggestion just added or followed: its ✓ turns in from the ＋.
  const [just, setJust] = useState('');
  const result = state.result;

  useEffect(() => {
    let cancelled = false;
    api('/api/recommendations').then(value => {
      if (cancelled) return;
      setState(value);
      if (value.result?.preference) setPreference(value.result.preference);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Started elsewhere (another window, or before this page opened): wait for it.
  useEffect(() => {
    if (!state.running || state.mine) return undefined;
    const timer = setInterval(() => api('/api/recommendations').then(value => { if (!value.running) setState(value); }).catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [state.running, state.mine]);

  async function ask(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    setState(current => ({ ...current, running: true, mine: true }));
    try { setState(await api('/api/recommendations', { method: 'POST', body: { preference } })); cue('triplet'); }
    catch (failure) { setError(serverText(failure.message)); setState(current => ({ ...current, running: false, mine: false })); }
  }
  async function addSearch(item, key, card) {
    setAdding(key);
    setError('');
    try {
      const saved = await api('/api/searches', { method: 'POST', body: draftSearch(item, boot.sites) });
      // The card flies into Saved searches, where the new search drops in.
      flyTo(card, document.querySelector('.saved-searches h2'), 'page');
      cue('note');
      setJust(key);
      await reload();
      onAdded(saved.id);
      setMessage(t(`已添加搜索“${item.name}”，会在下次每日抓取时运行。`, `Added “${item.name}”; it runs with the next daily search.`));
    } catch (failure) { setError(serverText(failure.message)); } finally { setAdding(''); }
  }
  async function follow(item, key) {
    setAdding(key);
    setError('');
    try {
      const company = await api('/api/companies', { method: 'POST', body: { ats: item.ats, slug: item.slug, name: item.name } });
      cue('success');
      setJust(key);
      await reload();
      setMessage(company.listed !== null && company.listed !== undefined
        ? t(`已关注 ${company.name}，目前有 ${company.listed} 个公开岗位。`, `Following ${company.name}: ${company.listed} open ${company.listed === 1 ? 'job' : 'jobs'} right now.`)
        : t(`已关注 ${company.name}。`, `Following ${company.name}.`));
    } catch (failure) { setError(serverText(failure.message)); } finally { setAdding(''); }
  }
  // Closed suggestions stay saved and can be opened again.
  // Closing folds the panel up into its one-line "show again"; opening deals the cards out again.
  const close = event => leave(event.currentTarget.closest('.suggestion-result'), 'up', () => setHidden(true));
  async function setHidden(hidden) {
    setError('');
    setMessage('');
    setState(current => ({ ...current, result: { ...current.result, hidden } }));
    try { setState(await api('/api/recommendations', { method: 'PATCH', body: { hidden } })); }
    catch (failure) { setError(serverText(failure.message)); setState(current => ({ ...current, result: { ...current.result, hidden: !hidden } })); }
  }
  const resumeName = id => boot.resumes.find(resume => resume.id === id)?.name;

  return (
    <section className="card-section suggestions">
      <h2><Sparkles size={18} />{t('AI 按简历推荐', 'Suggestions from your resumes')}</h2>
      <p className="hint">{t('AI 读你的简历，推荐每天要抓的搜索和值得关注的公司；公司招聘页会先检查确实存在。推荐不会自动加入，点“添加”或“关注”的才会。使用“简历与 AI”里选的 AI 和模型（本机 Claude Code 或 Codex 会用你的额度）。',
        'The AI reads your resumes and suggests daily searches and companies worth following; Dayjob checks that each company board exists. Nothing is added until you click Add or Follow. Uses the AI and model chosen under Resume & AI (Claude Code or Codex on this computer uses your allowance).')}</p>
      {!boot.resumes.length ? (
        <p className="notice">{t('先上传简历，AI 才能推荐。', 'Upload a resume first so the AI has something to read.')}<button className="link" onClick={() => setView('resume')}>{t('上传简历', 'Upload a resume')}</button></p>
      ) : (
        <form className="inline-form" onSubmit={ask}>
          <input value={preference} onChange={event => setPreference(event.target.value)} maxLength={500}
            placeholder={t('补充偏好（可选），例如：只看湾区和远程、需要 H-1B 担保、New Grad', 'Preferences (optional), e.g. Bay Area or remote only, needs H-1B sponsorship, new grad')} />
          <button className="button primary" type="submit" data-fx="sparkle" disabled={state.running}>
            {state.running ? <Eq /> : <Sparkles size={15} />}{result ? t('重新推荐', 'Suggest again') : t('让 AI 推荐', 'Ask the AI')}
          </button>
        </form>
      )}
      {state.running ? <p className="notice"><LoaderCircle size={14} className="spin" />{t('AI 正在读简历，Dayjob 在检查公司招聘页，大约需要一分钟…', 'The AI is reading your resumes and Dayjob is checking the company boards. This takes about a minute…')}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}
      {result?.hidden && !state.running ? (
        <p className="hint suggestion-closed">
          {t(`${formatTime(result.createdAt)} 的推荐已关闭。`, `The suggestions from ${formatTime(result.createdAt)} are closed.`)}
          <button type="button" className="link" onClick={() => setHidden(false)}>{t('重新打开', 'Show them again')}</button>
        </p>
      ) : null}
      {result && !result.hidden && !state.running ? (
        <div className="suggestion-result">
          <div className="suggestion-bar">
            <strong>{t('推荐结果', 'Suggestions')}</strong>
            <button type="button" className="icon-button" title={t('关闭推荐', 'Close the suggestions')} aria-label={t('关闭推荐', 'Close the suggestions')} onClick={close}><X size={16} /></button>
          </div>
          {result.summary ? <p className="suggestion-summary">{result.summary}</p> : null}
          {result.searches.length ? (
            <>
              <h3>{t('推荐的搜索', 'Suggested searches')}</h3>
              <ul className="search-list">
                {result.searches.map((item, index) => {
                  const key = `search-${index}`;
                  const added = boot.searches.some(search => sameSearch(search, item));
                  return (
                    <li key={key} className="dealt" style={{ animationDelay: `${index * E8}ms` }}>
                      <div className="search-main">
                        <strong>{item.name}</strong>
                        <span>{item.keywords}{item.location ? ` · ${item.location}` : ''}{item.isRemote ? t(' · 远程', ' · remote') : ''}</span>
                        <span className="chips">
                          {item.jobType ? <em>{label('jobType', item.jobType)}</em> : null}
                          {item.titleInclude.length ? <em>{t(`标题含 ${item.titleInclude.join('、')}`, `Title has ${item.titleInclude.join(', ')}`)}</em> : null}
                          {item.excludeKeywords.length ? <em>{t(`排除 ${item.excludeKeywords.join('、')}`, `Excludes ${item.excludeKeywords.join(', ')}`)}</em> : null}
                          {resumeName(item.resumeId) ? <em>{t(`适合：${resumeName(item.resumeId)}`, `Fits ${resumeName(item.resumeId)}`)}</em> : null}
                        </span>
                        {item.reason ? <small>{item.reason}</small> : null}
                      </div>
                      <div className="search-actions">
                        {added ? <span className={`added-tag${just === key ? ' just' : ''}`}><Check size={14} />{t('已添加', 'Added')}</span> : (
                          <>
                            <button className="icon-button" data-fx="wiggle" title={t('编辑后添加', 'Edit, then add')} onClick={() => onEdit(draftSearch(item, boot.sites))}><Pencil size={15} /></button>
                            <button className="button small" onClick={event => addSearch(item, key, event.currentTarget.closest('li'))} disabled={Boolean(adding)}>{adding === key ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}{t('添加', 'Add')}</button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          {result.companies.length ? (
            <>
              <h3>{t('推荐关注的公司', 'Suggested companies')}</h3>
              <ul className="company-list">
                {result.companies.map((item, index) => {
                  const key = `company-${index}`;
                  const following = boot.companies.some(company => sameBoard(company, item));
                  return (
                    <li key={key} className="dealt" style={{ animationDelay: `${(result.searches.length + index) * E8}ms` }}>
                      <div className="search-main">
                        <strong>{item.name}</strong>
                        <span>{label('site', item.ats)} · {item.slug}{item.openJobs !== null && item.openJobs !== undefined ? t(` · 目前 ${item.openJobs} 个公开岗位`, ` · ${item.openJobs} open ${item.openJobs === 1 ? 'job' : 'jobs'}`) : ''}</span>
                        {item.reason ? <small>{item.reason}</small> : null}
                      </div>
                      {following ? <span className={`added-tag${just === key ? ' just' : ''}`}><Check size={14} />{t('已关注', 'Following')}</span>
                        : <button className="button small" onClick={() => follow(item, key)} disabled={Boolean(adding)}>{adding === key ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}{t('关注', 'Follow')}</button>}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          <div className="suggestion-foot">
            <p className="hint">
              {t(`${formatTime(result.createdAt)} 推荐`, `Suggested ${formatTime(result.createdAt)}`)}
              {result.dropped ? t(`；另有 ${result.dropped} 家公司的招聘页不存在，已去掉`, `; ${result.dropped} more ${result.dropped === 1 ? 'company was' : 'companies were'} dropped because their board does not exist`) : ''}
              {t('。', '.')}
            </p>
            <button type="button" className="button small" onClick={close}><X size={14} />{t('选好了，关闭推荐', 'Done, close the suggestions')}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Companies({ companies, onChange }) {
  const { t } = useI18n();
  const [arrived, markArrived] = useArrived();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function add(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const company = await api('/api/companies', { method: 'POST', body: { url, name: name || undefined } });
      setMessage(company.listed !== null && company.listed !== undefined
        ? t(`已关注 ${company.name}，目前有 ${company.listed} 个公开岗位。`, `Following ${company.name}: ${company.listed} open ${company.listed === 1 ? 'job' : 'jobs'} right now.`)
        : t(`已关注 ${company.name}。`, `Following ${company.name}.`));
      setUrl('');
      setName('');
      cue('success');
      await onChange();
      markArrived(company.id);
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function toggle(company) {
    try { await api(`/api/companies/${company.id}`, { method: 'PATCH', body: { enabled: !company.enabled } }); onChange(); }
    catch (failure) { setError(failure.message); }
  }
  async function remove(company, row) {
    if (!window.confirm(t(`不再关注 ${company.name}？已抓到的岗位会保留。`, `Stop following ${company.name}? Jobs already found are kept.`))) return;
    // The chip shrinks away first and comes back if the request fails.
    leaveThen(row, 'shrink', async () => {
      try { await api(`/api/companies/${company.id}`, { method: 'DELETE' }); await onChange(); return true; }
      catch (failure) { setError(failure.message); return false; }
    });
  }
  return (
    <section className="card-section">
      <h2><Building2 size={18} />{t('关注的公司', 'Followed companies')}</h2>
      <p className="hint">{t('直接读取公司自己的招聘系统（Greenhouse、Lever、Ashby 的官方公开接口），最稳定，也能准确知道岗位何时下线。每天保留和上面搜索的关键词、地点匹配的所有开放岗位，不受发布时间限制。',
        'Reads the company\'s own hiring system (the official public Greenhouse, Lever and Ashby feeds): the most reliable source, and it knows exactly when a job closes. Every day Dayjob keeps all open jobs that match your searches\' keywords and location, however long ago they were posted.')}</p>
      <form className="inline-form" onSubmit={add}>
        <input value={url} onChange={event => setUrl(event.target.value)} required placeholder={t('招聘页链接，例如 https://jobs.lever.co/acme 或 https://job-boards.greenhouse.io/acme', 'Careers link, e.g. https://jobs.lever.co/acme or https://job-boards.greenhouse.io/acme')} />
        <input value={name} onChange={event => setName(event.target.value)} placeholder={t('公司名（可选）', 'Company name (optional)')} className="narrow" />
        <button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{t('关注', 'Follow')}</button>
      </form>
      {error ? <p className="notice error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}
      {companies.length ? (
        <ul className="company-list">
          {companies.map(company => (
            <li key={company.id} className={`${company.enabled ? '' : 'disabled'}${arrived === company.id ? ' dropped' : ''}`}>
              <strong>{company.name}</strong><span>{label('site', company.ats)} · {company.slug}</span>
              <label className="switch"><input type="checkbox" checked={company.enabled} onChange={() => toggle(company)} />{company.enabled ? t('启用', 'On') : t('暂停', 'Paused')}</label>
              <button className="icon-button" title={t('取消关注', 'Unfollow')} onClick={event => remove(company, event.currentTarget.closest('li'))}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Runs({ runs }) {
  const { t } = useI18n();
  if (!runs?.length) return null;
  return (
    <section className="card-section">
      <h2>{t('最近的抓取', 'Recent searches')}</h2>
      <ul className="run-list">
        {runs.map(run => (
          <li key={run.id}>
            <div className="run-head">
              <span className={`run-status ${run.cancelled ? 'cancelled' : run.status}`}>{run.cancelled ? <CircleStop size={14} /> : run.status === 'failed' ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}{t(...(RUN_STATUS[run.cancelled ? 'cancelled' : run.status] || [run.status, run.status]))}</span>
              <span>{formatTime(run.startedAt)}{run.trigger === 'schedule' ? t(' · 每日自动', ' · daily') : t(' · 手动', ' · manual')}</span>
              <span>{t(`${run.found} 个岗位 · ${run.newCount} 个新 · ${run.scored} 个已打分`, `${run.found} jobs · ${run.newCount} new · ${run.scored} scored`)}</span>
            </div>
            {run.detail?.length ? (
              <ul className="run-detail">
                {run.detail.map((entry, index) => (
                  <li key={index} className={entry.error ? 'error' : entry.warning ? 'warning' : ''}>
                    <span>{entry.source}</span>
                    {entry.error ? <em>{serverText(entry.error)}{entry.blocked && !/limit|限流/i.test(serverText(entry.error)) ? t('（网站在限流，稍后会再试）', ' (the site is rate limiting; Dayjob tries again later)') : ''}</em>
                      : entry.warning ? <em>{serverText(entry.warning)}</em>
                        : <em>{t(`${entry.found} 个`, `${entry.found} found`)}{entry.new ? t(`，${entry.new} 个新`, `, ${entry.new} new`) : ''}{entry.closed ? t(`，${entry.closed} 个已下线`, `, ${entry.closed} closed`) : ''}
                          {entry.warnings?.length ? t(`（${entry.warnings.map(serverText).join('；')}）`, ` (${entry.warnings.join('; ')})`) : ''}</em>}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SearchesView({ boot, reload, status, setView, refreshStatus }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [runs, setRuns] = useState(boot.runs);
  const [arrived, markArrived] = useArrived();
  // The search started from its own ▶, which turns into a spinning record until the run ends.
  const [playing, setPlaying] = useState(null);
  const started = useRef(0);
  const running = status?.scheduler?.running;
  useEffect(() => { if (!running) setPlaying(null); }, [running]);

  useEffect(() => {
    api('/api/runs?limit=10').then(setRuns).catch(() => {});
  }, [running]);

  async function runSearch(search) {
    setError('');
    setMessage('');
    try {
      setPlaying(search.id);
      started.current = Date.now();
      playNeedle();
      await api('/api/runs', { method: 'POST', body: { searchIds: [search.id] } });
      setMessage(t(`已开始抓取“${search.name}”。`, `Started “${search.name}”.`));
    } catch (failure) { setPlaying(null); setError(failure.message); }
  }
  // Its spinning record, clicked again, stops it (not within a second of starting: that is a double click).
  async function stopSearch(search) {
    if (Date.now() - started.current < 1000) return;
    setError('');
    playLift();
    try {
      const result = await api('/api/runs/cancel', { method: 'POST', body: {} });
      setMessage(result.run ? t(`已停止“${search.name}”，留下 ${result.run.newCount} 个新岗位。`, `Stopped “${search.name}”; kept ${result.run.newCount} new ${result.run.newCount === 1 ? 'job' : 'jobs'}.`) : '');
      await refreshStatus();
    } catch (failure) { setError(failure.message); }
  }
  async function toggle(search) {
    try { await api(`/api/searches/${search.id}`, { method: 'PATCH', body: { enabled: !search.enabled } }); await reload(); }
    catch (failure) { setError(failure.message); }
  }
  // The card folds up and away, and the ones below move up; it comes back if the delete fails.
  async function remove(search, row) {
    if (!window.confirm(t(`删除搜索“${search.name}”？已抓到的岗位会保留。`, `Delete the search “${search.name}”? Jobs already found are kept.`))) return;
    leaveThen(row, 'up', async () => {
      try { await api(`/api/searches/${search.id}`, { method: 'DELETE' }); await reload(); return true; }
      catch (failure) { setError(failure.message); return false; }
    });
  }

  return (
    <section className="settings-page searches-page">
      <header className="view-header">
        <ListenWave />
        <div className="title-block"><ViewDate /><h1>{t('搜索与公司', 'Searches & companies')}</h1></div>
        <div className="header-actions"><button className="button primary" onClick={() => (editing === 'new' ? leave(document.querySelector('.searches-page > .panel-form'), 'up', () => setEditing(null)) : setEditing('new'))}><Plus size={15} />{t('新建搜索', 'New search')}</button></div>
      </header>
      {editing ? (
        <SearchForm initial={editing === 'new' ? null : editing} sites={boot.sites} countries={boot.countries}
          onCancel={() => setEditing(null)} onSaved={async saved => { setEditing(null); cue('note'); await reload(); markArrived(saved.id); }} />
      ) : null}
      {error ? <p className="notice error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}
      {/* Searches on the left and companies on the right once the page is wide. */}
      <div className="searches-columns">
        <div className="searches-column">
          <Suggestions boot={boot} reload={reload} setView={setView} onAdded={markArrived} onEdit={draft => { setEditing(draft); for (const node of [document.querySelector('.main-view'), window]) node?.scrollTo?.({ top: 0, behavior: 'smooth' }); }} />
          <section className="card-section saved-searches">
            <h2>{t('保存的搜索', 'Saved searches')}</h2>
            {!boot.searches.length ? <p className="hint">{t('还没有搜索。新建一个，例如关键词“Data Scientist, Data Analyst”、地点“New York, NY”、发布时间 3 天内。',
              'No searches yet. Create one, for example keywords “Data Scientist, Data Analyst”, location “New York, NY”, posted in the past 3 days.')}</p> : null}
            <ul className="search-list">
              {boot.searches.map(search => (
                <li key={search.id} className={`${search.enabled ? '' : 'disabled'}${arrived === search.id ? ' dropped' : ''}`}>
                  <div className="search-main">
                    <strong>{search.name}{arrived === search.id ? <Eq /> : null}</strong>
                    <span>{search.keywords}{search.location ? ` · ${search.location}` : ''}{search.isRemote ? t(' · 远程', ' · remote') : ''}</span>
                    <span className="chips">
                      {search.sites.map(site => <em key={site}>{label('site', site)}</em>)}
                      {search.hoursOld ? <em>{t(...(POSTED.find(option => option.value === search.hoursOld)?.label || [`${search.hoursOld} 小时内`, `Past ${search.hoursOld} hours`]))}</em> : null}
                      {search.jobType ? <em>{label('jobType', search.jobType)}</em> : null}
                      {search.excludeKeywords.length ? <em>{t(`排除 ${search.excludeKeywords.join('、')}`, `Excludes ${search.excludeKeywords.join(', ')}`)}</em> : null}
                    </span>
                    <small key={search.lastRunAt || 'never'} className={search.lastRunAt ? 'fx-roll' : undefined}>{search.lastRunAt ? t(`上次运行 ${relativeDay(search.lastRunAt)} ${lastTime(search.lastRunAt)}`, `Last run ${relativeDay(search.lastRunAt)} at ${lastTime(search.lastRunAt)}`) : t('还没有运行过', 'Not run yet')}</small>
                  </div>
                  <div className="search-actions">
                    <label className="switch"><input type="checkbox" checked={search.enabled} onChange={() => toggle(search)} />{search.enabled ? t('每日', 'Daily') : t('暂停', 'Paused')}</label>
                    <button className={`icon-button${playing === search.id ? ' playing' : ''}`} title={playing === search.id && running ? t('停止', 'Stop') : t('立即运行', 'Run now')}
                      onClick={() => (playing === search.id && running ? stopSearch(search) : runSearch(search))} disabled={running && playing !== search.id}>
                      {playing === search.id ? <span className="mini-disc" aria-hidden="true" /> : <Play size={15} />}</button>
                    <button className="icon-button" data-fx="wiggle" title={t('编辑', 'Edit')} onClick={() => setEditing(search)}><Pencil size={15} /></button>
                    <button className="icon-button" title={t('删除', 'Delete')} onClick={event => remove(search, event.currentTarget.closest('li'))}><Trash2 size={15} /></button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <div className="searches-column">
          <Companies companies={boot.companies} onChange={reload} />
          <Runs runs={runs} />
        </div>
      </div>
    </section>
  );
}
