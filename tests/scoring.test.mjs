import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { memoryRepo } from './helpers.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { buildUserPrompt, normalizeScore, parseScoreText, SCORE_SCHEMA } from '../server/jobs/scoring/prompt.mjs';
import { claudeCandidates, cliArgs, createClaudeCliProvider, detectClaude, parseCliOutput, stopProcess } from '../server/jobs/scoring/claude-cli.mjs';
import { apiRequest, createApiProvider } from '../server/jobs/scoring/anthropic-api.mjs';
import { codexArgs, codexCandidates, createCodexCliProvider } from '../server/jobs/scoring/codex-cli.mjs';
import { createOpenAiProvider, openAiRequest } from '../server/jobs/scoring/openai-api.mjs';
import { PROVIDERS, effortFor, modelInfo } from '../server/jobs/scoring/models.mjs';
import { createScorer } from '../server/jobs/scoring/index.mjs';

const RESULT = { score: 78, verdict: 'good', summary: '匹配大部分要求。', strengths: ['Python'], gaps: ['No Spark'], missing_keywords: ['Spark'] };
const settings = (ai = {}) => () => ({ ai: { provider: 'claude-cli', claudeCommand: '', codexCommand: '', model: '', apiKey: '', openaiApiKey: '', language: 'zh', maxPerRun: 40, effort: 'medium', ...ai } });

test('score replies are validated and clamped', () => {
  assert.deepEqual(normalizeScore(RESULT), { score: 78, verdict: 'good', summary: '匹配大部分要求。', strengths: ['Python'], gaps: ['No Spark'], missingKeywords: ['Spark'] });
  assert.equal(normalizeScore({ score: 140, summary: 'x' }).score, 100);
  assert.equal(normalizeScore({ score: '30' }).verdict, 'weak');
  assert.throws(() => normalizeScore({ score: 'high' }), /numeric/);
  assert.equal(parseScoreText(`Here you go:\n\`\`\`json\n${JSON.stringify(RESULT)}\n\`\`\``).score, 78);
  assert.throws(() => parseScoreText('no json here'), /JSON/);
  assert.equal(SCORE_SCHEMA.additionalProperties, false);
  const prompt = buildUserPrompt({ resume: 'R'.repeat(30000), posting: { title: 'DS', company: 'Acme', description: null }, language: 'en' });
  assert.match(prompt, /<resume>/);
  assert.match(prompt, /no description/);
  assert.match(prompt, /in English/);
  assert.ok(prompt.length < 26000, 'long resumes are trimmed');
});

test('Claude Code output envelopes', () => {
  assert.equal(parseCliOutput(JSON.stringify({ type: 'result', is_error: false, structured_output: RESULT, result: '', modelUsage: { 'claude-opus-5-5': {} } })).model, 'claude-opus-5-5');
  assert.equal(parseCliOutput(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(RESULT) })).value.score, 78);
  assert.equal(parseCliOutput(JSON.stringify([{ type: 'system' }, { type: 'result', result: JSON.stringify(RESULT) }])).value.score, 78);
  assert.throws(() => parseCliOutput(JSON.stringify({ is_error: true, result: 'Not logged in' })), /Not logged in/);
  assert.ok(cliArgs({}).includes('--json-schema'));
  assert.ok(!cliArgs({ shell: true }).includes('--system-prompt'), 'cmd shims never get long arguments');
  assert.deepEqual(cliArgs({ shell: true, basic: true, model: 'bad model; rm' }), ['-p', '--output-format', 'json']);
  assert.ok(claudeCandidates('', { USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32').includes('C:\\Users\\me\\.local\\bin\\claude.exe'));
});

test('Claude Code detection skips missing absolute paths', async () => {
  const seen = [];
  const run = (command, _args, _options, done) => { seen.push(command); done(command === 'claude' ? null : new Error('nope'), '2.1.0 (Claude Code)'); };
  const found = await detectClaude('/missing/claude', { run, exists: () => false, env: { HOME: '/home/me' }, platform: 'linux' });
  assert.deepEqual(found, { available: true, command: 'claude', version: '2.1.0 (Claude Code)' });
  assert.ok(!seen.includes('/missing/claude'));
});

function fakeSpawn(replies) {
  const calls = [];
  const spawn = (command, args, options) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)];
    let stdin = '';
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({ write(chunk, _encoding, done) { stdin += chunk; done(); } });
    child.stdin.on('finish', () => {
      const files = Object.fromEntries(fs.readdirSync(options.cwd).map(name => [name, fs.readFileSync(path.join(options.cwd, name), 'utf8')]));
      if (reply.file) fs.writeFileSync(path.join(options.cwd, 'reply.txt'), reply.file);
      calls.push({ command, args, options, stdin, files });
      setImmediate(() => { child.stdout.end(reply.stdout || ''); child.stderr.end(reply.stderr || ''); setImmediate(() => child.emit('close', reply.code ?? 0)); });
    });
    return child;
  };
  return { spawn, calls };
}

