import test from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../src/dayjob/detail-swap.js';

// The Today page in a 992-high view: the pane begins 173 down the page, the list beside it stays 46 under the
// top once the page is scrolled 127, and 28 of padding follow the pane.
const page = { height: 984, paneTop: 173, below: 28, sticky: true, stickyTop: 46 };

test('with the header scrolled away, another job leaves the page and the list where they were', () => {
  // The page stood exactly where the list begins to stay put: it stays, and the pane is kept tall enough for that
  // even when the next job is two lines long.
  assert.deepEqual(settle({ ...page, top: 127 }), { top: 127, minHeight: 910 });
  // Scrolled far down into a long job: the next one starts at its top, and the list has not moved.
  assert.deepEqual(settle({ ...page, top: 900 }), { top: 127, minHeight: 910 });
});

test('near the top of the page nothing moves, and no room is made that is not needed', () => {
  assert.deepEqual(settle({ ...page, top: 0 }), { top: 0, minHeight: 783 });
  assert.deepEqual(settle({ ...page, top: 60 }), { top: 60, minHeight: 843 });
});

test('with the list above the pane (a narrow view) the page keeps its place', () => {
  const stacked = { height: 600, paneTop: 520, below: 28, sticky: false, stickyTop: 0 };
  assert.deepEqual(settle({ ...stacked, top: 400 }), { top: 400, minHeight: 452 });
  assert.deepEqual(settle({ ...stacked, top: 0 }), { top: 0, minHeight: 52 });
  // A pane that begins below what the view shows needs no height at all for a page at its top.
  assert.deepEqual(settle({ ...stacked, paneTop: 700, top: 0 }), { top: 0, minHeight: 0 });
});
