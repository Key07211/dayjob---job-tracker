import { createApiProvider } from './anthropic-api.mjs';
import { createClaudeCliProvider } from './claude-cli.mjs';
import { createCodexCliProvider } from './codex-cli.mjs';
import { createOpenAiProvider } from './openai-api.mjs';

// Picks the provider from settings and scores postings one at a time, so a
// daily run never floods the AI. Failures are counted, not thrown, in batches.
// Failures that would repeat for every posting, so a batch stops at the first.
const FATAL = /API key|(Claude Code|Codex) was not found|not logged in|not signed in|\/login|rate limit/i;
const pausedError = () => Object.assign(new Error('AI scoring is paused. Resume it in Dayjob first.'), { status: 409, paused: true });

export function createScorer({ repo, providers, log = console.warn }) {
  const getSettings = () => repo.getSettings();
  const available = providers || {
    'claude-cli': createClaudeCliProvider({ getSettings }),
    'anthropic-api': createApiProvider({ getSettings }),
    'codex-cli': createCodexCliProvider({ getSettings }),
    'openai-api': createOpenAiProvider({ getSettings }),
  };
  let queue = Promise.resolve();
  let pending = 0;
  // Pausing stops the posting being scored and holds it, with the rest of
  // every batch, until the user resumes. It survives a restart.
  const saved = repo.getMeta('scoringPaused');
  let paused = Boolean(saved);
  let held = Array.isArray(saved?.ids) ? saved.ids : [];
  let inFlight = null;
  const batches = new Set();
  // Postings in the running batches, and the ones of those already done; two
  // batches asking for the same posting count it once.
  let progress = { ids: new Set(), done: new Set() };
  // The latest scores as they land, numbered, so the app can play each one once.
  let landed = [];
  let landedSeq = 0;

  const provider = () => available[getSettings().ai.provider] || available['claude-cli'];
  const persist = () => repo.setMeta('scoringPaused', paused ? { at: new Date().toISOString(), ids: held } : null);
  function hold(ids) {
    held = [...new Set([...held, ...ids])];
    persist();
  }

  async function status(refresh = false) {
    const current = provider();
    return { provider: current.id, ...(await current.status(refresh)), mode: getSettings().ai.scoreMode, resumes: repo.countResumes(), pending,
      paused, held: held.length, progress: batches.size ? { done: progress.done.size, total: progress.ids.size } : null, landed };
  }

  // Each posting is scored against the resume it was matched to by keywords.
  async function scoreNow(postingId, { force = false } = {}) {
    if (paused) throw pausedError();
    const posting = repo.postingForScoring(postingId);
    if (!posting) throw new Error('Posting not found.');
    const resume = posting.resumeId ? repo.getResume(posting.resumeId, true) : null;
    if (!resume) throw new Error('Upload a resume before scoring.');
    if (!force) {
      const existing = repo.getScore(postingId, resume.id);
      if (existing) return existing;
    }
    const controller = new AbortController();
    inFlight = controller;
    let result;
    try { result = await provider().score({ resume: resume.text, posting, signal: controller.signal }); }
    catch (error) { throw controller.signal.aborted ? pausedError() : error; }
    finally { if (inFlight === controller) inFlight = null; }
    const saved = repo.saveScore(postingId, resume.id, result);
    landedSeq += 1;
    landed = [...landed, { seq: landedSeq, id: postingId, score: saved.score, verdict: saved.verdict }].slice(-20);
    return saved;
  }

  // Serialized: a manual "score" click waits behind a running batch.
  function enqueue(work) {
    pending += 1;
    const next = queue.then(work).finally(() => { pending -= 1; });
    queue = next.catch(() => {});
    return next;
  }

  // A batch for a run that is stopped (signal) ends now: the posting it is
  // scoring stops, and the rest wait for a later run.
  async function runBatch(ids, { limit, signal } = {}) {
    if (!repo.countResumes()) return { scored: 0, failed: 0, skipped: ids?.length || 0, reason: 'no-resume' };
    const max = limit ?? getSettings().ai.maxPerRun;
    const targets = (ids?.length ? ids : repo.unscoredPostingIds(max)).slice(0, max);
    if (paused) {
      hold(targets);
      return { scored: 0, failed: 0, skipped: targets.length, paused: true, results: [] };
    }
    const state = await status();
    if (!state.available) return { scored: 0, failed: 0, skipped: targets.length, reason: state.detail };
    let scored = 0;
    let failed = 0;
    let lastError = '';
    const results = [];
    for (const id of targets) progress.ids.add(id);
    let ours = false;
    const stop = () => { if (ours) inFlight?.abort(); };
    signal?.addEventListener('abort', stop, { once: true });
    const stopped = () => ({ scored, failed, skipped: targets.length - scored - failed, cancelled: true, results });
    for (const [index, id] of targets.entries()) {
      if (signal?.aborted) return stopped();
      try {
        const score = await enqueue(async () => {
          signal?.throwIfAborted();
          ours = true;
          try { return await scoreNow(id); } finally { ours = false; }
        });
        scored += 1;
        results.push({ id, score: score.score });
      } catch (error) {
        if (signal?.aborted) return stopped();
        if (error.paused) {
          hold(targets.slice(index));
          return { scored, failed, skipped: targets.length - scored - failed, paused: true, results };
        }
        failed += 1;
        log(`[dayjob] scoring ${id}: ${error.message}`);
        // A bad key or a missing CLI fails every posting the same way.
        if (FATAL.test(error.message)) return { scored, failed, skipped: targets.length - scored - failed, reason: error.message, results };
        lastError = error.message;
      }
      progress.done.add(id);
    }
    return { scored, failed, skipped: 0, results, ...(failed ? { reason: `${failed} of ${targets.length} could not be scored: ${lastError}` } : {}) };
  }

  return {
    status,
    get pending() { return pending; },
    get paused() { return paused; },
    // Any other single question for the same provider, outside the scoring queue.
    async ask(request) {
      const state = await provider().status();
      if (!state.available) throw new Error(state.detail);
      return provider().ask(request);
    },
    // A single posting asked for while paused waits with the others.
    score: (postingId, options) => enqueue(() => scoreNow(postingId, options)).catch(error => {
      if (error.paused) hold([postingId]);
      throw error;
    }),
    scoreBatch(ids, options) {
      const batch = runBatch(ids, options).finally(() => {
        batches.delete(batch);
        if (!batches.size) progress = { ids: new Set(), done: new Set() };
      });
      batches.add(batch);
      return batch;
    },
    pause() {
      if (!paused) {
        paused = true;
        persist();
      }
      inFlight?.abort();
      return { paused, held: held.length };
    },
    // Hands back the held postings once every batch that was running has
    // settled, so none of them is left behind; ones since dismissed or
    // applied to are dropped.
    async resume() {
      paused = false;
      await Promise.allSettled([...batches]);
      const ids = held.filter(id => ['new', 'saved'].includes(repo.postingForScoring(id)?.status));
      held = [];
      persist();
      return ids;
    },
  };
}
