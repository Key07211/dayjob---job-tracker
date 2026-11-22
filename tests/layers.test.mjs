import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_WIDTH, PAGE_EDGE, PANE_MIN, RESIZER, SIDEBAR, layersFor, paneLimits } from '../src/dayjob/layers.js';

// The browser and the assistant are layers at the right of the window; the page behind keeps its own width
// (the window less the sidebar) whatever is open, so nothing here ever takes room from it.

test('the browser opens over the right of the page and leaves the rest in sight', () => {
  const alone = layersFor({ windowWidth: 1440, browserOpen: true });
  assert.deepEqual([alone.beside, alone.room, alone.wide, alone.pageCovered], [0, 1440 - SIDEBAR, false, false]);
  assert.equal(alone.width, Math.round((1440 - SIDEBAR) * 0.58));
  // Dragged, it keeps the width it was given, between the narrowest it works at and an edge of the page left in sight.
  assert.equal(layersFor({ windowWidth: 1440, browserOpen: true, paneWidth: 500 }).width, 500);
  assert.equal(layersFor({ windowWidth: 1440, browserOpen: true, paneWidth: 100 }).width, PANE_MIN);
  assert.equal(layersFor({ windowWidth: 1440, browserOpen: true, paneWidth: 5000 }).width, 1440 - SIDEBAR - RESIZER - PAGE_EDGE);
  // Asked to cover the page, it does.
  const covering = layersFor({ windowWidth: 1440, browserOpen: true, browserWide: true });
  assert.deepEqual([covering.wide, covering.pageCovered], [true, true]);
});

test('with both open the side chat is at the edge and the browser to its left', () => {
  const both = layersFor({ windowWidth: 1440, browserOpen: true, chatOpen: true });
  assert.deepEqual([both.assistantOpen, both.assistantFull, both.beside, both.room, both.wide], [true, false, ASSISTANT_WIDTH, 1440 - SIDEBAR - ASSISTANT_WIDTH, false]);
  assert.ok(both.width + RESIZER + both.beside <= 1440 - SIDEBAR - PAGE_EDGE, 'an edge of the page stays in sight');
  // A laptop window: both still stand at the right, over the page.
  const laptop = layersFor({ windowWidth: 1280, browserOpen: true, chatOpen: true });
  assert.deepEqual([laptop.wide, laptop.width, laptop.pageCovered], [false, PANE_MIN, false]);
  // Too narrow to leave any of the page in sight: the browser covers it, up to the chat, and never gets wider than its room.
  for (const windowWidth of [1100, 960]) {
    const narrow = layersFor({ windowWidth, browserOpen: true, chatOpen: true });
    assert.deepEqual([narrow.wide, narrow.canSide, narrow.pageCovered], [true, false, true], String(windowWidth));
    assert.ok(narrow.width <= narrow.room && narrow.room > 0, String(windowWidth));
  }
  // The smallest window, browser alone: it still opens over part of the page.
  assert.equal(layersFor({ windowWidth: 960, browserOpen: true }).wide, false);
});

test('the chat as a full page covers the page, and goes to the side when the browser covers it', () => {
  const full = layersFor({ windowWidth: 1440, chatOpen: true, chatForm: 'full' });
  assert.deepEqual([full.assistantFull, full.assistantOpen, full.beside, full.pageCovered], [true, false, 0, true]);
  // Beside the browser it keeps the page's place, and the browser has the whole room to open in.
  const beside = layersFor({ windowWidth: 1440, browserOpen: true, chatOpen: true, chatForm: 'full' });
  assert.deepEqual([beside.assistantFull, beside.beside, beside.wide], [true, 0, false]);
  // The browser covering the page, or a narrow window: the chat is at the side.
  for (const options of [{ windowWidth: 1440, browserWide: true }, { windowWidth: 980 }]) {
    const docked = layersFor({ browserOpen: true, chatOpen: true, chatForm: 'full', ...options });
    assert.deepEqual([docked.assistantFull, docked.assistantOpen, docked.beside], [false, true, ASSISTANT_WIDTH]);
  }
  // Nothing open: nothing is covered and nothing is beside the page.
  const none = layersFor({ windowWidth: 1440 });
  assert.deepEqual([none.assistantOpen, none.assistantFull, none.wide, none.beside, none.pageCovered], [false, false, false, 0, false]);
});

test('the widths the browser can be dragged to', () => {
  assert.deepEqual(paneLimits(1000), [PANE_MIN, 1000 - RESIZER - PAGE_EDGE]);
  assert.deepEqual(paneLimits(430), [PANE_MIN, PANE_MIN]);
  assert.deepEqual(paneLimits(384), [384, 384]);
  assert.deepEqual(paneLimits(-20), [0, 0]);
});
