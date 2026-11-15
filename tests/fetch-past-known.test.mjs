import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeHttp, memoryRepo } from './helpers.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { linkedin } from '../server/jobs/scrapers/linkedin.mjs';
import { indeed } from '../server/jobs/scrapers/indeed.mjs';
import { createSearchRunner, lookPast } from '../server/jobs/search-runner.mjs';
import { createScheduler } from '../server/jobs/scheduler.mjs';

// One LinkedIn search card, made from the first card of the saved page.
const CARD = fixture('linkedin-search.html').split('</li>')[0];
const card = (id, title = `Analyst ${id}`, company = 'Acme Analytics') => `${CARD.replaceAll('4012345678', String(id)).replaceAll('Data Scientist', title).replaceAll('Acme Analytics', company)}</li>`;
// LinkedIn answers ten cards a page; pages: lists of [id, title?].
function linkedinSite(pages) {
  return fakeHttp([
    ['seeMoreJobPostings', url => ({ body: (pages[Number(new URL(url).searchParams.get('start')) / 10] || []).map(entry => card(...[entry].flat())).join('\n') })],
    ['/jobs/view/', { body: fixture('linkedin-job.html') }],
  ]);
}
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const lists = calls => calls.filter(call => call.url.includes('seeMoreJobPostings')).length;
const pagesRead = calls => calls.filter(call => call.url.includes('/jobs/view/')).map(call => Number(call.url.split('/').pop()));

test('how far a search reads past what is of no use grows with what it asks for, within bounds', () => {
  assert.equal(lookPast(4), 50);
  assert.equal(lookPast(25), 75);
  assert.equal(lookPast(50), 150);
  assert.equal(lookPast(200), 200);
});

test('LinkedIn: jobs Dayjob already holds do not count, and their pages are not read again', async () => {
  const pages = [range(1, 10).map(id => (id === 9 ? [id, 'Senior Analyst'] : id)), range(11, 20).map(id => (id === 12 ? [id, 'Senior Analyst'] : id)), range(21, 30)];
  const held = new Set(range(1, 8).map(String));
  const input = { keywords: 'analyst', resultsWanted: 3, known: id => held.has(id), rejects: item => /senior/i.test(item.title), lookPast: 50 };

  let { http, calls } = linkedinSite(pages);
  let result = await linkedin.search(input, { http });
  assert.deepEqual(result.postings.map(item => Number(item.externalId)), [...range(1, 8), 10, 11, 13], 'the eight it holds, then three it did not have; the two the filters turn away are left out');
  assert.deepEqual(pagesRead(calls), [10, 11, 13], 'only the new jobs are opened');
  assert.equal(lists(calls), 2, 'it stops once it has what was asked for');
  assert.equal(result.postings[0].description, null, 'a job it holds comes back as its card alone');
  assert.ok(result.postings.at(-1).description, 'a new one comes with its description');
  assert.equal(result.postings[0].title, 'Analyst 1');

  ({ http, calls } = linkedinSite(pages));
  result = await linkedin.search({ ...input, lookPast: 5 }, { http });
  assert.deepEqual(result.postings.map(item => Number(item.externalId)), range(1, 5), 'it reads past five and no further');
  assert.equal(lists(calls), 1);
  assert.deepEqual(pagesRead(calls), []);

  ({ http, calls } = linkedinSite([range(1, 10), range(11, 14)]));
  result = await linkedin.search({ ...input, known: () => true }, { http });
  assert.equal(result.postings.length, 14, 'a list that runs out ends the search');
  assert.equal(lists(calls), 2);

  ({ http, calls } = linkedinSite(pages));
  result = await linkedin.search({ keywords: 'analyst', resultsWanted: 3, known: id => held.has(id), rejects: () => true }, { http });
  assert.deepEqual(result.postings.map(item => Number(item.externalId)), [1, 2, 3], 'without lookPast the first results are taken as they come');
  assert.deepEqual(pagesRead(calls), [1, 2, 3]);
});

// Indeed answers up to a hundred jobs a request.
const INDEED = JSON.parse(fixture('indeed-search.json'));
const indeedJob = (key, title) => ({ job: { ...INDEED.data.jobSearch.results[0].job, key, title } });
function indeedSite(pages) {
  let asked = 0;
  return fakeHttp([['apis.indeed.com/graphql', () => {
    const page = pages[asked] || [];
    asked += 1;
    return { body: { data: { jobSearch: { pageInfo: { nextCursor: asked < pages.length ? `page-${asked}` : null }, results: page.map(entry => indeedJob(...entry)) } } } };
  }]]);
}

