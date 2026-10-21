import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clock, memoryRepo } from './helpers.mjs';
import { openDatabase, SCHEMA_VERSION } from '../server/jobs/db.mjs';
import { createRepository } from '../server/jobs/repository.mjs';
import { dedupeKey, guessSalary, htmlToText, isoDay, posting } from '../server/jobs/normalize.mjs';
import { boardQuery, companyJobMatches, locationMatches, titleMatches } from '../server/jobs/matching.mjs';

const job = (fields = {}) => posting({ site: 'linkedin', externalId: '1', title: 'Data Scientist', company: 'Acme Inc.', city: 'San Francisco',
  location: 'San Francisco, CA', jobUrl: 'https://www.linkedin.com/jobs/view/1', datePosted: '2026-10-20', description: 'Python', ...fields });

test('normalizing board data', () => {
  assert.equal(isoDay('2026-10-20'), '2026-10-20');
  assert.equal(isoDay(1760918400000), '2025-10-20T00:00:00.000Z');
  assert.equal(isoDay('nonsense'), null);
  assert.throws(() => posting({ site: 'x', externalId: 1, title: '', jobUrl: 'https://a' }), /title/);
  assert.throws(() => posting({ site: 'x', externalId: 1, title: 'A', jobUrl: 'javascript:alert(1)' }), /URL/);
  assert.equal(htmlToText('<script>alert(1)</script><p>Hi <b>there</b>.</p>'), 'Hi **there**.');
  assert.equal(htmlToText('&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;'), '- One');
  assert.deepEqual(guessSalary('Pay is $120,000 - $150,000 per year'), { min: 120000, max: 150000, interval: 'yearly', currency: 'USD', source: 'description' });
  assert.deepEqual(guessSalary('$45 - $60 an hour'), { min: 45, max: 60, interval: 'hourly', currency: 'USD', source: 'description' });
  assert.equal(guessSalary('$5 - $900000000'), null);
  assert.equal(dedupeKey({ company: 'Acme, Inc.', title: 'Data Scientist', city: 'San Francisco' }), dedupeKey({ company: 'ACME', title: 'data scientist', location: 'San Francisco' }));
});

test('matching company-board jobs against saved searches', () => {
  assert.equal(boardQuery('data scientist, analyst'), '"data scientist" OR analyst');
  assert.equal(titleMatches('Senior Data Scientist, Ads', 'data scientist'), true);
  assert.equal(titleMatches('Data Engineer', 'data scientist, ml engineer'), false);
  assert.equal(titleMatches('Machine Learning Engineer', 'machine learning'), true);
  const search = { keywords: 'data scientist', location: 'San Francisco Bay Area', excludeKeywords: ['senior'], titleInclude: [], hoursOld: 72 };
  const now = new Date('2026-10-21T12:00:00Z');
  assert.equal(companyJobMatches(job({ location: 'Palo Alto, CA' }), search, now), true);
  assert.equal(companyJobMatches(job({ title: 'Senior Data Scientist' }), search, now), false);
  assert.equal(companyJobMatches(job({ location: 'Austin, TX' }), search, now), false);
  assert.equal(companyJobMatches(job({ datePosted: '2026-10-01' }), search, now), false);
  assert.equal(locationMatches({ location: 'New York, NY' }, { location: 'NY' }), true);
  assert.equal(locationMatches({ location: 'Remote - US', isRemote: true }, { isRemote: true }), true);
  assert.equal(locationMatches({ location: 'Seattle, WA' }, { location: 'United States' }), true);
});

