import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { languageFor } from '../src/language.js';
import { GUIDE_VERSION, dockCard, guideSteps, placeCard, sayTime, settingsSteps, spoken, spotBox } from '../src/dayjob/guide/steps.js';

const VIEWS = ['home', 'feed', 'saved', 'applications', 'browser', 'searches', 'resume', 'settings'];
const pairs = step => [step.title, ...step.say.map(part => part.text), ...(step.can || []).map(item => item.text), ...(step.where || []).flatMap(item => [item.what, item.at]),
  ...(step.terms || []).flatMap(item => [item.name, item.means]), ...(step.lead ? [step.lead] : []), ...(step.foot ? [step.foot] : []), ...(step.note ? [step.note] : [])];
// The groups of the Settings page, top to bottom.
const GROUPS = ['daily', 'sources', 'tracking', 'notify', 'jobspy', 'keys', 'spend', 'mcp', 'assistant', 'memory', 'vault', 'browser', 'close', 'updates', 'sound', 'look'];
const DESKTOP_ONLY = ['vault', 'browser', 'close', 'updates'];

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
    for (const step of [...guideSteps({ browser }), ...settingsSteps({ browser })]) {
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
  for (const step of [...guideSteps({ browser: true }), ...settingsSteps({ browser: true })]) {
    for (const pair of pairs(step)) {
      for (const text of pair) for (const name of quoted(text)) name.split(' → ').forEach(part => named(part, step.id));
    }
    // What the Settings guide explains is called what the page calls it.
    for (const item of step.terms || []) item.name.forEach(name => named(name, step.id));
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
  // A part tied to something on the page is said only while that thing is in sight.
  const tied = { say: [{ text: ['一', 'One'] }, { text: ['二', 'Two'], when: '.thing' }] };
  assert.deepEqual(spoken(tied, 'en'), ['One', 'Two']);
  assert.deepEqual(spoken(tied, 'zh', { seen: selector => selector !== '.thing' }), ['一']);
  const last = steps.at(-1);
  assert.equal(spoken(last, 'en').length, 1);
  assert.match(spoken(last, 'en', { state: 'no-cli' })[1], /Claude Code was not found/);
  assert.match(spoken(last, 'zh', { state: 'no-key' })[1], /API key/);
  assert.equal(spoken(last, 'en')[0], last.say[0].text[1]);
});

