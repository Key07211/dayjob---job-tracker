import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import autofill from '../desktop/autofill.cjs';
import { createApp } from '../server/app.mjs';
import { contactFromResume, DEFAULT_APPLICANT } from '../server/jobs/applicant.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { settingsPatch } from '../server/validation.mjs';
import { memoryRepo } from './helpers.mjs';

const { autofillScript, keyFor, optionFor, planFill } = autofill;

const PROFILE = { ...DEFAULT_APPLICANT, firstName: 'Yuan', lastName: 'Li', email: 'yuan@example.com', phone: '+1 510 555 0100',
  city: 'Berkeley', state: 'CA', country: 'United States', linkedin: 'https://www.linkedin.com/in/yuan', website: 'https://yuan.dev',
  school: 'University of California, Berkeley', degree: 'Master of Engineering', major: 'Industrial Engineering', graduation: 'May 2026',
  yearsExperience: '3', workAuthorized: 'yes', needsSponsorship: 'no', willingToRelocate: 'yes', startDate: 'June 2026', heardFrom: 'LinkedIn' };

let next = 0;
const field = (label, extra = {}) => ({ index: next++, frame: 0, kind: 'text', type: 'text', label, name: '', id: '', placeholder: '', autocomplete: '', required: false, filled: false, ...extra });
const choice = (label, options, extra = {}) => field(label, { kind: 'select', type: 'select', options, ...extra });

test('form fields are matched to the application profile by their labels', () => {
  assert.equal(keyFor(field('First Name *')), 'firstName');
  assert.equal(keyFor(field('', { name: 'job_application[last_name]' })), 'lastName');
  assert.equal(keyFor(field('Contact', { autocomplete: 'section-a email' })), 'email');
  assert.equal(keyFor(field('Preferred First Name')), 'preferredName');
  assert.equal(keyFor(field('LinkedIn Profile')), 'linkedin');
  assert.equal(keyFor(field('Are you legally authorized to work in the United States without visa sponsorship?')), 'authorizedWithoutSponsorship');
  assert.equal(keyFor(field('Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?')), 'needsSponsorship');
  assert.equal(keyFor(field('Emergency contact phone')), null, 'questions about someone else are left alone');
  assert.equal(keyFor(field('Name of referrer')), null);
  assert.equal(keyFor(field('Referred by')), null);
  assert.equal(keyFor(field('姓名')), 'fullName');
  assert.equal(keyFor(field('Why do you want to work here?')), null);

  assert.equal(optionFor('country', 'USA', ['Select...', 'Canada', 'United States', 'China']), 2);
  assert.equal(optionFor('state', 'CA', ['Arizona', 'California', 'Colorado']), 1);
  assert.equal(optionFor('state', 'California', ['AZ', 'CA', 'CO']), 1);
  assert.equal(optionFor('needsSponsorship', 'no', ['--', 'Yes', 'No']), 2);
  assert.equal(optionFor('yearsExperience', '3', ['Less than 1 year', '1-2 years', '3-5 years', '6+ years']), 2);
  assert.equal(optionFor('yearsExperience', '8', ['0-1', '2-4', '5+']), 2);
  assert.equal(optionFor('degree', 'Master of Engineering', ['High School', "Bachelor's Degree", "Master's Degree", 'PhD']), 2);
  assert.equal(optionFor('graduation', 'May 2026', ['2025', '2026', '2027']), 1);
  assert.equal(optionFor('eeoGender', 'decline', ['Male', 'Female', 'Decline To Self Identify']), 2);
  assert.equal(optionFor('eeoVeteran', 'decline', ['I am a protected veteran', "I don't wish to answer"]), 1);
  assert.equal(optionFor('heardFrom', 'LinkedIn', ['Job board', 'LinkedIn', 'Referral']), 1);
  assert.equal(optionFor('country', 'Narnia', ['United States', 'Canada']), -1);
});

