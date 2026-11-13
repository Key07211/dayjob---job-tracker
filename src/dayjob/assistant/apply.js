// Where an application the assistant is working on stands, read off the tools it has used in the conversation.
// Each applying tool says which step it was (open, login, fill, resume, questions, confirm, record) and leaves a few
// plain facts: the job, the resume's name, how many fields it filled. Nothing here comes from the web page itself
// except the name of the button that was clicked to send.
export const APPLY_STEPS = ['open', 'login', 'fill', 'resume', 'questions', 'confirm', 'record'];
const at = step => APPLY_STEPS.indexOf(step);
const fresh = () => ({ reached: -1, turn: -1, job: '', postingId: null, site: '', resume: '', filled: 0, answered: 0, letter: '', submitted: '', allowed: '' });

// The latest application in these turns, or null when there is none. reached: the furthest step done (an index
// into APPLY_STEPS); turn: the turn its latest step was in.
export function applyRun(turns = []) {
  let run = null;
  turns.forEach((turn, index) => {
    for (const tool of turn.tools || []) {
      const step = tool.ok && !tool.undone ? at(tool.step) : -1;
      if (step < 0) continue;
      // Opening a posting's application page starts over; so does opening a page once the last one was recorded.
      if (tool.step === 'open' && (!run || tool.name === 'open_application' || run.reached >= at('record'))) run = fresh();
      // Recording an application the user sent themselves is not one the assistant worked on.
      if (!run) { if (tool.step === 'record') continue; run = fresh(); }
      // Typing into a page before any form was filled in (a search box, say) is not answering its questions.
      if (tool.step === 'questions' && run.reached < at('fill')) continue;
      const facts = tool.facts || {};
      run.reached = Math.max(run.reached, step);
      run.turn = index;
      if (facts.job) { run.job = facts.job; run.postingId = facts.postingId || null; }
      if (facts.site) run.site = facts.site;
      if (facts.resume) run.resume = facts.resume;
      if (facts.filled) run.filled += facts.filled;
      if (facts.answered) run.answered += facts.answered;
      if (facts.letter) run.letter = facts.letter;
      if (facts.submitted) { run.submitted = facts.submitted; run.allowed = facts.allowed || ''; }
    }
  });
  return run;
}

// Each step for the strip above the chat: done, now (the one being worked on or waited for), or to come.
// asking: the card that asks before sending is up; busy: a reply is being written.
export function stepStates(run, { asking = false, busy = false } = {}) {
  const now = asking ? at('confirm') : busy && run.reached < at('record') ? run.reached + 1 : -1;
  return APPLY_STEPS.map((step, index) => ({ step, state: index === now ? 'now' : index <= run.reached && !(asking && index >= at('confirm')) ? 'done' : 'todo' }));
}
