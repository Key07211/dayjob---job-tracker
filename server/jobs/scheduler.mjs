import { message } from '../messages.mjs';
const pad = value => String(value).padStart(2, '0');
export const localDay = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// The computer's local wall-clock time of today's run.
export function scheduledAt(time, date) {
  const [hours, minutes] = /^\d{1,2}:\d{2}$/.test(time || '') ? time.split(':').map(Number) : [8, 30];
  const at = new Date(date);
  at.setHours(hours, minutes, 0, 0);
  return at;
}

// Once a day (or on demand): search, score what is new, then update every
// tracked application. A run missed while the computer was off happens at the
// next start instead.
export function createScheduler({ repo, runner, scorer, tracker, notify, now = () => new Date(), intervalMs = 60000, log = console.warn }) {
  let timer = null;
  let phase = null;
  let flight = null;
  let stopper = null;

  function nextRunAt() {
    const { schedule } = repo.getSettings();
    if (!schedule.enabled) return null;
    const current = now();
    const today = scheduledAt(schedule.time, current);
    const doneToday = repo.getMeta('lastDailyRun')?.day === localDay(current);
    if (!doneToday) return (today > current ? today : current).toISOString();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString();
  }

  function summarize(run, scoring, minScore) {
    const strong = (scoring.results || []).filter(item => item.score >= minScore).sort((a, b) => b.score - a.score);
    if (!run.newCount && !strong.length) return;
    const names = strong.slice(0, 3).map(item => {
      const posting = repo.postingForScoring(item.id);
      return posting ? `${posting.company || ''} ${posting.title} (${item.score})`.trim() : null;
    }).filter(Boolean);
    notify({ kind: 'daily', ...message(repo.getSettings().language, 'daily', { newCount: run.newCount, strong: strong.length, names }), refId: run.id });
  }

  // A stopped run keeps what it found and skips what is left: the rest of the
  // search, the scoring and the application check.
  async function pipeline({ trigger, searchIds, track, signal }) {
    const settings = repo.getSettings();
    phase = 'search';
    const { run, newIds } = await runner.run({ trigger, searchIds, signal });
    let scoring = { scored: 0, results: [] };
    const mode = settings.ai.scoreMode;
    if (signal.aborted) return { run, scoring: { scored: 0, failed: 0, reason: null }, tracking: null, cancelled: true };
    if (mode === 'auto' || mode === 'saved') {
      phase = 'score';
      try {
        // auto: today's new postings first, then any older ones still unscored.
        // saved: only the saved jobs that are still unscored.
        const backlog = repo.unscoredPostingIds(settings.ai.maxPerRun, { savedOnly: mode === 'saved' });
        const ids = mode === 'auto' ? [...new Set([...newIds, ...backlog])] : backlog;
        // An empty list would make scoreBatch fall back to every unscored job.
        if (ids.length) scoring = await scorer.scoreBatch(ids, { limit: settings.ai.maxPerRun, signal });
        if (scoring.reason && scoring.reason !== 'no-resume') {
          run.detail.push({ source: 'AI', warning: scoring.reason });
          if (run.status === 'succeeded') run.status = 'partial';
        }
        if (scoring.cancelled) {
          run.detail.push({ source: 'dayjob', warning: 'Stopped before it finished.', cancelled: true });
          if (run.status === 'succeeded') run.status = 'partial';
        }
        repo.updateRunScoring(run.id, { scored: scoring.scored, status: run.status, detail: run.detail });
      } catch (error) { log(`[dayjob] scoring: ${error.message}`); }
    }
    if (signal.aborted) return { run: { ...run, scored: scoring.scored }, scoring: { scored: scoring.scored, failed: scoring.failed || 0, reason: null }, tracking: null, cancelled: true };
    let tracking = null;
    if (track) {
      phase = 'track';
      try { tracking = await tracker.run({ signal }); } catch (error) { log(`[dayjob] tracking: ${error.message}`); }
      repo.purgeOldPostings(settings.retentionDays);
    }
    summarize(run, scoring, settings.notifications.minScore);
    return { run: { ...run, scored: scoring.scored }, scoring: { scored: scoring.scored, failed: scoring.failed || 0, reason: scoring.reason || null }, tracking };
  }

  function start(options) {
    if (flight) return flight;
    stopper = new AbortController();
    flight = pipeline({ ...options, signal: stopper.signal }).finally(() => { flight = null; phase = null; stopper = null; });
    return flight;
  }

  async function tick() {
    const { schedule } = repo.getSettings();
    if (!schedule.enabled || flight) return;
    const current = now();
    if (current < scheduledAt(schedule.time, current) || repo.getMeta('lastDailyRun')?.day === localDay(current)) return;
    repo.setMeta('lastDailyRun', { day: localDay(current), startedAt: current.toISOString() });
    try { await start({ trigger: 'schedule', track: true }); }
    catch (error) { log(`[dayjob] daily run: ${error.message}`); }
  }

  return {
    get phase() { return phase; },
    get running() { return Boolean(flight); },
    get stopping() { return Boolean(stopper?.signal.aborted); },
    // Stops the running search (manual or daily); false when none is running.
    cancel() {
      if (!flight || stopper.signal.aborted) return false;
      stopper.abort(Object.assign(new Error('The search was stopped.'), { cancelled: true }));
      return true;
    },
    nextRunAt,
    tick,
    // Manual runs search and score; the daily run also updates applications.
    runNow: ({ searchIds, track = !searchIds?.length } = {}) => start({ trigger: 'manual', searchIds, track }),
    async track() {
      if (flight) await flight.catch(() => {});
      phase = 'track';
      try { return await tracker.run(); } finally { phase = null; }
    },
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
      setTimeout(() => { void tick(); }, 3000).unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    wait: () => flight?.catch(() => {}) ?? Promise.resolve(),
  };
}