test('the fill plan only answers empty fields it is sure about', () => {
  const fields = [
    field('First Name *', { required: true }), field('Last Name *', { required: true }), field('Email', { type: 'email', required: true }),
    field('Phone', { type: 'tel' }), field('LinkedIn Profile'), field('Website', { filled: true }), field('Resume/CV', { kind: 'file', type: 'file', required: true }),
    choice('Are you legally authorized to work in the United States?', ['Select...', 'Yes', 'No']),
    choice('Will you now or in the future require sponsorship?', ['--', 'Yes', 'No']),
    field('Are you willing to relocate?', { kind: 'radio', type: 'radio', options: ['Yes', 'No'] }),
    field('Do you require sponsorship?'), choice('Country', ['Canada', 'United States']), choice('Gender', ['Male', 'Female', 'Decline To Self Identify']),
    field('Emergency contact phone'), field('Years of experience', { type: 'number' }), field('Expected salary'),
    field('Cover letter', { type: 'text' }), field('Cover letter', { type: 'textarea' }), field('Location (City)'), field('Full legal name'),
    { ...choice('State', ['Arizona', 'California']), frame: 1 },
  ];
  const { fills, used } = planFill(fields, { ...PROFILE, coverLetter: 'Dear team' });
  const byLabel = Object.fromEntries(fills.map(item => [fields.find(entry => entry.index === item.index).label + (item.frame ? ' (frame 1)' : ''), item.value ?? item.option]));
  assert.deepEqual(byLabel, {
    'First Name *': 'Yuan', 'Last Name *': 'Li', Email: 'yuan@example.com', Phone: '+1 510 555 0100', 'LinkedIn Profile': 'https://www.linkedin.com/in/yuan',
    'Are you legally authorized to work in the United States?': 1, 'Will you now or in the future require sponsorship?': 2, 'Are you willing to relocate?': 0,
    Country: 1, Gender: 2, 'Years of experience': '3', 'Cover letter': 'Dear team', 'Location (City)': 'Berkeley', 'Full legal name': 'Yuan Li',
    'State (frame 1)': 1,
  });
  assert.equal(fills.find(item => item.frame === 1).index, fields.at(-1).index, 'each fill names the frame its field is in');
  assert.ok(!used.some(item => item.label === 'Do you require sponsorship?'), 'a yes / no answer never goes into a text box');
  assert.ok(!used.some(item => item.key === 'salary'), 'empty profile entries are skipped');
  assert.equal(planFill(fields, { ...PROFILE, declineEeo: false }).fills.some(item => fields.find(entry => entry.index === item.index).label === 'Gender'), false);
  assert.doesNotThrow(() => new Function(autofillScript('dayjobAutofillTest', 'fill', [{ index: 0, value: 'x' }])), 'the page script is valid JavaScript');
});

test('contact details are read from a resume', () => {
  assert.deepEqual(contactFromResume('Yuan Li\nBerkeley, CA · yuan.li@berkeley.edu · (510) 555-0100\nlinkedin.com/in/yuan-li · github.com/yuanli\nEducation 2024 - 2026'), {
    email: 'yuan.li@berkeley.edu', phone: '(510) 555-0100', linkedin: 'https://linkedin.com/in/yuan-li', github: 'https://github.com/yuanli', firstName: 'Yuan', lastName: 'Li',
  });
  assert.deepEqual(contactFromResume('李远锦\n电话 +86 138 0013 8000'), { phone: '+86 138 0013 8000', lastName: '李', firstName: '远锦' });
  assert.deepEqual(contactFromResume('RESUME OF A DATA SCIENTIST WITH TEN YEARS\nCall 2024-2026'), {}, 'a heading is not a name and a year range is not a phone');
});

