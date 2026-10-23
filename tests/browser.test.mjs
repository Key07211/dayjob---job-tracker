import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../server/app.mjs';
import { createDayjobServer } from '../integrations/mcp-server.mjs';
import { browserInput } from '../server/validation.mjs';

async function start(browser) {
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')),
    notify: () => {}, log: () => {}, detectJobspy: async () => ({ available: false }), browser });
  const url = await app.listen(0);
  const { csrfToken } = await (await fetch(`${url}/api/bootstrap`)).json();
  const post = async (pathname, body, token = csrfToken) => {
    const response = await fetch(`${url}${pathname}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-dayjob-token': token } });
    return { status: response.status, body: await response.json() };
  };
  return { app, url, post };
}

test('browser requests are checked before they reach the desktop browser', () => {
  assert.deepEqual(browserInput('open', { url: 'https://boards.greenhouse.io/acme/jobs/1' }), { url: 'https://boards.greenhouse.io/acme/jobs/1', newTab: false });
  assert.throws(() => browserInput('open', { url: 'file:///C:/Users/me/resume.pdf' }), /http/);
  assert.throws(() => browserInput('open', { url: 'https://user:pass@example.com' }), /http/);
  assert.deepEqual(browserInput('read', {}), { query: '', maxChars: 15000 });
  assert.throws(() => browserInput('read', { maxChars: 10 }), /maxChars/);
  assert.throws(() => browserInput('click', { ref: 'button.submit' }), /e12/);
  assert.deepEqual(browserInput('type', { ref: 'e3', text: '  leading spaces stay ' }), { ref: 'e3', text: '  leading spaces stay ', append: false, pressEnter: false });
  assert.throws(() => browserInput('type', { ref: 'e3', text: 'x'.repeat(10001) }), /10000/);
  assert.throws(() => browserInput('key', { key: 'F12' }), /key must be one of/);
  assert.deepEqual(browserInput('scroll', {}), { direction: 'down', ref: null });
  assert.deepEqual(browserInput('tabs', {}), { action: 'list', tabId: null });
  assert.throws(() => browserInput('tabs', { action: 'close' }), /tabId/);
});

test('the browser API needs the desktop app, the write token and a known action', async () => {
  const plain = await start(undefined);
  try {
    const missing = await plain.post('/api/browser/read', {});
    assert.equal(missing.status, 503);
    assert.match(missing.body.error, /desktop app/);
  } finally { await plain.app.close(); }

  const calls = [];
  const browser = { run: async (action, input) => {
    calls.push([action, input]);
    if (action === 'click') throw Object.assign(new Error('The user declined this in Dayjob, so nothing happened.'), { status: 409 });
    if (action === 'scroll') throw new Error('boom');
    return { page: { id: 'tab-1', url: 'https://example.com/' } };
  } };
  const { app, post } = await start(browser);
  try {
    assert.equal((await post('/api/browser/read', {}, 'wrong')).status, 403);
    assert.equal((await post('/api/browser/eval', {})).status, 404);
    assert.equal((await post('/api/browser/open', { url: 'javascript:alert(1)' })).status, 400);
    assert.equal(calls.length, 0, 'nothing invalid reaches the browser');
    const opened = await post('/api/browser/open', { url: 'https://example.com/', newTab: true });
    assert.equal(opened.status, 200);
    assert.deepEqual(calls[0], ['open', { url: 'https://example.com/', newTab: true }]);
    const declined = await post('/api/browser/click', { ref: 'e4' });
    assert.deepEqual([declined.status, declined.body.error], [409, 'The user declined this in Dayjob, so nothing happened.']);
    const broken = await post('/api/browser/scroll', {});
    assert.deepEqual([broken.status, broken.body.error], [500, 'The Dayjob browser failed: boom']);
  } finally { await app.close(); }
});

test('Claude drives the Dayjob browser through MCP, screenshots included', async () => {
  const calls = [];
  const browser = { run: async (action, input) => {
    calls.push([action, input]);
    if (action === 'screenshot') return { image: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg', page: { id: 'tab-1' } };
    if (action === 'read') return { page: { id: 'tab-1' }, text: 'Data Analyst', elements: [{ ref: 'e1', role: 'button', name: 'Submit application' }] };
    return { page: { id: 'tab-1' } };
  } };
  const { app, url } = await start(browser);
  const server = createDayjobServer({ baseUrl: url });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name).filter(name => name.startsWith('dayjob_browser_'));
    assert.deepEqual(names, ['dayjob_browser_open', 'dayjob_browser_read', 'dayjob_browser_screenshot', 'dayjob_browser_click', 'dayjob_browser_type',
      'dayjob_browser_select', 'dayjob_browser_press_key', 'dayjob_browser_scroll', 'dayjob_browser_navigate', 'dayjob_browser_tabs']);
    assert.ok(tools.find(tool => tool.name === 'dayjob_browser_read').annotations.readOnlyHint);
    const read = await client.callTool({ name: 'dayjob_browser_read', arguments: { query: 'submit' } });
    assert.equal(JSON.parse(read.content[0].text).elements[0].ref, 'e1');
    const shot = await client.callTool({ name: 'dayjob_browser_screenshot', arguments: {} });
    assert.deepEqual(shot.content[0], { type: 'image', data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg' });
    await client.callTool({ name: 'dayjob_browser_press_key', arguments: { key: 'Escape' } });
    const bad = await client.callTool({ name: 'dayjob_browser_click', arguments: { ref: '#submit' } });
    assert.ok(bad.isError);
    assert.deepEqual(calls.map(([action]) => action), ['read', 'screenshot', 'key']);
    assert.deepEqual(calls[0][1], { query: 'submit', maxChars: 15000 });
  } finally {
    await client.close();
    await app.close();
  }
});
