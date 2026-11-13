import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from '../server/app.mjs';
import { createApiEngine } from '../server/assistant/engine-api.mjs';
import { createApiProvider } from '../server/jobs/scoring/anthropic-api.mjs';
import { BAD_KEY, BAD_WORKSPACE, NEEDS_WORKSPACE, WORKSPACE_HEADER, apiDetail, checkKey, clientOptions, keyInUse, keyProblem } from '../server/jobs/scoring/anthropic-key.mjs';

// The API's answers, in the words its documentation gives.
const UNSCOPED = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';
const apiError = (status, message, type = 'invalid_request_error') => Anthropic.APIError.generate(status, { type: 'error', error: { type, message }, request_id: 'req_test' }, message, new Headers());
const unscoped = () => apiError(400, UNSCOPED);
const notAnId = () => apiError(400, 'anthropic-workspace-id header must be a valid workspace ID.');
const noSuchWorkspace = id => apiError(404, `Workspace \`${id}\` not found.`, 'not_found_error');
const HOME = 'wrkspc_01HomeAAAAAAAAAAAAAAAAAA';
const LAB = 'wrkspc_01LabBBBBBBBBBBBBBBBBBBB';

test('a key problem is told apart from every other API error, and the API\'s sentence is read without its JSON', () => {
  assert.equal(keyProblem(unscoped()), 'needs-workspace');
  assert.equal(keyProblem(notAnId()), 'bad-workspace');
  assert.equal(keyProblem(noSuchWorkspace(HOME)), 'bad-workspace');
  assert.equal(keyProblem(apiError(401, 'invalid x-api-key', 'authentication_error')), 'bad-key');
  assert.equal(keyProblem(apiError(404, 'model: claude-nope', 'not_found_error')), null, 'a missing model is not a workspace problem');
  assert.equal(keyProblem(apiError(400, 'max_tokens: must be greater than 0')), null);
  assert.equal(keyProblem(apiError(429, 'slow down', 'rate_limit_error')), null);
  assert.equal(keyProblem(new Error('boom')), null);
  assert.equal(apiDetail(unscoped()), UNSCOPED);
  assert.match(unscoped().message, /^400 \{/, 'the SDK wraps the sentence in the whole body');
  assert.equal(apiDetail(new Error('plain')), 'plain');
});

test('the workspace header goes only with a key that has a workspace', () => {
  assert.deepEqual(clientOptions({ apiKey: 'k', workspace: '' }, { maxRetries: 2 }), { apiKey: 'k', maxRetries: 2 });
  assert.deepEqual(clientOptions({ apiKey: 'k', workspace: HOME }), { apiKey: 'k', defaultHeaders: { [WORKSPACE_HEADER]: HOME } });
  assert.equal(WORKSPACE_HEADER, 'anthropic-workspace-id');
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'from-env';
  try {
    assert.deepEqual(keyInUse({ apiKey: 'saved', workspace: HOME }), { apiKey: 'saved', workspace: HOME });
    assert.deepEqual(keyInUse({ apiKey: '', workspace: HOME }), { apiKey: 'from-env', workspace: '' }, 'a saved workspace does not travel with another key');
  } finally { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; }
});

// A stand-in for the API: a key that works everywhere answers only when told a workspace it knows.
function fakeAccount({ workspaces = [{ id: HOME, name: 'Default', archived_at: null }], scoped = false, valid = true, mayList = true } = {}) {
  const calls = [];
  const createClient = options => {
    const header = options.defaultHeaders?.[WORKSPACE_HEADER];
    return {
      models: { list: async () => {
        calls.push(['models', header ?? null]);
        if (!valid) throw apiError(401, 'invalid x-api-key', 'authentication_error');
        if (scoped) return { data: [] };
        if (!header) throw unscoped();
        if (!workspaces.some(item => item.id === header)) throw noSuchWorkspace(header);
        return { data: [] };
      } },
      beta: { organization: { workspaces: { list(query) {
        calls.push(['workspaces', header ?? null, query]);
        return { async* [Symbol.asyncIterator]() {
          if (!mayList) throw apiError(403, 'not allowed', 'permission_error');
          yield* workspaces;
        } };
      } } } },
    };
  };
  return { calls, createClient };
}

test('a check says whether a key can be used, and finds the workspaces of one that has to be told', async () => {
  assert.deepEqual(await checkKey({ apiKey: 'k' }, fakeAccount({ scoped: true })), { state: 'ok' });
  assert.deepEqual(await checkKey({ apiKey: 'k' }, fakeAccount({ valid: false })), { state: 'bad-key' });

  const everywhere = fakeAccount({ workspaces: [{ id: HOME, name: 'Default', archived_at: null }, { id: LAB, name: 'Lab', archived_at: null }, { id: 'wrkspc_01OldCCCCCCCC', name: 'Old', archived_at: '2026-01-01T00:00:00Z' }] });
  assert.deepEqual(await checkKey({ apiKey: 'k' }, everywhere), { state: 'needs-workspace', workspaces: [{ id: HOME, name: 'Default' }, { id: LAB, name: 'Lab' }] });
  assert.deepEqual(everywhere.calls, [['models', null], ['workspaces', null, { include_default: true, limit: 100 }]], 'the list is asked for without a workspace, the default one included');
  assert.deepEqual(await checkKey({ apiKey: 'k', workspace: LAB }, everywhere), { state: 'ok' });
  assert.deepEqual(await checkKey({ apiKey: 'k', workspace: 'wrkspc_01GoneDDDDDDDD' }, everywhere),
    { state: 'bad-workspace', workspaces: [{ id: HOME, name: 'Default' }, { id: LAB, name: 'Lab' }] });

  assert.deepEqual(await checkKey({ apiKey: 'k' }, fakeAccount({ mayList: false })), { state: 'needs-workspace', workspaces: [] }, 'a key that may not list them still learns what it needs');
  const offline = { createClient: () => ({ models: { list: async () => { throw new Anthropic.APIConnectionError({ message: 'no route' }); } } }) };
  assert.deepEqual(await checkKey({ apiKey: 'k' }, offline), { state: 'offline' });
  const odd = { createClient: () => ({ models: { list: async () => { throw apiError(500, 'Internal server error', 'api_error'); } } }) };
  assert.deepEqual(await checkKey({ apiKey: 'k' }, odd), { state: 'error', detail: 'Internal server error' });
});

test('scoring sends the workspace with the key and names a missing one plainly', async () => {
  const seen = [];
  const answer = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"score":70,"verdict":"good","summary":"ok","strengths":[],"gaps":[],"missing_keywords":[]}' }] };
  const provider = (ai, create = async () => answer) => createApiProvider({ getSettings: () => ({ ai: { provider: 'anthropic-api', model: '', effort: '', language: 'en', ...ai } }),
    createClient: options => { seen.push(options); return { beta: { messages: { create } } }; } });
  await provider({ apiKey: 'sk-ant-usr-test', workspace: HOME }).score({ resume: 'r', posting: { title: 'x' } });
  assert.deepEqual(seen[0].defaultHeaders, { [WORKSPACE_HEADER]: HOME });
  await provider({ apiKey: 'sk-ant-api03-test', workspace: '' }).score({ resume: 'r', posting: { title: 'x' } });
  assert.equal('defaultHeaders' in seen[1], false);

  const failing = error => provider({ apiKey: 'sk-ant-usr-test' }, async () => { throw error; }).score({ resume: 'r', posting: { title: 'x' } }).then(() => null, failure => failure.message);
  assert.equal(await failing(unscoped()), NEEDS_WORKSPACE);
  assert.equal(await failing(noSuchWorkspace(HOME)), BAD_WORKSPACE);
  assert.equal(await failing(apiError(401, 'invalid x-api-key', 'authentication_error')), BAD_KEY);
  assert.equal(await failing(apiError(400, 'max_tokens: must be greater than 0')), 'Claude API error 400: max_tokens: must be greater than 0', 'no JSON around the API\'s sentence');
});

