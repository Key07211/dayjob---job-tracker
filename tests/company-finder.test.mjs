import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { boardLinks, findCompanyBoards, publicPage, slugCandidates } from '../server/jobs/company-finder.mjs';
import { fakeHttp, fixture } from './helpers.mjs';

const GREENHOUSE = JSON.parse(fixture('greenhouse.json'));
const LEVER = JSON.parse(fixture('lever.json'));
const CAREERS_PAGE = `<html><body><h1>Work at Acme</h1>
  <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeai"></script>
  <a href="https:\\/\\/job-boards.greenhouse.io\\/acmeai\\/jobs\\/4012345">ML Engineer</a>
  <a href="https://www.greenhouse.io/privacy">Powered by Greenhouse</a></body></html>`;

test('a company\'s name gives the ids its board usually has', () => {
  assert.deepEqual(slugCandidates('Scale AI, Inc.'), ['scaleai', 'scale-ai', 'scale']);
  assert.deepEqual(slugCandidates('Stripe'), ['stripe']);
  assert.deepEqual(slugCandidates('Zoë & Co. Labs'), ['zoeandcolabs', 'zoe-and-co-labs', 'zoecolabs', 'zoe']);
  assert.deepEqual(slugCandidates('O\'Reilly Media LLC'), ['oreillymedia', 'oreilly-media', 'oreilly']);
  assert.deepEqual(slugCandidates('  '), []);
  assert.deepEqual(slugCandidates('招聘'), [], 'a name with no latin letters has no guess');
});

test('only pages on the open web are read, and a page gives up the boards it names', () => {
  assert.equal(publicPage('acme.com/careers').href, 'https://acme.com/careers');
  for (const link of ['http://localhost:4318/api/bootstrap', 'http://127.0.0.1/x', 'https://[::1]/x', 'file:///etc/passwd', 'https://intranet/jobs', 'https://printer.local/', 'https://user:pw@acme.com/', 'not a link']) {
    assert.equal(publicPage(link), null, link);
  }
  assert.deepEqual(boardLinks(CAREERS_PAGE), [{ ats: 'greenhouse', slug: 'acmeai' }], 'the embed and the escaped job link are one board; the vendor\'s own site is none');
  assert.deepEqual(boardLinks('<a href="https://jobs.lever.co/acme/1b2c">x</a> <a href="//jobs.ashbyhq.com/Acme%20Labs">y</a> fetch("https://api.ashbyhq.com/posting-api/job-board/acme-labs")'),
    [{ ats: 'lever', slug: 'acme' }, { ats: 'ashby', slug: 'acme-labs' }]);
  assert.deepEqual(boardLinks('<p>No jobs here.</p>'), []);
});

