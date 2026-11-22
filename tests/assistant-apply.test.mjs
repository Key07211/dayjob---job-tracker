import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { SYSTEM_PROMPT } from '../server/assistant/prompt.mjs';
import { APPLY_STEPS as SERVER_STEPS, TIERS } from '../server/assistant/tools.mjs';
import { APPLY_STEPS, applyRun, stepStates } from '../src/dayjob/assistant/apply.js';

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const PAGE = { url: 'https://jobs.example.com/apply/42', title: 'Apply · Data Analyst', favicon: 'data:image/png;base64,AAAA' };
const LETTER = 'Dear Example team,\n\nI am applying for the Data Analyst role. I build dashboards and forecasts.\n\nThank you,\nMei Lin';

// A stand-in engine: "call:<tool> <json>" runs that tool. What it was sent, and what each tool gave back to the
// model, are kept.
function scripted(id) {
  const seen = [];
  const results = [];
  return {
    id, seen, results,
    status: async () => ({ available: true, detail: 'test' }),
    live: () => false, close() {}, closeAll() {}, conversationFor: () => null,
    async send({ text, tools, callTool, onRound, onText }) {
      seen.push({ text, tools: tools.map(tool => tool.name) });
      const said = text.split(/<\/earlier_conversation>|<\/dayjob_note>/).at(-1).trim();
      onRound();
      const wanted = /^call:(\w+)\s*(\{.*\})?$/s.exec(said);
      if (!wanted) { onText(`Echo: ${said}`); return { usage: USAGE, model: 'test-model', rounds: 1 }; }
      const outcome = await callTool(wanted[1], JSON.parse(wanted[2] || '{}'));
      results.push({ ok: outcome.ok, content: outcome.content, value: JSON.parse(outcome.content) });
      onText(outcome.ok ? 'Done.' : 'Failed.');
      return { usage: USAGE, model: 'test-model', rounds: 2 };
    },
  };
}

// A stand-in for the Dayjob browser (desktop/browser.cjs): it keeps what it was asked and answers from `answers`.
function fakeBrowser(answers = {}) {
  const calls = [];
  return { calls, answers, async run(action, input, context) {
    calls.push({ action, input, context });
    const answer = answers[action];
    const value = typeof answer === 'function' ? await answer(input, context) : answer;
    return { ...(value || {}), page: { ...PAGE } };
  } };
}

async function start({ browser, onSettings } = {}) {
  const engines = { 'claude-cli': scripted('claude-cli'), 'anthropic-api': scripted('anthropic-api') };
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {},
    detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }), score: async () => { throw new Error('No scoring in these tests.'); } } },
    assistantEngines: engines, ...(browser ? { browser } : {}), ...(onSettings ? { onSettings } : {}) });
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
    return { events, id: events.at(-1).conversation.id, reply: events.at(-1).conversation.turns.at(-1), tool: done?.tool || null, done };
  };
  const add = key => app.repo.upsertPosting(posting({ site: 'linkedin', externalId: key, title: `Data Analyst ${key}`, company: `Company ${key}`, jobUrl: `https://www.linkedin.com/jobs/view/${key}`,
    description: 'Analyse product data with SQL and Python. Build dashboards and forecasting models.' }));
  return { app, call, chat, engines, add };
}

