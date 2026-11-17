import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { AssistantError, SYSTEM_PROMPT } from '../server/assistant/prompt.mjs';
import { createFeedback, entryText, scrub, sumSteps } from '../server/assistant/feedback.mjs';

// 同时申请, the feedback file, and what each step of a reply used.

const PAGE = { url: 'https://jobs.example.com/apply/42', title: 'Apply · Data Analyst' };
const step = (input, output, read = 0, write = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write });

// A stand-in engine. A reply does what `plan({ conversation, text, said })` lists, in order:
//   { step: usage }      a request to the model that used this much
//   { call: [tool, input] }
//   { wait: name }       stands still until open(name), or until the reply is stopped
//   { say: text }  { fail: code }
function staged(id) {
  const seen = [];
  const results = [];
  const waits = new Map();
  const engine = {
    id, seen, results, plan: () => [{ say: 'Done.' }],
    waiting: name => waits.has(name),
    open(name) { waits.get(name)?.(); waits.delete(name); },
    status: async () => ({ available: true, detail: 'test' }),
    live: () => false, close() {}, closeAll() {}, conversationFor: () => null,
    async send({ id: conversation, text, callTool, onStep = () => {}, onText, onRound, signal }) {
      const said = text.split(/<\/earlier_conversation>|<\/dayjob_note>/).at(-1).trim();
      seen.push({ conversation, text, said });
      onRound();
      let rounds = 0;
      for (const act of engine.plan({ conversation, text, said })) {
        if (signal?.aborted) throw signal.reason || new Error('Stopped.');
        if (act.step) { rounds += 1; onStep({ kind: act.kind || 'reply', model: 'claude-opus-5-5', usage: act.step }); }
        if (act.call) { const outcome = await callTool(act.call[0], act.call[1] || {}); results.push({ conversation, tool: act.call[0], ok: outcome.ok, value: JSON.parse(outcome.content) }); }
        if (act.wait) {
          await new Promise((resolve, reject) => {
            waits.set(act.wait, resolve);
            signal?.addEventListener('abort', () => { waits.delete(act.wait); reject(signal.reason || new Error('Stopped.')); }, { once: true });
          });
        }
        if (act.say) onText(act.say);
        if (act.fail) throw new AssistantError(act.fail, 'The Claude API is rate limiting requests. Try again in a moment.');
      }
      return { usage: step(10, 5), model: 'claude-opus-5-5', rounds: rounds || 1 };
    },
  };
  return engine;
}

// A stand-in for the Dayjob browser: it keeps what it was asked, and which applications it was told are over.
function fakeBrowser(answers = {}) {
  const calls = [];
  const ended = [];
  return { calls, ended, answers,
    async run(action, input, context) {
      calls.push({ action, input, context });
      const answer = answers[action];
      const value = typeof answer === 'function' ? await answer(input, context) : answer;
      return { ...(value || {}), page: { ...PAGE } };
    },
    endRun(key, options = {}) { ended.push({ key, ...options }); } };
}

