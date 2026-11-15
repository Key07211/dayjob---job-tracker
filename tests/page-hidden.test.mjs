import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installHidden, HIDDEN_SOURCE } = require('../desktop/page-hidden.cjs');

// A page reduced to what the check asks of it: boxes with a place, a parent and a few attributes, in a window of a
// given size. The topmost box at a point is the one drawn last (or with the highest `over`) that holds the point.
function page({ width = 1280, height = 900, scrollY = 0 } = {}) {
  const all = [];
  const view = { innerWidth: width, innerHeight: height, scrollY };
  const doc = {
    defaultView: view,
    querySelectorAll: () => all.filter(el => (el.tag === 'DIALOG' && el.attrs.open !== undefined) || el.attrs['aria-modal'] === 'true'),
    elementFromPoint(x, y) {
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return null;
      const holding = all.filter(el => el.drawn && x >= el.rect.left && x < el.rect.right && y >= el.rect.top && y < el.rect.bottom);
      return holding.sort((a, b) => (b.over - a.over) || (all.indexOf(b) - all.indexOf(a)))[0] || null;
    },
  };
  const matchesOne = (el, selector) => (selector === '[inert]' ? el.attrs.inert !== undefined
    : selector === '[aria-hidden="true"]' ? el.attrs['aria-hidden'] === 'true'
      : selector === ':modal' ? el.modal === true : false);
  function box(tag, [left, top, w, h], parent = null, attrs = {}, more = {}) {
    const el = {
      tag, tagName: tag, attrs, parentElement: parent, ownerDocument: doc, drawn: true, opaque: true, over: 0, ...more,
      rect: { left, top, right: left + w, bottom: top + h, width: w, height: h },
      getBoundingClientRect() { return this.rect; },
      getRootNode: () => doc,
      // Asked with opacityProperty, a see-through box does not count as drawn.
      checkVisibility(options = {}) { return this.drawn && (!options.opacityProperty || this.opaque); },
      matches(selector) { return matchesOne(this, selector); },
      closest(selector) { for (let at = this; at; at = at.parentElement) if (matchesOne(at, selector)) return at; return null; },
      contains(other) { for (let at = other; at; at = at.parentElement) if (at === this) return true; return false; },
    };
    all.push(el);
    return el;
  }
  return { box, view, doc };
}

// Verdicts are kept for a moment; a test that changes the page steps the clock past that.
function withClock(run) {
  const real = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try { run(ms => { now += ms; }); } finally { Date.now = real; }
}

test('a box marked aria-hidden that fills the window with no dialog open is read: its fields are in plain view', () => {
  const { box } = page();
  const hidden = installHidden();
  // Meta Careers: the scrolling box that holds the whole application form is marked, and nothing lies over it.
  const scrollview = box('DIV', [0, 0, 1280, 900], null, { 'aria-hidden': 'true' });
  const form = box('FORM', [200, 100, 800, 3000], scrollview);
  const first = box('INPUT', [220, 140, 400, 40], form);
  const submit = box('BUTTON', [220, 2900, 200, 44], form);
  assert.equal(hidden(first), false);
  assert.equal(hidden(submit), false, 'also what is further down inside it');
  assert.equal(hidden(scrollview), false);
  // A page with no marks at all is untouched.
  assert.equal(hidden(box('INPUT', [10, 10, 100, 30])), false);
});

test('what a page really keeps away stays hidden', () => {
  const { box } = page();
  const hidden = installHidden();
  const scrollview = box('DIV', [0, 0, 1280, 900], null, { 'aria-hidden': 'true' });

  // A field for robots: a small marked box of its own, inside the large one that is read.
  const trap = box('DIV', [220, 300, 300, 40], scrollview, { 'aria-hidden': 'true' });
  assert.equal(hidden(box('INPUT', [220, 300, 300, 40], trap)), true);
  // A marked field with no box around it.
  assert.equal(hidden(box('INPUT', [220, 400, 300, 40], scrollview, { 'aria-hidden': 'true' })), true);
  // A second copy of a link, marked on itself.
  assert.equal(hidden(box('A', [20, 20, 120, 40], scrollview, { 'aria-hidden': 'true' })), true);
  // inert, whatever its size.
  const inert = box('DIV', [0, 0, 1280, 900], null, { inert: '' });
  assert.equal(hidden(box('BUTTON', [10, 10, 100, 40], inert)), true);
  // A large menu waiting off to the left, and a large box parked above the top of the page.
  const drawer = box('NAV', [-900, 0, 900, 900], null, { 'aria-hidden': 'true' });
  assert.equal(hidden(box('A', [-880, 20, 200, 40], drawer)), true);
  const parked = box('DIV', [0, -5000, 1280, 900], null, { 'aria-hidden': 'true' });
  assert.equal(hidden(box('INPUT', [10, -4990, 200, 40], parked)), true);
  // A slide that is see-through until its turn, and a box that is not drawn at all.
  const slide = box('DIV', [0, 0, 1280, 900], null, { 'aria-hidden': 'true' }, { opaque: false });
  assert.equal(hidden(box('A', [100, 100, 300, 60], slide)), true);
  const gone = box('DIV', [0, 0, 1280, 900], null, { 'aria-hidden': 'true' }, { drawn: false });
  assert.equal(hidden(box('A', [100, 100, 300, 60], gone)), true);
});