test('the browser tools exist only where there is a Dayjob browser, and none of them names a secret', async t => {
  const browser = fakeBrowser();
  const desktop = await start({ browser });
  const plain = await start();
  t.after(() => Promise.all([desktop.app.close(), plain.app.close()]));
  assert.deepEqual(TIERS, ['read', 'undoable', 'browser']);
  assert.deepEqual(SERVER_STEPS, APPLY_STEPS, 'the server and the pane count the same steps');

  const there = (await desktop.call('/api/assistant')).body;
  assert.equal(there.browser, true);
  assert.equal(there.settings.apply, 'confirm', 'sending waits for the user unless they say otherwise');
  const tiers = Object.fromEntries(there.tools.map(tool => [tool.name, tool.tier]));
  for (const name of ['open_application', 'browser_open', 'browser_read', 'browser_click', 'browser_hover', 'browser_type', 'browser_select', 'browser_options', 'browser_press_key', 'browser_scroll', 'browser_navigate',
    'browser_tabs', 'browser_autofill', 'browser_upload_resume', 'browser_upload_transcript', 'browser_sign_in', 'browser_sign_up', 'browser_cover_letter']) assert.equal(tiers[name], 'browser', name);
  assert.equal(tiers.get_profile, 'read');
  assert.equal(tiers.update_profile, 'undoable');
  assert.ok(there.tools.every(tool => !/vault|password|secret|delete|key\b|upload_file|evaluate|(?<!tran)script/i.test(tool.name) || tool.name === 'browser_press_key'), there.tools.map(tool => tool.name).join(' '));
  // No tool takes a password, a file's contents or a script as input.
  for (const definition of desktop.app.assistant.tools.definitions()) {
    assert.equal(definition.input_schema.additionalProperties, false, definition.name);
    assert.ok(Object.keys(definition.input_schema.properties || {}).every(key => !/password|secret|username|(?<!tran)script/i.test(key) && !['file', 'data', 'content', 'code'].includes(key)), definition.name);
  }

  const without = (await plain.call('/api/assistant')).body;
  assert.equal(without.browser, false);
  assert.equal(without.tools.some(tool => tool.tier === 'browser'), false);
  assert.ok(without.tools.some(tool => tool.name === 'update_profile'));
  const refused = await plain.chat('call:browser_read {}');
  assert.equal(plain.engines['claude-cli'].results[0].ok, false);
  assert.match(plain.engines['claude-cli'].results[0].value.error, /no tool named browser_read/);
  assert.equal(refused.reply.tools[0].ok, false);
  assert.doesNotMatch(plain.engines['claude-cli'].seen[0].text, /Apply mode/, 'no apply mode where there is nothing to apply with');
});

test('a sending click carries the apply mode: it waits for the user until full takeover is switched on', async t => {
  const browser = fakeBrowser({ click: (input, context) => ({ clicked: { ref: input.ref, role: 'button', name: 'Submit application' }, allowed: context.takeover ? 'auto' : 'user' }) });
  const { app, call, chat, engines } = await start({ browser });
  t.after(() => app.close());

  const first = await chat('call:browser_click {"ref":"e5"}');
  const asked = browser.calls[0];
  assert.equal(asked.action, 'click');
  assert.deepEqual(asked.input, { ref: 'e5' });
  assert.equal(asked.context.by, 'assistant');
  assert.equal(asked.context.takeover, false);
  assert.ok(asked.context.signal instanceof AbortSignal, 'stopping the reply reaches the card that is waiting');
  assert.match(engines['claude-cli'].seen[0].text, /<dayjob_note>[^<]*Apply mode: manual confirm/);
  assert.equal(first.tool.tier, 'browser');
  assert.equal(first.tool.view, 'browser');
  assert.equal(first.tool.step, 'confirm');
  assert.deepEqual(first.tool.facts, { submitted: 'Submit application', allowed: 'user' });
  assert.deepEqual(first.tool.label, ['点了“Submit application”（你确认过）', 'Clicked “Submit application” (you allowed it)']);
  assert.equal(first.tool.undoable, false, 'what was sent to a website cannot be taken back');
  assert.equal(engines['claude-cli'].results[0].content.includes('favicon'), false);

  assert.equal((await call('/api/assistant/settings', { method: 'PATCH', body: { apply: 'always' } })).status, 400);
  assert.equal((await call('/api/assistant/settings', { method: 'PATCH', body: { apply: 'takeover' } })).body.apply, 'takeover');
  assert.equal((await call('/api/assistant')).body.settings.apply, 'takeover');
  const second = await chat('call:browser_click {"ref":"e5"}', first.id);
  assert.equal(browser.calls[1].context.takeover, true);
  assert.match(engines['claude-cli'].seen[1].text, /Apply mode: full takeover/);
  assert.deepEqual(second.tool.facts, { submitted: 'Submit application', allowed: 'auto' });
  assert.match(second.tool.label[1], /full takeover/);

  // A click that sends nothing is no step of an application.
  browser.answers.click = input => ({ clicked: { ref: input.ref, role: 'link', name: 'Benefits' } });
  const plain = await chat('call:browser_click {"ref":"e2"}', first.id);
  assert.equal(plain.tool.step, undefined);
  assert.deepEqual(plain.tool.label, ['点了“Benefits”', 'Clicked “Benefits”']);
  assert.equal((await call('/api/assistant/settings', { method: 'PATCH', body: { apply: 'confirm' } })).body.apply, 'confirm');
});