async function start({ browser = fakeBrowser(), dataDir = ':memory:', language } = {}) {
  const engine = staged('claude-cli');
  const app = await createApp({ dataDir, startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {},
    detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }), score: async () => { throw new Error('No scoring in these tests.'); } } },
    assistantEngines: { 'claude-cli': engine, 'anthropic-api': staged('anthropic-api') }, ...(browser ? { browser } : {}) });
  if (language) app.repo.updateSettings({ language });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const headers = { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken };
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: method === 'GET' ? {} : headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const lines = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const chat = async (text, conversationId) => {
    const events = await lines(await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers, body: JSON.stringify({ text, conversationId }) }));
    return { events, id: events.at(-1).conversation.id, conversation: events.at(-1).conversation, reply: events.at(-1).conversation.turns.at(-1) };
  };
  // Looks in on a conversation and stays until its reply is over.
  const follow = async id => lines(await fetch(`${url}/api/assistant/conversations/${id}/live`, { method: 'POST', headers, body: '{}' }));
  const add = key => app.repo.upsertPosting(posting({ site: 'linkedin', externalId: key, title: `Data Analyst ${key}`, company: `Company ${key}`, jobUrl: `https://www.linkedin.com/jobs/view/${key}`,
    description: 'Analyse product data with SQL and Python.' }));
  const apply = async item => (await call('/api/assistant/applications', { method: 'POST', body: { postingId: item.id } }));
  const runs = async () => (await call('/api/assistant/runs')).body.runs;
  const until = async (check, what = 'it') => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`${what} did not happen`);
  };
  return { app, url, headers, call, chat, follow, add, apply, runs, until, engine, browser };
}
// Which posting a reply is for: the note of an application's own conversation names it.
const postingOf = text => /posting (\S+) \(/.exec(text)?.[1] || null;

test('a job in the Today list gets an application of its own: its conversation, its tab, and its place in the list', async t => {
  const browser = fakeBrowser({ click: () => ({ clicked: { ref: 'e9', role: 'button', name: 'Submit application' }, allowed: 'user', recorded: { applicationId: 'a1' } }) });
  const { app, call, apply, runs, until, engine, add } = await start({ browser });
  t.after(() => app.close());
  const job = add('one');
  engine.plan = () => [{ step: step(200, 30, 5000, 800) }, { call: ['open_application', { id: job.id }] }, { wait: 'form' }, { step: step(100, 40, 6000, 0) }, { call: ['browser_click', { ref: 'e9' }] },
    { step: step(50, 20, 6200, 0) }, { call: ['report_application', { outcome: 'submitted' }] }, { say: 'Sent.' }];

  assert.equal((await call('/api/assistant/applications', { method: 'POST', body: {} })).status, 400);
  assert.equal((await call('/api/assistant/applications', { method: 'POST', body: { postingId: 'nothing' } })).status, 404);
  const started = await apply(job);
  assert.equal(started.status, 201);
  const run = started.body.run;
  assert.deepEqual({ postingId: run.postingId, job: run.job, state: run.state, outcome: run.outcome, parent: run.parent }, { postingId: job.id, job: 'Company one · Data Analyst one', state: 'working', outcome: null, parent: null });
  assert.equal(started.body.parallel, 3);
  // Asking again while it is under way gives the same one back.
  const again = await apply(job);
  assert.equal(again.status, 200);
  assert.equal(again.body.run.id, run.id);
  assert.equal((await runs()).length, 1);

  await until(() => engine.waiting('form'), 'the reply reaching the form');
  // The model is told which posting this is and that it works by itself; the user sees a plain line.
  assert.match(engine.seen[0].text, new RegExp(`<dayjob_note>[^<]*one application[^<]*posting ${job.id} \\(Company one · Data Analyst one\\)[^<]*tab of its own[^<]*report_application`));
  assert.equal(engine.seen[0].said, '申请这个岗位：Company one · Data Analyst one');
  // Its steps in the Dayjob browser say whose they are: this conversation, in a tab of its own.
  assert.deepEqual(browser.calls[0].context.run, { key: run.id, own: true, job: 'Company one · Data Analyst one' });
  const midway = (await call(`/api/assistant/conversations/${run.id}`)).body;
  assert.equal(midway.busy, true);
  assert.equal(midway.run.state, 'working');
  assert.equal(midway.title, '申请这个岗位：Company one · Data Analyst one');
  assert.deepEqual((await runs())[0].steps, 1);
  // A message cannot cut in while it works, and leaving the pane does not take it off the list.
  assert.equal((await call('/api/assistant/chat', { method: 'POST', body: { text: 'hello', conversationId: run.id } })).status, 409);
  assert.equal((await call(`/api/assistant/conversations/${run.id}/close`, { method: 'POST' })).status, 200);
  assert.equal((await runs()).length, 1);

  engine.open('form');
  await until(async () => (await runs())[0].state === 'done', 'the application ending');
  const [done] = await runs();
  assert.deepEqual({ state: done.state, outcome: done.outcome, reason: done.reason, steps: done.steps, tokens: done.tokens }, { state: 'done', outcome: 'submitted', reason: '', steps: 3, tokens: 350 + 90 + 17200 + 800 });
  assert.ok(done.cost > 0 && done.endedAt >= done.startedAt);
  // The page confirmed it: the tab it worked in is closed.
  assert.deepEqual(browser.ended, [{ key: run.id, close: true }]);
  const over = (await call(`/api/assistant/conversations/${run.id}`)).body;
  assert.equal(over.busy, false);
  assert.equal(over.turns.at(-1).text, 'Sent.');
  assert.deepEqual(over.turns.at(-1).tools.map(tool => [tool.name, tool.stepNo]), [['open_application', 1], ['browser_click', 2], ['report_application', 3]]);
  // A later message goes on in the same conversation, and one that only talks leaves the outcome alone.
  engine.plan = () => [{ step: step(10, 5) }, { say: 'It went to Company one.' }];
  const asked = await call('/api/assistant/chat', { method: 'POST', body: { text: 'what did you send?', conversationId: run.id } });
  assert.equal(asked.status, 200);
  assert.equal((await runs())[0].outcome, 'submitted');
  assert.equal((await call('/api/assistant/feedback')).body.entries, 1);
  // Taking it off the list forgets the conversation (it was not kept).
  assert.deepEqual((await call(`/api/assistant/runs/${run.id}`, { method: 'DELETE' })).body.runs, []);
  assert.equal((await call(`/api/assistant/conversations/${run.id}`)).status, 404);
  assert.deepEqual(browser.ended.at(-1), { key: run.id, forgotten: true });
});

test('only a few applications are worked on at once: the rest wait their turn', async t => {
  const { app, call, apply, runs, until, engine, add, browser } = await start();
  t.after(() => app.close());
  const jobs = ['a', 'b', 'c', 'd'].map(add);
  const key = text => jobs.findIndex(job => job.id === postingOf(text));
  engine.plan = ({ text }) => [{ step: step(10, 5) }, { call: ['open_application', { id: jobs[key(text)].id }] }, { wait: `job-${key(text)}` }, { say: 'Stopped here.' }];
  assert.equal((await call('/api/assistant/settings', { method: 'PATCH', body: { parallel: 9 } })).status, 400);
  assert.equal((await call('/api/assistant/settings', { method: 'PATCH', body: { parallel: 2 } })).body.parallel, 2);

  const started = [];
  for (const job of jobs) started.push((await apply(job)).body.run);
  assert.deepEqual(started.map(run => run.state), ['working', 'working', 'queued', 'queued']);
  await until(() => engine.waiting('job-0') && engine.waiting('job-1'), 'two replies at work');
  assert.equal(engine.seen.length, 2, 'the others have not been sent to the model');
  // One that waits takes no message, and can be stopped before it ever starts.
  assert.equal((await call('/api/assistant/chat', { method: 'POST', body: { text: 'go', conversationId: started[3].id } })).status, 409);
  assert.equal((await call(`/api/assistant/conversations/${started[3].id}/stop`, { method: 'POST' })).body.run.outcome, 'stopped');
  // Two tabs are being worked in at the same time, each for its own application.
  assert.deepEqual(browser.calls.map(item => item.context.run.key).sort(), [started[0].id, started[1].id].sort());

  // A place comes free: the next in line starts by itself.
  engine.open('job-0');
  await until(() => engine.waiting('job-2'), 'the third starting');
  assert.deepEqual((await runs()).map(run => run.state), ['done', 'working', 'working', 'done']);
  // The reply ended without sending anything and without a word on why.
  assert.equal((await runs())[0].outcome, 'unclear');
  assert.deepEqual(browser.ended.find(item => item.key === started[0].id), { key: started[0].id, close: false });

  // More room at once starts what was waiting; stopping one that works ends its reply.
  const fifth = add('e');
  jobs.push(fifth);
  const waiting = (await apply(fifth)).body.run;
  assert.equal(waiting.state, 'queued');
  assert.equal((await call('/api/assistant/settings', { method: 'PATCH', body: { parallel: 3 } })).body.parallel, 3);
  await until(() => engine.waiting('job-4'), 'the fifth starting');
  await call(`/api/assistant/conversations/${started[1].id}/stop`, { method: 'POST' });
  await until(async () => (await runs())[1].state === 'done', 'the second stopping');
  assert.equal((await runs())[1].outcome, 'stopped');
  assert.equal((await call(`/api/assistant/conversations/${started[1].id}`)).body.turns.at(-1).stopped, true);
  // Taking a working one off the list stops it as well.
  assert.equal((await call(`/api/assistant/runs/${started[2].id}`, { method: 'DELETE' })).body.runs.some(run => run.id === started[2].id), false);
  await until(() => !engine.waiting('job-2'), 'the third stopping');
  engine.open('job-4');
  await until(async () => (await runs()).every(run => run.state === 'done'), 'everything ending');
  // A job already applied to is not started again.
  app.repo.createApplication({ postingId: jobs[0].id, company: 'Company a', title: 'Data Analyst a', appliedAt: '2026-11-16T10:00:00.000Z', followUpDays: 7 });
  const refused = await apply(jobs[0]);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /already tracked/);
});

