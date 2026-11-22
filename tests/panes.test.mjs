import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_WIDTH, PANE_MIN, SIDEBAR, SIDE_MIN_WINDOW, VIEW_MIN, panesFor, paneLimits } from '../src/dayjob/panes.js';

// From left to right: the sidebar, the page, the assistant's side chat, the browser. What the page keeps is the
// window less the sidebar, the side chat and the browser.
const pageWidth = (windowWidth, panes) => windowWidth - SIDEBAR - panes.beside - (panes.wide ? Infinity : panes.width);

test('the browser alone stands beside the page', () => {
  const alone = panesFor({ windowWidth: 1440, browserOpen: true });
  assert.deepEqual([alone.beside, alone.wide, alone.pageHidden, alone.canSide], [0, false, false, true]);
  assert.equal(alone.width, Math.round((1440 - SIDEBAR) * 0.58));
  // Dragged, it keeps the width it was given, between the narrowest it works at and what the page needs.
  assert.equal(panesFor({ windowWidth: 1440, browserOpen: true, paneWidth: 500 }).width, 500);
  assert.equal(panesFor({ windowWidth: 1440, browserOpen: true, paneWidth: 100 }).width, PANE_MIN);
  assert.equal(panesFor({ windowWidth: 1440, browserOpen: true, paneWidth: 5000 }).width, 1440 - SIDEBAR - VIEW_MIN);
  // Asked to take the page's place, it does.
  const filling = panesFor({ windowWidth: 1440, browserOpen: true, browserWide: true });
  assert.deepEqual([filling.wide, filling.pageHidden], [true, true]);
  // Under the narrowest window that holds both, the browser takes the page's place by itself.
  assert.equal(panesFor({ windowWidth: SIDE_MIN_WINDOW, browserOpen: true }).wide, false);
  assert.equal(panesFor({ windowWidth: SIDE_MIN_WINDOW - 1, browserOpen: true }).wide, true);
});

test('with both open the page, the side chat and the browser stand side by side while the page keeps its least width', () => {
  for (const windowWidth of [1920, 1600, 1440, SIDE_MIN_WINDOW + ASSISTANT_WIDTH]) {
    const both = panesFor({ windowWidth, browserOpen: true, chatOpen: true });
    assert.deepEqual([both.assistantOpen, both.assistantFull, both.beside, both.wide, both.pageHidden], [true, false, ASSISTANT_WIDTH, false, false], `at ${windowWidth}`);
    assert.ok(both.width >= PANE_MIN, `the browser is wide enough at ${windowWidth}`);
    assert.ok(pageWidth(windowWidth, both) >= VIEW_MIN, `the page keeps its least width at ${windowWidth}`);
    // However far the divider is dragged, the page keeps it.
    const dragged = panesFor({ windowWidth, browserOpen: true, chatOpen: true, paneWidth: 5000 });
    assert.ok(pageWidth(windowWidth, dragged) >= VIEW_MIN, `dragged at ${windowWidth}`);
  }
  // Not room for all three: the browser takes the page's place and the side chat stays at its left.
  for (const windowWidth of [SIDE_MIN_WINDOW + ASSISTANT_WIDTH - 1, 1280, 1100, 960]) {
    const narrow = panesFor({ windowWidth, browserOpen: true, chatOpen: true });
    assert.deepEqual([narrow.assistantOpen, narrow.beside, narrow.canSide, narrow.wide, narrow.pageHidden], [true, ASSISTANT_WIDTH, false, true, true], `at ${windowWidth}`);
  }
});

test('the side chat alone takes its column and nothing else', () => {
  const chat = panesFor({ windowWidth: 960, chatOpen: true });
  assert.deepEqual([chat.assistantOpen, chat.beside, chat.wide, chat.pageHidden], [true, ASSISTANT_WIDTH, false, false]);
  const closed = panesFor({ windowWidth: 960 });
  assert.deepEqual([closed.assistantOpen, closed.beside, closed.pageHidden], [false, 0, false]);
});

test('the full-page chat stands where the page does, and goes to the side when the browser takes that place', () => {
  const full = panesFor({ windowWidth: 1440, chatOpen: true, chatForm: 'full' });
  assert.deepEqual([full.assistantFull, full.assistantOpen, full.beside, full.pageHidden], [true, false, 0, true]);
  // The browser beside it: the chat keeps the page's place, the browser the edge.
  const beside = panesFor({ windowWidth: 1440, browserOpen: true, chatOpen: true, chatForm: 'full' });
  assert.deepEqual([beside.assistantFull, beside.wide, beside.beside], [true, false, 0]);
  assert.ok(1440 - SIDEBAR - beside.width >= VIEW_MIN);
  // The browser asked to take the page's place, or a window too narrow for both: the chat is the side chat.
  const filled = panesFor({ windowWidth: 1440, browserOpen: true, browserWide: true, chatOpen: true, chatForm: 'full' });
  assert.deepEqual([filled.assistantFull, filled.assistantOpen, filled.beside, filled.wide], [false, true, ASSISTANT_WIDTH, true]);
  const narrow = panesFor({ windowWidth: 980, browserOpen: true, chatOpen: true, chatForm: 'full' });
  assert.deepEqual([narrow.assistantFull, narrow.assistantOpen, narrow.wide], [false, true, true]);
});

test('paneLimits never lets the browser under its least width', () => {
  assert.deepEqual(paneLimits(1440), [PANE_MIN, 1440 - SIDEBAR - VIEW_MIN]);
  assert.deepEqual(paneLimits(700), [PANE_MIN, PANE_MIN]);
});
