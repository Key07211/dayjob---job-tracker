import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import autofill from '../desktop/autofill.cjs';
import { createApp } from '../server/app.mjs';
import { openDatabase } from '../server/jobs/db.mjs';
import { createTranscripts, MAX_TRANSCRIPTS, transcriptFileName } from '../server/jobs/transcripts.mjs';
import { elementLine } from '../server/assistant/page-lean.mjs';
import { BROWSER_ACTIONS, browserInput } from '../server/validation.mjs';

const { isTrap, keyFor, pickFileField } = autofill;
const pdf = (words = 'a transcript') => Buffer.from(`%PDF-1.4\n% ${words}\n%%EOF\n`);
const upload = (label, more = {}) => ({ index: 0, frame: 0, label, name: '', id: '', section: '', accept: '', filled: false, ...more });

function folder(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-transcripts-'));
  const { db } = openDatabase(dataDir);
  // The database is closed before its folder goes: Windows does not delete a file that is still open.
  t.after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const dir = path.join(dataDir, 'transcripts');
  let tick = 0;
  return { dir, transcripts: createTranscripts({ db, dir, now: () => new Date(Date.UTC(2026, 10, 22, 12, 0, tick++)) }) };
}

test('a transcript is a PDF in the transcript folder, with a note and a default beside it', t => {
  const { dir, transcripts } = folder(t);
  assert.deepEqual(transcripts.list(), []);
  const first = transcripts.add({ name: 'UC Example Transcript.pdf', data: pdf('one'), note: '  UC Example, master\'s ' });
  assert.equal(first.name, 'UC Example Transcript.pdf');
  assert.equal(first.note, 'UC Example, master\'s');
  assert.equal(first.isDefault, false);
  assert.equal(first.size, pdf('one').length);
  assert.deepEqual(fs.readdirSync(dir), ['UC Example Transcript.pdf']);
  assert.equal(Object.keys(first).some(key => /data|file|bytes|text/i.test(key)), false, 'a list never carries the file');
  // The same name again gets a name of its own; a name Windows refuses is made safe.
  assert.equal(transcripts.add({ name: 'UC Example Transcript.pdf', data: pdf('two') }).name, 'UC Example Transcript (2).pdf');
  assert.equal(transcriptFileName('a/b:c?.PDF'), 'a b c.pdf');
  assert.equal(transcriptFileName(''), 'Transcript.pdf');
  assert.equal(transcriptFileName('con.pdf'), 'con transcript.pdf');
  assert.equal(transcriptFileName('..\\..\\secret'), 'secret.pdf');
  // Only PDFs, and not an empty file.
  assert.throws(() => transcripts.add({ name: 'grades.docx', data: Buffer.from('PK\u0003\u0004 not a pdf') }), { status: 415 });
  assert.throws(() => transcripts.add({ name: 'empty.pdf', data: Buffer.alloc(0) }), { status: 400 });
  // The file itself, for the form it goes into.
  const kept = transcripts.file(first.id);
  assert.equal(kept.name, 'UC Example Transcript.pdf');
  assert.equal(kept.mime, 'application/pdf');
  assert.equal(kept.data.equals(pdf('one')), true);
  // One default at a time.
  const second = transcripts.list().find(item => item.name.includes('(2)'));
  assert.equal(transcripts.update(first.id, { isDefault: true }).isDefault, true);
  assert.equal(transcripts.update(second.id, { isDefault: true, note: 'Undergraduate' }).note, 'Undergraduate');
  assert.deepEqual(transcripts.list().map(item => [item.name, item.isDefault]), [['UC Example Transcript (2).pdf', true], ['UC Example Transcript.pdf', false]]);
  assert.equal(transcripts.update(second.id, { isDefault: false }).isDefault, false);
  assert.equal(transcripts.update('nope', { note: 'x' }), null);
  // Deleting takes the file out of the folder too.
  assert.equal(transcripts.remove(second.id), true);
  assert.equal(transcripts.remove(second.id), false);
  assert.deepEqual(fs.readdirSync(dir), ['UC Example Transcript.pdf']);
});

