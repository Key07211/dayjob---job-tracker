// Checks every source against the real sites with a handful of results each,
// so scraper breakage shows up before the daily run hits it:
//   npm run live-check                         # boards + company pages
//   npm run live-check -- --pipeline           # also a full run into a temporary database
//   npm run live-check -- --score resume.pdf   # also score one posting with Claude Code
//   npm run live-check -- --jobspy             # also try the Python JobSpy bridge
// Writes a JSON report next to the console summary (--out report.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHttp } from '../server/jobs/scrapers/http-client.mjs';
import { linkedin } from '../server/jobs/scrapers/linkedin.mjs';
import { indeed } from '../server/jobs/scrapers/indeed.mjs';
import { checkCompanyJob, fetchCompanyBoard } from '../server/jobs/scrapers/company-boards.mjs';
import { createJobspyBridge, detectJobspy } from '../server/jobs/scrapers/jobspy-bridge.mjs';
import { boardQuery } from '../server/jobs/matching.mjs';

const { values } = parseArgs({ options: {
  keywords: { type: 'string', default: 'data scientist' },
  location: { type: 'string', default: 'San Francisco Bay Area' },
  results: { type: 'string', default: '5' },
  greenhouse: { type: 'string', default: 'stripe' },
  lever: { type: 'string', default: 'palantir' },
  ashby: { type: 'string', default: 'openai' },
  pipeline: { type: 'boolean', default: false },
  score: { type: 'string' },
  jobspy: { type: 'boolean', default: false },
  python: { type: 'string', default: process.platform === 'win32' ? 'python' : 'python3' },
  out: { type: 'string', default: 'live-check-report.json' },
} });

const http = createHttp();
const input = { keywords: boardQuery(values.keywords), location: values.location, hoursOld: 72, resultsWanted: Number(values.results) || 5 };
const report = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, input, checks: [] };
const logs = [];
const log = message => logs.push(message);

// How complete the stored fields are, so "found 5 jobs" also says whether
// dates, descriptions and salaries came through.
function completeness(postings) {
  const share = test => `${postings.filter(test).length}/${postings.length}`;
  return {
    datePosted: share(item => item.datePosted), description: share(item => (item.description || '').length > 200),
    salary: share(item => item.salary), location: share(item => item.location), companyLogo: share(item => item.companyLogo),
  };
}
const sample = item => item && { title: item.title, company: item.company, location: item.location, datePosted: item.datePosted,
  jobUrl: item.jobUrl, descriptionChars: (item.description || '').length, salary: item.salary || null };

async function check(name, work) {
  const started = Date.now();
  process.stdout.write(`${name} … `);
  try {
    const result = await work();
    report.checks.push({ name, ok: result.ok !== false, ms: Date.now() - started, ...result });
    console.log(result.ok === false ? `问题：${result.problem}` : `通过 (${result.summary || ''})`);
  } catch (error) {
    report.checks.push({ name, ok: false, ms: Date.now() - started, error: error.message, blocked: Boolean(error.blocked) });
    console.log(`失败：${error.message}`);
  }
}

async function board(scraper) {
  const { postings, warnings } = await scraper.search(input, { http, log });
  if (!postings.length) return { ok: false, problem: '没有返回岗位', warnings };
  const open = await scraper.checkOpen(postings[0], { http });
  return { ok: open !== false, problem: open === false ? '刚抓到的岗位被判断为已关闭' : undefined, found: postings.length, warnings,
    completeness: completeness(postings), checkOpen: open, sample: sample(postings[0]),
    summary: `${postings.length} 个岗位，发布日期 ${completeness(postings).datePosted}，描述 ${completeness(postings).description}，检查开放 = ${open}` };
}

