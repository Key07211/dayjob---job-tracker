import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hostOf, tell } from '../src/dayjob/tip.js';

// A stand-in for an element: what tip.js asks of one.
function element({ classes = [], text = '', within = null, before = null, parent = null } = {}) {
  const attributes = {};
  return { classList: { contains: name => classes.includes(name) }, textContent: text, closest: () => within, previousElementSibling: before, parentElement: parent,
    get title() { return attributes.title ?? ''; }, set title(value) { attributes.title = value; }, removeAttribute: name => { delete attributes[name]; }, attributes };
}

test('a tip is the tooltip of the row it is in, or of what stands before it, or of what holds it', () => {
  const row = element();
  assert.equal(hostOf(element({ within: row, before: element(), parent: element() })), row, 'the label or row it is written in comes first');
  const heading = element();
  const first = element({ classes: ['tip'], before: heading });
  assert.equal(hostOf(first), heading);
  assert.equal(hostOf(element({ classes: ['tip'], before: first })), heading, 'a second sentence looks past the first one');
  const holder = element();
  assert.equal(hostOf(element({ parent: holder })), holder);
});

test('sentences about one thing make one tooltip, and leave it when they leave the page', () => {
  const heading = element();
  const one = element({ classes: ['tip'], text: '  Kept on this computer. ', before: heading });
  const two = element({ classes: ['tip'], text: 'Never sent to a model.', before: one });
  const forgetOne = tell(one);
  assert.equal(heading.title, 'Kept on this computer.');
  const forgetTwo = tell(two);
  assert.equal(heading.title, 'Kept on this computer.\n\nNever sent to a model.');
  one.textContent = '只保存在这台电脑上。';
  tell(one);
  assert.equal(heading.title, '只保存在这台电脑上。\n\nNever sent to a model.', 'the words follow the language');
  forgetOne();
  assert.equal(heading.title, 'Never sent to a model.');
  forgetTwo();
  assert.equal('title' in heading.attributes, false, 'no empty tooltip is left behind');
  assert.doesNotThrow(tell(element({ text: 'x' })), 'a sentence with nowhere to go is let be');
});

test('the settings pages keep their explanations in tooltips', () => {
  const read = file => fs.readFileSync(new URL(`../src/dayjob/${file}`, import.meta.url), 'utf8');
  for (const [file, least] of [['SettingsView.jsx', 15], ['ResumeView.jsx', 10], ['assistant/AssistantSettings.jsx', 5], ['groove/SoundSettings.jsx', 4]]) {
    const tips = read(file).split('<Tip>').length - 1;
    assert.ok(tips >= least, `${file} has ${tips} tips`);
  }
  // The file's own path is not printed on the page: "Open folder" leads there.
  assert.doesNotMatch(read('assistant/Runs.jsx'), /feedback\.file\b/);
  // Hidden however the page styles a span.
  assert.match(read('dayjob.css'), /\.tip \{ display: none !important; \}/);
});