test('the assistant sends the workspace too, and its error says what the key needs', async () => {
  const seen = [];
  const engine = (ai, error) => createApiEngine({ getSettings: () => ({ ai }), createClient: options => {
    seen.push(options);
    return { messages: { stream: () => ({ on() { return this; }, async finalMessage() { if (error) throw error; return { model: 'claude-opus-5-5', usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi.' }] }; } }) } };
  } });
  const send = made => made.send({ id: 'c1', text: 'hi', system: 's', model: '', tools: [], callTool: async () => ({ ok: true, content: '' }), onText() {}, onThinking() {}, onRound() {}, onDiscard() {} });
  await send(engine({ apiKey: 'sk-ant-usr-test', workspace: LAB }));
  assert.deepEqual(seen[0].defaultHeaders, { [WORKSPACE_HEADER]: LAB });
  assert.equal(seen[0].apiKey, 'sk-ant-usr-test');
  const code = async error => send(engine({ apiKey: 'sk-ant-usr-test', workspace: '' }, error)).then(() => null, failure => [failure.code, failure.message]);
  assert.deepEqual(await code(unscoped()), ['needs-workspace', NEEDS_WORKSPACE]);
  assert.deepEqual(await code(notAnId()), ['bad-workspace', BAD_WORKSPACE]);
  assert.deepEqual(await code(apiError(401, 'expired', 'authentication_error')), ['bad-key', BAD_KEY]);
  assert.deepEqual(await code(apiError(400, 'messages: too long')), ['api', 'Claude API error 400: messages: too long']);
});

test('a key keeps its workspace in Settings, and a check fills in the only one there is', async () => {
  const asked = [];
  let account = { [HOME]: 'Default' };
  // What the API would say: this key works everywhere, and knows the workspaces in account.
  const check = async ({ apiKey, workspace }) => {
    asked.push([apiKey, workspace]);
    if (apiKey.startsWith('sk-ant-api03')) return { state: 'ok' };
    if (workspace) return account[workspace] ? { state: 'ok' } : { state: 'bad-workspace', workspaces: Object.entries(account).map(([id, name]) => ({ id, name })) };
    return { state: 'needs-workspace', workspaces: Object.entries(account).map(([id, name]) => ({ id, name })) };
  };
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify() {}, log() {},
    detectJobspy: async () => ({ available: false }), checkKey: check });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const call = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken }), ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const added = await call('/api/keys', { method: 'POST', body: { service: 'anthropic', name: 'Mine', key: 'sk-ant-usr-everywhere-AAAA1111' } });
    assert.equal(added.status, 201);
    const mine = added.body.id;
    assert.equal(added.body.keys.find(item => item.id === mine).name, 'Mine', 'the new key says which one it is');
    assert.equal('workspace' in added.body.keys[0], false);

    // One workspace: it is filled in, and asked about again with it.
    const first = await call(`/api/keys/${mine}/check`, { method: 'POST' });
    assert.deepEqual(first.body.check, { state: 'ok', filled: { id: HOME, name: 'Default' } });
    assert.equal(first.body.keys[0].workspace, HOME);
    assert.deepEqual(asked, [['sk-ant-usr-everywhere-AAAA1111', ''], ['sk-ant-usr-everywhere-AAAA1111', HOME]]);
    assert.deepEqual([app.repo.getSettings().ai.apiKey, app.repo.getSettings().ai.workspace], ['sk-ant-usr-everywhere-AAAA1111', HOME], 'the AI is called with both');
    const shown = (await call('/api/bootstrap')).body.settings;
    assert.equal(shown.ai.workspace, undefined);
    assert.equal(JSON.stringify(shown).includes('everywhere'), false, 'the key itself never comes back');

    // Several: the choice is the user's.
    account = { [HOME]: 'Default', [LAB]: 'Lab' };
    await call(`/api/keys/${mine}`, { method: 'PATCH', body: { workspace: '' } });
    assert.equal(app.repo.getSettings().ai.workspace, '');
    const several = await call(`/api/keys/${mine}/check`, { method: 'POST' });
    assert.deepEqual(several.body.check, { state: 'needs-workspace', workspaces: [{ id: HOME, name: 'Default' }, { id: LAB, name: 'Lab' }] });
    assert.equal('workspace' in several.body.keys[0], false);
    assert.equal((await call(`/api/keys/${mine}`, { method: 'PATCH', body: { workspace: 'Default' } })).status, 400, 'a name is not an ID');
    assert.equal((await call(`/api/keys/${mine}`, { method: 'PATCH', body: { workspace: ` ${LAB} ` } })).body.keys[0].workspace, LAB);
    assert.deepEqual((await call(`/api/keys/${mine}/check`, { method: 'POST' })).body.check, { state: 'ok' });
    // A new key in the same row keeps the workspace it was given.
    assert.equal((await call(`/api/keys/${mine}`, { method: 'PATCH', body: { key: 'sk-ant-usr-everywhere-BBBB2222' } })).body.keys[0].workspace, LAB);

    // Given with the key from the start; never for another service; never through MCP.
    const second = await call('/api/keys', { method: 'POST', body: { service: 'anthropic', key: 'sk-ant-usr-second-CCCC3333', workspace: HOME } });
    assert.equal(second.body.keys.find(item => item.id === second.body.id).workspace, HOME);
    const openai = await call('/api/keys', { method: 'POST', body: { service: 'openai', key: 'sk-proj-openai-DDDD4444', workspace: HOME } });
    assert.equal('workspace' in openai.body.keys.find(item => item.id === openai.body.id), false);
    assert.equal((await call(`/api/keys/${openai.body.id}`, { method: 'PATCH', body: { workspace: HOME } })).status, 400);
    assert.equal((await call(`/api/keys/${openai.body.id}/check`, { method: 'POST' })).status, 400);
    assert.equal((await call(`/api/keys/${mine}/check`, { method: 'POST', headers: { 'x-dayjob-client': 'mcp' } })).status, 403);
    assert.equal((await call('/api/keys/nope/check', { method: 'POST' })).status, 404);
  } finally {
    if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    await app.close();
  }
});
