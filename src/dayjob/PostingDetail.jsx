import { useEffect, useState } from 'react';
import { Bookmark, BookmarkCheck, Building2, CalendarClock, CircleCheck, ExternalLink, EyeOff, LoaderCircle, MapPin, RotateCcw, Sparkles, Wallet } from 'lucide-react';
import { api } from '../api.js';
import { SITE_LABELS, STATUS_LABELS, VERDICT_LABELS, dateInputToIso, formatDay, formatTime, jobTypeText, localDateInput, relativeDay, salaryText, scoreTone } from './format.js';
import { Markdown } from './Markdown.jsx';

function DateRow({ label, value, relative = true }) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd>{formatDay(value)}{relative ? <span>（{relativeDay(value)}）</span> : null}</dd></div>;
}

function ScoreCard({ score, onScore, scoring, hasResume, setView }) {
  if (!hasResume) {
    return <div className="score-card empty"><p>上传简历后，AI 会对每个岗位给出匹配度和差距分析。</p><button className="button" onClick={() => setView('resume')}>上传简历</button></div>;
  }
  if (!score) {
    return (
      <div className="score-card empty">
        <p>这个岗位还没有打分。</p>
        <button className="button primary" onClick={() => onScore(false)} disabled={scoring}>
          {scoring ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{scoring ? '打分中…（约半分钟）' : 'AI 打分'}
        </button>
      </div>
    );
  }
  return (
    <div className={`score-card ${scoreTone(score.score)}`}>
      <div className="score-head">
        <div className="score-number">{score.score}<small>/100</small></div>
        <div>
          <strong>{VERDICT_LABELS[score.verdict]}</strong>
          <span>{score.provider === 'claude-mcp' ? '来自 Claude（MCP）' : score.provider === 'anthropic-api' ? 'Claude API' : 'Claude Code'} · {formatTime(score.createdAt)}</span>
        </div>
        <button className="icon-button" title="重新打分" onClick={() => onScore(true)} disabled={scoring}>
          {scoring ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}
        </button>
      </div>
      {score.summary ? <p className="score-summary">{score.summary}</p> : null}
      <div className="score-columns">
        {score.strengths?.length ? <div><h4>匹配点</h4><ul>{score.strengths.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
        {score.gaps?.length ? <div><h4>差距</h4><ul>{score.gaps.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
      </div>
      {score.missingKeywords?.length ? (
        <div className="keywords"><h4>简历可补充的关键词（属实时）</h4><div>{score.missingKeywords.map(word => <span key={word}>{word}</span>)}</div></div>
      ) : null}
    </div>
  );
}

function ApplyForm({ onApply, onCancel, busy }) {
  const [day, setDay] = useState(localDateInput());
  const [note, setNote] = useState('');
  return (
    <form className="apply-form" onSubmit={event => { event.preventDefault(); onApply({ appliedAt: day === localDateInput() ? undefined : dateInputToIso(day), note }); }}>
      <label>投递日期<input type="date" value={day} max={localDateInput()} onChange={event => setDay(event.target.value)} required /></label>
      <label className="grow">备注（可选）<input value={note} maxLength={2000} placeholder="例如：内推人、用的简历版本" onChange={event => setNote(event.target.value)} /></label>
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>取消</button>
        <button type="submit" className="button primary" disabled={busy}><CircleCheck size={15} />确认已投递</button>
      </div>
      <p className="hint">确认后 Dayjob 会自动追踪：定期检查岗位是否关闭、到期提醒跟进、长时间无回复时提示。</p>
    </form>
  );
}

export function PostingDetail({ id, onChanged, setView, hasResume, mode }) {
  const [posting, setPosting] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPosting(null);
    setApplying(false);
    setError('');
    api(`/api/postings/${encodeURIComponent(id)}`).then(value => { if (!cancelled) setPosting(value); })
      .catch(failure => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [id]);

  async function act(name, work) {
    setBusy(name);
    setError('');
    try { await work(); } catch (failure) { setError(failure.message); } finally { setBusy(''); }
  }
  const setStatus = status => act(status, async () => {
    const updated = await api(`/api/postings/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
    setPosting(updated);
    onChanged(updated, { removed: status === 'dismissed' || (mode === 'saved' && status !== 'saved') });
  });
  const score = force => act('score', async () => {
    const updated = await api(`/api/postings/${encodeURIComponent(id)}/score`, { method: 'POST', body: { force } });
    setPosting(updated);
    onChanged(updated);
  });
  const apply = input => act('apply', async () => {
    await api(`/api/postings/${encodeURIComponent(id)}/apply`, { method: 'POST', body: input });
    const updated = await api(`/api/postings/${encodeURIComponent(id)}`);
    setPosting(updated);
    setApplying(false);
    onChanged(updated, { removed: true });
  });

  if (error && !posting) return <div className="detail-empty">{error}</div>;
  if (!posting) return <div className="detail-empty"><LoaderCircle className="spin" /></div>;
  const salary = salaryText(posting.salary);
  const facts = [jobTypeText(posting.jobType), posting.jobLevel, posting.isRemote ? '远程' : null, posting.department, posting.jobFunction].filter(Boolean);
  return (
    <article className="posting-detail">
      <header>
        <div className="detail-title">
          <div className="logo large">{posting.companyLogo ? <img src={posting.companyLogo} alt="" referrerPolicy="no-referrer" /> : <span>{(posting.company || posting.title).slice(0, 1).toUpperCase()}</span>}</div>
          <div>
            <h2>{posting.title}</h2>
            <p className="detail-company">
              <span><Building2 size={14} />{posting.company || '未知公司'}</span>
              {posting.location ? <span><MapPin size={14} />{posting.location}</span> : null}
              {salary ? <span><Wallet size={14} />{salary}</span> : null}
            </p>
            {facts.length ? <p className="facts">{facts.map(fact => <span key={fact}>{fact}</span>)}</p> : null}
          </div>
        </div>
        {posting.closedAt ? <p className="banner closed"><CalendarClock size={15} />这个岗位在 {formatDay(posting.closedAt)} 被发现已关闭或下线。</p> : null}
        <div className="detail-actions">
          <a className="button" href={posting.jobUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />打开{SITE_LABELS[posting.site] && posting.site !== 'manual' ? ` ${SITE_LABELS[posting.site]}` : '原帖'}</a>
          {posting.applyUrl ? <a className="button" href={posting.applyUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />公司申请页</a> : null}
          {posting.application ? (
            <button className="button primary" onClick={() => setView('applications')}><CircleCheck size={15} />{STATUS_LABELS[posting.application.status]} · 查看追踪</button>
          ) : (
            <>
              {posting.status === 'saved'
                ? <button className="button" onClick={() => setStatus('new')} disabled={Boolean(busy)}><BookmarkCheck size={15} />已收藏</button>
                : <button className="button" onClick={() => setStatus('saved')} disabled={Boolean(busy)}><Bookmark size={15} />收藏</button>}
              {posting.status === 'dismissed'
                ? <button className="button" onClick={() => setStatus('new')} disabled={Boolean(busy)}><RotateCcw size={15} />恢复</button>
                : <button className="button" onClick={() => setStatus('dismissed')} disabled={Boolean(busy)}><EyeOff size={15} />不感兴趣</button>}
              <button className="button primary" onClick={() => setApplying(true)} disabled={applying}><CircleCheck size={15} />我已投递</button>
            </>
          )}
        </div>
        {applying ? <ApplyForm onApply={apply} onCancel={() => setApplying(false)} busy={busy === 'apply'} /> : null}
        {error ? <p className="notice error">{error}</p> : null}
      </header>
      <dl className="dates">
        <DateRow label="发布 / 开放时间" value={posting.datePosted} />
        <DateRow label="Dayjob 首次抓取" value={posting.firstSeenAt} />
        <DateRow label="最近一次出现在搜索中" value={posting.lastSeenAt} />
        {posting.lastCheckedAt ? <DateRow label="最近检查是否开放" value={posting.lastCheckedAt} /> : null}
        <div><dt>来源</dt><dd>{SITE_LABELS[posting.site] || posting.site}{posting.duplicates?.length ? <span>（也发布在 {posting.duplicates.map(item => SITE_LABELS[item.site] || item.site).join('、')}）</span> : null}</dd></div>
        {posting.searches?.length ? <div><dt>匹配的搜索</dt><dd>{posting.searches.map(search => search.name).join('、')}</dd></div> : null}
      </dl>
      <ScoreCard score={posting.score} onScore={score} scoring={busy === 'score'} hasResume={hasResume} setView={setView} />
      <section className="description">
        <h3>职位描述</h3>
        {posting.description ? <Markdown text={posting.description} /> : <p className="hint">这个来源没有提供完整描述。打开原帖查看。</p>}
        {posting.emails?.length ? <p className="hint">描述中的邮箱：{posting.emails.join('，')}</p> : null}
      </section>
    </article>
  );
}
