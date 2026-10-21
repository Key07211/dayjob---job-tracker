import { useEffect, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, LoaderCircle, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api.js';
import { JOB_TYPE_LABELS, SITE_LABELS, formatTime, relativeDay } from './format.js';

const POSTED = [{ value: 24, label: '24 小时内' }, { value: 72, label: '3 天内' }, { value: 168, label: '7 天内' }, { value: 336, label: '14 天内' }, { value: '', label: '不限' }];
const COUNTRY_LABELS = { usa: '美国', canada: '加拿大', uk: '英国', australia: '澳大利亚', singapore: '新加坡', 'hong kong': '香港', china: '中国大陆',
  taiwan: '台湾', japan: '日本', 'south korea': '韩国', india: '印度', germany: '德国', france: '法国', netherlands: '荷兰', ireland: '爱尔兰',
  switzerland: '瑞士', spain: '西班牙', italy: '意大利', sweden: '瑞典', 'new zealand': '新西兰' };
const RUN_STATUS = { succeeded: '成功', partial: '部分成功', failed: '失败', running: '进行中' };
const EMPTY = { name: '', keywords: '', location: '', sites: ['linkedin', 'indeed'], hoursOld: 72, jobType: '', isRemote: false, resultsWanted: 25,
  country: 'usa', titleInclude: '', excludeKeywords: '', enabled: true };

function SearchForm({ initial, sites, countries, onSaved, onCancel }) {
  const [form, setForm] = useState(() => initial ? { ...initial, jobType: initial.jobType || '', hoursOld: initial.hoursOld ?? '',
    titleInclude: initial.titleInclude.join(', '), excludeKeywords: initial.excludeKeywords.join(', ') } : EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
      const saved = await api(initial ? `/api/searches/${encodeURIComponent(initial.id)}` : '/api/searches', { method: initial ? 'PATCH' : 'POST', body });
      onSaved(saved);
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return (
    <form className="panel-form" onSubmit={submit}>
      <div className="form-head"><h3>{initial ? '编辑搜索' : '新建搜索'}</h3><button type="button" className="icon-button" title="关闭" onClick={onCancel}><X size={16} /></button></div>
      <div className="form-grid">
        <label>关键词<input value={form.keywords} onChange={event => set('keywords', event.target.value)} required maxLength={200}
          placeholder="Data Scientist, Machine Learning Engineer" /><small>用逗号分隔表示“任一”。</small></label>
        <label>地点<input value={form.location} onChange={event => set('location', event.target.value)} maxLength={120} placeholder="San Francisco Bay Area" /></label>
        <label>名称（可选）<input value={form.name} onChange={event => set('name', event.target.value)} maxLength={80} placeholder="默认用关键词" /></label>
        <label>发布时间
          <select value={form.hoursOld} onChange={event => set('hoursOld', event.target.value)}>
            {POSTED.map(option => <option key={option.label} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>工作类型
          <select value={form.jobType} onChange={event => set('jobType', event.target.value)}>
            <option value="">不限</option>
            {Object.entries(JOB_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>每个网站最多
          <input type="number" min={1} max={200} value={form.resultsWanted} onChange={event => set('resultsWanted', event.target.value)} />
          <small>LinkedIn 每个岗位要多请求一次，数量越大越慢。</small>
        </label>
        <label>Indeed 国家/地区
          <select value={form.country} onChange={event => set('country', event.target.value)}>
            {countries.map(country => <option key={country} value={country}>{COUNTRY_LABELS[country] || country}</option>)}
          </select>
        </label>
        <label className="check-line"><input type="checkbox" checked={form.isRemote} onChange={event => set('isRemote', event.target.checked)} />只要远程</label>
      </div>
      <fieldset className="site-picker">
        <legend>网站</legend>
        {sites.map(site => (
          <label key={site.id} className={site.available ? '' : 'unavailable'} title={site.detail || ''}>
            <input type="checkbox" checked={form.sites.includes(site.id)} onChange={() => toggleSite(site.id)} />
            {site.label}{site.engine === 'jobspy' ? <small>{site.available ? '通过 JobSpy' : '需要 JobSpy'}</small> : null}
          </label>
        ))}
      </fieldset>
      <div className="form-grid">
        <label>标题必须包含（可选）<input value={form.titleInclude} onChange={event => set('titleInclude', event.target.value)} placeholder="例如：New Grad, Junior" /></label>
        <label>排除词（可选）<input value={form.excludeKeywords} onChange={event => set('excludeKeywords', event.target.value)} placeholder="例如：Senior, Staff, Principal" /></label>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>取消</button>
        <button type="submit" className="button primary" disabled={busy || !form.sites.length}>保存</button>
      </div>
    </form>
  );
}

function Companies({ companies, onChange }) {
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
      setMessage(company.listed !== null && company.listed !== undefined ? `已关注 ${company.name}，目前有 ${company.listed} 个公开岗位。` : `已关注 ${company.name}。`);
      setUrl('');
      setName('');
      onChange();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function toggle(company) {
    try { await api(`/api/companies/${company.id}`, { method: 'PATCH', body: { enabled: !company.enabled } }); onChange(); }
    catch (failure) { setError(failure.message); }
  }
  async function remove(company) {
    if (!window.confirm(`不再关注 ${company.name}？已抓到的岗位会保留。`)) return;
    try { await api(`/api/companies/${company.id}`, { method: 'DELETE' }); onChange(); }
    catch (failure) { setError(failure.message); }
  }
  return (
    <section className="card-section">
      <h2><Building2 size={18} />关注的公司</h2>
      <p className="hint">直接读取公司自己的招聘系统（Greenhouse、Lever、Ashby 的官方公开接口），最稳定，也能准确知道岗位何时下线。每天只保留和上面搜索匹配的岗位。</p>
      <form className="inline-form" onSubmit={add}>
        <input value={url} onChange={event => setUrl(event.target.value)} required placeholder="招聘页链接，例如 https://jobs.lever.co/acme 或 https://job-boards.greenhouse.io/acme" />
        <input value={name} onChange={event => setName(event.target.value)} placeholder="公司名（可选）" className="narrow" />
        <button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}关注</button>
      </form>
      {error ? <p className="notice error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}
      {companies.length ? (
        <ul className="company-list">
          {companies.map(company => (
            <li key={company.id} className={company.enabled ? '' : 'disabled'}>
              <strong>{company.name}</strong><span>{SITE_LABELS[company.ats]} · {company.slug}</span>
              <label className="switch"><input type="checkbox" checked={company.enabled} onChange={() => toggle(company)} />{company.enabled ? '启用' : '暂停'}</label>
              <button className="icon-button" title="取消关注" onClick={() => remove(company)}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Runs({ runs }) {
  if (!runs?.length) return null;
  return (
    <section className="card-section">
      <h2>最近的抓取</h2>
      <ul className="run-list">
        {runs.map(run => (
          <li key={run.id}>
            <div className="run-head">
              <span className={`run-status ${run.status}`}>{run.status === 'failed' ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}{RUN_STATUS[run.status]}</span>
              <span>{formatTime(run.startedAt)}{run.trigger === 'schedule' ? ' · 每日自动' : ' · 手动'}</span>
              <span>{run.found} 个岗位 · {run.newCount} 个新 · {run.scored} 个已打分</span>
            </div>
            {run.detail?.length ? (
              <ul className="run-detail">
                {run.detail.map((entry, index) => (
                  <li key={index} className={entry.error ? 'error' : entry.warning ? 'warning' : ''}>
                    <span>{entry.source}</span>
                    {entry.error ? <em>{entry.error}{entry.blocked ? '（网站在限流，稍后会再试）' : ''}</em>
                      : entry.warning ? <em>{entry.warning}</em>
                        : <em>{entry.found} 个{entry.new ? `，${entry.new} 个新` : ''}{entry.closed ? `，${entry.closed} 个已下线` : ''}{entry.warnings?.length ? `（${entry.warnings.join('；')}）` : ''}</em>}
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

export function SearchesView({ boot, reload, status }) {
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [runs, setRuns] = useState(boot.runs);
  const running = status?.scheduler?.running;

  useEffect(() => {
    api('/api/runs?limit=10').then(setRuns).catch(() => {});
  }, [running]);

  async function runSearch(search) {
    setError('');
    setMessage('');
    try {
      await api('/api/runs', { method: 'POST', body: { searchIds: [search.id] } });
      setMessage(`已开始抓取“${search.name}”。`);
    } catch (failure) { setError(failure.message); }
  }
  async function toggle(search) {
    try { await api(`/api/searches/${search.id}`, { method: 'PATCH', body: { enabled: !search.enabled } }); await reload(); }
    catch (failure) { setError(failure.message); }
  }
  async function remove(search) {
    if (!window.confirm(`删除搜索“${search.name}”？已抓到的岗位会保留。`)) return;
    try { await api(`/api/searches/${search.id}`, { method: 'DELETE' }); await reload(); }
    catch (failure) { setError(failure.message); }
  }

  return (
    <section className="settings-page">
      <header className="view-header">
        <div><h1>搜索与公司</h1><p>每天按这些条件抓取。抓取在你的电脑上进行，会放慢请求节奏，避免被网站限流。</p></div>
        <div className="header-actions"><button className="button primary" onClick={() => setEditing('new')}><Plus size={15} />新建搜索</button></div>
      </header>
      {editing ? (
        <SearchForm initial={editing === 'new' ? null : editing} sites={boot.sites} countries={boot.countries}
          onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />
      ) : null}
      {error ? <p className="notice error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}
      <section className="card-section">
        <h2>保存的搜索</h2>
        {!boot.searches.length ? <p className="hint">还没有搜索。新建一个，例如关键词“Data Scientist, Data Analyst”、地点“New York, NY”、发布时间 3 天内。</p> : null}
        <ul className="search-list">
          {boot.searches.map(search => (
            <li key={search.id} className={search.enabled ? '' : 'disabled'}>
              <div className="search-main">
                <strong>{search.name}</strong>
                <span>{search.keywords}{search.location ? ` · ${search.location}` : ''}{search.isRemote ? ' · 远程' : ''}</span>
                <span className="chips">
                  {search.sites.map(site => <em key={site}>{SITE_LABELS[site]}</em>)}
                  {search.hoursOld ? <em>{POSTED.find(option => option.value === search.hoursOld)?.label || `${search.hoursOld} 小时内`}</em> : null}
                  {search.jobType ? <em>{JOB_TYPE_LABELS[search.jobType]}</em> : null}
                  {search.excludeKeywords.length ? <em>排除 {search.excludeKeywords.join('、')}</em> : null}
                </span>
                <small>{search.lastRunAt ? `上次运行 ${relativeDay(search.lastRunAt)} ${formatTime(search.lastRunAt).split(' ')[1]}` : '还没有运行过'}</small>
              </div>
              <div className="search-actions">
                <label className="switch"><input type="checkbox" checked={search.enabled} onChange={() => toggle(search)} />{search.enabled ? '每日' : '暂停'}</label>
                <button className="icon-button" title="立即运行" onClick={() => runSearch(search)} disabled={running}><Play size={15} /></button>
                <button className="icon-button" title="编辑" onClick={() => setEditing(search)}><Pencil size={15} /></button>
                <button className="icon-button" title="删除" onClick={() => remove(search)}><Trash2 size={15} /></button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <Companies companies={boot.companies} onChange={reload} />
      <Runs runs={runs} />
    </section>
  );
}
