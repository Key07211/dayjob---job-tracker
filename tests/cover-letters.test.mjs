import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { letterFileBase } from '../server/jobs/cover-letters.mjs';
import { openDatabase, SCHEMA_VERSION } from '../server/jobs/db.mjs';
import { SYSTEM_PROMPT } from '../server/assistant/prompt.mjs';

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const TEMPLATE = 'Dear Hiring Manager,\n\nI am writing to apply for the [Position] role at [Company]. In my studies and my work I have turned messy data into decisions people could act on.\n\n'
  + '[Two experiences that fit the role]\n\nI would welcome the chance to talk about how I can help [Company].\n\nSincerely,\nMei Lin';
const LETTER = 'Dear Acme team,\n\nI am writing to apply for the Data Analyst role at Acme. At the campus dining office I built the weekly demand forecast in Python and SQL, '
  + 'which the kitchen managers used to plan their orders.\n\nAs a research assistant I cleaned survey data from four terms and built the dashboard the department reads each month.\n\n'
  + 'I would welcome the chance to talk about how I can help Acme.\n\nSincerely,\nMei Lin';
const SECOND = LETTER.replace('I would welcome the chance', 'I would be glad of the chance');

// A stand-in engine: "call:<tool> <json>" runs that tool; no model is asked anything.
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

async function start(t, { pdf = true, browser = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-letters-'));
  const engines = { 'claude-cli': scripted('claude-cli'), 'anthropic-api': scripted('anthropic-api') };
  const app = await createApp({ dataDir, startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {},
    detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }), score: async () => { throw new Error('No scoring in these tests.'); } } },
    assistantEngines: engines, ...(browser ? { browser } : {}),
    // What the desktop app does with a real page; here the "PDF" only has to be told from the text.
    ...(pdf ? { letterPdf: async (text, title) => Buffer.from(`%PDF-test\n${title}\n${text}`, 'utf8') } : {}) });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
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
    return { events, done, id: events.at(-1).conversation.id };
  };
  const add = (key, company = 'Acme', title = 'Data Analyst') => app.repo.upsertPosting(posting({ site: 'linkedin', externalId: key, title, company,
    jobUrl: `https://www.linkedin.com/jobs/view/${key}`, description: 'Analyse product data with SQL and Python. Build dashboards and forecasting models.' }));
  const folder = path.join(dataDir, 'cover-letters');
  const files = () => (fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []);
  return { app, url, call, chat, add, engine: engines['claude-cli'], folder, files };
}

test('a file name out of a company and a job title is one Windows takes', () => {
  assert.equal(letterFileBase('Acme: Data/AI', 'Analyst (Summer 2027)?'), 'Acme Data AI - Analyst (Summer 2027)');
  assert.equal(letterFileBase('  ', '  '), 'Cover letter');
  assert.equal(letterFileBase('', 'CON'), 'CON letter');
  assert.equal(letterFileBase('Acme Inc.', 'Intern.'), 'Acme Inc - Intern');
  assert.ok(letterFileBase('A'.repeat(200), 'B'.repeat(200)).length <= 143);
});

