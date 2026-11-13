import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from '../server/app.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { assistantArgs, createCliEngine, resultUsage } from '../server/assistant/engine-cli.mjs';
import { createApiEngine } from '../server/assistant/engine-api.mjs';
import { AssistantError, SYSTEM_PROMPT, transcript, withNotes } from '../server/assistant/prompt.mjs';
import { createConversationStore } from '../server/assistant/store.mjs';
import { TIERS } from '../server/assistant/tools.mjs';
import { memoryRepo } from './helpers.mjs';

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting.');
    await new Promise(done => setTimeout(done, 10));
  }
};

// A stand-in engine. "call:<tool> <json>" runs that tool, "slow" waits until it is stopped, "boom" and "crash" fail,
// and anything else is echoed. What it was sent is kept in `seen`.
function scripted(id) {
  const live = new Set();
  const seen = [];
  return {
    id, seen,
    status: async () => ({ available: true, detail: 'test' }),
    live: key => live.has(key),
    close: key => { live.delete(key); },
    closeAll: () => live.clear(),
    conversationFor: () => null,
    async send({ id: key, text, model, tools, callTool, onRound, onThinking, onText, signal }) {
      seen.push({ key, text, model, tools: tools.map(tool => tool.name) });
      live.add(key);
      const said = text.split(/<\/earlier_conversation>|<\/dayjob_note>/).at(-1).trim();
      onRound();
      onThinking();
      if (said === 'boom') throw new AssistantError('rate-limit', 'Slow down.');
      if (said === 'crash') throw new Error('secret detail');
      if (said === 'slow') {
        onText('Starting');
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason || new Error('Stopped.')), { once: true }));
      }
      const wanted = /^call:(\w+)\s*(\{.*\})?$/s.exec(said);
      if (!wanted) {
        onText(`Echo: ${said}`);
        return { usage: USAGE, model: model || 'test-model', rounds: 1 };
      }
      onText('Looking.');
      const outcome = await callTool(wanted[1], JSON.parse(wanted[2] || '{}'));
      onRound();
      onText(outcome.ok ? 'Done.' : 'Failed.');
      return { usage: USAGE, model: model || 'test-model', rounds: 2 };
    },
  };
}

async function start() {
  const engines = { 'claude-cli': scripted('claude-cli'), 'anthropic-api': scripted('anthropic-api') };
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {},
    detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }), score: async () => { throw new Error('No scoring in these tests.'); } } },
    assistantEngines: engines });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const writeHeaders = { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken };
  const call = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: { ...(method === 'GET' ? {} : writeHeaders), ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // One message and its reply: every event of the stream, and the conversation it ends with.
  const chat = async (text, conversationId) => {
    const response = await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text, conversationId }) });
    if (response.status !== 200) return { status: response.status, body: await response.json() };
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    return { status: 200, events, conversation: events.at(-1).conversation, id: events.at(-1).conversation.id, reply: events.at(-1).conversation.turns.at(-1) };
  };
  const add = key => app.repo.upsertPosting(posting({ site: 'linkedin', externalId: key, title: `Job ${key}`, company: `Company ${key}`, jobUrl: `https://www.linkedin.com/jobs/view/${key}` }));
  return { app, url, call, chat, engines, add, writeHeaders };
}

test('the assistant reports its engines, its models and tools that stay away from secrets', async t => {
  const { app, call } = await start();
  t.after(() => app.close());
  const { status, body } = await call('/api/assistant');
  assert.equal(status, 200);
  assert.deepEqual(body.settings, { engine: 'claude-cli', models: { 'claude-cli': '', 'anthropic-api': '' }, apply: 'confirm' });
  assert.equal(body.browser, false, 'no Dayjob browser outside the desktop app');
  assert.equal(body.engines['claude-cli'].available, true);
  assert.equal(body.engines['anthropic-api'].available, true);
  assert.deepEqual(body.defaultModels, { 'claude-cli': '', 'anthropic-api': 'claude-opus-5-5' });
  assert.ok(body.models.some(model => model.id === 'claude-opus-5-5'));
  assert.deepEqual(body.kept, []);
  const tiers = Object.fromEntries(body.tools.map(tool => [tool.name, tool.tier]));
  assert.equal(tiers.list_postings, 'read');
  assert.equal(tiers.show_in_app, 'read');
  assert.equal(tiers.set_posting_status, 'undoable');
  assert.equal(tiers.mark_applied, 'undoable');
  assert.ok(body.tools.every(tool => TIERS.includes(tool.tier)));
  // Nothing reaches the vault, the browser, settings or a delete.
  assert.ok(body.tools.every(tool => !/vault|password|secret|browser|delete|setting|key/i.test(tool.name)), body.tools.map(tool => tool.name).join(' '));
  // Every tool describes its input as a closed JSON Schema object, which both engines pass on.
  for (const definition of app.assistant.tools.definitions()) {
    assert.equal(definition.input_schema.type, 'object', definition.name);
    assert.equal(definition.input_schema.additionalProperties, false, definition.name);
    assert.ok(definition.description.length > 20, definition.name);
  }
});

test('a message streams a reply with its tool call, and the pane never gets tool data', async t => {
  const { app, chat, engines, add } = await start();
  t.after(() => app.close());
  add('a');
  add('b');
  const first = await chat('call:list_postings {}');
  assert.equal(first.status, 200);
  const types = first.events.map(event => (event.type === 'tool' ? `tool:${event.phase}` : event.type));
  assert.equal(types[0], 'start');
  assert.equal(types.at(-1), 'end');
  assert.ok(types.includes('thinking'));
  assert.ok(types.indexOf('tool:start') < types.indexOf('tool:done'));
  assert.equal(first.events[0].engine, 'claude-cli');
  assert.equal(first.events[0].conversation.kept, false);
  assert.equal(first.events.filter(event => event.type === 'text').map(event => event.delta).join(''), 'Looking.\n\nDone.');
  const done = first.events.find(event => event.type === 'tool' && event.phase === 'done');
  assert.deepEqual(done.tool.label, ['查了岗位（2 个）', 'Looked up jobs (2)']);
  assert.equal(done.tool.tier, 'read');
  assert.equal(done.tool.view, 'feed');
  assert.equal(done.tool.undoable, false);
  assert.equal(done.changed, false);
  assert.equal('input' in done.tool, false);
  assert.equal('summary' in done.tool, false);

  assert.equal(first.conversation.title, 'call:list_postings {}');
  assert.deepEqual(first.conversation.turns.map(turn => turn.role), ['user', 'assistant']);
  assert.equal(first.reply.text, 'Looking.\n\nDone.');
  assert.equal(first.reply.tools[0].offset, 'Looking.'.length, 'the chip sits where the call happened');
  assert.equal(first.reply.model, 'test-model');
  assert.deepEqual(first.reply.usage, USAGE);
  assert.equal(JSON.stringify(first.conversation).includes('Company a'), false, 'results stay on the server');

  // The engine is given the prompt's tools; the second message goes to the same engine session as it is.
  assert.ok(engines['claude-cli'].seen[0].tools.includes('set_posting_status'));
  const second = await chat('hello', first.id);
  assert.equal(second.id, first.id);
  assert.equal(engines['claude-cli'].seen[1].text, 'hello');
  assert.equal(second.conversation.turns.length, 4);

  const shown = await chat('call:show_in_app {"view":"applications"}', first.id);
  assert.deepEqual(shown.events.find(event => event.type === 'tool' && event.phase === 'done').ui, { open: 'applications', id: null });

  // Each reply is counted in the usage log, on its own line and not with the search suggestions.
  const used = app.repo.usageSummary().today;
  assert.deepEqual(used.assistant, { calls: 3, measured: 3, inputTokens: 30, cachedTokens: 0, outputTokens: 15, costUsd: 0, planUsd: 0, unpriced: 0 });
  assert.deepEqual([used.score.calls, used.other.calls], [0, 0]);
});