test('Claude Code provider sends the prompt over stdin from an empty folder', async () => {
  const { spawn, calls } = fakeSpawn([{ stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: RESULT }) }]);
  const provider = createClaudeCliProvider({ getSettings: settings(), spawn, detect: async () => ({ available: true, command: 'claude', version: 'x' }) });
  const result = await provider.score({ resume: 'My resume', posting: { title: 'DS', company: 'Acme', description: 'Python' } });
  assert.equal(result.score, 78);
  assert.equal(result.provider, 'claude-cli');
  assert.match(calls[0].stdin, /My resume/);
  assert.ok(calls[0].args.includes('--tools'));
  assert.equal(calls[0].options.shell, false);
  assert.equal(fs.existsSync(calls[0].options.cwd), false, 'the temporary folder is removed');
});

test('Claude Code provider falls back for older CLIs and reports failures', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 1, stderr: "error: unknown option '--json-schema'" }, { stdout: JSON.stringify({ result: JSON.stringify(RESULT) }) }]);
  const provider = createClaudeCliProvider({ getSettings: settings(), spawn, detect: async () => ({ available: true, command: 'claude', version: 'x' }) });
  assert.equal((await provider.score({ resume: 'r', posting: { title: 'x' } })).score, 78);
  assert.deepEqual(calls[1].args, ['-p', '--output-format', 'json']);
  assert.match(calls[1].stdin, /career advisor/, 'the system prompt moves into stdin');

  const shim = fakeSpawn([{ stdout: JSON.stringify({ result: JSON.stringify(RESULT) }) }]);
  const viaCmd = createClaudeCliProvider({ getSettings: settings(), spawn: shim.spawn, detect: async () => ({ available: true, command: 'C:\\npm\\claude.cmd', version: 'x' }) });
  await viaCmd.score({ resume: 'r', posting: { title: 'x' } });
  assert.equal(shim.calls[0].options.shell, true);
  assert.ok(shim.calls[0].args.every(arg => !/\s/.test(arg)), 'no argument needs quoting for cmd.exe');

  const failing = fakeSpawn([{ code: 1, stderr: 'Invalid API key · Please run /login' }]);
  const broken = createClaudeCliProvider({ getSettings: settings(), spawn: failing.spawn, detect: async () => ({ available: true, command: 'claude', version: 'x' }) });
  await assert.rejects(broken.score({ resume: 'r', posting: { title: 'x' } }), /not signed in/);
  assert.equal((await broken.status()).available, false);
  assert.equal((await broken.status(true)).available, true);
  const missing = createClaudeCliProvider({ getSettings: settings(), detect: async () => ({ available: false }) });
  assert.equal((await missing.status()).available, false);
  await assert.rejects(missing.score({ resume: 'r', posting: { title: 'x' } }), /Claude Code was not found/);
});

