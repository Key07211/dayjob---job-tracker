import { useEffect, useRef, useState } from 'react';
import { BellRing, ChartColumn, Flame, Ghost, History, LoaderCircle, RefreshCw, Sparkles, Table2 } from 'lucide-react';
import { api } from '../api.js';
import { dateLine, formatDay, label, relativeDay } from './format.js';
import { useI18n } from '../i18n.jsx';
import { ScoreBadge } from './ScoreBadge.jsx';
import { GoalsPanel } from './GoalsPanel.jsx';

const FUNNEL = ['applied', 'oa', 'interview', 'offer'];
const OPEN = ['applied', 'oa', 'interview', 'offer'];
const CLOSED = ['accepted', 'rejected', 'withdrawn', 'ghosted'];

const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const shortDay = day => `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`;
const weekRange = week => `${shortDay(week.start)}–${shortDay(week.end)}`;
const asDate = day => new Date(`${day}T12:00:00`);

// A bar with rounded top corners, standing on the baseline.
function barPath(x, y, width, height) {
  const radius = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`;
}
// The axis top and its ticks: at most four steps of 1, 2 or 5 times a power of ten.
function scale(max) {
  const value = Math.max(1, max);
  const step = [1, 10, 100, 1000].flatMap(power => [1, 2, 5].map(factor => factor * power)).find(size => value / size <= 4) || 1000;
  const top = Math.ceil(value / step) * step;
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, index) => index * step) };
}

// Hover details for a chart: the box is the positioned parent of the tip.
function useTip() {
  const box = useRef(null);
  const [tip, setTip] = useState(null);
  const show = (event, lines, key) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, lines, key });
  };
  return { box, tip, show, hide: () => setTip(null) };
}
function Tip({ tip }) {
  if (!tip) return null;
  return (
    <div className="chart-tip" style={{ left: Math.min(Math.max(tip.x, 80), tip.width - 80), top: tip.y }} role="status">
      {tip.lines.map((line, index) => (index ? <span key={index}>{line}</span> : <strong key={index}>{line}</strong>))}
    </div>
  );
}

function Tile({ title, value, detail, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`kpi${onClick ? ' clickable' : ''}`} onClick={onClick}>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </Tag>
  );
}

function Kpis({ kpis, setView }) {
  const { t } = useI18n();
  const replyRate = percent(kpis.replied, kpis.total);
  const interviewRate = percent(kpis.interviewsReached, kpis.total);
  return (
    <div className="kpi-row">
      <Tile title={t('本周投递', 'Applied this week')} value={kpis.appliedThisWeek} detail={t(`上周 ${kpis.appliedLastWeek}`, `Last week: ${kpis.appliedLastWeek}`)} />
      <Tile title={t('本月投递', 'Applied this month')} value={kpis.appliedThisMonth} detail={t(`上月同期 ${kpis.appliedLastMonthSoFar}`, `Same point last month: ${kpis.appliedLastMonthSoFar}`)} />
      <Tile title={t('进行中', 'Active')} value={kpis.open} detail={t(`共 ${kpis.total} 份投递`, `${kpis.total} applications in all`)} onClick={() => setView('applications')} />
      <Tile title={t('回复率', 'Reply rate')} value={kpis.total ? `${replyRate}%` : '—'}
        detail={kpis.medianReplyDays === null ? t('还没有收到回复', 'No replies yet') : t(`一般 ${kpis.medianReplyDays} 天回复`, `Typical reply in ${kpis.medianReplyDays} ${kpis.medianReplyDays === 1 ? 'day' : 'days'}`)} />
      <Tile title={t('测评 / 面试率', 'OA / interview rate')} value={kpis.total ? `${interviewRate}%` : '—'}
        detail={t(`${kpis.interviewsReached} 份 · Offer ${kpis.offers}`, `${kpis.interviewsReached} reached · ${kpis.offers} ${kpis.offers === 1 ? 'offer' : 'offers'}`)} />
      <Tile title={t('待看新岗位', 'New jobs')} value={kpis.newPostings} detail={t(`本周抓到 ${kpis.foundThisWeek} · 收藏 ${kpis.savedPostings}`, `${kpis.foundThisWeek} this week · ${kpis.savedPostings} saved`)} onClick={() => setView('feed')} />
    </div>
  );
}

// Applications and interviews each week, with the weekly goal as a dashed box behind applications.
function TrendChart({ weeks }) {
  const { t } = useI18n();
  const [asTable, setAsTable] = useState(false);
  const { box, tip, show, hide } = useTip();
  const width = 640;
  const height = 210;
  const left = 30;
  const top = 18;
  const bottom = 26;
  const plot = height - top - bottom;
  const slot = (width - left) / weeks.length;
  const bar = Math.min(16, slot * 0.28);
  const hasTarget = weeks.some(week => week.target !== null);
  const { top: max, ticks } = scale(Math.max(...weeks.flatMap(week => [week.applied, week.interviews, week.target || 0])));
  const y = value => top + plot - (value / max) * plot;
  const everyOther = weeks.length > 13;
  const total = weeks.reduce((sum, week) => sum + week.applied, 0);
  const lines = week => [weekRange(week), t(`投递 ${week.applied}${week.target !== null ? ` / 目标 ${week.target}` : ''}`, `Applied ${week.applied}${week.target !== null ? ` of ${week.target}` : ''}`),
    t(`测评 / 面试 ${week.interviews}`, `OAs / interviews ${week.interviews}`)];

  return (
    <section className="home-card wide">
      <header>
        <h2>{t(`近 ${weeks.length} 周投递`, `Last ${weeks.length} weeks`)}<span>{t(`共 ${total} 份`, `${total} applied`)}</span></h2>
        <button className="icon-button" title={asTable ? t('看图表', 'Show chart') : t('看表格', 'Show table')} onClick={() => setAsTable(value => !value)}>
          {asTable ? <ChartColumn size={16} /> : <Table2 size={16} />}
        </button>
      </header>
      {asTable ? (
        <div className="table-scroll">
          <table className="home-table">
            <thead><tr><th>{t('周', 'Week')}</th><th>{t('投递', 'Applied')}</th>{hasTarget ? <th>{t('每周目标', 'Weekly goal')}</th> : null}<th>{t('测评 / 面试', 'OAs / interviews')}</th></tr></thead>
            <tbody>{[...weeks].reverse().map(week => (
              <tr key={week.start} className={week.current ? 'current' : undefined}><td>{weekRange(week)}</td><td>{week.applied}</td>{hasTarget ? <td>{week.target ?? '—'}</td> : null}<td>{week.interviews}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="chart-box" ref={box} onMouseLeave={hide}>
          <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img"
            aria-label={t(`每周投递：${weeks.map(week => `${weekRange(week)} ${week.applied}`).join('，')}`, `Applications by week: ${weeks.map(week => `${weekRange(week)} ${week.applied}`).join(', ')}`)}>
            {ticks.map(tick => (
              <g key={tick}>
                <line x1={left} x2={width} y1={y(tick)} y2={y(tick)} className={tick ? 'grid' : 'axis'} />
                <text x={left - 8} y={y(tick) + 4} className="tick">{tick}</text>
              </g>
            ))}
            {weeks.map((week, index) => {
              const center = left + index * slot + slot / 2;
              const hovered = tip?.key === week.start;
              return (
                <g key={week.start} className={`${week.current ? 'current' : ''}${hovered ? ' hovered' : ''}`}>
                  {week.target ? <rect x={center - bar - 4} y={y(week.target)} width={bar + 6} height={top + plot - y(week.target)} rx="4" className="target" /> : null}
                  {week.applied ? <path d={barPath(center - bar - 1, y(week.applied), bar, top + plot - y(week.applied))} className="applied" /> : null}
                  {week.interviews ? <path d={barPath(center + 1, y(week.interviews), bar, top + plot - y(week.interviews))} className="interviews" /> : null}
                  {week.current || hovered ? <text x={center - bar / 2 - 1} y={Math.min(y(week.applied), week.target ? y(week.target) : height) - 6} className="value">{week.applied}</text> : null}
                  {!everyOther || index % 2 === weeks.length % 2 ? <text x={center} y={height - 8} className="label">{shortDay(week.start)}</text> : null}
                  <rect x={center - slot / 2} y={top} width={slot} height={plot} className="hit"
                    onMouseMove={event => show(event, lines(week), week.start)} />
                </g>
              );
            })}
          </svg>
          <Tip tip={tip} />
        </div>
      )}
      <p className="chart-legend">
        <i className="applied" />{t('投递', 'Applied')}
        <i className="interviews" />{t('进入测评 / 面试', 'Reached OA / interview')}
        {hasTarget ? <><i className="target" />{t('每周目标', 'Weekly goal')}</> : null}
      </p>
    </section>
  );
}

function FunnelCard({ funnel, statuses }) {
  const { t } = useI18n();
  const closed = [['rejected', statuses.rejected], ['ghosted', statuses.ghosted], ['withdrawn', statuses.withdrawn]].filter(([, value]) => value);
  return (
    <section className="home-card">
      <header><h2>{t('投递漏斗', 'Funnel')}<span>{t('走到过的最远一步', 'Furthest stage reached')}</span></h2></header>
      {!funnel.applied ? <p className="hint">{t('还没有投递记录。在岗位详情里点“我已投递”后，这里会显示每一步的转化。', 'No applications yet. Once you mark jobs applied, each stage\'s conversion shows here.')}</p> : (
        <>
          <ol className="funnel-bars">
            {FUNNEL.map((stage, index) => (
              <li key={stage}>
                <span className="name">{index === 0 ? t('投递', 'Applied') : label('status', stage)}</span>
                <span className="track"><i style={{ width: `${Math.max(funnel[stage] ? 2 : 0, percent(funnel[stage], funnel.applied))}%` }} /></span>
                <span className="count"><strong>{funnel[stage]}</strong>{index ? <small>{percent(funnel[stage], funnel.applied)}%</small> : null}</span>
              </li>
            ))}
          </ol>
          <ul className="step-rates">
            {FUNNEL.slice(1).map((stage, index) => {
              const from = FUNNEL[index];
              return (
                <li key={stage}><span>{index === 0 ? t('投递', 'Applied') : label('status', from)} → {label('status', stage)}</span>
                  <strong>{funnel[from] ? `${percent(funnel[stage], funnel[from])}%` : '—'}</strong></li>
              );
            })}
          </ul>
          {closed.length ? <p className="hint">{closed.map(([status, value]) => `${label('status', status)} ${value}`).join(' · ')}</p> : null}
        </>
      )}
    </section>
  );
}

// One square per day, Monday at the top; darker means more applications.
function Heatmap({ days }) {
  const { t, lang } = useI18n();
  const { box, tip, show, hide } = useTip();
  const cell = 13;
  const gap = 3;
  const leftPad = lang === 'zh' ? 22 : 30;
  const topPad = 16;
  const columns = Math.ceil(days.length / 7);
  const max = Math.max(0, ...days.map(day => day.applied));
  const level = value => (!value ? 0 : max <= 4 ? value : Math.min(4, Math.ceil((value / max) * 4)));
  const total = days.reduce((sum, day) => sum + day.applied, 0);
  const active = days.filter(day => day.applied).length;
  let streak = 0;
  for (let index = days.length - 1 - (days.at(-1)?.applied ? 0 : 1); index >= 0 && days[index].applied; index -= 1) streak += 1;
  const weekdays = lang === 'zh' ? ['一', '', '三', '', '五', '', ''] : ['Mon', '', 'Wed', '', 'Fri', '', ''];
  const dayText = day => {
    const date = asDate(day.day);
    const weekday = date.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short' });
    return `${formatDay(day.day)} ${weekday}`;
  };

  return (
    <section className="home-card">
      <header><h2><Flame size={15} />{t('每日投递', 'Daily applications')}</h2></header>
      <div className="chart-box heatmap-box" ref={box} onMouseLeave={hide}>
        <svg className="heatmap" viewBox={`0 0 ${leftPad + columns * (cell + gap)} ${topPad + 7 * (cell + gap)}`} role="img"
          aria-label={t(`近 ${columns} 周每天的投递数，共 ${total} 份`, `Applications per day over ${columns} weeks, ${total} in all`)}>
          {weekdays.map((name, row) => (name ? <text key={row} x={0} y={topPad + row * (cell + gap) + cell - 2} className="weekday">{name}</text> : null))}
          {days.map((day, index) => {
            const column = Math.floor(index / 7);
            const row = index % 7;
            const date = asDate(day.day);
            return (
              <g key={day.day}>
                {date.getDate() <= 7 && row === 0 ? (
                  <text x={leftPad + column * (cell + gap)} y={10} className="month">{lang === 'zh' ? `${date.getMonth() + 1}月` : date.toLocaleDateString('en-US', { month: 'short' })}</text>
                ) : null}
                <rect x={leftPad + column * (cell + gap)} y={topPad + row * (cell + gap)} width={cell} height={cell} rx="3"
                  className={`level-${level(day.applied)}${tip?.key === day.day ? ' hovered' : ''}`}
                  onMouseMove={event => show(event, [dayText(day), t(`投递 ${day.applied}`, `${day.applied} applied`)], day.day)} />
              </g>
            );
          })}
        </svg>
        <Tip tip={tip} />
      </div>
      <p className="heat-legend"><span>{t('少', 'Less')}</span>{[0, 1, 2, 3, 4].map(step => <i key={step} className={`level-${step}`} />)}<span>{t('多', 'More')}</span></p>
      <p className="hint">{t(`共 ${total} 份 · ${active} 天有投递${streak > 1 ? ` · 已连续 ${streak} 天` : ''}`,
        `${total} applied · on ${active} ${active === 1 ? 'day' : 'days'}${streak > 1 ? ` · ${streak}-day streak` : ''}`)}</p>
    </section>
  );
}

function StatusCard({ statuses }) {
  const { t } = useI18n();
  const open = OPEN.reduce((sum, status) => sum + statuses[status], 0);
  const closed = CLOSED.reduce((sum, status) => sum + statuses[status], 0);
  const total = open + closed;
  return (
    <section className="home-card">
      <header><h2>{t('当前状态', 'Where they stand')}<span>{t(`${total} 份`, `${total} in all`)}</span></h2></header>
      {!total ? <p className="hint">{t('还没有投递记录。', 'No applications yet.')}</p> : (
        <>
          <div className="split-bar" role="img" aria-label={t(`进行中 ${open}，已结束 ${closed}`, `${open} active, ${closed} closed`)}>
            {open ? <i className="open" style={{ flexGrow: open }} /> : null}
            {closed ? <i className="closed" style={{ flexGrow: closed }} /> : null}
          </div>
          <div className="status-columns">
            {[[t('进行中', 'Active'), OPEN, open], [t('已结束', 'Closed'), CLOSED, closed]].map(([title, list, sum]) => (
              <div key={title}>
                <h3><i className={list === OPEN ? 'open' : 'closed'} />{title}<span>{sum} · {percent(sum, total)}%</span></h3>
                <ul>{list.map(status => <li key={status}><span>{label('status', status)}</span><strong>{statuses[status]}</strong></li>)}</ul>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function SourcesCard({ sources }) {
  const { t } = useI18n();
  return (
    <section className="home-card">
      <header><h2>{t('来源效果', 'By job board')}<span>{t('哪里投的、哪里回得多', 'Where you applied and what came of it')}</span></h2></header>
      {!sources.length ? <p className="hint">{t('还没有投递记录。', 'No applications yet.')}</p> : (
        <div className="table-scroll">
          <table className="home-table">
            <thead><tr><th>{t('来源', 'Board')}</th><th>{t('投递', 'Applied')}</th><th>{t('测评 / 面试率', 'OA / interview rate')}</th><th>Offer</th></tr></thead>
            <tbody>{sources.map(row => (
              <tr key={row.site}>
                <td>{label('site', row.site)}</td>
                <td>{row.applied}</td>
                <td><span className="rate"><i style={{ width: `${percent(row.interviews, row.applied)}%` }} /></span>{percent(row.interviews, row.applied)}%<small> ({row.interviews})</small></td>
                <td>{row.offers}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AttentionCard({ items, due, openItem }) {
  const { t } = useI18n();
  const reason = item => {
    if (item.flags.includes('ghost-suspected')) return [<Ghost key="icon" size={13} />, label('flag', 'ghost-suspected')];
    if (item.flags.includes('follow-up-due') || (item.nextFollowUpAt && new Date(item.nextFollowUpAt) <= new Date())) return [<BellRing key="icon" size={13} />, label('flag', 'follow-up-due')];
    return [<BellRing key="icon" size={13} />, t(`${formatDay(item.nextFollowUpAt)}跟进`, `Follow up ${formatDay(item.nextFollowUpAt)}`)];
  };
  return (
    <section className="home-card">
      <header><h2><BellRing size={15} />{t('需要跟进', 'Needs a follow-up')}<span>{t(`${due} 个已到期`, `${due} due`)}</span></h2></header>
      {!items.length ? <p className="hint">{t('现在没有要跟进的投递。', 'Nothing to follow up on right now.')}</p> : (
        <ul className="home-list">
          {items.map(item => {
            const [icon, text] = reason(item);
            return (
              <li key={item.id}><button onClick={() => openItem('applications', item.id)}>
                <span className="item-main"><strong>{item.company}</strong><small>{item.title}</small></span>
                <span className="item-side"><span className={`status-pill ${item.status}`}>{label('status', item.status)}</span><small className="flag">{icon}{text}</small></span>
              </button></li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function RecentCard({ events, openItem }) {
  const { t } = useI18n();
  return (
    <section className="home-card">
      <header><h2><History size={15} />{t('最近动态', 'Recent changes')}</h2></header>
      {!events.length ? <p className="hint">{t('投递和状态变化会出现在这里。', 'Applications and status changes show up here.')}</p> : (
        <ul className="home-list">
          {events.map(event => (
            <li key={`${event.applicationId}-${event.at}-${event.toStatus}`}><button onClick={() => openItem('applications', event.applicationId)}>
              <span className="item-main"><strong>{event.company}</strong>
                <small>{event.fromStatus ? `${label('status', event.fromStatus)} → ${label('status', event.toStatus)}` : t('已投递', 'Applied')}{event.source !== 'user' ? ` · ${label('source', event.source)}` : ''}</small></span>
              <span className="item-side"><small>{relativeDay(event.at)}</small></span>
            </button></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PicksCard({ picks, openItem }) {
  const { t } = useI18n();
  return (
    <section className="home-card">
      <header><h2><Sparkles size={15} />{t('高分还没投', 'Best matches to apply to')}</h2></header>
      {!picks.length ? <p className="hint">{t('打过分的新岗位里，匹配度最高的会出现在这里。', 'The best-scoring new jobs show up here once jobs are scored.')}</p> : (
        <ul className="home-list">
          {picks.map(item => (
            <li key={item.id}><button onClick={() => openItem('feed', item.id)}>
              <ScoreBadge score={{ score: item.score }} compact />
              <span className="item-main"><strong>{item.title}</strong><small>{item.company}{item.status === 'saved' ? t(' · 已收藏', ' · saved') : ''}</small></span>
              <span className="item-side"><small>{item.datePosted ? t(`${relativeDay(item.datePosted)}发布`, `Posted ${relativeDay(item.datePosted)}`) : label('site', item.site)}</small></span>
            </button></li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomeView({ dataVersion, setView, openItem }) {
  const { t, locale } = useI18n();
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api('/api/dashboard').then(value => { if (!cancelled) { setReport(value); setError(''); } })
      .catch(failure => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [dataVersion, reloadKey]);

  return (
    <section className="home">
      <header className="view-header">
        <div className="title-block">
          <p className="view-date">{dateLine(locale)}{report ? t(` · 本周已投递 ${report.kpis.appliedThisWeek} 份`, ` · ${report.kpis.appliedThisWeek} applied this week`) : ''}</p>
          <h1>{t('主页', 'Home')}</h1>
        </div>
        <div className="header-actions"><button className="icon-button" title={t('刷新', 'Refresh')} onClick={() => setReloadKey(key => key + 1)}><RefreshCw size={16} /></button></div>
      </header>
      {error ? <p className="notice error">{error}</p> : null}
      {!report ? (error ? null : <div className="list-empty"><LoaderCircle className="spin" /></div>) : (
        <>
          <Kpis kpis={report.kpis} setView={setView} />
          <GoalsPanel version={dataVersion + reloadKey} />
          <div className="home-grid">
            <TrendChart weeks={report.weeks} />
            <FunnelCard funnel={report.funnel} statuses={report.statuses} />
            <Heatmap days={report.days} />
            <StatusCard statuses={report.statuses} />
            <SourcesCard sources={report.sources} />
            <AttentionCard items={report.attention} due={report.kpis.followUpsDue} openItem={openItem} />
            <RecentCard events={report.recent} openItem={openItem} />
            <PicksCard picks={report.topPicks} openItem={openItem} />
          </div>
        </>
      )}
    </section>
  );
}
