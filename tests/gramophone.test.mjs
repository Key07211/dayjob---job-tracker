import test from 'node:test';
import assert from 'node:assert/strict';
import { BAYER, COLORS, H, NOTES, W, frame, mouth } from '../src/dayjob/assistant/gramophone.js';
import { TOKENS_PER_NOTE, countTokens, createHorn } from '../src/dayjob/assistant/horn.js';

const FRAME = 1 / 60;
const painted = pixels => pixels.filter(Boolean).length;
const differing = (a, b) => a.reduce((count, value, index) => count + (value !== b[index] ? 1 : 0), 0);

// Runs the horn for some seconds at 60 frames a second. Words arrive `rate` tokens a second, `chunk` at a time.
function run(horn, seconds, { phase = 'speaking', rate = 0, chunk = 1 } = {}) {
  const seen = { notes: 0, pushes: 0, grows: new Set(), spins: new Set(), cranks: new Set(), last: null };
  let owed = 0, was = 0;
  for (let i = 0; i < Math.round(seconds / FRAME); i += 1) {
    owed += rate * FRAME;
    while (owed >= chunk) { horn.hear(chunk); owed -= chunk; }
    const now = horn.step(FRAME, phase);
    seen.notes += now.notes;
    if (now.grow === -1 && was !== -1) seen.pushes += 1;
    was = now.grow;
    seen.grows.add(now.grow); seen.spins.add(now.spin); seen.cranks.add(now.crank);
    seen.last = now;
  }
  return seen;
}

test('the gramophone is painted on its small grid, and the horn grows a step at a time', () => {
  const rest = frame(0, 0, -1);
  assert.equal(rest.length, W * H);
  assert.ok(rest.every(value => value < COLORS.length));
  assert.deepEqual([...frame(0, 0, -1)], [...rest], 'the same frame every time');
  const sizes = [-1, 0, 1, 2].map(grow => painted(frame(grow, 0, -1)));
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2] && sizes[2] < sizes[3], `the horn gets bigger: ${sizes}`);
  // Nothing is cut off at the edge of the frame, even with the horn pushed out the whole way.
  for (const grow of [-1, 0, 1, 2]) {
    const pixels = frame(grow, 3, 2);
    for (let x = 0; x < W; x += 1) assert.equal(pixels[x], 0, `top row is clear at grow ${grow}`);
    for (let y = 0; y < H; y += 1) { assert.equal(pixels[y * W], 0); assert.equal(pixels[y * W + W - 1], 0); }
  }
  assert.ok(mouth(2).major > mouth(0).major && mouth(-1).major < mouth(0).major);
});

test('a turn of the record or the crank changes only a few pixels', () => {
  const rest = frame(0, 0, -1);
  // Two glints sit opposite each other on the record, so half a turn looks like the start again.
  for (let spin = 1; spin < 4; spin += 1) {
    const moved = differing(rest, frame(0, spin, -1));
    assert.ok(moved > 0 && moved <= 6, `spin ${spin} moves ${moved} pixels`);
    assert.deepEqual([...frame(0, spin + 4, -1)], [...frame(0, spin, -1)]);
  }
  assert.deepEqual([...frame(0, 4, -1)], [...rest]);
  const cranks = [0, 1, 2, 3].map(crank => frame(0, 0, crank));
  assert.equal(new Set(cranks.map(pixels => pixels.join(''))).size, 4, 'the crank has four positions');
  assert.ok(cranks.every(pixels => differing(rest, pixels) <= 12), 'only the handle moves');
  assert.deepEqual([...cranks[2]], [...rest], 'the handle comes to rest pointing down');
});

test('the notes are small bitmaps and the fade table uses each step once', () => {
  assert.ok(NOTES.length >= 3);
  for (const note of NOTES) {
    assert.ok(note.w <= 7 && note.h <= 6);
    assert.equal(note.on.length, note.h);
    assert.ok(note.on.every(row => row.length === note.w));
  }
  assert.deepEqual(BAYER.flat().sort((a, b) => a - b), Array.from({ length: 16 }, (_, index) => index));
});

test('reply text is counted in rough tokens', () => {
  assert.equal(countTokens(''), 0);
  assert.equal(countTokens('   \n'), 0);
  assert.equal(countTokens('今天有新岗位'), 6);
  assert.equal(countTokens('Machine Learning Engineer'), 3);
  assert.equal(countTokens('Northwind AI，76 分。'), 6);
  assert.equal(countTokens(undefined), 0);
});