test('what the browser refuses comes back to the model in words, and its own failures give nothing away', async t => {
  const refusal = Object.assign(new Error('The user did not allow this within 10 minutes. Use dayjob_browser_read to look again.'), { status: 408 });
  const browser = fakeBrowser({ click: () => { throw refusal; }, read: () => { throw new Error('socket hang up'); } });
  const { app, chat, engines } = await start({ browser });
  t.after(() => app.close());
  const declined = await chat('call:browser_click {"ref":"e5"}');
  assert.equal(declined.reply.tools[0].ok, false);
  assert.equal(engines['claude-cli'].results[0].value.error, 'The user did not allow this within 10 minutes. Use browser_read to look again.');
  await chat('call:browser_read {}', declined.id);
  assert.equal(engines['claude-cli'].results[1].value.error, 'The Dayjob browser failed: socket hang up');
  await chat('call:browser_click {"ref":"button#submit"}', declined.id);
  assert.match(engines['claude-cli'].results[2].value.error, /Invalid input/);
  assert.equal(browser.calls.length, 2, 'a ref that is not one of the page\'s never reaches the browser');
});

test('the assistant works dropdowns and choices a page draws itself with the mouse', async t => {
  const rows = [{ ref: 'e31', role: 'option', name: '+93 Afghanistan' }, { ref: 'e32', role: 'option', name: '+355 Albania' }];
  const browser = fakeBrowser({
    click: input => (input.text ? { clicked: { ref: 'e19', role: 'span', name: input.text } }
      : input.ref === 'e5' ? { clicked: { ref: 'e5', role: 'radio', name: 'By phone', checked: true } }
        : { clicked: { ref: input.ref, role: 'combobox', name: 'Code', expanded: true }, appeared: rows, appearedCount: 239, notice: 'What appeared is named by the website.' }),
    hover: input => ({ hovered: { ref: 'e18', role: 'span', name: input.text }, appeared: [{ ref: 'e40', role: 'link', name: 'Get help with this form' }] }),
    select: input => ({ selected: { ref: input.ref, name: 'Code', value: '+1 United States', shows: '+1' } }),
  });
  const { app, chat, engines } = await start({ browser });
  t.after(() => app.close());
  // A dropdown is one step: the option as the user reads it.
  const chosen = await chat('call:browser_select {"ref":"e1","option":"United States"}');
  assert.deepEqual(browser.calls[0].input, { ref: 'e1', option: 'United States' });
  assert.deepEqual(chosen.tool.label, ['选了“Code”：+1 United States', 'Chose +1 United States for “Code”']);
  assert.equal(chosen.tool.step, 'questions');
  assert.equal(engines['claude-cli'].results[0].value.selected.shows, '+1');
  // A click says what it brought on show, so the rows of a list that opened can be clicked next.
  const opened = await chat('call:browser_click {"ref":"e1"}', chosen.id);
  assert.deepEqual(engines['claude-cli'].results[1].value.appeared, rows);
  assert.equal(engines['claude-cli'].results[1].value.appearedCount, 239);
  assert.deepEqual(opened.tool.label, ['点开了“Code”', 'Opened “Code”']);
  // A tile that is a radio button says it is chosen; something with no ref is clicked by the words on it.
  assert.deepEqual((await chat('call:browser_click {"ref":"e5"}', chosen.id)).tool.label, ['选了“By phone”', 'Chose “By phone”']);
  const worded = await chat('call:browser_click {"text":"Add another reference"}', chosen.id);
  assert.deepEqual(browser.calls[3].input, { text: 'Add another reference' });
  assert.deepEqual(worded.tool.label, ['点了“Add another reference”', 'Clicked “Add another reference”']);
  // The mouse over a menu, without a click.
  const over = await chat('call:browser_hover {"text":"More actions"}', chosen.id);
  assert.deepEqual(browser.calls[4], { action: 'hover', input: { text: 'More actions' }, context: browser.calls[4].context });
  assert.equal(over.tool.tier, 'browser');
  assert.deepEqual(over.tool.label, ['把鼠标移到了“More actions”上', 'Moved the mouse over “More actions”']);
  assert.equal(engines['claude-cli'].results[4].value.appeared[0].name, 'Get help with this form');
  // One way of aiming at a time, and no points: the assistant does not see the page as a picture.
  await chat('call:browser_click {"ref":"e1","text":"Code"}', chosen.id);
  assert.match(engines['claude-cli'].results[5].value.error, /one way/);
  await chat('call:browser_click {"x":10,"y":10}', chosen.id);
  assert.match(engines['claude-cli'].results[6].value.error, /Invalid input/);
  assert.equal(browser.calls.length, 5);
});

