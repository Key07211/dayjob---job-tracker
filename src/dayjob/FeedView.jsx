import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, EyeOff, Inbox, RefreshCw, RotateCcw, Sparkles, X } from 'lucide-react';
import { api, query } from '../api.js';
import { label, relativeDay, salaryText } from './format.js';
import { useI18n } from '../i18n.jsx';
import { ScoreBadge } from './ScoreBadge.jsx';
import { PostingDetail } from './PostingDetail.jsx';
import { ViewDate } from './ViewDate.jsx';
import { ListenWave } from './groove/ListenWave.jsx';
import { useGroove } from './groove/bus.js';
import { BEAT, cue, reducedMotion } from './groove/sound.js';
import { E8, Q, flipList } from './groove/fx.js';
import { Hit, Roll } from './groove/Fx.jsx';
import { NoteLoader } from './groove/BrandNote.jsx';

const SORTS = [{ id: 'posted', label: ['最新发布', 'Newest posted'] }, { id: 'score', label: ['匹配度', 'Best match'] }, { id: 'seen', label: ['最新抓取', 'Newest found'] }, { id: 'company', label: ['公司', 'Company'] }];
const SINCE = [{ id: '', label: ['全部时间', 'Any time'] }, { id: '1', label: ['今天抓取', 'Found today'] }, { id: '3', label: ['近 3 天', 'Last 3 days'] }, { id: '7', label: ['近 7 天', 'Last 7 days'] }];
// "Remove low matches" moves new jobs scoring under this to Not interested.
const LOW_SCORE = 60;
const SCORES = [{ id: '', label: ['任意匹配度', 'Any match'] }, { id: '65', label: ['≥ 65', '≥ 65'] }, { id: '75', label: ['≥ 75', '≥ 75'] }, { id: '85', label: ['≥ 85', '≥ 85'] }];

function useDebounced(value, delay) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return current;
}

