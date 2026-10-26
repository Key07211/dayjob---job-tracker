import { useEffect, useRef, useState } from 'react';
import { Bookmark, Building2, CalendarClock, CircleCheck, ExternalLink, EyeOff, FileUser, Globe, MapPin, RotateCcw, Sparkles, Wallet } from 'lucide-react';
import { api } from '../api.js';
import { dateInputToIso, formatDay, formatTime, jobTypeText, label, localDateInput, relativeDay, salaryText, scoreTone } from './format.js';
import { useI18n } from '../i18n.jsx';
import { Markdown } from './Markdown.jsx';
import { hasBrowser, openInBrowser } from './BrowserView.jsx';
import { emit } from './groove/bus.js';
import { cue } from './groove/sound.js';
import { flyTo, keyBump, leave } from './groove/fx.js';
import { Eq } from './groove/Fx.jsx';
import { BeatLoader } from './groove/BrandMark.jsx';
import { DateField } from './groove/Picker.jsx';

const SCORED_BY = { 'claude-cli': 'Claude Code', 'anthropic-api': 'Claude API', 'codex-cli': 'Codex', 'openai-api': 'OpenAI API' };

// When the job was posted, where it came from and what Dayjob has seen of it, as one line of small facts; the exact dates are in the tooltips.
function FactsLine({ posting }) {
  const { t } = useI18n();
  const seenToday = posting.lastSeenAt && relativeDay(posting.lastSeenAt) === relativeDay(new Date());
  const also = posting.duplicates?.length ? posting.duplicates.map(item => label('site', item.site)).join(t('、', ', ')) : '';
  const facts = [
    posting.datePosted ? { key: 'posted', text: t(`${relativeDay(posting.datePosted)}发布`, `Posted ${relativeDay(posting.datePosted)}`), title: formatDay(posting.datePosted) } : null,
    { key: 'site', text: also ? t(`${label('site', posting.site)}（也在 ${also}）`, `${label('site', posting.site)} (also on ${also})`) : label('site', posting.site) },
    posting.firstSeenAt ? { key: 'found', text: t(`${relativeDay(posting.firstSeenAt)}抓到`, `Found ${relativeDay(posting.firstSeenAt)}`), title: formatDay(posting.firstSeenAt) } : null,
    posting.lastSeenAt && !posting.closedAt ? { key: 'seen', text: seenToday ? t('仍在搜索结果里', 'Still in search results') : t(`${relativeDay(posting.lastSeenAt)}最后出现在搜索里`, `Last in a search ${relativeDay(posting.lastSeenAt)}`), title: formatDay(posting.lastSeenAt) } : null,
    posting.lastCheckedAt && !posting.closedAt ? { key: 'checked', text: t(`${relativeDay(posting.lastCheckedAt)}确认仍开放`, `Checked open ${relativeDay(posting.lastCheckedAt)}`), title: formatDay(posting.lastCheckedAt) } : null,
    posting.searches?.length ? { key: 'searches', text: t(`搜索：${posting.searches.map(search => search.name).join('、')}`, `Search: ${posting.searches.map(search => search.name).join(', ')}`) } : null,
  ].filter(Boolean);
  return <p className="facts-line">{facts.map(fact => <span key={fact.key} title={fact.title}>{fact.text}</span>)}</p>;
}

// The bookmark fills with yellow from the bottom up when a job is saved, and drains from the top when it is not.
function BookmarkIcon({ on, mark }) {
  return <span className={`fx-bookmark${mark ? ` ${mark}` : ''}`}><Bookmark size={15} />{on || mark === 'draining' ? <Bookmark size={15} className="fill" /> : null}</span>;
}