test('Indeed: jobs Dayjob already holds are passed on without counting, filtered ones are left out', async () => {
  const pages = [[['k1', 'Data Analyst'], ['k2', 'Data Analyst'], ['k3', 'Senior Data Analyst'], ['k4', 'BI Analyst'], ['k5', 'Analyst']], [['k6', 'Analyst'], ['k7', 'Analyst']]];
  const input = { keywords: 'analyst', resultsWanted: 3, known: key => ['k1', 'k2', 'k6'].includes(key), rejects: item => /senior/i.test(item.title), lookPast: 50 };

  let { http, calls } = indeedSite(pages);
  let { postings } = await indeed.search(input, { http });
  assert.deepEqual(postings.map(item => item.externalId), ['k1', 'k2', 'k4', 'k5', 'k6', 'k7'], 'three it did not have, and the three it holds on the way');
  assert.equal(calls.length, 2, 'it asks for the next page to find the third');

  ({ http, calls } = indeedSite(pages));
  ({ postings } = await indeed.search({ ...input, lookPast: 2 }, { http }));
  assert.deepEqual(postings.map(item => item.externalId), ['k1', 'k2'], 'it reads past two and no further');
  assert.equal(calls.length, 1);

  ({ http, calls } = indeedSite(pages));
  ({ postings } = await indeed.search({ keywords: 'analyst', resultsWanted: 3, known: () => true, rejects: () => true }, { http }));
  assert.deepEqual(postings.map(item => item.externalId), ['k1', 'k2', 'k3'], 'without lookPast the first results are taken as they come');
});

test('the store says where a job it already had stood, and whether it holds its description', () => {
  const { repo } = memoryRepo();
  const job = (id, extra = {}) => posting({ site: 'linkedin', externalId: String(id), title: `Analyst ${id}`, company: 'Acme', location: 'Oakland, CA',
    jobUrl: `https://www.linkedin.com/jobs/view/${id}`, description: 'Python', ...extra });
  assert.deepEqual(repo.upsertPosting(job(1)), { id: 'li-1', isNew: true, reopened: false, was: null, duplicate: false });
  assert.deepEqual(repo.upsertPosting(job(1)), { id: 'li-1', isNew: false, reopened: false, was: 'new', duplicate: false });
  repo.setPostingStatus('li-1', 'dismissed');
  assert.equal(repo.upsertPosting(job(1, { description: null })).was, 'dismissed');
  assert.equal(repo.getPosting('li-1').status, 'dismissed', 'finding it again does not bring it back');
  const twin = repo.upsertPosting({ ...job(1), site: 'indeed', externalId: 'abc', jobUrl: 'https://www.indeed.com/viewjob?jk=abc' });
  assert.deepEqual([twin.isNew, twin.duplicate, twin.was], [false, true, null]);
  assert.equal(repo.upsertPosting({ ...job(1), site: 'indeed', externalId: 'abc', jobUrl: 'https://www.indeed.com/viewjob?jk=abc' }).duplicate, true);

  assert.equal(repo.holdsPosting('linkedin', '1'), true);
  assert.equal(repo.holdsPosting('linkedin', '2'), false, 'a job it never saw');
  repo.upsertPosting(job(3, { description: null }));
  assert.equal(repo.holdsPosting('linkedin', '3'), false, 'a job whose page could not be read is read again');
  assert.equal(repo.holdsPosting('indeed', 'abc'), true);
});

