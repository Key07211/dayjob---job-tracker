import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { SYSTEM_PROMPT } from '../server/assistant/prompt.mjs';
import { fuller, jobTypeOf, pageIsAbout, siteName, webJob } from '../server/jobs/web-jobs.mjs';

// 读岗位: jobs the assistant reads on a web page (Handshake and the like) go into Today.

test('a job\'s link says which site it is from and which posting it is', () => {
  // Handshake: the id in the path, whatever else the link carries; the link is kept without its query.
  assert.deepEqual(webJob('https://app.joinhandshake.com/job-search/9912345?page=1&per_page=25#top'),
    { site: 'handshake', externalId: '9912345', jobUrl: 'https://app.joinhandshake.com/job-search/9912345' });
  assert.deepEqual(webJob('https://berkeley.joinhandshake.com/stu/jobs/9912345/apply'), { site: 'handshake', externalId: '9912345', jobUrl: 'https://berkeley.joinhandshake.com/stu/jobs/9912345' });
  assert.equal(webJob('https://app.joinhandshake.com/jobs/9912345').externalId, '9912345');
  // A Handshake page that is no job is still Handshake's, told apart by its address.
  const list = webJob('https://app.joinhandshake.com/stu/postings?query=analyst');
  assert.equal(list.site, 'handshake');
  assert.match(list.externalId, /^[0-9a-f]{24}$/);
  // LinkedIn and Indeed: the id the daily fetch uses, so it is that very posting.
  assert.deepEqual(webJob('https://www.linkedin.com/jobs/view/data-analyst-at-acme-4012345678/?refId=x'), { site: 'linkedin', externalId: '4012345678', jobUrl: 'https://www.linkedin.com/jobs/view/4012345678' });
  assert.deepEqual(webJob('https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=data'), { site: 'linkedin', externalId: '4012345678', jobUrl: 'https://www.linkedin.com/jobs/view/4012345678' });
  assert.deepEqual(webJob('https://www.indeed.com/viewjob?jk=0123456789ABCDEF&from=serp'), { site: 'indeed', externalId: '0123456789abcdef', jobUrl: 'https://www.indeed.com/viewjob?jk=0123456789abcdef' });
  assert.equal(webJob('https://www.linkedin.com/feed/').site, 'manual', 'a LinkedIn page that is no job is not taken for one');
  // Another board with a name; any other site is told apart by its address, as "Add to Dayjob" does.
  assert.equal(webJob('https://wellfound.com/jobs/123-data-analyst').site, 'wellfound');
  const other = webJob('https://careers.example.com/jobs/77?utm_source=mail&dept=data#apply');
  assert.equal(other.site, 'manual');
  assert.equal(other.jobUrl, 'https://careers.example.com/jobs/77?dept=data', 'what only counts clicks is left off');
  assert.equal(webJob('https://careers.example.com/jobs/77?dept=data&utm_campaign=x').externalId, other.externalId);
  assert.notEqual(webJob('https://careers.example.com/jobs/78?dept=data').externalId, other.externalId);
  for (const bad of ['', 'notalink', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.com/job']) assert.equal(webJob(bad), null, bad);

  assert.equal(siteName('https://app.joinhandshake.com/job-search/1'), 'Handshake');
  assert.equal(siteName('https://www.careers.example.com/x'), 'careers.example.com');
  assert.equal(jobTypeOf(['FULL_TIME']), 'fulltime');
  assert.equal(jobTypeOf('Intern'), 'internship');
  assert.equal(jobTypeOf(['OTHER']), null);
  assert.equal(fuller('Data Analyst Intern, Summ…', 'Data Analyst Intern, Summer 2027'), 'Data Analyst Intern, Summer 2027');
  assert.equal(fuller('Data Analyst', 'Senior Product Manager'), 'Data Analyst', 'another title is not taken for the whole of this one');
  assert.equal(fuller('Data Analyst', ''), 'Data Analyst');
});

test('a page is taken for a job\'s own when it names the company or most of the title', () => {
  const job = { title: 'Data Analyst Intern', company: 'Northwind Labs, Inc.' };
  assert.equal(pageIsAbout(job, { title: 'Data Analyst Intern', description: 'Join us.' }), true);
  assert.equal(pageIsAbout(job, { title: 'Careers', description: 'Northwind Labs is hiring across teams.' }), true);
  assert.equal(pageIsAbout(job, { title: 'Sign in', description: 'Enter your school email to continue.' }), false);
  assert.equal(pageIsAbout(job, { title: 'Search results', description: 'Marketing intern, Sales associate, Barista' }), false);
  assert.equal(pageIsAbout(job, { title: '', description: '' }), false);
});

const HS = id => `https://app.joinhandshake.com/job-search/${id}?page=1`;
const TEXT = 'About the role. You will analyse product data with SQL and Python and present findings to the team. '.repeat(8);
// A stand-in for the Dayjob browser: `pages` says what each link's page shows.
function fakeBrowser(pages) {
  const calls = [];
  return { calls,
    async run(action, input, context) {
      calls.push({ action, input, context });
      if (action !== 'jobs') return { page: { url: 'https://app.joinhandshake.com/job-search', title: 'Jobs' } };
      return { jobs: input.items.map(item => {
        const key = item.url || item.ref || 'here';
        const page = pages[key];
        if (!page) return { url: item.url, error: 'not-loaded' };
        if (page.error) return page;
        return { title: '', company: '', location: '', remote: false, datePosted: null, employmentType: [], description: '', structured: false, gate: false, asked: item.url || page.url, url: page.url || item.url, ...page };
      }) };
    },
    endRun() {} };
}
async function start(t, { browser, dataDir = ':memory:' } = {}) {
  const app = await createApp({ dataDir, startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {},
    detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }), score: async () => { throw new Error('No scoring in these tests.'); } } },
    ...(browser ? { browser } : {}) });
  t.after(() => app.close());
  const add = (input, context = {}) => app.assistant.tools.run('add_postings', input, context);
  const today = () => app.repo.listPostings({ status: 'new' }).items;
  return { app, repo: app.repo, add, today };
}