function ScoreCard({ score, onScore, scoring, hasResume, setView, scoreMode, saved, rolled }) {
  const { t } = useI18n();
  if (!hasResume) {
    return (
      <div className="score-card empty">
        <p>{t('上传简历后，AI 会对每个岗位给出匹配度和差距分析。', 'Upload your resume and AI rates how well each job fits, with the gaps.')}</p>
        <button className="button" onClick={() => setView('resume')}>{t('上传简历', 'Upload a resume')}</button>
      </div>
    );
  }
  if (!score) {
    return (
      <div className="score-card empty">
        <p>{scoreMode === 'saved' && !saved ? t('这个岗位还没有打分。收藏后会自动打分，也可以现在就打。', 'This job has not been scored yet. Saving it scores it, or score it now.')
          : scoreMode === 'auto' ? t('这个岗位还没有打分。', 'This job has not been scored yet.')
            : t('这个岗位还没有打分。打一次分用一次 Claude 额度。', 'This job has not been scored yet. Each score is one Claude call.')}</p>
        <button className="button primary" data-fx="sparkle" onClick={() => onScore(false)} disabled={scoring}>
          {scoring ? <Eq /> : <Sparkles size={15} />}{scoring ? t('打分中…（约半分钟）', 'Scoring… (about 30 seconds)') : t('AI 打分', 'Score with AI')}
        </button>
      </div>
    );
  }
  return (
    <div className={`score-card ${scoreTone(score.score)}`}>
      <div className="score-head">
        <div className={`score-number${rolled ? ' roll' : ''}`} key={score.createdAt}>{score.score}<small>/100</small></div>
        <div>
          <strong>{label('verdict', score.verdict)}</strong>
          <span>{score.provider === 'claude-mcp' ? t('来自 Claude（MCP）', 'From Claude (MCP)') : SCORED_BY[score.provider] || 'Claude Code'}{score.model ? ` · ${score.model}` : ''} · {formatTime(score.createdAt)}</span>
        </div>
        <button className="icon-button" data-fx="rescore" title={t('重新打分', 'Score again')} onClick={() => { cue('rescore'); onScore(true); }} disabled={scoring}>
          {scoring ? <Eq /> : <RotateCcw size={15} />}
        </button>
      </div>
      {score.summary ? <p className="score-summary">{score.summary}</p> : null}
      <div className="score-columns">
        {score.strengths?.length ? <div><h4>{t('匹配点', 'Strengths')}</h4><ul>{score.strengths.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
        {score.gaps?.length ? <div><h4>{t('差距', 'Gaps')}</h4><ul>{score.gaps.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
      </div>
      {score.missingKeywords?.length ? (
        <div className="keywords"><h4>{t('简历可补充的关键词（属实时）', 'Keywords to add to your resume (if true)')}</h4><div>{score.missingKeywords.map(word => <span key={word}>{word}</span>)}</div></div>
      ) : null}
    </div>
  );
}

// Which resume this job is scored against, and how the others compare.
function ResumeMatch({ match }) {
  const { t } = useI18n();
  if (!match?.ranking?.length) return null;
  const chosen = match.ranking.find(entry => entry.id === match.resumeId) || match.ranking[0];
  const percent = value => `${Math.round(value * 100)}%`;
  return (
    <details className="resume-match">
      <summary><FileUser size={14} />{t(`按简历“${chosen.name}”分析 · 关键词重合 ${percent(chosen.overlap)}`, `Scored against “${chosen.name}” · ${percent(chosen.overlap)} keyword overlap`)}</summary>
      {chosen.matched.length ? <div className="keywords"><h4>{t('重合的关键词', 'Shared keywords')}</h4><div>{chosen.matched.map(word => <span key={word}>{word}</span>)}</div></div> : null}
      {match.ranking.length > 1 ? (
        <ul>{match.ranking.map(entry => <li key={entry.id} className={entry.id === chosen.id ? 'chosen' : undefined}><span>{entry.name}</span><em>{percent(entry.overlap)}</em></li>)}</ul>
      ) : null}
      <p className="hint">{t('Dayjob 会自动选关键词重合度最高的简历来打分。', 'Dayjob scores each job against the resume with the highest keyword overlap.')}</p>
    </details>
  );
}

function ApplyForm({ onApply, onCancel, busy }) {
  const { t } = useI18n();
  const [day, setDay] = useState(localDateInput());
  const [note, setNote] = useState('');
  const form = useRef(null);
  return (
    <form className="apply-form" ref={form} onSubmit={event => { event.preventDefault(); onApply({ appliedAt: day === localDateInput() ? undefined : dateInputToIso(day), note }); }}>
      <label>{t('投递日期', 'Applied on')}<DateField value={day} max={localDateInput()} onChange={event => setDay(event.target.value)} required /></label>
      <label className="grow">{t('备注（可选）', 'Note (optional)')}<input value={note} maxLength={2000} placeholder={t('例如：内推人、用的简历版本', 'e.g. referrer, resume version')} onChange={event => setNote(event.target.value)} /></label>
      <div className="form-actions">
        <button type="button" className="button" onClick={() => leave(form.current, 'up', onCancel)}>{t('取消', 'Cancel')}</button>
        <button type="submit" className={`button primary${busy ? ' fx-draw' : ''}`} disabled={busy}><CircleCheck size={15} />{t('确认已投递', 'Confirm applied')}</button>
      </div>
      <p className="hint">{t('确认后 Dayjob 会自动追踪：定期检查岗位是否关闭、到期提醒跟进、长时间无回复时提示。',
        'Dayjob then tracks it for you: it checks whether the posting closes, reminds you to follow up, and flags a long silence.')}</p>
    </form>
  );
}

export function PostingDetail({ id, onChanged, setView, hasResume, mode, scoreMode = 'auto' }) {
  const { t } = useI18n();
  const [posting, setPosting] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [applying, setApplying] = useState(false);
  // What the last click left to finish on screen: the bookmark filling or draining, a new score rolling in, the applied tick drawing.
  const [mark, setMark] = useState('');
  const [rolled, setRolled] = useState(false);
  const [justApplied, setJustApplied] = useState(false);
  // A slow request (scoring takes about 30 s) must not show on another job.
  const shown = useRef(id);
  shown.current = id;

  useEffect(() => {
    let cancelled = false;
    setPosting(null);
    setApplying(false);
    setBusy('');
    setError('');
    setMark('');
    setRolled(false);
    setJustApplied(false);
    api(`/api/postings/${encodeURIComponent(id)}`).then(value => { if (!cancelled) setPosting(value); })
      .catch(failure => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [id]);

  async function act(name, work) {
    const own = () => shown.current === id;
    setBusy(name);
    setError('');
    try { await work(own); } catch (failure) { if (own()) { setError(failure.message); setMark(''); } } finally { if (own()) setBusy(''); }
  }
  const score = force => act('score', async own => {
    const updated = await api(`/api/postings/${encodeURIComponent(id)}/score`, { method: 'POST', body: { force } });
    if (own()) { setPosting(updated); setRolled(force); }
    onChanged(updated);
  });
  const setStatus = (status, done) => act(status, async own => {
    const updated = await api(`/api/postings/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
    if (own()) setPosting(updated);
    done?.();
    onChanged(updated, { removed: status === 'dismissed' || (mode === 'saved' && status !== 'saved'), restored: posting.status === 'dismissed' && status === 'new' });
    // Saving is the request to score in that mode; the server has queued it, and this waits for it.
    if (status === 'saved' && scoreMode === 'saved' && hasResume && !updated.score && own()) await score(false);
  });
  const apply = input => act('apply', async () => {
    await api(`/api/postings/${encodeURIComponent(id)}/apply`, { method: 'POST', body: input });
    emit('apply', { postingId: id });
    keyBump('applications');
    const updated = await api(`/api/postings/${encodeURIComponent(id)}`);
    setPosting(updated);
    setApplying(false);
    setJustApplied(true);
    onChanged(updated, { removed: true, applied: true });
  });
  // Saving: the bookmark fills at once and, once it is saved, a note flies into the Saved key. Unsaving drains it.
  const save = event => {
    const button = event.currentTarget;
    setMark('just');
    cue('fav');
    setStatus('saved', () => flyTo(button, 'saved'));
  };
  const unsave = () => {
    setMark('draining');
    cue('unfav');
    setStatus('new', () => keyBump('saved'));
  };
  const restore = () => { cue('restore'); setStatus('new'); };

  if (error && !posting) return <div className="detail-empty">{error}</div>;
  if (!posting) return <div className="detail-empty"><BeatLoader /></div>;
  const salary = salaryText(posting.salary);
  const facts = [jobTypeText(posting.jobType), posting.jobLevel, posting.isRemote ? t('远程', 'Remote') : null, posting.department, posting.jobFunction].filter(Boolean);
  return (
    <article className="posting-detail" key={posting.id}>
      <header>
        <div className="detail-title">
          <div className="logo large">{posting.companyLogo ? <img src={posting.companyLogo} alt="" referrerPolicy="no-referrer" /> : <span>{(posting.company || posting.title).slice(0, 1).toUpperCase()}</span>}</div>
          <div>
            <h2>{posting.title}</h2>
            <p className="detail-company">
              <span><Building2 size={14} />{posting.company || t('未知公司', 'Unknown company')}</span>
              {posting.location ? <span><MapPin size={14} />{posting.location}</span> : null}
              {salary ? <span><Wallet size={14} />{salary}</span> : null}
            </p>
            {facts.length ? <p className="facts">{facts.map(fact => <span key={fact}>{fact}</span>)}</p> : null}
          </div>
        </div>
        {posting.closedAt ? <p className="banner closed"><CalendarClock size={15} />{t(`这个岗位在 ${formatDay(posting.closedAt)} 被发现已关闭或下线。`, `This posting was found closed or taken down on ${formatDay(posting.closedAt)}.`)}</p> : null}
        <div className="detail-actions">
          {hasBrowser ? (
            <>
              <button className="button" data-fx="open" onClick={() => openInBrowser(posting.jobUrl, setView)}><Globe size={15} />{posting.site !== 'manual' ? t(`打开 ${label('site', posting.site)}`, `Open on ${label('site', posting.site)}`) : t('打开原帖', 'Open posting')}</button>
              {posting.applyUrl ? <button className="button" data-fx="open" onClick={() => openInBrowser(posting.applyUrl, setView)}><Globe size={15} />{t('公司申请页', 'Company apply page')}</button> : null}
              <a className="icon-button" data-fx="external" href={posting.applyUrl || posting.jobUrl} target="_blank" rel="noreferrer" title={t('用系统浏览器打开', 'Open in your browser')}><ExternalLink size={15} /></a>
            </>
          ) : (
            <>
              <a className="button" data-fx="external" href={posting.jobUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />{posting.site !== 'manual' ? t(`打开 ${label('site', posting.site)}`, `Open on ${label('site', posting.site)}`) : t('打开原帖', 'Open posting')}</a>
              {posting.applyUrl ? <a className="button" data-fx="external" href={posting.applyUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />{t('公司申请页', 'Company apply page')}</a> : null}
            </>
          )}
          {posting.application ? (
            <button className={`button primary${justApplied ? ' fx-draw' : ''}`} onClick={() => setView('applications')}><CircleCheck size={15} />{label('status', posting.application.status)} · {t('查看追踪', 'View tracking')}</button>
          ) : (
            <>
              {posting.status === 'saved'
                ? <button className="button" onClick={unsave} disabled={Boolean(busy)}><BookmarkIcon on mark={mark} />{t('已收藏', 'Saved')}</button>
                : <button className="button" onClick={save} disabled={Boolean(busy)}><BookmarkIcon mark={mark} />{t('收藏', 'Save')}</button>}
              {posting.status === 'dismissed'
                ? <button className="button" data-fx="rewind" onClick={restore} disabled={Boolean(busy)}><RotateCcw size={15} />{t('恢复', 'Restore')}</button>
                : <button className="button" data-fx="dismiss" onClick={() => setStatus('dismissed')} disabled={Boolean(busy)}><EyeOff size={15} />{t('不感兴趣', 'Not interested')}</button>}
              <button className="button primary" onClick={() => setApplying(true)} disabled={applying}><CircleCheck size={15} />{t('我已投递', 'I applied')}</button>
            </>
          )}
        </div>
        {applying ? <ApplyForm onApply={apply} onCancel={() => setApplying(false)} busy={busy === 'apply'} /> : null}
        {error ? <p className="notice error">{error}</p> : null}
      </header>
      <FactsLine posting={posting} />
      <ScoreCard score={posting.score} onScore={score} scoring={busy === 'score'} hasResume={hasResume} setView={setView} scoreMode={scoreMode} saved={posting.status === 'saved'} rolled={rolled} />
      <ResumeMatch match={posting.resumeMatch} />
      <section className="description">
        <h3>{t('职位描述', 'Job description')}</h3>
        {posting.description ? <Markdown text={posting.description} /> : <p className="hint">{t('这个来源没有提供完整描述。打开原帖查看。', 'This source does not include the full description. Open the posting to read it.')}</p>}
        {posting.emails?.length ? <p className="hint">{t('描述中的邮箱：', 'Emails in the description: ')}{posting.emails.join(t('，', ', '))}</p> : null}
      </section>
    </article>
  );
}