test('a change can be undone once, the model is told, and a later change blocks the undo', async t => {
  const { app, call, chat, engines, add } = await start();
  t.after(() => app.close());
  add('a');
  const saved = await chat('call:set_posting_status {"id":"li-a","status":"saved"}');
  const done = saved.events.find(event => event.type === 'tool' && event.phase === 'done');
  assert.equal(done.changed, true);
  assert.equal(done.tool.undoable, true);
  assert.deepEqual(done.tool.label, ['收藏了：Company a · Job a', 'Saved: Company a · Job a']);
  assert.equal(app.repo.getPosting('li-a').status, 'saved');

  const undone = await call(`/api/assistant/conversations/${saved.id}/undo`, { method: 'POST', body: { actionId: done.tool.id } });
  assert.equal(undone.status, 200);
  assert.equal(undone.body.turns.at(-1).tools[0].undone, true);
  assert.equal(undone.body.turns.at(-1).tools[0].undoable, false);
  assert.equal(app.repo.getPosting('li-a').status, 'new');
  assert.equal((await call(`/api/assistant/conversations/${saved.id}/undo`, { method: 'POST', body: { actionId: done.tool.id } })).status, 409);
  assert.equal((await call(`/api/assistant/conversations/${saved.id}/undo`, { method: 'POST', body: {} })).status, 400);

  await chat('thanks', saved.id);
  assert.match(engines['claude-cli'].seen.at(-1).text, /^<dayjob_note>\nThe user has undone this change: Saved: Company a · Job a\.\n<\/dayjob_note>\n\nthanks$/);
  await chat('again', saved.id);
  assert.equal(engines['claude-cli'].seen.at(-1).text, 'again', 'a note is passed on once');

  // Saved by the assistant, then dismissed by hand: the undo would overwrite the user's own later choice.
  const again = await chat('call:set_posting_status {"id":"li-a","status":"saved"}', saved.id);
  app.repo.setPostingStatus('li-a', 'dismissed');
  const refused = await call(`/api/assistant/conversations/${saved.id}/undo`, { method: 'POST', body: { actionId: again.reply.tools[0].id } });
  assert.equal(refused.status, 409);
  assert.equal(app.repo.getPosting('li-a').status, 'dismissed');
});

test('recording an application starts tracking, and its undo takes it away again', async t => {
  const { app, call, chat, add } = await start();
  t.after(() => app.close());
  add('a');
  const applied = await chat('call:mark_applied {"id":"li-a","note":"via referral"}');
  const done = applied.events.find(event => event.type === 'tool' && event.phase === 'done');
  assert.equal(done.applied, true);
  assert.equal(done.tool.view, 'applications');
  const application = app.repo.applicationForPosting('li-a');
  assert.equal(application.status, 'applied');
  assert.equal(app.repo.getPosting('li-a').status, 'applied');

  const changed = await chat(`call:update_application {"id":"${application.id}","status":"interview","note":"phone screen booked"}`, applied.id);
  assert.equal(changed.reply.tools[0].ok, true);
  assert.equal(app.repo.getApplication(application.id).status, 'interview');
  const events = app.repo.getApplication(application.id).events.length;
  assert.equal((await call(`/api/assistant/conversations/${applied.id}/undo`, { method: 'POST', body: { actionId: changed.reply.tools[0].id } })).status, 200);
  assert.equal(app.repo.getApplication(application.id).status, 'applied');
  assert.ok(app.repo.getApplication(application.id).events.length < events, 'the timeline entries it added are gone too');

  assert.equal((await call(`/api/assistant/conversations/${applied.id}/undo`, { method: 'POST', body: { actionId: done.tool.id } })).status, 200);
  assert.equal(app.repo.applicationForPosting('li-a'), null);
  assert.equal(app.repo.getPosting('li-a').status, 'new');
});

test('a saved search can be created and changed, and each step taken back', async t => {
  const { app, call, chat } = await start();
  t.after(() => app.close());
  const made = await chat('call:save_search {"keywords":"data scientist","location":"Oakland, CA"}');
  assert.equal(made.reply.tools[0].ok, true, JSON.stringify(made.reply.tools[0]));
  assert.equal(made.reply.tools[0].view, 'searches');
  const [search] = app.repo.listSearches();
  assert.equal(search.keywords, 'data scientist');
  const edited = await chat(`call:save_search {"id":"${search.id}","keywords":"ml engineer"}`, made.id);
  assert.equal(app.repo.listSearches()[0].keywords, 'ml engineer');
  assert.equal(app.repo.listSearches()[0].location, 'Oakland, CA', 'fields left out stay');
  assert.equal((await call(`/api/assistant/conversations/${made.id}/undo`, { method: 'POST', body: { actionId: edited.reply.tools[0].id } })).status, 200);
  assert.equal(app.repo.listSearches()[0].keywords, 'data scientist');
  assert.equal((await call(`/api/assistant/conversations/${made.id}/undo`, { method: 'POST', body: { actionId: made.reply.tools[0].id } })).status, 200);
  assert.deepEqual(app.repo.listSearches(), []);
  // Edited by hand afterwards: the assistant's undo would throw that edit away, so it is refused.
  const other = await chat('call:save_search {"keywords":"analyst"}', made.id);
  const mine = app.repo.listSearches()[0];
  app.repo.saveSearch({ ...mine, keywords: 'senior analyst' }, mine.id);
  assert.equal((await call(`/api/assistant/conversations/${made.id}/undo`, { method: 'POST', body: { actionId: other.reply.tools[0].id } })).status, 409);
  assert.equal(app.repo.listSearches()[0].keywords, 'senior analyst');
  app.repo.deleteSearch(mine.id);
  // With nothing to search, a run is refused instead of started.
  const run = await chat('call:run_search {}', made.id);
  assert.equal(run.reply.tools[0].ok, false);
  assert.match(run.reply.tools[0].error, /Add a search/);
});

