import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, memoryRepo } from './helpers.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { createDashboard } from '../server/jobs/dashboard.mjs';
import { createGoals } from '../server/jobs/goals.mjs';

// Local times, so the weeks line up whatever the test machine's timezone.
const local = (day, hour = 12) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`);

test('the home page counts weeks, stages, replies and boards', () => {
  const now = clock(local('2026-10-21'));
  const { db, repo } = memoryRepo(now);
  const dashboard = createDashboard({ db, now });
  const goals = createGoals({ db, repo, now });

  const empty = dashboard.report();
  assert.equal(empty.weeks.length, 12);
  assert.equal(empty.weeks[0].start, '2026-08-03', 'twelve Monday-to-Sunday weeks ending with this one');
  assert.deepEqual([empty.weeks.at(-1).start, empty.weeks.at(-1).end, empty.weeks.at(-1).current], ['2026-10-19', '2026-10-25', true]);
  assert.equal(empty.days.length, 80, 'every day from the first Monday through today');
  assert.deepEqual(empty.funnel, { applied: 0, oa: 0, interview: 0, offer: 0 });
  assert.equal(empty.kpis.medianReplyDays, null);
  assert.ok(empty.weeks.every(week => week.target === null), 'no goals, no weekly target');

  repo.addResume({ name: 'cv.txt', mime: 'text/plain', size: 1, text: 'Data scientist. Python, SQL, experimentation.' });
  const add = (site, externalId, title, company) => repo.upsertPosting(posting({ site, externalId, title, company, jobUrl: `https://example.com/${site}/${externalId}` }));
  add('linkedin', '1', 'Data Scientist', 'Acme');
  add('indeed', '2', 'Analyst', 'Birch');
  add('linkedin', '3', 'ML Engineer', 'Cedar');
  add('linkedin', '4', 'Data Engineer', 'Dune');
  add('linkedin', '5', 'Research Scientist', 'Elm');
  const score = (id, value) => repo.saveScore(id, db.prepare('SELECT resume_id FROM postings WHERE id = ?').get(id).resume_id,
    { score: value, verdict: 'good', summary: 'ok', provider: 'claude-cli' });
  score('li-3', 91);
  score('li-4', 70);
  score('li-5', 99);
  repo.setPostingStatus('li-4', 'saved');
  repo.setPostingStatus('li-5', 'dismissed');

  const apply = (day, fields = {}, hour = 12) => repo.createApplication({ company: fields.company || `Co ${day}`, title: 'Data Scientist', appliedAt: local(day, hour).toISOString(), followUpDays: 7, ...fields });
  const move = (application, status, day, hour = 12) => repo.updateApplication(application.id, { status, statusAt: local(day, hour).toISOString() });
  const a1 = apply('2026-10-20', { postingId: 'li-1', company: 'Acme' });
  move(a1, 'oa', '2026-10-21', 11);
  const a2 = apply('2026-10-13', { postingId: 'in-2', company: 'Birch' });
  move(a2, 'rejected', '2026-10-17');
  const a3 = apply('2026-10-06');
  move(a3, 'interview', '2026-10-14');
  move(a3, 'rejected', '2026-10-19');
  apply('2026-10-21', {}, 9);
  const a5 = apply('2026-09-29', { company: 'Quiet Co' });
  move(apply('2026-07-01'), 'ghosted', '2026-09-01');
  move(apply('2026-10-08'), 'offer', '2026-10-20');
  move(apply('2026-09-10'), 'withdrawn', '2026-09-12');
  goals.save('2026-09', [{ metric: 'applications', target: 30 }]);
  goals.save('2026-10', [{ metric: 'applications', target: 40 }]);

  const report = dashboard.report();
  assert.deepEqual(report.kpis, {
    appliedThisWeek: 2, appliedLastWeek: 1, appliedThisMonth: 5, appliedLastMonthSoFar: 1,
    total: 8, open: 4, replied: 4, interviewsReached: 3, offers: 1, medianReplyDays: 6, followUpsDue: 1,
    foundThisWeek: 5, newPostings: 1, savedPostings: 1,
  });
  assert.deepEqual(report.funnel, { applied: 8, oa: 3, interview: 2, offer: 1 }, 'a direct offer counts as every stage before it');
  assert.deepEqual(report.statuses, { applied: 2, oa: 1, interview: 0, offer: 1, accepted: 0, rejected: 2, withdrawn: 1, ghosted: 1 });

  const week = start => report.weeks.find(item => item.start === start);
  assert.deepEqual(week('2026-10-19'), { start: '2026-10-19', end: '2026-10-25', applied: 2, interviews: 1, target: 9, current: true });
  assert.deepEqual(week('2026-10-12'), { start: '2026-10-12', end: '2026-10-18', applied: 1, interviews: 1, target: 9, current: false });
  assert.equal(week('2026-10-05').applied, 2);
  assert.equal(week('2026-09-28').target, 8, 'three September days plus four October days: 3 + 5');
  assert.equal(week('2026-08-31').target, 6, 'only September has a goal in this week');
  assert.equal(week('2026-08-24').target, null);
  assert.equal(report.weeks.reduce((sum, item) => sum + item.applied, 0), 7, 'July is before the first week');
  assert.deepEqual(report.days.slice(-2), [{ day: '2026-10-20', applied: 1 }, { day: '2026-10-21', applied: 1 }]);

  assert.deepEqual(report.sources, [
    { site: 'manual', applied: 6, interviews: 2, offers: 1 },
    { site: 'indeed', applied: 1, interviews: 0, offers: 0 },
    { site: 'linkedin', applied: 1, interviews: 1, offers: 0 },
  ]);
  assert.deepEqual(report.attention.map(item => [item.id, item.company]), [[a5.id, 'Quiet Co']], 'the follow-up from September 29 is due');
  assert.deepEqual(report.recent.slice(0, 2).map(event => [event.company, event.fromStatus, event.toStatus]), [['Acme', 'applied', 'oa'], ['Co 2026-10-21', null, 'applied']]);
  assert.deepEqual(report.topPicks.map(item => [item.id, item.score, item.status]), [['li-3', 91, 'new'], ['li-4', 70, 'saved']], 'dismissed and applied jobs are left out');

  assert.equal(dashboard.report({ weeks: 4 }).weeks.length, 4);
  assert.equal(dashboard.report({ weeks: 4 }).days.length, 24);
});