test('a run reads past the jobs it holds, counts each job once and says where they went', async () => {
  const { repo } = memoryRepo();
  repo.addResume({ name: 'r', mime: 'text/plain', size: 1, text: 'resume' });
  const analysts = repo.saveSearch({ name: 'Analysts', keywords: 'analyst', sites: ['linkedin'], resultsWanted: 50, excludeKeywords: ['senior'] });
  repo.saveSearch({ name: 'Interns', keywords: 'analyst intern', sites: ['linkedin'], resultsWanted: 50, excludeKeywords: ['senior'] });
  repo.addCompany({ name: 'Acme AI', ats: 'greenhouse', slug: 'acmeai' });
  // By number: LinkedIn is asked for 4 in the run, 2 for each search.
  repo.updateSettings({ sources: { mode: 'count', counts: { linkedin: 4 } } });
  // Five jobs from earlier runs: one still new, one saved, one removed, one applied to, and one whose page was never read.
  const before = id => repo.upsertPosting(posting({ site: 'linkedin', externalId: String(id), title: `Analyst ${id}`, company: 'Acme Analytics', location: 'Oakland, CA',
    jobUrl: `https://www.linkedin.com/jobs/view/${id}`, description: id === 5 ? null : 'Python' }), analysts.id).id;
  const [, saved, removed, applied] = range(1, 5).map(before);
  repo.setPostingStatus(saved, 'saved');
  repo.setPostingStatus(removed, 'dismissed');
  repo.createApplication({ postingId: applied, company: 'Acme Analytics', title: 'Analyst 4' });

  // Both searches get the same list: what Dayjob holds first, a senior job, then six it has not seen.
  const site = linkedinSite([[...range(1, 5), [6, 'Senior Analyst'], ...range(7, 10)], [11, 12]]);
  const board = fakeHttp([['boards-api.greenhouse.io/v1/boards/acmeai/jobs', { body: { jobs: [
    { id: 1, title: 'Analyst Intern', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/acmeai/jobs/1', first_published: '2026-10-20T00:00:00Z', content: '' },
  ] } }]]);
  const http = { request: (url, options) => (String(url).includes('greenhouse') ? board.http : site.http).request(url, options), sleep: async () => {} };
  const runner = createSearchRunner({ repo, http, bridge: () => { throw new Error('unused'); }, log: () => {} });
  const scorer = { pending: 0, scoreBatch: async ids => ({ scored: ids.length, results: [] }) };
  const scheduler = createScheduler({ repo, runner, scorer, tracker: { run: async () => null }, notify: () => {}, log: () => {} });
  const { run } = await scheduler.runNow();

  assert.deepEqual(pagesRead(site.calls), [5, 7, 8, 9], 'pages are read for the job that was never read and the new ones, not for the four it holds');
  assert.deepEqual(run.detail.map(entry => [entry.source, entry.asked, entry.found, entry.new]), [
    ['Analysts · linkedin', 2, 6, 1], ['Interns · linkedin', 2, 8, 2], ['Acme AI · greenhouse', undefined, 1, 1]]);
  assert.equal(run.found, 9, 'nine different jobs, though the two searches found most of them twice');
  assert.equal(run.newCount, 4, 'the company job fits both searches and is new once');
  assert.deepEqual(run.outcome, { new: 4, listed: 2, saved: 1, removed: 1, applied: 1, duplicates: 0 });
  assert.equal(Object.values(run.outcome).reduce((sum, count) => sum + count, 0), run.found);
  assert.ok(run.scored >= 4, 'the new jobs were scored, so the run was written down a second time');
  assert.deepEqual(repo.listRuns(1)[0].outcome, run.outcome, 'kept with the run, also after its scoring is written down');
  assert.equal(repo.listRuns(1)[0].detail.some(entry => entry.outcome), false, 'and not shown as one of its sources');
  assert.equal(repo.getPosting(removed).status, 'dismissed', 'a removed job stays removed');
  assert.equal(repo.getPosting('li-6'), null, 'the job the filters turn away is not kept');

  site.calls.length = 0;
  const again = await scheduler.runNow();
  assert.deepEqual(pagesRead(site.calls), [10, 11, 12], 'the next run goes on to the jobs after those');
  assert.equal(again.run.newCount, 3);
  assert.deepEqual(again.run.outcome, { new: 3, listed: 6, saved: 1, removed: 1, applied: 1, duplicates: 0 });
  assert.equal(repo.listPostings({ status: 'new', limit: 50 }).total, 9, 'and they are in the list');
});

test('what a run found is said in a short line under the record and, when not all of it was new, in full on Today', async () => {
  const { knownParts, runResult, feedNote } = await import('../src/dayjob/run-outcome.js');
  const zh = (chinese) => chinese;
  const en = (chinese, english) => english;
  const run = (found, outcome, more = {}) => ({ id: 'r', status: 'succeeded', found, newCount: outcome?.new ?? 0, outcome, ...more });
  const none = { new: 0, listed: 20, saved: 1, removed: 9, applied: 2, duplicates: 0 };
  const some = { new: 5, listed: 12, saved: 0, removed: 2, applied: 0, duplicates: 1 };

  assert.deepEqual(knownParts(none, zh), ['20 个已在今日岗位', '1 个已收藏', '9 个在“不感兴趣”里', '2 个已投递']);
  assert.deepEqual(knownParts(some, en), ['12 already in Today', '2 in Not interested', '1 listed on another site too']);
  assert.deepEqual(knownParts(null, zh), []);

  // The sidebar line stays short whatever the run found.
  assert.equal(runResult(run(32, none), zh), '抓到 32 个岗位，没有新的。');
  assert.equal(runResult(run(20, some), zh), '抓到 20 个岗位，5 个是新的。');
  assert.equal(runResult(run(1, { ...none, new: 1, listed: 0, saved: 0, removed: 0, applied: 0 }), en), 'Found 1 job, 1 new.');
  assert.equal(runResult(run(0, { ...none, listed: 0, saved: 0, removed: 0, applied: 0 }), zh), '这次没有抓到岗位。');
  assert.match(runResult(run(0, null, { status: 'failed' }), zh), /没有成功/);

  // Today's note: only when something found was not new.
  assert.equal(feedNote(run(32, none), zh, '今天 08:30'), '上次抓取（今天 08:30）找到 32 个岗位，Dayjob 都已经有了：20 个已在今日岗位，1 个已收藏，9 个在“不感兴趣”里，2 个已投递。');
  assert.equal(feedNote(run(20, some), en, 'today 08:30'),
    'The last search (today 08:30) found 20 jobs, 5 of them new. Dayjob already had the rest: 12 already in Today, 2 in Not interested, 1 listed on another site too.');
  assert.equal(feedNote(run(5, { new: 5, listed: 0, saved: 0, removed: 0, applied: 0, duplicates: 0 }), zh, 'x'), '');
  assert.equal(feedNote(run(32, null), zh, 'x'), '', 'a run from before 0.36 has no outcome');
  assert.equal(feedNote(run(32, none, { status: 'failed' }), zh, 'x'), '');
  assert.equal(feedNote(null, zh, 'x'), '');
});
