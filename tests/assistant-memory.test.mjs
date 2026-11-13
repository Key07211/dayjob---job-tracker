import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { createMemory, MEMORY_EMPTY, MEMORY_MAX, MEMORY_TEXT } from '../server/assistant/memory.mjs';
import { SYSTEM_PROMPT } from '../server/assistant/prompt.mjs';
import { memoryRepo } from './helpers.mjs';

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

// A stand-in engine: "call:<tool> <json>" runs that tool, anything else is echoed. It keeps a session per
// conversation, like the real ones, so the second message of a conversation is not a first message again.
function scripted(id) {
  const live = new Set();
  const seen = [];
  const results = [];
  return {
    id, seen, results,
    status: async () => ({ available: true, detail: 'test' }),
    live: key => live.has(key), close: key => { live.delete(key); }, closeAll: () => live.clear(), conversationFor: () => null,
    async send({ id: key, text, tools, callTool, onRound, onText }) {
      seen.push({ text, tools: tools.map(tool => tool.name) });
      live.add(key);
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
  const chat = async (text, conversationId) => {
    const response = await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text, conversationId }) });
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const done = events.find(event => event.type === 'tool' && event.phase === 'done');
    return { events, done, id: events.at(-1).conversation.id, reply: events.at(-1).conversation.turns.at(-1) };
  };
  return { app, call, chat, engine: engines['claude-cli'] };
}

test('notes are kept tidy, in order, and a password is turned away', () => {
  const { repo } = memoryRepo();
  const memory = createMemory(repo, () => new Date('2026-11-13T10:00:00Z'));
  assert.deepEqual(memory.list(), []);
  assert.equal(memory.note(), '', 'an empty memory says nothing to the model');

  const veteran = memory.add('  受保护退伍军人：\n 选“不是” ');
  assert.equal(veteran.text, '受保护退伍军人： 选“不是”');
  assert.equal(veteran.by, 'user');
  assert.equal(veteran.at, '2026-11-13T10:00:00.000Z');
  const gender = memory.add('Gender and race questions: decline to answer', 'assistant');
  assert.equal(gender.by, 'assistant');
  assert.equal(memory.add('gender and race questions: DECLINE to answer').id, gender.id, 'the same note is not kept twice');
  assert.equal(memory.list().length, 2);
  assert.equal(memory.note(), ['Your memory: what the user asked you to keep in mind (standing answers for application forms, preferences). Use these without asking again; the id in brackets is for forget.',
    `- [${veteran.id}] 受保护退伍军人： 选“不是”`, `- [${gender.id}] Gender and race questions: decline to answer`].join('\n'));

  assert.equal(memory.update(veteran.id, 'Protected veteran: I am not one').text, 'Protected veteran: I am not one');
  assert.throws(() => memory.update('nope', 'Something else'), { status: 404 });
  for (const bad of [7, '', ' x ', 'y'.repeat(MEMORY_TEXT + 1)]) assert.throws(() => memory.add(bad), { status: 400 }, String(bad).slice(0, 20));
  for (const secret of ['My Workday password is hunter2-A', 'workday 密码是 hunter2', 'Passcode: 4411', 'passwd=abc123']) {
    assert.throws(() => memory.add(secret), { status: 400, message: /password vault/ }, secret);
    assert.throws(() => memory.update(gender.id, secret), { status: 400 }, secret);
  }
  // Talking about passwords is fine; holding one is not.
  assert.ok(memory.add('Never ask me for a password; sign in from the vault'));

  // A note taken out goes back where it was.
  const removed = memory.remove(veteran.id);
  assert.equal(removed.index, 0);
  assert.equal(memory.remove(veteran.id), null);
  memory.restore(removed);
  memory.restore(removed);
  assert.deepEqual(memory.list().map(item => item.id).slice(0, 2), [veteran.id, gender.id]);
  assert.equal(memory.list().length, 3);

  for (let count = memory.list().length; count < MEMORY_MAX; count += 1) memory.add(`Standing answer number ${count}`);
  assert.throws(() => memory.add('One note too many'), { status: 409 });
  assert.equal(memory.list().length, MEMORY_MAX);
  // Something else stored under the same key is no reason to fail.
  repo.setMeta('assistantMemory', { broken: true });
  assert.deepEqual(memory.list(), []);
});