test('samples are read from files or taken as text, several of them, shown without being sent whole, and removed one by one', async t => {
  const { call } = await start(t);
  const state = (await call('/api/cover-letters')).body;
  assert.deepEqual({ samples: state.samples, maxSamples: state.maxSamples }, { samples: [], maxSamples: 8 });
  const add = (name, text, mime = 'text/plain') => call('/api/cover-letters/samples', { method: 'POST', body: { name, mime, data: Buffer.from(text).toString('base64') } });
  assert.equal((await add('short.txt', 'Dear Sir,')).status, 422);
  assert.equal((await add('letter.png', 'x', 'image/png')).status, 415);
  const saved = await add('My letter.txt', TEMPLATE);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.name, 'My letter.txt');
  assert.equal(saved.body.characters, TEMPLATE.length);
  assert.ok(saved.body.preview.startsWith('Dear Hiring Manager') && saved.body.text === undefined);
  const typed = await call('/api/cover-letters/samples', { method: 'POST', body: { name: 'typed', text: `${TEMPLATE}\n\nP.S. typed in.` } });
  assert.ok(typed.body.preview.includes('Dear Hiring Manager') && typed.body.characters > TEMPLATE.length);
  // The same letter again is kept once, under the newer name.
  const again = await add('My letter (copy).txt', TEMPLATE);
  assert.equal(again.body.id, saved.body.id);
  assert.deepEqual((await call('/api/cover-letters')).body.samples.map(item => item.name), ['My letter (copy).txt', 'typed']);
  // Eight at most.
  for (let count = 3; count <= 8; count += 1) assert.equal((await add(`letter ${count}.txt`, `${TEMPLATE}\n\nVersion ${count}.`)).status, 200);
  const ninth = await add('letter 9.txt', `${TEMPLATE}\n\nVersion 9.`);
  assert.equal(ninth.status, 409);
  assert.match(ninth.body.error, /up to 8 cover letter samples/);
  assert.deepEqual((await call(`/api/cover-letters/samples/${saved.body.id}`, { method: 'DELETE' })).body, { ok: true });
  assert.equal((await call(`/api/cover-letters/samples/${saved.body.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await call('/api/cover-letters')).body.samples.length, 7);
  assert.equal((await add('letter 9.txt', `${TEMPLATE}\n\nVersion 9.`)).status, 200);
});

test('the template an earlier Dayjob kept becomes the first sample', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-letters-old-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = openDatabase(dataDir);
  first.db.exec('DROP TABLE cover_letter_samples');
  first.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('meta:coverLetterTemplate', JSON.stringify({ name: 'old.docx', text: TEMPLATE, updatedAt: '2026-11-20T05:00:00.000Z' }));
  first.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  first.db.close();
  const again = openDatabase(dataDir);
  assert.deepEqual(again.db.prepare('SELECT name, text, created_at FROM cover_letter_samples').all().map(row => ({ ...row })),
    [{ name: 'old.docx', text: TEMPLATE, created_at: '2026-11-20T05:00:00.000Z' }]);
  assert.equal(again.db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'meta:coverLetterTemplate'").get().n, 0);
  // A template that was taken away again (kept as null) leaves no sample.
  again.db.exec('DELETE FROM cover_letter_samples; DROP TABLE cover_letter_samples');
  again.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('meta:coverLetterTemplate', 'null');
  again.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  again.db.close();
  const third = openDatabase(dataDir);
  assert.equal(third.db.prepare('SELECT count(*) AS n FROM cover_letter_samples').get().n, 0);
  third.db.close();
});

test('the assistant reads the samples and saves the letter for a posting as a file in the cover letter folder', async t => {
  const { app, url, call, chat, add, engine, folder, files } = await start(t);
  const job = add('101');
  await call('/api/cover-letters/samples', { method: 'POST', body: { text: TEMPLATE, name: 'mine.docx' } });
  // A long sample is given to the assistant cut to its first 6000 characters, and says so.
  const long = `${LETTER}\n\n${'More about a project. '.repeat(400)}`;
  await call('/api/cover-letters/samples', { method: 'POST', body: { text: long, name: 'long.txt' } });
  assert.ok((await call('/api/assistant')).body.tools.some(tool => tool.name === 'save_cover_letter' && tool.tier === 'undoable'));

  await chat(`call:get_cover_letter_samples ${JSON.stringify({ postingId: job.id })}`);
  assert.deepEqual(engine.results.at(-1).value, { samples: [{ name: 'mine.docx', text: TEMPLATE }, { name: 'long.txt', text: long.trim().slice(0, 6000), cut: true }], general: null, saved: null });

  const first = await chat(`call:save_cover_letter ${JSON.stringify({ postingId: job.id, text: LETTER })}`);
  assert.equal(engine.results.at(-1).ok, true);
  assert.deepEqual(engine.results.at(-1).value.letter.file, 'Acme - Data Analyst.pdf');
  assert.equal(engine.results.at(-1).value.letter.replaced, false);
  assert.ok(!JSON.stringify(engine.results.at(-1).value).includes(folder), 'the model is not told where the folder is on the computer');
  assert.deepEqual(files(), ['Acme - Data Analyst.pdf']);
  assert.ok(fs.readFileSync(path.join(folder, 'Acme - Data Analyst.pdf'), 'utf8').startsWith('%PDF-test\nCover Letter - Acme - Data Analyst\nDear Acme team'));
  assert.equal(first.done.tool.undoable, true);

  // The window: the list on the Resume & AI page, the job's details, the letter in full, and its file.
  const listed = (await call('/api/cover-letters')).body;
  assert.equal(listed.folder, folder);
  assert.equal(listed.letters.length, 1);
  assert.deepEqual({ company: listed.letters[0].company, title: listed.letters[0].title, hasFile: listed.letters[0].hasFile, text: listed.letters[0].text },
    { company: 'Acme', title: 'Data Analyst', hasFile: true, text: undefined });
  assert.equal((await call(`/api/postings/${job.id}`)).body.coverLetter.id, listed.letters[0].id);
  assert.equal((await call(`/api/cover-letters/${listed.letters[0].id}`)).body.text, LETTER);
  const download = await fetch(`${url}/api/cover-letters/${listed.letters[0].id}/file`);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''Acme%20-%20Data%20Analyst\.pdf$/);
  assert.equal(app.letters.filePath(listed.letters[0].id), path.join(folder, 'Acme - Data Analyst.pdf'));

  // Written again: the same file, the new words; the saved letter is what the assistant reads back.
  const second = await chat(`call:save_cover_letter ${JSON.stringify({ postingId: job.id, text: SECOND })}`);
  assert.equal(engine.results.at(-1).value.letter.replaced, true);
  assert.deepEqual(files(), ['Acme - Data Analyst.pdf']);
  assert.ok(fs.readFileSync(path.join(folder, 'Acme - Data Analyst.pdf'), 'utf8').includes('I would be glad of the chance'));
  await chat(`call:get_cover_letter_samples ${JSON.stringify({ postingId: job.id })}`);
  assert.equal(engine.results.at(-1).value.saved.text, SECOND);

  // Undo puts the earlier letter back, words and file; undoing the first one takes the letter away.
  const undo = (conversation, actionId) => call(`/api/assistant/conversations/${conversation}/undo`, { method: 'POST', body: { actionId } });
  assert.equal((await undo(second.id, second.done.tool.id)).status, 200);
  assert.equal((await call(`/api/cover-letters/${listed.letters[0].id}`)).body.text, LETTER);
  assert.ok(fs.readFileSync(path.join(folder, 'Acme - Data Analyst.pdf'), 'utf8').includes('I would welcome the chance'));
  assert.equal((await undo(first.id, first.done.tool.id)).status, 200);
  assert.deepEqual(files(), []);
  assert.deepEqual((await call('/api/cover-letters')).body.letters, []);
  assert.equal((await call(`/api/postings/${job.id}`)).body.coverLetter, null);

  await chat(`call:save_cover_letter ${JSON.stringify({ postingId: job.id, text: 'Too short.' })}`);
  assert.equal(engine.results.at(-1).ok, false);
  await chat(`call:save_cover_letter ${JSON.stringify({ postingId: 'nope', text: LETTER })}`);
  assert.equal(engine.results.at(-1).ok, false);
});

test('two jobs with one name get a file each, and deleting a letter takes its own file and nothing else', async t => {
  const { call, chat, add, engine, folder, files } = await start(t);
  const one = add('201');
  const two = add('202');
  await chat(`call:save_cover_letter ${JSON.stringify({ postingId: one.id, text: LETTER })}`);
  await chat(`call:save_cover_letter ${JSON.stringify({ postingId: two.id, text: SECOND })}`);
  assert.deepEqual(files(), ['Acme - Data Analyst (2).pdf', 'Acme - Data Analyst.pdf']);
  assert.equal(engine.results.at(-1).value.letter.file, 'Acme - Data Analyst (2).pdf');
  // Something of the user's own in the folder is left alone, also by a letter that would have had its name.
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'mine');
  fs.writeFileSync(path.join(folder, 'Beta - Analyst.pdf'), 'mine too');
  const three = add('203', 'Beta', 'Analyst');
  await chat(`call:save_cover_letter ${JSON.stringify({ postingId: three.id, text: LETTER })}`);
  assert.equal(engine.results.at(-1).value.letter.file, 'Beta - Analyst (2).pdf');
  assert.equal(fs.readFileSync(path.join(folder, 'Beta - Analyst.pdf'), 'utf8'), 'mine too');
  const letters = (await call('/api/cover-letters')).body.letters;
  const first = letters.find(item => item.postingId === one.id);
  assert.deepEqual((await call(`/api/cover-letters/${first.id}`, { method: 'DELETE' })).body, { ok: true });
  assert.deepEqual(files(), ['Acme - Data Analyst (2).pdf', 'Beta - Analyst (2).pdf', 'Beta - Analyst.pdf', 'notes.txt']);
  assert.equal((await call(`/api/cover-letters/${first.id}`, { method: 'DELETE' })).status, 404);
  // A file the user removed by hand: the letter's words stay, and the list says the file is gone.
  fs.unlinkSync(path.join(folder, 'Acme - Data Analyst (2).pdf'));
  const left = (await call('/api/cover-letters')).body.letters.find(item => item.postingId === two.id);
  assert.equal(left.hasFile, false);
  assert.equal((await call(`/api/cover-letters/${left.id}/file`)).status, 404);
});

test('where Dayjob cannot lay out a PDF the letter is kept as a text file', async t => {
  const { chat, add, engine, folder, files } = await start(t, { pdf: false });
  const job = add('301');
  await chat(`call:save_cover_letter ${JSON.stringify({ postingId: job.id, text: LETTER })}`);
  assert.equal(engine.results.at(-1).value.letter.file, 'Acme - Data Analyst.txt');
  assert.deepEqual(files(), ['Acme - Data Analyst.txt']);
  assert.ok(fs.readFileSync(path.join(folder, 'Acme - Data Analyst.txt'), 'utf8').includes('Dear Acme team'));
});

test('in an application the saved letter goes into the form, and a letter written there is kept in the folder too', async t => {
  const calls = [];
  const browser = { async run(action, input) {
    calls.push({ action, input });
    return { ...(action === 'letter' ? { letter: { as: 'file', file: 'Cover Letter - Mei Lin.pdf', field: 'Cover letter' } } : {}), page: { url: 'https://jobs.example.com/apply/1', title: 'Apply' } };
  }, endRun() {} };
  const { chat, add, engine, files } = await start(t, { browser });
  const job = add('401');
  const other = add('402', 'Beta', 'Analyst');

  // No letter saved and none passed: there is nothing to put in.
  const opened = await chat(`call:open_application ${JSON.stringify({ id: job.id })}`);
  await chat('call:browser_cover_letter {}', opened.id);
  assert.equal(engine.results.at(-1).ok, false);
  assert.ok(!calls.some(item => item.action === 'letter'));

  await chat(`call:save_cover_letter ${JSON.stringify({ postingId: job.id, text: LETTER })}`, opened.id);
  await chat('call:browser_cover_letter {}', opened.id);
  assert.equal(engine.results.at(-1).ok, true);
  assert.deepEqual(calls.at(-1), { action: 'letter', input: { text: LETTER } });

  // A letter passed as text while applying to another job is put in and kept under that job's name.
  const second = await chat(`call:open_application ${JSON.stringify({ id: other.id })}`);
  await chat(`call:browser_cover_letter ${JSON.stringify({ text: SECOND })}`, second.id);
  assert.deepEqual(calls.at(-1), { action: 'letter', input: { text: SECOND } });
  assert.deepEqual(engine.results.at(-1).value.saved, { file: 'Beta - Analyst.pdf' });
  assert.deepEqual(files(), ['Acme - Data Analyst.pdf', 'Beta - Analyst.pdf']);
});

test('the assistant is told how a cover letter is written', () => {
  for (const name of ['get_cover_letter_samples', 'save_cover_letter', 'browser_cover_letter']) assert.ok(SYSTEM_PROMPT.includes(name), name);
  assert.match(SYSTEM_PROMPT, /Never invent an experience/);
  assert.match(SYSTEM_PROMPT, /passages from different samples/);
  assert.match(SYSTEM_PROMPT, /never carried over/);
});
