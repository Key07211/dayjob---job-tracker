import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import autofill from '../desktop/autofill.cjs';
import { createApp } from '../server/app.mjs';
import { createDayjobServer } from '../integrations/mcp-server.mjs';
import { openDatabase } from '../server/jobs/db.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { resumeFileType, sameResume } from '../server/jobs/resume.mjs';
import { browserInput } from '../server/validation.mjs';
import { memoryRepo } from './helpers.mjs';

const { acceptsFile, pickFileField } = autofill;

const DATA = `Jane Doe — Data Scientist\n${'Python, SQL, PyTorch, experimentation, forecasting, dashboards. '.repeat(10)}`;
const SWE = `Jane Doe — Software Engineer\n${'Java, Kubernetes, distributed systems, Go, services, reliability. '.repeat(10)}`;
const job = (fields = {}) => posting({ site: 'linkedin', externalId: '1', title: 'Data Scientist', company: 'Acme Inc.', city: 'San Francisco',
  location: 'San Francisco, CA', jobUrl: 'https://www.linkedin.com/jobs/view/1', datePosted: '2026-10-20', description: 'Python, SQL and forecasting.', ...fields });

// A PDF with the text on it, small and whole enough to be read back.
function makePdf(text) {
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

async function start(options = {}) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-'));
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir, notify: () => {}, log: () => {}, detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }),
      score: async () => ({ score: 70, verdict: 'good', summary: 'ok', strengths: [], gaps: [], missingKeywords: [], provider: 'claude-cli' }) } }, ...options });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, url, boot, call };
}

test('a resume keeps its file beside its text, and lists never carry the file', () => {
  const { repo } = memoryRepo();
  const file = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80, 0x0a]);
  const kept = repo.addResume({ name: 'data.pdf', mime: 'application/pdf', size: file.length, text: DATA, file });
  const bare = repo.addResume({ name: 'old.pdf', mime: 'application/pdf', size: 4, text: SWE });
  assert.equal(kept.hasFile, true);
  assert.equal(bare.hasFile, false, 'a resume saved without its file says so');
  for (const listed of repo.listResumes()) assert.deepEqual(Object.keys(listed).sort(), ['characters', 'hasFile', 'id', 'mime', 'name', 'preview', 'size', 'uploadedAt']);
  const back = repo.getResumeFile(kept.id);
  assert.ok(Buffer.isBuffer(back.data) && back.data.equals(file), 'the bytes come back as they went in');
  assert.deepEqual({ name: back.name, mime: back.mime, size: back.size }, { name: 'data.pdf', mime: 'application/pdf', size: file.length });
  assert.equal(repo.getResumeFile(bare.id), null);
  assert.equal(repo.getResumeFile('nope'), null);

  // The file for a resume that had only its text: the text, its match and its score stay.
  repo.upsertPosting(job({ externalId: '2', title: 'Software Engineer', jobUrl: 'https://www.linkedin.com/jobs/view/2', description: 'Java, Kubernetes and distributed systems.' }));
  assert.equal(repo.getPosting('li-2').resumeId, bare.id);
  repo.saveScore('li-2', bare.id, { score: 81, verdict: 'good', summary: 's', strengths: [], gaps: [], missingKeywords: [], provider: 'claude-cli' });
  const added = repo.setResumeFile(bare.id, { name: 'swe-2026.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', file: Buffer.from('word file') });
  assert.deepEqual({ name: added.name, size: added.size, hasFile: added.hasFile, characters: added.characters }, { name: 'swe-2026.docx', size: 9, hasFile: true, characters: SWE.length });
  assert.equal(repo.getResume(bare.id, true).text, SWE);
  assert.equal(repo.getPosting('li-2').resumeId, bare.id);
  assert.equal(repo.getScore('li-2', bare.id).score, 81);
  assert.equal(repo.getResumeFile(bare.id).data.toString(), 'word file');
  assert.equal(repo.setResumeFile('nope', { name: 'x.pdf', mime: 'application/pdf', file: Buffer.from('x') }), null);

  repo.deleteResume(kept.id);
  assert.equal(repo.getResumeFile(kept.id), null, 'the file goes with its resume');
});

