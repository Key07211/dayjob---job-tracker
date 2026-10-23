import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, fakeHttp, fixture, memoryRepo } from './helpers.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { createTracker } from '../server/jobs/tracker.mjs';
import { createScheduler, localDay, scheduledAt } from '../server/jobs/scheduler.mjs';
import { createSearchRunner } from '../server/jobs/search-runner.mjs';
import { settingsPatch } from '../server/validation.mjs';

const DAY = 864e5;
const li = id => posting({ site: 'linkedin', externalId: id, title: `Job ${id}`, company: `Co ${id}`, jobUrl: `https://www.linkedin.com/jobs/view/${id}` });

test('tracking flags follow-ups and silence, once each', async () => {
  const now = clock('2026-10-01T16:00:00Z');
  const { repo } = memoryRepo(now);
  repo.upsertPosting(li('1'));
  const application = repo.createApplication({ postingId: 'li-1', company: 'Co 1', title: 'Job 1', followUpDays: 7 });
  const notes = [];
  const { http } = fakeHttp([['/jobs/view/1', { body: fixture('linkedin-job.html') }]]);
  const tracker = createTracker({ repo, http, now, notify: item => notes.push(item), log: () => {} });

  now.advance(3 * DAY);
  let report = await tracker.run();
  assert.deepEqual(report.followUps, []);
  assert.equal(report.checked, 1);
  assert.equal((await tracker.run()).checked, 0, 'a posting checked within the last day is not checked again');

  now.advance(5 * DAY);
  report = await tracker.run();
  assert.deepEqual(report.followUps, [application.id]);
  assert.equal(notes.at(-1).kind, 'follow-up');
  assert.deepEqual((await tracker.run()).followUps, [], 'one reminder per follow-up date');

  now.advance(14 * DAY);
  report = await tracker.run();
  assert.deepEqual(report.ghosted, [application.id]);
  const flagged = repo.getApplication(application.id);
  assert.deepEqual(flagged.flags.sort(), ['follow-up-due', 'ghost-suspected']);
  assert.ok(flagged.events.some(event => event.type === 'ghost-suspected' && event.source === 'auto'));
  assert.equal(repo.getMeta('lastTracking').ghosted.length, 1);

  repo.updateApplication(application.id, { status: 'interview' });
  assert.deepEqual(repo.getApplication(application.id).flags, []);
});

test('tracking notices when an applied posting closes', async () => {
  const now = clock('2026-10-10T16:00:00Z');
  const { repo } = memoryRepo(now);
  repo.upsertPosting(li('2'));
  repo.upsertPosting(li('3'));
  repo.setPostingStatus('li-3', 'saved');
  const application = repo.createApplication({ postingId: 'li-2', company: 'Co 2', title: 'Job 2', followUpDays: 0 });
  const notes = [];
  const { http, calls } = fakeHttp([
    ['/jobs/view/2', { body: fixture('linkedin-closed.html') }],
    ['/jobs/view/3', { status: 429, body: '' }],
  ]);
  now.advance(DAY);
  const report = await createTracker({ repo, http, now, notify: item => notes.push(item), log: () => {} }).run();
  assert.deepEqual(report.closed, ['li-2']);
  assert.equal(report.errors, 1);
  assert.ok(report.warnings[0].includes('limited'));
  assert.ok(repo.getPosting('li-2').closedAt);
  assert.equal(repo.getApplication(application.id).events[0].type, 'posting-closed');
  assert.equal(notes[0].kind, 'posting-closed');
  assert.equal(calls.filter(call => call.url.includes('/jobs/view/2')).length, 1, 'applied jobs are checked first');
});

test('jobs a search listed today are not requested, and a refusing site waits for the next run', async () => {
  const now = clock('2026-10-10T16:00:00Z');
  const { repo } = memoryRepo(now);
  const ind = id => posting({ site: 'indeed', externalId: id, title: `Job ${id}`, company: `Co ${id}`, jobUrl: `https://www.indeed.com/viewjob?jk=${id}` });
  for (const item of [ind('a1'), ind('a2'), li('4'), li('5')]) {
    const { id } = repo.upsertPosting(item);
    repo.createApplication({ postingId: id, company: item.company, title: item.title, followUpDays: 0 });
  }
  now.advance(DAY);
  repo.upsertPosting(li('5'));
  const { http, calls } = fakeHttp([
    ['viewjob?jk=', { status: 401, body: '' }],
    ['/jobs/view/4', { body: fixture('linkedin-job.html') }],
  ]);
  const report = await createTracker({ repo, http, now, log: () => {} }).run();
  assert.equal(calls.filter(call => call.url.includes('indeed.com')).length, 1, 'one refused Indeed page, then Indeed waits');
  assert.equal(calls.filter(call => call.url.includes('/jobs/view/4')).length, 1, 'the other site is still checked');
  assert.equal(calls.filter(call => call.url.includes('/jobs/view/5')).length, 0, 'listed by today\'s search');
  assert.equal(report.checked, 1);
  assert.equal(report.errors, 1);
  assert.deepEqual(report.warnings, ['indeed limited requests; the rest are checked next time.']);
  assert.equal(repo.getPosting('in-a1').closedAt, null);
  assert.equal(repo.getPosting('in-a1').lastCheckedAt, null, 'tried again first next time');
});

