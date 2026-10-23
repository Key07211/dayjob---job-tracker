import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../server/app.mjs';
import { createDayjobServer, localBaseUrl } from '../integrations/mcp-server.mjs';
import { extractResumeText } from '../server/jobs/resume.mjs';
import { fakeHttp, fixture } from './helpers.mjs';

const RESUME = `Jane Doe — Data Scientist\n${'Python, SQL, PyTorch, experimentation, forecasting. '.repeat(12)}`;

function makePdf(text) {
  // One line per ~80 characters: text outside the page is not extracted.
  const lines = text.match(/.{1,80}(\s|$)/g).map(line => `(${line.trim().replace(/[()\\]/g, '\\$&')}) Tj T*`);
  const stream = `BT /F1 11 Tf 14 TL 72 740 Td ${lines.join(' ')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => { const offset = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function makeDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function start(options = {}) {
  const distDir = options.distDir || fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-'));
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir, notify: () => {}, log: () => {},
    detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }),
      score: async () => ({ score: 70, verdict: 'good', summary: 'ok', strengths: [], gaps: [], missingKeywords: [], provider: 'claude-cli' }) } },
    ...options });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const call = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken }), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  };
  return { app, url, boot, call, distDir };
}

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({ host: target.hostname, port: target.port, path: target.pathname, headers }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

test('the local server only answers this machine and its own pages', async () => {
  const { app, url, call } = await start();
  try {
    assert.equal(await rawRequest(`${url}/api/status`, { host: 'evil.example' }), 403, 'DNS rebinding is refused');
    assert.equal((await call('/api/status', { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/api/settings', { method: 'PATCH', body: { retentionDays: 30 }, headers: { 'x-dayjob-token': 'wrong' } })).status, 403);
    const frontend = await fetch(`${url}/applications`);
    assert.equal(frontend.status, 503, 'no build yet');
  } finally { await app.close(); }
});

test('the built interface is served with a strict policy', async () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Dayjob</title>');
  const { app, url } = await start({ distDir });
  try {
    const page = await fetch(`${url}/saved`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`${url}/missing.js`)).status, 404);
    assert.equal((await fetch(`${url}/..%2f..%2fetc%2fpasswd`)).status, 403);
  } finally { await app.close(); }
});

test('settings and searches are validated; the API key never comes back', async () => {
  const { app, call, boot } = await start();
  try {
    assert.equal(boot.settings.ai.apiKey, undefined);
    assert.equal((await call('/api/settings', { method: 'PATCH', body: { schedule: { time: '25:00' } } })).status, 400);
    assert.equal((await call('/api/settings', { method: 'PATCH', body: { ai: { provider: 'gpt' } } })).status, 400);
    const saved = await call('/api/settings', { method: 'PATCH', body: { ai: { apiKey: 'sk-secret', model: 'claude-opus-5-5' }, schedule: { time: '7:05' } } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ai.hasApiKey, true);
    assert.equal(saved.body.schedule.time, '07:05');
    assert.ok(!JSON.stringify(saved.body).includes('sk-secret'));
    assert.ok(!JSON.stringify((await call('/api/bootstrap')).body).includes('sk-secret'));
    assert.equal((await call('/api/settings', { method: 'PATCH', body: { ai: { apiKey: null } } })).body.ai.hasApiKey, false);

    assert.equal((await call('/api/searches', { method: 'POST', body: { keywords: 'data', sites: [] } })).status, 400);
    assert.equal((await call('/api/searches', { method: 'POST', body: { keywords: 'data', sites: ['monster'] } })).status, 400);
    const created = await call('/api/searches', { method: 'POST', body: { keywords: 'data scientist', sites: ['linkedin'], excludeKeywords: 'senior, staff' } });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.excludeKeywords, ['senior', 'staff']);
    const patched = await call(`/api/searches/${created.body.id}`, { method: 'PATCH', body: { enabled: false } });
    assert.equal(patched.body.enabled, false);
    assert.equal(patched.body.keywords, 'data scientist');
    assert.equal((await call(`/api/searches/${created.body.id}`, { method: 'DELETE' })).body.ok, true);
  } finally { await app.close(); }
});

test('saving a job scores it only when the user chose to score saved jobs', async () => {
  const scored = [];
  const { app, call } = await start({ providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }),
    score: async ({ posting }) => {
      scored.push(posting.title);
      return { score: 70, verdict: 'good', summary: 'ok', strengths: [], gaps: [], missingKeywords: [], provider: 'claude-cli' };
    } } } });
  const add = title => call('/api/postings', { method: 'POST', body: { title, company: 'Acme', jobUrl: `https://acme.example/jobs/${title.length}` } });
  const settle = () => app.scorer.score('none').catch(() => {});
  try {
    assert.equal((await call('/api/settings', { method: 'PATCH', body: { ai: { scoreMode: 'sometimes' } } })).status, 400);
    await call('/api/resumes', { method: 'POST', body: { name: 'cv.txt', mime: 'text/plain', data: Buffer.from(RESUME).toString('base64') } });
    const first = await add('Data Analyst');
    await call(`/api/postings/${first.body.id}`, { method: 'PATCH', body: { status: 'saved' } });
    await settle();
    assert.deepEqual(scored, [], 'the default mode leaves scoring to the daily run');

    const mode = await call('/api/settings', { method: 'PATCH', body: { ai: { scoreMode: 'saved' } } });
    assert.equal(mode.body.ai.scoreMode, 'saved');
    assert.equal((await call('/api/scoring/status')).body.mode, 'saved');
    const second = await add('Data Scientist');
    await call(`/api/postings/${second.body.id}`, { method: 'PATCH', body: { status: 'saved' } });
    await call('/api/postings', { method: 'POST', body: { title: 'ML Engineer', company: 'Acme', jobUrl: 'https://acme.example/jobs/ml', status: 'saved' } });
    await settle();
    assert.deepEqual(scored, ['Data Scientist', 'ML Engineer'], 'saving, in the app or from the browser, scores the job');
    const again = await call(`/api/postings/${second.body.id}/score`, { method: 'POST', body: {} });
    assert.equal(again.body.score.score, 70);
    assert.equal(scored.length, 2, 'the app waiting for that score does not score it twice');

    await call('/api/settings', { method: 'PATCH', body: { ai: { scoreMode: 'manual' } } });
    const third = await add('Analytics Engineer');
    await call(`/api/postings/${third.body.id}`, { method: 'PATCH', body: { status: 'saved' } });
    await settle();
    assert.equal(scored.length, 2);
  } finally { await app.close(); }
});

