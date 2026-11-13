import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BEAT, HOLD, LOGO, OPENINGS, OPENING_TOKENS, OUT, T_OUT, fitStage, fromRows, outTime, paintOpening, pickOpening } from '../src/dayjob/groove/opening-scenes.js';

// A grid that takes the three calls a scene makes: a cell holds the colour last painted on it, or null where the
// picture was cleared (the page shows through there).
function grid(W, H) {
  const cells = new Array(W * H).fill(undefined);
  const each = (x, y, w, h, value) => {
    for (let row = Math.max(0, Math.round(y)); row < Math.min(H, Math.round(y + h)); row += 1) {
      for (let col = Math.max(0, Math.round(x)); col < Math.min(W, Math.round(x + w)); col += 1) cells[row * W + col] = value;
    }
  };
  const g = { fillStyle: '', fillRect(x, y, w, h) { each(x, y, w, h, g.fillStyle); }, clearRect(x, y, w, h) { each(x, y, w, h, null); } };
  return { g, cells, at: (x, y) => cells[y * W + x] };
}
// Every colour gets a name of its own, so a painted cell says what painted it.
const C = Object.fromEntries(Object.keys(OPENING_TOKENS).map(name => [name, `c:${name}`]));
const block = (colour, size = LOGO) => fromRows(Array.from({ length: size }, () => '#'.repeat(size)), { '#': colour });
const A = { tile: block(C.tile), bag: block(C.case), deck: block(C.deck), sheet: fromRows(['EEE', 'EWE', 'EEE'], { E: C.sheetEdge, W: C.sheet }) };
const W = 132, H = 82;
const picture = (id, t, tOut = T_OUT) => { const stage = grid(W, H); paintOpening(stage.g, id, t, tOut, W, H, C, A); return stage; };
const cleared = cells => cells.filter(cell => cell === null).length;

test('three openings, one at random and never the one that played last', () => {
  assert.deepEqual(OPENINGS, ['gramophone', 'wave', 'briefcase']);
  for (const last of [...OPENINGS, null, 'gone']) {
    const seen = new Set();
    for (let step = 0; step < 60; step += 1) seen.add(pickOpening(last, () => step / 60));
    const expected = OPENINGS.filter(id => id !== last);
    assert.deepEqual([...seen].sort(), [...expected].sort(), `after ${last}`);
  }
  // A generator that returns exactly 1 (never should, but must not fall off the end).
  assert.ok(OPENINGS.includes(pickOpening('wave', () => 1)));
});

test('the stage covers the window in whole square pixels, about 132 across and at least 72 down', () => {
  for (const [width, height, ratio] of [[1440, 960, 1], [1440, 960, 1.5], [960, 640, 1], [2560, 1400, 2], [3440, 1300, 1], [960, 1400, 1], [300, 200, 1]]) {
    const { k, W: wide, H: tall } = fitStage(width, height, ratio);
    assert.ok(Number.isInteger(k) && k >= 2, `${width}x${height}: k = ${k}`);
    assert.ok(wide * k >= width * ratio && tall * k >= height * ratio, `${width}x${height} is covered`);
    assert.ok((wide - 1) * k < width * ratio && (tall - 1) * k < height * ratio, `${width}x${height}: no more than one pixel over`);
    if (height * ratio >= 144) assert.ok(tall >= 72, `${width}x${height}: ${tall} rows`);
  }
  assert.equal(fitStage(1440, 960, 1).W, 131);
});