test('Claude API provider uses structured output with server-side fallback', async () => {
  let request;
  const createClient = () => ({ beta: { messages: { create: async body => { request = body; return { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(RESULT) }] }; } } } });
  const provider = createApiProvider({ getSettings: settings({ provider: 'anthropic-api', apiKey: 'sk-test', effort: 'low' }), createClient });
  const result = await provider.score({ resume: 'r', posting: { title: 'DS' } });
  assert.equal(result.score, 78);
  assert.equal(request.model, 'claude-opus-5-5');
  assert.deepEqual(request.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(request.fallbacks, 'default');
  assert.equal(request.output_config.effort, 'low');
  assert.equal(request.output_config.format.type, 'json_schema');

  const refusing = createApiProvider({ getSettings: settings({ apiKey: 'k' }), createClient: () => ({ beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } }) });
  await assert.rejects(refusing.score({ resume: 'r', posting: { title: 'x' } }), /declined/);
  const unauthorized = createApiProvider({ getSettings: settings({ apiKey: 'k' }), createClient: () => ({ beta: { messages: { create: async () => {
    throw new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
  } } } }) });
  await assert.rejects(unauthorized.score({ resume: 'r', posting: { title: 'x' } }), /API key was rejected/);
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(createApiProvider({ getSettings: settings() }).status().available, false);
  if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
});

test('the model list knows which efforts each model takes', () => {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    assert.ok(!provider.defaultModel || provider.models.some(item => item.id === provider.defaultModel), `${id} defaults to a listed model`);
    assert.equal(new Set(provider.models.map(item => item.id)).size, provider.models.length);
  }
  assert.equal(effortFor('anthropic-api', '', 'max'), 'max', 'Claude Opus 5.5 takes every level');
  assert.equal(effortFor('anthropic-api', 'claude-opus-4-6', 'xhigh'), '', 'a level the model lacks becomes its default');
  assert.equal(effortFor('claude-cli', 'claude-haiku-4-5', 'low'), '');
  assert.equal(effortFor('openai-api', 'gpt-5-mini', 'max'), '');
  assert.equal(effortFor('codex-cli', '', 'high'), 'high', 'the CLI\'s own model is left to accept or refuse');
  assert.equal(effortFor('openai-api', 'gpt-7-preview', 'max'), 'max', 'typed-in ids pass through');
  assert.equal(effortFor('claude-cli', 'claude-opus-5-5', ''), '');
  assert.equal(modelInfo('codex-cli', 'gpt-6-luna').name, 'GPT-6 Luna');
});

test('Claude Code gets the chosen model and effort', async () => {
  assert.deepEqual(cliArgs({ model: 'claude-sonnet-5-5', effort: 'high' }).slice(-4), ['--effort', 'high', '--model', 'claude-sonnet-5-5']);
  assert.ok(!cliArgs({ basic: true, effort: 'high' }).includes('--effort'), 'older releases get no --effort');
  const { spawn, calls } = fakeSpawn([{ stdout: JSON.stringify({ result: JSON.stringify(RESULT) }) }]);
  const haiku = createClaudeCliProvider({ getSettings: settings({ model: 'claude-haiku-4-5', effort: 'high' }), spawn, detect: async () => ({ available: true, command: 'claude', version: 'x' }) });
  await haiku.score({ resume: 'r', posting: { title: 'x' } });
  assert.ok(!calls[0].args.includes('--effort'), 'Haiku 4.5 has no effort setting');
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'claude-haiku-4-5');
  assert.match((await haiku.status()).detail, /claude-haiku-4-5/);
});

test('Claude API requests follow the chosen model', () => {
  const base = { system: 's', prompt: 'p', schema: SCORE_SCHEMA };
  const opus = apiRequest({ ai: { model: '', effort: '' }, ...base });
  assert.equal(opus.model, 'claude-opus-5-5');
  assert.equal(opus.output_config.effort, undefined, 'no effort sent means the model default');
  assert.equal(opus.fallbacks, 'default');
  const deep = apiRequest({ ai: { model: 'claude-fable-5-1', effort: 'max' }, ...base });
  assert.deepEqual([deep.output_config.effort, deep.max_tokens], ['max', 32000]);
  const haiku = apiRequest({ ai: { model: 'claude-haiku-5-5', effort: 'low' }, ...base });
  assert.equal(haiku.fallbacks, undefined, 'Haiku 5.5 has no server-side fallback');
  assert.equal(haiku.betas, undefined);
  assert.equal(haiku.output_config.effort, 'low');
  assert.equal(apiRequest({ ai: { model: 'claude-haiku-4-5', effort: 'high' }, ...base }).output_config.effort, undefined);
});