test('the assistant learns a form\'s dropdowns before it answers them, and text typed into one is taken as the option meant', async t => {
  const lists = [{ ref: 'e7', name: 'How did you hear about us?', options: ['Company website', 'Job board or social media', 'Career fair'] }, { ref: 'e9', name: 'School', note: 'It lists nothing until something is typed.' }];
  const browser = fakeBrowser({
    options: input => ({ dropdowns: input.refs ? lists.filter(item => input.refs.includes(item.ref)) : lists }),
    type: input => (input.ref === 'e7' ? { selected: { ref: 'e7', name: 'How did you hear about us?', value: 'Job board or social media' }, note: 'e7 is a dropdown, so Dayjob chose the option that reads like what you typed.' }
      : { typed: { ref: input.ref, name: 'School', value: input.text }, suggestions: ['University of California, Berkeley', 'Berkeley College'] }),
  });
  const { app, chat, engines } = await start({ browser });
  t.after(() => app.close());
  // Every dropdown of the page in one call, or the ones named.
  const all = await chat('call:browser_options {}');
  assert.deepEqual(browser.calls[0], { action: 'options', input: {}, context: browser.calls[0].context });
  assert.equal(all.tool.tier, 'browser');
  assert.deepEqual(all.tool.label, ['看了 2 个下拉框的选项', 'Read the options of 2 dropdowns']);
  assert.deepEqual(engines['claude-cli'].results[0].value.dropdowns[0].options, lists[0].options);
  const one = await chat('call:browser_options {"refs":["e7"]}', all.id);
  assert.deepEqual(browser.calls[1].input, { refs: ['e7'] });
  assert.deepEqual(one.tool.label, ['看了 1 个下拉框的选项', 'Read the options of 1 dropdown']);
  await chat('call:browser_options {"refs":["seven"]}', all.id);
  assert.match(engines['claude-cli'].results[2].value.error, /Invalid input/);
  // Typed into a dropdown: Dayjob chose the option, and the line in the chat says chose, not filled in.
  const typed = await chat('call:browser_type {"ref":"e7","text":"job board"}', all.id);
  assert.deepEqual(typed.tool.label, ['选了“How did you hear about us?”：Job board or social media', 'Chose Job board or social media for “How did you hear about us?”']);
  assert.equal(typed.tool.step, 'questions');
  // A box that suggests as you type says what it suggests.
  const suggested = await chat('call:browser_type {"ref":"e9","text":"Berkeley"}', all.id);
  assert.deepEqual(suggested.tool.label, ['填了“School”', 'Filled in “School”']);
  assert.deepEqual(engines['claude-cli'].results[4].value.suggestions, ['University of California, Berkeley', 'Berkeley College']);
  // The tools and the prompt say how a field's kind is told and that dropdowns are chosen from.
  const tools = app.assistant.tools;
  assert.match(tools.get('browser_read').description, /opens-list.*suggests-list.*never typed in/s);
  assert.match(tools.get('browser_type').description, /Not for dropdowns/);
  assert.match(tools.get('browser_select').description, /do not guess at the wording/);
});

test('signing in tells the model how it went and nothing else', async t => {
  // Even a browser layer that said too much would not get a user name or a password through.
  const browser = fakeBrowser({ signin: { status: 'signed-in', site: 'jobs.example.com', username: 'mei.lin@example.com', password: 'N0rthwind-pass!', entry: { id: 'v1' } } });
  const { app, chat, engines } = await start({ browser });
  t.after(() => app.close());
  const done = await chat('call:browser_sign_in {}');
  const told = engines['claude-cli'].results[0];
  assert.deepEqual(Object.keys(told.value).sort(), ['page', 'site', 'status', 'what']);
  assert.equal(told.value.status, 'signed-in');
  assert.equal(told.value.site, 'jobs.example.com');
  for (const secret of ['mei.lin@example.com', 'N0rthwind-pass!', 'v1']) {
    assert.equal(told.content.includes(secret), false);
    assert.equal(JSON.stringify(done.events).includes(secret), false);
  }
  assert.deepEqual(browser.calls[0].input, {}, 'the model gives it nothing to type');
  assert.equal(done.tool.step, 'login');
  assert.deepEqual(done.tool.label, ['已登录 jobs.example.com（密码由密码保管在本机填入）', 'Signed in to jobs.example.com (the vault filled the password on this computer)']);

  browser.answers.signin = { status: 'failed', site: 'jobs.example.com' };
  const failed = await chat('call:browser_sign_in {}', done.id);
  assert.equal(engines['claude-cli'].results[1].value.status, 'failed');
  assert.match(engines['claude-cli'].results[1].value.what, /not tried again/);
  assert.equal(failed.tool.step, undefined, 'a sign-in that did not work is not a step done');
  browser.answers.signin = { status: 'something-new', site: 'jobs.example.com' };
  await chat('call:browser_sign_in {}', done.id);
  assert.equal(engines['claude-cli'].results[2].value.status, 'unavailable');
  await chat('call:browser_sign_in {"username":"someone","password":"x"}', done.id);
  assert.match(engines['claude-cli'].results[3].value.error, /Invalid input/);
  assert.equal(browser.calls.length, 3);
  assert.match(SYSTEM_PROMPT, /browser_sign_in has Dayjob fill a saved one in/);
});