export function FeedView({ mode, boot, dataVersion, setView, refreshStatus, focus = null }) {
  const { t } = useI18n();
  const [filters, setFilters] = useState({ q: '', site: '', minScore: '', sort: focus ? 'score' : mode === 'saved' ? 'seen' : 'posted', sinceDays: '', searchId: '', includeClosed: mode === 'saved' });
  const [result, setResult] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(focus);
  const [reloadKey, setReloadKey] = useState(0);
  const [scoringMessage, setScoringMessage] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  // What can be undone: jobs just moved to Not interested, with the bar that offers it rising at the bottom.
  const [undo, setUndo] = useState(null);
  const [noneLow, setNoneLow] = useState(false);
  // Rows on their way out (low scores, folded from the bottom up) or back (undone, from the top down), by id: their place in the wave.
  const [folding, setFolding] = useState({});
  const [returning, setReturning] = useState({});
  // Refreshing deals the rows in again, an eighth note apart.
  const [wave, setWave] = useState(0);
  const list = useRef(null);
  const flip = useMemo(() => flipList({ get children() { return list.current?.children; } }), []);
  // Ripples behind a job row: a soft ring when its score lands, three yellow rings when it is applied to.
  const [ripples, setRipples] = useState({});
  const [landed, setLanded] = useState(() => new Set());
  const [leaving, setLeaving] = useState({});
  const uid = useRef(0);
  const text = useDebounced(filters.q, 250);
  const scoreMode = boot.settings.ai.scoreMode || 'auto';
  const hasResume = boot.resumes.length > 0;
  // Outside "score everything", the user ticks the jobs worth a Claude call.
  const picking = scoreMode !== 'auto' && hasResume;
  const scoreAllShown = scoreMode === 'auto' || (scoreMode === 'saved' && mode === 'saved');
  // A changed sort or filter: rows that stay slide to their new place instead of jumping.
  const set = (key, value) => { flip.measure(); setFilters(current => ({ ...current, [key]: value })); };

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

  useLayoutEffect(() => { flip.play(); }, [result, flip]);
  useEffect(() => {
    if (!undo?.auto) return undefined;
    const timer = setTimeout(() => setUndo(current => (current === undo ? null : current)), 8000);
    return () => clearTimeout(timer);
  }, [undo]);
  // A finished or paused batch refreshes the data; its "scoring started" note is then out of date.
  useEffect(() => { setScoringMessage(''); }, [dataVersion]);
  const sites = useMemo(() => [...new Set(result.items.map(item => item.site))], [result.items]);
  const unscored = result.items.filter(item => !item.score).length;
  const low = mode === 'active' ? result.items.filter(item => item.status === 'new' && item.score && item.score.score < LOW_SCORE).length : 0;
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

  function ripple(id, kind) {
    if (reducedMotion()) return;
    const ring = { id: ++uid.current, kind };
    setRipples(current => ({ ...current, [id]: [...(current[id] || []), ring].slice(-3) }));
    setTimeout(() => setRipples(current => ({ ...current, [id]: (current[id] || []).filter(item => item.id !== ring.id) })), BEAT * 2);
  }
  // A score landing while the list is open: the row's badge drops in and a ring spreads behind it.
  useGroove('score', ({ id, score, verdict }) => {
    if (!result.items.some(item => item.id === id)) return;
    setResult(current => ({ ...current, items: current.items.map(item => (item.id === id ? { ...item, score: { ...(item.score || {}), score, verdict } } : item)) }));
    setLanded(current => new Set(current).add(id));
    ripple(id, 'note');
  });
  useGroove('apply', ({ postingId }) => { if (postingId) ripple(postingId, 'chord'); });

  function onChanged(updated, { removed, applied, restored } = {}) {
    // A job taken back from Not interested slides back into its place from the left.
    if (restored) {
      setReturning(current => ({ ...current, [updated.id]: 0 }));
      setTimeout(() => setReturning(current => { const next = { ...current }; delete next[updated.id]; return next; }), BEAT * 2);
    }
    if (removed && updated.status === 'dismissed') setUndo({ ids: [updated.id], auto: true, text: ['已移到“不感兴趣”。', 'Moved to Not interested.'] });
    if (removed) {
      const index = result.items.findIndex(item => item.id === updated.id);
      const rest = result.items.filter(item => item.id !== updated.id);
      setSelected(rest[Math.min(index, rest.length - 1)]?.id || null);
      // The row slides out first; an application lets its rings play for a beat and a half.
      setLeaving(current => ({ ...current, [updated.id]: applied ? 'leaving applied' : 'leaving' }));
      setTimeout(() => {
        setResult(current => ({ items: current.items.filter(item => item.id !== updated.id), total: Math.max(0, current.total - 1) }));
        setLeaving(current => { const next = { ...current }; delete next[updated.id]; return next; });
      }, reducedMotion() ? 0 : applied ? BEAT * 1.5 : BEAT * 0.75);
    } else {
      setResult(current => ({ ...current, items: current.items.map(item => (item.id === updated.id ? { ...item, ...updated, description: undefined } : item)) }));
    }
    void refreshStatus();
  }

  async function scoreJobs(ids) {
    setScoringMessage('');
    try {
      const { started, paused } = await api('/api/scores', { method: 'POST', body: { postingIds: ids } });
      if (paused) {
        setScoringMessage(t('AI 打分已暂停。点左下角的“继续打分”后，会给这些岗位打分。', 'AI scoring is paused. These jobs are scored once you click “Resume scoring” at the bottom left.'));
        setPicked(new Set());
        void refreshStatus();
        return;
      }
      if (!started) {
        setScoringMessage(t('正在给别的岗位打分，完成后再试。', 'Other jobs are being scored. Try again when that is done.'));
        return;
      }
      setScoringMessage(t('已开始为这些岗位打分，完成后会自动刷新。', 'Scoring started. The list refreshes when it is done.'));
      setPicked(new Set());
      void refreshStatus();
    } catch (failure) { setScoringMessage(failure.message); }
  }
  // The low rows fold away one by one from the bottom up, an eighth note apart, then the undo bar rises.
  async function removeLow() {
    setScoringMessage('');
    setNoneLow(false);
    cue('removeLow');
    const lows = result.items.filter(item => item.status === 'new' && item.score && item.score.score < LOW_SCORE).map(item => item.id);
    if (lows.length && !reducedMotion()) {
      setFolding(Object.fromEntries([...lows].reverse().map((id, index) => [id, Math.min(index, 12)])));
      await new Promise(resolve => setTimeout(resolve, Math.min(lows.length, 12) * E8 + Q * 1.25));
    }
    try {
      const { dismissed } = await api('/api/postings/dismiss-low', { method: 'POST', body: { below: LOW_SCORE } });
      setResult(current => ({ items: current.items.filter(item => !dismissed.includes(item.id)), total: Math.max(0, current.total - dismissed.length) }));
      if (dismissed.length) setUndo({ ids: dismissed, text: [`已把 ${dismissed.length} 个低于 ${LOW_SCORE} 分的岗位移到“不感兴趣”。`, `Moved ${dismissed.length} ${dismissed.length === 1 ? 'job' : 'jobs'} under ${LOW_SCORE} to Not interested.`] });
      else setNoneLow(true);
      setReloadKey(key => key + 1);
      void refreshStatus();
    } catch (failure) { setScoringMessage(failure.message); } finally { setFolding({}); }
  }
  // Like rewinding: what was just taken away comes back in the reverse order, from the top down.
  async function undoRemove() {
    const ids = undo.ids;
    try {
      await api('/api/postings/restore', { method: 'POST', body: { ids } });
      setUndo(null);
      setReturning(Object.fromEntries(ids.map((id, index) => [id, Math.min(index, 12)])));
      setTimeout(() => setReturning({}), BEAT * 2 + Math.min(ids.length, 12) * E8);
      setReloadKey(key => key + 1);
      void refreshStatus();
    } catch (failure) { setScoringMessage(failure.message); }
  }
  const scoreAll = () => scoreJobs(result.items.filter(item => !item.score).map(item => item.id));

  const empty = !loading && !result.items.length;
  return (
    <section className="feed">
      <header className="view-header">
        <ListenWave />
        <div className="title-block">
          <ViewDate />
          <h1>{mode === 'saved' ? t('已收藏', 'Saved') : t('今日岗位', 'Today')}</h1>
        </div>
        <div className="header-actions">
          {picked.size ? <button className="button primary" data-fx="sparkle" onClick={() => scoreJobs([...picked])}><Sparkles size={15} />{t('给选中的 ', 'Score ')}<Roll value={picked.size} />{t(' 个岗位打分', picked.size === 1 ? ' picked job' : ' picked jobs')}</button>
            : unscored && hasResume && scoreAllShown ? <button className="button" data-fx="sparkle" onClick={scoreAll}><Sparkles size={15} />{t(`给 ${unscored} 个岗位打分`, `Score ${unscored} ${unscored === 1 ? 'job' : 'jobs'}`)}</button> : null}
          {low ? <button className="button" onClick={removeLow} title={t(`把所有低于 ${LOW_SCORE} 分的新岗位移到“不感兴趣”，已收藏的不动`, `Move every new job scoring under ${LOW_SCORE} to Not interested; saved jobs stay`)}>
            <EyeOff size={15} />{t(`剔除低于 ${LOW_SCORE} 分的岗位`, `Remove jobs under ${LOW_SCORE}`)}</button> : null}
          <button className="icon-button" data-fx="refresh" title={t('刷新', 'Refresh')} onClick={() => { setWave(value => value + 1); setReloadKey(key => key + 1); }}><RefreshCw size={16} /></button>
        </div>
      </header>
      {scoringMessage ? <p className="notice">{scoringMessage}</p> : null}
      {noneLow ? <p className="notice">{t(`没有低于 ${LOW_SCORE} 分的新岗位。`, `No new jobs score under ${LOW_SCORE}.`)}<button className="link" onClick={() => setNoneLow(false)}>{t('知道了', 'OK')}</button></p> : null}
      {/* The page is a container (for its own layout), so the bar is placed on the window itself to sit at its bottom. */}
      {undo ? createPortal(
        <div className="undo-bar" role="status">
          <span>{t(...undo.text)}</span>
          <button className="button small" data-fx="undo" onClick={undoRemove}><RotateCcw size={14} />{t('撤销', 'Undo')}</button>
          <button className="icon-button" title={t('知道了', 'OK')} onClick={() => setUndo(null)}><X size={15} /></button>
        </div>, document.body) : null}
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
        <div className="posting-list" role="list" ref={list}>
          {loading && !result.items.length ? <div className="list-empty"><NoteLoader /></div> : null}
          {empty ? (
            <div className="list-empty">
              <Inbox size={28} />
              {mode === 'saved' ? <p>{t('还没有收藏的岗位。', 'No saved jobs yet.')}</p> : boot.searches.length || boot.companies.length
                ? <p>{t('没有符合条件的岗位。点左下角“立即抓取”获取最新岗位。', 'No jobs match. Click “Search now” at the bottom left to fetch the latest.')}</p>
                : <><p>{t('先添加一个搜索，比如“Data Scientist · San Francisco”。', 'Start by adding a search, such as “Data Scientist · San Francisco”.')}</p><button className="button primary" onClick={() => setView('searches')}>{t('添加搜索', 'Add a search')}</button></>}
            </div>
          ) : null}
          {result.items.map((item, index) => (
            <div key={`${item.id}-${wave}`} data-id={item.id} role="listitem"
              className={`posting-item ${item.id in returning ? 'returning' : item.id in folding ? 'folding' : 'enter'}${picking ? ' picking' : ''}${selected === item.id ? ' selected' : ''}${leaving[item.id] ? ` ${leaving[item.id]}` : ''}`}
              style={leaving[item.id] ? undefined : { animationDelay: `${(folding[item.id] ?? returning[item.id] ?? Math.min(index, 12)) * E8}ms` }}>
              {ripples[item.id]?.length ? <span className="ripples" aria-hidden="true">{ripples[item.id].map(ring => (ring.kind === 'chord'
                ? [0, 1, 2].map(k => <i key={`${ring.id}-${k}`} className="rp chord" style={{ animationDelay: `${k * (BEAT / 8)}ms` }} />)
                : [<i key={`${ring.id}-w`} className="rp wash" />, <i key={`${ring.id}-r`} className="rp note" />]))}</span> : null}
              {picking ? (
                <span className="pick">
                  {!item.score ? <input type="checkbox" data-fx="pick" checked={picked.has(item.id)} onChange={() => togglePick(item.id)}
                    title={t('勾选后一起打分', 'Tick to score it')} aria-label={t(`勾选“${item.title}”来打分`, `Pick “${item.title}” for scoring`)} /> : null}
                </span>
              ) : null}
              <button className={`posting-row${selected === item.id ? ' selected' : ''}${item.closedAt ? ' closed' : ''}`} data-fx="select" onClick={() => setSelected(item.id)}>
                <div className="logo">{item.companyLogo ? <img src={item.companyLogo} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span>{(item.company || item.title).slice(0, 1).toUpperCase()}</span>}</div>
                <div className="row-main">
                  <strong><Hit text={item.title} q={text} /></strong>
                  <span className="row-company"><Hit text={item.company} q={text} />{item.location ? ` · ${item.location}` : ''}</span>
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
                <ScoreBadge score={item.score} compact landed={landed.has(item.id)} />
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
