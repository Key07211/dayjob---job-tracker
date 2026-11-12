import { z } from 'zod';
import { HttpError } from '../http.mjs';
import { transaction } from '../jobs/db.mjs';
import { APPLICATION_STATUSES } from '../jobs/repository.mjs';
import { SITE_IDS } from '../jobs/scrapers/index.mjs';
import { applicationPatch, applyInput, JOB_TYPES, manualApplication, monthParam, searchInput } from '../validation.mjs';

// What the in-app assistant can do, for both engines (Claude Code reaches these
// through MCP, the Claude API as tool calls). Each tool has a tier:
//   read      looks something up, changes nothing
//   undoable  changes something and hands back how to put it back
// Anything riskier (deleting, editing a resume, scoring, settings) is not here
// yet, and the password vault and submitting an application never will be.
export const TIERS = ['read', 'undoable'];
export const VIEWS = ['home', 'feed', 'saved', 'applications', 'browser', 'searches', 'resume', 'settings'];

const id = z.string().min(1).max(200);
const when = z.string().max(40).describe('ISO 8601 with a time zone offset, for example 2026-11-12T09:30:00-08:00.');
const CHANGED = 'This was changed again afterwards, so it cannot be put back automatically.';
// A search is still as the assistant left it when everything the user can edit is the same; having run in between does not count.
const searchShape = search => (search ? JSON.stringify({ ...search, updatedAt: undefined, lastRunAt: undefined }) : '');
const DESCRIPTION_CAP = 8000;
const RESUME_CAP = 24000;

