import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { costOf, priceOf, PRICES_AS_OF } from '../server/jobs/scoring/prices.mjs';
import { clock, memoryRepo } from './helpers.mjs';

const near = (actual, expected, text) => assert.ok(Math.abs(actual - expected) < 1e-9, `${text || 'amount'}: ${actual} is not ${expected}`);
const M = 1e6;

test('a model is priced by its id, whatever snapshot date or mark an engine adds to it', () => {
  assert.match(PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(priceOf('claude-opus-5-5'), { input: 4, output: 20, read: 0.2, write: 5 });
  assert.equal(priceOf('claude-haiku-4-5-20251001').input, 1);
  assert.equal(priceOf('claude-opus-5-5[1m]').output, 20);
  assert.equal(priceOf(' Claude-Sonnet-5-5 ').input, 2);
  // The longest id that fits wins: Fable 5.2 is not Fable 5, GPT-6.1 Sol is not GPT-6 Sol.
  assert.equal(priceOf('claude-fable-5-2').input, 8);
  assert.equal(priceOf('claude-fable-5-20260101').input, 10);
  assert.equal(priceOf('claude-opus-5-20260301').input, 5);
  assert.equal(priceOf('gpt-6.1-sol').read, 0.1);
  assert.equal(priceOf('gpt-6-sol-2026-05-01').read, 0.2);
  for (const unknown of ['', null, 'test-model', 'claude-opus', 'gpt-7']) assert.equal(priceOf(unknown), null, String(unknown));
});

test('a call costs its four kinds of tokens at their prices, and a long prompt its dearer ones', () => {
  near(costOf('claude-opus-5-5', { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 6000, cacheWriteTokens: 2000 }), (1000 * 4 + 500 * 20 + 6000 * 0.2 + 2000 * 5) / M);
  near(costOf('gpt-6.1-sol', { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 6000, cacheWriteTokens: 0 }), (1000 * 2 + 500 * 10 + 6000 * 0.1) / M);
  assert.equal(costOf('claude-opus-5-5', null), null, 'no numbers, no price');
  assert.equal(costOf('test-model', { inputTokens: 10, outputTokens: 10 }), null, 'an unknown model has no price');
  assert.equal(costOf('claude-opus-5-5', { inputTokens: 0, outputTokens: 0 }), 0);
  // Over 272,000 tokens of prompt a GPT call is charged more for all of it; Haiku 5.5 from 100,000.
  near(costOf('gpt-6.1-sol', { inputTokens: 300000, outputTokens: 1000, cacheReadTokens: 0 }), (300000 * 4 + 1000 * 15) / M);
  near(costOf('claude-haiku-5-5', { inputTokens: 90000, outputTokens: 1000 }), (90000 * 0.1 + 1000 * 0.5) / M);
  near(costOf('claude-haiku-5-5', { inputTokens: 20000, outputTokens: 1000, cacheReadTokens: 100000 }), (20000 * 0.5 + 100000 * 0.05 + 1000 * 2.5) / M);
  // A reply of several turns adds its prompts up; the size that counts is one prompt's.
  near(costOf('gpt-6.1-sol', { inputTokens: 300000, outputTokens: 1000 }, 3), (300000 * 2 + 1000 * 10) / M);
});

test('a call on an API key is put down to the key in use, with what it cost', () => {
  const now = clock('2026-11-13T18:00:00Z');
  const { db, repo } = memoryRepo(now);
  const usage = { inputTokens: 100000, outputTokens: 20000, cacheReadTokens: 0, cacheWriteTokens: 0 };   // $0.80 at Opus 5.5 prices
  // No key kept in Settings (the key came from the environment): the cost is still counted.
  near(repo.logUsage({ kind: 'score', provider: 'anthropic-api', model: 'claude-opus-5-5', usage }).cost, 0.8);
  const first = repo.addApiKey({ service: 'anthropic', name: 'School', key: 'sk-ant-api03-school-AAAA1111' }).entry;
  const second = repo.addApiKey({ service: 'anthropic', name: 'Mine', key: 'sk-ant-api03-mine-BBBB2222' }).entry;
  const openai = repo.addApiKey({ service: 'openai', name: '', key: 'sk-proj-openai-CCCC3333' }).entry;
  assert.equal(repo.logUsage({ kind: 'score', provider: 'anthropic-api', model: 'claude-opus-5-5', usage }).keyId, first.id);
  repo.updateApiKey(second.id, { active: true });
  assert.equal(repo.logUsage({ kind: 'assistant', provider: 'anthropic-api', model: 'claude-opus-5-5-20260901', usage, turns: 2 }).keyId, second.id);
  assert.equal(repo.logUsage({ kind: 'score', provider: 'openai-api', model: 'gpt-6.1-sol', usage }).keyId, openai.id);   // $0.40
  // A subscription call is priced for reference and belongs to no key; a model without a price costs nothing known.
  assert.deepEqual(repo.logUsage({ kind: 'score', provider: 'claude-cli', model: 'claude-opus-5-5', usage }).keyId, null);
  assert.equal(repo.logUsage({ kind: 'score', provider: 'anthropic-api', model: 'claude-next', usage }).cost, null);
  assert.equal(repo.logUsage({ kind: 'score', provider: 'codex-cli', model: 'gpt-6.1-sol', usage: null }).cost, null);

  const rows = db.prepare('SELECT provider, key_id, cost_usd FROM ai_usage ORDER BY id').all().map(row => [row.provider, row.key_id, row.cost_usd]);
  assert.deepEqual(rows.map(row => row[1]), [null, first.id, second.id, openai.id, null, second.id, null]);
  assert.deepEqual(rows.map(row => row[2]), [0.8, 0.8, 0.8, 0.4, 0.8, null, null]);

  const spend = repo.usageSpend(now());
  assert.deepEqual(spend.today, { usd: 2.8, calls: 5, unpriced: 1 });
  assert.deepEqual(spend.month, spend.today);
  assert.deepEqual(spend.plan, { usd: 0.8, calls: 2 });
  assert.deepEqual(spend.keys.map(item => [item.name, item.service, item.active, item.monthUsd, item.allowance]),
    [['School', 'anthropic', false, 0.8, null], ['Mine', 'anthropic', true, 0.8, null], ['', 'openai', true, 0.4, null]]);
  assert.equal(spend.otherUsd, 0.8, 'what no kept key paid for');
  assert.equal(JSON.stringify(spend).includes('sk-'), false, 'no key leaves with the sums');
  const totals = repo.usageSummary(now()).today;
  assert.deepEqual([totals.score.costUsd, totals.score.planUsd, totals.score.unpriced, totals.assistant.costUsd], [2, 0.8, 1, 0.8]);
  // A removed key's spending stays in the sums.
  repo.deleteApiKey(first.id);
  const after = repo.usageSpend(now());
  assert.deepEqual([after.month.usd, after.otherUsd, after.keys.length], [2.8, 1.6, 2]);
});

test('spending is summed by the computer\'s own day and month, with a bar for each of the last 30 days', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const now = clock('2026-10-20T20:00:00Z');
    const { repo } = memoryRepo(now);
    const call = dollars => repo.logUsage({ kind: 'score', provider: 'anthropic-api', model: 'claude-opus-5-5', usage: { inputTokens: dollars * 250000, outputTokens: 0 } });
    call(1);                                   // Oct 20
    now.set('2026-11-01T06:30:00Z');           // still Oct 31 in Los Angeles
    call(2);
    now.set('2026-11-01T09:00:00Z');           // Nov 1
    call(4);
    now.set('2026-11-13T07:30:00Z');           // late on Nov 12
    call(8);
    now.set('2026-11-13T18:00:00Z');           // Nov 13
    call(16);
    const spend = repo.usageSpend(now());
    assert.deepEqual([spend.today.usd, spend.month.usd, spend.last30.usd], [16, 28, 31]);
    assert.equal(spend.daily.length, 30);
    assert.deepEqual([spend.daily[0].date, spend.daily.at(-1).date], ['2026-10-15', '2026-11-13']);
    assert.deepEqual(spend.daily.filter(day => day.usd).map(day => [day.date, day.usd]), [['2026-10-20', 1], ['2026-10-31', 2], ['2026-11-01', 4], ['2026-11-12', 8], ['2026-11-13', 16]]);
    assert.deepEqual([spend.pricesAsOf, spend.lowPercent], [PRICES_AS_OF, 15]);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('a key\'s allowance counts down from when it was entered, and says once when it runs low and once when it is used up', () => {
  const now = clock('2026-11-13T18:00:00Z');
  const { repo } = memoryRepo(now);
  const key = repo.addApiKey({ service: 'anthropic', name: 'School', key: 'sk-ant-api03-school-AAAA1111' }).entry;
  const call = dollars => repo.logUsage({ kind: 'score', provider: 'anthropic-api', model: 'claude-opus-5-5', usage: { inputTokens: dollars * 250000, outputTokens: 0 } });
  const left = () => repo.usageSpend(now()).keys[0].allowance;
  assert.equal(call(3).alert, null, 'nothing to say without an allowance');
  assert.equal(left(), null);

  // $10 left on the key as of now: what was spent before does not count against it.
  now.advance(60000);
  repo.updateApiKey(key.id, { allowance: { kind: 'balance', amount: 10 } });
  assert.deepEqual(repo.getApiKey(key.id).allowance, { kind: 'balance', amount: 10, at: '2026-11-13T18:01:00.000Z' });
  assert.deepEqual(left(), { kind: 'balance', amount: 10, at: '2026-11-13T18:01:00.000Z', since: '2026-11-13T18:01:00.000Z', used: 0, left: 10, percent: 100 });
  now.advance(60000);
  assert.equal(call(8).alert, null);
  assert.deepEqual([left().used, left().left, left().percent], [8, 2, 20]);
  assert.deepEqual(call(0.6).alert, { level: 'low', id: key.id, service: 'anthropic', name: 'School', kind: 'balance', left: 1.4, percent: 14 });
  assert.equal(call(0.4).alert, null, 'told once');
  assert.equal(call(1.5).alert.level, 'empty');
  assert.deepEqual([left().left, left().percent], [0, 0]);
  assert.equal(call(1).alert, null);
  // One call can take a key from plenty to nothing: that is the one notice.
  now.advance(60000);
  repo.updateApiKey(key.id, { allowance: { kind: 'balance', amount: 5 } });
  assert.equal(left().percent, 100, 'a new amount starts the count again');
  assert.equal(call(6).alert.level, 'empty');
  // Renaming the key leaves its allowance alone; null stops the count.
  repo.updateApiKey(key.id, { name: 'Uni' });
  assert.equal(repo.getApiKey(key.id).allowance.amount, 5);
  repo.updateApiKey(key.id, { allowance: null });
  assert.equal('allowance' in repo.getApiKey(key.id), false);
  assert.equal(left(), null);

  // A budget for the month counts everything since the first of the month, and starts again with the next one.
  repo.updateApiKey(key.id, { allowance: { kind: 'monthly', amount: 40 } });
  const month = new Date(2026, 10, 1).toISOString();
  assert.deepEqual([left().since, left().used, left().left, left().percent], [month, 20.5, 19.5, 48.8]);
  now.set('2026-12-02T18:00:00Z');
  assert.deepEqual([left().used, left().percent], [0, 100]);
  // The other key of the service is not touched by this one's calls.
  const other = repo.addApiKey({ service: 'anthropic', name: 'Mine', key: 'sk-ant-api03-mine-BBBB2222' }).entry;
  repo.updateApiKey(other.id, { allowance: { kind: 'balance', amount: 1 } });
  assert.equal(call(39).alert.id, key.id);
  assert.equal(repo.usageSpend(now()).keys[1].allowance.percent, 100);
});

test('calls logged before costs were kept are priced once', () => {
  const { db, repo } = memoryRepo();
  const insert = db.prepare('INSERT INTO ai_usage (at, kind, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('2026-10-21T10:00:00.000Z', 'score', 'anthropic-api', 'claude-opus-5-5', 100000, 20000, 0, 0, 1);
  insert.run('2026-10-21T10:01:00.000Z', 'score', 'claude-cli', 'claude-opus-5-5[1m]', 0, 0, 1000000, 0, 2);
  insert.run('2026-10-21T10:02:00.000Z', 'score', 'codex-cli', 'gpt-6.1-sol', null, null, null, null, null);
  insert.run('2026-10-21T10:03:00.000Z', 'score', 'anthropic-api', 'claude-next', 10, 10, 0, 0, 1);
  assert.equal(repo.priceUsage(), 2);
  assert.deepEqual(db.prepare('SELECT cost_usd FROM ai_usage ORDER BY id').all().map(row => row.cost_usd), [0.8, 0.2, null, null]);
  assert.equal(repo.priceUsage(), 0, 'only once');
});

async function start(options = {}) {
  const notes = [];
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: note => notes.push(note), log: () => {},
    detectJobspy: async () => ({ available: false }), ...options });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, call, notes };
}