test('Codex scores through codex exec with the schema in its folder', async () => {
  const args = codexArgs({ model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(args.slice(0, 4), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only']);
  assert.deepEqual(args.slice(-5), ['--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-']);
  assert.ok(args.every(arg => !/\s/.test(arg)), 'no argument needs quoting for cmd.exe');
  assert.ok(codexCandidates('', { USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32').includes('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'));

  const run = (_command, _args, _options, done) => done(null, 'Logged in using ChatGPT', '');
  const { spawn, calls } = fakeSpawn([{ stdout: 'working…', file: `\`\`\`json\n${JSON.stringify(RESULT)}\n\`\`\`` }]);
  const provider = createCodexCliProvider({ getSettings: settings({ provider: 'codex-cli', model: 'gpt-6-luna', effort: 'xhigh' }), spawn, run,
    detect: async () => ({ available: true, command: 'C:\\npm\\codex.cmd', version: 'codex-cli 0.60.1' }) });
  assert.equal((await provider.status()).detail, 'Codex 0.60.1 · gpt-6-luna');
  const result = await provider.score({ resume: 'My resume', posting: { title: 'DS', company: 'Acme', description: 'Python' } });
  assert.deepEqual([result.score, result.provider, result.model], [78, 'codex-cli', 'gpt-6-luna']);
  assert.match(calls[0].stdin, /career advisor[\s\S]*Do not run commands[\s\S]*My resume/);
  assert.deepEqual(JSON.parse(calls[0].files['schema.json']), SCORE_SCHEMA);
  assert.equal(calls[0].options.shell, true);
  assert.ok(calls[0].args.includes('model_reasoning_effort=xhigh'));
  assert.equal(fs.existsSync(calls[0].options.cwd), false, 'the temporary folder is removed');
});

test('Codex falls back for older releases and reports a missing sign-in', async () => {
  const detect = async () => ({ available: true, command: 'codex', version: 'codex-cli 0.30.0' });
  const ok = (_command, _args, _options, done) => done(null, 'Logged in', '');
  const older = fakeSpawn([{ code: 2, stderr: "error: unexpected argument '--ignore-user-config' found" }, { file: JSON.stringify(RESULT) }]);
  const provider = createCodexCliProvider({ getSettings: settings({ provider: 'codex-cli' }), spawn: older.spawn, run: ok, detect });
  assert.equal((await provider.score({ resume: 'r', posting: { title: 'x' } })).score, 78);
  assert.ok(!older.calls[1].args.includes('--ignore-user-config'));
  assert.ok(!older.calls[0].args.includes('--model'), 'no model chosen leaves Codex on its own');

  const signedOut = fakeSpawn([{ code: 1, stderr: 'Error: Not logged in. Run `codex login` first.' }]);
  const broken = createCodexCliProvider({ getSettings: settings({ provider: 'codex-cli' }), spawn: signedOut.spawn, run: ok, detect });
  await assert.rejects(broken.score({ resume: 'r', posting: { title: 'x' } }), /Codex is not signed in/);
  assert.equal((await broken.status()).available, false);

  const loggedOut = (_command, _args, _options, done) => done(Object.assign(new Error('exit 1'), { code: 1 }), '', 'Not logged in');
  const checked = createCodexCliProvider({ getSettings: settings({ provider: 'codex-cli' }), spawn: signedOut.spawn, run: loggedOut, detect });
  assert.match((await checked.status()).detail, /not signed in/, '`codex login status` is checked up front');
  const missing = createCodexCliProvider({ getSettings: settings({ provider: 'codex-cli' }), detect: async () => ({ available: false }) });
  await assert.rejects(missing.score({ resume: 'r', posting: { title: 'x' } }), /Codex was not found/);
});

test('OpenAI API provider uses strict structured output on the Responses API', async () => {
  let sent;
  const reply = (status, body) => ({ ok: status < 400, status, statusText: '', json: async () => body });
  const fetch = async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return reply(200, { model: 'gpt-6.1-sol-2026-09-29', status: 'completed', output: [{ type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(RESULT) }] }] });
  };
  const provider = createOpenAiProvider({ getSettings: settings({ provider: 'openai-api', openaiApiKey: 'sk-test', effort: 'high' }), fetch });
  const result = await provider.score({ resume: 'r', posting: { title: 'DS' } });
  assert.deepEqual([result.score, result.provider, result.model], [78, 'openai-api', 'gpt-6.1-sol-2026-09-29']);
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent.options.headers.authorization, 'Bearer sk-test');
  assert.deepEqual([sent.body.model, sent.body.reasoning, sent.body.store], ['gpt-6.1-sol', { effort: 'high' }, false]);
  assert.match(sent.body.instructions, /career advisor/);
  assert.equal(sent.body.text.format.strict, true);
  assert.equal(openAiRequest({ ai: { model: 'gpt-5-mini', effort: 'max' }, system: 's', prompt: 'p', schema: SCORE_SCHEMA }).reasoning, undefined);

  const failing = body => createOpenAiProvider({ getSettings: settings({ openaiApiKey: 'k' }), fetch: async () => body });
  await assert.rejects(failing(reply(401, { error: { message: 'Incorrect API key' } })).score({ resume: 'r', posting: { title: 'x' } }), /OpenAI API key was rejected/);
  await assert.rejects(failing(reply(400, { error: { message: 'Unsupported value' } })).score({ resume: 'r', posting: { title: 'x' } }), /OpenAI API error 400: Unsupported value/);
  await assert.rejects(failing(reply(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })).score({ resume: 'r', posting: { title: 'x' } }), /declined/);
  await assert.rejects(failing(reply(200, { status: 'incomplete', output: [] })).score({ resume: 'r', posting: { title: 'x' } }), /cut off/);
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assert.equal(createOpenAiProvider({ getSettings: settings() }).status().available, false);
  if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
});

test('the scorer stores results and stops a batch on a provider-wide failure', async () => {
  const { repo } = memoryRepo();
  for (const id of ['1', '2', '3']) repo.upsertPosting(posting({ site: 'linkedin', externalId: id, title: `Job ${id}`, company: 'Acme', jobUrl: `https://www.linkedin.com/jobs/view/${id}` }));
  let calls = 0;
  const provider = { id: 'claude-cli', status: async () => ({ available: true, detail: 'ok' }),
    score: async ({ posting: item }) => { calls += 1; if (item.title === 'Job 2') throw new Error('Claude Code was not found.'); return { ...normalizeScore(RESULT), provider: 'claude-cli' }; } };
  const scorer = createScorer({ repo, providers: { 'claude-cli': provider }, log: () => {} });
  assert.equal((await scorer.scoreBatch()).reason, 'no-resume');
  repo.addResume({ name: 'r', mime: 'text/plain', size: 1, text: 'resume' });
  const result = await scorer.scoreBatch(['li-1', 'li-2', 'li-3']);
  assert.equal(result.scored, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(calls, 2);
  assert.equal(repo.getPosting('li-1').score.score, 78);
  const again = await scorer.score('li-1');
  assert.equal(again.score, 78);
  assert.equal(calls, 2, 'an existing score is reused unless forced');
});

test('a batch reports postings that could not be scored', async () => {
  const { repo } = memoryRepo();
  for (const id of ['1', '2']) repo.upsertPosting(posting({ site: 'linkedin', externalId: id, title: `Job ${id}`, company: 'Acme', jobUrl: `https://www.linkedin.com/jobs/view/${id}` }));
  repo.addResume({ name: 'r.txt', mime: 'text/plain', size: 10, text: 'resume' });
  const provider = { id: 'claude-cli', status: async () => ({ available: true, detail: 'ok' }),
    score: async ({ posting: item }) => { if (item.title === 'Job 2') throw new Error('The AI reply did not contain JSON.'); return { ...normalizeScore(RESULT), provider: 'claude-cli' }; } };
  const scorer = createScorer({ repo, providers: { 'claude-cli': provider }, log: () => {} });
  const result = await scorer.scoreBatch(null, { limit: 5 });
  assert.equal(result.scored, 1);
  assert.equal(result.failed, 1);
  assert.match(result.reason, /1 of 2 could not be scored: The AI reply did not contain JSON/);
});

test('pausing stops the posting being scored and holds the rest until resumed, across restarts', async () => {
  const { repo } = memoryRepo();
  for (const id of ['1', '2', '3']) repo.upsertPosting(posting({ site: 'linkedin', externalId: id, title: `Job ${id}`, company: `Acme ${id}`, jobUrl: `https://www.linkedin.com/jobs/view/${id}` }));
  repo.addResume({ name: 'r', mime: 'text/plain', size: 1, text: 'resume' });
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const scoredIds = [];
  let first = true;
  // The first call hangs until it is aborted; every later one answers.
  const provider = { id: 'claude-cli', status: async () => ({ available: true, detail: 'ok' }),
    score: ({ posting: item, signal }) => new Promise((resolve, reject) => {
      if (!first) { scoredIds.push(item.title); resolve({ ...normalizeScore(RESULT), provider: 'claude-cli' }); return; }
      first = false;
      started();
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) };
  const scorer = createScorer({ repo, providers: { 'claude-cli': provider }, log: () => {} });
  const batch = scorer.scoreBatch(['li-1', 'li-2', 'li-3']);
  await running;
  assert.deepEqual((await scorer.status()).progress, { done: 0, total: 3 });
  assert.deepEqual(scorer.pause(), { paused: true, held: 0 });
  const result = await batch;
  assert.equal(result.paused, true);
  assert.equal(result.scored, 0);
  assert.deepEqual(await scorer.status().then(state => [state.paused, state.held, state.progress]), [true, 3, null]);

  // While paused, new work waits too: a batch is held at once and a single job is refused.
  assert.equal((await scorer.scoreBatch(['li-2'])).paused, true);
  await assert.rejects(scorer.score('li-1'), error => error.status === 409 && /paused/.test(error.message));
  assert.equal(repo.getPosting('li-1').score, null);

  // Dayjob restarts paused, with the same jobs waiting.
  const restarted = createScorer({ repo, providers: { 'claude-cli': provider }, log: () => {} });
  assert.deepEqual(await restarted.status().then(state => [state.paused, state.held]), [true, 3]);
  repo.setPostingStatus('li-3', 'dismissed');
  const ids = await restarted.resume();
  assert.deepEqual(ids, ['li-1', 'li-2'], 'a job dismissed meanwhile is not scored');
  assert.equal((await restarted.status()).paused, false);
  assert.equal(repo.getMeta('scoringPaused'), null);
  assert.equal((await restarted.scoreBatch(ids)).scored, 2);
  assert.deepEqual(scoredIds, ['Job 1', 'Job 2']);
});

test('pausing kills the running Claude Code process', async () => {
  const stopped = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    return child;
  };
  // A child of the stopped process can hold the output open; the score still ends now.
  const stop = child => { stopped.push(child); };
  const provider = createClaudeCliProvider({ getSettings: settings(), spawn, stop, detect: async () => ({ available: true, command: 'claude', version: 'x' }) });
  const controller = new AbortController();
  const scoring = provider.score({ resume: 'r', posting: { title: 'x' }, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(scoring);
  assert.equal(stopped.length, 1);
  await assert.rejects(provider.score({ resume: 'r', posting: { title: 'x' }, signal: controller.signal }), 'an aborted signal never starts Claude Code');
  assert.equal(stopped.length, 1);
  const runs = [];
  stopProcess({ pid: 42, kill: () => runs.push('kill') }, { platform: 'win32', run: (command, args) => runs.push([command, ...args]) });
  stopProcess({ pid: 43, kill: () => runs.push('kill') }, { platform: 'linux' });
  assert.deepEqual(runs, [['taskkill', '/pid', '42', '/T', '/F'], 'kill'], 'on Windows the cmd.exe shim and Claude Code under it both go');
});
