import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { memoryRepo } from './helpers.mjs';

// 手动换简历: the resume a job is scored against, chosen by hand.
const DATA = `Jane Doe, Data Scientist\n${'Python, SQL, PyTorch, experimentation, forecasting, dashboards. '.repeat(10)}`;
const SWE = `Jane Doe, Software Engineer\n${'Java, Kubernetes, distributed systems, backend services. '.repeat(10)}`;
const JOB = { site: 'linkedin', externalId: 'ml-1', title: 'Machine Learning Engineer', company: 'Nimbus', jobUrl: 'https://nimbus.example/jobs/1',
  description: 'PyTorch, Python, SQL and forecasting models. You run experiments and build dashboards.' };
const result = score => ({ score, verdict: 'good', summary: 's', strengths: [], gaps: [], missingKeywords: [], provider: 'claude-cli', model: null });

test('a resume chosen by hand stays when resumes are matched again, until it is gone or given back', () => {
  const { repo } = memoryRepo();
  const data = repo.addResume({ name: 'data.pdf', mime: 'application/pdf', size: 1, text: DATA, file: Buffer.from('data file') });
  const swe = repo.addResume({ name: 'swe.pdf', mime: 'application/pdf', size: 1, text: SWE, file: Buffer.from('swe file') });
  const { id } = repo.upsertPosting(posting(JOB));
  assert.equal(repo.pickResumeFile({ url: JOB.jobUrl }).resume.id, data.id);
  const matched = repo.getPosting(id);
  assert.equal(matched.resumeId, data.id, 'by keywords the job goes with the data resume');
  assert.equal(matched.resumeManual, undefined);
  assert.equal(matched.resumeMatch.manual, false);
  repo.saveScore(id, data.id, result(82));

  const chosen = repo.setPostingResume(id, swe.id);
  assert.equal(chosen.resumeId, swe.id);
  assert.equal(chosen.resumeManual, true);
  assert.equal(chosen.resumeMatch.manual, true);
  assert.equal(chosen.resumeOverlap, chosen.resumeMatch.ranking.find(entry => entry.id === swe.id).overlap, 'the overlap shown is the chosen resume\'s own');
  assert.equal(chosen.score, null, 'this pair has not been scored');
  assert.deepEqual(repo.unscoredPostingIds(10), [id], 'so it waits for a score like any unscored job');
  assert.equal(repo.getScore(id, data.id).score, 82, 'the score against the other resume is kept');
  assert.equal(repo.pickResumeFile({ url: JOB.jobUrl }).resume.id, swe.id, 'and it is the file attached when applying to this job');

  // The same job seen again in a search, another resume uploaded, every posting matched again: the choice stays.
  repo.upsertPosting(posting({ ...JOB, description: `${JOB.description} Remote.` }));
  const third = repo.addResume({ name: 'ml.pdf', mime: 'application/pdf', size: 1, text: `Jane Doe\n${'PyTorch, Python, SQL, forecasting models, experiments, dashboards. '.repeat(12)}` });
  repo.rematchPostings();
  assert.deepEqual([repo.getPosting(id).resumeId, repo.getPosting(id).resumeManual], [swe.id, true]);

  // An unknown resume changes nothing; an unknown posting is said so.
  assert.equal(repo.setPostingResume(id, 'nope'), false);
  assert.equal(repo.setPostingResume('nope', swe.id), null);
  assert.equal(repo.getPosting(id).resumeId, swe.id);

  // Given back: Dayjob chooses again, and the score made against that resume shows again.
  const back = repo.setPostingResume(id, null);
  assert.equal(back.resumeId, third.id, 'the resume that now shares most keywords');
  assert.equal(back.resumeManual, undefined);
  assert.equal(repo.setPostingResume(id, data.id).score.score, 82);

  // The chosen resume is deleted: the job goes back to Dayjob's choice.
  repo.deleteResume(data.id);
  const after = repo.getPosting(id);
  assert.deepEqual([after.resumeId, after.resumeManual, after.resumeMatch.manual], [third.id, undefined, false]);
});

test('over the API: choose a resume for a job, score it against that one, and go back', async t => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-'));
  const scored = [];
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir, notify: () => {}, log: () => {}, detectJobspy: async () => ({ available: false }),
    providers: { 'claude-cli': { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }),
      score: async ({ resume }) => { scored.push(resume.slice(0, 30)); return { ...result(/Software/.test(resume) ? 41 : 82), provider: 'claude-cli' }; } } } });
  t.after(async () => { await app.close(); fs.rmSync(distDir, { recursive: true, force: true }); });
  const url = await app.listen(0);
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  const post = async (pathname, body) => {
    const response = await fetch(`${url}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dayjob-token': boot.csrfToken }, body: JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const data = app.repo.addResume({ name: 'data.pdf', mime: 'application/pdf', size: 1, text: DATA });
  const swe = app.repo.addResume({ name: 'swe.pdf', mime: 'application/pdf', size: 1, text: SWE });
  const { id } = app.repo.upsertPosting(posting(JOB));
  assert.equal((await post(`/api/postings/${id}/score`, {})).body.score.score, 82);

  const chosen = await post(`/api/postings/${id}/resume`, { resumeId: swe.id });
  assert.deepEqual([chosen.status, chosen.body.resumeId, chosen.body.resumeMatch.manual, chosen.body.score], [200, swe.id, true, null]);
  assert.equal(scored.length, 1, 'choosing a resume scores nothing by itself');
  const rescored = await post(`/api/postings/${id}/score`, {});
  assert.deepEqual([rescored.body.score.score, rescored.body.score.resumeId], [41, swe.id]);
  assert.match(scored[1], /Software Engineer/, 'the score was made against the chosen resume');

  // Back to the first resume: its score is still there, so nothing is scored again.
  const first = await post(`/api/postings/${id}/resume`, { resumeId: data.id });
  assert.deepEqual([first.body.score.score, first.body.resumeMatch.manual], [82, true]);
  assert.equal((await post(`/api/postings/${id}/score`, {})).body.score.score, 82);
  assert.equal(scored.length, 2);
  const auto = await post(`/api/postings/${id}/resume`, { resumeId: null });
  assert.deepEqual([auto.body.resumeId, auto.body.resumeMatch.manual], [data.id, false]);

  assert.equal((await post(`/api/postings/${id}/resume`, { resumeId: 'nope' })).status, 404);
  assert.equal((await post(`/api/postings/${id}/resume`, {})).status, 400);
  assert.equal((await post('/api/postings/nope/resume', { resumeId: swe.id })).status, 404);
});