test('it gives way after four beats, or on the first beat after slow data, and never waits for ever', () => {
  assert.equal(T_OUT + OUT, BEAT * 4);
  assert.equal(outTime(0, 0), T_OUT);
  assert.equal(outTime(T_OUT, T_OUT), T_OUT);
  assert.equal(outTime(T_OUT + 1, T_OUT + 1), T_OUT + BEAT);
  assert.equal(outTime(T_OUT + BEAT + 40, T_OUT + BEAT + 40), T_OUT + 2 * BEAT);
  // No data yet: not known, until patience runs out.
  assert.equal(outTime(null, 0), Infinity);
  assert.equal(outTime(null, T_OUT + 8 * BEAT - 1), Infinity);
  assert.equal(outTime(null, T_OUT + 8 * BEAT), T_OUT + 8 * BEAT);
  assert.equal(outTime(null, 5000, 2), T_OUT + 2 * BEAT);
  // Data that came after the patience ran out does not move the end later.
  assert.equal(outTime(T_OUT + 20 * BEAT, T_OUT + 20 * BEAT), T_OUT + 8 * BEAT);
});

for (const id of OPENINGS) {
  test(`${id}: the cover is whole from the first frame and until it gives way`, () => {
    for (const t of [0, 16, 200, BEAT, HOLD, HOLD + 300, T_OUT - 1]) {
      const { cells } = picture(id, t);
      assert.equal(cells.filter(cell => cell === undefined).length, 0, `t = ${t}: every pixel is painted`);
      assert.equal(cleared(cells), 0, `t = ${t}: nothing is cleared yet`);
    }
    // The very first frame is already a picture, not an empty ground.
    assert.ok(new Set(picture(id, 0).cells).size > 1, 'the first frame has more than the ground on it');
  });

  test(`${id}: the picture is set up in two beats and then holds`, () => {
    const colours = t => new Set(picture(id, t).cells);
    assert.ok(colours(HOLD + 400).has(C.ink), 'the word is there');
    assert.ok(colours(HOLD + 400).size > colours(0).size, 'more of the picture than at the start');
    // While it holds for slow data (tOut far away) it is still whole, beats later.
    const late = picture(id, T_OUT + 5 * BEAT, T_OUT + 8 * BEAT);
    assert.equal(cleared(late.cells), 0);
    assert.ok(new Set(late.cells).has(C.ink));
  });

  test(`${id}: it gives way from the corners inwards, and is gone when the time is up`, () => {
    let before = 0;
    for (const step of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const { cells } = picture(id, T_OUT + OUT * step);
      assert.ok(cleared(cells) >= before, `more is clear at ${step}`);
      before = cleared(cells);
    }
    const half = picture(id, T_OUT + OUT * 0.5);
    assert.equal(half.at(0, 0), null, 'a corner goes early');
    assert.notEqual(half.at(W >> 1, H >> 1), null, 'the middle is still there half way');
    assert.ok(cleared(half.cells) > 0 && cleared(half.cells) < W * H);
    assert.equal(cleared(picture(id, T_OUT + OUT).cells), W * H, 'all of it is clear at the end');
    // A later start to the end (slow data) moves the whole thing by whole beats.
    const moved = T_OUT + 3 * BEAT;
    assert.equal(cleared(picture(id, moved - 1, moved).cells), 0);
    assert.equal(cleared(picture(id, moved + OUT, moved).cells), W * H);
  });
}

test('every colour a scene asks for has a property to come from', () => {
  const css = ['groove/opening.css', 'groove/groove.css', 'dayjob.css'].map(file => fs.readFileSync(new URL(`../src/dayjob/${file}`, import.meta.url), 'utf8')).join('\n');
  for (const [name, token] of Object.entries(OPENING_TOKENS)) {
    assert.match(token, /^--[a-z-]+$/, name);
    assert.ok(css.includes(`${token}:`), `${token} is set in the styles`);
  }
  // The scenes never paint a colour that was not handed in.
  const known = new Set([...Object.values(C), null]);
  for (const id of OPENINGS) for (const t of [0, 400, HOLD, T_OUT, T_OUT + 200]) {
    for (const cell of picture(id, t).cells) {
      if (typeof cell === 'string' && cell.startsWith('#')) continue;   // the gramophone's own fixed pixels
      assert.ok(known.has(cell), `${id} at ${t}: ${cell}`);
    }
  }
});
