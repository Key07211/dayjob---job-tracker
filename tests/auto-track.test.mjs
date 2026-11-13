import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { posting } from '../server/jobs/normalize.mjs';

// 自动收录: what the Dayjob browser hands over once a page says an application went through (desktop/browser.cjs),
// and what Dayjob makes of it. The browser side runs in the Electron smoke test; this is the deciding part.
const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const PAGE = { url: 'https://boards.example.com/acme/apply/7/thanks', title: 'Application received' };
const THANKS = 'thank you for applying. we have received your application.';
const FORM = 'apply for data analyst at acme analytics first name last name email resume submit application';

function scripted(id) {
  const results = [];
  return {
    id, results,
    status: async () => ({ available: true, detail: 'test' }),
    live: () => false, close() {}, closeAll() {}, conversationFor: () => null,
    async send({ text, callTool, onRound, onText }) {
      const said = text.split(/<\/earlier_conversation>|<\/dayjob_note>/).at(-1).trim();
      onRound();
      const wanted = /^call:(\w+)\s*(\{.*\})?$/s.exec(said);
      if (!wanted) { onText(`Echo: ${said}`); return { usage: USAGE, model: 'test-model', rounds: 1 }; }
      const outcome = await callTool(wanted[1], JSON.parse(wanted[2] || '{}'));
      results.push({ ok: outcome.ok, value: JSON.parse(outcome.content) });
      onText(outcome.ok ? 'Done.' : 'Failed.');
      return { usage: USAGE, model: 'test-model', rounds: 2 };
    },
  };
}

async function start({ browser } = {}) {
  const engines = { 'claude-cli': scripted('claude-cli'), 'anthropic-api': scripted('anthropic-api') };
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {},
    detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }), score: async () => { throw new Error('No scoring in these tests.'); } } },
    assistantEngines: engines, ...(browser ? { browser } : {}) });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const writeHeaders = { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken };
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: method === 'GET' ? {} : writeHeaders, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const chat = async (text, conversationId) => {
    const response = await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text, conversationId }) });
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const done = events.find(event => event.type === 'tool' && event.phase === 'done');
    return { events, done, id: events.at(-1).conversation.id, reply: events.at(-1).conversation.turns.at(-1) };
  };
  const add = (key, more = {}) => app.repo.upsertPosting(posting({ site: 'linkedin', externalId: key, title: 'Data Analyst', company: 'Acme Analytics', jobUrl: `https://www.linkedin.com/jobs/view/${key}`,
    description: 'Analyse product data with SQL and Python.', ...more }));
  return { app, call, chat, engines, add };
}

// What the page script reads off a posting's own page (schema.org JobPosting).
const draft = (more = {}) => ({ structured: true, url: 'https://boards.example.com/harbor/jobs/9', title: 'Operations Analyst', company: 'Harbor Freight Lines', location: 'Oakland, CA',
  description: 'Plan routes and report on them.', datePosted: '2026-11-02T08:00:00Z', employmentType: 'FULL_TIME', ...more });

test('an application the page confirms is recorded against the posting the tab came from', async t => {
  const { app, add } = await start();
  t.after(() => app.close());
  const job = add('a');
  const trail = ['https://boards.example.com/acme/apply/7', 'https://www.linkedin.com/jobs/view/a?trk=feed'];

  const outcome = app.trackApplied({ urls: trail, by: 'user', words: `${FORM} ${THANKS}`, page: trail[0] });
  assert.equal(outcome.status, 'recorded');
  assert.equal(outcome.created, false, 'the posting was there already');
  assert.deepEqual(outcome.posting, { id: job.id });
  assert.deepEqual({ company: outcome.application.company, title: outcome.application.title }, { company: 'Acme Analytics', title: 'Data Analyst' });
  const application = app.repo.getApplication(outcome.application.id);
  assert.equal(application.status, 'applied');
  assert.equal(application.postingId, job.id);
  assert.equal(application.events.at(-1).source, 'auto');
  assert.match(application.notes, /^自动收录：你在 Dayjob 浏览器里提交后/);
  assert.ok(application.nextFollowUpAt, 'tracking has started: a follow-up is due');
  assert.equal(app.repo.getPosting(job.id).status, 'applied');

  // The same confirmation seen again (a reload, the next look) records nothing twice.
  const again = app.trackApplied({ urls: trail, by: 'user', words: `${FORM} ${THANKS}`, page: trail[0] });
  assert.equal(again.status, 'already');
  assert.equal(again.application.id, outcome.application.id);
  assert.equal(app.repo.listApplications().length, 1);
});

