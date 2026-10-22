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

  async function pipeline({ trigger, searchIds, track }) {
    const settings = repo.getSettings();
    phase = 'search';
    const { run, newIds } = await runner.run({ trigger, searchIds });
    let scoring = { scored: 0, results: [] };
    if (settings.ai.autoScore) {
      phase = 'score';
      try {
        // Today's new postings first, then any older ones still unscored.
        const resume = repo.activeResume();
        const backlog = resume ? repo.unscoredPostingIds(resume.id, settings.ai.maxPerRun) : [];
        const ids = [...new Set([...newIds, ...backlog])];
        scoring = await scorer.scoreBatch(ids, { limit: settings.ai.maxPerRun });
        if (scoring.reason && scoring.reason !== 'no-resume') {
          run.detail.push({ source: 'AI', warning: scoring.reason });
          if (run.status === 'succeeded') run.status = 'partial';
        }
        repo.updateRunScoring(run.id, { scored: scoring.scored, status: run.status, detail: run.detail });
      } catch (error) { log(`[dayjob] scoring: ${error.message}`); }
    }
    let tracking = null;
    if (track) {
      phase = 'track';
      try { tracking = await tracker.run(); } catch (error) { log(`[dayjob] tracking: ${error.message}`); }
      repo.purgeOldPostings(settings.retentionDays);
    }
    summarize(run, scoring, settings.notifications.minScore);
    return { run: { ...run, scored: scoring.scored }, scoring: { scored: scoring.scored, failed: scoring.failed || 0, reason: scoring.reason || null }, tracking };
  }

  function start(options) {
    if (flight) return flight;
    flight = pipeline(options).finally(() => { flight = null; phase = null; });
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
