import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, memoryRepo } from './helpers.mjs';
import { createGoals, monthWeeks, splitTarget } from '../server/jobs/goals.mjs';

// Local times, so the weeks line up whatever the test machine's timezone.
const local = (day, hour = 12) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`);

test('a monthly target is split into Monday-to-Sunday weeks by their days', () => {
  const october = monthWeeks('2026-10');
  assert.equal(october.days, 31);
  assert.deepEqual(october.weeks.map(week => week.days), [4, 7, 7, 7, 6], 'October 2026 starts on a Thursday');
  assert.equal(october.weeks[1].start.getDay(), 1);
  assert.deepEqual(splitTarget(40, october.weeks, 31), [5, 9, 9, 9, 8]);
  const february = monthWeeks('2027-02');
  assert.deepEqual(february.weeks.map(week => week.days), [7, 7, 7, 7]);
  assert.deepEqual(splitTarget(10, february.weeks, 28), [3, 3, 2, 2]);
  for (const target of [1, 3, 7, 13, 100]) assert.equal(splitTarget(target, october.weeks, 31).reduce((a, b) => a + b, 0), target);
});

test('goals count applications, interviews and logged work by week', () => {
  const now = clock(local('2026-10-21'));
  const { db, repo } = memoryRepo(now);
  const goals = createGoals({ db, repo, now });
  const apply = day => repo.createApplication({ company: `Co ${day}`, title: 'Data Scientist', appliedAt: local(day).toISOString(), followUpDays: 7 });
  ['2026-10-02', '2026-10-06', '2026-10-07', '2026-10-13', '2026-10-20', '2026-10-21'].forEach(apply);
  apply('2026-09-30');
  const interviewing = apply('2026-10-08');
  repo.updateApplication(interviewing.id, { status: 'oa', statusAt: local('2026-10-14').toISOString() });
  repo.updateApplication(interviewing.id, { status: 'interview', statusAt: local('2026-10-20').toISOString() });

  assert.deepEqual(goals.report().goals, [], 'no goals yet');
  let report = goals.save('2026-10', [{ metric: 'applications', target: 40 }, { metric: 'interviews', target: 4 }, { metric: 'custom', name: 'LeetCode', target: 31 }]);
  assert.equal(report.current, true);
  assert.equal(report.elapsedDays, 21);
  assert.deepEqual(report.weeks.map(week => week.current), [false, false, false, true, false]);
  const [applications, interviews, practice] = report.goals;
  assert.deepEqual(applications.weeks, [{ target: 5, done: 1 }, { target: 9, done: 3 }, { target: 9, done: 1 }, { target: 9, done: 2 }, { target: 8, done: 0 }]);
  assert.equal(applications.done, 7, 'September does not count');
  assert.equal(applications.expected, 27);
  assert.deepEqual(applications.thisWeek, { target: 9, done: 2 });
  assert.equal(applications.perWeekToFinish, 21, '33 to go in the 11 days left');
  assert.deepEqual(interviews.weeks.map(week => week.done), [0, 0, 1, 1, 0], 'the OA and the interview each count once');

  report = goals.log(practice.id, 3);
  assert.equal(report.goals[2].thisWeek.done, 3);
  report = goals.log(practice.id, -1);
  assert.equal(report.goals[2].done, 2);
  assert.throws(() => goals.log(practice.id, -5), /Nothing logged/);
  assert.throws(() => goals.log(applications.id, 1), /counted automatically/);
  assert.equal(goals.log('missing', 1), null);

  // Editing keeps a goal's logs; leaving one out removes it.
  report = goals.save('2026-10', [{ id: practice.id, metric: 'custom', name: 'LeetCode', target: 20 }, { metric: 'applications', target: 30 }]);
  assert.deepEqual(report.goals.map(goal => [goal.metric, goal.target, goal.done]), [['custom', 20, 2], ['applications', 30, 7]]);
  assert.equal(report.goals[1].id, applications.id);
});

test('a new month starts with last month\'s goals once, and Claude can set one goal', () => {
  const now = clock(local('2026-10-21'));
  const { db, repo } = memoryRepo(now);
  const goals = createGoals({ db, repo, now });
  const october = goals.save('2026-10', [{ metric: 'applications', target: 40 }, { metric: 'custom', name: 'Coffee chats', target: 4 }]);
  goals.log(october.goals[1].id, 2);

  now.set(local('2026-11-02'));
  let november = goals.report();
  assert.equal(november.month, '2026-11');
  assert.deepEqual(november.goals.map(goal => [goal.metric, goal.name, goal.target, goal.done]), [['applications', '', 40, 0], ['custom', 'Coffee chats', 4, 0]]);
  assert.notEqual(november.goals[0].id, october.goals[0].id);
  assert.equal(goals.report('2026-10').goals[1].done, 2, 'October keeps its own progress');
  assert.equal(goals.report('2026-10').current, false);

  goals.save('2026-11', []);
  assert.deepEqual(goals.report().goals, [], 'clearing a month sticks');

  november = goals.set(null, { metric: 'interviews', name: '', target: 5 });
  november = goals.set(null, { metric: 'custom', name: 'coffee chats', target: 6 });
  november = goals.set(null, { metric: 'custom', name: 'Coffee Chats', target: 8 });
  assert.deepEqual(november.goals.map(goal => [goal.metric, goal.target]), [['interviews', 5], ['custom', 8]], 'custom names match without case');
  november = goals.set('2026-11', { metric: 'interviews', name: '', target: 0 });
  assert.deepEqual(november.goals.map(goal => goal.metric), ['custom']);
  for (let index = 0; index < 7; index += 1) goals.set(null, { metric: 'custom', name: `Goal ${index}`, target: 1 });
  assert.throws(() => goals.set(null, { metric: 'custom', name: 'One too many', target: 1 }), /up to 8/);

  const future = goals.report('2026-12');
  assert.deepEqual([future.current, future.elapsedDays, future.goals.length], [false, 0, 0], 'other months are not filled in by looking');
});