test('a tool that fails says why, and unknown tools or extra input are refused', async t => {
  const { app, chat, add } = await start();
  t.after(() => app.close());
  add('a');
  const missing = await chat('call:get_posting {"id":"nope"}');
  assert.equal(missing.reply.tools[0].ok, false);
  assert.equal(missing.reply.tools[0].error, 'Posting not found.');
  assert.equal(missing.reply.text, 'Looking.\n\nFailed.');
  const unknown = await chat('call:delete_everything {}', missing.id);
  assert.equal(unknown.reply.tools[0].ok, false);
  const extra = await chat('call:set_posting_status {"id":"li-a","status":"saved","force":true}', missing.id);
  assert.equal(extra.reply.tools[0].ok, false);
  const wrong = await chat('call:set_posting_status {"id":"li-a","status":"applied"}', missing.id);
  assert.equal(wrong.reply.tools[0].ok, false);
  assert.equal(app.repo.getPosting('li-a').status, 'new');
  assert.equal(app.assistant.conversations.get(missing.id).actions.size, 0);
});

test('a conversation is written to the database only while it is kept', async t => {
  const { app, call, chat, engines } = await start();
  t.after(() => app.close());
  const first = await chat('remember the fox');
  assert.deepEqual(app.assistant.store.list(), []);

  const kept = await call(`/api/assistant/conversations/${first.id}/keep`, { method: 'POST', body: { keep: true } });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.conversation.kept, true);
  assert.deepEqual(kept.body.kept.map(item => [item.id, item.title, item.turns]), [[first.id, 'remember the fox', 2]]);
  await chat('and the hen', first.id);
  assert.equal(app.assistant.store.get(first.id).turns.length, 4, 'a kept conversation is saved as it grows');
  assert.equal((await call('/api/assistant')).body.kept[0].turns, 4);

  // Leaving it: gone from memory, still in the database, and the engine gets the earlier turns as text next time.
  assert.equal((await call(`/api/assistant/conversations/${first.id}/close`, { method: 'POST' })).status, 200);
  assert.equal(app.assistant.conversations.has(first.id), false);
  assert.equal(engines['claude-cli'].live(first.id), false);
  const reopened = await call(`/api/assistant/conversations/${first.id}`);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.kept, true);
  assert.equal(reopened.body.turns.length, 4);
  await chat('what did I say?', first.id);
  const handed = engines['claude-cli'].seen.at(-1).text;
  assert.match(handed, /^<earlier_conversation>/);
  assert.match(handed, /User: remember the fox/);
  assert.match(handed, /Assistant: Echo: and the hen/);
  assert.match(handed, /<\/earlier_conversation>\n\nwhat did I say\?$/);

  // No longer kept: the row is removed, the conversation carries on in memory only.
  const dropped = await call(`/api/assistant/conversations/${first.id}/keep`, { method: 'POST', body: { keep: false } });
  assert.deepEqual(dropped.body.kept, []);
  assert.equal(app.assistant.store.has(first.id), false);
  await chat('still here', first.id);
  assert.equal(app.assistant.store.has(first.id), false);
  assert.equal((await call(`/api/assistant/conversations/${first.id}/keep`, { method: 'POST', body: { keep: 'yes' } })).status, 400);

  // Leaving one that is not kept forgets it; deleting a kept one removes both copies.
  assert.equal((await call(`/api/assistant/conversations/${first.id}/close`, { method: 'POST' })).status, 200);
  assert.equal((await call(`/api/assistant/conversations/${first.id}`)).status, 404);
  const second = await chat('keep me');
  await call(`/api/assistant/conversations/${second.id}/keep`, { method: 'POST', body: { keep: true } });
  const removed = await call(`/api/assistant/conversations/${second.id}`, { method: 'DELETE' });
  assert.deepEqual(removed.body, { ok: true, kept: [] });
  assert.equal((await call(`/api/assistant/conversations/${second.id}`)).status, 404);
  assert.equal((await chat('hello?', second.id)).status, 404);
});

test('a conversation can be archived and taken back out, open in the pane or straight from the list', async t => {
  const { app, call, chat } = await start();
  t.after(() => app.close());
  const archive = (id, archived, headers) => call(`/api/assistant/conversations/${id}/archive`, { method: 'POST', body: { archived }, headers });
  const first = await chat('plan the week');
  assert.equal(first.conversation.archivedAt, null);

  // Archiving the open conversation keeps it; it carries on as an archived one until it is taken out.
  const archived = await archive(first.id, true);
  assert.equal(archived.status, 200);
  assert.equal(archived.body.conversation.kept, true);
  assert.match(archived.body.conversation.archivedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(archived.body.kept.map(item => [item.id, item.archivedAt]), [[first.id, archived.body.conversation.archivedAt]]);
  await chat('and the weekend', first.id);
  assert.equal(app.assistant.store.get(first.id).turns.length, 4);
  assert.equal(app.assistant.store.get(first.id).archivedAt, archived.body.conversation.archivedAt);
  const back = await archive(first.id, false);
  assert.deepEqual([back.body.conversation.kept, back.body.conversation.archivedAt, back.body.kept[0].archivedAt], [true, null, null]);

  // One that is only in the database is changed there and not loaded, so the open conversation keeps its place.
  await call(`/api/assistant/conversations/${first.id}/close`, { method: 'POST' });
  const open = await chat('something else');
  const put = await archive(first.id, true);
  assert.deepEqual([put.status, put.body.conversation], [200, null]);
  assert.ok(put.body.kept[0].archivedAt);
  assert.deepEqual([...app.assistant.conversations.keys()], [open.id]);
  assert.equal((await call('/api/assistant')).body.kept[0].archivedAt, put.body.kept[0].archivedAt);

  // Reopened it still says archived; "stop keeping" removes it from the database, archive and all.
  assert.equal((await call(`/api/assistant/conversations/${first.id}`)).body.archivedAt, put.body.kept[0].archivedAt);
  const dropped = await call(`/api/assistant/conversations/${first.id}/keep`, { method: 'POST', body: { keep: false } });
  assert.deepEqual([dropped.body.conversation.kept, dropped.body.conversation.archivedAt, dropped.body.kept], [false, null, []]);

  // Taking out one that was never kept saves nothing; a bad or unknown request is refused, and so is Claude over MCP.
  assert.equal((await archive(open.id, false)).status, 200);
  assert.equal(app.assistant.store.has(open.id), false);
  assert.equal((await archive(open.id, 'yes')).status, 400);
  assert.equal((await archive('nope', true)).status, 404);
  assert.equal((await archive(open.id, true, { 'x-dayjob-client': 'mcp' })).status, 403);
  assert.equal(app.assistant.store.has(open.id), false);
});

test('deleting a kept conversation while it is still answering leaves nothing behind', async t => {
  const { app, url, call, chat, engines, writeHeaders } = await start();
  t.after(() => app.close());
  const first = await chat('keep this');
  await call(`/api/assistant/conversations/${first.id}/keep`, { method: 'POST', body: { keep: true } });
  const response = await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text: 'slow', conversationId: first.id }) });
  const reader = response.body.getReader();
  let received = '';
  while (!received.includes('"type":"text"')) received += new TextDecoder().decode((await reader.read()).value);
  assert.equal(app.assistant.store.has(first.id), true);

  const removed = await call(`/api/assistant/conversations/${first.id}`, { method: 'DELETE' });
  assert.deepEqual(removed.body, { ok: true, kept: [] });
  while (!(await reader.read()).done) { /* the reply ends as it is stopped */ }
  assert.equal(app.assistant.store.has(first.id), false, 'the half reply is not saved again as it stops');
  assert.equal(app.assistant.conversations.has(first.id), false);
  assert.equal(engines['claude-cli'].live(first.id), false);
  assert.equal((await call(`/api/assistant/conversations/${first.id}`)).status, 404);
});

