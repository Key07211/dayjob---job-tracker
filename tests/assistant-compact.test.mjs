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
import { COMPACT_WINDOW, createCliEngine, summaryFrom } from '../server/assistant/engine-cli.mjs';
import { compactLine, contextWindow, createApiEngine } from '../server/assistant/engine-api.mjs';
import { HANDOVER_MAX, RECENT_MAX, carryOn, compactPrompt, cutFor, estimateTokens, handover, summaryBlock, summaryOf, transcript } from '../server/assistant/prompt.mjs';
import { createConversationStore } from '../server/assistant/store.mjs';
import { memoryRepo } from './helpers.mjs';

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting.');
    await new Promise(done => setTimeout(done, 10));
  }
};

// ---------- the summary and what an engine is handed ----------

test('the request for a summary asks for text only, lays out what must survive, and carries what the user asked to keep', () => {
  const plain = compactPrompt();
  assert.match(plain, /^<dayjob_compact>\n/);
  assert.match(plain, /<\/dayjob_compact>$/);
  assert.match(plain, /not a message from the user/);
  assert.match(plain, /Reply with text only\. Do not call any tool/);
  assert.match(plain, /inside <summary><\/summary>, in the language the user writes in/);
  for (const part of ['What the user wants', 'What the user said', 'Jobs, companies and applications', 'What you did in Dayjob', 'Applications in the Dayjob browser', 'Problems', 'Still open', 'Where things stand']) assert.ok(plain.includes(part), part);
  assert.match(plain, /never write down a password, a card number or a code/);
  assert.equal(plain.includes('special attention'), false);
  assert.match(compactPrompt('the salary answers'), /pay special attention to this:\nthe salary answers\n<\/dayjob_compact>$/);

  assert.equal(summaryOf('<analysis>thinking it over</analysis>\n<summary>\n1. Wants a job.\n</summary>\nbye'), '1. Wants a job.');
  assert.equal(summaryOf('first <summary>old</summary> then <summary>new</summary>'), 'new', 'the last one counts');
  assert.equal(summaryOf('<summary>cut off half way'), 'cut off half way');
  const untagged = `1. The user wants a data job in Shanghai. ${'They saved three postings and applied to one. '.repeat(5)}`;
  assert.equal(summaryOf(`<analysis>x</analysis>  ${untagged}  `), untagged.trim(), 'a summary written without the tags still counts');
  assert.equal(summaryOf('Sure, I can do that.'), '', 'a line of chat is not a summary');
  assert.equal(summaryOf(''), '');
  assert.equal(summaryOf('<summary>   </summary>'), '');
  assert.ok(summaryOf(`<summary>${'x'.repeat(70000)}</summary>`).length < 60010);

  const block = summaryBlock('The summary.');
  assert.match(block, /^<conversation_summary>\n[\s\S]*call a tool again when you need current data[\s\S]*read the page again[\s\S]*\n\nThe summary\.\n<\/conversation_summary>$/);
  assert.equal(carryOn('S'), summaryBlock('S'));
  const going = carryOn('S', { notes: '<dayjob_note>\nApply mode: manual confirm.\n</dayjob_note>', request: 'apply to the first one' });
  assert.ok(going.startsWith(`${summaryBlock('S')}\n\n<dayjob_note>\nApply mode: manual confirm.\n</dayjob_note>\n\nCarry on with what you were doing`));
  assert.match(going, /without asking the user to repeat themselves\. The message you were answering:\n\napply to the first one$/);

  assert.ok(estimateTokens('你好世界这是中文') > estimateTokens('hello wo'), 'Chinese characters count for more');
  assert.equal(estimateTokens(''), 0);
  assert.ok(Math.abs(estimateTokens('x'.repeat(3200)) - 1000) < 5);
});

test('a compacted conversation is handed over as its summary and the turns after it; a long one is cut between exchanges', () => {
  const turn = (index, size = 20) => ({ role: index % 2 ? 'assistant' : 'user', text: `${index}:${'x'.repeat(size)}`, tools: [] });
  const marker = summary => ({ role: 'compact', at: '2026-11-14T08:00:00.000Z', trigger: 'manual', summary });
  const plain = [turn(0), turn(1)];
  assert.equal(handover(plain), transcript(plain), 'nothing compacted: the conversation as before');
  assert.equal(handover([]), '');

  // The summary stands for everything before the marker; only what follows is written out.
  const compacted = [turn(0), turn(1), marker('First summary.'), turn(2), turn(3)];
  const text = handover(compacted);
  assert.ok(text.startsWith(summaryBlock('First summary.')));
  assert.match(text, /<\/conversation_summary>\n\n<earlier_conversation>\nThese are the turns since that summary/);
  assert.match(text, /User: 2:x+\n\nAssistant: 3:x+\n<\/earlier_conversation>$/);
  assert.equal(text.includes('0:x'), false);
  assert.equal(handover([turn(0), turn(1), marker('Only this.')]), summaryBlock('Only this.'), 'nothing after the marker: the summary alone');
  // The latest summary counts. A marker without one (Claude Code did not say what it wrote) changes nothing.
  assert.ok(handover([turn(0), marker('One.'), turn(1), marker('Two.'), turn(2)]).startsWith(summaryBlock('Two.')));
  assert.equal(handover([turn(0), turn(1), marker(''), turn(2), turn(3)]), transcript([turn(0), turn(1), turn(2), turn(3)]));
  assert.equal(transcript(compacted).includes('compact'), false, 'a marker is never written out as a turn');

  // Cutting: null while it fits; else the recent turns are kept whole, starting at a message of the user's.
  assert.equal(cutFor([turn(0), turn(1)]), null);
  const long = Array.from({ length: 12 }, (_, index) => turn(index, 5000));
  assert.ok(long.reduce((sum, item) => sum + item.text.length, 0) > HANDOVER_MAX);
  assert.equal(cutFor(long), 10, 'the last exchange fits in what is kept');
  assert.equal(long[cutFor(long)].role, 'user');
  assert.equal(cutFor(long, { keep: 21000 }), 8);
  assert.ok(RECENT_MAX < HANDOVER_MAX);
  // An exchange too large to keep as it is: all of it is summarised.
  assert.equal(cutFor([turn(0, 30000), turn(1, 30000)]), 2);
  // Only what follows the last summary is weighed.
  assert.equal(cutFor([...long, marker('Summed up.'), turn(12), turn(13)]), null);
  const again = [...long.slice(0, 4), marker('Summed up.'), ...long.slice(4)];
  assert.equal(cutFor(again), 11);
  assert.equal(again[11].text.startsWith('10:'), true);
});

