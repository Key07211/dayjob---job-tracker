import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TITLE_BAR, hexColor, shadeOf, shaded } from '../src/dayjob/titlebar.js';
import { dockCard, placeCard } from '../src/dayjob/guide/steps.js';

// 窗口边框: the window's three buttons are drawn in colours the page names (src/dayjob/titlebar.js).

test('outside the desktop window there is no title strip', () => {
  assert.equal(TITLE_BAR, 0);
});

test('a colour for the window buttons is six hex digits, or none', () => {
  assert.equal(hexColor(' #dcebf7 '), '#DCEBF7');
  assert.equal(hexColor('#1C1916'), '#1C1916');
  assert.equal(hexColor('#abc'), '#AABBCC');
  for (const not of ['', 'red', '#12345', '#1234567', 'rgb(1 2 3)', '#GGGGGG', null, undefined]) assert.equal(hexColor(not), null);
});

test('the buttons under the guide\'s shade take the shaded colour', () => {
  assert.deepEqual(shadeOf('rgb(30 43 56 / 46%)'), { rgb: [30, 43, 56], alpha: 0.46 });
  assert.deepEqual(shadeOf(' rgba(0, 0, 0, 0.6) '), { rgb: [0, 0, 0], alpha: 0.6 });
  for (const not of ['', 'none', 'rgb(30 43 56)', 'rgb(300 0 0 / 50%)', 'rgb(0 0 0 / 0%)']) assert.equal(shadeOf(not), null);
  assert.equal(shaded('#DCEBF7', null), '#DCEBF7');
  // Black at 60% over the night strip.
  assert.equal(shaded('#1C1916', shadeOf('rgb(0 0 0 / 60%)')), '#0B0A09');
  // The day shade over the day strip: each part moves 46% of the way to the shade.
  assert.equal(shaded('#DCEBF7', shadeOf('rgb(30 43 56 / 46%)')), '#85939F');
  assert.equal(shaded('#FFFFFF', shadeOf('rgb(0 0 0 / 100%)')), '#000000');
});

test('the guide\'s card stands clear of the title strip', () => {
  const view = { width: 1440, height: 900 };
  const card = { width: 392, height: 300 };
  // Beside something at the very top of the window the card would stand at the window's margin; with a strip it
  // stands under the strip, and its pointer still finds the thing.
  const top = { left: 0, top: 20, width: 216, height: 32 };
  assert.equal(placeCard({ spot: top, card, view }).top, 12);
  const under = placeCard({ spot: top, card, view, head: 36 });
  assert.equal(under.top, 36);
  assert.equal(under.tail, 24);
  // Lower down the strip changes nothing.
  const low = { left: 0, top: 400, width: 216, height: 52 };
  assert.deepEqual(placeCard({ spot: low, card, view, head: 36 }), placeCard({ spot: low, card, view }));
  // The Settings guide's card: under the strip with nothing lit, and when the lit group is at the top.
  assert.equal(dockCard({ spot: null, card, view }).top, 12);
  assert.equal(dockCard({ spot: null, card, view, head: 36 }).top, 36);
  assert.equal(dockCard({ spot: { left: 238, top: 14, width: 760, height: 300 }, card, view, head: 36 }).top, 36);
  assert.equal(dockCard({ spot: { left: 238, top: 200, width: 760, height: 300 }, card, view, head: 36 }).top, 200);
});

test('the window and its page agree on the strip, and only colours reach the window', () => {
  const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  const preload = fs.readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  const height = /const TITLE_BAR = (\d+);/.exec(main)?.[1];
  assert.ok(height);
  assert.match(preload, new RegExp(`titleBar: process\\.platform === 'darwin' \\? 0 : ${height},`));
  assert.match(main, /titleBarStyle: 'hidden', titleBarOverlay: \{ \.\.\.FRAME_DAY, height: TITLE_BAR \}/);
  // What the page sends is checked before the window takes it.
  assert.match(main, /if \(!HEX_COLOR\.test\(color\) \|\| !HEX_COLOR\.test\(symbolColor\)/);
  // The strip is in the page from the first moment, before the app draws anything.
  assert.match(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /<body><div id="titlebar"><\/div><div id="root"><\/div>/);
});