test('followed company boards are left to the daily search', async () => {
  const { repo } = memoryRepo();
  repo.addCompany({ name: 'Acme', ats: 'greenhouse', slug: 'acme' });
  repo.upsertPosting(posting({ site: 'greenhouse', externalId: 'acme-5', title: 'DS', company: 'Acme', jobUrl: 'https://job-boards.greenhouse.io/acme/jobs/5' }));
  repo.createApplication({ postingId: 'gh-acme-5', company: 'Acme', title: 'DS' });
  const { http, calls } = fakeHttp([]);
  const report = await createTracker({ repo, http, log: () => {} }).run();
  assert.equal(report.checked, 0);
  assert.equal(calls.length, 0);
});

test('daily runs happen once a day, after the set time, and catch up', async () => {
  const now = clock(new Date(2026, 9, 21, 7, 0));
  const { repo } = memoryRepo(now);
  repo.updateSettings({ schedule: { enabled: true, time: '08:30' } });
  const triggers = [];
  const runner = { run: async ({ trigger }) => { triggers.push(trigger); return { run: { id: 'r', newCount: 0, detail: [] }, newIds: [] }; } };
  const scorer = { scoreBatch: async () => ({ scored: 0 }), pending: 0 };
  const tracker = { run: async () => ({}) };
  const scheduler = createScheduler({ repo, runner, scorer, tracker, notify: () => {}, now, log: () => {} });

  assert.equal(new Date(scheduler.nextRunAt()).getHours(), 8);
  await scheduler.tick();
  assert.deepEqual(triggers, [], 'not before 08:30');
  now.set(new Date(2026, 9, 21, 11, 15));
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(triggers, ['schedule'], 'a late start catches up exactly once');
  assert.equal(repo.getMeta('lastDailyRun').day, localDay(now()));
  assert.equal(new Date(scheduler.nextRunAt()).getDate(), 22);
  now.set(new Date(2026, 9, 22, 8, 31));
  await scheduler.tick();
  assert.equal(triggers.length, 2);
  repo.updateSettings({ schedule: { enabled: false } });
  assert.equal(scheduler.nextRunAt(), null);
  assert.equal(scheduledAt('bad', new Date(2026, 0, 1)).getHours(), 8);
});