// ---------- the assistant: compacting on request, and by itself ----------

// A stand-in engine with a session per conversation. A request for a summary is answered with `summary` (null: no
// summary at all; with `own` set the engine compacts by itself instead and answers something else); with `reach`
// set it first tries a tool. "squeeze" and "squeeze-quiet" compact the way an engine
// does by itself in the middle of a reply; "big" reports a nearly full conversation; "call:<tool> <json>" runs a
// tool; "slow" waits to be stopped; anything else is echoed.
function scripted(id) {
  const live = new Set();
  const seen = [];
  const engine = {
    id, seen, summary: 'Summary of it all.', own: '', reach: null, reached: [], gate: null, token: null,
    status: async () => ({ available: true, detail: 'test' }),
    live: key => live.has(key),
    close: key => { live.delete(key); },
    closeAll: () => live.clear(),
    conversationFor: token => (engine.token && token === engine.token.value ? engine.token.conversation : null),
    async send({ id: key, text, model, notes, compacting = false, callTool, onRound, onThinking, onText, onCompacting, onCompact, signal }) {
      seen.push({ key, text, notes, compacting, live: live.has(key) });
      live.add(key);
      onRound();
      onThinking();
      if (text.includes('<dayjob_compact>')) {
        if (engine.reach) engine.reached.push(await callTool(engine.reach.name, engine.reach.input));
        // Like the real engines, a wait ends at once when the reply is stopped.
        if (engine.gate) await Promise.race([engine.gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason || new Error('Stopped.')), { once: true }))]);
        // Claude Code compacting by itself as the request arrives, and then answering something else.
        if (engine.own) { onCompacting('auto'); onCompact({ trigger: 'auto', summary: engine.own, before: 170000, after: 900 }); onText('Sure, where were we?'); }
        else if (engine.summary !== null) onText(`<analysis>…</analysis>\n<summary>\n${engine.summary}\n</summary>`);
        return { usage: USAGE, model: model || 'test-model', rounds: 1 };
      }
      const said = text.split(/<\/earlier_conversation>|<\/dayjob_note>|<\/conversation_summary>/).at(-1).trim();
      if (said === 'slow') {
        onText('Starting');
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason || new Error('Stopped.')), { once: true }));
      }
      if (said === 'squeeze' || said === 'squeeze-quiet') {
        onCompacting('auto');
        onCompact({ trigger: 'auto', summary: said === 'squeeze' ? 'What the engine wrote.' : '', before: 170000, after: 900 });
        onText('Carried on.');
        return { usage: USAGE, model: model || 'test-model', rounds: 2, context: { tokens: 1200, limit: 167000 } };
      }
      const wanted = /^call:(\w+)\s*(\{.*\})?$/s.exec(said);
      if (wanted) {
        const outcome = await callTool(wanted[1], JSON.parse(wanted[2] || '{}'));
        onText(outcome.ok ? 'Done.' : 'Failed.');
        return { usage: USAGE, model: model || 'test-model', rounds: 2 };
      }
      onText(`Echo: ${said}`);
      return { usage: USAGE, model: model || 'test-model', rounds: 1, ...(said === 'big' ? { context: { tokens: 120000, limit: 167000 } } : {}) };
    },
  };
  return engine;
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
  const lines = async response => {
    if (response.status !== 200) return { status: response.status, body: await response.json() };
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    return { status: 200, events, types: events.map(event => event.type), end: events.at(-1), conversation: events.at(-1).conversation, id: events.at(-1).conversation.id, reply: events.at(-1).conversation.turns.at(-1) };
  };
  const chat = async (text, conversationId) => lines(await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text, conversationId }) }));
  const compact = async (id, body = {}) => lines(await fetch(`${url}/api/assistant/conversations/${id}/compact`, { method: 'POST', headers: writeHeaders, body: JSON.stringify(body) }));
  return { app, url, call, chat, compact, engines, engine: engines['claude-cli'], writeHeaders };
}