test('the pane can look in on an application and leave again; only asking stops it', async t => {
  const { app, url, headers, call, apply, follow, runs, until, engine, add } = await start();
  t.after(() => app.close());
  const job = add('live');
  engine.plan = ({ said }) => (said === 'carry on' ? [{ step: step(5, 5) }, { wait: 'second' }, { say: 'Went on.' }]
    : [{ step: step(10, 5) }, { call: ['open_application', { id: job.id }] }, { say: 'Opened. ' }, { wait: 'first' }, { step: step(20, 5) }, { say: 'Stuck at a captcha.' }]);
  const run = (await apply(job)).body.run;
  await until(() => engine.waiting('first'), 'the reply standing still');

  // Looking in: how it stands, then what happens from here on, up to the end.
  const looking = follow(run.id);
  await new Promise(resolve => setTimeout(resolve, 30));
  engine.open('first');
  const events = await looking;
  assert.equal(events[0].type, 'snapshot');
  assert.equal(events[0].conversation.busy, true);
  assert.equal(events[0].conversation.turns.at(-1).text, 'Opened. ');
  assert.deepEqual(events[0].conversation.turns.at(-1).tools.map(tool => tool.name), ['open_application']);
  assert.equal(events[0].conversation.turns.at(-1).steps.length, 1);
  assert.deepEqual(events.slice(1).map(event => event.type), ['step', 'text', 'end']);
  assert.equal(events.at(-1).conversation.run.state, 'done');
  // Looking in on one that is over gives how it stands and nothing more.
  assert.deepEqual((await follow(run.id)).map(event => event.type), ['snapshot']);

  // A message sent in its conversation goes on in the background when the pane goes away.
  const controller = new AbortController();
  const sent = fetch(`${url}/api/assistant/chat`, { method: 'POST', headers, body: JSON.stringify({ text: 'carry on', conversationId: run.id }), signal: controller.signal });
  await until(() => engine.waiting('second'), 'the second reply standing still');
  controller.abort();
  await sent.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(engine.waiting('second'), true, 'leaving did not stop it');
  assert.equal((await runs())[0].state, 'working');
  engine.open('second');
  await until(async () => (await runs())[0].state === 'done', 'the second reply ending');
  assert.equal((await call(`/api/assistant/conversations/${run.id}`)).body.turns.at(-1).text, 'Went on.');

  // An ordinary conversation is as before: leaving it stops the reply.
  engine.plan = () => [{ wait: 'plain' }, { say: 'never' }];
  const plain = new AbortController();
  const asked = fetch(`${url}/api/assistant/chat`, { method: 'POST', headers, body: JSON.stringify({ text: 'hello' }), signal: plain.signal });
  await until(() => engine.waiting('plain'), 'the plain reply standing still');
  plain.abort();
  await asked.catch(() => {});
  await until(() => !engine.waiting('plain'), 'the plain reply stopping');
});

