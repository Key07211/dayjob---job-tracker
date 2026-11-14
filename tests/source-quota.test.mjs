import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryRepo } from './helpers.mjs';
import { divide, sourcePlan } from '../server/jobs/source-quota.mjs';
import { createSearchRunner } from '../server/jobs/search-runner.mjs';
import { SITE_IDS } from '../server/jobs/scrapers/index.mjs';
import { settingsPatch } from '../server/validation.mjs';

const search = (id, sites, resultsWanted = 25) => ({ id, sites, resultsWanted });

test('a whole number is divided by weights, and what rounding leaves over is handed out', () => {
  assert.deepEqual(divide(100, [3, 1]), [75, 25]);
  assert.deepEqual(divide(10, [1, 1, 1]), [4, 3, 3], 'the one left over goes to the first');
  assert.deepEqual(divide(7, [5, 3, 2]), [4, 2, 1], 'the largest remainder first');
  assert.deepEqual(divide(5, [0, 0]), [0, 0]);
  assert.deepEqual(divide(0, [1, 2]), [0, 0]);
  assert.deepEqual(divide(3, []), []);
});

test('by each search: every search asks for its own number', () => {
  const plan = sourcePlan({ mode: 'search' }, [search('a', ['linkedin', 'indeed'], 30), search('b', ['linkedin'], 10)], SITE_IDS);
  assert.deepEqual(plan.forSearch('a'), { linkedin: 30, indeed: 30 });
  assert.deepEqual(plan.forSearch('b'), { linkedin: 10 });
  assert.equal(plan.total, 70);
  assert.deepEqual(plan.sites.linkedin, { searches: 2, wanted: 40, asked: 40 });
  assert.deepEqual(plan.sites.glassdoor, { searches: 0, wanted: 0, asked: 0 });
  // Settings saved before this existed have no numbers at all.
  assert.equal(sourcePlan(undefined, [search('a', ['indeed'], 12)], SITE_IDS).total, 12);
});

test('by number: a source\'s number is shared evenly by the searches that tick it', () => {
  const searches = [search('a', ['linkedin', 'indeed']), search('b', ['linkedin', 'indeed']), search('c', ['linkedin'])];
  const plan = sourcePlan({ mode: 'count', counts: { linkedin: 50, indeed: 0, glassdoor: 40 } }, searches, SITE_IDS);
  assert.deepEqual(plan.forSearch('a'), { linkedin: 17, indeed: 0 });
  assert.deepEqual(plan.forSearch('b'), { linkedin: 17, indeed: 0 });
  assert.deepEqual(plan.forSearch('c'), { linkedin: 16 });
  assert.deepEqual(plan.sites.linkedin, { searches: 3, wanted: 50, asked: 50 });
  assert.deepEqual(plan.sites.glassdoor, { searches: 0, wanted: 40, asked: 0 }, 'nobody ticks Glassdoor, so nothing is asked of it');
  assert.equal(plan.total, 50);
  // A source nobody gave a number keeps the usual 25, and one search never asks for more than 200.
  assert.equal(sourcePlan({ mode: 'count', counts: {} }, [search('a', ['indeed'])], SITE_IDS).forSearch('a').indeed, 25);
  const big = sourcePlan({ mode: 'count', counts: { indeed: 1000 } }, [search('a', ['indeed'])], SITE_IDS);
  assert.deepEqual(big.sites.indeed, { searches: 1, wanted: 1000, asked: 200 });
});

test('by share: one total is divided between the sources in use', () => {
  const searches = [search('a', ['linkedin', 'indeed', 'google']), search('b', ['linkedin'])];
  const plan = sourcePlan({ mode: 'share', total: 100, shares: { linkedin: 3, indeed: 1, google: 0, glassdoor: 9 } }, searches, SITE_IDS);
  assert.deepEqual(plan.sites.linkedin, { searches: 2, wanted: 75, asked: 75, percent: 75 });
  assert.deepEqual(plan.sites.indeed, { searches: 1, wanted: 25, asked: 25, percent: 25 });
  assert.deepEqual(plan.sites.google, { searches: 1, wanted: 0, asked: 0, percent: 0 });
  assert.deepEqual(plan.sites.glassdoor, { searches: 0, wanted: 0, asked: 0, percent: 0 }, 'a share for a source nobody ticks takes nothing from the others');
  assert.deepEqual(plan.forSearch('a'), { linkedin: 38, indeed: 25, google: 0 });
  assert.deepEqual(plan.forSearch('b'), { linkedin: 37 });
  assert.equal(plan.total, 100);
  // Sources with no share of their own count as equal.
  const even = sourcePlan({ mode: 'share', total: 10, shares: {} }, [search('a', ['linkedin', 'indeed', 'google'])], SITE_IDS);
  assert.deepEqual(even.forSearch('a'), { linkedin: 4, indeed: 3, google: 3 });
});

