import { dayKey, monthKey, monthWeeks, splitTarget } from './goal-weeks.mjs';
import { OPEN_APPLICATION_STATUSES } from './repository.mjs';

// The home page's numbers: how applications go week by week, how far they get,
// where they came from, and what needs attention now. Weeks run Monday to
// Sunday in local time, like the goals.
export const DASHBOARD_WEEKS = { min: 4, max: 26, default: 12 };

// Reaching a later stage implies the earlier ones; accepting implies an offer.
const STAGE_RANK = { applied: 0, oa: 1, interview: 2, offer: 3, accepted: 3 };
const REPLIES = ['oa', 'interview', 'offer', 'accepted', 'rejected'];
const DAY = 864e5;

const mondayOf = date => {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
};
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function createDashboard({ db, now = () => new Date() }) {
  const q = sql => db.prepare(sql);
  const count = (sql, ...params) => q(sql).get(...params).n;
  const appliedBetween = (start, end) => count('SELECT COUNT(*) AS n FROM applications WHERE applied_at >= ? AND applied_at < ?', start.toISOString(), end.toISOString());

  // Each calendar week's share of the monthly applications goals; a week that
  // spans two months adds up its part of each. Null when neither month has one.
  function weeklyTargets(weeks) {
    const monthsOf = week => [monthKey(week.start), monthKey(addDays(week.end, -1))];
    const withGoal = new Set();
    const pieces = new Map();
    for (const month of new Set(weeks.flatMap(monthsOf))) {
      const target = q("SELECT target FROM goals WHERE month = ? AND metric = 'applications'").get(month)?.target;
      if (!target) continue;
      withGoal.add(month);
      const { days, weeks: parts } = monthWeeks(month);
      splitTarget(target, parts, days).forEach((share, index) => pieces.set(dayKey(parts[index].start), share));
    }
    return weeks.map(week => {
      if (!monthsOf(week).some(month => withGoal.has(month))) return null;
      let total = 0;
      for (let day = week.start; day < week.end; day = addDays(day, 1)) total += pieces.get(dayKey(day)) || 0;
      return total;
    });
  }

  function report({ weeks: weekCount = DASHBOARD_WEEKS.default } = {}) {
    const today = now();
    const thisMonday = mondayOf(today);
    const first = addDays(thisMonday, -7 * (weekCount - 1));
    const weeks = Array.from({ length: weekCount }, (_, index) => ({ start: addDays(first, index * 7), end: addDays(first, index * 7 + 7) }));

    // Every application with the furthest stage it reached and when it first heard back.
    const applications = q(`SELECT a.id, a.status, a.applied_at, p.site FROM applications a LEFT JOIN postings p ON p.id = a.posting_id`).all();
    const events = q("SELECT application_id, to_status, at FROM application_events WHERE type = 'status' ORDER BY at").all();
    const history = new Map(applications.map(item => [item.id, { reached: STAGE_RANK[item.status] ?? 0, replied: null }]));
    for (const event of events) {
      const entry = history.get(event.application_id);
      if (!entry) continue;
      entry.reached = Math.max(entry.reached, STAGE_RANK[event.to_status] ?? 0);
      if (!entry.replied && REPLIES.includes(event.to_status)) entry.replied = event.at;
    }
    const reachedAtLeast = rank => applications.filter(item => history.get(item.id).reached >= rank).length;
    const replyDays = applications.map(item => history.get(item.id).replied && (Date.parse(history.get(item.id).replied) - Date.parse(item.applied_at)) / DAY)
      .filter(days => days !== null && days >= 0);

    const statuses = Object.fromEntries(['applied', 'oa', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted'].map(status => [status, 0]));
    for (const item of applications) statuses[item.status] = (statuses[item.status] || 0) + 1;

    const bySite = new Map();
    for (const item of applications) {
      const site = item.site || 'manual';
      const entry = bySite.get(site) || { site, applied: 0, interviews: 0, offers: 0 };
      const { reached } = history.get(item.id);
      entry.applied += 1;
      if (reached >= STAGE_RANK.oa) entry.interviews += 1;
      if (reached >= STAGE_RANK.offer) entry.offers += 1;
      bySite.set(site, entry);
    }

    // Per week: applications sent, and OAs or interviews reached (each stage once, as the goals count them).
    const targets = weeklyTargets(weeks);
    const interviewsBetween = (start, end) => count(`SELECT COUNT(DISTINCT application_id || ':' || to_status) AS n FROM application_events
      WHERE type = 'status' AND to_status IN ('oa', 'interview') AND at >= ? AND at < ?`, start.toISOString(), end.toISOString());
    const weekRows = weeks.map((week, index) => ({
      start: dayKey(week.start),
      end: dayKey(addDays(week.end, -1)),
      applied: appliedBetween(week.start, week.end),
      interviews: interviewsBetween(week.start, week.end),
      target: targets[index],
      current: index === weeks.length - 1,
    }));

    // Applications per local day, from the first week's Monday through today.
    const perDay = new Map();
    for (const item of applications) {
      if (Date.parse(item.applied_at) < first.getTime()) continue;
      const key = dayKey(new Date(item.applied_at));
      perDay.set(key, (perDay.get(key) || 0) + 1);
    }
    const days = [];
    for (let day = first; day <= today; day = addDays(day, 1)) days.push({ day: dayKey(day), applied: perDay.get(dayKey(day)) || 0 });

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    // Last month up to the same day and time, so the two are comparable mid-month.
    const lastMonthDays = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
    const sameTimeLastMonth = new Date(lastMonthStart.getFullYear(), lastMonthStart.getMonth(), Math.min(today.getDate(), lastMonthDays),
      today.getHours(), today.getMinutes(), today.getSeconds());
    const open = OPEN_APPLICATION_STATUSES.map(() => '?').join(', ');
    const soon = new Date(today.getTime() + 2 * DAY).toISOString();

    return {
      generatedAt: today.toISOString(),
      kpis: {
        appliedThisWeek: appliedBetween(thisMonday, addDays(thisMonday, 7)),
        appliedLastWeek: appliedBetween(addDays(thisMonday, -7), thisMonday),
        appliedThisMonth: appliedBetween(monthStart, new Date(today.getFullYear(), today.getMonth() + 1, 1)),
        appliedLastMonthSoFar: appliedBetween(lastMonthStart, sameTimeLastMonth),
        total: applications.length,
        open: applications.filter(item => OPEN_APPLICATION_STATUSES.includes(item.status)).length,
        replied: replyDays.length,
        interviewsReached: reachedAtLeast(STAGE_RANK.oa),
        offers: reachedAtLeast(STAGE_RANK.offer),
        medianReplyDays: replyDays.length ? Math.round(median(replyDays) * 10) / 10 : null,
        followUpsDue: count(`SELECT COUNT(*) AS n FROM applications WHERE status IN (${open}) AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= ?`,
          ...OPEN_APPLICATION_STATUSES, today.toISOString()),
        foundThisWeek: count('SELECT COUNT(*) AS n FROM postings WHERE duplicate_of IS NULL AND first_seen_at >= ?', thisMonday.toISOString()),
        newPostings: count("SELECT COUNT(*) AS n FROM postings WHERE status = 'new' AND duplicate_of IS NULL"),
        savedPostings: count("SELECT COUNT(*) AS n FROM postings WHERE status = 'saved' AND duplicate_of IS NULL"),
      },
      weeks: weekRows,
      days,
      funnel: { applied: applications.length, oa: reachedAtLeast(1), interview: reachedAtLeast(2), offer: reachedAtLeast(3) },
      statuses,
      sources: [...bySite.values()].sort((a, b) => b.applied - a.applied || a.site.localeCompare(b.site)),
      // Open applications with a flag or a follow-up due within two days.
      attention: q(`SELECT id, company, title, status, applied_at, status_changed_at, next_follow_up_at, flags FROM applications
        WHERE status IN (${open}) AND (flags <> '[]' OR (next_follow_up_at IS NOT NULL AND next_follow_up_at <= ?))
        ORDER BY next_follow_up_at IS NULL, next_follow_up_at, status_changed_at LIMIT 8`).all(...OPEN_APPLICATION_STATUSES, soon)
        .map(row => ({ id: row.id, company: row.company, title: row.title, status: row.status, appliedAt: row.applied_at, statusChangedAt: row.status_changed_at,
          nextFollowUpAt: row.next_follow_up_at, flags: JSON.parse(row.flags || '[]') })),
      recent: q(`SELECT e.application_id, e.at, e.from_status, e.to_status, e.source, a.company, a.title FROM application_events e
        JOIN applications a ON a.id = e.application_id WHERE e.type = 'status' ORDER BY e.at DESC, e.rowid DESC LIMIT 8`).all()
        .map(row => ({ applicationId: row.application_id, at: row.at, fromStatus: row.from_status, toStatus: row.to_status, source: row.source, company: row.company, title: row.title })),
      // The best-scoring open jobs not applied to yet.
      topPicks: q(`SELECT p.id, p.title, p.company, p.site, p.status, p.date_posted, p.first_seen_at, s.score FROM postings p
        JOIN scores s ON s.posting_id = p.id AND s.resume_id = p.resume_id
        WHERE p.status IN ('new', 'saved') AND p.duplicate_of IS NULL AND p.closed_at IS NULL
        ORDER BY s.score DESC, p.first_seen_at DESC LIMIT 5`).all()
        .map(row => ({ id: row.id, title: row.title, company: row.company, site: row.site, status: row.status, datePosted: row.date_posted, firstSeenAt: row.first_seen_at, score: row.score })),
    };
  }

  return { report };
}