test('a new account gets its password from Dayjob: the model asks for one and never sees it', async t => {
  // Even a browser layer that said too much would not get the password through.
  const browser = fakeBrowser({ signup: { status: 'set', site: 'jobs.example.com', username: 'mei.lin@example.com', boxes: 2, length: 20, symbols: true, allowed: 'user',
    password: 'Made-Up-0n-This-PC!', entry: { id: 'v9' } } });
  const { app, chat, engines } = await start({ browser });
  t.after(() => app.close());
  const done = await chat('call:browser_sign_up {}');
  const told = engines['claude-cli'].results[0];
  assert.deepEqual(Object.keys(told.value).sort(), ['length', 'page', 'passwordBoxes', 'site', 'status', 'username', 'what']);
  assert.equal(told.value.status, 'set');
  assert.equal(told.value.passwordBoxes, 2);
  assert.match(told.value.what, /vault/);
  for (const secret of ['Made-Up-0n-This-PC!', 'v9']) {
    assert.equal(told.content.includes(secret), false);
    assert.equal(JSON.stringify(done.events).includes(secret), false);
    assert.equal(JSON.stringify(done.tool).includes(secret), false);
  }
  assert.deepEqual(browser.calls[0].input, {}, 'the model gives it nothing to type');
  assert.equal(browser.calls[0].context.by, 'assistant');
  assert.equal(done.tool.step, 'login');
  assert.match(done.tool.label[1], /jobs\.example\.com/);

  // A site with its own rules: how long, and which symbols. Nothing else is taken.
  await chat('call:browser_sign_up {"length":12,"symbols":"-_"}', done.id);
  assert.deepEqual(browser.calls[1].input, { length: 12, symbols: '-_' });
  for (const refused of ['{"password":"Mine-1234"}', '{"length":4}', '{"length":200}', '{"symbols":"abc"}', '{"username":"someone@example.com"}']) {
    await chat(`call:browser_sign_up ${refused}`, done.id);
    assert.match(engines['claude-cli'].results.at(-1).value.error, /Invalid input/, refused);
  }
  assert.equal(browser.calls.length, 2);

  // What did not happen is said as it is, and is not a step done.
  for (const status of ['no-form', 'login', 'no-username', 'has-account', 'unavailable']) {
    browser.answers.signup = { status, site: 'jobs.example.com', username: 'mei.lin@example.com' };
    const other = await chat('call:browser_sign_up {}', done.id);
    const said = engines['claude-cli'].results.at(-1).value;
    assert.equal(said.status, status);
    assert.deepEqual(Object.keys(said).sort(), ['page', 'site', 'status', 'what']);
    assert.equal(other.tool.step, undefined, status);
  }
  browser.answers.signup = { status: 'something-new', site: 'jobs.example.com' };
  await chat('call:browser_sign_up {}', done.id);
  assert.equal(engines['claude-cli'].results.at(-1).value.status, 'unavailable');
  assert.match(SYSTEM_PROMPT, /browser_sign_up has Dayjob make one up for an account you create, type it in and keep it/);
  assert.match(SYSTEM_PROMPT, /do not create another/);
});

test('signing in, a new account\'s password, the cover letter and full takeover belong to the assistant in the window, not to the browser API', async t => {
  const browser = fakeBrowser({ click: input => ({ clicked: { ref: input.ref, role: 'button', name: 'Submit application' }, allowed: 'user' }) });
  const { app, call } = await start({ browser });
  t.after(() => app.close());
  assert.equal((await call('/api/assistant/settings', { method: 'PATCH', body: { apply: 'takeover' } })).status, 200);
  // What Claude reaches over MCP (the browser API) has no sign-in and no letter,
  assert.equal((await call('/api/browser/signin', { method: 'POST', body: {} })).status, 404);
  assert.equal((await call('/api/browser/signup', { method: 'POST', body: {} })).status, 404);
  assert.equal((await call('/api/browser/letter', { method: 'POST', body: { text: LETTER } })).status, 404);
  assert.equal(browser.calls.length, 0);
  // and its clicks ask the user whatever the assistant's switch says.
  assert.equal((await call('/api/browser/click', { method: 'POST', body: { ref: 'e5' } })).status, 200);
  assert.equal(browser.calls[0].action, 'click');
  assert.equal(browser.calls[0].context, undefined);
});