test('a web page finds the posting it belongs to', () => {
  const { repo } = memoryRepo();
  const add = (site, externalId, jobUrl, applyUrl) => repo.upsertPosting(posting({ site, externalId, title: 'Analyst', company: `Acme ${site}`, jobUrl, applyUrl }));
  add('linkedin', '4100000001', 'https://www.linkedin.com/jobs/view/4100000001');
  add('indeed', 'abc123', 'https://www.indeed.com/viewjob?jk=abc123');
  add('company', 'greenhouse:acme:77', 'https://boards.greenhouse.io/acme/jobs/77', 'https://boards.greenhouse.io/acme/jobs/77#app');
  const found = url => repo.findPostingByUrl(url)?.id ?? null;
  assert.equal(found('https://www.linkedin.com/jobs/view/4100000001/?refId=x'), 'li-4100000001');
  assert.equal(found('https://www.linkedin.com/jobs/view/data-analyst-at-acme-4100000001'), 'li-4100000001');
  assert.equal(found('https://www.linkedin.com/jobs/search/?currentJobId=4100000001&keywords=analyst'), 'li-4100000001');
  assert.equal(found('https://www.indeed.com/viewjob?jk=abc123&from=serp'), 'in-abc123');
  assert.equal(found('https://www.indeed.com/viewjob?jk=zzz'), null, 'another Indeed job on the same path');
  assert.equal(found('https://boards.greenhouse.io/acme/jobs/77?gh_src=1#app'), repo.listPostings({ site: 'company' }).items[0].id);
  assert.equal(found('https://boards.greenhouse.io/acme/jobs/7'), null);
  assert.equal(found('not a url'), null);
});

test('the application profile is validated, and pages look up their posting', async () => {
  assert.deepEqual(settingsPatch({ applicant: { firstName: ' Yuan ', linkedin: 'linkedin.com/in/yuan', workAuthorized: 'yes', declineEeo: false } }).applicant,
    { firstName: 'Yuan', linkedin: 'https://linkedin.com/in/yuan', workAuthorized: 'yes', declineEeo: false });
  assert.throws(() => settingsPatch({ applicant: { email: 'yuan at example' } }), /name@example\.com/);
  assert.throws(() => settingsPatch({ applicant: { website: 'javascript:alert(1)' } }), /web link/);
  assert.throws(() => settingsPatch({ applicant: { needsSponsorship: 'maybe' } }), /yes, no or empty/);
  assert.throws(() => settingsPatch({ applicant: { firstName: 'x'.repeat(81) } }), /80/);

  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')),
    notify: () => {}, log: () => {}, detectJobspy: async () => ({ available: false }) });
  const url = await app.listen(0);
  const { csrfToken, settings } = await (await fetch(`${url}/api/bootstrap`)).json();
  const call = async (pathname, method = 'GET', body) => {
    const response = await fetch(`${url}${pathname}`, { method, body: body && JSON.stringify(body),
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-dayjob-token': csrfToken } });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.deepEqual(settings.applicant, DEFAULT_APPLICANT, 'an empty profile that declines self-identification questions');
    const saved = await call('/api/settings', 'PATCH', { applicant: { firstName: 'Yuan', email: 'yuan@example.com' } });
    assert.deepEqual([saved.body.applicant.firstName, saved.body.applicant.email, saved.body.applicant.declineEeo], ['Yuan', 'yuan@example.com', true]);

    const resume = Buffer.from(`Yuan Li\nyuan@example.com | 510-555-0100\n${'Data scientist. Python, SQL, experimentation, forecasting. '.repeat(12)}`).toString('base64');
    assert.equal((await call('/api/resumes', 'POST', { name: 'cv.txt', mime: 'text/plain', data: resume })).status, 201);
    assert.deepEqual((await call('/api/applicant/from-resume')).body, { email: 'yuan@example.com', phone: '510-555-0100', firstName: 'Yuan', lastName: 'Li' });

    const job = (await call('/api/postings', 'POST', { title: 'Data Analyst', company: 'Acme', jobUrl: 'https://jobs.lever.co/acme/1234', status: 'saved' })).body;
    const lookup = page => call(`/api/postings/lookup?url=${encodeURIComponent(page)}`);
    assert.deepEqual((await lookup('https://jobs.lever.co/acme/1234/apply?source=x')).body, { posting: null }, 'the apply page is a different path');
    const known = (await lookup('https://jobs.lever.co/acme/1234?lever-source=LinkedIn')).body.posting;
    assert.deepEqual([known.id, known.title, known.company, known.status, known.application], [job.id, 'Data Analyst', 'Acme', 'saved', null]);
    await call(`/api/postings/${job.id}/apply`, 'POST', {});
    const applied = (await lookup('https://jobs.lever.co/acme/1234')).body.posting;
    assert.equal(applied.application.status, 'applied');
  } finally { await app.close(); }
});
