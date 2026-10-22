import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture, fakeHttp } from './helpers.mjs';
import { linkedin, parseCards, parseDetail, parseLocation, parseSalary, searchParams } from '../server/jobs/scrapers/linkedin.mjs';
import { buildFilters, buildQuery, indeed } from '../server/jobs/scrapers/indeed.mjs';
import { BOARDS, checkCompanyJob, fetchCompanyBoard, parseCompanyBoard, splitCompanyId } from '../server/jobs/scrapers/company-boards.mjs';
import { bridgeArgs, createJobspyBridge, fromRecord } from '../server/jobs/scrapers/jobspy-bridge.mjs';

test('LinkedIn search parameters follow JobSpy', () => {
  const params = searchParams({ keywords: 'data scientist', location: 'New York, NY', distance: 25, hoursOld: 72, jobType: 'internship', isRemote: true });
  assert.equal(params.get('keywords'), 'data scientist');
  assert.equal(params.get('f_TPR'), 'r259200');
  assert.equal(params.get('f_JT'), 'I');
  assert.equal(params.get('f_WT'), '2');
  assert.equal(params.get('distance'), '25');
});

test('LinkedIn cards and job pages parse into postings', () => {
  const cards = parseCards(fixture('linkedin-search.html'));
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], { id: '4012345678', title: 'Data Scientist', company: 'Acme Analytics', companyUrl: 'https://www.linkedin.com/company/acme-analytics',
    locationText: 'San Francisco, CA', datePosted: '2026-10-20', logo: 'https://media.licdn.com/dms/image/acme-logo.png' });
  assert.deepEqual(parseLocation('San Francisco, CA'), { city: 'San Francisco', state: 'CA', country: 'United States' });
  assert.deepEqual(parseLocation('London, England, United Kingdom'), { city: 'London', state: 'England', country: 'United Kingdom' });

  const detail = parseDetail(fixture('linkedin-job.html'));
  assert.equal(detail.jobType, 'fulltime');
  assert.equal(detail.jobLevel, 'entry level');
  assert.equal(detail.industry, 'Software Development');
  assert.deepEqual(detail.salary, { min: 140000, max: 185000, interval: 'yearly', currency: 'USD', source: 'board' });
  assert.deepEqual(detail.emails, ['talent@acme-analytics.com']);
  assert.match(detail.description, /\*\*Requirements\*\*/);
  assert.match(detail.description, /- 2\+ years with Python and SQL/);
  assert.equal(detail.closed, false);
  assert.equal(parseDetail(fixture('linkedin-closed.html')).closed, true);
  assert.equal(parseSalary('$45.00/hr - $60.50/hr').interval, 'hourly');
});

test('LinkedIn search pages, waits politely and fetches each job page', async () => {
  const { http, calls, sleeps } = fakeHttp([
    ['seeMoreJobPostings', url => ({ body: new URL(url).searchParams.get('start') === '0' ? fixture('linkedin-search.html') : '' })],
    ['/jobs/view/4012345678', { body: fixture('linkedin-job.html') }],
    ['/jobs/view/4012399999', { body: fixture('linkedin-closed.html') }],
  ]);
  const result = await linkedin.search({ keywords: 'data', location: 'San Francisco, CA', resultsWanted: 25 }, { http });
  assert.equal(result.postings.length, 2);
  const [first, second] = result.postings;
  assert.equal(first.site, 'linkedin');
  assert.equal(first.jobUrl, 'https://www.linkedin.com/jobs/view/4012345678');
  assert.equal(first.datePosted, '2026-10-20');
  assert.equal(first.salary.max, 185000);
  assert.equal(first.companyLogo, 'https://media.licdn.com/dms/image/acme-logo-large.png');
  assert.equal(second.isRemote, true);
  assert.ok(sleeps.length >= 1, 'waits between job pages');
  assert.equal(calls.filter(call => call.url.includes('seeMoreJobPostings')).length, 1, 'stops after a short page');
});

test('LinkedIn reports a block instead of silently returning nothing', async () => {
  const { http } = fakeHttp([['seeMoreJobPostings', { body: '<html><body>Sign in to continue</body></html>' }]]);
  await assert.rejects(linkedin.search({ keywords: 'data' }, { http }), error => error.blocked === true);
  const { http: limited } = fakeHttp([['seeMoreJobPostings', { status: 429, body: '' }]]);
  await assert.rejects(linkedin.search({ keywords: 'data' }, { http: limited }), error => error.blocked === true && error.status === 429);
});

