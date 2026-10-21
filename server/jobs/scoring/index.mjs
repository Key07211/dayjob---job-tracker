import { createApiProvider } from './anthropic-api.mjs';
import { createClaudeCliProvider } from './claude-cli.mjs';

// Picks the provider from settings and scores postings one at a time, so a
// daily run never floods Claude. Failures are counted, not thrown, in batches.
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
    const resume = repo.activeResume();
    return { provider: current.id, ...(await current.status(refresh)), resume: resume ? { id: resume.id, name: resume.name } : null, pending };
  }

  async function scoreNow(postingId, { force = false } = {}) {
    const resume = repo.activeResume(true);
    if (!resume) throw new Error('Upload a resume before scoring.');
    if (!force) {
      const existing = repo.getScore(postingId, resume.id);
      if (existing) return existing;
    }
    const posting = repo.postingForScoring(postingId);
    if (!posting) throw new Error('Posting not found.');
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
    score: (postingId, options) => enqueue(() => scoreNow(postingId, options)),
    async scoreBatch(ids, { limit } = {}) {
      const resume = repo.activeResume();
      if (!resume) return { scored: 0, failed: 0, skipped: ids?.length || 0, reason: 'no-resume' };
      const max = limit ?? getSettings().ai.maxPerRun;
      const targets = (ids?.length ? ids : repo.unscoredPostingIds(resume.id, max)).slice(0, max);
      const state = await status();
      if (!state.available) return { scored: 0, failed: 0, skipped: targets.length, reason: state.detail };
      let scored = 0;
      let failed = 0;
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
          if (/API key|Claude Code was not found|rate limit/i.test(error.message)) return { scored, failed, skipped: targets.length - scored - failed, reason: error.message, results };
        }
      }
      return { scored, failed, skipped: 0, results };
    },
  };
}
