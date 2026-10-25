import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fakeHttp, fixture, memoryRepo } from './helpers.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { createHttp } from '../server/jobs/scrapers/http-client.mjs';
import { createScheduler } from '../server/jobs/scheduler.mjs';
import { createSearchRunner } from '../server/jobs/search-runner.mjs';
import { createScorer } from '../server/jobs/scoring/index.mjs';
import { normalizeScore } from '../server/jobs/scoring/prompt.mjs';

const RESULT = { score: 78, verdict: 'good', summary: 'ok', strengths: [], gaps: [], missingKeywords: [] };

test('stopping a search keeps what it found and skips the rest of the run', async () => {
  const { repo } = memoryRepo();
  repo.saveSearch({ name: 'DS', keywords: 'data', sites: ['linkedin', 'glassdoor', 'indeed'] });
  const { http, calls } = fakeHttp([
    ['seeMoreJobPostings', url => ({ body: new URL(url).searchParams.get('start') === '0' ? fixture('linkedin-search.html') : '' })],
    ['/jobs/view/', { body: fixture('linkedin-job.html') }],
  ]);
  // Glassdoor goes through JobSpy, which runs until the search is stopped.
  let started;
  const inJobspy = new Promise(resolve => { started = resolve; });
  let killed = false;
  const bridge = () => ({ search: (_site, _input, { signal }) => new Promise((_resolve, reject) => {
    started();
    signal.addEventListener('abort', () => { killed = true; reject(signal.reason); });
  }) });
  const runner = createSearchRunner({ repo, http, bridge, log: () => {} });
  const scored = [];
  const tracked = [];
  const scorer = { pending: 0, scoreBatch: async ids => { scored.push(ids); return { scored: 0, results: [] }; } };
  const scheduler = createScheduler({ repo, runner, scorer, tracker: { run: async () => { tracked.push(true); return null; } }, notify: () => {}, log: () => {} });

  assert.equal(scheduler.cancel(), false, 'nothing to stop yet');
  const flight = scheduler.runNow();
  await inJobspy;
  assert.equal(scheduler.cancel(), true);
  assert.equal(scheduler.stopping, true);
  assert.equal(scheduler.cancel(), false, 'already stopping');
  const result = await flight;

  assert.equal(killed, true, 'JobSpy is ended');
  assert.equal(result.cancelled, true);
  assert.equal(result.run.status, 'partial');
  assert.ok(result.run.newCount > 0, 'the LinkedIn jobs found first are kept');
  assert.equal(repo.listPostings().total, result.run.newCount);
  assert.deepEqual(result.run.detail.map(entry => entry.source), ['DS · linkedin', 'dayjob'], 'Indeed is never asked');
  assert.ok(!calls.some(call => call.url.includes('indeed')));
  assert.deepEqual([scored, tracked], [[], []], 'no scoring and no application check after a stop');
  assert.equal(repo.listRuns(1)[0].cancelled, true);
  assert.deepEqual([scheduler.running, scheduler.stopping], [false, false]);
});

test('a request in flight ends at once when its run stops, without retrying', async () => {
  const { fetch, calls } = fakeFetch([['example.com', (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  })]]);
  const http = createHttp({ fetch, sleep: async () => {}, retries: 2 });
  const stopper = new AbortController();
  const pending = http.request('https://example.com/jobs', { signal: stopper.signal });
  stopper.abort(new Error('stopped'));
  await assert.rejects(pending, /stopped/);
  assert.equal(calls.length, 1);
  await assert.rejects(http.request('https://example.com/again', { signal: stopper.signal }), /stopped/);
  assert.equal(calls.length, 1, 'a stopped run asks nothing more');
});

test('stopping a run during scoring ends the posting being scored without pausing scoring', async () => {
  const { repo } = memoryRepo();
  for (const id of ['1', '2']) repo.upsertPosting(posting({ site: 'linkedin', externalId: id, title: `Job ${id}`, company: `Acme ${id}`, jobUrl: `https://www.linkedin.com/jobs/view/${id}` }));
  repo.addResume({ name: 'r', mime: 'text/plain', size: 1, text: 'resume' });
  let started;
  const scoring = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const provider = { id: 'claude-cli', status: async () => ({ available: true, detail: 'ok' }),
    score: ({ signal }) => new Promise((resolve, reject) => {
      calls += 1;
      if (calls > 1) { resolve({ ...normalizeScore(RESULT), provider: 'claude-cli' }); return; }
      started();
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) };
  const scorer = createScorer({ repo, providers: { 'claude-cli': provider }, log: () => {} });
  const stopper = new AbortController();
  const batch = scorer.scoreBatch(['li-1', 'li-2'], { signal: stopper.signal });
  await scoring;
  stopper.abort();
  const result = await batch;
  assert.deepEqual([result.cancelled, result.scored, result.skipped], [true, 0, 2]);
  assert.equal(calls, 1, 'the second posting is left for later');
  const state = await scorer.status();
  assert.deepEqual([state.paused, state.held], [false, 0], 'stopping a run is not a pause');
  assert.equal((await scorer.scoreBatch(['li-1', 'li-2'])).scored, 2, 'both can be scored later');
});