test('LinkedIn open check reads closed and removed jobs', async () => {
  const { http } = fakeHttp([
    ['/jobs/view/1', { body: fixture('linkedin-job.html') }],
    ['/jobs/view/2', { body: fixture('linkedin-closed.html') }],
    ['/jobs/view/3', { status: 404, body: '' }],
    ['/jobs/view/4', { body: '<html>login</html>', url: 'https://www.linkedin.com/authwall?x=1' }],
  ]);
  assert.equal(await linkedin.checkOpen({ externalId: '1' }, { http }), true);
  assert.equal(await linkedin.checkOpen({ externalId: '2' }, { http }), false);
  assert.equal(await linkedin.checkOpen({ externalId: '3' }, { http }), false);
  assert.equal(await linkedin.checkOpen({ externalId: '4' }, { http }), null);
});

test('Indeed GraphQL query and results', async () => {
  assert.match(buildFilters({ hoursOld: 24, jobType: 'contract', isRemote: true }), /start: "24h"/);
  assert.match(buildFilters({ jobType: 'contract' }), /operation: OR/);
  const query = buildQuery({ keywords: '"data analyst" OR "bi analyst"', location: 'New York, NY', distance: 30 }, 'abc');
  assert.match(query, /what: "\\"data analyst\\" OR \\"bi analyst\\""/);
  assert.match(query, /radius: 30/);
  assert.match(query, /cursor: "abc"/);

  const { http, calls } = fakeHttp([['apis.indeed.com/graphql', { body: JSON.parse(fixture('indeed-search.json')) }]]);
  const { postings } = await indeed.search({ keywords: 'data analyst', country: 'usa', resultsWanted: 10 }, { http });
  assert.equal(calls[0].headers['indeed-co'], 'US');
  assert.equal(postings.length, 2);
  const [analyst, intern] = postings;
  assert.equal(analyst.jobUrl, 'https://www.indeed.com/viewjob?jk=a1b2c3d4e5f60718');
  assert.equal(analyst.applyUrl, 'https://careers.bluebird.example/jobs/889');
  assert.equal(analyst.companyUrl, 'https://www.indeed.com/cmp/Bluebird-Health');
  assert.equal(analyst.isRemote, true);
  assert.equal(analyst.jobType, 'fulltime');
  assert.equal(analyst.location, 'New York, NY, US');
  assert.equal(analyst.datePosted, '2025-10-20T00:00:00.000Z');
  assert.deepEqual(analyst.salary, { min: 85000, max: 105000, interval: 'yearly', currency: 'USD', source: 'board' });
  assert.equal(intern.applyUrl, null, 'Indeed-hosted apply links are not company pages');
  assert.equal(intern.salary.source, 'estimate');
  assert.equal(intern.salary.interval, 'hourly');
  assert.equal(intern.jobType, 'internship');
});

test('Indeed API errors are reported', async () => {
  const { http } = fakeHttp([['apis.indeed.com', { body: { errors: [{ message: 'Bad field' }] } }]]);
  await assert.rejects(indeed.search({ keywords: 'x' }, { http }), /Bad field/);

  // Indeed's app API sometimes answers 401 to a good request: one retry, then a clear error.
  let attempts = 0;
  const flaky = fakeHttp([['apis.indeed.com', () => (++attempts === 1 ? { status: 401, body: {} } : { body: JSON.parse(fixture('indeed-search.json')) })]]);
  assert.ok((await indeed.search({ keywords: 'x', resultsWanted: 1 }, { http: flaky.http })).postings.length);
  const refused = fakeHttp([['apis.indeed.com', { status: 401, body: {} }]]);
  await assert.rejects(indeed.search({ keywords: 'x' }, { http: refused.http }), error => error.blocked && /401/.test(error.message));
});

