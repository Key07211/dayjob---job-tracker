import { useEffect, useMemo, useState } from 'react';
import { Bookmark, Inbox, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { api, query } from '../api.js';
import { label, relativeDay, salaryText } from './format.js';
import { useI18n } from '../i18n.jsx';
import { ScoreBadge } from './ScoreBadge.jsx';
import { PostingDetail } from './PostingDetail.jsx';

const SORTS = [{ id: 'posted', label: ['最新发布', 'Newest posted'] }, { id: 'score', label: ['匹配度', 'Best match'] }, { id: 'seen', label: ['最新抓取', 'Newest found'] }, { id: 'company', label: ['公司', 'Company'] }];
const SINCE = [{ id: '', label: ['全部时间', 'Any time'] }, { id: '1', label: ['今天抓取', 'Found today'] }, { id: '3', label: ['近 3 天', 'Last 3 days'] }, { id: '7', label: ['近 7 天', 'Last 7 days'] }];
const SCORES = [{ id: '', label: ['任意匹配度', 'Any match'] }, { id: '65', label: ['≥ 65', '≥ 65'] }, { id: '75', label: ['≥ 75', '≥ 75'] }, { id: '85', label: ['≥ 85', '≥ 85'] }];

function useDebounced(value, delay) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return current;
}