test('a database from before files were kept gains the column and keeps its resumes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-db-'));
  try {
    const first = openDatabase(directory);
    // As an older Dayjob left it: no file column, and the schema one step back.
    const version = first.db.prepare('PRAGMA user_version').get().user_version;
    first.db.exec('ALTER TABLE resumes DROP COLUMN file');
    first.db.exec(`PRAGMA user_version = ${version - 1}`);
    first.db.prepare('INSERT INTO resumes (id, name, mime, size, text, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)').run('r1', 'old.pdf', 'application/pdf', 3, DATA, '2026-10-01T00:00:00.000Z');
    first.db.close();
    const again = openDatabase(directory);
    assert.equal(again.db.prepare('PRAGMA user_version').get().user_version, version);
    const row = again.db.prepare('SELECT name, text, file FROM resumes WHERE id = ?').get('r1');
    assert.deepEqual({ name: row.name, text: row.text, file: row.file }, { name: 'old.pdf', text: DATA, file: null });
    again.db.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the resume that goes with a job page', () => {
  const { repo } = memoryRepo();
  assert.deepEqual(repo.pickResumeFile({ url: 'https://example.com/jobs/1' }), { resume: null, reason: 'no-resume' });
  const data = repo.addResume({ name: 'data.pdf', mime: 'application/pdf', size: 1, text: DATA });
  assert.deepEqual(repo.pickResumeFile({ title: 'Data Scientist' }), { resume: null, reason: 'no-file' }, 'text alone cannot be attached');
  repo.setResumeFile(data.id, { name: 'data.pdf', mime: 'application/pdf', file: Buffer.from('data file') });
  const swe = repo.addResume({ name: 'swe.pdf', mime: 'application/pdf', size: 1, text: SWE, file: Buffer.from('swe file') });
  repo.upsertPosting(job());
  repo.upsertPosting(job({ externalId: '2', title: 'Backend Engineer', jobUrl: 'https://www.linkedin.com/jobs/view/2', description: 'Java, Kubernetes and distributed systems.' }));

  // A page of a posting Dayjob has: the resume that posting is matched to.
  const forData = repo.pickResumeFile({ url: 'https://www.linkedin.com/jobs/view/1?trk=mail' });
  assert.deepEqual(forData, { resume: { id: data.id, name: 'data.pdf', mime: 'application/pdf', size: 9 }, reason: 'posting', posting: { id: 'li-1', title: 'Data Scientist', company: 'Acme Inc.' } });
  assert.equal(repo.pickResumeFile({ url: 'https://www.linkedin.com/jobs/view/2', title: 'Data Scientist', description: 'Python and SQL' }).resume.id, swe.id, 'the posting decides, not the page text');
  // A page Dayjob does not know: by its own title and text.
  assert.deepEqual(repo.pickResumeFile({ url: 'https://jobs.example.com/apply/9', title: 'Platform Engineer', description: 'Kubernetes, Go and reliability of distributed services.' }),
    { resume: { id: swe.id, name: 'swe.pdf', mime: 'application/pdf', size: 8 }, reason: 'page' });
  assert.equal(repo.pickResumeFile({ url: 'https://jobs.example.com/apply/9', title: 'Analyst', description: 'Forecasting with Python, SQL and dashboards.' }).resume.id, data.id);
  // Nothing to go by: the newest.
  assert.deepEqual(repo.pickResumeFile({ url: 'about:blank' }), { resume: { id: swe.id, name: 'swe.pdf', mime: 'application/pdf', size: 8 }, reason: 'newest' });
  // Asked for by id.
  assert.equal(repo.pickResumeFile({ resumeId: data.id, url: 'https://www.linkedin.com/jobs/view/2' }).resume.id, data.id);
  assert.equal(repo.pickResumeFile({ resumeId: data.id }).reason, 'chosen');
  assert.deepEqual(repo.pickResumeFile({ resumeId: 'nope' }), { resume: null, reason: 'unknown' });

  // The best match has only its text: the next one with a file goes, and the better one is named.
  const ml = repo.addResume({ name: 'ml.pdf', mime: 'application/pdf', size: 1, text: `Jane Doe\n${'Python, SQL, forecasting, PyTorch, machine learning research. '.repeat(10)}` });
  repo.upsertPosting(job({ externalId: '3', title: 'Machine Learning Researcher', jobUrl: 'https://www.linkedin.com/jobs/view/3', description: 'Machine learning research with PyTorch.' }));
  assert.equal(repo.getPosting('li-3').resumeId, ml.id);
  const second = repo.pickResumeFile({ url: 'https://www.linkedin.com/jobs/view/3' });
  assert.equal(second.resume.id, data.id);
  assert.deepEqual(second.better, { id: ml.id, name: 'ml.pdf', mime: 'application/pdf', size: 1 });
  assert.deepEqual(repo.pickResumeFile({ resumeId: ml.id }), { resume: null, reason: 'no-file', better: { id: ml.id, name: 'ml.pdf', mime: 'application/pdf', size: 1 } });
});

