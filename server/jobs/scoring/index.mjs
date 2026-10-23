import { createApiProvider } from './anthropic-api.mjs';
import { createClaudeCliProvider } from './claude-cli.mjs';

// Picks the provider from settings and scores postings one at a time, so a
// daily run never floods Claude. Failures are counted, not thrown, in batches.
// Failures that would repeat for every posting, so a batch stops at the first.
const FATAL = /API key|Claude Code was not found|not logged in|\/login|rate limit/i;

export function createScorer({ repo, providers, log = console.warn }) {
  const getSettings = () => repo.getSettings();
  const available = providers || {
    'claude-cli': createClaudeCliProvider({ getSettings }),
    'anthropic-api': createApiProvider({ getSettings }),
  };
  let queue = Promise.resolve();
  let pending = 0;

  const provider = () => available[getSettings().ai.provider] || available['claude-cli'];

  async function status(refresh = false) {
    const current = provider();
    return { provider: current.id, ...(await current.status(refresh)), resumes: repo.countResumes(), pending };
  }

  // Each posting is scored against the resume it was matched to by keywords.
  async function scoreNow(postingId, { force = false } = {}) {
    const posting = repo.postingForScoring(postingId);
    if (!posting) throw new Error('Posting not found.');
    const resume = posting.resumeId ? repo.getResume(posting.resumeId, true) : null;
    if (!resume) throw new Error('Upload a resume before scoring.');
    if (!force) {
      const existing = repo.getScore(postingId, resume.id);
      if (existing) return existing;
    }
    const result = await provider().score({ resume: resume.text, posting });
    return repo.saveScore(postingId, resume.id, result);
  }

  // Serialized: a manual "score" click waits behind a running batch.
  function enqueue(work) {
    pending += 1;
    const next = queue.then(work).finally(() => { pending -= 1; });
    queue = next.catch(() => {});
    return next;
  }

  return {
    status,
    get pending() { return pending; },
    // Any other single question for the same provider, outside the scoring queue.
    async ask(request) {
      const state = await provider().status();
      if (!state.available) throw new Error(state.detail);
      return provider().ask(request);
    },
    score: (postingId, options) => enqueue(() => scoreNow(postingId, options)),
    async scoreBatch(ids, { limit } = {}) {
      if (!repo.countResumes()) return { scored: 0, failed: 0, skipped: ids?.length || 0, reason: 'no-resume' };
      const max = limit ?? getSettings().ai.maxPerRun;
      const targets = (ids?.length ? ids : repo.unscoredPostingIds(max)).slice(0, max);
      const state = await status();
      if (!state.available) return { scored: 0, failed: 0, skipped: targets.length, reason: state.detail };
      let scored = 0;
      let failed = 0;
      let lastError = '';
      const results = [];
      for (const id of targets) {
        try {
          const score = await enqueue(() => scoreNow(id));
          scored += 1;
          results.push({ id, score: score.score });
        } catch (error) {
          failed += 1;
          log(`[dayjob] scoring ${id}: ${error.message}`);
          // A bad key or a missing CLI fails every posting the same way.
          if (FATAL.test(error.message)) return { scored, failed, skipped: targets.length - scored - failed, reason: error.message, results };
          lastError = error.message;
        }
      }
      return { scored, failed, skipped: 0, results, ...(failed ? { reason: `${failed} of ${targets.length} could not be scored: ${lastError}` } : {}) };
    },
  };
}
