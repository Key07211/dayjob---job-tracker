import { useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, LoaderCircle, Minus, Pencil, Plus, Target, Trash2 } from 'lucide-react';
import { api, query } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { splitTarget } from '../../server/jobs/goal-weeks.mjs';

const COLLAPSED_KEY = 'dayjob-goals-collapsed';
const MAX_GOALS = 8;

function shiftMonth(month, by) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(year, number - 1 + by, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
const dayOf = day => Number(day.slice(8));
const weekLabel = week => `${Number(week.start.slice(5, 7))}/${dayOf(week.start)}${week.start === week.end ? '' : `–${dayOf(week.end)}`}`;

function useGoalName() {
  const { t } = useI18n();
  return goal => (goal.metric === 'applications' ? t('投递', 'Applications') : goal.metric === 'interviews' ? t('面试 / OA', 'Interviews / OAs') : goal.name);
}

function Ring({ value, max }) {
  const radius = 17;
  const length = 2 * Math.PI * radius;
  const share = max ? Math.min(1, value / max) : value ? 1 : 0;
  return (
    <svg className={`goal-ring${share >= 1 ? ' done' : ''}`} viewBox="0 0 42 42" aria-hidden="true">
      <circle cx="21" cy="21" r={radius} className="track" />
      <circle cx="21" cy="21" r={radius} className="bar" strokeDasharray={length} strokeDashoffset={length * (1 - share)} transform="rotate(-90 21 21)" />
    </svg>
  );
}

// Bars are what was done each week; the dashed box behind each is that week's task.
function WeekChart({ weeks, data }) {
  const { t } = useI18n();
  const slot = 64;
  const height = 150;
  const top = 22;
  const bottom = 26;
  const plot = height - top - bottom;
  const max = Math.max(1, ...data.flatMap(item => [item.target, item.done]));
  const y = value => top + plot - (value / max) * plot;
  const currentIndex = weeks.findIndex(week => week.current);
  return (
    <svg className="week-chart" viewBox={`0 0 ${weeks.length * slot} ${height}`} role="img"
      aria-label={t(`每周完成：${data.map((item, index) => `${weekLabel(weeks[index])} ${item.done}/${item.target}`).join('，')}`,
        `By week: ${data.map((item, index) => `${weekLabel(weeks[index])} ${item.done} of ${item.target}`).join(', ')}`)}>
      <line x1="0" x2={weeks.length * slot} y1={top + plot} y2={top + plot} className="axis" />
      {data.map((item, index) => {
        const x = index * slot + slot / 2;
        const future = currentIndex >= 0 && index > currentIndex;
        const met = item.target > 0 && item.done >= item.target;
        return (
          <g key={weeks[index].start} className={`${weeks[index].current ? 'current' : ''}${future ? ' future' : ''}${met ? ' met' : ''}`}>
            {item.target ? <rect x={x - 15} y={y(item.target)} width="30" height={top + plot - y(item.target)} rx="4" className="target" /> : null}
            {item.done ? <rect x={x - 11} y={y(item.done)} width="22" height={top + plot - y(item.done)} rx="3" className="done" /> : null}
            <text x={x} y={Math.min(y(item.target), y(item.done)) - 6} className="value">{item.done}/{item.target}</text>
            <text x={x} y={height - 8} className="label">{weekLabel(weeks[index])}</text>
          </g>
        );
      })}
    </svg>
  );
}

function GoalEditor({ report, onSaved, onCancel }) {
  const { t } = useI18n();
  const existing = metric => report.goals.find(goal => goal.metric === metric);
  const [builtins, setBuiltins] = useState({ applications: String(existing('applications')?.target ?? ''), interviews: String(existing('interviews')?.target ?? '') });
  const [custom, setCustom] = useState(report.goals.filter(goal => goal.metric === 'custom').map(goal => ({ id: goal.id, name: goal.name, target: String(goal.target) })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const count = Object.values(builtins).filter(value => Number(value) > 0).length + custom.length;
  const preview = value => {
    const target = Number(value);
    if (!Number.isInteger(target) || target <= 0) return null;
    return t(`每周：${splitTarget(target, report.weeks, report.days).join(' · ')}`, `Weekly: ${splitTarget(target, report.weeks, report.days).join(' · ')}`);
  };
  const setRow = (index, patch) => setCustom(rows => rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  async function save(event) {
    event.preventDefault();
    setError('');
    const goals = [];
    for (const metric of ['applications', 'interviews']) {
      const target = Number(builtins[metric]);
      if (builtins[metric].trim() && (!Number.isInteger(target) || target < 0)) return setError(t('目标要填 0 以上的整数。', 'Targets must be whole numbers.'));
      if (target > 0) goals.push({ ...(existing(metric) ? { id: existing(metric).id } : {}), metric, target });
    }
    for (const row of custom) {
      const target = Number(row.target);
      if (!row.name.trim() && !row.target.trim()) continue;
      if (!row.name.trim()) return setError(t('自定义目标需要名字。', 'Custom goals need a name.'));
      if (!Number.isInteger(target) || target <= 0) return setError(t(`“${row.name.trim()}”的目标要填 1 以上的整数。`, `The target for “${row.name.trim()}” must be a whole number above 0.`));
      goals.push({ ...(row.id ? { id: row.id } : {}), metric: 'custom', name: row.name.trim(), target });
    }
    setSaving(true);
    try { onSaved(await api('/api/goals', { method: 'PUT', body: { month: report.month, goals } })); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }

  return (
    <form className="goal-editor" onSubmit={save}>
      <p className="hint">{t('填每月目标，Dayjob 按每周在本月的天数分成每周任务（周一到周日）。留空就是不设。',
        'Set monthly targets; Dayjob splits them into weekly tasks by how many of the month\'s days each week has (Monday to Sunday). Leave blank for none.')}</p>
      <div className="goal-rows">
        <label className="goal-row">
          <span><strong>{t('投递', 'Applications')}</strong><small>{t('点“我已投递”时自动计数', 'Counted when you mark a job applied')}</small></span>
          <input type="number" min={0} max={1000} inputMode="numeric" value={builtins.applications} onChange={event => setBuiltins(value => ({ ...value, applications: event.target.value }))} placeholder="—" />
          <em>{preview(builtins.applications)}</em>
        </label>
        <label className="goal-row">
          <span><strong>{t('面试 / OA', 'Interviews / OAs')}</strong><small>{t('投递追踪里改成在线测评或面试时自动计数', 'Counted when an application moves to assessment or interview')}</small></span>
          <input type="number" min={0} max={1000} inputMode="numeric" value={builtins.interviews} onChange={event => setBuiltins(value => ({ ...value, interviews: event.target.value }))} placeholder="—" />
          <em>{preview(builtins.interviews)}</em>
        </label>
        {custom.map((row, index) => (
          <div className="goal-row custom" key={row.id || `new-${index}`}>
            <span><input value={row.name} maxLength={60} onChange={event => setRow(index, { name: event.target.value })} placeholder={t('比如：刷题、联系校友', 'e.g. practice problems, coffee chats')} aria-label={t('目标名称', 'Goal name')} />
              <small>{t('在本周任务里点 +1 打卡', 'Log it with +1 in This week')}</small></span>
            <input type="number" min={1} max={1000} inputMode="numeric" value={row.target} onChange={event => setRow(index, { target: event.target.value })} placeholder="—" aria-label={t('每月目标', 'Monthly target')} />
            <em>{preview(row.target)}</em>
            <button type="button" className="icon-button" title={t('删除', 'Remove')} onClick={() => setCustom(rows => rows.filter((_, at) => at !== index))}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" onClick={() => setCustom(rows => [...rows, { name: '', target: '' }])} disabled={count >= MAX_GOALS}><Plus size={15} />{t('添加自定义目标', 'Add a custom goal')}</button>
        <span className="spacer" />
        <button type="button" className="button" onClick={onCancel}>{t('取消', 'Cancel')}</button>
        <button type="submit" className="button primary" disabled={saving}>{saving ? <LoaderCircle size={15} className="spin" /> : null}{t('保存', 'Save')}</button>
      </div>
    </form>
  );
}

function paceText(goal, report, t) {
  if (goal.done >= goal.target) return [t('本月目标已完成', 'Done for the month'), 'ahead'];
  if (!report.current) return report.elapsedDays ? [t(`还差 ${goal.target - goal.done}`, `${goal.target - goal.done} short`), 'behind'] : [t('还没开始', 'Not started'), ''];
  if (goal.done >= goal.expected) return [goal.done > goal.expected ? t(`比进度多 ${goal.done - goal.expected}`, `${goal.done - goal.expected} ahead of pace`) : t('进度正常', 'On pace'), 'ahead'];
  return [t(`落后 ${goal.expected - goal.done}，之后每周约 ${goal.perWeekToFinish} 个能追上`, `${goal.expected - goal.done} behind; about ${goal.perWeekToFinish} a week catches up`), 'behind'];
}

// The home page's goals: this week's tasks, the month so far, and each week.
export function GoalsPanel({ version }) {
  const { t, lang } = useI18n();
  const goalName = useGoalName();
  const [month, setMonth] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [chartGoal, setChartGoal] = useState(null);
  const [busy, setBusy] = useState('');
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; } });

  useEffect(() => {
    let cancelled = false;
    api(`/api/goals${query({ month })}`).then(value => { if (!cancelled) { setReport(value); setError(''); } })
      .catch(failure => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [month, version]);

  function toggle() {
    setCollapsed(value => {
      try { localStorage.setItem(COLLAPSED_KEY, value ? '0' : '1'); } catch { /* per-viewer convenience only */ }
      return !value;
    });
  }
  async function logProgress(goal, amount) {
    setBusy(goal.id);
    try { setReport(await api(`/api/goals/${encodeURIComponent(goal.id)}/log`, { method: 'POST', body: { amount } })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  if (!report) return error ? <p className="notice error">{error}</p> : null;
  const [year, number] = report.month.split('-').map(Number);
  const title = lang === 'zh' ? `${year} 年 ${number} 月目标` : `${new Date(year, number - 1, 1).toLocaleString('en-US', { month: 'long' })} ${year} goals`;
  const week = report.weeks.find(item => item.current);
  const shown = report.goals.find(goal => goal.id === chartGoal) || report.goals[0];
  const first = report.goals[0];

  return (
    <section className={`goals-panel${collapsed ? ' collapsed' : ''}`} aria-label={title}>
      <header className="goals-head">
        <h2><Target size={17} />{title}</h2>
        <div className="month-switch">
          <button className="icon-button" title={t('上个月', 'Previous month')} onClick={() => { setEditing(false); setMonth(shiftMonth(report.month, -1)); }}><ChevronLeft size={16} /></button>
          {!report.current ? <button className="link" onClick={() => { setEditing(false); setMonth(null); }}>{t('回到本月', 'This month')}</button> : null}
          <button className="icon-button" title={t('下个月', 'Next month')} onClick={() => { setEditing(false); setMonth(shiftMonth(report.month, 1)); }}><ChevronRight size={16} /></button>
        </div>
        {collapsed && first && week && first.thisWeek ? <span className="goals-summary">{t(`本周${goalName(first)} ${first.thisWeek.done}/${first.thisWeek.target}`, `This week: ${goalName(first)} ${first.thisWeek.done}/${first.thisWeek.target}`)}</span> : null}
        <span className="spacer" />
        {!collapsed && !editing ? <button className="button" onClick={() => setEditing(true)}><Pencil size={14} />{report.goals.length ? t('设置目标', 'Edit goals') : t('设定目标', 'Set goals')}</button> : null}
        <button className="icon-button" title={collapsed ? t('展开', 'Show') : t('收起', 'Hide')} onClick={toggle}>{collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</button>
      </header>
      {error ? <p className="notice error">{error}</p> : null}
      {collapsed ? null : editing ? (
        <GoalEditor key={report.month} report={report} onCancel={() => setEditing(false)} onSaved={value => { setReport(value); setEditing(false); }} />
      ) : !report.goals.length ? (
        <div className="goals-empty">
          <p>{t('设定每月想投递多少份、拿到几次面试，或者自己的目标（比如刷题），Dayjob 会分成每周任务，并在这里画出进度。',
            'Set how many applications and interviews you want this month, or a goal of your own such as practice problems. Dayjob splits it into weekly tasks and charts the progress here.')}</p>
          <button className="button primary" onClick={() => setEditing(true)}><Target size={15} />{t('设定目标', 'Set goals')}</button>
        </div>
      ) : (
        <div className="goal-grid">
          {report.current && week ? (
            <div className="goal-card">
              <h3>{t('本周任务', 'This week')}<span>{weekLabel(week)}</span></h3>
              <ul className="goal-tasks">
                {report.goals.map(goal => (
                  <li key={goal.id}>
                    <Ring value={goal.thisWeek.done} max={goal.thisWeek.target} />
                    <div>
                      <strong>{goalName(goal)}</strong>
                      <span>{goal.thisWeek.done} / {goal.thisWeek.target}{' · '}{!goal.thisWeek.target && !goal.thisWeek.done ? t('本周没有任务', 'nothing due this week')
                        : goal.thisWeek.done >= goal.thisWeek.target ? t('完成', 'done') : t(`还差 ${goal.thisWeek.target - goal.thisWeek.done}`, `${goal.thisWeek.target - goal.thisWeek.done} to go`)}</span>
                    </div>
                    {goal.metric === 'custom' ? (
                      <div className="goal-log">
                        <button className="icon-button" title={t('撤回一次', 'Take one back')} onClick={() => logProgress(goal, -1)} disabled={busy === goal.id || !goal.done}><Minus size={14} /></button>
                        <button className="icon-button" title={t('完成一次', 'Log one')} onClick={() => logProgress(goal, 1)} disabled={busy === goal.id}><Plus size={14} /></button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="goal-card">
            <h3>{t('本月进度', 'This month')}<span>{report.current ? t(`第 ${report.elapsedDays} / ${report.days} 天`, `Day ${report.elapsedDays} of ${report.days}`) : t(`${report.days} 天`, `${report.days} days`)}</span></h3>
            {report.goals.map(goal => {
              const [pace, tone] = paceText(goal, report, t);
              return (
                <div className="goal-bar" key={goal.id}>
                  <div className="goal-bar-head"><strong>{goalName(goal)}</strong><span>{goal.done} / {goal.target}</span></div>
                  <div className="goal-track">
                    <div className="goal-fill" style={{ width: `${Math.min(100, (goal.done / goal.target) * 100)}%` }} />
                    {report.current && goal.expected < goal.target ? <i className="goal-pace" style={{ left: `${(goal.expected / goal.target) * 100}%` }} title={t(`按进度今天应到 ${goal.expected}`, `On pace: ${goal.expected} by today`)} /> : null}
                  </div>
                  <small className={tone}>{pace}</small>
                </div>
              );
            })}
          </div>
          <div className="goal-card chart">
            <h3>{t('每周完成', 'By week')}
              {report.goals.length > 1 ? (
                <select value={shown.id} onChange={event => setChartGoal(event.target.value)} aria-label={t('图表显示的目标', 'Goal shown in the chart')}>
                  {report.goals.map(goal => <option key={goal.id} value={goal.id}>{goalName(goal)}</option>)}
                </select>
              ) : <span>{goalName(shown)}</span>}
            </h3>
            <WeekChart weeks={report.weeks} data={shown.weeks} />
            <p className="chart-legend"><i className="done" />{t('完成', 'Done')}<i className="target" />{t('每周任务', 'Weekly task')}</p>
          </div>
        </div>
      )}
    </section>
  );
}