test('the API keeps an uploaded file, serves it back as a download, and adds one to a text-only resume', async () => {
  const { app, url, call } = await start();
  try {
    const pdf = makePdf(DATA);
    const uploaded = await call('/api/resumes', { method: 'POST', body: { name: 'Jane Doe 简历.pdf', mime: 'application/pdf', data: pdf.toString('base64') } });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.hasFile, true);
    assert.equal(uploaded.body.size, pdf.length);
    assert.equal('file' in uploaded.body || 'data' in uploaded.body, false);
    assert.equal(JSON.stringify((await call('/api/bootstrap')).body.resumes).includes('hasFile'), true, 'the app knows which resumes can be attached');

    const served = await fetch(`${url}/api/resumes/${uploaded.body.id}/file`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'application/pdf');
    assert.equal(served.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('Jane Doe 简历.pdf')}`);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await served.arrayBuffer()).equals(pdf), 'the same bytes');

    // Whatever type the upload claimed, a text resume is served as plain text to save, never as a page.
    const page = await call('/api/resumes', { method: 'POST', body: { name: 'cv.txt', mime: 'text/html', data: Buffer.from(`<script>alert(1)</script>\n${SWE}`).toString('base64') } });
    const text = await fetch(`${url}/api/resumes/${page.body.id}/file`);
    assert.equal(text.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(text.headers.get('content-disposition'), /^attachment;/);

    // A resume from before files were kept: no file to serve, until one is added.
    const old = app.repo.addResume({ name: 'old.pdf', mime: 'application/pdf', size: 1, text: DATA });
    assert.equal((await fetch(`${url}/api/resumes/${old.id}/file`)).status, 404);
    assert.equal((await fetch(`${url}/api/resumes/nope/file`)).status, 404);
    const other = await call(`/api/resumes/${old.id}/file`, { method: 'POST', body: { name: 'swe.txt', mime: 'text/plain', data: Buffer.from(SWE).toString('base64') } });
    assert.equal(other.status, 409, 'a file that reads as another resume is not taken without asking');
    assert.equal(app.repo.getResume(old.id).hasFile, false);
    const same = await call(`/api/resumes/${old.id}/file`, { method: 'POST', body: { name: 'data-2026.pdf', mime: 'application/pdf', data: pdf.toString('base64') } });
    assert.equal(same.status, 200);
    assert.deepEqual({ name: same.body.name, hasFile: same.body.hasFile, size: same.body.size }, { name: 'data-2026.pdf', hasFile: true, size: pdf.length });
    assert.equal(app.repo.getResume(old.id, true).text, DATA, 'the text used for scoring stays');
    const forced = await call(`/api/resumes/${old.id}/file`, { method: 'POST', body: { name: 'swe.txt', mime: 'text/plain', data: Buffer.from(SWE).toString('base64'), force: true } });
    assert.equal(forced.status, 200);
    assert.equal(app.repo.getResumeFile(old.id).data.toString(), SWE);
    assert.equal((await call(`/api/resumes/${old.id}/file`, { method: 'POST', body: { name: 'x.png', mime: 'image/png', data: 'AAAA' } })).status, 415);
    assert.equal((await call('/api/resumes/nope/file', { method: 'POST', body: { name: 'a.txt', data: 'AAAA' } })).status, 404);
    // Writing needs the window's token.
    const noToken = await fetch(`${url}/api/resumes/${old.id}/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noToken.status, 403);
  } finally { await app.close(); }
});

test('two readings of one resume are the same resume; another resume is not', () => {
  assert.equal(sameResume(DATA, `  ${DATA.replace(/\n/g, '  \n')}\nPage 1 of 1`), true);
  assert.equal(sameResume(DATA, `${DATA}\nNew: led a pricing experiment in 2026.`), true, 'a newer edit of it');
  assert.equal(sameResume(DATA, SWE), false);
  assert.equal(sameResume('', DATA), false);
  assert.deepEqual(resumeFileType('a.PDF', ''), { kind: 'pdf', mime: 'application/pdf' });
  assert.equal(resumeFileType('a.docx', 'text/html').kind, 'docx');
  assert.equal(resumeFileType('a.exe', 'application/octet-stream'), null);
});