test('a board is found by the company\'s name, with what is open and what the searches would keep', async () => {
  const { http, calls } = fakeHttp([
    ['boards-api.greenhouse.io/v1/boards/acmeai/jobs', { body: GREENHOUSE }],
    ['api.lever.co/v0/postings/acme-ai?', { body: LEVER }],
    ['api.ashbyhq.com', { status: 404, body: 'Not Found' }],
  ]);
  const searches = [{ keywords: 'machine learning engineer, data scientist', location: '', isRemote: false, titleInclude: [], excludeKeywords: [] }];
  const companies = [{ id: 'c1', ats: 'lever', slug: 'acme-ai', enabled: false }];
  const found = await findCompanyBoards({ company: 'Acme AI', keywords: 'engineer' }, { http, searches, companies });
  assert.deepEqual(found.boards.map(board => [board.ats, board.slug, board.name, board.open, board.matchingSearches, board.matchingKeywords, board.followed]), [
    ['greenhouse', 'acmeai', 'Acme AI', 2, 1, 1, false],
    ['lever', 'acme-ai', 'Acme AI', 1, 1, 0, true],
  ]);
  assert.deepEqual(found.boards[0].jobs, [{ title: 'Machine Learning Engineer, New Grad', location: 'San Francisco, CA', url: found.boards[0].jobs[0].url, posted: found.boards[0].jobs[0].posted }]);
  assert.match(found.boards[0].jobs[0].url, /^https:\/\//);
  assert.equal(found.boards[0].link, 'https://job-boards.greenhouse.io/acmeai');
  assert.deepEqual([found.boards[1].companyId, found.boards[1].enabled], ['c1', false]);
  assert.equal(found.note, undefined);
  // Lever had no "acmeai", so the next id was tried; Ashby has neither and answers with something that is not JSON.
  assert.ok(found.looked.includes('lever/acmeai: no such board') && found.looked.includes('lever/acme-ai: 1 open'), found.looked.join(' | '));
  assert.ok(found.looked.includes('ashby/acme: no such board'));
  assert.ok(calls.every(call => /greenhouse\.io|lever\.co|ashbyhq\.com/.test(call.url)));

  const none = await findCompanyBoards({ company: 'Nobody Corp' }, { http });
  assert.deepEqual(none.boards, []);
  assert.match(none.note, /No Greenhouse, Lever or Ashby board was found for Nobody Corp/);
});

test('a board is found from a link: the board itself, one of its jobs, or the company\'s own careers page', async () => {
  const { http, calls } = fakeHttp([
    ['boards-api.greenhouse.io/v1/boards/acmeai/jobs', { body: GREENHOUSE }],
    ['https://acme.example/careers', { body: CAREERS_PAGE }],
    ['https://plain.example/', { body: '<p>We are hiring. Email us.</p>' }],
  ]);
  const direct = await findCompanyBoards({ url: 'https://job-boards.greenhouse.io/acmeai/jobs/4012345' }, { http });
  assert.deepEqual(direct.boards.map(board => `${board.ats}/${board.slug} ${board.open}`), ['greenhouse/acmeai 2']);
  assert.equal(calls.length, 1, 'a board link needs no guessing');
  assert.equal(direct.boards[0].jobs.length, 2, 'with no searches and no keywords, the open jobs themselves');

  const viaPage = await findCompanyBoards({ url: 'acme.example/careers' }, { http });
  assert.deepEqual(viaPage.boards.map(board => `${board.ats}/${board.slug}`), ['greenhouse/acmeai']);
  assert.match(viaPage.looked[0], /^acme\.example: greenhouse\/acmeai$/);

  // A page that names no board: the site's own name is tried, and when that leads nowhere the answer says what to do instead.
  const plain = await findCompanyBoards({ url: 'https://plain.example/' }, { http });
  assert.deepEqual(plain.boards, []);
  assert.ok(plain.looked.includes('plain.example: no board link in the page') && plain.looked.includes('greenhouse/plain: no such board'));
  assert.match(plain.note, /saved search with the company's name/);

  const local = await findCompanyBoards({ url: 'http://127.0.0.1:4318/api/bootstrap' }, { http });
  assert.deepEqual(local.boards, []);
  assert.match(local.note, /not a web page Dayjob can read/);
  assert.ok(!calls.some(call => call.url.includes('127.0.0.1')), 'nothing on this computer is fetched');
});

// The app with a stand-in assistant engine: "call:<tool> <json>" runs that tool.
async function start(http) {
  const engine = id => ({ id, status: async () => ({ available: true, detail: 'test' }), live: () => false, close() {}, closeAll() {}, conversationFor: () => null,
    async send({ text, callTool, onRound, onText }) {
      const wanted = /^call:(\w+)\s*(\{.*\})?$/s.exec(text.split(/<\/earlier_conversation>|<\/dayjob_note>/).at(-1).trim());
      onRound();
      const outcome = await callTool(wanted[1], JSON.parse(wanted[2] || '{}'));
      onText(outcome.ok ? 'Done.' : 'Failed.');
      return { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'test-model', rounds: 1 };
    } });
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {}, http,
    detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }), score: async () => { throw new Error('No scoring in these tests.'); } } },
    assistantEngines: { 'claude-cli': engine('claude-cli'), 'anthropic-api': engine('anthropic-api') } });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const headers = { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken };
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: method === 'GET' ? {} : headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const chat = async (text, conversationId) => {
    const response = await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers, body: JSON.stringify({ text, conversationId }) });
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const conversation = events.at(-1).conversation;
    return { id: conversation.id, tool: conversation.turns.at(-1).tools[0] };
  };
  return { app, call, chat };
}