test('an application is opened once per posting, with the resume that fits it, and recorded when it is sent', async t => {
  const browser = fakeBrowser({
    autofill: input => ({ filled: [{ key: 'firstName', label: 'First name' }, { key: 'email', label: 'Email' }], missing: [],
      resume: input.resumeId ? { attached: true, resume: { id: input.resumeId, name: 'data.pdf' }, field: 'Resume/CV' } : { attached: false, reason: 'no-file' } }),
    upload: input => ({ uploaded: { resume: 'data.pdf', field: 'Resume/CV', resumeId: input.resumeId } }),
  });
  const { app, chat, engines, add } = await start({ browser });
  t.after(() => app.close());
  const job = add('a');
  const resume = app.repo.addResume({ name: 'data.pdf', mime: 'application/pdf', size: 8, text: `Mei Lin\n${'SQL, Python, dashboards, forecasting, product analytics. '.repeat(12)}`, file: Buffer.from('%PDF-1.4') });
  assert.equal(app.repo.getPosting(job.id).resumeId, resume.id);

  const opened = await chat(`call:open_application {"id":"${job.id}"}`);
  assert.equal(browser.calls[0].action, 'open');
  assert.equal(browser.calls[0].input.url, 'https://www.linkedin.com/jobs/view/a');
  assert.equal(opened.tool.step, 'open');
  assert.deepEqual(opened.tool.facts, { job: 'Company a · Data Analyst a', postingId: job.id });
  const told = engines['claude-cli'].results[0].value;
  assert.deepEqual(told.resume, { id: resume.id, name: 'data.pdf', hasFile: true });
  assert.equal(told.posting.id, job.id);
  assert.equal(JSON.stringify(told).includes('%PDF'), false, 'the model learns which resume, never its file');

  // Filling in and attaching use the resume of the posting that was opened, without the model naming it.
  const filled = await chat('call:browser_autofill {}', opened.id);
  assert.equal(browser.calls[1].action, 'autofill');
  assert.equal(browser.calls[1].input.resumeId, resume.id);
  assert.equal(filled.tool.step, 'resume');
  assert.deepEqual(filled.tool.facts, { filled: 2, resume: 'data.pdf' });
  const attached = await chat('call:browser_upload_resume {}', opened.id);
  assert.equal(browser.calls[2].input.resumeId, resume.id);
  assert.deepEqual(attached.tool.facts, { resume: 'data.pdf' });
  // In another conversation nothing was opened, so the browser picks by the page.
  await chat('call:browser_upload_resume {}');
  assert.equal(browser.calls[3].input.resumeId, null);

  const recorded = await chat(`call:mark_applied {"id":"${job.id}"}`, opened.id);
  assert.equal(recorded.tool.step, 'record');
  assert.equal(app.repo.applicationForPosting(job.id).status, 'applied');
  const again = await chat(`call:open_application {"id":"${job.id}"}`, opened.id);
  assert.equal(again.reply.tools[0].ok, false);
  assert.match(engines['claude-cli'].results.at(-1).value.error, /already tracked as applied/);
  assert.equal(browser.calls.length, 4, 'nothing was opened');
  await chat(`call:open_application {"id":"${job.id}","again":true}`, opened.id);
  assert.equal(browser.calls.length, 5);
  await chat('call:open_application {"id":"nope"}', opened.id);
  assert.match(engines['claude-cli'].results.at(-1).value.error, /not found/i);
});

