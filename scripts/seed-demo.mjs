// Fills a separate data folder with made-up postings and applications, for
// screenshots and trying the interface without scraping:
//   node scripts/seed-demo.mjs ./demo-data && DAYJOB_DATA_DIR=./demo-data npm start
import path from 'node:path';
import { openDatabase } from '../server/jobs/db.mjs';
import { createRepository } from '../server/jobs/repository.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { localDay } from '../server/jobs/scheduler.mjs';

const directory = path.resolve(process.argv[2] || 'demo-data');
const DAY = 864e5;
const base = Date.now();
const ago = days => new Date(base - days * DAY).toISOString();
const day = days => ago(days).slice(0, 10);
let clockOffset = 0;
const { db } = openDatabase(directory);
const repo = createRepository(db, { now: () => new Date(base - clockOffset) });
const at = (days, work) => { clockOffset = days * DAY; const result = work(); clockOffset = 0; return result; };

if (repo.listPostings({ status: 'all' }).total) {
  console.log(`${directory} already has data; nothing changed.`);
  process.exit(0);
}

const search = repo.saveSearch({ name: 'Data Scientist · 湾区', keywords: 'data scientist, machine learning engineer', location: 'San Francisco Bay Area',
  sites: ['linkedin', 'indeed'], hoursOld: 72, excludeKeywords: ['senior', 'staff', 'principal'] });
const nyc = repo.saveSearch({ name: 'Data Analyst · 纽约', keywords: 'data analyst, business intelligence', location: 'New York, NY', sites: ['linkedin', 'indeed'], hoursOld: 168 });
repo.addCompany({ name: 'Northwind AI', ats: 'greenhouse', slug: 'northwindai' });
repo.addCompany({ name: 'Brightline', ats: 'lever', slug: 'brightline' });

const description = (team, must, nice) => `## About the team\n\n${team}\n\n## What you'll do\n\n- Build and ship models that power product decisions\n- Design experiments and read out results with product partners\n- Own data pipelines from raw events to features\n\n## You have\n\n${must.map(item => `- ${item}`).join('\n')}\n\n## Nice to have\n\n${nice.map(item => `- ${item}`).join('\n')}\n\n**Visa sponsorship:** available for this role.`;

const jobs = [
  { site: 'linkedin', externalId: '4100000001', title: 'Data Scientist, Product Analytics', company: 'Lumen Health', location: 'San Francisco, CA', city: 'San Francisco',
    salary: { min: 145000, max: 185000, interval: 'yearly', currency: 'USD' }, jobType: 'fulltime', jobLevel: 'entry level', datePosted: day(1), seen: 1, search,
    score: [88, 'strong', '简历里的 A/B 测试和 Python/SQL 经验与岗位核心要求高度一致，学历也满足。', ['A/B testing 项目经验', 'Python、SQL 熟练', '统计学硕士'], ['没有医疗行业经验'], ['causal inference', 'dbt']] },
  { site: 'indeed', externalId: 'c0ffee0000000002', title: 'Machine Learning Engineer, New Grad', company: 'Northwind AI', location: 'Palo Alto, CA', city: 'Palo Alto',
    salary: { min: 150000, max: 190000, interval: 'yearly', currency: 'USD' }, jobType: 'fulltime', datePosted: day(2), seen: 2, search,
    score: [76, 'good', 'PyTorch 和模型训练经验匹配；岗位更看重分布式训练，简历里只有单机项目。', ['PyTorch 项目', '计算机视觉课程项目'], ['缺少分布式训练经验', '没有大规模线上服务经验'], ['Ray', 'Kubernetes', 'CUDA']] },
  { site: 'linkedin', externalId: '4100000003', title: 'Data Scientist I', company: 'Harbor Logistics', location: 'Oakland, CA', city: 'Oakland', isRemote: false,
    jobType: 'fulltime', datePosted: day(0), seen: 0, search, score: [69, 'good', '基础要求都满足，但岗位偏供应链预测。', ['时间序列预测课程项目', 'SQL'], ['没有供应链领域经验'], ['demand forecasting']] },
  { site: 'greenhouse', externalId: 'northwindai-7000004', title: 'Research Engineer, Evaluations', company: 'Northwind AI', location: 'San Francisco, CA', city: 'San Francisco',
    salary: { min: 170000, max: 230000, interval: 'yearly', currency: 'USD' }, datePosted: day(4), seen: 3, search,
    score: [54, 'stretch', '要求 2 年以上研究工程经验，简历以课程和实习为主。', ['Python', '读过并复现论文'], ['经验年限不足', '没有发表论文'], ['LLM evaluation', 'JAX']] },
  { site: 'linkedin', externalId: '4100000005', title: 'Data Analyst', company: 'Cobalt Bank', location: 'New York, NY', city: 'New York',
    salary: { min: 90000, max: 115000, interval: 'yearly', currency: 'USD' }, jobType: 'fulltime', datePosted: day(1), seen: 1, search: nyc,
    score: [81, 'good', 'SQL、Tableau 与岗位一致；金融背景是加分项但不是必需。', ['SQL 与 Tableau 仪表盘', '业务分析实习'], ['岗位写明不提供签证担保'], ['Looker']] },
  { site: 'indeed', externalId: 'c0ffee0000000006', title: 'Business Intelligence Intern (Summer 2027)', company: 'Meridian Media', location: 'New York, NY', city: 'New York',
    salary: { min: 32, max: 38, interval: 'hourly', currency: 'USD', source: 'estimate' }, jobType: 'internship', datePosted: day(5), seen: 5, search: nyc },
  { site: 'lever', externalId: 'brightline-5b7d0b0e-6c1f-4e9e-9f8a-1b2c3d4e5f60', title: 'Senior Data Scientist, Pricing', company: 'Brightline', location: 'Remote - US', isRemote: true,
    datePosted: day(6), seen: 6, search, score: [38, 'weak', '要求 6 年以上经验和定价模型背景，级别差距大。', ['统计建模'], ['资历要求 6 年以上', '没有定价经验'], []] },
];