test('the assistant finds a company\'s board, follows it and fetches it, and each step can be taken back', async t => {
  const { http, calls } = fakeHttp([
    ['boards-api.greenhouse.io/v1/boards/acmeai/jobs', { body: GREENHOUSE }],
    ['api.lever.co/v0/postings/ghost', { status: 404, body: { ok: false, error: 'Document not found' } }],
  ]);
  const { app, call, chat } = await start(http);
  t.after(() => app.close());
  const tools = (await call('/api/assistant')).body.tools.map(tool => `${tool.name}:${tool.tier}`);
  assert.ok(tools.includes('find_company_board:read') && tools.includes('follow_company:undoable'), tools.join(' '));
  app.repo.saveSearch({ name: 'ML', keywords: 'machine learning engineer', sites: ['linkedin'] });

  const found = await chat('call:find_company_board {"company":"Acme AI"}');
  assert.equal(found.tool.ok, true, JSON.stringify(found.tool));
  assert.deepEqual([found.tool.view, found.tool.label], ['searches', ['找到招聘页：Acme AI', 'Found the job board: Acme AI']]);
  assert.equal(found.tool.undoable, false, 'looking changes nothing');
  assert.deepEqual(app.repo.listCompanies(), []);
  assert.equal((await chat('call:find_company_board {}', found.id)).tool.ok, false, 'a name or a link is needed');

  const followed = await chat('call:follow_company {"ats":"greenhouse","slug":"acmeai","name":"Acme AI"}', found.id);
  assert.equal(followed.tool.ok, true, JSON.stringify(followed.tool));
  assert.deepEqual(followed.tool.label, ['关注了 Acme AI 的招聘页', 'Following Acme AI\'s job board']);
  const [company] = app.repo.listCompanies();
  assert.deepEqual([company.name, company.ats, company.slug, company.enabled], ['Acme AI', 'greenhouse', 'acmeai', true]);
  const again = await chat('call:follow_company {"ats":"greenhouse","slug":"AcmeAI"}', found.id);
  assert.deepEqual([again.tool.ok, again.tool.label[1], again.tool.undoable], [true, 'Already following Acme AI', false]);
  assert.equal(app.repo.listCompanies().length, 1);
  const ghost = await chat('call:follow_company {"ats":"lever","slug":"ghost"}', found.id);
  assert.deepEqual([ghost.tool.ok, ghost.tool.error], [false, 'No lever job board named "ghost" was found.']);

  // Only this company's board is read: the search's own boards (LinkedIn) are left alone.
  const before = calls.length;
  const run = await chat(`call:run_search {"companyIds":["${company.id}"]}`, found.id);
  assert.equal(run.tool.ok, true, JSON.stringify(run.tool));
  for (let tries = 0; app.scheduler.running && tries < 200; tries += 1) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(calls.slice(before).map(entry => new URL(entry.url).host), ['boards-api.greenhouse.io']);
  assert.deepEqual(app.repo.listPostings().items.map(item => item.title), ['Machine Learning Engineer, New Grad'], 'the job that matches the search is in the list');
  assert.deepEqual(app.repo.listRuns(1)[0].detail.map(entry => entry.source), ['Acme AI · greenhouse']);

  // A company the user had paused is switched back on, and undo pauses it again; undoing the first follow removes it.
  app.repo.setCompanyEnabled(company.id, false);
  const resumed = await chat('call:follow_company {"ats":"greenhouse","slug":"acmeai"}', found.id);
  assert.equal(app.repo.listCompanies()[0].enabled, true);
  assert.equal((await call(`/api/assistant/conversations/${found.id}/undo`, { method: 'POST', body: { actionId: resumed.tool.id } })).status, 200);
  assert.equal(app.repo.listCompanies()[0].enabled, false);
  assert.equal((await call(`/api/assistant/conversations/${found.id}/undo`, { method: 'POST', body: { actionId: followed.tool.id } })).status, 200);
  assert.deepEqual(app.repo.listCompanies(), []);
});

test('the window and Claude can look a board up too, and a follow says how many jobs match', async t => {
  const { http } = fakeHttp([['boards-api.greenhouse.io/v1/boards/acmeai/jobs', { body: GREENHOUSE }]]);
  const { app, call } = await start(http);
  t.after(() => app.close());
  app.repo.saveSearch({ name: 'Sales', keywords: 'account executive', sites: ['linkedin'] });
  const found = await call('/api/companies/find', { method: 'POST', body: { url: 'https://job-boards.greenhouse.io/acmeai', keywords: 'engineer' } });
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.boards.map(board => [board.slug, board.open, board.matchingSearches, board.matchingKeywords]), [['acmeai', 2, 1, 1]]);
  assert.equal((await call('/api/companies/find', { method: 'POST', body: {} })).status, 400);
  const followed = await call('/api/companies', { method: 'POST', body: { ats: 'greenhouse', slug: 'acmeai', name: 'Acme AI' } });
  assert.deepEqual([followed.status, followed.body.listed, followed.body.matching, followed.body.already], [201, 2, 1, false]);
  assert.equal((await call('/api/companies', { method: 'POST', body: { ats: 'greenhouse', slug: 'acmeai' } })).body.already, true);
});