test('every step of a reply is kept with what it used: in the reply, in the database, and counted when it broke off', async t => {
  const { app, chat, call, engine, add, apply, until, runs } = await start();
  t.after(() => app.close());
  const job = add('steps');
  // What is put down with the rest of the AI usage, one row for a reply.
  const logged = [];
  const { logUsage } = app.repo;
  app.repo.logUsage = entry => { if (entry.kind === 'assistant') logged.push({ input: entry.usage.inputTokens, output: entry.usage.outputTokens, read: entry.usage.cacheReadTokens, turns: entry.turns }); return logUsage(entry); };
  engine.plan = () => [{ step: step(1200, 300, 40000, 5000) }, { call: ['get_status'] }, { call: ['list_postings'] }, { step: step(80, 150, 46000, 600), kind: 'compact' }, { step: step(90, 60, 2000, 300) }, { say: 'Three steps.' }];
  const talked = await chat('what is new?');
  const steps = talked.reply.steps;
  assert.deepEqual(steps.map(item => [item.n, item.kind || 'reply', item.tools, item.inputTokens, item.outputTokens, item.cacheReadTokens, item.cacheWriteTokens]),
    [[1, 'reply', ['get_status', 'list_postings'], 1200, 300, 40000, 5000], [2, 'compact', [], 80, 150, 46000, 600], [3, 'reply', [], 90, 60, 2000, 300]]);
  // Opus 5.5 at list prices: $4 in, $20 out, $0.2 read from the cache, $5 written to it, for a million tokens.
  assert.equal(Math.round(steps[0].cost * 1e6), Math.round(1200 * 4 + 300 * 20 + 40000 * 0.2 + 5000 * 5));
  assert.deepEqual(talked.reply.tools.map(tool => tool.stepNo), [1, 1]);
  assert.deepEqual(talked.events.filter(event => event.type === 'step').map(event => event.step.n), [1, 2, 3]);
  const rows = app.repo.listSteps(talked.id);
  assert.deepEqual(rows.map(row => [row.step, row.kind, row.tools, row.inputTokens, row.cacheReadTokens, row.provider, row.model, row.postingId]),
    [[1, 'reply', ['get_status', 'list_postings'], 1200, 40000, 'claude-cli', 'claude-opus-5-5', null], [2, 'compact', [], 80, 46000, 'claude-cli', 'claude-opus-5-5', null], [3, 'reply', [], 90, 2000, 'claude-cli', 'claude-opus-5-5', null]]);
  assert.equal(Math.round(rows[0].cost * 1e6), Math.round(steps[0].cost * 1e6));
  assert.equal(new Set(rows.map(row => row.replyAt)).size, 1);
  // The reply as a whole is counted once, as before, from what the engine said it used.
  assert.deepEqual(logged, [{ input: 10, output: 5, read: 0, turns: 3 }]);
  // No step, no row: an engine that reports nothing leaves the reply as it always was.
  engine.plan = () => [{ say: 'Nothing to count.' }];
  assert.deepEqual((await chat('hello', talked.id)).reply.steps, []);
  assert.equal(app.repo.listSteps(talked.id).length, 3);

  // A reply that broke off used what its steps used: that is counted as well, and its steps are kept.
  engine.plan = () => [{ step: step(500, 20, 9000, 100) }, { call: ['get_status'] }, { step: step(40, 10, 9600, 0) }, { fail: 'rate-limit' }];
  const broke = await chat('and again', talked.id);
  assert.equal(broke.reply.errorCode, 'rate-limit');
  assert.deepEqual(broke.reply.usage, step(540, 30, 18600, 100));
  assert.deepEqual(logged.at(-1), { input: 540, output: 30, read: 18600, turns: 2 });
  assert.equal(logged.length, 3);
  assert.equal(app.repo.listSteps(talked.id).length, 5);
  assert.equal(app.repo.listSteps(talked.id, broke.reply.at).length, 2);

  // An application's steps say which posting they were for.
  engine.plan = () => [{ step: step(10, 5) }, { call: ['open_application', { id: job.id }] }, { step: step(20, 5) }, { say: 'Stopped.' }];
  const run = (await apply(job)).body.run;
  await until(async () => (await runs())[0].state === 'done', 'the application ending');
  assert.deepEqual(app.repo.listSteps(run.id).map(row => [row.step, row.postingId, row.tools]), [[1, job.id, ['open_application']], [2, job.id, []]]);
  assert.equal((await call(`/api/assistant/conversations/${run.id}`)).body.turns.at(-1).steps.length, 2);
});