test('compacting on request: the model writes a summary, a marker takes its place among the turns, and the next message starts from it', async t => {
  const { app, call, chat, compact, engine } = await start();
  t.after(() => app.close());
  const first = await chat('one');
  assert.equal(first.conversation.compactable, true);
  assert.equal(first.conversation.context, null);
  await chat('two', first.id);

  const done = await compact(first.id, { focus: '  the salary answers ' });
  assert.equal(done.status, 200);
  assert.deepEqual(done.types, ['compacting', 'compact', 'end']);
  assert.deepEqual(done.events[0], { type: 'compacting', trigger: 'manual' });
  assert.equal(done.events[1].index, 4, 'after everything said so far');
  assert.deepEqual(done.events[1].turn, { role: 'compact', at: done.events[1].turn.at, trigger: 'manual', summary: 'Summary of it all.', before: null, after: null });
  assert.equal(done.end.failure, undefined);
  assert.deepEqual(done.conversation.turns.map(turn => turn.role), ['user', 'assistant', 'user', 'assistant', 'compact'], 'the turns stay where they were');
  assert.equal(done.conversation.compactable, false, 'nothing new to compact');
  assert.equal(done.conversation.busy, false);

  // The engine was asked in the conversation it already held, with what to keep an eye on, and then let go of it.
  const asked = engine.seen[2];
  assert.equal(asked.live, true);
  assert.equal(asked.compacting, true, 'the engine is told this is the summary request, so it does not compact on its own first');
  assert.equal(engine.seen[1].compacting, false);
  assert.equal(asked.text, compactPrompt('the salary answers'));
  assert.equal(engine.live(first.id), false);
  // The summary request is counted with the assistant's usage.
  assert.equal(app.repo.usageSummary().today.assistant.calls, 3);

  const next = await chat('three', first.id);
  assert.equal(engine.seen[3].text, `${summaryBlock('Summary of it all.')}\n\nthree`, 'the summary, and nothing of the turns it stands for');
  assert.deepEqual(next.conversation.turns.map(turn => turn.role), ['user', 'assistant', 'user', 'assistant', 'compact', 'user', 'assistant']);
  assert.equal(next.conversation.compactable, true);
  // Later the engine's copy is gone again (ten idle minutes, say): the summary and what was said after it are handed over.
  engine.close(first.id);
  await chat('four', first.id);
  assert.match(engine.seen[4].text, /^<conversation_summary>[\s\S]*Summary of it all\.\n<\/conversation_summary>\n\n<earlier_conversation>\nThese are the turns since that summary[\s\S]*User: three\n\nAssistant: Echo: three\n<\/earlier_conversation>\n\nfour$/);
  assert.equal(engine.seen[4].text.includes('Echo: one'), false);

  // A second compaction, without the engine's copy: it is given the first summary and the turns after it.
  engine.close(first.id);
  engine.summary = 'Second summary.';
  const again = await compact(first.id);
  assert.equal(again.events[1].index, 9);
  const cold = engine.seen.at(-1);
  assert.equal(cold.live, false);
  assert.ok(cold.text.startsWith(summaryBlock('Summary of it all.')));
  assert.match(cold.text, /User: four\n\nAssistant: Echo: four\n<\/earlier_conversation>\n\n<dayjob_compact>/);
  assert.equal(cold.text.endsWith(compactPrompt()), true);
  await chat('five', first.id);
  assert.equal(engine.seen.at(-1).text, `${summaryBlock('Second summary.')}\n\nfive`);

  // Claude Code compacted by itself just as the request arrived and then answered something else: its own summary
  // of the same conversation is the one that is kept.
  engine.own = 'What Claude Code wrote by itself.';
  const own = await compact(first.id);
  assert.deepEqual(own.types, ['compacting', 'compact', 'end']);
  assert.equal(own.conversation.turns.at(-1).summary, 'What Claude Code wrote by itself.');
  assert.equal(own.conversation.turns.at(-1).trigger, 'manual');
  assert.equal(own.conversation.turns.filter(turn => turn.role === 'compact').length, 3, 'one marker for it, not two');
  engine.own = '';

  // What cannot be compacted, and who may ask.
  assert.equal((await compact(first.id, { focus: 7 })).status, 400);
  assert.equal((await compact(first.id, { focus: 'x'.repeat(1001) })).status, 400);
  assert.equal((await compact('no-such-conversation')).status, 404);
  assert.equal((await call(`/api/assistant/conversations/${first.id}/compact`, { method: 'POST', headers: { 'x-dayjob-client': 'mcp' } })).status, 403);
  const empty = await chat('boom?');
  await compact(empty.id);
  const nothing = await compact(empty.id);
  assert.equal(nothing.status, 409);
  assert.equal(nothing.body.error, 'There is nothing to compact yet.');
});

test('a kept conversation keeps its markers, and the list counts what was said', async t => {
  const { app, call, chat, compact } = await start();
  t.after(() => app.close());
  const first = await chat('one');
  await call(`/api/assistant/conversations/${first.id}/keep`, { method: 'POST', body: { keep: true } });
  await compact(first.id);
  const stored = app.assistant.store.get(first.id);
  assert.deepEqual(stored.turns.map(turn => turn.role), ['user', 'assistant', 'compact']);
  assert.equal(stored.turns[2].summary, 'Summary of it all.');
  assert.equal(stored.turns[2].trigger, 'manual');
  assert.equal(stored.turns[2].engine, 'claude-cli');
  assert.deepEqual(stored.turns[2].usage, USAGE);
  assert.equal((await call('/api/assistant')).body.kept[0].turns, 2, 'a marker is not an exchange');

  // Opened again after a restart: the pane shows the marker, and the engine starts from the summary.
  app.assistant.conversations.clear();
  const reopened = (await call(`/api/assistant/conversations/${first.id}`)).body;
  assert.equal(reopened.turns[2].role, 'compact');
  assert.equal(reopened.turns[2].summary, 'Summary of it all.');
  const { db } = memoryRepo();
  const store = createConversationStore(db);
  store.save({ id: 'c1', title: 'T', createdAt: '2026-11-14T08:00:00.000Z', updatedAt: '2026-11-14T08:00:00.000Z', turns: [{ role: 'user', text: 'a' }, { role: 'compact', summary: 'S' }, { role: 'assistant', text: 'b' }] });
  assert.equal(store.list()[0].turns, 2);
});