test('the numbers are validated and kept with the settings', () => {
  const { repo } = memoryRepo();
  assert.equal(repo.getSettings().sources.mode, 'search');
  const patch = settingsPatch({ sources: { mode: 'count', counts: { linkedin: 40, indeed: 0 } } });
  assert.deepEqual(patch, { sources: { mode: 'count', counts: { linkedin: 40, indeed: 0 } } });
  repo.updateSettings(patch);
  repo.updateSettings(settingsPatch({ sources: { counts: { google: 5 } } }));
  assert.deepEqual(repo.getSettings().sources, { mode: 'count', total: 100, counts: { linkedin: 40, indeed: 0, google: 5 }, shares: {} }, 'a number left out stays');
  for (const bad of [{ mode: 'most' }, { total: 0 }, { total: 2001 }, { counts: { monster: 5 } }, { counts: { linkedin: -1 } }, { counts: { linkedin: 1001 } }, { counts: [5] },
    { shares: { linkedin: 101 } }, { shares: { linkedin: 1.5 } }]) {
    assert.throws(() => settingsPatch({ sources: bad }), error => error.status === 400, JSON.stringify(bad));
  }
});

// Three JobSpy boards, so one stand-in answers for all of them and notes what it was asked.
function runnerFor(repo) {
  const asked = [];
  const bridge = () => ({ search: async (site, input) => { asked.push(`${input.keywords} ${site} ${input.resultsWanted}`); return { postings: [], warnings: [] }; } });
  return { asked, runner: createSearchRunner({ repo, http: { request: async () => { throw new Error('no network in this test'); }, sleep: async () => {} }, bridge, log: () => {} }) };
}

test('a run asks each board for the numbers in Settings, and leaves out a board set to 0', async () => {
  const { repo } = memoryRepo();
  const first = repo.saveSearch({ name: 'A', keywords: 'analyst', sites: ['glassdoor', 'zip_recruiter', 'google'], resultsWanted: 60 });
  repo.saveSearch({ name: 'B', keywords: 'scientist', sites: ['glassdoor', 'google'], resultsWanted: 60 });
  repo.saveSearch({ name: 'Off', keywords: 'intern', sites: ['glassdoor'], resultsWanted: 60, enabled: false });

  let { asked, runner } = runnerFor(repo);
  let { run } = await runner.run();
  assert.deepEqual(asked, ['analyst glassdoor 60', 'analyst zip_recruiter 60', 'analyst google 60', 'scientist glassdoor 60', 'scientist google 60'], 'by each search, as before');
  assert.deepEqual(run.detail.map(entry => entry.asked), [60, 60, 60, 60, 60]);

  repo.updateSettings({ sources: { mode: 'count', counts: { glassdoor: 31, zip_recruiter: 0, google: 8 } } });
  ({ asked, runner } = runnerFor(repo));
  const flight = runner.run();
  assert.deepEqual(runner.progress, { done: 0, total: 4 }, 'the board set to 0 is not a step of the run');
  ({ run } = await flight);
  assert.deepEqual(asked, ['analyst glassdoor 16', 'analyst google 4', 'scientist glassdoor 15', 'scientist google 4'], 'the search that is switched off takes no part');
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.detail.map(entry => entry.source), ['A · glassdoor', 'A · google', 'B · glassdoor', 'B · google']);

  // One search run on its own asks for what it asks for in the daily run.
  ({ asked, runner } = runnerFor(repo));
  await runner.run({ searchIds: [first.id] });
  assert.deepEqual(asked, ['analyst glassdoor 16', 'analyst google 4']);

  repo.updateSettings({ sources: { mode: 'share', total: 30, shares: { glassdoor: 2, zip_recruiter: 1, google: 0 } } });
  ({ asked, runner } = runnerFor(repo));
  await runner.run();
  assert.deepEqual(asked, ['analyst glassdoor 10', 'analyst zip_recruiter 10', 'scientist glassdoor 10']);
});