test('after an application Dayjob writes how it went into the feedback file, whatever the model reported', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-feedback-'));
  const browser = fakeBrowser({ click: (input, context) => { if (input.ref === 'e1') { const error = new Error('e1 is no longer on the page. Read the page again.'); error.status = 404; throw error; } return { clicked: { ref: input.ref, role: 'button', name: 'Next' } }; },
    autofill: () => ({ filled: [{ field: 'email' }, { field: 'firstName' }] }), read: () => ({ text: 'Thank you', elements: [] }) });
  const { app, call, chat, apply, runs, until, engine, add } = await start({ browser, dataDir });
  // The database is closed before its folder goes: Windows does not delete a file that is open.
  t.after(async () => { try { await app.close(); } finally { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } });
  const file = path.join(dataDir, 'feedback', 'apply-feedback.md');
  const info = (await call('/api/assistant')).body;
  assert.deepEqual(info.feedback, { file, folder: path.join(dataDir, 'feedback') });
  assert.deepEqual(info.parallel, { min: 1, max: 5, default: 3 });
  assert.deepEqual((await call('/api/assistant/feedback')).body, { file, folder: path.join(dataDir, 'feedback'), entries: 0, cut: false, text: '' });

  // 1. It could not be sent, and the model said why.
  const [first, second, third, fourth] = ['f1', 'f2', 'f3', 'f4'].map(add);
  engine.plan = () => [{ step: step(300, 40, 20000, 2000) }, { call: ['open_application', { id: first.id }] }, { step: step(100, 20, 22000, 500) }, { call: ['browser_click', { ref: 'e1' }] }, { call: ['browser_click', { ref: 'e1' }] },
    { step: step(90, 30, 23000, 0) }, { call: ['browser_click', { ref: 'e2' }] }, { step: step(80, 60, 23500, 0) },
    { call: ['report_application', { outcome: 'needs-user', stoppedAt: 'login', reason: 'The site sent a code to mei.lin@example.com and asked for it: 482913.',
      problems: [{ at: 'login', what: 'Sign-in asked for a one-time code', why: 'The account at +1 (415) 555-0134 has two-step sign-in' }, { what: 'The Next button moved after the page changed' }] }] }, { say: 'It needs your code.' }];
  await apply(first);
  await until(async () => (await runs()).at(-1).state === 'done', 'the first ending');
  let run = (await runs()).at(-1);
  assert.equal(run.outcome, 'needs-user');
  assert.equal(run.reason, 'The site sent a code to [email] and asked for it: [number].');
  let text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# Dayjob 申请问题反馈\n\n助手每做完一次申请/);
  assert.match(text, /\n## \d{4}-\d\d-\d\d \d\d:\d\d · Company f1 · Data Analyst f1\n\n- 结果: 没投出去：需要你来处理\n- 停在: 登录\n- 原因: The site sent a code to \[email\] and asked for it: \[number\]\.\n- 网站: www\.linkedin\.com\n- 引擎和模型: Claude Code · claude-opus-5-5\n- 用时: \d+ 秒，共 4 步\n/);
  assert.match(text, /- Token: 输入 91,570（其中读缓存 88,500，写缓存 2,500），输出 150；约 \$0\.0\d+（Claude Code 走订阅，这是按 API 价格折算的参考数）\n/);
  assert.match(text, /- 用得最多的几步: 第 1 步（open_application）输入 22,300、输出 40，\$0\.0\d+；第 2 步（browser_click, browser_click）/);
  assert.match(text, /遇到的问题：\n\n1\. \[登录\] Sign-in asked for a one-time code：The account at \[number\] has two-step sign-in\n2\. The Next button moved after the page changed\n3\. browser_click 没做成 2 次：e1 is no longer on the page\. Read the page again\.（Dayjob 记录）\n/);
  // Nothing that was typed or sent to the user gets in.
  for (const secret of ['mei.lin@example.com', '482913', '555-0134']) assert.equal(text.includes(secret), false, secret);

  // 2. The model said nothing at all, and the reply broke off: Dayjob still writes what it saw.
  engine.plan = () => [{ step: step(10, 5) }, { call: ['open_application', { id: second.id }] }, { call: ['browser_autofill', {}] }, { step: step(10, 5) }, { fail: 'rate-limit' }];
  await apply(second);
  await until(async () => (await runs()).at(-1).state === 'done', 'the second ending');
  run = (await runs()).at(-1);
  assert.deepEqual([run.outcome, run.reason], ['error', 'The Claude API is rate limiting requests. Try again in a moment.']);
  text = fs.readFileSync(file, 'utf8');
  assert.match(text, /## [^\n]* · Company f2 · Data Analyst f2\n\n- 结果: 没投出去：助手出错了\n- 停在: 填写表单\n- 原因: The Claude API is rate limiting requests\. Try again in a moment\.\n/);

  // 3. In English when the window is in English; one that was stopped says so.
  app.repo.updateSettings({ language: 'en' });
  engine.plan = () => [{ step: step(10, 5) }, { call: ['open_application', { id: third.id }] }, { wait: 'third' }];
  const stopped = (await apply(third)).body.run;
  await until(() => engine.waiting('third'), 'the third standing still');
  assert.equal(engine.seen.at(-1).said, 'Apply to this job: Company f3 · Data Analyst f3');
  await call(`/api/assistant/conversations/${stopped.id}/stop`, { method: 'POST' });
  await until(async () => (await runs()).at(-1).state === 'done', 'the third ending');
  text = fs.readFileSync(file, 'utf8');
  assert.match(text, /## [^\n]* · Company f3 · Data Analyst f3\n\n- Result: Not sent: you stopped it\n- Stopped at: Opening the page\n- Site: www\.linkedin\.com\n- Engine and model: Claude Code · claude-opus-5-5\n- Time: \d+ s, 1 step\n- Token: input 10 \(0 read from the cache, 0 written to it\), output 5; about \$0\.0\d+ \(Claude Code runs on a subscription[^\n]*\n\nNo problems were noted\.\n/);

  // 4. An application done in an ordinary conversation is noted too; a chat about something else is not.
  engine.plan = () => [{ step: step(10, 5) }, { call: ['open_application', { id: fourth.id }] }, { call: ['report_application', { outcome: 'skipped', reason: 'The posting is closed.' }] }, { say: 'Closed.' }];
  const talked = await chat('apply to the fourth one');
  assert.equal(talked.conversation.run, null);
  assert.equal((await call('/api/assistant/feedback')).body.entries, 4);
  assert.match(fs.readFileSync(file, 'utf8'), /Company f4 · Data Analyst f4\n\n- Result: Not sent: skipped\n- Stopped at: Opening the page\n- Why: The posting is closed\.\n/);
  engine.plan = () => [{ step: step(10, 5) }, { call: ['get_status'] }, { say: 'All quiet.' }];
  await chat('anything new?', talked.id);
  const read = (await call('/api/assistant/feedback')).body;
  assert.equal(read.entries, 4);
  assert.equal(read.text, fs.readFileSync(file, 'utf8'));
  // What the model says was sent, without the page confirming it, is written as just that.
  engine.plan = () => [{ step: step(10, 5) }, { call: ['browser_read', {}] }, { call: ['report_application', { outcome: 'submitted' }] }, { say: 'Sent, I think.' }];
  await chat('go on', talked.id);
  assert.match(fs.readFileSync(file, 'utf8'), /Company f4 · Data Analyst f4 \(continued\)\n\n- Result: The assistant says it was sent, but Dayjob saw no confirmation page\n/);
});

test('the feedback file: its entries, what is taken out of them, and a long file put aside', () => {
  assert.equal(scrub('  call   me at 415-555-0134 or a.b+c@mail.example.org | now  '), 'call me at [number] or [email] / now');
  assert.equal(scrub('x'.repeat(40), 10), `${'x'.repeat(10)}…`);
  assert.equal(scrub('step e12 of 3, 60 minutes'), 'step e12 of 3, 60 minutes', 'short numbers stay');
  assert.deepEqual(sumSteps([{ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, cost: null }, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, cost: 0.5 }]),
    { steps: 2, inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, cost: 0.5 });
  assert.equal(sumSteps([{ inputTokens: 1 }]).cost, null);
  const entry = { at: new Date(2026, 10, 16, 9, 5), job: 'Acme | Analyst 2026-2027', site: 'jobs.acme.example', outcome: 'submitted', stoppedAt: 'record', reason: 'not shown', problems: [], failures: [],
    engine: 'anthropic-api', model: 'claude-opus-5-5', durationMs: 125000, steps: [{ n: 1, tools: ['browser_read'], inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1.25 }] };
  assert.equal(entryText(entry), '## 2026-11-16 09:05 · Acme / Analyst 2026-2027\n\n- 结果: 已投递\n- 原因: not shown\n- 网站: jobs.acme.example\n- 引擎和模型: Claude API · claude-opus-5-5\n- 用时: 2 分 5 秒，共 1 步\n'
    + '- Token: 输入 1,000（其中读缓存 0，写缓存 0），输出 100；约 $1.25\n\n没有记录到问题。\n');
  assert.match(entryText({ ...entry, outcome: 'nonsense', model: null, steps: [] }, true), /- Result: Not sent, and the assistant gave no reason\n- Stopped at: Recording\n[^]*- Engine and model: Claude API\n- Time: 2 min 5 s, 0 steps\n- Token: input 0 [^\n]*output 0\n\nNo problems/);

  // In memory when there is no folder; on disk a file that has grown long is put aside and a new one begun.
  const held = createFeedback({ now: () => new Date(2026, 10, 16, 9, 5) });
  held.add(entry);
  held.add({ ...entry, job: 'Second' });
  assert.deepEqual({ ...held.read(), text: '' }, { file: null, folder: null, entries: 2, cut: false, text: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-feedback-'));
  try {
    const kept = createFeedback({ dir: path.join(dir, 'feedback'), english: () => true, now: () => new Date(2026, 10, 16, 9, 5, 7) });
    kept.add(entry);
    kept.add(entry);
    const file = path.join(dir, 'feedback', 'apply-feedback.md');
    assert.match(fs.readFileSync(file, 'utf8'), /^# Dayjob: how the assistant's applications went\n\n[^\n]+\n\n## 2026-11-16 09:05 · Acme[^]*\n\n## 2026-11-16 09:05 · Acme/);
    fs.appendFileSync(file, 'x'.repeat(2 * 1024 * 1024));
    kept.add(entry);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'feedback')).sort(), ['apply-feedback-20261116-090507.md', 'apply-feedback.md']);
    assert.equal(kept.read().entries, 1);
    assert.match(kept.read().text, /^# Dayjob: how the assistant's applications went/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the assistant can start several applications itself, and is told how each one ended', async t => {
  const { app, chat, call, runs, until, engine, add } = await start();
  t.after(() => app.close());
  const [one, two] = ['m1', 'm2'].map(add);
  engine.plan = ({ said, text }) => (said.startsWith('apply to both') ? [{ step: step(10, 5) }, { call: ['start_applications', { ids: [one.id, two.id, one.id, 'missing'] }] }, { say: 'Started.' }]
    : postingOf(text) === one.id ? [{ step: step(10, 5) }, { call: ['start_applications', { ids: [two.id] }] }, { call: ['report_application', { outcome: 'failed', reason: 'The form would not load.' }] }, { say: 'Failed.' }]
      : postingOf(text) ? [{ step: step(10, 5) }, { wait: 'two' }, { say: 'Stopped.' }]
        : said === 'how are they?' ? [{ step: step(10, 5) }, { call: ['list_application_runs'] }, { say: 'Listed.' }] : [{ say: 'Fine.' }]);
  const parent = await chat('apply to both of these');
  const started = engine.results.find(item => item.tool === 'start_applications' && item.conversation === parent.id);
  assert.equal(started.ok, true);
  assert.deepEqual(started.value.applications.map(item => [item.id, item.job || null, Boolean(item.state), item.error || null]),
    [[one.id, 'Company m1 · Data Analyst m1', true, null], [two.id, 'Company m2 · Data Analyst m2', true, null], ['missing', null, false, 'Posting not found.']]);
  assert.deepEqual(parent.reply.tools[0].label, ['开始了 2 个申请', 'Started 2 applications']);
  assert.equal(parent.events.find(event => event.type === 'tool' && event.phase === 'done').ui.runs, true);
  assert.deepEqual((await runs()).map(run => run.parent), [parent.id, parent.id]);

  await until(async () => (await runs())[0].state === 'done' && engine.waiting('two'), 'the first ending');
  // An application's own conversation cannot start others.
  const inner = engine.results.find(item => item.tool === 'start_applications' && item.conversation !== parent.id);
  assert.equal(inner.ok, false);
  assert.match(inner.value.error, /one application already/);
  // The conversation that started them hears how the first one ended with its next message, and can ask about the rest.
  const next = await chat('how are they?', parent.id);
  assert.match(engine.seen.at(-1).text, /<dayjob_note>[^<]*The application you started for Company m1 · Data Analyst m1 has ended: it was not sent: it failed \(The form would not load\.\)\./);
  const listed = engine.results.at(-1).value.applications;
  assert.deepEqual(listed.map(item => [item.job, item.state, item.outcome]), [['Company m1 · Data Analyst m1', 'done', 'failed'], ['Company m2 · Data Analyst m2', 'working', null]]);
  assert.equal(next.reply.text, 'Listed.');
  engine.open('two');
  await until(async () => (await runs()).every(run => run.state === 'done'), 'the second ending');

  // The model is told when to use them.
  assert.match(SYSTEM_PROMPT, /several jobs at once, call start_applications/);
  assert.match(SYSTEM_PROMPT, /call report_application once/);
  assert.doesNotMatch(SYSTEM_PROMPT, /Apply to one job at a time/);
  // Without the Dayjob browser there is nothing to apply with, and no such tools.
  const bare = await start({ browser: null });
  t.after(() => bare.app.close());
  const names = (await bare.call('/api/assistant')).body.tools.map(tool => tool.name);
  assert.equal(names.some(name => ['start_applications', 'report_application', 'list_application_runs'].includes(name)), false);
  assert.equal((await bare.call('/api/assistant/applications', { method: 'POST', body: { postingId: bare.add('x').id } })).status, 409);
  const there = (await call('/api/assistant')).body.tools.map(tool => tool.name);
  assert.ok(['start_applications', 'report_application', 'list_application_runs'].every(name => there.includes(name)));
});
