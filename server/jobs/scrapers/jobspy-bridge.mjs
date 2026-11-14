// Boards that need a browser-grade TLS fingerprint (Glassdoor, ZipRecruiter, Google Jobs) run through the real
// JobSpy CLI. The Windows app carries a Python with JobSpy inside it (resources/jobspy, put together by
// scripts/build-jobspy.mjs); without that, or when the user says so, their own Python with
// `pip install python-jobspy` is used.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractEmails, posting } from '../normalize.mjs';
import { ScrapeError } from './http-client.mjs';

export const BRIDGE_SITES = ['glassdoor', 'zip_recruiter', 'google'];

// -X utf8: what JobSpy prints is read as UTF-8 whatever the Windows code page is. (The variable PYTHONIOENCODING
// says the same, but the Python inside Dayjob ignores every variable.)
const PYTHON_ARGS = ['-X', 'utf8', '-m', 'jobspy'];

// The JobSpy inside the app: { command, version, python } when dir holds one that can run here, else null.
export function builtInJobspy(dir) {
  if (!dir) return null;
  const command = path.join(dir, process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
  try {
    const made = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
    if (!fs.existsSync(command) || typeof made.jobspy !== 'string') return null;
    return { command, version: made.jobspy, python: String(made.python || '') };
  } catch { return null; }
}

export function bridgeArgs(site, input) {
  const args = [...PYTHON_ARGS];
  if (input.keywords) args.push(input.keywords);
  args.push('--site', site, '-n', String(input.resultsWanted || 25), '--fields', 'all', '--description-format', 'markdown', '-q');
  if (input.location) args.push('--location', input.location);
  if (input.distance) args.push('--distance', String(input.distance));
  if (input.hoursOld) args.push('--hours-old', String(input.hoursOld));
  if (input.jobType) args.push('--job-type', input.jobType);
  if (input.isRemote) args.push('--remote');
  if (input.country) args.push('--country-indeed', input.country);
  return args;
}

export function fromRecord(record) {
  const site = record.site;
  const externalId = String(record.id || '').replace(/^[a-z]+-/, '') || Buffer.from(record.job_url).toString('base64url').slice(0, 40);
  return posting({
    site, externalId, title: record.title, company: record.company, companyUrl: record.company_url_direct || record.company_url,
    companyLogo: record.company_logo, location: record.location, isRemote: typeof record.is_remote === 'boolean' ? record.is_remote : null,
    jobType: record.job_type ? String(record.job_type).split(',') : null, jobLevel: record.job_level, jobFunction: record.job_function,
    department: record.company_industry,
    salary: record.min_amount || record.max_amount ? { min: record.min_amount ?? null, max: record.max_amount ?? null,
      interval: record.interval || null, currency: record.currency || 'USD', source: record.salary_source || 'board' } : null,
    description: record.description, emails: Array.isArray(record.emails) ? record.emails : extractEmails(record.emails),
    jobUrl: record.job_url, applyUrl: record.job_url_direct, datePosted: record.date_posted,
  });
}

// The last thing Python said: "C:\\Python312\\python.exe: No module named jobspy", or JobSpy's own "ERROR: jobspy.google: ...".
const lastLine = text => String(text || '').trim().split(/\r?\n/).pop().trim().slice(0, 300);
// A Python that starts but has no JobSpy in it: on a computer with several Pythons, JobSpy went into another one.
export const noJobspyModule = text => /No module named '?jobspy/i.test(String(text || ''));

// -> { available, version } and, when it is not there, reason: what the command answered, so Settings can say
// which Python was asked and what it lacks.
export function detectJobspy(command, spawn = nodeSpawn) {
  return new Promise(resolve => {
    let output = '';
    let errors = '';
    let child;
    const missing = reason => resolve({ available: false, version: null, ...(reason ? { reason } : {}) });
    try { child = spawn(command, [...PYTHON_ARGS, '--version'], { windowsHide: true, shell: false }); }
    catch (error) { missing(String(error.message || '').slice(0, 300)); return; }
    // Long enough for a first start, when the antivirus reads every file of Python on its way in.
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); missing(String(error.message || '').slice(0, 300)); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve({ available: true, version: output.trim().slice(0, 80) }); else missing(lastLine(errors)); });
  });
}

const SITE_NAMES = { glassdoor: 'Glassdoor', zip_recruiter: 'ZipRecruiter', google: 'Google Jobs' };
// Why a search came back with nothing, in words that say whose fault it is:
//   the Python has no JobSpy            -> the same answer as a JobSpy that is not there
//   JobSpy itself gave up on the site   -> the site turned it away or changed its pages; nothing in Dayjob is broken
//   anything else                       -> what Python said
export function searchFailure(site, stderr, code, missing) {
  const last = lastLine(stderr);
  if (noJobspyModule(stderr)) return missing(last);
  const own = last.match(/^(?:ERROR|CRITICAL)\s*:\s*jobspy\.\w+\s*:\s*(.+)$/i);
  if (own) return `JobSpy got no jobs from ${SITE_NAMES[site] || site} (${own[1]}). The site turned the request away or changed its pages; the other sources are not affected.`;
  return `JobSpy ${site} failed: ${last || `exit ${code}`}`;
}

// builtIn: command is the JobSpy inside the app, so a failure to start is not answered with how to install one.
export function createJobspyBridge({ command = 'python', builtIn = false, spawn = nodeSpawn, timeoutMs = 10 * 60 * 1000 } = {}) {
  const missing = detail => (builtIn ? `The JobSpy inside Dayjob did not start (${detail}). Installing Dayjob again puts it back.`
    : noJobspyModule(detail) ? `The Python that Dayjob runs has no JobSpy in it (${detail}). Run: ${command} -m pip install python-jobspy, or name the Python that has JobSpy under Settings, JobSpy.`
      : `JobSpy is not available (${detail}). Install Python and run: pip install python-jobspy`);
  return {
    // A stopped run (signal) ends the Python process at once.
    async search(site, input, { log = () => {}, signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        let stdout = '';
        let stderr = '';
        let child;
        try {
          child = spawn(command, bridgeArgs(site, input), { windowsHide: true, shell: false, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        } catch (error) { reject(new ScrapeError(missing(error.message))); return; }
        const timer = setTimeout(() => child.kill(), timeoutMs);
        const stop = () => { child.kill(); reject(signal.reason); };
        signal?.addEventListener('abort', stop, { once: true });
        child.on('close', () => signal?.removeEventListener('abort', stop));
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 50 * 1024 * 1024) child.kill(); });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
        child.on('error', error => { clearTimeout(timer); reject(new ScrapeError(missing(error.message))); });
        child.on('close', code => {
          clearTimeout(timer);
          const postings = [];
          for (const line of stdout.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try { postings.push(fromRecord(JSON.parse(line))); } catch (error) { log(`jobspy ${site}: skipped a record (${error.message})`); }
          }
          if (code !== 0 && !postings.length) reject(new ScrapeError(searchFailure(site, stderr, code, missing)));
          else resolve({ postings, warnings: stderr.trim() ? [lastLine(stderr)] : [] });
        });
      });
    },
  };
}