test('company boards read official Greenhouse, Lever and Ashby JSON', async () => {
  const { http } = fakeHttp([
    ['boards-api.greenhouse.io/v1/boards/acmeai/jobs?content=true', { body: JSON.parse(fixture('greenhouse.json')) }],
    ['api.lever.co/v0/postings/plaidish?mode=json', { body: JSON.parse(fixture('lever.json')) }],
    ['api.ashbyhq.com/posting-api/job-board/rampish', { body: JSON.parse(fixture('ashby.json')) }],
  ]);
  const gh = await fetchCompanyBoard({ ats: 'greenhouse', slug: 'acmeai', name: 'Acme' }, { http });
  assert.equal(gh.length, 2);
  assert.equal(gh[0].externalId, 'acmeai-7012345');
  assert.equal(gh[0].company, 'Acme AI');
  assert.equal(gh[0].department, 'Research');
  assert.equal(gh[0].datePosted, '2026-10-17T13:00:00.000Z');
  assert.match(gh[0].description, /## About the team/);
  assert.match(gh[0].description, /\*\*large models\*\*/);
  assert.doesNotMatch(gh[0].description, /&lt;|<p>/);

  const [lv] = await fetchCompanyBoard({ ats: 'lever', slug: 'plaidish', name: 'Plaidish' }, { http });
  assert.equal(lv.externalId, 'plaidish-3f1c2b8a-1d2e-4f50-9a7b-1234567890ab');
  assert.equal(lv.isRemote, false);
  assert.equal(lv.department, 'Data · Growth');
  assert.deepEqual(lv.salary, { min: 160000, max: 200000, interval: 'yearly', currency: 'USD', source: 'board' });
  assert.match(lv.description, /## What you'll do/);
  assert.equal(lv.applyUrl.endsWith('/apply'), true);

  const ab = await fetchCompanyBoard({ ats: 'ashby', slug: 'rampish', name: 'Rampish' }, { http });
  assert.equal(ab.length, 1, 'unlisted Ashby jobs are skipped');
  assert.equal(ab[0].jobType, 'fulltime');
  assert.equal(ab[0].isRemote, true);
  assert.deepEqual(ab[0].salary, { min: 170000, max: 210000, interval: 'yearly', currency: 'USD', source: 'board' });
});

test('careers links resolve to a board and slug', () => {
  assert.deepEqual(parseCompanyBoard('https://job-boards.greenhouse.io/anthropic'), { ats: 'greenhouse', slug: 'anthropic' });
  assert.deepEqual(parseCompanyBoard('https://boards.greenhouse.io/embed/job_board?for=figma'), { ats: 'greenhouse', slug: 'figma' });
  assert.deepEqual(parseCompanyBoard('https://boards-api.greenhouse.io/v1/boards/stripe/jobs'), { ats: 'greenhouse', slug: 'stripe' });
  assert.deepEqual(parseCompanyBoard('jobs.lever.co/plaid/abc'), { ats: 'lever', slug: 'plaid' });
  assert.deepEqual(parseCompanyBoard('https://jobs.ashbyhq.com/ramp'), { ats: 'ashby', slug: 'ramp' });
  assert.deepEqual(parseCompanyBoard('lever:netflix'), { ats: 'lever', slug: 'netflix' });
  assert.equal(parseCompanyBoard('https://example.com/careers'), null);
  assert.equal(BOARDS.greenhouse.url('a b'), 'https://boards-api.greenhouse.io/v1/boards/a%20b/jobs?content=true');
});

test('company job ids split even when slugs contain dashes', async () => {
  assert.deepEqual(splitCompanyId('greenhouse', 'scale-ai-4501234'), { slug: 'scale-ai', id: '4501234' });
  assert.deepEqual(splitCompanyId('lever', 'my-co-3f1c2b8a-1d2e-4f50-9a7b-1234567890ab'), { slug: 'my-co', id: '3f1c2b8a-1d2e-4f50-9a7b-1234567890ab' });
  assert.equal(splitCompanyId('lever', 'nouuid'), null);
  const { http } = fakeHttp([
    ['boards/acmeai/jobs/7012345', { body: '{}' }],
    ['boards/acmeai/jobs/1', { status: 404, body: '' }],
    ['api.ashbyhq.com', { body: JSON.parse(fixture('ashby.json')) }],
  ]);
  assert.equal(await checkCompanyJob({ site: 'greenhouse', externalId: 'acmeai-7012345' }, { http }), true);
  assert.equal(await checkCompanyJob({ site: 'greenhouse', externalId: 'acmeai-1' }, { http }), false);
  const cache = new Map();
  assert.equal(await checkCompanyJob({ site: 'ashby', externalId: 'rampish-9b8c7d6e-5f40-4321-8abc-def012345678' }, { http, cache }), true);
  assert.equal(await checkCompanyJob({ site: 'ashby', externalId: 'rampish-00000000-0000-4000-8000-000000000001' }, { http, cache }), false);
});

test('JobSpy bridge arguments and records', async () => {
  const args = bridgeArgs('glassdoor', { keywords: 'data scientist', location: 'Austin, TX', hoursOld: 48, isRemote: true, resultsWanted: 15, country: 'usa' });
  assert.deepEqual(args.slice(0, 3), ['-m', 'jobspy', 'data scientist']);
  assert.ok(args.includes('--remote') && args.includes('--hours-old') && args.includes('glassdoor'));
  const item = fromRecord({ site: 'glassdoor', id: 'gd-123', title: 'Data Scientist', company: 'Initech', job_url: 'https://www.glassdoor.com/job-listing/123',
    location: 'Austin, TX', min_amount: 100000, max_amount: 130000, interval: 'yearly', currency: 'USD', date_posted: '2026-10-19', is_remote: false, job_type: 'fulltime' });
  assert.equal(item.externalId, '123');
  assert.equal(item.salary.max, 130000);

  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(`${JSON.stringify({ site: 'google', id: 'go-9', title: 'Analyst', company: 'Hooli', job_url: 'https://example.com/9' })}\nnot json\n`);
      child.emit('close', 0);
    });
    return child;
  };
  const result = await createJobspyBridge({ command: 'python', spawn }).search('google', { keywords: 'analyst' });
  assert.equal(result.postings.length, 1);
  assert.equal(result.postings[0].site, 'google');
});