async function company(ats, slug) {
  const item = { name: slug, ats, slug };
  const postings = await fetchCompanyBoard(item, { http, log });
  if (!postings.length) return { ok: false, problem: `${ats}/${slug} 没有公开岗位，换一个公司试试（--${ats} <slug>）` };
  const open = await checkCompanyJob(postings[0], { http });
  return { ok: open === true, problem: open === true ? undefined : `单个岗位检查返回 ${open}`, found: postings.length,
    completeness: completeness(postings), checkOpen: open, sample: sample(postings[0]),
    summary: `${postings.length} 个岗位，发布日期 ${completeness(postings).datePosted}，检查开放 = ${open}` };
}

await check('LinkedIn 搜索 + 岗位详情', () => board(linkedin));
await check('Indeed 搜索', () => board(indeed));
await check(`Greenhouse (${values.greenhouse})`, () => company('greenhouse', values.greenhouse));
await check(`Lever (${values.lever})`, () => company('lever', values.lever));
await check(`Ashby (${values.ashby})`, () => company('ashby', values.ashby));

if (values.jobspy) {
  await check('JobSpy（Python）', async () => {
    const found = await detectJobspy(values.python);
    if (!found.available) return { ok: false, problem: `${values.python} -m jobspy 无法运行；先 pip install python-jobspy` };
    const { postings } = await createJobspyBridge({ command: values.python }).search('glassdoor', input, { log });
    return { ok: postings.length > 0, problem: postings.length ? undefined : 'Glassdoor 没有返回岗位', found: postings.length,
      version: found.version, completeness: completeness(postings), sample: sample(postings[0]), summary: `JobSpy ${found.version}，Glassdoor ${postings.length} 个岗位` };
  });
}

let app = null;
let dataDir = null;
if (values.pipeline || values.score) {
  const { createApp } = await import('../server/app.mjs');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-live-'));
  app = await createApp({ dataDir, startScheduler: false, log, notify: () => {} });
}

if (values.score) {
  await check('Claude Code 打分', async () => {
    const { extractResumeText } = await import('../server/jobs/resume.mjs');
    const file = path.resolve(values.score);
    app.repo.addResume(await extractResumeText({ name: path.basename(file), mime: '', data: fs.readFileSync(file) }));
    const state = await app.scorer.status(true);
    if (!state.available) return { ok: false, problem: state.detail };
    const { postings } = await linkedin.search({ ...input, resultsWanted: 1 }, { http, log });
    if (!postings.length) return { ok: false, problem: 'LinkedIn 没有返回可以打分的岗位' };
    const stored = app.repo.upsertPosting(postings[0], null);
    const score = await app.scorer.score(stored.id, { force: true });
    return { ok: Number.isFinite(score?.score), detail: state.detail, posting: sample(postings[0]), score,
      summary: `${state.detail}：${postings[0].title} @ ${postings[0].company} = ${score?.score}` };
  });
}

if (values.pipeline) {
  await check('完整流程（搜索 → 公司 → 打分 → 追踪）', async () => {
    const search = app.repo.saveSearch({ name: 'Live check', keywords: values.keywords, location: values.location, sites: ['linkedin', 'indeed'],
      hoursOld: 72, resultsWanted: Number(values.results) || 5 });
    app.repo.addCompany({ name: values.greenhouse, ats: 'greenhouse', slug: values.greenhouse });
    const result = await app.scheduler.runNow({ track: true });
    const stored = app.repo.listPostings({ status: 'all', limit: 200 });
    const failed = result.run.detail.filter(entry => entry.error);
    return { ok: stored.total > 0 && failed.length < result.run.detail.length, problem: stored.total ? undefined : '没有保存任何岗位',
      searchId: search.id, run: result.run, scoring: result.scoring, tracking: result.tracking, stored: stored.total,
      summary: `保存 ${stored.total} 个岗位，${failed.length} 个来源出错，打分 ${result.scoring.scored}` };
  });
}

if (app) await app.close();
if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
report.finishedAt = new Date().toISOString();
report.logs = logs.slice(-50);
fs.writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
const failed = report.checks.filter(item => !item.ok);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} 项通过。报告：${path.resolve(values.out)}`);
process.exitCode = failed.length ? 1 : 0;