export function FeedView({ mode, boot, dataVersion, setView, refreshStatus }) {
  const { t } = useI18n();
  const [filters, setFilters] = useState({ q: '', site: '', minScore: '', sort: mode === 'saved' ? 'seen' : 'posted', sinceDays: '', searchId: '', includeClosed: mode === 'saved' });
  const [result, setResult] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [scoringMessage, setScoringMessage] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const text = useDebounced(filters.q, 250);
  const scoreMode = boot.settings.ai.scoreMode || 'auto';
  const hasResume = boot.resumes.length > 0;
  // Outside "score everything", the user ticks the jobs worth a Claude call.
  const picking = scoreMode !== 'auto' && hasResume;
  const scoreAllShown = scoreMode === 'auto' || (scoreMode === 'saved' && mode === 'saved');
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
  useEffect(() => {
    setPicked(current => {
      const still = new Set(result.items.filter(item => current.has(item.id) && !item.score).map(item => item.id));
      return still.size === current.size ? current : still;
    });
  }, [result.items]);
  const togglePick = id => setPicked(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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

  async function scoreJobs(ids) {
    setScoringMessage('');
    try {
      const { started } = await api('/api/scores', { method: 'POST', body: { postingIds: ids } });
      if (!started) {
        setScoringMessage(t('正在给别的岗位打分，完成后再试。', 'Other jobs are being scored. Try again when that is done.'));
        return;
      }
      setScoringMessage(t('已开始为这些岗位打分，完成后会自动刷新。', 'Scoring started. The list refreshes when it is done.'));
      setPicked(new Set());
      void refreshStatus();
    } catch (failure) { setScoringMessage(failure.message); }
  }
  const scoreAll = () => scoreJobs(result.items.filter(item => !item.score).map(item => item.id));
  const intro = mode === 'saved' ? t('先收藏，准备好再投递。投递后会自动出现在“投递追踪”。', 'Save jobs now and apply when you are ready. Applied jobs move to Applications.')
    : scoreMode === 'saved' ? t('每日抓取的新岗位。收藏的岗位会按你的简历 AI 打分，也可以勾选几个直接打分。', 'New jobs from the daily search. Jobs you save are scored against your resume, or tick a few to score them now.')
      : scoreMode === 'manual' ? t('每日抓取的新岗位。勾选想打分的岗位，再点右上角的按钮。', 'New jobs from the daily search. Tick the ones you want scored, then use the button at the top right.')
        : t('每日抓取的新岗位，按你的简历 AI 打分。', 'New jobs from the daily search, scored by AI against your resume.');

  const empty = !loading && !result.items.length;
  return (
    <section className="feed">
      <header className="view-header">
        <div>
          <h1>{mode === 'saved' ? t('已收藏', 'Saved') : t('今日岗位', 'Today')}</h1>
          <p>{intro}</p>
        </div>
        <div className="header-actions">
          {picked.size ? <button className="button primary" onClick={() => scoreJobs([...picked])}><Sparkles size={15} />{t(`给选中的 ${picked.size} 个岗位打分`, `Score ${picked.size} picked ${picked.size === 1 ? 'job' : 'jobs'}`)}</button>
            : unscored && hasResume && scoreAllShown ? <button className="button" onClick={scoreAll}><Sparkles size={15} />{t(`给 ${unscored} 个岗位打分`, `Score ${unscored} ${unscored === 1 ? 'job' : 'jobs'}`)}</button> : null}
          <button className="icon-button" title={t('刷新', 'Refresh')} onClick={() => setReloadKey(key => key + 1)}><RefreshCw size={16} /></button>
        </div>
      </header>
      {scoringMessage ? <p className="notice">{scoringMessage}</p> : null}
      {!hasResume && mode === 'active' ? (
        <p className="notice">{t('还没有上传简历，岗位不会被打分。', 'No resume yet, so jobs are not scored.')}<button className="link" onClick={() => setView('resume')}>{t('上传简历', 'Upload a resume')}</button></p>
      ) : null}
      <div className="filters">
        <input className="search-input" placeholder={t('搜索职位、公司或地点', 'Search title, company or location')} value={filters.q} onChange={event => set('q', event.target.value)} />
        <select value={filters.sort} onChange={event => set('sort', event.target.value)} aria-label={t('排序', 'Sort')}>
          {SORTS.map(option => <option key={option.id} value={option.id}>{t(...option.label)}</option>)}
        </select>
        <select value={filters.minScore} onChange={event => set('minScore', event.target.value)} aria-label={t('匹配度', 'Match')}>
          {SCORES.map(option => <option key={option.id} value={option.id}>{t(...option.label)}</option>)}
        </select>
        <select value={filters.sinceDays} onChange={event => set('sinceDays', event.target.value)} aria-label={t('时间', 'Time')}>
          {SINCE.map(option => <option key={option.id} value={option.id}>{t(...option.label)}</option>)}
        </select>
        <select value={filters.site} onChange={event => set('site', event.target.value)} aria-label={t('来源', 'Source')}>
          <option value="">{t('全部来源', 'All sources')}</option>
          {[...new Set([...sites, filters.site].filter(Boolean))].map(site => <option key={site} value={site}>{label('site', site)}</option>)}
        </select>
        {boot.searches.length > 1 ? (
          <select value={filters.searchId} onChange={event => set('searchId', event.target.value)} aria-label={t('搜索', 'Search')}>
            <option value="">{t('全部搜索', 'All searches')}</option>
            {boot.searches.map(search => <option key={search.id} value={search.id}>{search.name}</option>)}
          </select>
        ) : null}
        <label className="check"><input type="checkbox" checked={filters.includeClosed} onChange={event => set('includeClosed', event.target.checked)} />{t('显示已关闭', 'Show closed')}</label>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="split">
        <div className="posting-list" role="list">
          {loading && !result.items.length ? <div className="list-empty"><LoaderCircle className="spin" /></div> : null}
          {empty ? (
            <div className="list-empty">
              <Inbox size={28} />
              {mode === 'saved' ? <p>{t('还没有收藏的岗位。', 'No saved jobs yet.')}</p> : boot.searches.length || boot.companies.length
                ? <p>{t('没有符合条件的岗位。点左下角“立即抓取”获取最新岗位。', 'No jobs match. Click “Search now” at the bottom left to fetch the latest.')}</p>
                : <><p>{t('先添加一个搜索，比如“Data Scientist · San Francisco”。', 'Start by adding a search, such as “Data Scientist · San Francisco”.')}</p><button className="button primary" onClick={() => setView('searches')}>{t('添加搜索', 'Add a search')}</button></>}
            </div>
          ) : null}
          {result.items.map(item => (
            <div key={item.id} role="listitem" className={`posting-item${picking ? ' picking' : ''}${selected === item.id ? ' selected' : ''}`}>
              {picking ? (
                <span className="pick">
                  {!item.score ? <input type="checkbox" checked={picked.has(item.id)} onChange={() => togglePick(item.id)}
                    title={t('勾选后一起打分', 'Tick to score it')} aria-label={t(`勾选“${item.title}”来打分`, `Pick “${item.title}” for scoring`)} /> : null}
                </span>
              ) : null}
              <button className={`posting-row${selected === item.id ? ' selected' : ''}${item.closedAt ? ' closed' : ''}`} onClick={() => setSelected(item.id)}>
                <div className="logo">{item.companyLogo ? <img src={item.companyLogo} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span>{(item.company || item.title).slice(0, 1).toUpperCase()}</span>}</div>
                <div className="row-main">
                  <strong>{item.title}</strong>
                  <span className="row-company">{item.company}{item.location ? ` · ${item.location}` : ''}</span>
                  <span className="row-meta">
                    {item.datePosted ? <span>{t(`${relativeDay(item.datePosted)}发布`, `Posted ${relativeDay(item.datePosted)}`)}</span>
                      : <span>{t(`${relativeDay(item.firstSeenAt)}抓取`, `Found ${relativeDay(item.firstSeenAt)}`)}</span>}
                    <span>{label('site', item.site)}</span>
                    {salaryText(item.salary) ? <span>{salaryText(item.salary)}</span> : null}
                    {item.isRemote ? <span>{t('远程', 'Remote')}</span> : null}
                    {item.closedAt ? <span className="tag-closed">{t('已关闭', 'Closed')}</span> : null}
                    {item.status === 'new' && mode === 'active' ? <span className="tag-new">{t('新', 'New')}</span> : null}
                    {item.status === 'saved' && mode === 'active' ? <span className="tag-saved"><Bookmark size={11} />{t('已收藏', 'Saved')}</span> : null}
                  </span>
                </div>
                <ScoreBadge score={item.score} compact />
              </button>
            </div>
          ))}
          {result.total > result.items.length ? <p className="list-more">{t(`显示前 ${result.items.length} 个，共 ${result.total} 个。用筛选缩小范围。`, `Showing ${result.items.length} of ${result.total}. Use the filters to narrow it down.`)}</p> : null}
        </div>
        <div className="detail-pane">
          {selected ? <PostingDetail id={selected} onChanged={onChanged} setView={setView} hasResume={hasResume} mode={mode} scoreMode={scoreMode} />
            : <div className="detail-empty">{t('选择左侧的岗位查看详情', 'Pick a job on the left to see it here')}</div>}
        </div>
      </div>
    </section>
  );
}