test('the note says who sent it, in the language of the app', async t => {
  const { app, call, add } = await start();
  t.after(() => app.close());
  add('a'); add('b', { title: 'Growth Analyst' }); add('c', { title: 'Risk Analyst' });
  const note = (key, by) => app.repo.getApplication(app.trackApplied({ urls: [`https://www.linkedin.com/jobs/view/${key}`], by, words: 'acme analytics' }).application.id).notes;
  assert.match(note('a', 'assistant'), /^自动收录：助手在 Dayjob 浏览器里提交后/);
  assert.equal((await call('/api/settings', { method: 'PATCH', body: { language: 'en' } })).status, 200);
  assert.equal(note('b', 'claude'), 'Recorded automatically: after Claude sent it in the Dayjob browser, the page said the application was received.');
  assert.match(note('c', 'user'), /after you sent it/);
});

test('a job Dayjob never fetched is taken from what its own page says, and only when the form was about it', async t => {
  const { app } = await start();
  t.after(() => app.close());
  const trail = ['https://boards.example.com/harbor/jobs/9/apply', 'https://boards.example.com/harbor/jobs/9'];
  const words = `application for operations analyst first name resume ${THANKS}`;

  const outcome = app.trackApplied({ urls: trail, draft: draft(), by: 'user', words, page: trail[0] });
  assert.equal(outcome.status, 'recorded');
  assert.equal(outcome.created, true);
  const made = app.repo.getPosting(outcome.posting.id);
  assert.deepEqual({ title: made.title, company: made.company, location: made.location, jobUrl: made.jobUrl, site: made.site, jobType: made.jobType, datePosted: made.datePosted },
    { title: 'Operations Analyst', company: 'Harbor Freight Lines', location: 'Oakland, CA', jobUrl: 'https://boards.example.com/harbor/jobs/9', site: 'manual', jobType: 'fulltime', datePosted: '2026-11-02' });
  assert.equal(made.status, 'applied');
  assert.equal(app.repo.applicationForPosting(made.id).id, outcome.application.id);
  // Coming back to it finds the posting by its address.
  assert.equal(app.trackApplied({ urls: trail, draft: draft(), words }).status, 'already');

  // A page that only looks like a job page is not enough to go on.
  const other = { urls: ['https://jobs.example.org/x/apply', 'https://jobs.example.org/x'], words };
  assert.deepEqual(app.trackApplied({ ...other, draft: draft({ structured: false, url: 'https://jobs.example.org/x' }) }), { status: 'unknown' });
  assert.deepEqual(app.trackApplied({ ...other, draft: draft({ company: '', url: 'https://jobs.example.org/x' }) }), { status: 'unknown' });
  assert.deepEqual(app.trackApplied({ ...other, draft: draft({ url: '' }) }), { status: 'unknown' });
  assert.deepEqual(app.trackApplied({ ...other, draft: draft({ url: 'javascript:alert(1)' }) }), { status: 'unknown' });
  assert.deepEqual(app.trackApplied({ ...other }), { status: 'unknown' });
  assert.deepEqual(app.trackApplied(), { status: 'unknown' });
  assert.equal(app.repo.listApplications().length, 1);
});

test('a confirmation that names neither the job nor the company is asked about, not guessed', async t => {
  const { app, add } = await start();
  t.after(() => app.close());
  const job = add('a');
  const quiet = `newsletter sign-up your email ${THANKS}`;

  // The tab passed a posting earlier, but what was sent says nothing about it.
  assert.deepEqual(app.trackApplied({ urls: ['https://forms.example.net/f/1', 'https://www.linkedin.com/jobs/view/a'], words: quiet, page: 'https://forms.example.net/f/1' }),
    { status: 'unsure', guess: { title: 'Data Analyst', company: 'Acme Analytics' } });
  assert.deepEqual(app.trackApplied({ urls: ['https://forms.example.net/f/1'], draft: draft(), words: quiet, page: 'https://forms.example.net/f/1' }),
    { status: 'unsure', guess: { title: 'Operations Analyst', company: 'Harbor Freight Lines' } });
  assert.equal(app.repo.listApplications().length, 0);
  assert.equal(app.repo.getPosting(job.id).status, 'new');
  // Two letters are no evidence: "QA" is in half the words on a page.
  add('q', { title: 'QA', company: 'Go' });
  assert.equal(app.trackApplied({ urls: ['https://www.linkedin.com/jobs/view/q'], words: 'quality and good things' }).status, 'unsure');

  // The user says it was that job: recorded, with no more questions.
  const named = app.trackApplied({ urls: ['https://forms.example.net/f/1', 'https://www.linkedin.com/jobs/view/a'], draft: { structured: true, title: 'Data Analyst', company: 'Acme Analytics' },
    words: quiet, page: 'https://forms.example.net/f/1', named: true });
  assert.equal(named.status, 'recorded');
  assert.deepEqual(named.posting, { id: job.id });

  // The user names another job than the one the tab passed: it gets a posting of its own, under the form's address.
  add('b', { title: 'Growth Analyst' });
  const form = 'https://forms.example.net/f/2';
  const elsewhere = app.trackApplied({ urls: [form, 'https://www.linkedin.com/jobs/view/b'], draft: { structured: true, url: 'https://www.linkedin.com/jobs/view/b', title: 'Operations Analyst', company: 'Harbor Freight Lines' },
    words: quiet, page: form, named: true });
  assert.equal(elsewhere.status, 'recorded');
  assert.equal(elsewhere.created, true);
  const made = app.repo.getPosting(elsewhere.posting.id);
  assert.deepEqual({ title: made.title, company: made.company, jobUrl: made.jobUrl }, { title: 'Operations Analyst', company: 'Harbor Freight Lines', jobUrl: form });
  assert.equal(made.description || '', '', 'nothing is copied from the other job\'s page');
  assert.equal(app.repo.applicationForPosting('li-b'), null, 'the job the tab passed is left alone');
  assert.equal(app.repo.listApplications().length, 2);
});

