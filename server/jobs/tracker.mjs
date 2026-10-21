import { message } from '../messages.mjs';
import { BOARD_SCRAPERS } from './scrapers/index.mjs';
import { checkCompanyJob, splitCompanyId } from './scrapers/company-boards.mjs';
import { jitter } from './scrapers/http-client.mjs';

const COMPANY_SITES = ['greenhouse', 'lever', 'ashby'];
const RECHECK_HOURS = 20;
const MAX_CHECKS = 30;
const CHECK_DELAY = [1.5, 3.5];
const DAY = 864e5;

// Keeps applied jobs current without the user re-entering anything: checks
// whether each posting is still open, schedules follow-ups and flags
// applications that have gone quiet. It never changes a status by itself.
export function createTracker({ repo, http, now = () => new Date(), notify = () => {}, log = console.warn }) {
  const settings = () => repo.getSettings().tracking;
  const text = (key, params) => message(repo.getSettings().language, key, params);

  async function isOpen(posting, cache) {
    if (BOARD_SCRAPERS[posting.site]?.checkOpen) return BOARD_SCRAPERS[posting.site].checkOpen(posting, { http });
    if (COMPANY_SITES.includes(posting.site)) return checkCompanyJob(posting, { http, cache });
    // Other boards: only a definite 404/410 counts as closed.
    const response = await http.request(posting.jobUrl, { allowStatus: [404, 410] });
    return response.status === 404 || response.status === 410 ? false : null;
  }

  // Applied jobs first (oldest check first), then saved ones, within a budget.
  function dueForCheck() {
    const cutoff = now().getTime() - RECHECK_HOURS * 3600e3;
    const fresh = item => !item.lastCheckedAt || Date.parse(item.lastCheckedAt) < cutoff;
    // Followed company boards are re-read in full by every search run.
    const followed = new Set(repo.listCompanies().filter(company => company.enabled).map(company => `${company.ats}:${company.slug}`));
    const coveredBySearch = posting => COMPANY_SITES.includes(posting.site)
      && followed.has(`${posting.site}:${splitCompanyId(posting.site, posting.externalId)?.slug}`);
    const applied = repo.listApplications({ open: true }).filter(item => item.postingId && !item.postingClosedAt)
      .map(item => repo.postingForScoring(item.postingId)).filter(Boolean);
    const saved = repo.listPostings({ status: 'saved', includeClosed: false, limit: 200 }).items;
    const seen = new Set();
    return [...applied, ...saved].filter(posting => {
      if (seen.has(posting.id) || posting.closedAt || !fresh(posting) || coveredBySearch(posting)) return false;
      seen.add(posting.id);
      return true;
    }).sort((a, b) => (Date.parse(a.lastCheckedAt || 0) || 0) - (Date.parse(b.lastCheckedAt || 0) || 0)).slice(0, MAX_CHECKS);
  }

  async function checkPostings(report) {
    if (!settings().checkClosed) return;
    const cache = new Map();
    const targets = dueForCheck();
    for (const [index, posting] of targets.entries()) {
      if (index) await http.sleep(jitter(CHECK_DELAY));
      let open = null;
      try { open = await isOpen(posting, cache); }
      catch (error) {
        log(`[dayjob] check ${posting.id}: ${error.message}`);
        report.errors += 1;
        if (error.blocked) { report.warnings.push(`${posting.site} limited requests; the rest are checked next time.`); break; }
      }
      report.checked += 1;
      const change = repo.markChecked(posting.id, open);
      if (!change.changed) continue;
      const application = repo.applicationForPosting(posting.id);
      if (change.closed) {
        report.closed.push(posting.id);
        if (application) {
          repo.addEvent(application.id, { type: 'posting-closed', note: text('noteClosed'), source: 'auto' });
          notify({ kind: 'posting-closed', ...text('postingClosed', posting), refId: application.id });
        }
      } else if (application) {
        repo.addEvent(application.id, { type: 'posting-reopened', note: text('noteReopened'), source: 'auto' });
      }
    }
  }

  function followUps(report) {
    const { ghostDays } = settings();
    const at = now().getTime();
    for (const application of repo.listApplications({ open: true })) {
      const flags = new Set(application.flags);
      let changed = false;
      if (application.nextFollowUpAt && Date.parse(application.nextFollowUpAt) <= at && !flags.has('follow-up-due')) {
        flags.add('follow-up-due');
        changed = true;
        report.followUps.push(application.id);
        repo.addEvent(application.id, { type: 'follow-up-due', note: text('noteFollowUp'), source: 'auto' });
        notify({ kind: 'follow-up', ...text('followUp', { ...application, days: Math.round((at - Date.parse(application.statusChangedAt)) / DAY) }), refId: application.id });
      }
      const quietDays = (at - Date.parse(application.statusChangedAt)) / DAY;
      if (application.status === 'applied' && ghostDays && quietDays >= ghostDays && !flags.has('ghost-suspected')) {
        flags.add('ghost-suspected');
        changed = true;
        report.ghosted.push(application.id);
        repo.addEvent(application.id, { type: 'ghost-suspected', note: text('noteGhost', { days: Math.floor(quietDays) }), source: 'auto' });
        notify({ kind: 'ghost', ...text('ghost', { ...application, days: Math.floor(quietDays) }), refId: application.id });
      }
      if (changed) repo.setApplicationFlags(application.id, [...flags]);
    }
  }

  return {
    async run() {
      const report = { checked: 0, errors: 0, closed: [], followUps: [], ghosted: [], warnings: [] };
      followUps(report);
      await checkPostings(report);
      repo.setMeta('lastTracking', { ...report, at: now().toISOString() });
      return report;
    },
  };
}