const ids = {};
for (const item of jobs) {
  const value = posting({ ...item, jobUrl: item.site === 'linkedin' ? `https://www.linkedin.com/jobs/view/${item.externalId}` : item.site === 'indeed'
    ? `https://www.indeed.com/viewjob?jk=${item.externalId}` : `https://example.com/jobs/${item.externalId}`,
  description: description(`${item.company} is a growing team working on ${item.title.toLowerCase()} problems.`,
    ['BS/MS in Statistics, Computer Science or a related field', 'Strong Python and SQL', 'Experience with experimentation or ML modeling'],
    ['Experience with dbt or Airflow', 'Industry experience in the domain']) });
  const stored = at(item.seen, () => repo.upsertPosting(value, item.search.id));
  ids[item.externalId] = stored.id;
}

const resume = repo.addResume({ name: 'Jane_Doe_Resume.pdf', mime: 'application/pdf', size: 84211,
  text: `Jane Doe\nM.S. Statistics, 2026\n\nExperience\n- Data Science Intern, Lumen Labs: built churn models in Python, ran A/B tests.\n- Research Assistant: computer vision with PyTorch.\n\nSkills: Python, SQL, PyTorch, Tableau, experimentation, forecasting.\n${'Additional project details. '.repeat(20)}` });
for (const item of jobs.filter(entry => entry.score)) {
  const [score, verdict, summary, strengths, gaps, missingKeywords] = item.score;
  repo.saveScore(ids[item.externalId], resume.id, { score, verdict, summary, strengths, gaps, missingKeywords, provider: 'claude-cli', model: 'claude-opus-5-5' });
}
repo.setPostingStatus(ids['4100000005'], 'saved');

// Applications in different stages, with their history.
const apply = (title, company, daysAgo, extra = {}) => at(daysAgo, () => repo.createApplication({ company, title, jobUrl: `https://example.com/${company.toLowerCase().replace(/\W+/g, '-')}`,
  appliedAt: ago(daysAgo), followUpDays: 7, note: extra.note || '', ...extra }));
const interview = apply('Data Scientist, Growth', 'Pinecone Payments', 16, { note: '内推：Alex (校友)' });
at(9, () => repo.updateApplication(interview.id, { status: 'oa', note: 'HackerRank SQL + Python，90 分钟' }));
at(4, () => repo.updateApplication(interview.id, { status: 'interview', note: '电话面试：和招聘经理 45 分钟' }, 'mcp'));
const quiet = apply('Applied Scientist', 'Riverstone Retail', 24);
at(0, () => repo.setApplicationFlags(quiet.id, ['follow-up-due', 'ghost-suspected']));
at(0, () => repo.addEvent(quiet.id, { type: 'ghost-suspected', note: 'No response for 24 days.', source: 'auto' }));
const followUp = apply('Machine Learning Engineer', 'Atlas Robotics', 9);
at(0, () => repo.setApplicationFlags(followUp.id, ['follow-up-due']));
const rejected = apply('Data Scientist', 'Vega Insurance', 30);
at(12, () => repo.updateApplication(rejected.id, { status: 'rejected', note: '自动拒信邮件' }, 'mcp'));
const offer = apply('Quantitative Analyst', 'Kestrel Capital', 40);
at(30, () => repo.updateApplication(offer.id, { status: 'interview', note: 'Superday' }));
at(2, () => repo.updateApplication(offer.id, { status: 'offer', note: '口头 offer，等待书面' }));
const fromFeed = at(1, () => repo.createApplication({ postingId: ids['4100000001'], company: 'Lumen Health', title: 'Data Scientist, Product Analytics',
  jobUrl: 'https://www.linkedin.com/jobs/view/4100000001', appliedAt: ago(1), resumeId: resume.id, followUpDays: 7 }));
void fromFeed;

const run = repo.startRun('search', 'schedule');
repo.finishRun(run, { status: 'partial', found: 7, newCount: 5, scored: 6, detail: [
  { source: 'Data Scientist · 湾区 · linkedin', found: 3, new: 2, warnings: [] },
  { source: 'Data Scientist · 湾区 · indeed', found: 1, new: 1, warnings: [] },
  { source: 'Data Analyst · 纽约 · linkedin', found: 1, new: 1, warnings: [] },
  { source: 'Data Analyst · 纽约 · indeed', error: 'HTTP 429 (the site is limiting requests; try again later)', blocked: true },
  { source: 'Northwind AI · greenhouse', found: 1, new: 1, listed: 38, closed: 2 },
] });
repo.addNotification({ kind: 'daily', title: 'Dayjob：5 个新岗位，2 个高匹配', body: 'Lumen Health Data Scientist, Product Analytics (88)；Cobalt Bank Data Analyst (81)' });
repo.addNotification({ kind: 'follow-up', title: '该跟进了：Atlas Robotics', body: 'Machine Learning Engineer 已经 9 天没有进展。', refId: followUp.id });
repo.addNotification({ kind: 'ghost', title: '可能没有回音：Riverstone Retail', body: 'Applied Scientist 投递 24 天无回复，可在 Dayjob 中标记为 ghosted 或继续等待。', refId: quiet.id });
repo.setMeta('lastDailyRun', { day: localDay(new Date()), startedAt: new Date().toISOString() });
db.close();
console.log(`Demo data written to ${directory}`);