test('saying a line takes about as long in either language, and never long', () => {
  for (const step of [...guideSteps({ browser: true }), ...settingsSteps({ browser: true })]) {
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

test('what stands at the foot of the sidebar is lit by itself: the record, the bell, the assistant', () => {
  const steps = guideSteps({ browser: true });
  const target = id => steps.find(step => step.id === id).target;
  // The sidebar's foot holds "Check for updates", the assistant, the bell and the record, each told apart by more
  // than its place: the first row there is the update, not the bell.
  assert.deepEqual(target('bell'), ['.sidebar-foot [data-fx="bell"]']);
  assert.deepEqual(target('deck'), ['.sidebar-foot .turntable']);
  const main = fs.readFileSync('src/main.jsx', 'utf8');
  assert.match(main, /data-fx="bell"/);
  assert.doesNotMatch(main, /WeekBars|week-bars/);
  // The week's bars left the sidebar, and the guide no longer speaks of them.
  assert.doesNotMatch(steps.flatMap(pairs).flat().join('\n'), /柱|\bbars?\b/i);
  // The Settings step says where the Settings guide is.
  const settings = steps.find(step => step.id === 'settings');
  assert.ok(settings.where.some(item => /讲解设置/.test(item.at[0]) && /Explain settings/.test(item.at[1])));
});

test('the Settings guide goes through the groups of the page from top to bottom', () => {
  const steps = settingsSteps({ browser: true });
  assert.deepEqual(steps.map(step => step.id), GROUPS);
  const page = ['src/dayjob/SettingsView.jsx', 'src/dayjob/Spend.jsx', 'src/dayjob/groove/SoundSettings.jsx', 'src/dayjob/assistant/AssistantSettings.jsx']
    .map(file => fs.readFileSync(file, 'utf8')).join('\n');
  for (const step of steps) {
    // Each step lights the group marked with its name on the page, says what the group is for, and explains at
    // least one of its settings.
    assert.deepEqual(step.target, [`[data-guide="${step.id}"]`]);
    assert.ok(page.includes(`data-guide="${step.id}"`), `${step.id} is marked on the page`);
    assert.ok(step.say.length >= 1 && step.terms.length >= 1 && step.terms.length <= 4, step.id);
    assert.ok(!step.where && !step.key && !step.view, step.id);
  }
  // Every marked group has its step, and every group but the first few has a question mark that starts there.
  const marked = new Set([...page.matchAll(/data-guide="([a-z]+)"/g)].map(match => match[1]));
  assert.deepEqual([...marked].sort(), [...GROUPS].sort());
  const asked = new Set([...page.matchAll(/<GuideHelp id="([a-z]+)"/g)].map(match => match[1]));
  assert.deepEqual([...asked].sort(), GROUPS.filter(id => id !== 'sources').sort());
  // The web build has no vault, browser, tray or updates.
  const web = settingsSteps({ browser: false });
  assert.deepEqual(web.map(step => step.id), GROUPS.filter(id => !DESKTOP_ONLY.includes(id)));
  assert.doesNotMatch(web.flatMap(pairs).flat().join('\n'), /浏览器|browser|托盘|tray/i);
});

test('the Settings guide\'s card stands in its own column at the right, level with the group', () => {
  const view = { width: 1440, height: 960 };
  const card = { width: 392, height: 420 };
  // Level with a group near the top, the pointer at the group's title.
  assert.deepEqual(dockCard({ spot: { left: 238, top: 14, width: 760, height: 300 }, card, view }), { left: 1036, top: 14, tail: 28 });
  // A group lower down: the card goes down with it but stays inside the window, and the pointer follows the title.
  const low = dockCard({ spot: { left: 238, top: 700, width: 760, height: 240 }, card, view });
  assert.deepEqual(low, { left: 1036, top: 960 - 12 - 420, tail: 200 });
  assert.equal(low.top + low.tail, 700 + 28);
  // A group scrolled above the window: the card stays at the top.
  assert.equal(dockCard({ spot: { left: 238, top: -200, width: 760, height: 300 }, card, view }).top, 12);
  // Nothing lit (the group is not on the page): the card keeps its column, without a pointer.
  assert.deepEqual(dockCard({ spot: null, card, view }), { left: 1036, top: 12, tail: null });
  // No pointer when the group reaches under the card's column.
  assert.equal(dockCard({ spot: { left: 238, top: 14, width: 900, height: 300 }, card, view }).tail, null);
  // The smallest window: the narrower card still has its column.
  const least = dockCard({ spot: { left: 230, top: 14, width: 345, height: 300 }, card: { width: 344, height: 500 }, view: { width: 960, height: 640 } });
  assert.deepEqual(least, { left: 604, top: 14, tail: 28 });
});

test('a first launch, and the guide with it, speaks the system\'s language', () => {
  for (const locale of ['zh-CN', 'zh', 'zh-TW', 'zh-Hant-HK', 'ZH-cn']) assert.equal(languageFor(locale), 'zh', locale);
  for (const locale of ['en-US', 'en-GB', 'ja-JP', 'fr', '', undefined, null]) assert.equal(languageFor(locale), 'en', String(locale));
  // The page takes the system's language only while none has been picked on this computer, and the choice it
  // then saves wins from there on; the greeting carries the switch for anyone it guessed wrong for.
  const i18n = fs.readFileSync('src/i18n.jsx', 'utf8');
  assert.match(i18n, /if \(saved === 'en' \|\| saved === 'zh'\) return saved;/);
  assert.match(i18n, /return systemLanguage\(\);/);
  const main = fs.readFileSync('src/main.jsx', 'utf8');
  assert.match(main, /if \(value\.languageChosen\) setLang\(value\.settings\.language, \{ adopt: true \}\);\s+else setLang\(currentLanguage\(\)\);/);
  assert.match(fs.readFileSync('src/dayjob/guide/Guide.jsx', 'utf8'), /<LanguageSwitch compact \/>/);
  // The desktop shell's tray follows the same rule until a language is saved.
  assert.match(fs.readFileSync('desktop/main.cjs', 'utf8'), /app\.getLocale\(\)\.toLowerCase\(\)\.startsWith\('zh'\) \? 'zh' : 'en'/);
});