test('jobs read from a list go into Today, each with the description Dayjob read on its own page', async t => {
  const browser = fakeBrowser({
    [HS(101)]: { title: 'Data Analyst Intern', description: TEXT },
    e7: { url: HS(102), asked: HS(102), structured: true, title: 'Business Intelligence Intern, Summer 2027', company: 'Harbor Freight Lines', location: 'Oakland, CA', employmentType: ['INTERN'],
      datePosted: '2026-11-10T08:00:00Z', description: `Harbor Freight Lines. ${TEXT}` },
    [HS(103)]: { url: 'https://app.joinhandshake.com/login?return=/job-search/103', title: 'Sign in', description: 'Sign in with your school.', gate: true },
  });
  const { repo, add, today } = await start(t, { browser });
  const search = repo.saveSearch({ name: 'Analyst interns', keywords: 'data analyst, business intelligence', location: '', sites: ['linkedin'], jobType: 'internship' });

  const outcome = await add({ jobs: [
    { title: 'Data Analyst Intern', company: 'Northwind Labs', location: 'San Francisco, CA', url: HS(101) },
    { title: 'Business Intelligence Intern, Summ…', company: 'Harbor Freight Lines', ref: 'e7' },
    { title: 'Operations Associate', company: 'Cobalt Bank', location: 'New York, NY', url: HS(103) },
  ] }, { run: { key: 'c1', own: false, job: '' } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.tier, 'undoable');
  assert.equal(outcome.view, 'feed');
  assert.equal(outcome.changed, true);
  assert.deepEqual(outcome.label, ['往今日岗位加了 3 个岗位（Handshake）', 'Added 3 jobs to Today (Handshake)']);
  const { jobs, ...totals } = outcome.result;
  assert.deepEqual(totals, { site: 'Handshake', added: 3, already: 0, skipped: 0, failed: 0, scoring: 'started' });
  assert.deepEqual(jobs.map(job => [job.title, job.state, job.search, job.description]), [
    ['Data Analyst Intern', 'added', 'Analyst interns', undefined],
    ['Business Intelligence Intern, Summ…', 'added', 'Analyst interns', undefined],
    ['Operations Associate', 'added', undefined, 'none'],
  ]);
  assert.match(jobs[2].note, /asks to sign in/);
  // One call to the browser for all of them, as whoever asked; nothing of a page comes back to the model.
  assert.equal(browser.calls.length, 1);
  assert.deepEqual(browser.calls[0].input, { items: [{ url: HS(101) }, { ref: 'e7' }, { url: HS(103) }] });
  assert.equal(browser.calls[0].context.by, 'assistant');
  assert.deepEqual(browser.calls[0].context.run, { key: 'c1', own: false, job: '' });
  assert.equal(JSON.stringify(outcome.result).includes('About the role'), false, 'the description goes to Dayjob, not to the model');

  const listed = today();
  assert.deepEqual(listed.map(item => item.id).sort(), ['handshake-101', 'handshake-102', 'handshake-103']);
  const first = repo.getPosting('handshake-101');
  assert.deepEqual([first.site, first.status, first.title, first.company, first.location, first.jobUrl], ['handshake', 'new', 'Data Analyst Intern', 'Northwind Labs', 'San Francisco, CA', 'https://app.joinhandshake.com/job-search/101']);
  assert.equal(first.description, TEXT.trim());
  // The page's own data fills in what the list cut short or left out.
  const second = repo.getPosting('handshake-102');
  assert.deepEqual([second.title, second.location, second.jobType, second.datePosted], ['Business Intelligence Intern, Summer 2027', 'Oakland, CA', 'internship', '2026-11-10']);
  // A link that led to a sign-in page: the job is kept by the link that was asked for, without a description.
  const third = repo.getPosting('handshake-103');
  assert.deepEqual([third.jobUrl, third.description], ['https://app.joinhandshake.com/job-search/103', null]);
  // Under the search that would keep them.
  assert.deepEqual(repo.listPostings({ status: 'new', searchId: search.id }).items.map(item => item.id).sort(), ['handshake-101', 'handshake-102']);

  // Undo takes back what is still as it was added; a job saved since stays.
  repo.setPostingStatus('handshake-102', 'saved');
  await outcome.undo();
  assert.deepEqual(today().map(item => item.id), []);
  assert.equal(repo.getPosting('handshake-101'), null);
  assert.equal(repo.getPosting('handshake-102').status, 'saved');
});

test('a job Dayjob already has is not added twice, and one the user removed stays removed', async t => {
  const browser = fakeBrowser({
    [HS(201)]: { title: 'Data Analyst', description: TEXT },
    [HS(202)]: { title: 'Data Scientist I', description: TEXT },
    [HS(203)]: { title: 'Research Analyst', description: TEXT },
    'https://app.joinhandshake.com/jobs/777': { title: 'Research Analyst', description: TEXT },
    'https://www.linkedin.com/jobs/view/4012345678': { title: 'Machine Learning Engineer', description: 'A shorter text read from the page. Machine Learning Engineer at Vertex.' },
  });
  const { repo, add, today } = await start(t, { browser });
  repo.updateSettings({ ai: { scoreMode: 'manual' } });
  // What the daily fetch brought earlier: one the user removed, one still new, and one LinkedIn job with its own text.
  const removed = repo.upsertPosting(posting({ site: 'linkedin', externalId: '4000000001', title: 'Data Analyst', company: 'Northwind Labs, Inc.', location: 'San Francisco, CA', jobUrl: 'https://www.linkedin.com/jobs/view/4000000001', description: 'From LinkedIn.' }));
  repo.setPostingStatus(removed.id, 'dismissed');
  repo.upsertPosting(posting({ site: 'indeed', externalId: 'aaaaaaaaaaaaaaaa', title: 'Data Scientist I', company: 'Harbor Logistics', location: 'Oakland, CA', jobUrl: 'https://www.indeed.com/viewjob?jk=aaaaaaaaaaaaaaaa' }));
  repo.upsertPosting(posting({ site: 'linkedin', externalId: '4012345678', title: 'Machine Learning Engineer, New Grad', company: 'Vertex', location: 'Palo Alto, CA', jobUrl: 'https://www.linkedin.com/jobs/view/4012345678', description: 'The full text from the fetch.' }));
  const before = today().map(item => item.id).sort();

  const outcome = await add({ jobs: [
    { title: 'Data Analyst', company: 'Northwind Labs', location: 'San Francisco, CA', url: HS(201) },
    { title: 'Data Scientist I', company: 'Harbor Logistics', location: 'Oakland, CA', url: HS(202) },
    { title: 'Machine Learning Engineer', company: 'Vertex', url: 'https://www.linkedin.com/jobs/view/machine-learning-engineer-at-vertex-4012345678?trk=x' },
    { title: 'Research Analyst', company: 'Cobalt Bank', location: 'New York, NY', url: HS(203) },
  ] });
  assert.equal(outcome.ok, true);
  const { jobs, ...totals } = outcome.result;
  assert.deepEqual(totals, { site: 'Handshake', added: 1, already: 3, skipped: 0, failed: 0, scoring: 'not automatic: the user scores jobs themselves' });
  assert.deepEqual(jobs.map(job => [job.state, job.id, job.status]), [
    ['already', 'li-4000000001', 'dismissed'], ['already', 'in-aaaaaaaaaaaaaaaa', 'new'], ['already', 'li-4012345678', 'new'], ['added', 'handshake-203', undefined]]);
  assert.match(jobs[0].note, /Dayjob has this job from linkedin; the two are kept as one\. The user removed this job; it stays removed\./);
  assert.match(jobs[1].note, /from indeed/);
  // Today gained the one new job and nothing else; the removed one is not back.
  assert.deepEqual(today().map(item => item.id).sort(), [...before, 'handshake-203'].sort());
  assert.equal(repo.getPosting('li-4000000001').status, 'dismissed');
  // The LinkedIn job read on its page is the fetched posting itself: it keeps its title, its link and its text.
  const same = repo.getPosting('li-4012345678');
  assert.deepEqual([same.title, same.jobUrl, same.description, same.location], ['Machine Learning Engineer, New Grad', 'https://www.linkedin.com/jobs/view/4012345678', 'The full text from the fetch.', 'Palo Alto, CA']);

  // The same job by another link of the same site is the one Dayjob has; nothing is added, so there is nothing to undo.
  const again = await add({ jobs: [{ title: 'Research Analyst', company: 'Cobalt Bank', location: 'New York, NY', url: 'https://app.joinhandshake.com/jobs/777' }] });
  assert.deepEqual(again.result.jobs.map(job => [job.state, job.id, job.status]), [['already', 'handshake-203', 'new']]);
  assert.deepEqual(again.label, ['这 1 个岗位 Dayjob 已经有了', 'Dayjob already had this job']);
  assert.equal(again.changed, false);
  assert.equal(again.undo, null);
  assert.equal(repo.getPosting('handshake-777'), null);

  // A fetch that finds the Handshake job on another site later keeps the two as one: no second row in Today.
  const later = repo.upsertPosting(posting({ site: 'linkedin', externalId: '4999999999', title: 'Research Analyst', company: 'Cobalt Bank', location: 'New York, NY', jobUrl: 'https://www.linkedin.com/jobs/view/4999999999' }));
  assert.deepEqual([later.isNew, later.duplicate], [false, true]);
  assert.equal(today().filter(item => item.title === 'Research Analyst').length, 1);
  // Undoing the first call hands the job's place to that twin.
  await outcome.undo();
  assert.equal(repo.getPosting('handshake-203'), null);
  assert.deepEqual(today().filter(item => item.title === 'Research Analyst').map(item => item.id), ['li-4999999999']);
});

test('on one site, a removed job stays removed by another link, and a posting that closed does not hold back the job posted anew', async t => {
  const page = { title: 'Supply Chain Analyst', description: TEXT };
  const browser = fakeBrowser({ [HS(401)]: page, 'https://app.joinhandshake.com/jobs/402': page, 'https://app.joinhandshake.com/jobs/403': page });
  const { repo, add, today } = await start(t, { browser });
  repo.updateSettings({ ai: { scoreMode: 'manual' } });
  const job = url => ({ jobs: [{ title: 'Supply Chain Analyst', company: 'Cobalt Freight', location: 'Reno, NV', url }] });
  assert.equal((await add(job(HS(401)))).result.added, 1);
  repo.setPostingStatus('handshake-401', 'dismissed');
  const gone = await add(job('https://app.joinhandshake.com/jobs/402'));
  assert.deepEqual(gone.result.jobs.map(item => [item.state, item.id, item.status, item.note]), [['already', 'handshake-401', 'dismissed', 'The user removed this job; it stays removed.']]);
  assert.equal(repo.getPosting('handshake-402'), null);
  assert.equal(today().length, 0);
  // The posting has closed since; the employer posts the job again under a new number: that one is a new job.
  repo.markChecked('handshake-401', false);
  const anew = await add(job('https://app.joinhandshake.com/jobs/403'));
  assert.deepEqual(anew.result.jobs.map(item => [item.state, item.id]), [['added', 'handshake-403']]);
  assert.deepEqual(today().map(item => item.id), ['handshake-403']);
});

test('only the jobs a saved search keeps, the open page, and what cannot be read', async t => {
  const browser = fakeBrowser({
    here: { url: 'https://careers.example.com/jobs/77?utm_source=x', here: true, structured: true, title: 'Data Engineer', company: 'Example Corp', location: 'Remote', remote: true, description: `Example Corp. ${TEXT}` },
    [HS(301)]: { title: 'Data Analyst', description: TEXT },
    e3: { error: 'missing-ref' },
    e4: { error: 'no-link' },
    [HS(305)]: { title: 'Barista', description: 'Coffee and more coffee. Marketing intern. Sales associate.' },
  });
  const { repo, add, today } = await start(t, { browser });
  repo.saveSearch({ name: 'Analysts', keywords: 'data analyst', location: 'San Francisco, CA', sites: ['linkedin'], excludeKeywords: ['senior'] });
  repo.saveSearch({ name: 'Off', keywords: 'marketing', location: '', sites: ['linkedin'], enabled: false });

  const picked = await add({ onlyMatching: true, jobs: [
    { title: 'Data Analyst', company: 'Northwind Labs', location: 'San Francisco, CA', url: HS(301) },
    { title: 'Senior Data Analyst', company: 'Northwind Labs', location: 'San Francisco, CA', url: HS(302) },
    { title: 'Data Analyst', company: 'Harbor Logistics', location: 'Austin, TX', url: HS(303) },
    { title: 'Marketing Intern', company: 'Meridian Media', location: 'San Francisco, CA', url: HS(304) },
  ] });
  assert.deepEqual(picked.result.jobs.map(job => job.state), ['added', 'skipped', 'skipped', 'skipped']);
  assert.match(picked.result.jobs[1].note, /None of the enabled searches/);
  assert.deepEqual(browser.calls.at(-1).input, { items: [{ url: HS(301) }] }, 'a job that is left out is not visited');

  // The job whose own page is open, with nothing but what it is called.
  const open = await add({ jobs: [{ title: 'Data Engineer', company: 'Example Corp' }] });
  assert.deepEqual(browser.calls.at(-1).input, { items: [{}] });
  const added = repo.getPosting(open.result.jobs[0].id);
  assert.deepEqual([added.site, added.jobUrl, added.location, added.isRemote], ['manual', 'https://careers.example.com/jobs/77', 'Remote', true]);
  assert.equal(open.result.site, 'careers.example.com');

  // Refs that no longer hold, a thing that is no link, and a page that is about something else.
  const rest = await add({ jobs: [
    { title: 'Product Analyst', company: 'Acme', ref: 'e3' }, { title: 'Growth Analyst', company: 'Acme', ref: 'e4' },
    { title: 'Financial Analyst', company: 'Cobalt Bank', url: HS(305) }, { title: 'Risk Analyst', company: 'Cobalt Bank', url: HS(306) },
  ] });
  assert.deepEqual(rest.result.jobs.map(job => [job.state, job.description]), [['failed', undefined], ['failed', undefined], ['added', 'none'], ['added', 'none']]);
  assert.match(rest.result.jobs[0].note, /Read the page again/);
  assert.match(rest.result.jobs[1].note, /not a link to a job/);
  assert.match(rest.result.jobs[2].note, /did not look like this job/);
  assert.match(rest.result.jobs[3].note, /did not load/);
  assert.equal(repo.getPosting('handshake-305').description, null, 'another page\'s text is not kept as this job\'s');
  assert.equal(today().length, 4);

  // What the browser refuses comes back in its own words; bad input is said plainly.
  browser.run = async () => { const error = new Error('No page is open in the Dayjob browser. Open one with dayjob_browser_open.'); error.status = 409; throw error; };
  const refused = await add({ jobs: [{ title: 'Data Engineer', company: 'Example Corp' }] });
  assert.deepEqual([refused.ok, refused.error], [false, 'No page is open in the Dayjob browser. Open one with browser_open.']);
  assert.equal((await add({ jobs: [] })).ok, false);
  assert.equal((await add({ jobs: [{ title: 'x', company: 'y', ref: 'nope' }] })).ok, false);
});

test('without the Dayjob browser a job is added from what the user gave; the prompt and the tool list say how', async t => {
  const { app, repo, add } = await start(t);
  const tool = app.assistant.tools.get('add_postings');
  assert.match(tool.description, /There is no Dayjob browser here/);
  const outcome = await add({ jobs: [
    { title: 'Data Analyst', company: 'Northwind Labs', url: 'https://careers.example.com/jobs/9', description: 'Pasted by the user: SQL, Python, dashboards.' },
    { title: 'Data Scientist', company: 'Northwind Labs' },
  ] });
  assert.deepEqual(outcome.result.jobs.map(job => job.state), ['added', 'skipped']);
  assert.match(outcome.result.jobs[1].note, /Give this job's link/);
  assert.equal(repo.getPosting(outcome.result.jobs[0].id).description, 'Pasted by the user: SQL, Python, dashboards.');

  assert.match(SYSTEM_PROMPT, /Jobs from a web page/);
  assert.match(SYSTEM_PROMPT, /Do not sign in to a school's or a company's single sign-on for them\./);
  // With a browser the tool comes with the browser's group, and a message about a site brings that group along.
  const desk = await start(t, { browser: fakeBrowser({}) });
  assert.ok(desk.app.assistant.tools.groups().apply.tools.includes('add_postings'));
  assert.match(desk.app.assistant.tools.get('add_postings').description, /Dayjob then opens each job's page itself/);
});
