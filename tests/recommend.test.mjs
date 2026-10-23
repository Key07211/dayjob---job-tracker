import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { buildRecommendPrompt, checkBoards, normalizeRecommendations, RECOMMEND_SCHEMA } from '../server/jobs/recommend.mjs';
import { fakeHttp, fixture } from './helpers.mjs';

const RESUME = `Jane Doe, Berkeley CA. Data analyst intern. ${'Python, SQL, Tableau, A/B tests, dashboards. '.repeat(10)}`;
const REPLY = {
  summary: '数据分析方向，应届。',
  searches: [
    { name: '湾区数据分析', keywords: ' Data Analyst,  Business Analyst ', location: 'San Francisco Bay Area', country: 'usa', is_remote: false, job_type: 'fulltime',
      title_include: [], exclude_keywords: ['Senior', 'Senior', 'Staff'], resume: 'cv.txt', reason: '简历以 SQL 和看板为主。' },
    { name: 'dup', keywords: 'data analyst, business analyst', location: 'San Francisco Bay Area', country: 'usa', is_remote: false, job_type: '',
      title_include: [], exclude_keywords: [], resume: '', reason: '' },
    { name: 'Remote', keywords: 'Analytics Engineer', location: '', country: 'mars', is_remote: true, job_type: 'gig',
      title_include: ['New Grad'], exclude_keywords: [], resume: 'CV', reason: '' },
    { name: 'empty', keywords: '  ', location: '', country: 'usa', is_remote: false, job_type: '', title_include: [], exclude_keywords: [], resume: '', reason: '' },
  ],
  companies: [
    { name: 'Acme AI', ats: 'greenhouse', slug: 'acmeai', reason: '招数据岗。' },
    { name: 'Acme again', ats: 'greenhouse', slug: 'AcmeAI', reason: '' },
    { name: 'Ghost', ats: 'lever', slug: 'ghost-co', reason: '' },
    { name: 'Bad', ats: 'workday', slug: 'bad', reason: '' },
    { name: 'Weird', ats: 'ashby', slug: '../etc', reason: '' },
  ],
};

test('Claude\'s suggestions are cleaned before the app shows them', () => {
  const resumes = [{ id: 'r1', name: 'cv.txt' }, { id: 'r2', name: 'swe.pdf' }];
  const result = normalizeRecommendations(REPLY, resumes);
  assert.equal(result.summary, '数据分析方向，应届。');
  assert.equal(result.searches.length, 2, 'duplicates and empty keywords are dropped');
  assert.deepEqual(result.searches[0], { name: '湾区数据分析', keywords: 'Data Analyst, Business Analyst', location: 'San Francisco Bay Area', country: 'usa',
    isRemote: false, jobType: 'fulltime', titleInclude: [], excludeKeywords: ['Senior', 'Staff'], resumeId: 'r1', reason: '简历以 SQL 和看板为主。' });
  assert.equal(result.searches[1].country, 'usa', 'unknown countries fall back to the US');
  assert.equal(result.searches[1].jobType, null);
  assert.equal(result.searches[1].resumeId, 'r1', 'resume names match loosely');
  assert.deepEqual(result.companies.map(company => `${company.ats}/${company.slug}`), ['greenhouse/acmeai', 'lever/ghost-co']);
  assert.throws(() => normalizeRecommendations('nope'), /JSON object/);
  assert.equal(RECOMMEND_SCHEMA.additionalProperties, false);
});

test('the prompt carries every resume, what already exists and the preferences', () => {
  const prompt = buildRecommendPrompt({ resumes: [{ name: 'a"b.pdf', text: 'A'.repeat(20000) }, { name: 'swe.pdf', text: 'Java' }],
    searches: [{ keywords: 'Data Analyst', location: 'New York, NY', isRemote: false }], companies: [{ name: 'Stripe', ats: 'greenhouse', slug: 'stripe' }],
    preference: 'Bay Area only', language: 'en' });
  assert.match(prompt, /<resume name="ab.pdf">/);
  assert.match(prompt, /<resume name="swe.pdf">\nJava/);
  assert.ok(!prompt.includes('A'.repeat(16001)), 'long resumes are trimmed');
  assert.match(prompt, /Data Analyst · New York, NY/);
  assert.match(prompt, /Stripe \(greenhouse\/stripe\)/);
  assert.match(prompt, /<preferences>\nBay Area only/);
  assert.match(prompt, /in English/);
  assert.match(buildRecommendPrompt({ resumes: [{ name: 'a', text: 'x' }] }), /\(none\)[\s\S]*Simplified Chinese/);
});

test('suggested boards that do not exist are dropped', async () => {
  const { http } = fakeHttp([
    ['boards/acmeai/jobs', { body: JSON.parse(fixture('greenhouse.json')) }],
    ['lever.co/v0/postings/ghost-co', { status: 404, body: '' }],
    ['ashbyhq.com', new Error('offline')],
  ]);
  const result = await checkBoards([{ name: 'Acme AI', ats: 'greenhouse', slug: 'acmeai' }, { name: 'Ghost', ats: 'lever', slug: 'ghost-co' },
    { name: 'Later', ats: 'ashby', slug: 'later' }], { http });
  assert.equal(result.dropped, 1);
  assert.deepEqual(result.companies.map(company => [company.slug, company.openJobs]), [['acmeai', 2], ['later', null]]);
});

test('suggestions through the API are stored until asked again', async () => {
  const { http } = fakeHttp([
    ['boards/acmeai/jobs', { body: JSON.parse(fixture('greenhouse.json')) }],
    ['lever.co/v0/postings/ghost-co', { status: 404, body: '' }],
  ]);
  const asked = [];
  const provider = { id: 'claude-cli', status: async () => ({ available: true, detail: 'test' }),
    ask: async request => { asked.push(request); return { value: REPLY, provider: 'claude-cli', model: 'claude-opus-5-5' }; } };
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')), notify: () => {}, log: () => {},
    http, detectJobspy: async () => ({ available: false }), providers: { 'claude-cli': provider } });
  const url = await app.listen(0);
  const { csrfToken } = await (await fetch(`${url}/api/bootstrap`)).json();
  const call = async (method, body) => {
    const response = await fetch(`${url}/api/recommendations`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-dayjob-token': csrfToken },
      body: method === 'GET' ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.deepEqual((await call('GET')).body, { result: null, running: false });
    assert.equal((await call('POST', {})).status, 409, 'needs a resume');
    app.repo.addResume({ name: 'cv.txt', mime: 'text/plain', size: 1, text: RESUME });
    assert.equal((await call('POST', { preference: 'x'.repeat(501) })).status, 400);
    const made = await call('POST', { preference: ' Bay Area ' });
    assert.equal(made.status, 200);
    assert.equal(made.body.result.searches.length, 2);
    assert.deepEqual(made.body.result.companies.map(company => company.slug), ['acmeai']);
    assert.equal(made.body.result.dropped, 1);
    assert.equal(made.body.result.preference, 'Bay Area');
    assert.match(asked[0].prompt, /Data analyst intern/);
    assert.match(asked[0].prompt, /<preferences>\nBay Area/);
    assert.equal(asked[0].schema, RECOMMEND_SCHEMA);
    assert.equal((await call('GET')).body.result.createdAt, made.body.result.createdAt);
  } finally { await app.close(); }
});
