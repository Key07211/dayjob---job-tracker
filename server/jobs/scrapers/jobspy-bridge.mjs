// Optional: boards that need a browser-grade TLS fingerprint (Glassdoor,
// ZipRecruiter, Google Jobs) run through the real JobSpy CLI when the user has
// Python and `pip install python-jobspy`. Dayjob never bundles Python.
import { spawn as nodeSpawn } from 'node:child_process';
import { extractEmails, posting } from '../normalize.mjs';
import { ScrapeError } from './http-client.mjs';

export const BRIDGE_SITES = ['glassdoor', 'zip_recruiter', 'google'];

export function bridgeArgs(site, input) {
  const args = ['-m', 'jobspy'];
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

export function detectJobspy(command, spawn = nodeSpawn) {
  return new Promise(resolve => {
    let output = '';
    let child;
    try { child = spawn(command, ['-m', 'jobspy', '--version'], { windowsHide: true, shell: false }); }
    catch { resolve({ available: false, version: null }); return; }
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout?.on('data', chunk => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve({ available: false, version: null }); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? { available: true, version: output.trim().slice(0, 80) } : { available: false, version: null }); });
  });
}

export function createJobspyBridge({ command = 'python', spawn = nodeSpawn, timeoutMs = 10 * 60 * 1000 } = {}) {
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
        } catch (error) { reject(new ScrapeError(`Cannot start ${command}: ${error.message}`)); return; }
        const timer = setTimeout(() => child.kill(), timeoutMs);
        const stop = () => { child.kill(); reject(signal.reason); };
        signal?.addEventListener('abort', stop, { once: true });
        child.on('close', () => signal?.removeEventListener('abort', stop));
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 50 * 1024 * 1024) child.kill(); });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
        child.on('error', error => { clearTimeout(timer); reject(new ScrapeError(`JobSpy is not available (${error.message}). Install Python and run: pip install python-jobspy`)); });
        child.on('close', code => {
          clearTimeout(timer);
          const postings = [];
          for (const line of stdout.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try { postings.push(fromRecord(JSON.parse(line))); } catch (error) { log(`jobspy ${site}: skipped a record (${error.message})`); }
          }
          if (code !== 0 && !postings.length) reject(new ScrapeError(`JobSpy ${site} failed: ${stderr.trim().split('\n').pop() || `exit ${code}`}`));
          else resolve({ postings, warnings: stderr.trim() ? [stderr.trim().split('\n').pop().slice(0, 300)] : [] });
        });
      });
    },
  };
}