test('migrations run once and refuse a newer database', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-db-'));
  const first = openDatabase(directory);
  assert.equal(first.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  first.db.close();
  const again = openDatabase(directory);
  again.db.close();
  const raw = new DatabaseSync(path.join(directory, 'dayjob.sqlite'));
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => openDatabase(directory), /newer Dayjob/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('postings upsert, dedupe across boards, reopen and filter', () => {
  const now = clock('2026-10-21T16:00:00Z');
  const { repo } = memoryRepo(now);
  const search = repo.saveSearch({ name: 'DS', keywords: 'data scientist', sites: ['linkedin', 'indeed'] });
  const first = repo.upsertPosting(job(), search.id);
  assert.deepEqual(first, { id: 'li-1', isNew: true, reopened: false });
  assert.equal(repo.upsertPosting(job({ description: null }), search.id).isNew, false);
  assert.equal(repo.getPosting('li-1').description, 'Python', 'a later run without a description keeps the old one');

  const twin = repo.upsertPosting(job({ site: 'indeed', externalId: 'abc', jobUrl: 'https://www.indeed.com/viewjob?jk=abc' }), search.id);
  assert.equal(twin.isNew, false, 'the same job on another board is a duplicate, not new');
  assert.equal(repo.listPostings().total, 1);
  assert.equal(repo.listPostings({ includeDuplicates: true }).total, 2);
  assert.deepEqual(repo.getPosting('li-1').duplicates.map(item => item.site), ['indeed']);

  repo.markChecked('li-1', false);
  assert.ok(repo.getPosting('li-1').closedAt);
  assert.equal(repo.listPostings({ includeClosed: false }).total, 0);
  assert.equal(repo.upsertPosting(job(), search.id).reopened, true);
  assert.equal(repo.getPosting('li-1').closedAt, null);

  repo.upsertPosting(job({ externalId: '2', title: 'ML Engineer', company: 'Nimbus', jobUrl: 'https://www.linkedin.com/jobs/view/2', datePosted: null }));
  assert.equal(repo.listPostings({ q: 'nimbus' }).total, 1);
  assert.equal(repo.listPostings({ searchId: search.id }).total, 1);
  repo.setPostingStatus('li-2', 'dismissed');
  assert.equal(repo.listPostings().total, 1);
  assert.equal(repo.listPostings({ status: 'dismissed' }).total, 1);

  now.advance(60 * 864e5);
  repo.upsertPosting(job({ externalId: '3', title: 'Fresh', company: 'New Co', jobUrl: 'https://www.linkedin.com/jobs/view/3' }));
  assert.equal(repo.purgeOldPostings(45), 3, 'old new and dismissed postings, twins included, are purged');
  assert.equal(repo.listPostings({ status: 'all', includeDuplicates: true }).total, 1);
});

test('company boards close jobs that disappear', () => {
  const { repo } = memoryRepo();
  const gh = (id, slug = 'acme') => posting({ site: 'greenhouse', externalId: `${slug}-${id}`, title: `Job ${id}`, company: slug, jobUrl: `https://job-boards.greenhouse.io/${slug}/jobs/${id}` });
  repo.upsertPosting(gh(1));
  repo.upsertPosting(gh(2));
  repo.upsertPosting(gh(9, 'acme-labs'));
  const closed = repo.markUnseenCompanyJobsClosed('greenhouse', 'acme', ['gh-acme-1']);
  assert.deepEqual(closed, ['gh-acme-2']);
  assert.equal(repo.getPosting('gh-acme-labs-9').closedAt, null, 'another company with a prefix-sharing slug is untouched');
});

test('applications record a timeline and keep follow-ups current', () => {
  const now = clock('2026-10-21T16:00:00Z');
  const { repo } = memoryRepo(now);
  repo.upsertPosting(job());
  repo.upsertPosting(job({ site: 'indeed', externalId: 'abc', jobUrl: 'https://www.indeed.com/viewjob?jk=abc' }));
  const application = repo.createApplication({ postingId: 'li-1', company: 'Acme', title: 'Data Scientist', followUpDays: 7, note: 'referral' });
  assert.equal(application.status, 'applied');
  assert.equal(application.nextFollowUpAt, '2026-10-28T16:00:00.000Z');
  assert.equal(repo.getPosting('li-1').status, 'applied');
  assert.equal(repo.getPosting('in-abc').status, 'applied', 'duplicates are marked too');
  assert.equal(repo.listPostings().total, 0);

  repo.setApplicationFlags(application.id, ['follow-up-due', 'ghost-suspected']);
  now.advance(3 * 864e5);
  const moved = repo.updateApplication(application.id, { status: 'interview', note: 'Phone screen' }, 'mcp');
  assert.deepEqual(moved.flags, []);
  assert.equal(moved.nextFollowUpAt, '2026-10-31T16:00:00.000Z', 'a new stage gets a fresh follow-up');
  assert.deepEqual(moved.events.map(event => `${event.source}:${event.toStatus}`), ['mcp:interview', 'user:applied']);

  const rejected = repo.updateApplication(application.id, { status: 'rejected' });
  assert.equal(rejected.nextFollowUpAt, null);
  repo.updateApplication(application.id, { note: 'Asked for feedback' });
  assert.equal(repo.getApplication(application.id).events[0].type, 'note');
  assert.equal(repo.listApplications({ open: true }).length, 0);
  assert.equal(repo.stats().applications.rejected, 1);

  assert.equal(repo.deleteApplication(application.id), true);
  assert.equal(repo.getPosting('li-1').status, 'saved', 'a deleted application leaves the job saved');
});

test('resumes switch and scores follow the active one', () => {
  const { repo } = memoryRepo();
  repo.upsertPosting(job());
  const first = repo.addResume({ name: 'a.pdf', mime: 'application/pdf', size: 1, text: 'A'.repeat(300) });
  repo.saveScore('li-1', first.id, { score: 80, verdict: 'good', summary: 's', strengths: ['x'], gaps: [], missingKeywords: [], provider: 'claude-cli' });
  assert.equal(repo.listPostings().items[0].score.score, 80);
  const second = repo.addResume({ name: 'b.pdf', mime: 'application/pdf', size: 1, text: 'B'.repeat(300) });
  assert.equal(repo.activeResume().id, second.id);
  assert.equal(repo.listPostings().items[0].score, null);
  assert.deepEqual(repo.unscoredPostingIds(second.id, 10), ['li-1']);
  repo.activateResume(first.id);
  assert.equal(repo.getPosting('li-1').score.score, 80);
  repo.deleteResume(first.id);
  assert.equal(repo.activeResume().id, second.id);
  assert.equal(repo.getScore('li-1', first.id), null, 'scores are deleted with their resume');
});

test('settings merge with defaults and runs record results', () => {
  const { repo } = memoryRepo();
  assert.equal(repo.getSettings().tracking.followUpDays, 7);
  repo.updateSettings({ tracking: { ghostDays: 30 } });
  assert.deepEqual([repo.getSettings().tracking.followUpDays, repo.getSettings().tracking.ghostDays], [7, 30]);
  const run = repo.startRun('search', 'manual');
  repo.abandonRunningRuns();
  assert.equal(repo.listRuns()[0].status, 'failed');
  const finished = repo.finishRun(run, { status: 'partial', found: 3, newCount: 2, detail: [{ source: 'x', error: 'y' }] });
  assert.equal(finished.newCount, 2);
});