test('a cover letter goes to the form through Dayjob, and the user can read it in the chat', async t => {
  const browser = fakeBrowser({ letter: { notice: 'Attached.', letter: { as: 'file', file: 'Cover Letter - Mei Lin.pdf', field: 'Cover Letter' } } });
  const { app, chat, engines } = await start({ browser });
  t.after(() => app.close());
  const done = await chat(`call:browser_cover_letter ${JSON.stringify({ text: `\n${LETTER}\n\n` })}`);
  assert.deepEqual(browser.calls[0].input, { text: LETTER });
  assert.equal(done.tool.step, 'questions');
  assert.deepEqual(done.tool.facts, { letter: 'file' });
  assert.equal(done.tool.detail, LETTER);
  assert.deepEqual(done.tool.label, ['附上了求职信（Cover Letter - Mei Lin.pdf）', 'Attached the cover letter (Cover Letter - Mei Lin.pdf)']);
  assert.equal(done.reply.tools[0].detail, LETTER, 'it stays with the conversation');

  browser.answers.letter = { letter: { as: 'text', field: 'Cover letter', replaced: false } };
  const typed = await chat(`call:browser_cover_letter ${JSON.stringify({ text: LETTER })}`, done.id);
  assert.deepEqual(typed.tool.label, ['把求职信填进了表单', 'Put the cover letter into the form']);
  await chat('call:browser_cover_letter {"text":"Hi."}', done.id);
  assert.match(engines['claude-cli'].results[2].value.error, /Invalid input/);
  await chat(`call:browser_cover_letter ${JSON.stringify({ text: 'x'.repeat(6001) })}`, done.id);
  assert.match(engines['claude-cli'].results[3].value.error, /Invalid input/);
  assert.equal(browser.calls.length, 2);
});

test('an answer the user gave is kept in the application profile, and taking it back restores what was there', async t => {
  const told = [];
  const { app, call, chat, engines } = await start({ onSettings: settings => told.push(settings.applicant.salary) });
  t.after(() => app.close());
  app.repo.updateSettings({ applicant: { ...app.repo.getSettings().applicant, firstName: 'Mei', salary: '90000' } });

  await chat('call:get_profile {}');
  assert.equal(engines['claude-cli'].results[0].value.profile.firstName, 'Mei');
  const saved = await chat('call:update_profile {"salary":"120000","needsSponsorship":"no"}');
  assert.deepEqual(engines['claude-cli'].results[1].value, { saved: { salary: '120000', needsSponsorship: 'no' } });
  assert.equal(app.repo.getSettings().applicant.salary, '120000');
  assert.equal(app.repo.getSettings().applicant.firstName, 'Mei', 'fields left out stay as they are');
  assert.equal(saved.tool.undoable, true);
  assert.deepEqual([...saved.tool.label].map(text => text.replace(/^[^：:]+[：:]\s*/, '').split(/、|, /).sort().join('+')), ['needsSponsorship+salary', 'needsSponsorship+salary']);
  assert.match(saved.tool.label[1], /^Saved to the application profile: /);
  assert.deepEqual(told, ['120000'], 'the desktop app hears of it, so the browser fills with the new answer');

  assert.equal((await call(`/api/assistant/conversations/${saved.id}/undo`, { method: 'POST', body: { actionId: saved.tool.id } })).status, 200);
  assert.equal(app.repo.getSettings().applicant.salary, '90000');
  assert.equal(app.repo.getSettings().applicant.needsSponsorship, '');
  assert.deepEqual(told, ['120000', '90000']);

  // Changed by hand since: the undo would overwrite it, so it is refused.
  const later = await chat('call:update_profile {"salary":"130000"}');
  app.repo.updateSettings({ applicant: { ...app.repo.getSettings().applicant, salary: '140000' } });
  assert.equal((await call(`/api/assistant/conversations/${later.id}/undo`, { method: 'POST', body: { actionId: later.tool.id } })).status, 409);
  assert.equal(app.repo.getSettings().applicant.salary, '140000');

  await chat('call:update_profile {}');
  assert.match(engines['claude-cli'].results.at(-1).value.error, /at least one field/);
  await chat('call:update_profile {"coverLetter":"Dear team"}');
  assert.match(engines['claude-cli'].results.at(-1).value.error, /Invalid input/);
  await chat('call:update_profile {"password":"x"}');
  assert.match(engines['claude-cli'].results.at(-1).value.error, /Invalid input/);
});