test('a compaction that brings no summary, or is stopped, changes nothing; no tool runs while compacting', async t => {
  const { app, url, chat, compact, engine, writeHeaders } = await start();
  t.after(() => app.close());
  const saved = app.repo.upsertPosting(posting({ site: 'linkedin', externalId: 'a', title: 'Job a', company: 'Company a', jobUrl: 'https://www.linkedin.com/jobs/view/a' }));
  const first = await chat('one');

  engine.summary = null;
  const failed = await compact(first.id);
  assert.deepEqual(failed.types, ['compacting', 'end']);
  assert.deepEqual(failed.end.failure, { code: 'no-summary', message: 'The assistant did not write a summary. Try again.' });
  assert.deepEqual(failed.conversation.turns.map(turn => turn.role), ['user', 'assistant']);
  assert.equal(failed.conversation.busy, false);
  assert.equal(engine.live(first.id), false, 'the engine lets go either way');
  await chat('two', first.id);
  assert.match(engine.seen.at(-1).text, /^<earlier_conversation>\nThis is your conversation with the user so far[\s\S]*User: one[\s\S]*<\/earlier_conversation>\n\ntwo$/);

  // The model reaches for a tool instead of writing: the Claude API engine's call is turned away, and so is one
  // that arrives from a Claude Code process over MCP.
  engine.summary = 'Fine.';
  engine.reach = { name: 'set_posting_status', input: { id: saved.id, status: 'saved' } };
  let release;
  engine.gate = new Promise(done => { release = done; });
  engine.token = { value: 'tok-1', conversation: first.id };
  const running = compact(first.id);
  await until(() => engine.reached.length === 1);
  assert.equal(engine.reached[0].ok, false);
  assert.match(engine.reached[0].content, /without using a tool/);
  const rpc = await fetch(`${url}/api/assistant/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer tok-1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_posting_status', arguments: { id: saved.id, status: 'saved' } } }) });
  const answer = await rpc.json();
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /No reply is in progress/);
  assert.equal(app.repo.getPosting(saved.id).status, 'new', 'nothing was changed');
  // While it runs the conversation is busy: no message, no second compaction.
  assert.equal((await chat('wait', first.id)).status, 409);
  assert.equal((await compact(first.id)).status, 409);
  release();
  const done = await running;
  assert.equal(done.conversation.turns.at(-1).summary, 'Fine.');

  // Stopped half way (the stream is closed): no marker, and the conversation is free again.
  engine.reach = null;
  engine.token = null;
  await chat('three', first.id);
  engine.gate = new Promise(() => {});
  const controller = new AbortController();
  const stopped = fetch(`${url}/api/assistant/conversations/${first.id}/compact`, { method: 'POST', headers: writeHeaders, body: '{}', signal: controller.signal }).then(response => response.text()).catch(() => 'aborted');
  await until(() => engine.seen.at(-1).text.includes('<dayjob_compact>'));
  controller.abort();
  await stopped;
  await until(() => !app.assistant.conversations.get(first.id).flight);
  engine.gate = null;
  const after = await chat('four', first.id);
  assert.equal(after.conversation.turns.filter(turn => turn.role === 'compact').length, 1);
  assert.equal(after.reply.text, 'Echo: four');
});

test('a conversation too long to hand over whole has its older turns summarised once, instead of left out', async t => {
  const { app, chat, engine } = await start();
  t.after(() => app.close());
  const turns = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `${index}:${'x'.repeat(5000)}`, tools: [], at: '2026-11-13T08:00:00.000Z', ...(index % 2 ? { engine: 'claude-cli' } : {}) }));
  app.assistant.store.save({ id: 'long-1', title: 'Long', createdAt: '2026-11-13T08:00:00.000Z', updatedAt: '2026-11-13T08:00:00.000Z', turns });

  const next = await chat('next', 'long-1');
  assert.deepEqual(next.types.slice(0, 3), ['start', 'compacting', 'compact']);
  assert.deepEqual(next.events[1], { type: 'compacting', trigger: 'auto' });
  assert.equal(next.events[2].index, 10);
  assert.equal(next.events[2].turn.trigger, 'auto');
  assert.equal(next.conversation.turns.length, 15);
  assert.equal(next.conversation.turns[10].role, 'compact');
  assert.equal(next.reply.text, 'Echo: next');

  // First the older turns go to the model with the request for a summary, then the message with the summary
  // and the latest exchange as it was said.
  const [asked, sent] = engine.seen;
  assert.match(asked.text, /^<earlier_conversation>\nThis is your conversation with the user so far[\s\S]*User: 0:x+[\s\S]*Assistant: 9:x+\n<\/earlier_conversation>\n\n<dayjob_compact>/);
  assert.equal(asked.text.includes('10:xxx'), false, 'the latest exchange is not part of what is summarised');
  assert.equal(asked.text.includes('older turns are left out'), false);
  assert.ok(sent.text.startsWith(summaryBlock('Summary of it all.')));
  assert.match(sent.text, /These are the turns since that summary[\s\S]*User: 10:x+\n\nAssistant: 11:x+\n<\/earlier_conversation>\n\nnext$/);
  assert.equal(sent.text.includes('9:xxx'), false);
  assert.ok(sent.text.length < 12000);
  // It was kept, so the marker is saved with it and the summary is never asked for again.
  assert.equal(app.assistant.store.get('long-1').turns[10].summary, 'Summary of it all.');
  engine.close('long-1');
  await chat('again', 'long-1');
  assert.equal(engine.seen.length, 3);
  assert.equal(engine.seen[2].text.includes('<dayjob_compact>'), false);
  assert.ok(engine.seen[2].text.startsWith(summaryBlock('Summary of it all.')));

  // When the summary does not come, the conversation is handed over as it used to be: without its oldest turns.
  app.assistant.store.save({ id: 'long-2', title: 'Long', createdAt: '2026-11-13T08:00:00.000Z', updatedAt: '2026-11-13T08:00:00.000Z', turns });
  engine.summary = null;
  const fallback = await chat('next', 'long-2');
  assert.equal(fallback.reply.text, 'Echo: next');
  assert.equal(fallback.reply.error, null);
  assert.equal(fallback.conversation.turns.some(turn => turn.role === 'compact'), false);
  assert.match(engine.seen.at(-1).text, /^<earlier_conversation>[\s\S]*\(\d+ older turns are left out\.\)[\s\S]*<\/earlier_conversation>\n\nnext$/);
});

test('an engine that compacts by itself is recorded: the marker sits before the message being answered, and the memory is told again', async t => {
  const { app, call, chat, engine } = await start();
  t.after(() => app.close());
  await call('/api/assistant/memory', { method: 'POST', body: { text: 'Not a protected veteran.' } });
  const first = await chat('one');
  assert.match(engine.seen[0].text, /Your memory:[\s\S]*Not a protected veteran\./);
  assert.match(engine.seen[0].notes, /^<dayjob_note>\nYour memory:[\s\S]*Not a protected veteran\.\n<\/dayjob_note>$/, 'what stands for the whole conversation goes with every message, for the engine to repeat');

  const squeezed = await chat('squeeze', first.id);
  assert.equal(engine.seen[1].text, 'squeeze', 'the memory is not repeated while the engine still has it');
  assert.deepEqual(squeezed.types, ['start', 'thinking', 'compacting', 'compact', 'text', 'end']);
  assert.equal(squeezed.events[3].index, 2);
  assert.deepEqual(squeezed.events[3].turn, { role: 'compact', at: squeezed.events[3].turn.at, trigger: 'auto', summary: 'What the engine wrote.', before: 170000, after: 900 });
  assert.deepEqual(squeezed.conversation.turns.map(turn => turn.role), ['user', 'assistant', 'compact', 'user', 'assistant']);
  assert.equal(squeezed.reply.text, 'Carried on.');
  assert.deepEqual(squeezed.conversation.context, { tokens: 1200, limit: 167000 });

  await chat('three', first.id);
  assert.match(engine.seen[2].text, /^<dayjob_note>\nYour memory:[\s\S]*Not a protected veteran\.\n<\/dayjob_note>\n\nthree$/, 'what the summary may have lost is said again');
  await chat('four', first.id);
  assert.equal(engine.seen[3].text, 'four');
  // With the engine's copy gone, its summary is where the conversation starts from.
  engine.close(first.id);
  await chat('five', first.id);
  assert.ok(engine.seen[4].text.startsWith(summaryBlock('What the engine wrote.')));
  assert.match(engine.seen[4].text, /User: squeeze\n\nAssistant: Carried on\.[\s\S]*User: four\n\nAssistant: Echo: four\n<\/earlier_conversation>/);
  assert.equal(engine.seen[4].text.includes('Echo: one'), false);

  // Claude Code compacted and did not say what it wrote: the pane shows it, the handover stays whole.
  const other = await chat('one');
  const quiet = await chat('squeeze-quiet', other.id);
  assert.equal(quiet.conversation.turns[2].role, 'compact');
  assert.equal(quiet.conversation.turns[2].summary, '');
  engine.close(other.id);
  await chat('three', other.id);
  assert.match(engine.seen.at(-1).text, /^<earlier_conversation>\nThis is your conversation with the user so far[\s\S]*User: one[\s\S]*User: squeeze-quiet[\s\S]*<\/earlier_conversation>/);
});

test('the pane is told how full the conversation is, until the engine lets go of it', async t => {
  const { app, call, chat, compact, engine } = await start();
  t.after(() => app.close());
  const first = await chat('big');
  assert.deepEqual(first.conversation.context, { tokens: 120000, limit: 167000 });
  assert.deepEqual((await call(`/api/assistant/conversations/${first.id}`)).body.context, { tokens: 120000, limit: 167000 });
  assert.equal((await chat('small', first.id)).conversation.context, null, 'an engine that does not say leaves it unknown');
  await chat('big', first.id);
  assert.equal((await compact(first.id)).conversation.context, null);
  await chat('big', first.id);
  await call('/api/assistant/settings', { method: 'PATCH', body: { engine: 'anthropic-api' } });
  assert.equal((await chat('hello', first.id)).conversation.context, null, 'another engine starts over');
  assert.equal(engine.live(first.id), false);
});

// ---------- the Claude API engine ----------

// A stand-in for the SDK client: each request answers the next entry of `rounds` (a message, or an error to throw).
function fakeApi(rounds) {
  const requests = [];
  const createClient = () => ({ messages: { stream(body) {
    requests.push(structuredClone(body));
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
  } } });
  return { requests, createClient };
}
const TOOLS = [{ name: 'list_postings', description: 'List postings.', input_schema: { type: 'object', properties: {}, additionalProperties: false } }];
const toolUse = (id, input = {}) => ({ type: 'tool_use', id, name: 'list_postings', input });
const NOTES = '<dayjob_note>\nApply mode: manual confirm.\n</dayjob_note>';
function apiEngine(rounds, options = {}) {
  const fake = fakeApi(rounds);
  const engine = createApiEngine({ getSettings: () => ({ ai: { apiKey: 'sk-ant-test' } }), createClient: fake.createClient, ...options });
  const sent = (id, text, extra = {}) => {
    const heard = { text: '', rounds: 0, thinking: 0, compacting: 0, compacts: [], calls: [] };
    const reply = engine.send({ id, text, system: 'Be brief.', model: '', tools: TOOLS, notes: NOTES, onText: piece => { heard.text += piece; }, onRound: () => { heard.rounds += 1; }, onThinking: () => { heard.thinking += 1; },
      onDiscard() {}, onCompacting: () => { heard.compacting += 1; }, onCompact: compacted => heard.compacts.push(compacted),
      callTool: async (name, input) => { heard.calls.push([name, input]); return { ok: true, content: '{"total":2}' }; }, ...extra });
    return { heard, reply };
  };
  return { engine, sent, ...fake };
}
const apiError = (status, message) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'invalid_request_error', message } }, message, new Headers());

test('the line a conversation is compacted at leaves room in every model', () => {
  assert.equal(contextWindow('claude-opus-5-5'), 1_000_000);
  assert.equal(contextWindow('claude-haiku-4-5'), 200_000);
  assert.equal(contextWindow('some-model-typed-in'), 200_000, 'an unknown model is taken for the smaller window');
  assert.equal(compactLine('claude-opus-5-5'), 167_000, 'Claude Code\'s line for a 200,000-token window');
  assert.equal(compactLine('claude-fable-5-2'), 167_000);
  assert.equal(compactLine('claude-haiku-4-5'), 107_000, 'room for one more round of tool results and the summary request');
  assert.equal(COMPACT_WINDOW, 200_000);
});

test('the Claude API engine compacts a conversation that has reached the line before the next message joins it', async () => {
  const thought = { type: 'thinking', thinking: '', signature: 'sig' };
  const { engine, sent, requests } = apiEngine([
    { content: [thought, { type: 'text', text: 'Hello.' }] },
    { content: [thought, { type: 'text', text: '<analysis>hm</analysis><summary>The user said hi.</summary>' }] },
    { content: [{ type: 'text', text: 'Again.' }] },
  ], { compactAt: () => 1000 });
  const first = sent('c1', 'hi');
  const outcome = await first.reply;
  assert.deepEqual(outcome.context, { tokens: 1070, limit: 1000 }, 'what was read and written at the last reply');
  assert.equal(first.heard.compacting, 0);

  const second = sent('c1', 'and now?');
  const result = await second.reply;
  assert.equal(second.heard.text, 'Again.', 'the summary is not part of the reply');
  assert.equal(second.heard.compacting, 1);
  assert.deepEqual(second.heard.compacts, [{ trigger: 'auto', summary: 'The user said hi.', before: 1070 }]);
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 40, cacheReadTokens: 1800, cacheWriteTokens: 100 }, 'the summary request is counted with the reply');
  assert.equal(result.rounds, 1);

  // The request for the summary: the conversation exactly as it stood (thinking included), with the request after it,
  // and everything else as in any other request, so it is read from the cache.
  const [one, asked, after] = requests;
  assert.deepEqual(asked.messages, [...one.messages, { role: 'assistant', content: [thought, { type: 'text', text: 'Hello.' }] }, { role: 'user', content: [{ type: 'text', text: compactPrompt() }] }]);
  for (const key of ['model', 'system', 'tools', 'thinking', 'cache_control', 'max_tokens']) assert.deepEqual(asked[key], one[key], key);
  // What follows is a new conversation that starts with the summary: nothing older, so no thinking block is replayed out of place.
  assert.deepEqual(after.messages, [{ role: 'user', content: `${carryOn('The user said hi.', { notes: NOTES })}\n\nand now?` }]);
  assert.match(after.messages[0].content, /<\/conversation_summary>\n\n<dayjob_note>\nApply mode: manual confirm\.\n<\/dayjob_note>\n\nand now\?$/);
  assert.equal(engine.live('c1'), true);
});

test('a reply that outgrows the line while working is compacted between two rounds and goes on with its message', async () => {
  const { sent, requests } = apiEngine([
    { content: [{ type: 'text', text: 'Looking.' }, toolUse('t1')], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: '<summary>Was looking things up.</summary>' }] },
    { content: [toolUse('t2')], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Two jobs.' }] },
  ], { compactAt: () => 1000 });
  const first = sent('c1', 'what is new?');
  const outcome = await first.reply;
  assert.equal(first.heard.text, 'Looking.Two jobs.');
  assert.deepEqual(first.heard.compacts, [{ trigger: 'auto', summary: 'Was looking things up.', before: 1070 + estimateTokens('{"total":2}') }]);
  assert.equal(first.heard.calls.length, 2);
  assert.equal(outcome.rounds, 3);

  const [one, asked, carried, last] = requests;
  // The request is added to the message that holds the tool results: nothing already sent is changed.
  assert.deepEqual(asked.messages, [...one.messages, { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, toolUse('t1')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"total":2}' }, { type: 'text', text: compactPrompt() }] }]);
  assert.deepEqual(carried.messages, [{ role: 'user', content: carryOn('Was looking things up.', { notes: NOTES, request: 'what is new?' }) }]);
  assert.match(carried.messages[0].content, /The message you were answering:\n\nwhat is new\?$/);
  // The round after that is over the line again, but a reply is not compacted twice within a few rounds.
  assert.equal(last.messages.length, 3);
  assert.equal(last.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(last.messages.at(-1).content.length, 1);
});

test('a summary request that brings no summary leaves the conversation as it was, and one that no longer fits lets go of it', async () => {
  const { engine, sent, requests } = apiEngine([
    { content: [{ type: 'text', text: 'Hello.' }] },
    { content: [toolUse('t9')], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Fine.' }] },
    apiError(400, 'prompt is too long: 1021000 tokens > 1000000 maximum'),
  ], { compactAt: () => 1000 });
  await sent('c1', 'hi').reply;
  const second = sent('c1', 'more');
  await second.reply;
  assert.equal(second.heard.text, 'Fine.');
  assert.deepEqual(second.heard.compacts, []);
  assert.deepEqual(second.heard.calls, [], 'a tool asked for instead of a summary is not run');
  assert.equal(second.heard.compacting, 1);
  assert.ok(second.heard.thinking >= 2, 'the pane goes back from compacting to thinking');
  assert.deepEqual(requests[2].messages.map(message => message.role), ['user', 'assistant', 'user'], 'the conversation is whole, and the request for a summary is not in it');
  assert.equal(requests[2].messages.at(-1).content, 'more');

  await assert.rejects(sent('c1', 'again').reply, error => error.code === 'context-full' && /Send the message again/.test(error.message));
  assert.equal(engine.live('c1'), false, 'the next message starts from the turns Dayjob keeps');

  // Dayjob's own request for a summary is never compacted first, however long the conversation is.
  const asked = apiEngine([{ content: [{ type: 'text', text: 'Hello.' }] }, { content: [{ type: 'text', text: '<summary>S</summary>' }] }], { compactAt: () => 1000 });
  await asked.sent('c4', 'hi').reply;
  const summary = asked.sent('c4', compactPrompt(), { compacting: true });
  await summary.reply;
  assert.equal(summary.heard.compacting, 0);
  assert.equal(summary.heard.text, '<summary>S</summary>');
  assert.equal(asked.requests[1].messages.length, 3);
  assert.equal(asked.requests[1].messages.at(-1).content, compactPrompt());

  // Any other refusal of a request keeps its own reason.
  const other = apiEngine([apiError(400, 'messages: roles must alternate')]);
  await assert.rejects(other.sent('c2', 'hi').reply, error => error.code === 'api');
  // With no line (a custom one may say so) nothing is ever compacted.
  const never = apiEngine([{ content: [{ type: 'text', text: 'A.' }] }, { content: [{ type: 'text', text: 'B.' }] }], { compactAt: () => 0 });
  await never.sent('c3', 'one').reply;
  const quiet = never.sent('c3', 'two');
  assert.deepEqual((await quiet.reply).context, { tokens: 1070, limit: null });
  assert.equal(quiet.heard.compacting, 0);
});

// ---------- the Claude Code engine ----------

// A stand-in for the `claude` process that answers each line on stdin through `script`.
function fakeClaude(script) {
  const spawned = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false });
    child.kill = () => { if (!child.killed) { child.killed = true; setImmediate(() => child.emit('close', null)); } };
    const record = { command, args, options, child, inputs: [] };
    spawned.push(record);
    const say = event => child.stdout.write(`${JSON.stringify(event)}\n`);
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        record.inputs.push(line);
        script({ record, say, text: line.message.content[0].text });
      }
    });
    return child;
  };
  return { spawn, spawned };
}
function cliEngine(script, options = {}) {
  const fake = fakeClaude(script);
  const engine = createCliEngine({ getSettings: () => ({ ai: { claudeCommand: '' } }), mcpUrl: () => 'http://127.0.0.1:4318/api/assistant/mcp', spawn: fake.spawn,
    detect: async () => ({ available: true, command: 'claude', version: '2.1.325 (Claude Code)' }), stop: child => child.kill(), env: {}, ...options });
  const sent = (id, text) => {
    const heard = { text: '', thinking: 0, compacting: 0, compacts: [] };
    const reply = engine.send({ id, text, system: 'Be brief.', model: '', onText: piece => { heard.text += piece; }, onRound() {}, onThinking: () => { heard.thinking += 1; },
      onCompacting: () => { heard.compacting += 1; }, onCompact: compacted => heard.compacts.push(compacted) });
    return { heard, reply };
  };
  return { engine, sent, ...fake };
}
// The lines Claude Code 2.1 writes around a compaction, as recorded from the real CLI against a stand-in API.
const CONTINUED = summary => `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

<system-reminder>
<tools-used-before-summary></tools-used-before-summary>
</system-reminder>
Summary:
${summary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.

The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them.`;
const answer = (say, id, text, usage) => {
  say({ type: 'system', subtype: 'status', status: 'requesting' });
  say({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  say({ type: 'assistant', message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } });
  say({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, usage: { input_tokens: 5, output_tokens: 6 } });
};

test('Claude Code runs with a 200,000-token auto-compact window unless the user set their own, and says how full the conversation is', async () => {
  const usage = { input_tokens: 2000, cache_read_input_tokens: 150000, cache_creation_input_tokens: 3000, output_tokens: 400 };
  const ours = cliEngine(({ say, record }) => answer(say, `m${record.inputs.length}`, 'Hello.', usage));
  const outcome = await ours.sent('c1', 'hi').reply;
  assert.equal(ours.spawned[0].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
  assert.ok(ours.spawned[0].options.env.MCP_TOOL_TIMEOUT);
  assert.deepEqual(outcome.context, { tokens: 155400, limit: 167000 });
  ours.engine.closeAll();

  const theirs = cliEngine(({ say, record }) => answer(say, `m${record.inputs.length}`, 'Hello.', usage), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k', PATH: '/usr/bin' } });
  assert.deepEqual((await theirs.sent('c1', 'hi').reply).context, { tokens: 155400, limit: null }, 'their window, their line: Dayjob does not guess it');
  assert.equal(theirs.spawned[0].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '500k');
  assert.equal(theirs.spawned[0].options.env.PATH, '/usr/bin');
  theirs.engine.closeAll();
  const moved = cliEngine(({ say, record }) => answer(say, `m${record.inputs.length}`, 'Hello.', usage), { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' } });
  assert.deepEqual((await moved.sent('c1', 'hi').reply).context, { tokens: 155400, limit: null }, 'a line moved by percentage is not guessed either');
  assert.equal(moved.spawned[0].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
  moved.engine.closeAll();

  // The message Claude Code goes on from, in the two shapes the real CLI writes (2.1.325), and in none.
  assert.equal(summaryFrom(CONTINUED('1. The user wants a data job.\n2. Saved li-a.')), '1. The user wants a data job.\n2. Saved li-a.');
  assert.equal(summaryFrom(CONTINUED('x').replace('Summary:\nx', 'A summary the model did not tag.')), 'A summary the model did not tag.');
  assert.equal(summaryFrom('This session is being continued from a previous conversation that ran out of context.\n\nJust the summary.'), 'Just the summary.');
  assert.equal(summaryFrom('Something else entirely.'), 'Something else entirely.');
  assert.equal(summaryFrom(''), '');
});

test('a compaction Claude Code does by itself is passed on with its summary, and one it gives up on is not', async () => {
  const script = ({ say, record, text }) => {
    const id = `m${record.inputs.length}`;
    if (text === 'compact now') {
      say({ type: 'system', subtype: 'status', status: 'requesting' });
      say({ type: 'system', subtype: 'status', status: 'compacting', compact_output_chars: 0 });
      say({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
      say({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 168200, post_tokens: 4100, duration_ms: 20 } });
      say({ type: 'user', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: CONTINUED('1. The user wants a data job.\n2. Saved li-a.') }] } });
      return answer(say, id, 'Carrying on.', { input_tokens: 4200, output_tokens: 100 });
    }
    if (text === 'no summary') {
      say({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 9000 } });
      return answer(say, id, 'Still here.');
    }
    if (text === 'string summary') {
      say({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });
      say({ type: 'user', message: { role: 'user', content: 'Something else entirely.' } });
      return answer(say, id, 'Yes.');
    }
    if (text === 'gives up') {
      say({ type: 'system', subtype: 'status', status: 'compacting' });
      say({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'too_few_groups' });
      return answer(say, id, 'Went on anyway.');
    }
    // An ordinary reply, with a user line in the stream that has nothing to do with compacting.
    say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } });
    return answer(say, id, 'Plain.');
  };
  const { engine, sent } = cliEngine(script);
  const plain = sent('c1', 'hello');
  await plain.reply;
  assert.deepEqual(plain.heard.compacts, []);
  assert.equal(plain.heard.compacting, 0);

  const compacted = sent('c1', 'compact now');
  const outcome = await compacted.reply;
  assert.equal(compacted.heard.text, 'Carrying on.', 'the summary is not shown as a reply');
  assert.equal(compacted.heard.compacting, 1);
  assert.deepEqual(compacted.heard.compacts, [{ trigger: 'auto', before: 168200, after: 4100, summary: '1. The user wants a data job.\n2. Saved li-a.' }]);
  assert.deepEqual(outcome.context, { tokens: 4300, limit: 167000 });

  const silent = sent('c1', 'no summary');
  await silent.reply;
  assert.deepEqual(silent.heard.compacts, [{ trigger: 'manual', before: 9000, after: null, summary: '' }]);
  const loose = sent('c1', 'string summary');
  await loose.reply;
  assert.deepEqual(loose.heard.compacts, [{ trigger: 'auto', before: null, after: null, summary: 'Something else entirely.' }], 'a message in another shape is taken whole');

  const failed = sent('c1', 'gives up');
  const before = failed.heard.thinking;
  await failed.reply;
  assert.equal(failed.heard.compacting, 1);
  assert.deepEqual(failed.heard.compacts, []);
  assert.ok(failed.heard.thinking > before, 'the pane goes back to thinking');
  assert.equal(failed.heard.text, 'Went on anyway.');
  engine.closeAll();
});
