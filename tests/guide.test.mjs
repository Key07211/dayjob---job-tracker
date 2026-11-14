import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GUIDE_VERSION, guideSteps, placeCard, sayTime, spoken, spotBox } from '../src/dayjob/guide/steps.js';

const VIEWS = ['home', 'feed', 'saved', 'applications', 'browser', 'searches', 'resume', 'settings'];
const pairs = step => [step.title, ...step.say.map(part => part.text), ...(step.can || []).map(item => item.text), ...(step.where || []).flatMap(item => [item.what, item.at]),
  ...(step.lead ? [step.lead] : []), ...(step.foot ? [step.foot] : [])];

// Everything the app itself shows, outside the guide: the words the guide may point at.
function appText() {
  const files = [];
  const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).forEach(item => {
    const full = path.join(folder, item.name);
    if (item.isDirectory()) { if (item.name !== 'guide' && item.name !== 'fonts') walk(full); }
    else if (/\.(jsx?|mjs)$/.test(item.name)) files.push(full);
  });
  walk('src');
  return files.map(file => fs.readFileSync(file, 'utf8')).join('\n').replaceAll('\\\'', '\'');
}

test('the guide greets, then goes through every page in the sidebar\'s order and ends at the assistant', () => {
  const steps = guideSteps({ browser: true });
  assert.equal(GUIDE_VERSION, 1);
  assert.equal(steps[0].id, 'intro');
  assert.equal(steps.at(-1).id, 'assistant');
  assert.equal(new Set(steps.map(step => step.id)).size, steps.length);
  // The greeting says what the assistant can do, and has nothing lit.
  assert.ok(steps[0].can.length >= 5 && steps[0].lead && steps[0].foot && !steps[0].target);
  // Every page has its step, in the order of the keys, and a note goes to its key.
  assert.deepEqual(steps.filter(step => step.key).map(step => step.key), VIEWS);
  for (const step of steps.slice(1)) {
    assert.ok(step.target?.length, `${step.id} lights something`);
    if (step.view) assert.equal(step.view, step.key);
    if (step.key) assert.deepEqual(step.target, [`.pkey[data-view="${step.key}"]`]);
    // What it is for, and where to change it.
    assert.ok(step.say.length >= 1 && step.where?.length >= 1, `${step.id} says what it is and where its settings are`);
  }
  // The browser has a key but is not opened by the guide: its page is a native view that would cover the card.
  assert.equal(steps.find(step => step.id === 'browser').view, undefined);
});

test('every line of the guide is written in both languages', () => {
  for (const browser of [true, false]) {
    for (const step of guideSteps({ browser })) {
      for (const pair of pairs(step)) {
        assert.equal(pair.length, 2, step.id);
        assert.ok(pair[0].trim() && pair[1].trim(), step.id);
        assert.match(pair[0], /[一-鿿]/, `${step.id}: ${pair[0]}`);
        // The English names the language switch by what is written on it.
        assert.doesNotMatch(pair[1].replaceAll('中文', ''), /[一-鿿]/, `${step.id}: ${pair[1]}`);
      }
    }
  }
});

test('without its own browser, Dayjob\'s guide says nothing about the browser', () => {
  const steps = guideSteps({ browser: false });
  assert.ok(!steps.some(step => step.id === 'browser'));
  assert.deepEqual(steps.filter(step => step.key).map(step => step.key), VIEWS.filter(view => view !== 'browser'));
  const all = steps.flatMap(pairs).flat().join('\n');
  assert.doesNotMatch(all, /浏览器|browser|托盘|tray/i);
  assert.ok(!steps[0].can.some(item => item.icon === 'apply'));
});

test('the guide only names pages, cards and buttons that the app really has', () => {
  const app = appText();
  const has = name => app.includes(name);
  // A name is there as written, or each of its parts is ("API key、API 消费").
  const named = (name, where) => assert.ok(has(name) || name.split(/、|, | \/ /).every(part => part.trim() && has(part.trim())), `${where}: “${name}” is not in the app`);
  const quoted = text => [...text.matchAll(/“([^”]+)”/g)].map(match => match[1]);
  for (const step of guideSteps({ browser: true })) {
    for (const pair of pairs(step)) {
      for (const text of pair) for (const name of quoted(text)) name.split(' → ').forEach(part => named(part, step.id));
    }
    for (const item of step.where || []) {
      if (!item.in) continue;
      for (const text of item.at) {
        // Either the place is in quotes (checked above), or it is a path: page → card → field.
        if (quoted(text).length) continue;
        const parts = text.split(' → ');
        assert.ok(parts.length >= 2, `${step.id}: “${text}” is a path`);
        parts.forEach(part => named(part, step.id));
      }
    }
  }
});