test('the steps of an application are read off the tools the assistant used', () => {
  const tool = (name, step, facts, extra = {}) => ({ name, ok: true, step, facts, ...extra });
  assert.equal(applyRun([]), null);
  assert.equal(applyRun([{ role: 'user', text: 'hi' }, { role: 'assistant', tools: [{ name: 'list_postings', ok: true }] }]), null);
  // An application the user sent themselves is recorded, not worked on.
  assert.equal(applyRun([{ role: 'assistant', tools: [tool('mark_applied', 'record')] }]), null);

  const turns = [
    { role: 'user', text: 'apply' },
    { role: 'assistant', tools: [
      tool('browser_type', 'questions', { answered: 1 }),
      tool('open_application', 'open', { job: 'Northwind Labs · Data Analyst', postingId: 'p1' }),
      tool('browser_type', 'questions', { answered: 1 }),
      tool('browser_sign_in', 'login'),
      tool('browser_autofill', 'resume', { filled: 4, resume: 'data.pdf' }),
      tool('browser_type', 'questions', { answered: 1 }),
      { name: 'browser_click', ok: false, step: 'confirm' },
      tool('browser_cover_letter', 'questions', { letter: 'file' }),
    ] },
  ];
  const run = applyRun(turns);
  assert.equal(APPLY_STEPS[run.reached], 'questions');
  assert.equal(run.turn, 1);
  assert.deepEqual({ job: run.job, postingId: run.postingId, resume: run.resume, filled: run.filled, answered: run.answered, letter: run.letter, submitted: run.submitted },
    { job: 'Northwind Labs · Data Analyst', postingId: 'p1', resume: 'data.pdf', filled: 4, answered: 1, letter: 'file', submitted: '' },
    'typing before a form was filled in is not an answer, and a refused click is not a step');
  const states = extra => stepStates(run, extra).map(item => item.state);
  assert.deepEqual(states(), ['done', 'done', 'done', 'done', 'done', 'todo', 'todo']);
  assert.deepEqual(states({ busy: true }), ['done', 'done', 'done', 'done', 'done', 'now', 'todo']);
  assert.deepEqual(states({ asking: true, busy: true }), ['done', 'done', 'done', 'done', 'done', 'now', 'todo']);

  turns.push({ role: 'user', text: 'go on' }, { role: 'assistant', tools: [tool('browser_click', 'confirm', { submitted: 'Submit application', allowed: 'user' }), tool('mark_applied', 'record')] });
  const sent = applyRun(turns);
  assert.equal(APPLY_STEPS[sent.reached], 'record');
  assert.equal(sent.turn, 3);
  assert.deepEqual([sent.submitted, sent.allowed], ['Submit application', 'user']);
  assert.deepEqual(stepStates(sent, { busy: true }).map(item => item.state), Array(7).fill('done'));

  // The next posting starts a new run; an undone step does not count.
  turns.push({ role: 'assistant', tools: [tool('open_application', 'open', { job: 'Northwind Labs · Product Analyst', postingId: 'p2' }), tool('browser_autofill', 'fill', { filled: 3 }, { undone: true })] });
  const next = applyRun(turns);
  assert.deepEqual([next.job, APPLY_STEPS[next.reached], next.filled, next.resume, next.turn], ['Northwind Labs · Product Analyst', 'open', 0, '', 4]);
  // A page opened by its address after one application was recorded is a new run too; before that it is the same one.
  assert.equal(applyRun([{ role: 'assistant', tools: [tool('open_application', 'open', { job: 'A', postingId: 'p1' }), tool('browser_open', 'open', { site: 'jobs.example.com' })] }]).job, 'A');
  assert.equal(applyRun([{ role: 'assistant', tools: [tool('open_application', 'open', { job: 'A', postingId: 'p1' }), tool('mark_applied', 'record'), tool('browser_open', 'open', { site: 'jobs.example.com' })] }]).job, '');
});

test('the assistant lists the transcripts and has Dayjob attach one, without ever getting a file', async t => {
  const browser = fakeBrowser({
    transcript: input => ({ uploaded: { transcripts: [{ name: 'Example Transcript.pdf', note: 'Example University' }], field: 'College Transcript', chosenBy: input.transcriptIds ? 'chosen' : 'only' } }),
  });
  const { app, chat, engines } = await start({ browser });
  t.after(() => app.close());
  const kept = app.transcripts.add({ name: 'Example Transcript.pdf', note: 'Example University', data: Buffer.from('%PDF-1.4\n% grades: all of them\n%%EOF\n') });

  const listed = await chat('call:list_transcripts {}');
  assert.deepEqual(engines['claude-cli'].results[0].value, { transcripts: [{ id: kept.id, name: 'Example Transcript.pdf', note: 'Example University', isDefault: false }] });
  const attached = await chat('call:browser_upload_transcript {}', listed.id);
  assert.equal(browser.calls[0].action, 'transcript');
  assert.deepEqual(browser.calls[0].input, { transcriptIds: null });
  assert.equal(attached.tool.step, 'resume');
  assert.deepEqual(attached.tool.facts, { transcript: 'Example Transcript.pdf' });
  await chat(`call:browser_upload_transcript {"transcriptIds":["${kept.id}"]}`, listed.id);
  assert.deepEqual(browser.calls[1].input, { transcriptIds: [kept.id] });
  assert.equal(JSON.stringify(engines['claude-cli'].results).includes('grades'), false, 'what a transcript says never reaches the model');
  assert.equal(app.assistant.tools.get('list_transcripts').tier, 'read');
});