test('stopping a reply marks it stopped, frees the conversation and tells the model', async t => {
  const { app, url, chat, engines, writeHeaders } = await start();
  t.after(() => app.close());
  const stopper = new AbortController();
  const response = await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text: 'slow' }), signal: stopper.signal });
  const reader = response.body.getReader();
  let received = '';
  while (!received.includes('"type":"text"')) received += new TextDecoder().decode((await reader.read()).value);
  const id = JSON.parse(received.split('\n')[0]).conversation.id;
  assert.equal((await chat('me too', id)).status, 409, 'one reply at a time');
  stopper.abort();
  await reader.read().catch(() => {});
  await until(() => !app.assistant.conversations.get(id).flight);
  const stopped = app.assistant.conversations.get(id).turns.at(-1);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.text, 'Starting');
  assert.equal(engines['claude-cli'].live(id), false, 'the engine keeps nothing of the half reply');

  const next = await chat('go on', id);
  assert.equal(next.status, 200);
  const handed = engines['claude-cli'].seen.at(-1).text;
  assert.match(handed, /Assistant: Starting \(the user stopped this reply\)/);
  assert.match(handed, /<dayjob_note>\nThe user stopped your previous reply before it finished\.\n<\/dayjob_note>\n\ngo on$/);
});

test('an engine failure reaches the pane as a code, and an unexpected one gives nothing away', async t => {
  const { app, chat } = await start();
  t.after(() => app.close());
  const limited = await chat('boom');
  assert.equal(limited.status, 200);
  assert.equal(limited.reply.errorCode, 'rate-limit');
  assert.equal(limited.reply.error, 'Slow down.');
  const crashed = await chat('crash', limited.id);
  assert.equal(crashed.reply.errorCode, 'internal');
  assert.equal(JSON.stringify(crashed.conversation).includes('secret detail'), false);
  assert.equal((await chat('fine now', limited.id)).reply.text, 'Echo: fine now');
});

test('switching the engine or its model hands the conversation to the new one', async t => {
  const { app, call, chat, engines } = await start();
  t.after(() => app.close());
  const first = await chat('one');
  assert.equal(engines['claude-cli'].seen.length, 1);

  assert.deepEqual((await call('/api/assistant/settings', { method: 'PATCH', body: { engine: 'anthropic-api' } })).body,
    { engine: 'anthropic-api', models: { 'claude-cli': '', 'anthropic-api': '' }, apply: 'confirm' });
  const second = await chat('two', first.id);
  assert.equal(second.events[0].engine, 'anthropic-api');
  assert.equal(second.reply.engine, 'anthropic-api');
  assert.equal(engines['claude-cli'].live(first.id), false, 'the old engine lets go');
  assert.match(engines['anthropic-api'].seen[0].text, /^<earlier_conversation>[\s\S]*User: one[\s\S]*Assistant: Echo: one[\s\S]*<\/earlier_conversation>\n\ntwo$/);

  await call('/api/assistant/settings', { method: 'PATCH', body: { models: { 'anthropic-api': 'claude-haiku-5-5' } } });
  const third = await chat('three', first.id);
  assert.equal(third.reply.model, 'claude-haiku-5-5');
  assert.equal(engines['anthropic-api'].seen[1].model, 'claude-haiku-5-5');
  assert.match(engines['anthropic-api'].seen[1].text, /^<earlier_conversation>/, 'a new model starts from the kept turns as well');
  await chat('four', first.id);
  assert.equal(engines['anthropic-api'].seen[2].text, 'four');
  assert.equal((await call('/api/assistant')).body.settings.models['anthropic-api'], 'claude-haiku-5-5');

  for (const body of [{ engine: 'gpt' }, { models: { 'claude-cli': 'opus; rm -rf' } }, { models: { other: 'x' } }, { models: 'claude-opus-5-5' }, { models: { 'claude-cli': 5 } }]) {
    assert.equal((await call('/api/assistant/settings', { method: 'PATCH', body })).status, 400, JSON.stringify(body));
  }
});