let next = 0;
const upload = (label, extra = {}) => ({ index: next++, frame: 0, label, section: '', name: '', id: '', accept: '', multiple: false, filled: false, shown: true, ...extra });

test('the resume goes into the field that is for it', () => {
  const resume = upload('Resume/CV'), cover = upload('Cover Letter');
  assert.equal(pickFileField([cover, resume]), resume);
  assert.equal(pickFileField([cover, resume], 'coverLetter'), cover);
  // By the field's name in the form, when it is hidden behind a button and the words are elsewhere.
  for (const extra of [{ name: 'job_application[resume]' }, { id: '_systemfield_resume' }, { name: 'cv-upload' }, { label: '上传简历' }, { label: 'Curriculum vitae' }, { label: 'Lebenslauf / Résumé' }]) {
    const field = upload('', extra);
    assert.equal(pickFileField([upload('', { name: 'cover_letter' }), field]), field, JSON.stringify(extra));
  }
  // By the part of the form it is in.
  const inSection = upload('Attach', { section: 'Resume' });
  assert.equal(pickFileField([upload('Attach', { section: 'Portfolio' }), inSection]), inSection);
  // A form's only upload, with nothing saying what it is for.
  const only = upload('Upload file');
  assert.equal(pickFileField([only]), only);
  assert.equal(pickFileField([only], 'coverLetter'), null, 'a cover letter never goes into an unnamed field');
  // Never a field that is for something else, or that takes pictures only.
  assert.equal(pickFileField([upload('Transcript')]), null);
  assert.equal(pickFileField([upload('Cover letter')]), null);
  assert.equal(pickFileField([upload('', { name: 'avatar', accept: 'image/*' })]), null);
  assert.equal(pickFileField([upload('Upload', { accept: '.png,.jpg' })]), null);
  assert.equal(pickFileField([upload('Upload file'), upload('Attach')]), null, 'two unnamed uploads: no guessing');
  assert.equal(pickFileField([]), null);
});

test('a field takes a file by its accept list', () => {
  const pdf = { name: 'Jane Doe.PDF', mime: 'application/pdf' };
  const docx = { name: 'cv.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  assert.equal(acceptsFile('', pdf), true);
  assert.equal(acceptsFile('.pdf, .doc, .docx', pdf), true);
  assert.equal(acceptsFile('application/pdf', pdf), true);
  assert.equal(acceptsFile('application/pdf', docx), false);
  assert.equal(acceptsFile('.pdf', docx), false);
  assert.equal(acceptsFile('application/*', docx), true);
  assert.equal(acceptsFile('text/*', { name: 'cv.txt', mime: 'text/plain; charset=utf-8' }), true);
  assert.equal(acceptsFile('image/*', pdf), false);
});

test('Claude attaches a resume through Dayjob, by id or by the job, and never gets the file', async () => {
  assert.deepEqual(browserInput('upload', {}), { resumeId: null });
  assert.deepEqual(browserInput('upload', { resumeId: 'abc' }), { resumeId: 'abc' });
  assert.throws(() => browserInput('upload', { resumeId: 7 }));
  assert.deepEqual(browserInput('autofill', {}), { resumeId: null, resume: true });
  assert.deepEqual(browserInput('autofill', { resume: false }), { resumeId: null, resume: false });

  const asked = [];
  const { app, url, boot } = await start({ browser: { run: async (action, input) => { asked.push([action, input]); return { uploaded: { resume: 'data.pdf', field: 'Resume/CV', chosenBy: 'posting' } }; } } });
  try {
    const server = createDayjobServer({ baseUrl: url, token: boot.csrfToken });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const tools = (await client.listTools()).tools;
    const tool = tools.find(item => item.name === 'dayjob_browser_upload_resume');
    assert.ok(tool, 'the tool is offered');
    assert.match(tool.description, /never the file/);
    const result = await client.callTool({ name: 'dayjob_browser_upload_resume', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /data\.pdf/);
    await client.callTool({ name: 'dayjob_browser_upload_resume', arguments: { resumeId: 'r-2' } });
    assert.deepEqual(asked, [['upload', { resumeId: null }], ['upload', { resumeId: 'r-2' }]]);
    const listed = tools.find(item => item.name === 'dayjob_list_resumes');
    assert.match(listed.description, /hasFile/);
    await client.close();
  } finally { await app.close(); }
});