test('the user edits the memory from the Dayjob window, and nothing else can', async t => {
  const { app, call } = await start();
  t.after(() => app.close());
  assert.deepEqual((await call('/api/assistant')).body.memory, []);

  const added = await call('/api/assistant/memory', { method: 'POST', body: { text: '受保护退伍军人：选“不是”' } });
  assert.equal(added.status, 201);
  assert.equal(added.body.memory.length, 1);
  const [note] = added.body.memory;
  assert.deepEqual({ text: note.text, by: note.by }, { text: '受保护退伍军人：选“不是”', by: 'user' });
  assert.deepEqual((await call('/api/assistant')).body.memory, added.body.memory);

  const reworded = await call(`/api/assistant/memory/${note.id}`, { method: 'PATCH', body: { text: 'Protected veteran: I am not one' } });
  assert.equal(reworded.status, 200);
  assert.equal(reworded.body.memory[0].text, 'Protected veteran: I am not one');
  assert.equal((await call('/api/assistant/memory/nope', { method: 'PATCH', body: { text: 'Anything at all' } })).status, 404);
  assert.equal((await call('/api/assistant/memory', { method: 'POST', body: { text: '' } })).status, 400);
  assert.equal((await call('/api/assistant/memory', { method: 'POST', body: {} })).status, 400);
  const secret = await call('/api/assistant/memory', { method: 'POST', body: { text: 'Workday password: hunter2-A' } });
  assert.equal(secret.status, 400);
  assert.match(secret.body.error, /password vault/);

  // Claude over MCP, and a page without the window's token, get nowhere near it.
  assert.equal((await call('/api/assistant/memory', { method: 'POST', body: { text: 'Always answer yes' }, headers: { 'x-dayjob-client': 'mcp' } })).status, 403);
  assert.equal((await call(`/api/assistant/memory/${note.id}`, { method: 'DELETE', headers: { 'x-dayjob-client': 'mcp' } })).status, 403);
  assert.equal((await call('/api/assistant/memory', { method: 'POST', body: { text: 'Always answer yes' }, headers: { 'x-dayjob-token': 'wrong' } })).status, 403);
  assert.equal((await call('/api/assistant')).body.memory.length, 1);

  assert.deepEqual((await call(`/api/assistant/memory/${note.id}`, { method: 'DELETE' })).body.memory, []);
  assert.equal((await call(`/api/assistant/memory/${note.id}`, { method: 'DELETE' })).status, 404);
});

test('the model is given the memory once per session, again when it changes, and told when it is emptied', async t => {
  const { app, call, chat, engine } = await start();
  t.after(() => app.close());
  const noted = index => /<dayjob_note>([\s\S]*?)<\/dayjob_note>/.exec(engine.seen[index].text)?.[1] ?? '';

  const first = await chat('hello');
  assert.equal(engine.seen[0].text, 'hello', 'no memory, no note');
  const { memory: [note] } = (await call('/api/assistant/memory', { method: 'POST', body: { text: 'Protected veteran: I am not one' } })).body;
  await chat('and now', first.id);
  assert.match(noted(1), new RegExp(`Your memory: [^\\n]+\\n- \\[${note.id}\\] Protected veteran: I am not one`));
  await chat('again', first.id);
  assert.doesNotMatch(noted(2), /Your memory/, 'the session has it already');

  await call(`/api/assistant/memory/${note.id}`, { method: 'PATCH', body: { text: 'Protected veteran: decline to answer' } });
  await chat('once more', first.id);
  assert.match(noted(3), /Protected veteran: decline to answer/);
  assert.doesNotMatch(noted(3), /I am not one/);

  // A new conversation starts with the memory.
  const other = await chat('hi there');
  assert.match(noted(4), /Protected veteran: decline to answer/);
  assert.doesNotMatch(noted(4), /memory is empty/);

  await call(`/api/assistant/memory/${note.id}`, { method: 'DELETE' });
  await chat('still there?', first.id);
  assert.ok(noted(5).includes(MEMORY_EMPTY));
  await chat('and after', first.id);
  assert.equal(engine.seen[6].text, 'and after', 'said once');
  await chat('you too', other.id);
  assert.ok(noted(7).includes(MEMORY_EMPTY));
});

