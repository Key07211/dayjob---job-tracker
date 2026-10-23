import { randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
import { dayKey, monthKey, monthWeeks, splitTarget } from './goal-weeks.mjs';

export { monthKey, monthWeeks, splitTarget };

// Monthly goals and their weekly share. A month's weeks run Monday to Sunday
// and are cut at the month's edges; each week gets the part of the monthly
// target that its days are of the month, rounded so the weeks add up.
// Applications and interviews are counted from Dayjob's own records; custom
// goals (practice problems, coffee chats…) count what the user logs.
export const GOAL_METRICS = ['applications', 'interviews', 'custom'];
export const MAX_GOALS = 8;

const goalRow = row => ({ id: row.id, month: row.month, metric: row.metric, name: row.name, target: row.target });

export function createGoals({ db, repo, now = () => new Date() }) {
  const q = sql => db.prepare(sql);
  const list = month => q('SELECT * FROM goals WHERE month = ? ORDER BY position, created_at').all(month).map(goalRow);
  const find = id => {
    const row = q('SELECT * FROM goals WHERE id = ?').get(id);
    return row ? goalRow(row) : null;
  };
  const sameGoal = (goal, item) => (item.metric === 'custom' ? goal.metric === 'custom' && goal.name.toLowerCase() === item.name.toLowerCase() : goal.metric === item.metric);

  // A new month starts with last month's goals, once; clearing them sticks.
  function carryInto(month) {
    const marker = `goalsStarted:${month}`;
    if (repo.getMeta(marker)) return;
    transaction(db, () => {
      if (!q('SELECT 1 FROM goals WHERE month = ? LIMIT 1').get(month)) {
        const previous = q('SELECT month FROM goals WHERE month < ? ORDER BY month DESC LIMIT 1').get(month)?.month;
        if (previous) list(previous).forEach((goal, position) => insert(month, goal, position));
      }
      repo.setMeta(marker, true);
    });
  }
  function insert(month, { metric, name, target }, position) {
    q('INSERT INTO goals (id, month, metric, name, target, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), month, metric, metric === 'custom' ? name : '', target, position, now().toISOString());
  }

  function progress(goal, start, end) {
    const range = [start.toISOString(), end.toISOString()];
    if (goal.metric === 'applications') return q('SELECT COUNT(*) AS n FROM applications WHERE applied_at >= ? AND applied_at < ?').get(...range).n;
    // Each application counts once per stage it reached: an OA, then an interview.
    if (goal.metric === 'interviews') {
      return q(`SELECT COUNT(DISTINCT application_id || ':' || to_status) AS n FROM application_events
        WHERE type = 'status' AND to_status IN ('oa', 'interview') AND at >= ? AND at < ?`).get(...range).n;
    }
    return q('SELECT COALESCE(SUM(amount), 0) AS n FROM goal_logs WHERE goal_id = ? AND at >= ? AND at < ?').get(goal.id, ...range).n;
  }

  function report(month) {
    const today = now();
    const current = monthKey(today);
    const key = month || current;
    if (key === current) carryInto(key);
    const { days, weeks } = monthWeeks(key);
    const elapsed = key < current ? days : key > current ? 0 : today.getDate();
    const thisWeek = weeks.findIndex(week => today >= week.start && today < week.end);
    const daysLeft = days - elapsed + (key === current ? 1 : 0);
    return {
      month: key,
      current: key === current,
      days,
      elapsedDays: elapsed,
      weeks: weeks.map((week, index) => ({ start: dayKey(week.start), end: dayKey(new Date(week.end.getTime() - 1)), days: week.days, current: index === thisWeek })),
      goals: list(key).map(goal => {
        const targets = splitTarget(goal.target, weeks, days);
        const done = weeks.map(week => progress(goal, week.start, week.end));
        const total = done.reduce((sum, value) => sum + value, 0);
        const expected = Math.round((goal.target * elapsed) / days);
        return {
          ...goal,
          done: total,
          expected,
          weeks: targets.map((target, index) => ({ target, done: done[index] })),
          thisWeek: thisWeek >= 0 ? { target: targets[thisWeek], done: done[thisWeek] } : null,
          // Behind the month's pace: how many a week the rest of the month needs.
          perWeekToFinish: total < expected && daysLeft > 0 ? Math.ceil(((goal.target - total) * 7) / daysLeft) : null,
        };
      }),
    };
  }

  // Replaces the month's goals: matching goals keep their logs, missing ones go.
  function save(month, items) {
    transaction(db, () => {
      const existing = list(month);
      const kept = new Set();
      items.forEach((item, position) => {
        const match = existing.find(goal => (item.id ? goal.id === item.id : sameGoal(goal, item)) && !kept.has(goal.id));
        if (match) {
          q('UPDATE goals SET name = ?, target = ?, position = ? WHERE id = ?').run(match.metric === 'custom' ? item.name : '', item.target, position, match.id);
          kept.add(match.id);
        } else insert(month, item, position);
      });
      for (const goal of existing) if (!kept.has(goal.id)) q('DELETE FROM goals WHERE id = ?').run(goal.id);
      repo.setMeta(`goalsStarted:${month}`, true);
    });
    return report(month);
  }

  // One goal at a time (for Claude): a target of 0 removes it.
  function set(month, item) {
    const key = month || monthKey(now());
    if (key === monthKey(now())) carryInto(key);
    const goals = list(key);
    const index = goals.findIndex(goal => sameGoal(goal, item));
    if (index < 0 && item.target > 0 && goals.length >= MAX_GOALS) throw new Error(`A month can have up to ${MAX_GOALS} goals.`);
    const next = index < 0 ? [...goals, item] : goals.map((goal, at) => (at === index ? { ...goal, target: item.target } : goal));
    return save(key, next.filter(goal => goal.target > 0));
  }

  function log(id, amount) {
    const goal = find(id);
    if (!goal) return null;
    if (goal.metric !== 'custom') throw new Error('Applications and interviews are counted automatically.');
    const total = q('SELECT COALESCE(SUM(amount), 0) AS n FROM goal_logs WHERE goal_id = ?').get(id).n;
    if (total + amount < 0) throw new Error('Nothing logged to take back.');
    // Logs for another month's goal land on that month's last moment or first, so they count there.
    const { weeks } = monthWeeks(goal.month);
    const at = Math.min(Math.max(now().getTime(), weeks[0].start.getTime()), weeks.at(-1).end.getTime() - 1);
    q('INSERT INTO goal_logs (id, goal_id, at, amount) VALUES (?, ?, ?, ?)').run(randomUUID(), id, new Date(at).toISOString(), amount);
    return report(goal.month);
  }

  return { report, save, set, log, find };
}