test('resumes are read from PDF, Word and text files', async () => {
  const pdf = await extractResumeText({ name: 'cv.pdf', mime: 'application/pdf', data: makePdf(RESUME.replace('—', '-').replace(/\n/g, ' ')) });
  assert.match(pdf.text, /Jane Doe/);
  const docx = await extractResumeText({ name: 'cv.docx', mime: '', data: await makeDocx(RESUME) });
  assert.match(docx.text, /PyTorch/);
  await assert.rejects(extractResumeText({ name: 'cv.png', mime: 'image/png', data: Buffer.from('x') }), error => error.status === 415);
  await assert.rejects(extractResumeText({ name: 'cv.txt', mime: 'text/plain', data: Buffer.from('too short') }), error => error.status === 422);

  const { app, call } = await start();
  try {
    const uploaded = await call('/api/resumes', { method: 'POST', body: { name: 'cv.txt', mime: 'text/plain', data: Buffer.from(RESUME).toString('base64') } });
    assert.equal(uploaded.status, 201);
    assert.equal((await call(`/api/resumes/${uploaded.body.id}`)).body.text.startsWith('Jane Doe'), true);
    assert.equal((await call('/api/resumes', { method: 'POST', body: { name: 'cv.txt', data: '%%%' } })).status, 400);
    for (const name of ['two.txt', 'three.txt']) {
      assert.equal((await call('/api/resumes', { method: 'POST', body: { name, mime: 'text/plain', data: Buffer.from(RESUME).toString('base64') } })).status, 201);
    }
    const fourth = await call('/api/resumes', { method: 'POST', body: { name: 'four.txt', mime: 'text/plain', data: Buffer.from(RESUME).toString('base64') } });
    assert.equal(fourth.status, 409, 'three resumes at most');
    assert.equal((await call(`/api/resumes/${uploaded.body.id}`, { method: 'DELETE' })).body.ok, true);
    assert.equal((await call('/api/resumes')).body.length, 2);
  } finally { await app.close(); }
});