const need = (value, label) => {
  if (!value) throw new HttpError(404, `${label} not found.`);
  return value;
};
const pad = value => String(value).padStart(2, '0');
// 2026-11-12T15:40:00-08:00: the computer's own clock, so "today" and "this morning" mean what the user means.
export function localIso(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
const cap = (text, max) => (text && text.length > max ? `${text.slice(0, max)}\n[… cut at ${max} characters]` : text || '');
const named = item => [item.company, item.title].filter(Boolean).join(' · ') || 'job';

// Lists carry a short card for each posting; the description comes with get_posting.
function card(item) {
  return { id: item.id, title: item.title, company: item.company, location: item.location, site: item.site, isRemote: item.isRemote,
    jobType: item.jobType, salary: item.salary, datePosted: item.datePosted, firstSeenAt: item.firstSeenAt, closedAt: item.closedAt,
    status: item.status, score: item.score?.score ?? (typeof item.score === 'number' ? item.score : null), verdict: item.score?.verdict ?? null,
    application: item.application ?? null };
}
const applicationCard = item => ({ id: item.id, company: item.company, title: item.title, status: item.status, appliedAt: item.appliedAt,
  statusChangedAt: item.statusChangedAt, nextFollowUpAt: item.nextFollowUpAt, flags: item.flags, postingId: item.postingId, score: item.score ?? null,
  postingClosedAt: item.postingClosedAt ?? null });

export function createTools({ db, repo, scheduler, goals, dashboard, status, scoreIfSaved = () => {}, now = () => new Date() }) {
  const q = sql => db.prepare(sql);
  const followUpDays = () => repo.getSettings().tracking.followUpDays;

  // An application as it was, with where its timeline ended, so one change can be taken back exactly.
  function snapshot(applicationId) {
    return { row: q('SELECT * FROM applications WHERE id = ?').get(applicationId),
      lastEvent: q('SELECT COALESCE(MAX(rowid), 0) AS n FROM application_events WHERE application_id = ?').get(applicationId).n };
  }
  function restore(before, after) {
    const current = q('SELECT updated_at FROM applications WHERE id = ?').get(before.row.id);
    if (!current || current.updated_at !== after.row.updated_at) throw new HttpError(409, CHANGED);
    transaction(db, () => {
      q('DELETE FROM application_events WHERE application_id = ? AND rowid > ? AND rowid <= ?').run(before.row.id, before.lastEvent, after.lastEvent);
      q(`UPDATE applications SET status = ?, applied_at = ?, status_changed_at = ?, next_follow_up_at = ?, contact = ?, notes = ?, flags = ?, updated_at = ? WHERE id = ?`)
        .run(before.row.status, before.row.applied_at, before.row.status_changed_at, before.row.next_follow_up_at, before.row.contact, before.row.notes,
          before.row.flags, before.row.updated_at, before.row.id);
    });
  }
  // Takes back an application the assistant created, unless it has moved on since.
  function removeApplication(application, previousStatus) {
    const current = repo.getApplication(application.id);
    if (!current) return;
    if (current.updatedAt !== application.updatedAt) throw new HttpError(409, CHANGED);
    repo.deleteApplication(application.id);
    if (application.postingId && previousStatus && previousStatus !== 'saved') repo.setPostingStatus(application.postingId, previousStatus);
  }

  const tools = [
    {
      name: 'get_status', tier: 'read', view: 'home',
      description: 'Read Dayjob\'s state: the computer\'s local time and time zone, how many postings are new or saved, applications by status, '
        + 'whether a search or scoring is running, when the next daily search is, the scoring mode, and the latest search runs.',
      shape: {},
      label: () => ['看了一下现在的状态', 'Checked how things stand'],
      async run() {
        const state = await status();
        const settings = repo.getSettings();
        return { result: { localTime: localIso(now()), timeZone: state.timeZone, version: state.version, stats: state.stats,
          search: { running: state.scheduler.running, phase: state.scheduler.phase, nextRunAt: state.scheduler.nextRunAt, dailyAt: settings.schedule.enabled ? settings.schedule.time : null },
          scoring: { mode: state.scoring.mode, available: state.scoring.available, paused: state.scoring.paused, held: state.scoring.held, resumes: state.scoring.resumes,
            running: Boolean(state.scheduler.scoringBatch) },
          lastRuns: state.runs.slice(0, 3).map(run => ({ startedAt: run.startedAt, status: run.status, found: run.found, newCount: run.newCount, scored: run.scored })) } };
      },
    },
    {
      name: 'list_postings', tier: 'read', view: input => (input.status === 'saved' ? 'saved' : 'feed'),
      description: 'List fetched job postings with their AI fit score, newest first unless sorted otherwise. Returns short cards; use get_posting for the description and the full analysis.',
      shape: {
        status: z.enum(['active', 'new', 'saved', 'dismissed', 'applied', 'all']).optional().describe('active (default) means new + saved.'),
        query: z.string().max(200).optional().describe('Text matched against title, company and location.'),
        minScore: z.number().int().min(0).max(100).optional(),
        sinceDays: z.number().int().min(1).max(365).optional().describe('Only postings first seen in the last N days.'),
        unscored: z.boolean().optional(),
        includeClosed: z.boolean().optional().describe('Default true. Closed postings have closedAt set.'),
        sort: z.enum(['posted', 'score', 'seen', 'company']).optional(),
        limit: z.number().int().min(1).max(50).optional().describe('Default 15.'),
        offset: z.number().int().min(0).optional(),
      },
      label: (input, result) => [`查了岗位（${result.total} 个）`, `Looked up jobs (${result.total})`],
      run(input) {
        const found = repo.listPostings({ status: input.status || 'active', q: input.query || undefined, minScore: input.minScore, sinceDays: input.sinceDays,
          unscored: input.unscored === true, includeClosed: input.includeClosed !== false, sort: input.sort || 'posted', limit: input.limit ?? 15, offset: input.offset ?? 0 });
        return { result: { total: found.total, postings: found.items.map(card) } };
      },
    },
    {
      name: 'get_posting', tier: 'read', view: 'feed',
      description: 'Read one posting in full: description, pay, posted and first-seen dates, whether it has closed, the stored fit analysis (score, strengths, gaps), and any application.',
      shape: { id },
      label: (input, result) => [`读了岗位：${named(result)}`, `Read the job: ${named(result)}`],
      run(input) {
        const posting = need(repo.getPosting(input.id), 'Posting');
        return { result: { ...posting, description: cap(posting.description, DESCRIPTION_CAP) } };
      },
    },
    {
      name: 'list_applications', tier: 'read', view: 'applications',
      description: 'List tracked applications: status, applied date, last status change, next follow-up date and flags (follow-up-due, ghost-suspected).',
      shape: { status: z.enum(APPLICATION_STATUSES).optional(), open: z.boolean().optional().describe('Only applied, oa, interview and offer.') },
      label: (input, result) => [`查了投递记录（${result.applications.length} 条）`, `Looked up applications (${result.applications.length})`],
      run: input => ({ result: { applications: repo.listApplications({ status: input.status, open: input.open === true }).map(applicationCard) } }),
    },
    {
      name: 'get_application', tier: 'read', view: 'applications',
      description: 'Read one application with its notes, contact and full timeline.',
      shape: { id },
      label: (input, result) => [`读了投递：${named(result)}`, `Read the application: ${named(result)}`],
      run: input => ({ result: need(repo.getApplication(input.id), 'Application') }),
    },
    {
      name: 'list_searches', tier: 'read', view: 'searches',
      description: 'List the saved daily searches and the followed company career boards.',
      shape: {},
      label: (input, result) => [`看了搜索条件（${result.searches.length} 个）`, `Looked at the searches (${result.searches.length})`],
      run: () => ({ result: { searches: repo.listSearches(), companies: repo.listCompanies() } }),
    },
    {
      name: 'list_resumes', tier: 'read', view: 'resume',
      description: 'List the user\'s resumes (up to three): id, file name, upload date and size.',
      shape: {},
      label: (input, result) => [`看了简历列表（${result.resumes.length} 份）`, `Looked at the resumes (${result.resumes.length})`],
      run: () => ({ result: { resumes: repo.listResumes() } }),
    },
    {
      name: 'get_resume', tier: 'read', view: 'resume',
      description: 'Read a resume\'s text: the one matched to a posting (postingId), a given resume (id), or the only resume when there is one. You can read and discuss it; you cannot change it.',
      shape: { id: id.optional().describe('A resume id from list_resumes.'), postingId: id.optional().describe('Read the resume this posting is matched to and scored against.') },
      label: (input, result) => [`读了简历：${result.name}`, `Read the resume: ${result.name}`],
      run(input) {
        let wanted = input.id;
        if (!wanted && input.postingId) wanted = need(repo.getPosting(input.postingId), 'Posting').resumeId;
        if (!wanted) {
          const resumes = repo.listResumes();
          if (resumes.length > 1) throw new HttpError(400, `There are ${resumes.length} resumes; pass id (from list_resumes) or postingId.`);
          wanted = resumes[0]?.id;
        }
        if (!wanted) throw new HttpError(409, 'No resume has been uploaded yet.');
        const resume = need(repo.getResume(wanted, true), 'Resume');
        return { result: { id: resume.id, name: resume.name, uploadedAt: resume.uploadedAt, text: cap(resume.text, RESUME_CAP) } };
      },
    },
    {
      name: 'get_dashboard', tier: 'read', view: 'home',
      description: 'Read the home page statistics: applications this week and month, open applications, reply rate and median days to a first reply, how many reached an OA or interview '
        + 'and an offer, weekly counts with the weekly goal, results by job board, applications that need a follow-up, and the best-scoring jobs not applied to yet.',
      shape: { weeks: z.number().int().min(4).max(26).optional().describe('How many recent weeks; 12 when omitted.') },
      label: () => ['看了主页的统计', 'Read the home statistics'],
      run: input => ({ result: dashboard.report({ weeks: input.weeks }) }),
    },
    {
      name: 'get_goals', tier: 'read', view: 'home',
      description: 'Read the monthly goals and their weekly tasks: each goal\'s target, progress, the pace expected by today, and every week\'s target and count.',
      shape: { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe('YYYY-MM, local time; this month when omitted.') },
      label: () => ['看了本月目标', 'Read the monthly goals'],
      run: input => ({ result: goals.report(monthParam(input.month)) }),
    },
    {
      name: 'show_in_app', tier: 'read', view: input => input.view,
      description: 'Bring a page of the Dayjob window in front of the user, optionally opened on one posting (view feed or saved) or one application (view applications). '
        + 'Use it when the user asks to see or open something; it changes nothing.',
      shape: { view: z.enum(VIEWS.filter(view => view !== 'browser')), id: id.optional().describe('A posting id for feed or saved, an application id for applications.') },
      label: input => [`打开了页面：${VIEW_NAMES[input.view][0]}`, `Opened ${VIEW_NAMES[input.view][1]}`],
      run(input) {
        if (input.id && ['feed', 'saved'].includes(input.view)) need(repo.getPosting(input.id), 'Posting');
        if (input.id && input.view === 'applications') need(repo.getApplication(input.id), 'Application');
        const target = ['feed', 'saved', 'applications'].includes(input.view) ? input.id || null : null;
        return { result: { shown: input.view, id: target }, ui: { open: input.view, id: target } };
      },
    },
    {
      name: 'set_posting_status', tier: 'undoable', view: input => (input.status === 'saved' ? 'saved' : 'feed'),
      description: 'Save a posting for later (saved), mark it not interested (dismissed), or move it back to new. The user can undo it with one click.',
      shape: { id, status: z.enum(['new', 'saved', 'dismissed']) },
      label: (input, result) => ({ saved: [`收藏了：${named(result)}`, `Saved: ${named(result)}`], dismissed: [`标为不感兴趣：${named(result)}`, `Not interested: ${named(result)}`],
        new: [`移回新岗位：${named(result)}`, `Moved back to new: ${named(result)}`] })[input.status],
      run(input) {
        const posting = need(repo.getPosting(input.id), 'Posting');
        if (posting.status === 'applied') throw new HttpError(409, 'This job is already tracked as an application.');
        const before = posting.status;
        if (before === input.status) return { result: { ...card(posting), unchanged: true } };
        const updated = repo.setPostingStatus(posting.id, input.status);
        scoreIfSaved(posting.id);
        return { result: card(updated), changed: true, undo() {
          if (repo.getPosting(posting.id)?.status !== input.status) throw new HttpError(409, CHANGED);
          repo.setPostingStatus(posting.id, before);
        } };
      },
    },
    {
      name: 'mark_applied', tier: 'undoable', view: 'applications',
      description: 'Record that the user applied to a posting, which starts tracking it (follow-up reminders, closed-posting checks). Only when the user says they have applied; never guess the date.',
      shape: { id, appliedAt: when.optional().describe('When they applied; now when omitted.'), note: z.string().max(2000).optional() },
      label: (input, result) => [`记为已投递：${named(result)}`, `Marked as applied: ${named(result)}`],
      run(input) {
        const posting = need(repo.getPosting(input.id), 'Posting');
        if (repo.applicationForPosting(posting.id)) throw new HttpError(409, 'This job is already tracked.');
        const { appliedAt, note } = applyInput(input);
        const application = repo.createApplication({ postingId: posting.id, company: posting.company || 'Unknown company', title: posting.title,
          jobUrl: posting.applyUrl || posting.jobUrl, appliedAt, note, resumeId: posting.resumeId, followUpDays: followUpDays(), source: 'mcp' });
        return { result: applicationCard(application), changed: true, applied: true, undo: () => removeApplication(application, posting.status) };
      },
    },
    {
      name: 'add_application', tier: 'undoable', view: 'applications',
      description: 'Track an application that has no fetched posting, for example a referral or a job applied to elsewhere. Only when the user says they have applied.',
      shape: { company: z.string().min(1).max(160), title: z.string().min(1).max(240), jobUrl: z.string().max(2048).optional(), appliedAt: when.optional(), note: z.string().max(2000).optional() },
      label: (input, result) => [`加了一条投递：${named(result)}`, `Added an application: ${named(result)}`],
      run(input) {
        const application = repo.createApplication({ ...manualApplication(input), followUpDays: followUpDays(), source: 'mcp' });
        return { result: applicationCard(application), changed: true, applied: true, undo: () => removeApplication(application, null) };
      },
    },
    {
      name: 'update_application', tier: 'undoable', view: 'applications',
      description: 'Change an application\'s status (applied, oa, interview, offer, accepted, rejected, withdrawn, ghosted), add a timeline note, replace its notes or contact, '
        + 'or set the next follow-up date. Fields left out stay as they are.',
      shape: {
        id,
        status: z.enum(APPLICATION_STATUSES).optional(),
        statusAt: when.optional().describe('When the change happened, for example the date of the email; now when omitted.'),
        note: z.string().max(2000).optional().describe('A timeline note, for example "Recruiter call booked for Friday".'),
        notes: z.string().max(20000).optional().describe('Replaces the free-form notes.'),
        contact: z.string().max(500).optional(),
        nextFollowUpAt: when.nullable().optional(),
      },
      label: (input, result) => (input.status ? [`投递状态改为「${STATUS_NAMES[input.status][0]}」：${named(result)}`, `Set to ${STATUS_NAMES[input.status][1]}: ${named(result)}`]
        : [`更新了投递：${named(result)}`, `Updated the application: ${named(result)}`]),
      run(input) {
        const { id: applicationId, ...fields } = input;
        need(repo.getApplication(applicationId), 'Application');
        const patch = applicationPatch(fields);
        const before = snapshot(applicationId);
        const updated = repo.updateApplication(applicationId, patch, 'mcp');
        const after = snapshot(applicationId);
        return { result: applicationCard(updated), changed: true, undo: () => restore(before, after) };
      },
    },
    {
      name: 'save_search', tier: 'undoable', view: 'searches',
      description: 'Create a saved daily search, or change one by id (fields left out stay as they are). Comma-separated keywords mean any of those phrases. It runs with the next search.',
      shape: {
        id: id.optional().describe('Change this search; leave out to create one.'),
        name: z.string().max(80).optional(),
        keywords: z.string().min(1).max(200).optional(),
        location: z.string().max(120).optional(),
        sites: z.array(z.enum(SITE_IDS)).min(1).optional().describe('Default linkedin and indeed.'),
        hoursOld: z.number().int().min(1).max(1440).nullable().optional().describe('Only postings from the last N hours.'),
        jobType: z.enum(JOB_TYPES).nullable().optional(),
        isRemote: z.boolean().optional(),
        resultsWanted: z.number().int().min(1).max(200).optional(),
        titleInclude: z.array(z.string().max(60)).max(30).optional().describe('The title must contain one of these.'),
        excludeKeywords: z.array(z.string().max(60)).max(30).optional(),
        enabled: z.boolean().optional(),
      },
      label: (input, result) => (input.id ? [`改了搜索：${result.name}`, `Changed the search: ${result.name}`] : [`新建了搜索：${result.name}`, `Created the search: ${result.name}`]),
      run(input) {
        const { id: searchId, ...fields } = input;
        if (!searchId) {
          const created = repo.saveSearch(searchInput({ sites: ['linkedin', 'indeed'], ...fields }));
          return { result: created, changed: true, undo() {
            if (searchShape(repo.getSearch(created.id)) !== searchShape(created)) throw new HttpError(409, CHANGED);
            repo.deleteSearch(created.id);
          } };
        }
        const current = need(repo.getSearch(searchId), 'Search');
        const updated = repo.saveSearch(searchInput(fields, current), current.id);
        return { result: updated, changed: true, undo() {
          if (searchShape(repo.getSearch(current.id)) !== searchShape(updated)) throw new HttpError(409, CHANGED);
          repo.saveSearch(current, current.id);
        } };
      },
    },
    {
      name: 'run_search', tier: 'undoable', view: 'home',
      description: 'Start fetching new postings now, for every enabled search and followed company or only the given searches. It returns at once and the search carries on for a few minutes '
        + '(get_status shows progress); new postings are then scored according to the scoring mode. The user can stop it.',
      shape: { searchIds: z.array(id).max(50).optional() },
      label: (input, result) => (result.started ? ['开始抓取岗位', 'Started a search'] : ['抓取已经在进行', 'A search was already running']),
      run(input) {
        if (!repo.listSearches().some(search => search.enabled) && !repo.listCompanies().some(company => company.enabled)) {
          throw new HttpError(409, 'Add a search or follow a company first.');
        }
        if (scheduler.running) return { result: { started: false, alreadyRunning: true } };
        const flight = scheduler.runNow({ searchIds: input.searchIds?.length ? input.searchIds : undefined });
        flight.catch(() => {});
        // Undo stops this run, keeping what it has found; a later run is not touched.
        return { result: { started: true }, changed: true, undo() { if (scheduler.running) scheduler.cancel(); } };
      },
    },
  ];

  const byName = new Map(tools.map(tool => [tool.name, { ...tool, schema: z.strictObject(tool.shape) }]));
  return {
    list: [...byName.values()],
    get: name => byName.get(name) || null,
    // The JSON Schema form, for the Claude API.
    definitions: () => [...byName.values()].map(tool => {
      const { $schema, ...schema } = z.toJSONSchema(tool.schema);
      return { name: tool.name, description: tool.description, input_schema: schema };
    }),
    // Runs one tool. Bad input and refusals come back as { ok: false, error } for the model to read; they are not thrown.
    async run(name, input) {
      const tool = byName.get(name);
      if (!tool) return { ok: false, error: `There is no tool named ${name}.`, tier: 'read', view: null };
      const view = typeof tool.view === 'function' ? tool.view(input || {}) : tool.view;
      const parsed = tool.schema.safeParse(input ?? {});
      if (!parsed.success) {
        const problems = parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
        return { ok: false, error: `Invalid input (${problems}).`, tier: tool.tier, view };
      }
      try {
        const outcome = await tool.run(parsed.data);
        return { ok: true, tier: tool.tier, view, result: outcome.result, label: tool.label(parsed.data, outcome.result), undo: outcome.undo || null,
          changed: Boolean(outcome.changed), applied: Boolean(outcome.applied), ui: outcome.ui || null };
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return { ok: false, error: error.message, tier: tool.tier, view };
      }
    },
  };
}

const VIEW_NAMES = { home: ['主页', 'Home'], feed: ['今日岗位', 'Today'], saved: ['已收藏', 'Saved'], applications: ['投递追踪', 'Applications'],
  searches: ['搜索与公司', 'Searches'], resume: ['简历与 AI', 'Resume & AI'], settings: ['设置', 'Settings'] };
const STATUS_NAMES = { applied: ['已投递', 'Applied'], oa: ['在线测评', 'Assessment'], interview: ['面试中', 'Interviewing'], offer: ['Offer', 'Offer'], accepted: ['已接受', 'Accepted'],
  rejected: ['未通过', 'Rejected'], withdrawn: ['已撤回', 'Withdrawn'], ghosted: ['无回音', 'Ghosted'] };