test('the page behind an open dialog is hidden, the dialog is not', () => {
  withClock(step => {
    const { box } = page();
    const hidden = installHidden();
    const main = box('DIV', [0, 0, 1280, 900], null, { 'aria-hidden': 'true' });
    const field = box('INPUT', [220, 140, 400, 40], main);
    assert.equal(hidden(field), false, 'before the dialog opens');

    // A backdrop over the whole window with the dialog on it: a click on the page no longer lands in the page.
    const backdrop = box('DIV', [0, 0, 1280, 900], null, {}, { over: 10 });
    const dialog = box('DIV', [340, 250, 600, 400], backdrop, { role: 'dialog' }, { over: 11 });
    const confirm = box('BUTTON', [600, 560, 120, 44], dialog, {}, { over: 12 });
    assert.equal(hidden(field), false, 'the answer for a box is kept for a moment');
    step(100);
    assert.equal(hidden(field), true);
    assert.equal(hidden(confirm), false);

    // The dialog closes: the page is read again.
    backdrop.drawn = false; dialog.drawn = false; confirm.drawn = false;
    step(100);
    assert.equal(hidden(field), false);
  });
});

test('a dialog marked as taking the page over hides the marked page even with no backdrop', () => {
  const { box } = page();
  const hidden = installHidden();
  const main = box('DIV', [0, 0, 1280, 900], null, { 'aria-hidden': 'true' });
  const field = box('INPUT', [220, 140, 400, 40], main);
  // Small and in a corner, so most clicks on the page would still land in the page.
  const dialog = box('DIV', [900, 600, 300, 200], null, { role: 'dialog', 'aria-modal': 'true' }, { over: 5 });
  assert.equal(hidden(field), true);
  assert.equal(hidden(box('BUTTON', [920, 720, 100, 40], dialog, {}, { over: 6 })), false);

  // A <dialog> shown without taking the page over (show(), not showModal()) leaves the page in use.
  const other = page();
  const still = installHidden();
  const body = other.box('DIV', [0, 0, 1280, 900], null, { 'aria-hidden': 'true' });
  const input = other.box('INPUT', [220, 140, 400, 40], body);
  const note = other.box('DIALOG', [900, 600, 300, 200], null, { open: '' }, { over: 5, modal: false });
  assert.equal(still(input), false);
  note.modal = true;
  assert.equal(installHidden()(input), true, 'opened with showModal() it does');

  // A dialog inside the marked box is part of it, not a reason to hide it.
  const third = page();
  const whole = third.box('DIV', [0, 0, 1280, 900], null, { 'aria-hidden': 'true' });
  third.box('DIV', [340, 250, 600, 400], whole, { role: 'dialog', 'aria-modal': 'true' });
  assert.equal(installHidden()(third.box('INPUT', [20, 20, 200, 40], whole)), false);
});

test('a bar over one edge does not hide the page, and a box below the window needs no look at what is over it', () => {
  const { box } = page();
  const hidden = installHidden();
  const main = box('DIV', [0, 0, 1280, 900], null, { 'aria-hidden': 'true' });
  const field = box('INPUT', [220, 140, 400, 40], main);
  // A cookie bar along the bottom third: six of nine points still land in the page.
  box('DIV', [0, 600, 1280, 300], null, {}, { over: 10 });
  assert.equal(hidden(field), false);

  // Marked content that starts below the window (the page has to be scrolled to it).
  const lower = page();
  const below = lower.box('DIV', [0, 1400, 1280, 2000], null, { 'aria-hidden': 'true' });
  assert.equal(installHidden()(lower.box('INPUT', [20, 1500, 300, 40], below)), false);

  // A tab that was never given a size: the mark alone decides nothing.
  const blank = page({ width: 0, height: 0 });
  const unsized = blank.box('DIV', [0, 0, 0, 0], null, { 'aria-hidden': 'true' });
  assert.equal(installHidden()(blank.box('INPUT', [0, 0, 100, 20], unsized)), false);
});

test('the three page scripts carry the check and build without error', () => {
  const { PAGE_SOURCE } = require('../desktop/browser-page.cjs');
  const { autofillScript } = require('../desktop/autofill.cjs');
  const { loginScript } = require('../desktop/login.cjs');
  for (const source of [`${PAGE_SOURCE}.snapshot()`, autofillScript('dayjobFill1', 'scan'), loginScript('find')]) {
    assert.ok(source.includes(HIDDEN_SOURCE), 'the check is in the script');
    assert.doesNotThrow(() => new Function(`return ${source}`));
    // No script decides by the mark alone any more.
    assert.equal(source.split(HIDDEN_SOURCE).join('').includes('[aria-hidden="true"], [inert]'), false);
  }
});