test('the assistant\'s sending click reports the record, and recording it again is not an error', async t => {
  let job;
  const answers = { click: () => ({ clicked: { ref: 'e9', role: 'button', name: 'Submit application' }, allowed: 'user' }) };
  const browser = { async run(action) { return { ...(await answers[action]()), page: { ...PAGE } }; } };
  const { app, chat, engines, add } = await start({ browser });
  t.after(() => app.close());
  job = add('a');
  const engine = engines['claude-cli'];

  // Sent, but the page has not said so (yet): a confirm step, and nothing recorded.
  const sent = await chat('call:browser_click {"ref":"e9"}');
  assert.equal(sent.done.tool.step, 'confirm');
  assert.equal(sent.done.changed, false);
  assert.deepEqual(sent.done.tool.label, ['点了“Submit application”（你确认过）', 'Clicked “Submit application” (you allowed it)']);

  // The Dayjob browser recorded it when the page confirmed.
  answers.click = () => {
    const outcome = app.trackApplied({ urls: ['https://www.linkedin.com/jobs/view/a'], by: 'assistant', words: 'data analyst' });
    return { clicked: { ref: 'e9', role: 'button', name: 'Submit application' }, allowed: 'user',
      recorded: { applicationId: outcome.application.id, company: outcome.application.company, title: outcome.application.title, ...(outcome.status === 'already' ? { already: true } : {}) } };
  };
  const recorded = await chat('call:browser_click {"ref":"e9"}', sent.id);
  assert.equal(recorded.done.tool.step, 'record', 'the last step of the application is done');
  assert.equal(recorded.done.changed, true, 'the lists in the window reload');
  assert.equal(recorded.done.applied, false, 'the window celebrates once, when the browser says so');
  assert.deepEqual(recorded.done.tool.label, ['点了“Submit application”（你确认过），已自动记为已投递', 'Clicked “Submit application” (you allowed it); recorded as applied']);
  assert.equal(recorded.done.tool.undoable, false);
  assert.equal(engine.results.at(-1).value.recorded.title, 'Data Analyst');
  const application = app.repo.applicationForPosting(job.id);
  assert.equal(application.events.at(-1).source, 'auto');

  // A model that records it anyway is told it is done, and nothing is added or broken.
  const marked = await chat(`call:mark_applied {"id":"${job.id}"}`, sent.id);
  assert.equal(marked.reply.tools.at(-1).ok, true);
  assert.equal(marked.done.tool.step, 'record');
  assert.equal(marked.done.changed, false);
  assert.equal(marked.done.tool.undoable, false, 'it is not the assistant\'s to take back');
  assert.match(engine.results.at(-1).value.note, /already recorded this application/);
  assert.equal(app.repo.listApplications().length, 1);

  // Clicking send once more on a page that is already recorded changes nothing.
  const twice = await chat('call:browser_click {"ref":"e9"}', sent.id);
  assert.equal(twice.done.tool.step, 'record');
  assert.equal(twice.done.changed, false);
  assert.equal(engine.results.at(-1).value.recorded.already, true);

  // An application the user recorded themselves is no such case: the usual refusal.
  const other = app.repo.getPosting(add('b', { title: 'Growth Analyst' }).id);
  app.repo.createApplication({ postingId: other.id, company: other.company, title: other.title, jobUrl: other.jobUrl, followUpDays: 7 });
  await chat(`call:mark_applied {"id":"${other.id}"}`, sent.id);
  assert.match(engine.results.at(-1).value.error, /already tracked/);
});
