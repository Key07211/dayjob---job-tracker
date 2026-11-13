// How the gramophone moves, worked out from what the assistant is doing and how fast its words arrive. No drawing
// here: step() says where the horn, the record and the crank are right now, and how many notes just left the horn.
//
//   idle      nothing moves
//   thinking  the record turns
//   tool      the record turns and the crank is wound
//   speaking  the record turns; the horn pulls in, pushes out and lets notes go, faster the faster the words come
//
// One note stands for TOKENS_PER_NOTE tokens. The horn pushes at most five times a second, so quick speech sends
// two or three notes with each push instead of pushing faster.
export const TOKENS_PER_NOTE = 8;
const MAX_PER_PUMP = 3;
const BIG_FROM = 48;                 // tokens a second from which the horn pushes out the whole way
const STEP = 0.156;                  // a sixteenth note at 96 beats a minute: one move of the record or the crank
const BACKLOG = TOKENS_PER_NOTE * MAX_PER_PUMP * 4;   // words that came in one lump are played out over about a second
const LAST_PUSH = TOKENS_PER_NOTE * MAX_PER_PUMP;     // once the reply has ended, what is left is worth one push at most
const SMALL = [-1, 1, 1, 0, 0];
const BIG = [-1, 2, 2, 1, 0];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Roughly how many tokens a piece of reply text is: one for each Chinese, Japanese or Korean character, one for each
// run of Latin letters or digits, one for each other mark. Close enough to pace an animation by.
export const countTokens = text => (String(text || '').match(/[⺀-鿿가-힯　-〿＀-￯]|[A-Za-z0-9À-ɏ]+|[^\sA-Za-z0-9À-ɏ]/g) || []).length;

export function createHorn() {
  let clock = 0, spinTime = 0, crankTime = 0, credit = 0, pump = null, lastPump = -10, speakingSince = 0, phase = 'idle';
  let heard = [];                    // [time, tokens] for the last second
  let due = [];                      // when the notes of the current push leave
  const rate = () => heard.reduce((sum, item) => sum + item[1], 0) / clamp(clock - speakingSince, 0.3, 1);

  return {
    // Words arrived: so many tokens of them.
    hear(tokens) {
      if (!(tokens > 0)) return;
      heard.push([clock, tokens]);
      credit = Math.min(credit + tokens, phase === 'speaking' ? BACKLOG : LAST_PUSH);
    },
    // Tokens a second over the last second.
    rate,
    // Moves time on by dt seconds. Returns the frame to show, how many notes left the horn during this step, how
    // hard they were thrown (1 for slow speech, up to 1.6), and whether anything is still in motion.
    step(dt, now = 'idle') {
      clock += dt;
      while (heard.length && heard[0][0] < clock - 1) heard.shift();
      if (now !== phase) {
        if (now === 'speaking') speakingSince = clock;
        else credit = Math.min(credit, LAST_PUSH);
        phase = now;
      }
      if (phase !== 'idle') spinTime += dt;
      if (phase === 'tool') crankTime += dt;

      let grow = 0;
      if (pump) {
        const at = (clock - pump.start) / pump.length;
        if (at >= 1) pump = null;
        else {
          const shape = pump.big ? BIG : SMALL;
          grow = shape[Math.min(shape.length - 1, Math.floor(at * shape.length))];
          if (!pump.fired && at >= 0.2) { pump.fired = true; for (let i = 0; i < pump.notes; i += 1) due.push(clock + i * 0.055); }
        }
      }
      // A new push starts once a note's worth of words is waiting. Slow or very short speech still gets a note:
      // after a second without one, any words at all are enough. A few words left over when the reply has ended,
      // right after a push, are let go.
      if (!pump && credit > 0) {
        if (credit >= TOKENS_PER_NOTE || clock - lastPump >= 1) {
          const notes = clamp(Math.floor(credit / TOKENS_PER_NOTE), 1, MAX_PER_PUMP), speed = rate();
          credit = Math.max(0, credit - notes * TOKENS_PER_NOTE);
          pump = { start: clock, length: clamp(notes * TOKENS_PER_NOTE / Math.max(speed, 1), 0.2, 0.42), big: speed >= BIG_FROM || notes >= 2, notes, fired: false };
          lastPump = clock;
          grow = (pump.big ? BIG : SMALL)[0];
        } else if (phase !== 'speaking') credit = 0;
      }
      let notes = 0;
      if (due.length) due = due.filter(time => { if (time > clock) return true; notes += 1; return false; });

      return { grow, spin: Math.floor(spinTime / STEP) % 8, crank: phase === 'tool' ? Math.floor(crankTime / STEP) % 4 : -1, notes,
        boost: 1 + Math.min(rate(), 120) / 200, moving: phase !== 'idle' || Boolean(pump) || due.length > 0 || credit > 0 };
    },
  };
}