test('the list follows the folder: a PDF put there by hand is listed, one taken out is gone', t => {
  const { dir, transcripts } = folder(t);
  const uploaded = transcripts.add({ name: 'Uploaded.pdf', data: pdf('uploaded'), note: 'kept' });
  fs.writeFileSync(path.join(dir, 'By Hand.pdf'), pdf('by hand'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a transcript');
  fs.writeFileSync(path.join(dir, 'Only The Name.pdf'), 'plain words');
  const listed = transcripts.list();
  assert.deepEqual(listed.map(item => item.name).sort(), ['By Hand.pdf', 'Uploaded.pdf']);
  assert.equal(listed.find(item => item.name === 'Uploaded.pdf').note, 'kept');
  assert.equal(listed.find(item => item.name === 'By Hand.pdf').size, pdf('by hand').length);
  // Listing again adds nothing twice.
  assert.equal(transcripts.list().length, 2);
  fs.unlinkSync(path.join(dir, 'Uploaded.pdf'));
  assert.deepEqual(transcripts.list().map(item => item.name), ['By Hand.pdf']);
  assert.equal(transcripts.file(uploaded.id), null);
  assert.equal(transcripts.get(uploaded.id), null);
  // The folder holds what it holds; the list stops at its limit.
  for (let n = 0; n < MAX_TRANSCRIPTS + 2; n += 1) fs.writeFileSync(path.join(dir, `Extra ${n}.pdf`), pdf(`extra ${n}`));
  assert.equal(transcripts.list().length, MAX_TRANSCRIPTS);
  assert.throws(() => transcripts.add({ name: 'One More.pdf', data: pdf() }), { status: 409 });
});

test('the transcript for a field: the only one, the one its label names, the default, the newest, or the ones asked for', t => {
  const { transcripts } = folder(t);
  assert.deepEqual(transcripts.pick({ label: 'Transcript' }), { transcripts: [], reason: 'none' });
  const grad = transcripts.add({ name: 'Berkeley.pdf', data: pdf('grad'), note: 'UC Berkeley 硕士' });
  const only = transcripts.pick({ label: 'College Transcript' });
  assert.deepEqual([only.reason, only.transcripts, only.others], ['only', [{ id: grad.id, name: 'Berkeley.pdf', note: 'UC Berkeley 硕士' }], []]);
  const undergrad = transcripts.add({ name: 'Tongji Undergraduate Transcript.pdf', data: pdf('undergrad') });
  const by = (label, section = '') => { const picked = transcripts.pick({ label, section }); return [picked.reason, picked.transcripts[0].name]; };
  // Nothing in the label tells them apart: the newest, until one is starred.
  assert.deepEqual(by('College Transcript'), ['newest', 'Tongji Undergraduate Transcript.pdf']);
  transcripts.update(grad.id, { isDefault: true });
  assert.deepEqual(by('College Transcript'), ['default', 'Berkeley.pdf']);
  assert.deepEqual(by('成绩单'), ['default', 'Berkeley.pdf']);
  // The level of study, or a school's name, in the label or in the part of the form.
  assert.deepEqual(by('Undergraduate transcript'), ['label', 'Tongji Undergraduate Transcript.pdf']);
  assert.deepEqual(by('Graduate transcript (unofficial)'), ['label', 'Berkeley.pdf']);
  assert.deepEqual(by('研究生成绩单'), ['label', 'Berkeley.pdf']);
  assert.deepEqual(by('Bachelor\'s degree transcript'), ['label', 'Tongji Undergraduate Transcript.pdf']);
  assert.deepEqual(by('Transcript', 'Education: Tongji University'), ['label', 'Tongji Undergraduate Transcript.pdf']);
  assert.deepEqual(by('Upload your Berkeley transcript'), ['label', 'Berkeley.pdf']);
  assert.equal(transcripts.pick({ label: 'Undergraduate transcript' }).others[0].id, grad.id);
  // Asked for by id, in that order; an id that is not one is refused, with what there is.
  assert.deepEqual(transcripts.pick({ label: 'Transcripts', ids: [undergrad.id, grad.id] }).transcripts.map(item => item.name), ['Tongji Undergraduate Transcript.pdf', 'Berkeley.pdf']);
  const unknown = transcripts.pick({ ids: ['nope'] });
  assert.deepEqual([unknown.reason, unknown.transcripts.length, unknown.others.length], ['unknown', 0, 2]);
});

test('transcripts over the API: kept, noted, starred, downloaded and deleted, never listed with their file', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-transcripts-api-'));
  const app = await createApp({ dataDir, startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {}, detectJobspy: async () => ({ available: false }) });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${url}${pathname}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
  };
  assert.deepEqual(boot.transcripts, []);
  const empty = (await call('/api/transcripts')).body;
  assert.deepEqual([empty.transcripts, empty.max, empty.folder], [[], MAX_TRANSCRIPTS, path.join(dataDir, 'transcripts')]);
  const added = await call('/api/transcripts', { method: 'POST', body: { name: 'Transcript.pdf', note: 'Example University', data: pdf('api').toString('base64') } });
  assert.equal(added.status, 201);
  assert.equal(added.body.name, 'Transcript.pdf');
  assert.equal((await call('/api/transcripts', { method: 'POST', body: { name: 'words.pdf', data: Buffer.from('plain words').toString('base64') } })).status, 415);
  assert.equal((await call('/api/transcripts', { method: 'POST', body: { name: 'x.pdf', data: '<not base64>' } })).status, 400);
  assert.equal((await fetch(`${url}/api/transcripts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403, 'a write needs the window\'s token');
  const patched = await call(`/api/transcripts/${added.body.id}`, { method: 'PATCH', body: { note: 'Example University, BS', isDefault: true } });
  assert.deepEqual([patched.body.note, patched.body.isDefault], ['Example University, BS', true]);
  assert.equal((await call(`/api/transcripts/${added.body.id}`, { method: 'PATCH', body: { isDefault: 'yes' } })).status, 400);
  assert.equal((await call('/api/transcripts/nope', { method: 'PATCH', body: { note: 'x' } })).status, 404);
  const listed = (await call('/api/transcripts')).body.transcripts;
  assert.equal(JSON.stringify(listed).includes('%PDF'), false);
  assert.deepEqual((await (await fetch(`${url}/api/bootstrap`)).json()).transcripts, [{ id: added.body.id, name: 'Transcript.pdf', note: 'Example University, BS', isDefault: true }]);
  const file = await call(`/api/transcripts/${added.body.id}/file`);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /^attachment/);
  assert.equal(file.body.equals(pdf('api')), true);
  assert.equal((await call(`/api/transcripts/${added.body.id}`, { method: 'DELETE' })).body.ok, true);
  assert.equal((await call(`/api/transcripts/${added.body.id}/file`)).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'transcripts')), []);
});

test('a form\'s transcript field is told from its resume and cover letter fields', () => {
  // As BambooHR draws them: the same own name on all three, each named by the line over it.
  const cover = upload('Cover Letter', { index: 0 });
  const resume = upload('Resume', { index: 1 });
  const transcript = upload('College Transcript', { index: 2, multiple: true });
  const form = [cover, resume, transcript];
  assert.equal(pickFileField(form, 'resume'), resume);
  assert.equal(pickFileField(form, 'coverLetter'), cover);
  assert.equal(pickFileField(form, 'transcript'), transcript);
  for (const label of ['Unofficial transcript', 'Academic record', 'Transcripts (optional)', '成绩单', '上传成绩单', 'Grade report']) {
    const field = upload(label);
    assert.equal(pickFileField([upload('Resume/CV'), field], 'transcript'), field, label);
    assert.equal(pickFileField([upload('Resume/CV'), field], 'resume').label, 'Resume/CV', label);
  }
  assert.equal(pickFileField([upload('', { name: 'transcript_upload' })], 'transcript').name, 'transcript_upload');
  assert.equal(pickFileField([upload('Attach', { section: 'Transcripts' }), upload('Attach', { section: 'Portfolio' })], 'transcript').section, 'Transcripts');
  // A transcript never goes into a field that does not say it is for one, even a form's only upload.
  assert.equal(pickFileField([upload('Upload file')], 'transcript'), null);
  assert.equal(pickFileField([upload('Resume'), upload('Cover letter')], 'transcript'), null);
  assert.equal(pickFileField([upload('Transcript', { accept: 'image/*' })], 'transcript'), null);
  // And the resume never goes into the transcript's.
  assert.equal(pickFileField([transcript]), null);
});

test('the browser\'s transcript step takes ids or nothing, and Claude can ask for it', () => {
  assert.ok(BROWSER_ACTIONS.includes('transcript'));
  assert.deepEqual(browserInput('transcript', {}), { transcriptIds: null });
  assert.deepEqual(browserInput('transcript', { transcriptIds: ['a', 'b'] }), { transcriptIds: ['a', 'b'] });
  assert.throws(() => browserInput('transcript', { transcriptIds: [] }));
  assert.throws(() => browserInput('transcript', { transcriptIds: 'a' }));
  assert.throws(() => browserInput('transcript', { transcriptIds: [7] }));
  assert.throws(() => browserInput('transcript', { transcriptIds: ['a', 'b', 'c', 'd', 'e'] }));
});

test('a box that says to leave it empty is a trap for robots: autofill passes it by, and the reading marks it', () => {
  const field = (label, name = '') => ({ kind: 'text', type: 'text', label, name, id: '', placeholder: '', autocomplete: '', section: '' });
  assert.equal(keyFor(field('请将此栏留空', 'nickname_hpcsaf')), null);
  assert.equal(keyFor(field('Leave this field blank', 'nickname')), null);
  assert.equal(keyFor(field('Please leave this one empty', 'email_confirm')), null);
  assert.equal(keyFor(field('请勿填写', 'phone2')), null);
  assert.equal(keyFor(field('Email', 'email')), 'email');
  // Nor is it one of the fields the user is told are still empty.
  assert.equal(isTrap(field('请将此栏留空', 'nickname_hpcsaf')), true);
  assert.equal(isTrap(field('Email', 'email')), false);
  assert.equal(elementLine({ ref: 'e7', role: 'textbox', name: '请将此栏留空', trap: true }), 'e7 textbox "请将此栏留空" trap-leave-empty');
  assert.equal(elementLine({ ref: 'e8', role: 'textbox', name: 'Email' }), 'e8 textbox "Email"');
});
