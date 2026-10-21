import { useEffect, useMemo, useState } from 'react';
import { Inbox, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { api, query } from '../api.js';
import { SITE_LABELS, relativeDay, salaryText } from './format.js';
import { ScoreBadge } from './ScoreBadge.jsx';
import { PostingDetail } from './PostingDetail.jsx';

const SORTS = [{ id: 'posted', label: '最新发布' }, { id: 'score', label: '匹配度' }, { id: 'seen', label: '最新抓取' }, { id: 'company', label: '公司' }];
const SINCE = [{ id: '', label: '全部时间' }, { id: '1', label: '今天抓取' }, { id: '3', label: '近 3 天' }, { id: '7', label: '近 7 天' }];
const SCORES = [{ id: '', label: '任意匹配度' }, { id: '65', label: '≥ 65' }, { id: '75', label: '≥ 75' }, { id: '85', label: '≥ 85' }];

function useDebounced(value, delay) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return current;
}

export function FeedView({ mode, boot, dataVersion, setView, refreshStatus }) {
  const [filters, setFilters] = useState({ q: '', site: '', minScore: '', sort: mode === 'saved' ? 'seen' : 'posted', sinceDays: '', searchId: '', includeClosed: mode === 'saved' });
  const [result, setResult] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [scoringMessage, setScoringMessage] = useState('');
  const text = useDebounced(filters.q, 250);
  const set = (key, value) => setFilters(current => ({ ...current, [key]: value }));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api(`/api/postings${query({ status: mode, q: text, site: filters.site, minScore: filters.minScore, sort: filters.sort,
      sinceDays: filters.sinceDays, searchId: filters.searchId, includeClosed: filters.includeClosed ? undefined : '0', limit: 200 })}`)
      .then(value => {
        if (cancelled) return;
        setResult(value);
        setError('');
        setSelected(current => (current && value.items.some(item => item.id === current) ? current : value.items[0]?.id || null));
      })
      .catch(failure => { if (!cancelled) setError(failure.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode, text, filters.site, filters.minScore, filters.sort, filters.sinceDays, filters.searchId, filters.includeClosed, dataVersion, reloadKey]);

  const sites = useMemo(() => [...new Set(result.items.map(item => item.site))], [result.items]);
  const unscored = result.items.filter(item => !item.score).length;

  function onChanged(updated, { removed } = {}) {
    if (removed) {
      const index = result.items.findIndex(item => item.id === updated.id);
      const items = result.items.filter(item => item.id !== updated.id);
      setResult({ items, total: Math.max(0, result.total - 1) });
      setSelected(items[Math.min(index, items.length - 1)]?.id || null);
    } else {
      setResult(current => ({ ...current, items: current.items.map(item => (item.id === updated.id ? { ...item, ...updated, description: undefined } : item)) }));
    }
    void refreshStatus();
  }

  async function scoreAll() {
    setScoringMessage('');
    try {
      await api('/api/scores', { method: 'POST', body: { postingIds: result.items.filter(item => !item.score).map(item => item.id) } });
      setScoringMessage('已开始为这些岗位打分，完成后会自动刷新。');
      void refreshStatus();
    } catch (failure) { setScoringMessage(failure.message); }
  }

  const empty = !loading && !result.items.length;
  return (
    <section className="feed">
      <header className="view-header">
        <div>
          <h1>{mode === 'saved' ? '已收藏' : '今日岗位'}</h1>
          <p>{mode === 'saved' ? '先收藏，准备好再投递。投递后会自动出现在“投递追踪”。' : '每日抓取的新岗位，按你的简历 AI 打分。'}</p>
        </div>
        <div className="header-actions">
          {unscored && boot.resumes.length ? <button className="button" onClick={scoreAll}><Sparkles size={15} />给 {unscored} 个岗位打分</button> : null}
          <button className="icon-button" title="刷新" onClick={() => setReloadKey(key => key + 1)}><RefreshCw size={16} /></button>
        </div>
      </header>
      {scoringMessage ? <p className="notice">{scoringMessage}</p> : null}
      {!boot.resumes.length && mode === 'active' ? (
        <p className="notice">还没有上传简历，岗位不会被打分。<button className="link" onClick={() => setView('resume')}>上传简历</button></p>
      ) : null}
      <div className="filters">
        <input className="search-input" placeholder="搜索职位、公司或地点" value={filters.q} onChange={event => set('q', event.target.value)} />
        <select value={filters.sort} onChange={event => set('sort', event.target.value)} aria-label="排序">
          {SORTS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <select value={filters.minScore} onChange={event => set('minScore', event.target.value)} aria-label="匹配度">
          {SCORES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <select value={filters.sinceDays} onChange={event => set('sinceDays', event.target.value)} aria-label="时间">
          {SINCE.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <select value={filters.site} onChange={event => set('site', event.target.value)} aria-label="来源">
          <option value="">全部来源</option>
          {[...new Set([...sites, filters.site].filter(Boolean))].map(site => <option key={site} value={site}>{SITE_LABELS[site] || site}</option>)}
        </select>
        {boot.searches.length > 1 ? (
          <select value={filters.searchId} onChange={event => set('searchId', event.target.value)} aria-label="搜索">
            <option value="">全部搜索</option>
            {boot.searches.map(search => <option key={search.id} value={search.id}>{search.name}</option>)}
          </select>
        ) : null}
        <label className="check"><input type="checkbox" checked={filters.includeClosed} onChange={event => set('includeClosed', event.target.checked)} />显示已关闭</label>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="split">
        <div className="posting-list" role="list">
          {loading && !result.items.length ? <div className="list-empty"><LoaderCircle className="spin" /></div> : null}
          {empty ? (
            <div className="list-empty">
              <Inbox size={28} />
              {mode === 'saved' ? <p>还没有收藏的岗位。</p> : boot.searches.length || boot.companies.length
                ? <p>没有符合条件的岗位。点左下角“立即抓取”获取最新岗位。</p>
                : <><p>先添加一个搜索，比如“Data Scientist · San Francisco”。</p><button className="button primary" onClick={() => setView('searches')}>添加搜索</button></>}
            </div>
          ) : null}
          {result.items.map(item => (
            <button key={item.id} role="listitem" className={`posting-row${selected === item.id ? ' selected' : ''}${item.closedAt ? ' closed' : ''}`} onClick={() => setSelected(item.id)}>
              <div className="logo">{item.companyLogo ? <img src={item.companyLogo} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span>{(item.company || item.title).slice(0, 1).toUpperCase()}</span>}</div>
              <div className="row-main">
                <strong>{item.title}</strong>
                <span className="row-company">{item.company}{item.location ? ` · ${item.location}` : ''}</span>
                <span className="row-meta">
                  {item.datePosted ? <span>{relativeDay(item.datePosted)}发布</span> : <span>{relativeDay(item.firstSeenAt)}抓取</span>}
                  <span>{SITE_LABELS[item.site] || item.site}</span>
                  {salaryText(item.salary) ? <span>{salaryText(item.salary)}</span> : null}
                  {item.isRemote ? <span>远程</span> : null}
                  {item.closedAt ? <span className="tag-closed">已关闭</span> : null}
                  {item.status === 'new' && mode === 'active' ? <span className="tag-new">新</span> : null}
                </span>
              </div>
              <ScoreBadge score={item.score} compact />
            </button>
          ))}
          {result.total > result.items.length ? <p className="list-more">显示前 {result.items.length} 个，共 {result.total} 个。用筛选缩小范围。</p> : null}
        </div>
        <div className="detail-pane">
          {selected ? <PostingDetail id={selected} onChanged={onChanged} setView={setView} hasResume={boot.resumes.length > 0} mode={mode} />
            : <div className="detail-empty">选择左侧的岗位查看详情</div>}
        </div>
      </div>
    </section>
  );
}