test('idle, nothing moves; thinking turns the record; a tool call winds the crank', () => {
  const idle = run(createHorn(), 2, { phase: 'idle' });
  assert.deepEqual([[...idle.grows], [...idle.spins], [...idle.cranks], idle.notes, idle.last.moving], [[0], [0], [-1], 0, false]);
  const thinking = run(createHorn(), 2, { phase: 'thinking' });
  assert.deepEqual([[...thinking.grows], thinking.spins.size, [...thinking.cranks], thinking.notes], [[0], 8, [-1], 0]);
  const tool = run(createHorn(), 2, { phase: 'tool' });
  assert.deepEqual([[...tool.grows], tool.spins.size, [...tool.cranks].sort(), tool.notes], [[0], 8, [0, 1, 2, 3], 0]);
  assert.equal(tool.last.moving, true);
});

test('notes follow how fast the words come', () => {
  for (const [rate, low, high] of [[15, 1.5, 2.3], [40, 4.3, 5.6], [100, 11, 13.5]]) {
    const horn = createHorn();
    run(horn, 1, { rate });
    const seen = run(horn, 4, { rate });
    assert.ok(seen.notes / 4 >= low && seen.notes / 4 <= high, `${rate} tokens a second gave ${seen.notes / 4} notes a second`);
    assert.ok(Math.abs(horn.rate() - rate) <= rate * 0.15 + 1, `measured ${horn.rate()} for ${rate}`);
    assert.ok(seen.pushes / 4 <= 5.01, `never more than five pushes a second (${seen.pushes / 4})`);
  }
  assert.equal(TOKENS_PER_NOTE, 8);
});

test('slow speech pushes gently, quick speech the whole way, and a stall brings the horn to rest', () => {
  const horn = createHorn();
  assert.deepEqual([...run(horn, 3, { rate: 15 }).grows].sort((a, b) => a - b), [-1, 0, 1]);
  const quick = createHorn();
  run(quick, 1, { rate: 90 });
  assert.ok(run(quick, 2, { rate: 90 }).grows.has(2));
  // The words stop while the reply is still open: the horn settles and no notes leave it.
  run(quick, 1.5, { rate: 0 });
  const stalled = run(quick, 2, { rate: 0 });
  assert.deepEqual([[...stalled.grows], stalled.notes], [[0], 0]);
  assert.equal(stalled.last.moving, true, 'the record still turns while the reply is open');
});

test('words that arrive in lumps are still spread over pushes', () => {
  const horn = createHorn();
  // A model that sends a dozen tokens every third of a second: about 36 tokens a second.
  const seen = run(horn, 4, { rate: 36, chunk: 12 });
  assert.ok(seen.notes >= 14 && seen.notes <= 20, `${seen.notes} notes`);
  // A whole long reply in one piece plays out for about a second, not all at once and not for ever.
  const lump = createHorn();
  lump.step(FRAME, 'speaking');
  lump.hear(400);
  const first = run(lump, 0.5);
  const rest = run(lump, 3);
  assert.ok(first.notes >= 3 && first.notes <= 9, `${first.notes} notes in the first half second`);
  assert.equal(first.notes + rest.notes, 12);
  assert.equal(run(lump, 1).notes, 0);
});

test('a short reply still gets its note, and everything stops once the reply has ended', () => {
  const horn = createHorn();
  run(horn, 1, { phase: 'thinking' });
  horn.step(FRAME, 'speaking');
  horn.hear(3);
  const after = run(horn, 2, { phase: 'idle' });
  assert.equal(after.notes, 1);
  assert.deepEqual([after.last.grow, after.last.crank, after.last.moving], [0, -1, false]);
  const spin = after.last.spin;
  assert.equal(run(horn, 1, { phase: 'idle' }).last.spin, spin, 'the record stays where it stopped');

  // A reply that came and went before the pane saw it speaking: one push, then rest.
  const unseen = createHorn();
  unseen.hear(200);
  const seen = run(unseen, 2, { phase: 'idle' });
  assert.deepEqual([seen.notes, seen.pushes, seen.last.moving], [3, 1, false]);

  // A few words left over right after a push are let go rather than turned into a late note.
  const tail = createHorn();
  run(tail, 2, { rate: 40 });
  tail.hear(2);
  const ending = run(tail, 3, { phase: 'idle' });
  assert.ok(ending.notes <= 3, `${ending.notes} notes after the end`);
  assert.equal(ending.last.moving, false);
});
