import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { pickOption, PICK_SOURCE } = require('../desktop/page-pick.cjs');

test('the row meant is the closest one: just so, else the shortest that starts with, holds, or holds every word', () => {
  // Meta Careers lists a country as "+1 United States"; the longer row that also holds the words comes first.
  const codes = ['+93 Afghanistan', '+1 United States Minor Outlying Islands', '+971 United Arab Emirates', '+44 United Kingdom', '+1 United States'];
  assert.equal(pickOption(codes, 'United States'), 4);
  assert.equal(pickOption(codes, 'united kingdom'), 3);
  assert.equal(pickOption(codes, '+44 United Kingdom'), 3, 'a row that reads just so wins');
  assert.equal(pickOption(codes, '+971'), 2, 'the start of a row');
  // Two rows that read the same: the first.
  assert.equal(pickOption(['West Menlo Park, CA', 'Menlo Park, CA', 'Menlo Park, CA'], 'Menlo Park, CA'), 1);
  // A row that reads just so beats a shorter one that only starts with the words.
  assert.equal(pickOption(['Yes, with sponsorship', 'Yes'], 'yes'), 1);
  assert.equal(pickOption(['Yes, with sponsorship', 'No'], 'yes'), 0);
  // Every word, in any order, when nothing holds the words as they stand.
  assert.equal(pickOption(['Menlo Park, CA, United States', 'Park City, UT, United States'], 'Menlo Park United States'), 0);
  assert.equal(pickOption(['Bachelor of Science (BS)', 'Master of Science (MS)'], 'science master'), 1);
  // Spaces and case do not matter; one word alone is not "every word".
  assert.equal(pickOption(['  Data   and\nAnalytics '], 'data and analytics'), 0);
  assert.equal(pickOption(['Engineering', 'Operations'], 'Legal'), -1);
  assert.equal(pickOption(['Engineering', ''], ''), -1);
  assert.equal(pickOption([], 'anything'), -1);
});

test('the page reader carries the picker, lists what pages draw themselves, and builds without error', () => {
  const { PAGE_SOURCE } = require('../desktop/browser-page.cjs');
  assert.ok(PAGE_SOURCE.includes(PICK_SOURCE), 'the picker is in the page script');
  assert.doesNotThrow(() => new Function(`return ${PAGE_SOURCE}`));
  for (const role of ['combobox', 'option', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'switch', 'slider']) assert.ok(PAGE_SOURCE.includes(`[role="${role}"]`), role);
  // What the mouse needs from a page: where a ref, some words or a point lead, what a click brought, the rows of
  // an open list, and the pointer people watch.
  for (const method of ['target({ ref })', 'seek({ text })', 'at({ x, y })', 'mark()', 'changes({ ref', 'options({ ref', 'pointer({ x, y']) assert.ok(PAGE_SOURCE.includes(method), method);
  // The words beside a checkbox or radio button are its name, not a second thing listed; and a spot the page was
  // scrolled to says so, so that what the scroll set off is not taken for what the click brought.
  assert.match(PAGE_SOURCE, /Boolean\(name\(element\)\) && !namesControl\(element\)/);
  assert.match(PAGE_SOURCE, /info\.moved = true/);
  const browserSource = readFileSync(new URL('../desktop/browser.cjs', import.meta.url), 'utf8');
  assert.match(browserSource, /target\.moved \? SCROLL_REST : 0/);
  // The pointer takes no clicks and is not kept in the page.
  assert.match(PAGE_SOURCE, /pointer-events:none/);
  assert.match(PAGE_SOURCE, /host\.remove\(\)/);
});
