import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import autofill from '../desktop/autofill.cjs';
import { createApp } from '../server/app.mjs';
import { contactFromResume, DEFAULT_APPLICANT, migrateApplicant, monthOf, normalizeProfile, PROFILE_SCHEMA } from '../server/jobs/applicant.mjs';
import { posting } from '../server/jobs/normalize.mjs';
import { settingsPatch } from '../server/validation.mjs';
import { memoryRepo } from './helpers.mjs';

const { autofillScript, keyFor, optionFor, planFill } = autofill;

const PROFILE = { ...DEFAULT_APPLICANT, firstName: 'Yuan', lastName: 'Li', email: 'yuan@example.com', phone: '+1 510 555 0100',
  city: 'Berkeley', state: 'CA', country: 'United States', linkedin: 'https://www.linkedin.com/in/yuan', website: 'https://yuan.dev',
  education: [{ school: 'University of California, Berkeley', degree: 'Master of Engineering', major: 'Industrial Engineering', start: '2025-08', end: '2026-05', gpa: '3.9/4.0' },
    { school: 'Tsinghua University', degree: 'Bachelor of Science', major: 'Mathematics', start: '2021-09', end: '2025-06', gpa: '' }],
  experience: [{ company: 'Acme', title: 'Data Science Intern', location: 'San Francisco, CA', start: '2025-06', end: '', current: true, summary: 'Built churn models\nShipped a dashboard' },
    { company: 'Beta Labs', title: 'Analyst', location: 'Beijing', start: '2023-01', end: '2024-12', current: false, summary: '' }],
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
  assert.deepEqual(settingsPatch({ applicant: { firstName: ' Yuan ', linkedin: ' yuan-li ', github: 'github.com/yuan', workAuthorized: 'yes', declineEeo: false } }).applicant,
    { firstName: 'Yuan', linkedin: 'yuan-li', github: 'https://github.com/yuan', workAuthorized: 'yes', declineEeo: false }, 'LinkedIn is kept as typed');
  assert.deepEqual(settingsPatch({ applicant: {
    education: [{ school: ' UC Berkeley ', degree: 'MEng', start: 'Aug 2025', end: '2026/5', _key: 'entry-1' }, { school: '', degree: '' }],
    experience: [{ company: 'Acme', title: 'Intern', start: '2025-06', end: '2025-09', current: true, summary: 'One\nTwo' }],
  } }).applicant, {
    education: [{ school: 'UC Berkeley', degree: 'MEng', major: '', start: '2025-08', end: '2026-05', gpa: '' }],
    experience: [{ company: 'Acme', title: 'Intern', location: '', start: '2025-06', end: '', current: true, summary: 'One\nTwo' }],
  }, 'entries keep their own fields, dates become months, empty entries go and a current job has no end');
  assert.throws(() => settingsPatch({ applicant: { education: [{ school: 'x', end: 'Spring 2026' }] } }), /2024-08 or 2024/);
  assert.throws(() => settingsPatch({ applicant: { experience: Array.from({ length: 11 }, () => ({ company: 'x' })) } }), /up to 10/);
  assert.throws(() => settingsPatch({ applicant: { experience: { company: 'x' } } }), /must be a list/);
  assert.throws(() => settingsPatch({ applicant: { email: 'yuan at example' } }), /name@example\.com/);
  assert.throws(() => settingsPatch({ applicant: { website: 'javascript:alert(1)' } }), /web link/);
  assert.throws(() => settingsPatch({ applicant: { github: 'yuan li' } }), /http\(s\) link/);
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

test('schools and jobs fill their own parts of a form, in order', () => {
  const part = (section, label, extra = {}) => field(label, { section, ...extra });
  const months = ['Month', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const years = ['Year', '2021', '2022', '2023', '2024', '2025', '2026'];
  const fields = [
    part('My Experience', 'Job Title', { id: 'workExperience-1--jobTitle' }), part('My Experience', 'Company'), part('My Experience', 'Location'),
    part('My Experience', 'I currently work here', { kind: 'checkbox', type: 'checkbox' }),
    part('My Experience', 'From', { placeholder: 'MM/YYYY' }), part('My Experience', 'Role Description', { type: 'textarea' }),
    part('Work Experience 2', 'Job Title'), part('Work Experience 2', 'Company'), part('Work Experience 2', 'I currently work here', { kind: 'checkbox', type: 'checkbox' }),
    part('Work Experience 2', 'From', { placeholder: 'MM/YYYY' }), part('Work Experience 2', 'To', { placeholder: 'MM/YYYY' }),
    part('Education', 'School'), choice('Degree', ['Select', "Bachelor's", "Master's", 'PhD'], { section: 'Education' }), part('Education', 'Discipline'),
    choice('Start Date Month', months, { section: 'Education' }), choice('Start Date Year', years, { section: 'Education' }),
    choice('End Date Month', months, { section: 'Education' }), choice('End Date Year', years, { section: 'Education' }), part('Education', 'GPA'),
    part('Education', 'School', { filled: true }), part('Education', 'Discipline'),
    field('Current company'), field('Graduation date', { type: 'month' }), field('Earliest start date'),
    field('LinkedIn Profile'), field('LinkedIn URL', { type: 'url' }),
  ];
  const { fills } = planFill(fields, { ...PROFILE, linkedin: 'yuan-li', startDate: '' });
  const got = fills.map(item => {
    const asked = fields.find(entry => entry.index === item.index);
    return `${asked.section || '-'} · ${asked.label} = ${item.value ?? (item.check ? 'checked' : asked.options[item.option])}`;
  });
  assert.deepEqual(got, [
    'My Experience · Job Title = Data Science Intern', 'My Experience · Company = Acme', 'My Experience · Location = San Francisco, CA',
    'My Experience · I currently work here = checked', 'My Experience · From = 06/2025', 'My Experience · Role Description = Built churn models\nShipped a dashboard',
    'Work Experience 2 · Job Title = Analyst', 'Work Experience 2 · Company = Beta Labs', 'Work Experience 2 · From = 01/2023', 'Work Experience 2 · To = 12/2024',
    'Education · School = University of California, Berkeley', "Education · Degree = Master's", 'Education · Discipline = Industrial Engineering',
    'Education · Start Date Month = August', 'Education · Start Date Year = 2025', 'Education · End Date Month = May', 'Education · End Date Year = 2026',
    'Education · GPA = 3.9/4.0', 'Education · Discipline = Mathematics',
    '- · Current company = Acme', '- · Graduation date = 2026-05',
    '- · LinkedIn Profile = https://www.linkedin.com/in/yuan-li', '- · LinkedIn URL = https://www.linkedin.com/in/yuan-li',
  ]);
  const named = planFill([field('LinkedIn'), field('LinkedIn profile URL', { type: 'url' })], { ...PROFILE, linkedin: 'Yuan Li' }).fills;
  assert.deepEqual(named.map(item => item.value), ['Yuan Li'], 'a LinkedIn name goes into a text box but never into a link box');
  assert.equal(keyFor(field('Start date')), 'startDate', 'outside a work or education part, a start date is when one can start');
  assert.equal(keyFor(field('Are you currently employed?', { kind: 'checkbox', type: 'checkbox' })), null);
});

test('the profile is read from the whole resume and old profiles move to lists', async () => {
  assert.deepEqual(['2024-08', '8/2024', 'Aug 2024', 'Sept. 2024', '2024年8月', '2024', 'Spring 2026', ''].map(monthOf), ['2024-08', '2024-08', '2024-08', '2024-09', '2024-08', '2024', null, '']);
  assert.deepEqual(migrateApplicant({ firstName: 'Yuan', school: 'UCB', degree: 'MEng', major: 'IEOR', graduation: 'Spring 2026', company: 'Acme', title: 'Intern' }), {
    firstName: 'Yuan', education: [{ school: 'UCB', degree: 'MEng', major: 'IEOR', start: '', end: '2026', gpa: '' }],
    experience: [{ company: 'Acme', title: 'Intern', location: '', start: '', end: '', current: false, summary: '' }],
  });
  assert.ok(PROFILE_SCHEMA.required.includes('experience') && PROFILE_SCHEMA.properties.education.items.additionalProperties === false);
  assert.deepEqual(normalizeProfile({ firstName: ' Yuan ', email: 'not an email', yearsExperience: 'about three', linkedin: 'linkedin.com/in/yuan',
    education: [{ school: 'UC Berkeley', degree: 'MEng', major: 'IEOR', start: 'Aug 2025', end: 'May 2026', gpa: '3.9' }, { school: '', degree: 'BS' }],
    experience: [{ company: 'Acme', title: 'Intern', location: 'SF', start: '2025-06', end: 'Present', current: false, summary: '• Built models\n  - Shipped   a dashboard' }] }), {
    firstName: 'Yuan', linkedin: 'linkedin.com/in/yuan',
    education: [{ school: 'UC Berkeley', degree: 'MEng', major: 'IEOR', start: '2025-08', end: '2026-05', gpa: '3.9' }],
    experience: [{ company: 'Acme', title: 'Intern', location: 'SF', start: '2025-06', end: '', current: true, summary: 'Built models\nShipped a dashboard' }],
  });

  const asked = [];
  let available = true;
  const reply = { firstName: 'Yuan', lastName: 'Li', preferredName: '', email: '', phone: '', address: '', city: 'Berkeley', state: 'CA', postalCode: '', country: 'United States',
    linkedin: '', github: '', website: '', yearsExperience: '2',
    education: [{ school: 'UC Berkeley', degree: 'Master of Engineering', major: 'IEOR', start: '2025-08', end: '2026-05', gpa: '' }],
    experience: [{ company: 'Acme', title: 'Data Analyst', location: '', start: '2023-07', end: '2025-07', current: false, summary: 'Built dashboards' }] };
  const provider = { id: 'claude-cli', status: async () => (available ? { available: true, detail: 'test' } : { available: false, detail: 'Claude Code was not found. Install it and sign in, or set its path in Settings.' }),
    ask: async request => { asked.push(request); return { value: reply, provider: 'claude-cli', model: 'claude-opus-5-5' }; } };
  const app = await createApp({ dataDir: ':memory:', startScheduler: false, distDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-dist-')),
    notify: () => {}, log: () => {}, detectJobspy: async () => ({ available: false }), providers: { 'claude-cli': provider } });
  const url = await app.listen(0);
  const { csrfToken } = await (await fetch(`${url}/api/bootstrap`)).json();
  const extract = async () => {
    const response = await fetch(`${url}/api/applicant/extract`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-dayjob-token': csrfToken } });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await extract()).status, 409, 'needs a resume');
    app.repo.addResume({ name: 'cv.txt', mime: 'text/plain', size: 1, text: 'Yuan Li\nyuan@example.com · 510-555-0100\nUC Berkeley, MEng IEOR 2026\nAcme, Data Analyst 2023–2025' });
    const read = await extract();
    assert.equal(read.status, 200);
    assert.equal(read.body.ai, true);
    assert.deepEqual([read.body.profile.email, read.body.profile.phone], ['yuan@example.com', '510-555-0100'], 'contact details the AI left out still come from the text');
    assert.equal(read.body.profile.experience[0].company, 'Acme');
    assert.match(asked[0].prompt, /<resume name="cv.txt">[\s\S]*Acme, Data Analyst/);
    assert.equal(asked[0].schema, PROFILE_SCHEMA);
    available = false;
    const basic = await extract();
    assert.deepEqual([basic.body.ai, basic.body.profile.firstName, basic.body.profile.education], [false, 'Yuan', []]);
    assert.match(basic.body.reason, /Claude Code was not found/);

    // A profile saved by 0.11 or earlier opens with its school and job as entries.
    app.repo.saveSettings({ ...app.repo.getSettings(), applicant: { ...DEFAULT_APPLICANT, education: undefined, experience: undefined, school: 'UCB', company: 'Acme', title: 'Analyst' } });
    const { settings } = await (await fetch(`${url}/api/bootstrap`)).json();
    assert.deepEqual([settings.applicant.education.map(item => item.school), settings.applicant.experience.map(item => item.company), 'school' in settings.applicant], [['UCB'], ['Acme'], false]);
  } finally { await app.close(); }
});