test('a daily run searches, scores new postings, tracks and summarizes', async () => {
  const now = clock('2026-10-21T16:00:00Z');
  const { repo } = memoryRepo(now);
  repo.addResume({ name: 'r', mime: 'text/plain', size: 1, text: 'resume' });
  const search = repo.saveSearch({ name: 'DS', keywords: 'data scientist, analyst', sites: ['linkedin'], excludeKeywords: ['senior'] });
  repo.addCompany({ name: 'Acme AI', ats: 'greenhouse', slug: 'acmeai' });
  const { http, calls } = fakeHttp([
    ['seeMoreJobPostings', url => ({ body: new URL(url).searchParams.get('start') === '0' ? fixture('linkedin-search.html') : '' })],
    ['/jobs/view/', { body: fixture('linkedin-job.html') }],
    ['boards-api.greenhouse.io/v1/boards/acmeai/jobs', { body: { jobs: [
      { id: 1, title: 'Data Scientist, Ads', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/acmeai/jobs/1', first_published: '2026-10-20T00:00:00Z', content: '' },
      { id: 2, title: 'Recruiter', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/acmeai/jobs/2', first_published: '2026-10-20T00:00:00Z', content: '' },
    ] } }],
  ]);
  const runner = createSearchRunner({ repo, http, bridge: () => { throw new Error('unused'); }, now, log: () => {} });
  const scored = [];
  const scorer = { pending: 0, scoreBatch: async ids => {
    for (const id of ids) { scored.push(id); repo.saveScore(id, repo.getPosting(id).resumeId, { score: 90, verdict: 'strong', summary: 's', strengths: [], gaps: [], missingKeywords: [], provider: 'test' }); }
    return { scored: ids.length, results: ids.map(id => ({ id, score: 90 })) };
  } };
  const notes = [];
  const tracker = createTracker({ repo, http, now, notify: item => notes.push(item), log: () => {} });
  const scheduler = createScheduler({ repo, runner, scorer, tracker, notify: item => notes.push(item), now, log: () => {} });
  const result = await scheduler.runNow();
  assert.equal(result.run.status, 'succeeded');
  assert.equal(result.run.newCount, 3, 'two LinkedIn jobs and one matching company job');
  assert.equal(repo.listPostings().total, 3);
  assert.deepEqual(scored.sort(), ['gh-acmeai-1', 'li-4012345678', 'li-4012399999']);
  assert.equal(result.run.scored, 3);
  assert.ok(result.tracking, 'a full run also updates applications');
  assert.match(notes.at(-1).title, /3 个新岗位，3 个高匹配/);
  assert.ok(calls[0].url.includes('keywords=%22data+scientist%22+OR+analyst'));
  assert.equal(repo.getSearch(search.id).lastRunAt, now().toISOString());

  const second = await scheduler.runNow({ searchIds: [search.id] });
  assert.equal(second.run.newCount, 0);
  assert.equal(second.tracking, null, 'a single-search run skips tracking');
});

test('the scoring mode decides what a run scores', async () => {
  const now = clock('2026-10-21T16:00:00Z');
  const { repo } = memoryRepo(now);
  repo.addResume({ name: 'r', mime: 'text/plain', size: 1, text: 'resume' });
  const [oldJob, savedJob, newJob] = ['1', '2', '3'].map(id => repo.upsertPosting(li(id)).id);
  repo.setPostingStatus(savedJob, 'saved');
  assert.deepEqual(repo.unscoredPostingIds(10, { savedOnly: true }), [savedJob]);
  const runner = { run: async () => ({ run: repo.finishRun(repo.startRun('search', 'manual'), { status: 'succeeded', found: 3, newCount: 1 }), newIds: [newJob] }) };
  const batches = [];
  const scorer = { pending: 0, scoreBatch: async ids => { batches.push(ids); return { scored: 0, results: [] }; } };
  const scheduler = createScheduler({ repo, runner, scorer, tracker: { run: async () => null }, notify: () => {}, now, log: () => {} });
  for (const scoreMode of ['manual', 'saved', 'auto']) {
    repo.updateSettings({ ai: { scoreMode } });
    await scheduler.runNow({ searchIds: ['any'] });
  }
  assert.equal(batches.length, 2, 'manual scores nothing');
  assert.deepEqual(batches[0], [savedJob], 'saved scores only the saved job');
  assert.equal(batches[1][0], newJob, 'auto scores the new job first');
  assert.deepEqual([...batches[1]].sort(), [oldJob, savedJob, newJob].sort());

  repo.updateSettings({ ai: { scoreMode: 'saved' } });
  repo.setPostingStatus(savedJob, 'new');
  await scheduler.runNow({ searchIds: ['any'] });
  assert.equal(batches.length, 2, 'with nothing saved, nothing is scored');
});

test('one failing board makes a run partial, not failed', async () => {
  const { repo } = memoryRepo();
  repo.saveSearch({ name: 'DS', keywords: 'data', sites: ['linkedin', 'indeed'] });
  const { http } = fakeHttp([
    ['seeMoreJobPostings', url => ({ body: new URL(url).searchParams.get('start') === '0' ? fixture('linkedin-search.html') : '' })],
    ['/jobs/view/', { body: fixture('linkedin-job.html') }],
    ['apis.indeed.com', { status: 403, body: '' }],
  ]);
  const runner = createSearchRunner({ repo, http, bridge: () => ({}), log: () => {} });
  const { run } = await runner.run({ trigger: 'manual' });
  assert.equal(run.status, 'partial');
  assert.ok(run.detail.find(entry => entry.source.endsWith('indeed')).blocked);
});

test('reminders are written in the interface language', async () => {
  const now = clock('2026-10-01T16:00:00Z');
  const { repo } = memoryRepo(now);
  repo.createApplication({ company: 'Acme', title: 'Analyst', followUpDays: 2 });
  const notes = [];
  const tracker = createTracker({ repo, http: fakeHttp([]).http, now, notify: item => notes.push(item), log: () => {} });
  repo.updateSettings(settingsPatch({ language: 'en' }));
  now.advance(3 * DAY);
  await tracker.run();
  assert.equal(notes.at(-1).title, 'Time to follow up: Acme');
  assert.equal(repo.listApplications()[0].flags.includes('follow-up-due'), true);
  assert.throws(() => settingsPatch({ language: 'fr' }), /Language/);
});