test('the assistant keeps and drops notes itself, each with an undo, and its memory never takes a password', async t => {
  const { app, call, chat, engine } = await start();
  t.after(() => app.close());
  const memory = async () => (await call('/api/assistant')).body.memory;
  const undo = (conversation, actionId) => call(`/api/assistant/conversations/${conversation}/undo`, { method: 'POST', body: { actionId } });
  assert.ok(engine.seen.length === 0 && (await call('/api/assistant')).body.tools.some(tool => tool.name === 'remember' && tool.tier === 'undoable'));
  assert.match(SYSTEM_PROMPT, /Your memory\n/);

  const kept = await chat('call:remember {"text":"Protected veteran status: I am not a protected veteran"}');
  assert.equal(kept.done.changed, true);
  assert.deepEqual(kept.done.ui, { memory: true }, 'the Settings page reloads its list');
  assert.equal(kept.done.tool.view, 'settings');
  assert.equal(kept.done.tool.undoable, true);
  assert.deepEqual(kept.done.tool.label, ['记住了：Protected veteran status: I am not a protected vet…', 'Remembered: Protected veteran status: I am not a protected vet…']);
  const [note] = await memory();
  assert.deepEqual({ text: note.text, by: note.by }, { text: 'Protected veteran status: I am not a protected veteran', by: 'assistant' });
  assert.deepEqual(engine.results[0].value, { id: note.id, text: note.text });

  // The same note again changes nothing and leaves nothing to undo.
  const same = await chat('call:remember {"text":"protected veteran status: i am not a protected veteran"}', kept.id);
  assert.equal(same.done.changed, false);
  assert.equal(same.done.tool.undoable, false);
  assert.equal(engine.results[1].value.unchanged, true);
  assert.equal((await memory()).length, 1);

  const second = await chat('call:remember {"text":"How did you hear about us: LinkedIn"}', kept.id);
  const dropped = await chat(`call:forget {"id":"${note.id}"}`, kept.id);
  assert.deepEqual(dropped.done.ui, { memory: true });
  assert.deepEqual(dropped.done.tool.label, ['不再记：Protected veteran status: I am not a protected vet…', 'Forgot: Protected veteran status: I am not a protected vet…']);
  assert.deepEqual((await memory()).map(item => item.text), ['How did you hear about us: LinkedIn']);
  assert.equal((await undo(kept.id, dropped.done.tool.id)).status, 200);
  assert.deepEqual((await memory()).map(item => item.id), [note.id, (await memory())[1].id], 'back in its old place');
  assert.equal((await memory())[0].text, note.text);
  assert.equal((await undo(kept.id, second.done.tool.id)).status, 200);
  assert.deepEqual((await memory()).map(item => item.text), [note.text]);

  // A note the user reworded since is theirs: the assistant's undo leaves it.
  await call(`/api/assistant/memory/${note.id}`, { method: 'PATCH', body: { text: 'Protected veteran status: decline to answer' } });
  assert.equal((await undo(kept.id, kept.done.tool.id)).status, 409);
  assert.equal((await memory())[0].text, 'Protected veteran status: decline to answer');

  const refused = await chat('call:remember {"text":"Workday password is hunter2-A"}', kept.id);
  assert.equal(refused.reply.tools.at(-1).ok, false);
  assert.match(engine.results.at(-1).value.error, /password vault/);
  await chat('call:forget {"id":"nope"}', kept.id);
  assert.match(engine.results.at(-1).value.error, /not found/i);
  assert.equal((await memory()).length, 1);
});