test('a step says only what fits the window and the assistant\'s state', () => {
  const steps = guideSteps({ browser: true });
  const deck = steps.find(step => step.id === 'deck');
  assert.equal(spoken(deck, 'zh').length, 2);
  // In a short window the week's bars are not shown, so they are not talked about.
  assert.equal(spoken(deck, 'zh', { seen: selector => !selector.includes('week-bars') }).length, 1);
  const last = steps.at(-1);
  assert.equal(spoken(last, 'en').length, 1);
  assert.match(spoken(last, 'en', { state: 'no-cli' })[1], /Claude Code was not found/);
  assert.match(spoken(last, 'zh', { state: 'no-key' })[1], /API key/);
  assert.equal(spoken(last, 'en')[0], last.say[0].text[1]);
});

test('saying a line takes about as long in either language, and never long', () => {
  for (const step of guideSteps({ browser: true })) {
    for (const part of step.say) {
      const [zh, en] = [sayTime(part.text[0], 'zh'), sayTime(part.text[1], 'en')];
      assert.ok(zh >= 500 && zh <= 3200 && en >= 500 && en <= 3200, step.id);
      assert.ok(Math.max(zh, en) / Math.min(zh, en) < 1.8, `${step.id}: ${zh} ms and ${en} ms`);
    }
  }
  assert.equal(sayTime('好', 'zh'), 500);
  assert.equal(sayTime('x'.repeat(2000), 'en'), 3200);
});

test('the lit box joins what is in sight, with a margin, inside the window', () => {
  const view = { width: 1000, height: 700 };
  assert.equal(spotBox([], view), null);
  assert.equal(spotBox([null, { left: 0, top: 0, right: 0, bottom: 0 }], view), null);
  assert.deepEqual(spotBox([{ left: 20, top: 100, right: 200, bottom: 140 }], view), { left: 14, top: 94, width: 192, height: 52 });
  // Two parts become one box; a hidden one is left out; the window's edge is the limit.
  assert.deepEqual(spotBox([{ left: 2, top: 500, right: 210, bottom: 560 }, null, { left: 12, top: 570, right: 204, bottom: 698 }, { left: 0, top: 0, right: 0, bottom: 0 }], view),
    { left: 0, top: 494, width: 216, height: 206 });
});

test('the card stands in the middle for the greeting and beside what is lit after that', () => {
  const view = { width: 1440, height: 900 };
  const card = { width: 392, height: 360 };
  assert.deepEqual(placeCard({ spot: null, card: { width: 540, height: 500 }, view }), { left: 450, top: 200, tail: null });
  // Beside a key near the top: to its right, the pointer level with the key's middle.
  const key = { left: 0, top: 90, width: 216, height: 52 };
  const beside = placeCard({ spot: key, card, view });
  assert.deepEqual(beside, { left: 234, top: 60, tail: 56 });
  assert.equal(beside.top + beside.tail, key.top + key.height / 2);
  // Beside something at the bottom of the sidebar: the card stays inside the window, the pointer follows the thing.
  const record = { left: 6, top: 720, width: 204, height: 170 };
  const low = placeCard({ spot: record, card, view });
  assert.equal(low.top, 900 - 12 - 360);
  assert.equal(low.top + low.tail, Math.min(low.top + 360 - 24, 805));
  // A window too small for the card to stand beside: it stays inside, without a pointer.
  const small = placeCard({ spot: { left: 0, top: 100, width: 216, height: 52 }, card, view: { width: 500, height: 300 } });
  assert.deepEqual(small, { left: 96, top: 12, tail: null });
  // The smallest window Dayjob allows still has room beside the sidebar.
  const least = placeCard({ spot: key, card, view: { width: 960, height: 640 } });
  assert.ok(least.left >= 216 && least.left + card.width <= 960 && least.tail !== null);
});