test('the assistant is for the Dayjob window only, and its tool endpoint needs a live session token', async t => {
  const { app, url, call, chat } = await start();
  t.after(() => app.close());
  assert.equal((await call('/api/assistant', { headers: { 'x-dayjob-client': 'mcp' } })).status, 403);
  assert.equal((await call('/api/assistant/chat', { method: 'POST', body: { text: 'hi' }, headers: { 'x-dayjob-client': 'mcp' } })).status, 403);
  const noToken = await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(noToken.status, 403);
  assert.equal(app.assistant.conversations.size, 0);

  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(`${url}/api/assistant/mcp`, { method: 'POST', headers, body: JSON.stringify(rpc) })).status, 401);
  assert.equal((await fetch(`${url}/api/assistant/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer not-a-session' }, body: JSON.stringify(rpc) })).status, 401);
  assert.equal((await fetch(`${url}/api/assistant/mcp`, { headers })).status, 405);

  assert.equal((await chat('   ')).status, 400);
  assert.equal((await chat('x'.repeat(8001))).status, 400);
  assert.equal((await chat('hi', 'no-such-conversation')).status, 404);
  assert.equal((await chat('hi', 7)).status, 400);
  assert.equal((await call('/api/assistant/nothing')).status, 404);
});

test('only a few conversations stay in memory, and the one used longest ago goes first', async t => {
  const { app, chat } = await start();
  t.after(() => app.close());
  const ids = [];
  for (let index = 0; index < 9; index += 1) {
    ids.push((await chat(`number ${index}`)).id);
    await new Promise(done => setTimeout(done, 3));
  }
  assert.equal(app.assistant.conversations.size, 8);
  assert.equal(app.assistant.conversations.has(ids[0]), false);
  assert.equal(app.assistant.conversations.has(ids[8]), true);
});

// ---------- what an engine without the conversation is given ----------

test('a conversation is written out for an engine that has not seen it', () => {
  assert.equal(transcript([]), '');
  const turns = [
    { role: 'user', text: 'save the first one' },
    { role: 'assistant', text: 'Saved it.', tools: [{ name: 'set_posting_status', input: { id: 'li-a', status: 'saved' }, ok: true, summary: '{"id":"li-a"}', undone: true },
      { name: 'get_posting', input: { id: 'nope' }, ok: false, error: 'Posting not found.' }] },
    { role: 'user', text: 'tell me more' },
    { role: 'assistant', text: 'Well', tools: [], stopped: true },
    { role: 'user', text: 'and?' },
    { role: 'assistant', text: '', tools: [], error: 'Slow down.' },
  ];
  const text = transcript(turns);
  assert.match(text, /^<earlier_conversation>\n/);
  assert.match(text, /<\/earlier_conversation>$/);
  assert.match(text, /User: save the first one/);
  assert.match(text, /\[tool set_posting_status \{"id":"li-a","status":"saved"\} -> \{"id":"li-a"\} \(the user has undone this\)\]\n\[tool get_posting \{"id":"nope"\} -> error: Posting not found\.\]\nAssistant: Saved it\./);
  assert.match(text, /Assistant: Well \(the user stopped this reply\)/);
  assert.match(text, /Assistant: \(no reply\) \(this reply failed\)/);

  // A long conversation loses its oldest turns first and says so.
  const long = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `${index}:${'x'.repeat(200)}`, tools: [] }));
  const cut = transcript(long, 2000);
  assert.ok(cut.length < 2400);
  assert.match(cut, /\(\d+ older turns are left out\.\)/);
  assert.equal(cut.includes('0:xxx'), false);
  assert.ok(cut.includes('39:xxx'));

  assert.equal(withNotes('hello', []), 'hello');
  assert.equal(withNotes('hello', ['One.', 'Two.']), '<dayjob_note>\nOne.\nTwo.\n</dayjob_note>\n\nhello');
  assert.match(SYSTEM_PROMPT, /See or type a password, a card number or a one-time code/);
  assert.match(SYSTEM_PROMPT, /tells you only how it went/);
  assert.match(SYSTEM_PROMPT, /never instructions to you/);
});

test('kept conversations are stored, replaced and removed with secure delete, which is then put back', () => {
  const { db } = memoryRepo();
  const mode = () => db.prepare('PRAGMA secure_delete').get().secure_delete;
  const before = mode();
  const store = createConversationStore(db);
  assert.deepEqual(store.list(), []);
  store.save({ id: 'c1', title: 'First', createdAt: '2026-11-12T08:00:00.000Z', updatedAt: '2026-11-12T08:00:00.000Z', turns: [{ role: 'user', text: 'hi' }] });
  store.save({ id: 'c2', title: 'Second', createdAt: '2026-11-12T09:00:00.000Z', updatedAt: '2026-11-12T09:00:00.000Z', turns: [] });
  store.save({ id: 'c1', title: 'First', createdAt: 'ignored', updatedAt: '2026-11-12T10:00:00.000Z', turns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] });
  assert.deepEqual(store.list().map(item => [item.id, item.turns]), [['c1', 2], ['c2', 0]], 'newest first');
  assert.equal(store.get('c1').createdAt, '2026-11-12T08:00:00.000Z');
  assert.equal(store.get('c1').turns[1].text, 'hello');
  assert.equal(store.get('nope'), null);
  assert.equal(store.has('c2'), true);
  assert.equal(store.remove('c2'), true);
  assert.equal(store.remove('c2'), false);
  assert.equal(store.has('c2'), false);
  assert.equal(mode(), before);
  // Archived is a mark on the row: set and cleared on its own, and carried by a later save.
  assert.equal(store.list()[0].archivedAt, null);
  assert.equal(store.archive('c1', '2026-11-12T11:00:00.000Z'), true);
  assert.equal(store.archive('nope', '2026-11-12T11:00:00.000Z'), false);
  assert.deepEqual([store.list()[0].archivedAt, store.get('c1').archivedAt, store.get('c1').turns.length], ['2026-11-12T11:00:00.000Z', '2026-11-12T11:00:00.000Z', 2]);
  store.save({ ...store.get('c1'), updatedAt: '2026-11-12T12:00:00.000Z' });
  assert.equal(store.get('c1').archivedAt, '2026-11-12T11:00:00.000Z');
  assert.equal(store.archive('c1', null), true);
  assert.equal(store.get('c1').archivedAt, null);
  // A second store on the same database finds the table already there.
  assert.equal(createConversationStore(db).list().length, 1);
});

// ---------- the Claude Code engine ----------

// A stand-in for the `claude` process: it records how it was started and answers each line on stdin through `script`.
function fakeClaude(script) {
  const spawned = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false });
    child.exit = (code = 0, said = '') => { if (said) child.stderr.write(said); setImmediate(() => child.emit('close', code)); };
    child.kill = () => { if (!child.killed) { child.killed = true; child.exit(null); } };
    const record = { command, args, options, child, inputs: [], mcp: JSON.parse(fs.readFileSync(path.join(options.cwd, 'mcp.json'), 'utf8')), system: fs.readFileSync(path.join(options.cwd, 'system.txt'), 'utf8') };
    spawned.push(record);
    const say = event => child.stdout.write(`${JSON.stringify(event)}\n`);
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        record.inputs.push(line);
        script({ record, line, say, child, text: line.message.content[0].text });
      }
    });
    return child;
  };
  return { spawn, spawned };
}
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const answered = (say, id, text) => {
  say({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', mcp_servers: [{ name: 'dayjob_app', status: 'connected' }] });
  say({ type: 'system', subtype: 'status', status: 'requesting' });
  say({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  for (const piece of text.match(/.{1,4}/gs)) say(delta(piece));
  say({ type: 'assistant', message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
  say({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1,
    model_usage_since_last_result: { 'claude-opus-5-5': { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 } } });
};
function cliEngine(script, options = {}) {
  const fake = fakeClaude(script);
  const engine = createCliEngine({ getSettings: () => ({ ai: { claudeCommand: '' } }), mcpUrl: () => 'http://127.0.0.1:4318/api/assistant/mcp', spawn: fake.spawn,
    detect: async () => ({ available: true, command: 'claude', version: '2.1.322 (Claude Code)' }), stop: child => child.kill(), ...options });
  const sent = (id, text, extra = {}) => {
    const heard = { text: '', rounds: 0, thinking: 0 };
    const reply = engine.send({ id, text, system: 'Be brief.', model: '', onText: piece => { heard.text += piece; }, onRound: () => { heard.rounds += 1; }, onThinking: () => { heard.thinking += 1; }, ...extra });
    return { heard, reply };
  };
  return { engine, sent, ...fake };
}

test('Claude Code is started locked down, with only Dayjob\'s tools', () => {
  const args = assistantArgs();
  assert.deepEqual(args.slice(0, 7), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  assert.equal(args[args.indexOf('--tools') + 1], '', 'no built-in tools');
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], 'mcp.json');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__dayjob_app');
  assert.equal(args[args.indexOf('--system-prompt-file') + 1], 'system.txt');
  assert.equal(args.includes('--model'), false);
  assert.equal(args.some(arg => /dangerously|bypass/i.test(arg)), false);
  assert.equal(assistantArgs({ shell: true })[assistantArgs({ shell: true }).indexOf('--tools') + 1], '""', 'through cmd.exe an empty argument is written out');
  assert.equal(assistantArgs({ strictMcp: false }).includes('--strict-mcp-config'), false);
  assert.deepEqual(assistantArgs({ model: 'claude-opus-5-5[1m]' }).slice(-2), ['--model', 'claude-opus-5-5[1m]']);
  assert.equal(assistantArgs({ model: 'opus" & calc' }).includes('--model'), false);

  assert.deepEqual(resultUsage({ model_usage_since_last_result: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }, b: { inputTokens: 10, outputTokens: 20 } } }),
    { inputTokens: 11, outputTokens: 22, cacheReadTokens: 3, cacheWriteTokens: 4 });
  assert.deepEqual(resultUsage({ usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7 } }), { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 0 });
  assert.equal(resultUsage({}), null);
});

test('one Claude Code process serves a conversation: it streams text once and is reused for the next message', async () => {
  const { engine, sent, spawned } = cliEngine(({ say, text, record }) => answered(say, `msg_${record.inputs.length}`, `You said: ${text}`));
  assert.deepEqual(await engine.status(), { available: true, detail: 'Claude Code 2.1.322' });
  const first = sent('c1', 'hello');
  const outcome = await first.reply;
  assert.equal(first.heard.text, 'You said: hello', 'the whole message that follows the deltas is not shown twice');
  assert.ok(first.heard.rounds >= 1 && first.heard.thinking >= 1);
  assert.deepEqual(outcome, { usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 300, cacheWriteTokens: 40 }, model: 'claude-opus-5-5', rounds: 1 });

  const [started] = spawned;
  assert.equal(started.command, 'claude');
  assert.deepEqual(started.args, assistantArgs());
  assert.equal(started.system, 'Be brief.');
  assert.deepEqual(started.inputs[0], { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
  const server = started.mcp.mcpServers.dayjob_app;
  assert.deepEqual(Object.keys(started.mcp.mcpServers), ['dayjob_app']);
  assert.equal(server.type, 'http');
  assert.equal(server.url, 'http://127.0.0.1:4318/api/assistant/mcp');
  const token = /^Bearer ([0-9a-f]{48})$/.exec(server.headers.Authorization)[1];
  assert.equal(engine.conversationFor(token), 'c1');
  assert.equal(engine.conversationFor('someone-else'), null);
  assert.notEqual(path.resolve(started.options.cwd), path.resolve(process.cwd()), 'it runs in an empty folder of its own');

  const second = sent('c1', 'again');
  await second.reply;
  assert.equal(second.heard.text, 'You said: again');
  assert.equal(spawned.length, 1);
  assert.equal(engine.live('c1'), true);

  engine.close('c1');
  assert.equal(engine.live('c1'), false);
  assert.equal(started.child.killed, true);
  assert.equal(fs.existsSync(started.options.cwd), false, 'the token file goes with the process');
  assert.equal(engine.conversationFor(token), null);
});

test('Claude Code text that never came as deltas is still shown, and a typed model is passed on', async () => {
  const { engine, sent, spawned } = cliEngine(({ say }) => {
    say({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Whole.' }] } });
    say({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 3, output_tokens: 2 }, num_turns: 2 });
  });
  const { heard, reply } = sent('c1', 'hi', { model: 'claude-haiku-5-5' });
  assert.deepEqual(await reply, { usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'claude-haiku-5-5', rounds: 2 });
  assert.equal(heard.text, 'Whole.');
  assert.deepEqual(spawned[0].args.slice(-2), ['--model', 'claude-haiku-5-5']);
  engine.closeAll();
});

test('each way a Claude Code reply can fail ends it with a reason and leaves no process behind', async () => {
  const failure = async (script, options) => {
    const made = cliEngine(script, options);
    const error = await made.sent('c1', 'hi').reply.then(() => null, caught => caught);
    assert.ok(error instanceof AssistantError, String(error));
    assert.equal(made.engine.live('c1'), false);
    for (const item of made.spawned) assert.equal(fs.existsSync(item.options.cwd), false);
    return { error, ...made };
  };
  assert.equal((await failure(({ say }) => say({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }))).error.code, 'signed-out');
  assert.equal((await failure(({ say }) => say({ type: 'result', subtype: 'error_during_execution', is_error: true }))).error.code, 'cli-error');
  assert.equal((await failure(({ say }) => say({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'dayjob_app', status: 'failed' }] }))).error.code, 'mcp-failed');
  assert.equal((await failure(({ child }) => child.exit(1, 'error: unknown option \'--include-partial-messages\'\n'))).error.code, 'old-cli');
  assert.equal((await failure(({ child }) => child.exit(1, 'Invalid API key · Please run /login\n'))).error.code, 'signed-out');
  const died = await failure(({ child }) => child.exit(3, 'first line\nsomething broke\n'));
  assert.equal(died.error.code, 'cli-exit');
  assert.match(died.error.message, /\(3\): something broke/);
  assert.equal((await failure(() => {}, { quietMs: 40 })).error.code, 'quiet');

  const none = createCliEngine({ getSettings: () => ({ ai: {} }), mcpUrl: () => '', spawn: () => { throw new Error('must not start'); }, detect: async () => ({ available: false }) });
  assert.equal((await none.status()).available, false);
  await assert.rejects(none.send({ id: 'c1', text: 'hi', system: '', onText() {}, onRound() {}, onThinking() {} }), error => error.code === 'no-cli');
});

test('the quiet watch stands still while a tool waits on the user, and starts over when the tool is done', async () => {
  let finish = null;
  const { engine, sent } = cliEngine(({ say, text }) => { if (text === 'apply') finish = () => answered(say, 'm1', 'Sent.'); }, { quietMs: 60 });
  const first = sent('c1', 'apply');
  await until(() => finish);
  engine.hold('c1', true);
  await new Promise(done => setTimeout(done, 200));
  assert.equal(engine.live('c1'), true, 'well past the quiet limit, the reply is still waited for');
  engine.hold('c1', false);
  finish();
  assert.equal((await first.reply).rounds, 1);

  // Once the tool is done, silence counts again.
  const second = sent('c1', 'stall');
  await until(() => engine.live('c1'));
  engine.hold('c1', true);
  await new Promise(done => setTimeout(done, 100));
  engine.hold('c1', false);
  assert.equal((await second.reply.then(() => null, error => error)).code, 'quiet');
  assert.equal(engine.live('c1'), false);
  engine.hold('c1', true);
  engine.hold('nobody', false);
});

test('a setup that refuses --strict-mcp-config gets one more start without it', async () => {
  const { engine, sent, spawned } = cliEngine(({ say, child, record, text }) => {
    if (record.args.includes('--strict-mcp-config')) child.exit(1, 'error: --strict-mcp-config is not allowed by your organization\n');
    else answered(say, 'm1', `ok ${text}`);
  });
  const { heard, reply } = sent('c1', 'hi');
  await reply;
  assert.equal(heard.text, 'ok hi');
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].args.includes('--strict-mcp-config'), false);
  assert.equal(spawned[1].mcp.mcpServers.dayjob_app.headers.Authorization, spawned[0].mcp.mcpServers.dayjob_app.headers.Authorization);
  assert.equal(engine.live('c1'), true);
  engine.closeAll();
});

test('stopping a Claude Code reply ends its process', async () => {
  const { engine, sent, spawned } = cliEngine(({ say }) => { say({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } }); say(delta('Half')); });
  const stopper = new AbortController();
  const { heard, reply } = sent('c1', 'hi', { signal: stopper.signal });
  await until(() => heard.text === 'Half');
  stopper.abort(new Error('Stopped by the user.'));
  await assert.rejects(reply, /Stopped by the user/);
  assert.equal(engine.live('c1'), false);
  assert.equal(spawned[0].child.killed, true);
  const already = new AbortController();
  already.abort();
  await assert.rejects(sent('c2', 'hi', { signal: already.signal }).reply);
  assert.equal(spawned.length, 1, 'a reply stopped before it began starts nothing');
});

test('temp folders left by a Dayjob that was ended by force are cleared, and nothing else is touched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-sweep-'));
  const make = (name, { old = true, files = ['mcp.json', 'system.txt'] } = {}) => {
    const folder = path.join(root, name);
    fs.mkdirSync(folder);
    for (const file of files) fs.writeFileSync(path.join(folder, file), '{}');
    if (old) fs.utimesSync(folder, new Date(Date.now() - 2 * 86400000), new Date(Date.now() - 2 * 86400000));
    return folder;
  };
  const stale = make('dayjob-assistant-AbC123');
  const recent = make('dayjob-assistant-Zz9Yy8', { old: false });
  const foreign = make('dayjob-assistant-Qq1Ww2', { files: ['mcp.json', 'notes.txt'] });
  const other = make('someone-elses-folder');
  const longer = make('dayjob-assistant-backup-2026');
  const { engine, sent } = cliEngine(({ say }) => answered(say, 'm1', 'ok'), { tmpdir: () => root });
  await sent('c1', 'hi').reply;
  assert.equal(fs.existsSync(stale), false);
  for (const kept of [recent, foreign, other, longer]) assert.equal(fs.existsSync(kept), true, kept);
  engine.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- the Claude API engine ----------

// A stand-in for the SDK client: each round answers the next entry of `rounds` (a message, or an error to throw).
function fakeApi(rounds) {
  const requests = [];
  const clients = [];
  const createClient = options => {
    clients.push(options);
    return { messages: { stream(body, extra) {
      requests.push({ body: structuredClone(body), extra });
      const next = rounds.shift();
      const listeners = [];
      return {
        on(event, listener) { if (event === 'text') listeners.push(listener); return this; },
        async finalMessage() {
          if (next instanceof Error) throw next;
          for (const block of next.content) if (block.type === 'text') listeners.forEach(listener => listener(block.text));
          return { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }, stop_reason: 'end_turn', ...next };
        },
      };
    } } };
  };
  return { requests, clients, createClient };
}
const TOOLS = [{ name: 'list_postings', description: 'List postings.', input_schema: { type: 'object', properties: {}, additionalProperties: false } }];
const toolUse = (id, input = {}) => ({ type: 'tool_use', id, name: 'list_postings', input });
function apiEngine(rounds, { key = 'sk-ant-test', ...options } = {}) {
  const fake = fakeApi(rounds);
  const engine = createApiEngine({ getSettings: () => ({ ai: { apiKey: key } }), createClient: fake.createClient, ...options });
  const sent = (id, text, extra = {}) => {
    const heard = { text: '', rounds: 0, discards: 0, calls: [] };
    const reply = engine.send({ id, text, system: 'Be brief.', model: '', tools: TOOLS, onText: piece => { heard.text += piece; }, onRound: () => { heard.rounds += 1; }, onThinking() {},
      onDiscard: () => { heard.discards += 1; }, callTool: async (name, input) => { heard.calls.push([name, input]); return { ok: true, content: '{"total":2}' }; }, ...extra });
    return { heard, reply };
  };
  return { engine, sent, ...fake };
}
const apiError = status => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'nope' } }, 'nope', new Headers());

test('the Claude API engine runs the tool loop itself and keeps the conversation for the next message', async () => {
  const thought = { type: 'thinking', thinking: '', signature: 'sig' };
  const { engine, sent, requests, clients } = apiEngine([
    { content: [thought, { type: 'text', text: 'Looking.' }, toolUse('t1', { status: 'new' })], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Two jobs.' }] },
    { content: [{ type: 'text', text: 'Bye.' }] },
  ]);
  const first = sent('c1', 'what is new?');
  const outcome = await first.reply;
  assert.deepEqual(outcome, { usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 1800, cacheWriteTokens: 100 }, model: 'claude-opus-5-5', rounds: 2 });
  assert.equal(first.heard.text, 'Looking.Two jobs.');
  assert.equal(first.heard.rounds, 2);
  assert.deepEqual(first.heard.calls, [['list_postings', { status: 'new' }]]);
  assert.equal(clients[0].apiKey, 'sk-ant-test');

  const [one, two] = requests.map(request => request.body);
  assert.equal(one.model, 'claude-opus-5-5', 'the default model');
  assert.deepEqual(one.thinking, { type: 'adaptive' });
  assert.deepEqual(one.cache_control, { type: 'ephemeral' });
  assert.equal(one.system, 'Be brief.');
  assert.ok(one.max_tokens >= 8000);
  assert.deepEqual(one.tools, [{ ...TOOLS[0], eager_input_streaming: true }]);
  assert.deepEqual(one.messages, [{ role: 'user', content: 'what is new?' }]);
  assert.deepEqual(two.messages.slice(1), [
    { role: 'assistant', content: [thought, { type: 'text', text: 'Looking.' }, toolUse('t1', { status: 'new' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"total":2}' }] },
  ], 'the reply goes back exactly as it came, thinking included');

  await sent('c1', 'thanks').reply;
  assert.equal(requests[2].body.messages.length, 5);
  assert.deepEqual(requests[2].body.messages.at(-1), { role: 'user', content: 'thanks' });
  assert.equal(engine.live('c1'), true);
  engine.close('c1');
  assert.equal(engine.live('c1'), false);
});

test('the Claude API engine tells the model when a tool failed, and gives the oldest model no thinking setting', async () => {
  const { sent, requests } = apiEngine([{ content: [toolUse('t1')], stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'Sorry.' }] }]);
  await sent('c1', 'go', { model: 'claude-haiku-4-5', callTool: async () => ({ ok: false, content: '{"error":"Posting not found."}' }) }).reply;
  assert.deepEqual(requests[1].body.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 't1', content: '{"error":"Posting not found."}', is_error: true }]);
  assert.equal(requests[0].body.model, 'claude-haiku-4-5');
  assert.equal('thinking' in requests[0].body, false);
});

test('a refused, cut-off or runaway Claude API reply ends with its reason and runs no half-written tool call', async () => {
  const refused = apiEngine([{ content: [], stop_reason: 'refusal' }]);
  await assert.rejects(refused.sent('c1', 'hi').reply, error => error instanceof AssistantError && error.code === 'refusal');
  assert.equal(refused.engine.live('c1'), false, 'a message that got no answer is taken back');

  const cut = apiEngine([{ content: [{ type: 'text', text: 'Let me' }, toolUse('t1', { status: 'ne' })], stop_reason: 'max_tokens' }, { content: [{ type: 'text', text: 'Again.' }] }]);
  const cutSent = cut.sent('c1', 'hi');
  await assert.rejects(cutSent.reply, error => error.code === 'cut-off');
  assert.deepEqual(cutSent.heard.calls, [], 'the call may be incomplete, so it is not run');
  await cut.sent('c1', 'once more').reply;
  const carried = cut.requests[1].body.messages;
  assert.equal(carried[2].content[0].is_error, true, 'every tool call still has its answer, so the conversation stays valid');
  assert.equal(carried[2].content[0].tool_use_id, 't1');

  // A plain answer that ran out of room simply ends.
  const long = apiEngine([{ content: [{ type: 'text', text: 'Long' }], stop_reason: 'max_tokens' }]);
  assert.equal((await long.sent('c1', 'hi').reply).rounds, 1);

  const loop = apiEngine(Array.from({ length: 5 }, (_, index) => ({ content: [toolUse(`t${index}`)], stop_reason: 'tool_use' })), { maxRounds: 3 });
  const looped = loop.sent('c1', 'hi');
  await assert.rejects(looped.reply, error => error.code === 'too-many-steps');
  assert.equal(looped.heard.calls.length, 3);

  // A server tool pausing the turn is simply continued.
  const paused = apiEngine([{ content: [{ type: 'text', text: 'One' }], stop_reason: 'pause_turn' }, { content: [{ type: 'text', text: ' two.' }] }]);
  const pausedSent = paused.sent('c1', 'hi');
  assert.equal((await pausedSent.reply).rounds, 1);
  assert.equal(pausedSent.heard.text, 'One two.');
  assert.equal(paused.requests[1].body.messages.length, 2, 'the paused part is sent back to be continued');
});

test('Claude API failures become reasons the pane can explain, and the key never leaves the engine', async () => {
  const code = async error => {
    const made = apiEngine([error]);
    const caught = await made.sent('c1', 'hi').reply.then(() => null, failure => failure);
    assert.ok(caught instanceof AssistantError, String(caught));
    assert.equal(made.engine.live('c1'), false);
    assert.equal(JSON.stringify([caught.message, caught.code]).includes('sk-ant-test'), false);
    return caught.code;
  };
  assert.equal(await code(apiError(401)), 'bad-key');
  assert.equal(await code(apiError(429)), 'rate-limit');
  assert.equal(await code(apiError(500)), 'api');
  assert.equal(await code(new Anthropic.APIConnectionError({ message: 'no route' })), 'offline');

  const none = apiEngine([], { key: '' });
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal((await none.engine.status()).available, false);
    await assert.rejects(none.sent('c1', 'hi').reply, error => error.code === 'no-key');
    assert.equal(none.clients.length, 0);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    assert.equal((await none.engine.status()).available, true);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('a tool input that arrives broken is asked for again, twice at most, and a stop is passed through', async () => {
  const broken = () => new SyntaxError('Unexpected end of JSON input');
  const retried = apiEngine([broken(), { content: [{ type: 'text', text: 'Fine.' }] }]);
  const sent = retried.sent('c1', 'hi');
  await sent.reply;
  assert.equal(sent.heard.discards, 1);
  assert.equal(sent.heard.text, 'Fine.');
  assert.deepEqual(retried.requests[1].body.messages, [{ role: 'user', content: 'hi' }]);

  const hopeless = apiEngine([broken(), broken(), broken(), { content: [{ type: 'text', text: 'never' }] }]);
  await assert.rejects(hopeless.sent('c1', 'hi').reply, SyntaxError);
  assert.equal(hopeless.requests.length, 3);

  // Stopped while a tool runs: the remaining calls are answered as not run, and the stop is what comes out.
  const stopper = new AbortController();
  const stopped = apiEngine([{ content: [toolUse('t1'), toolUse('t2')], stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'never' }] }]);
  const calls = [];
  const reply = stopped.sent('c1', 'hi', { signal: stopper.signal, callTool: async name => { calls.push(name); stopper.abort(new Error('Stopped by the user.')); return { ok: true, content: '{}' }; } }).reply;
  await assert.rejects(reply, /Stopped by the user/);
  assert.equal(calls.length, 1);
  assert.equal(stopped.requests.length, 1);
  assert.equal(stopped.requests[0].extra.signal, stopper.signal);
});