test('jobs, applications and company boards through the API', async () => {
  const { http } = fakeHttp([
    ['boards/acmeai/jobs?content=true', { body: JSON.parse(fixture('greenhouse.json')) }],
    ['boards/nobody/jobs', { status: 404, body: '' }],
  ]);
  const { app, call } = await start({ http });
  try {
    assert.equal((await call('/api/runs', { method: 'POST' })).status, 409, 'nothing to search yet');
    assert.equal((await call('/api/companies', { method: 'POST', body: { url: 'https://example.com/careers' } })).status, 400);
    assert.equal((await call('/api/companies', { method: 'POST', body: { url: 'https://job-boards.greenhouse.io/nobody' } })).status, 422);
    const company = await call('/api/companies', { method: 'POST', body: { url: 'https://job-boards.greenhouse.io/acmeai', name: 'Acme AI' } });
    assert.equal(company.status, 201);
    assert.equal(company.body.listed, 2);

    const job = await call('/api/postings', { method: 'POST', body: { title: 'Data Scientist', company: 'Acme', jobUrl: 'https://acme.example/jobs/1', datePosted: '2026-10-20', status: 'saved' } });
    assert.equal(job.status, 201);
    assert.equal(job.body.status, 'saved');
    assert.equal((await call('/api/postings', { method: 'POST', body: { title: 'x', company: 'y', jobUrl: 'file:///etc/passwd' } })).status, 400);
    assert.equal((await call(`/api/postings/${job.body.id}/score`, { method: 'POST' })).status, 409, 'no resume yet');
    await call('/api/resumes', { method: 'POST', body: { name: 'cv.txt', mime: 'text/plain', data: Buffer.from(RESUME).toString('base64') } });
    const scored = await call(`/api/postings/${job.body.id}/score`, { method: 'POST' });
    assert.equal(scored.body.score.score, 70);

    const applied = await call(`/api/postings/${job.body.id}/apply`, { method: 'POST', body: { appliedAt: '2026-10-20T12:00:00Z', note: 'referral' } });
    assert.equal(applied.status, 201);
    assert.equal(applied.body.appliedAt, '2026-10-20T12:00:00.000Z');
    assert.equal((await call(`/api/postings/${job.body.id}/apply`, { method: 'POST' })).status, 409);
    assert.equal((await call(`/api/postings/${job.body.id}`, { method: 'PATCH', body: { status: 'dismissed' } })).status, 409);
    assert.equal((await call(`/api/applications/${applied.body.id}`, { method: 'PATCH', body: { status: 'hired' } })).status, 400);
    const moved = await call(`/api/applications/${applied.body.id}`, { method: 'PATCH', body: { status: 'oa', note: 'HackerRank' } });
    assert.equal(moved.body.events[0].toStatus, 'oa');
    const manual = await call('/api/applications', { method: 'POST', body: { company: 'Initech', title: 'Analyst' } });
    assert.equal(manual.status, 201);
    assert.equal((await call('/api/applications?open=1')).body.length, 2);
    assert.equal((await call('/api/status')).body.stats.applications.oa, 1);
  } finally { await app.close(); }
});

test('the MCP bridge exposes Dayjob to Claude', async () => {
  assert.throws(() => localBaseUrl('https://example.com'), /local HTTP origin/);
  const { app, url } = await start();
  const server = createDayjobServer({ baseUrl: `${url}/` });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 29);
    assert.ok(tools.find(tool => tool.name === 'dayjob_list_postings').annotations.readOnlyHint);
    const added = await call('dayjob_add_posting', { title: 'ML Engineer', company: 'Nimbus', jobUrl: 'https://nimbus.example/jobs/7', description: 'PyTorch, Python, SQL and forecasting models.' });
    assert.match((await call('dayjob_save_analysis', { id: added.id, score: 82, verdict: 'good', summary: 's', strengths: [], gaps: [] })).error, /resume/i);
    await call('dayjob_get_resume').then(result => assert.match(result.error, /No resume/));
    await app.repo.addResume({ name: 'cv', mime: 'text/plain', size: 1, text: RESUME });
    await app.repo.addResume({ name: 'swe', mime: 'text/plain', size: 1, text: 'Software engineer. Java, Kubernetes, distributed systems.' });
    assert.match((await call('dayjob_get_resume')).error, /2 resumes/);
    assert.equal((await call('dayjob_get_resume', { postingId: added.id })).name, 'cv', 'the PyTorch job matches the ML resume');
    assert.equal((await call('dayjob_list_resumes')).length, 2);
    const analysed = await call('dayjob_save_analysis', { id: added.id, score: 82, verdict: 'good', summary: 'Strong ML match', strengths: ['PyTorch'], gaps: ['Visa'] });
    assert.equal(analysed.score.provider, 'claude-mcp');
    const listed = await call('dayjob_list_postings', { minScore: 80 });
    assert.equal(listed.postings[0].score, 82);
    assert.equal(listed.postings[0].description, undefined, 'lists stay compact');
    // A fixed applied date keeps the timeline order independent of today's date.
    const application = await call('dayjob_mark_applied', { id: added.id, appliedAt: '2026-10-20T12:00:00Z' });
    const updated = await call('dayjob_update_application', { id: application.id, status: 'interview', note: 'Invite from recruiter@nimbus.example', statusAt: '2026-10-22T09:00:00-07:00' });
    assert.equal(updated.events[0].source, 'mcp');
    assert.equal(updated.events[0].at, '2026-10-22T16:00:00.000Z');
    assert.match((await call('dayjob_update_application', { id: application.id })).error, /at least one/);
    const status = await call('dayjob_status');
    assert.equal(status.stats.applications.interview, 1);
  } finally {
    await client.close();
    await app.close();
  }
});