test('Settings sets a key\'s allowance, GET /api/usage/spend reports it, and a notification says when it runs low', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const usage = { inputTokens: 250000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };   // $1.00 a score
  const provider = id => ({ id, status: async () => ({ available: true, detail: 'test' }),
    score: async () => ({ score: 70, verdict: 'good', summary: 'ok', strengths: [], gaps: [], missingKeywords: [], provider: id, model: 'claude-opus-5-5', usage, turns: 1, chars: 900 }) });
  const { app, call, notes } = await start({ providers: { 'claude-cli': provider('claude-cli'), 'anthropic-api': provider('anthropic-api') } });
  try {
    const empty = (await call('/api/usage/spend')).body;
    assert.deepEqual([empty.month, empty.keys, empty.daily.length, empty.otherUsd], [{ usd: 0, calls: 0, unpriced: 0 }, [], 30, 0]);
    const added = await call('/api/keys', { method: 'POST', body: { service: 'anthropic', name: 'School', key: 'sk-ant-api03-school-AAAA1111' } });
    const id = added.body.keys[0].id;
    for (const allowance of [5, 'ten', {}, { amount: 0 }, { amount: -3 }, { amount: 'x' }, { amount: 2000000 }, { amount: 5, kind: 'weekly' }]) {
      assert.equal((await call(`/api/keys/${id}`, { method: 'PATCH', body: { allowance } })).status, 400, JSON.stringify(allowance));
    }
    const set = await call(`/api/keys/${id}`, { method: 'PATCH', body: { allowance: { amount: 2.204 } } });
    assert.equal(set.status, 200);
    assert.deepEqual([set.body.keys[0].allowance.kind, set.body.keys[0].allowance.amount, 'key' in set.body.keys[0]], ['balance', 2.2, false]);

    await call('/api/settings', { method: 'PATCH', body: { ai: { provider: 'anthropic-api' } } });
    await call('/api/resumes', { method: 'POST', body: { name: 'cv.txt', mime: 'text/plain', data: Buffer.from(`Jane Doe\n${'Python, SQL, forecasting. '.repeat(20)}`).toString('base64') } });
    const score = async number => {
      const posted = await call('/api/postings', { method: 'POST', body: { title: `Analyst ${number}`, company: 'Acme', jobUrl: `https://acme.example/jobs/${number}` } });
      assert.equal((await call(`/api/postings/${posted.body.id}/score`, { method: 'POST', body: {} })).status, 200);
    };
    await score(1);
    assert.equal(notes.length, 0);
    await score(2);
    await score(3);
    assert.deepEqual(notes.map(note => [note.kind, note.refId]), [['spend', id], ['spend', id]]);
    assert.match(notes[0].title, /School/);
    assert.match(notes[0].body, /\$0\.20（9\.1%）/);
    assert.match(notes[1].title, /用完/);

    const spend = (await call('/api/usage/spend')).body;
    assert.deepEqual([spend.today.usd, spend.month.usd, spend.month.calls], [3, 3, 3]);
    assert.deepEqual([spend.keys[0].monthUsd, spend.keys[0].allowance.used, spend.keys[0].allowance.left, spend.keys[0].allowance.percent], [3, 3, 0, 0]);
    assert.equal(spend.daily.at(-1).usd, 3);
    assert.equal((await call('/api/scoring/usage')).body.today.score.costUsd, 3);
    assert.deepEqual((await call('/api/notifications')).body.map(note => [note.kind, note.refId]), [['spend', id], ['spend', id]], 'kept in the app with the other notifications');

    const cleared = await call(`/api/keys/${id}`, { method: 'PATCH', body: { allowance: null } });
    assert.equal('allowance' in cleared.body.keys[0], false);
    assert.equal((await call('/api/usage/spend')).body.keys[0].allowance, null);
  } finally {
    if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    await app.close();
  }
});
