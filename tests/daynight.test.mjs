import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_HOURS, nextTurn, nightAt, parseHours } from '../src/dayjob/daynight.js';

const at = (h, m = 0) => new Date(2026, 9, 25, h, m);

test('by the clock it is night from the night time until the day time', () => {
  assert.equal(nightAt(at(6, 59), DEFAULT_HOURS), true);
  assert.equal(nightAt(at(7, 0), DEFAULT_HOURS), false);
  assert.equal(nightAt(at(18, 59), DEFAULT_HOURS), false);
  assert.equal(nightAt(at(19, 0), DEFAULT_HOURS), true);
  assert.equal(nightAt(at(0, 30), DEFAULT_HOURS), true);
  // Night that starts after midnight and ends before the day starts.
  assert.equal(nightAt(at(1, 0), { day: '09:00', night: '00:30' }), true);
  assert.equal(nightAt(at(0, 10), { day: '09:00', night: '00:30' }), false);
  // The same two times mean it is always day.
  assert.equal(nightAt(at(23, 0), { day: '08:00', night: '08:00' }), false);
});

test('bad saved times fall back to 07:00 and 19:00', () => {
  assert.deepEqual(parseHours({ day: '7:00', night: '25:00' }), DEFAULT_HOURS);
  assert.deepEqual(parseHours(null), DEFAULT_HOURS);
  assert.deepEqual(parseHours({ day: '06:30' }), { day: '06:30', night: '19:00' });
});

test('the next turn is counted in minutes', () => {
  assert.equal(nextTurn(at(18, 0), DEFAULT_HOURS), 60);
  assert.equal(nextTurn(at(19, 0), DEFAULT_HOURS), 720);
  assert.equal(nextTurn(at(6, 30), DEFAULT_HOURS), 30);
});

// public/theme-init.js runs before the page paints and repeats the rule; it must agree with daynight.js.
test('the theme set before paint matches the running page', () => {
  const script = fs.readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  const run = (choice, hours, when, systemDark = false, store = { 'dayjob-theme-clock': '1' }) => {
    Object.assign(store, { 'dayjob-theme': choice, 'dayjob-theme-hours': hours ? JSON.stringify(hours) : null });
    const root = { dataset: {}, style: {} };
    const RealDate = Date;
    const FakeDate = class extends RealDate { constructor(...args) { super(...(args.length ? args : [when.getTime()])); } };
    vm.runInNewContext(script, {
      Date: FakeDate, JSON, Number, String,
      localStorage: { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = String(value); } },
      window: { matchMedia: () => ({ matches: systemDark }) },
      document: { documentElement: root },
    });
    return root.dataset.theme;
  };
  for (const hours of [null, { day: '06:30', night: '18:15' }, { day: '09:00', night: '00:30' }]) {
    for (const [h, m] of [[0, 10], [0, 45], [6, 29], [6, 31], [7, 0], [12, 0], [18, 14], [18, 16], [19, 0], [23, 59]]) {
      const expected = nightAt(at(h, m), hours || DEFAULT_HOURS) ? 'night' : 'day';
      assert.equal(run(null, hours, at(h, m)), expected, `default choice at ${h}:${m} with ${JSON.stringify(hours)}`);
      assert.equal(run('time', hours, at(h, m)), expected);
    }
  }
  assert.equal(run('dark', null, at(12)), 'night');
  assert.equal(run('light', null, at(23)), 'day');
  assert.equal(run('system', null, at(12), true), 'night');
  assert.equal(run('system', null, at(23), false), 'day');
  // A turn of the header's day/night switch holds until the clock's next turn, and only by the clock.
  const held = (night, until) => ({ 'dayjob-theme-clock': '1', 'dayjob-theme-hold': JSON.stringify({ night, until: until.getTime() }) });
  assert.equal(run('time', null, at(21), false, held(false, at(31))), 'day');
  assert.equal(run(null, null, at(12), false, held(true, at(19))), 'night');
  assert.equal(run('time', null, at(7, 1), false, held(false, at(7))), 'day');
  assert.equal(run('time', null, at(19, 1), false, held(false, at(19))), 'night');
  assert.equal(run('light', null, at(12), false, held(true, at(19))), 'day');
  assert.equal(run('dark', null, at(12), false, held(false, at(19))), 'night');
});

test('the first start of 0.11.0 moves an earlier choice over to the clock, once', () => {
  const script = fs.readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  const store = { 'dayjob-theme': 'dark' };
  const root = { dataset: {}, style: {} };
  const context = { JSON, Number, String, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [at(12).getTime()])); } },
    localStorage: { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = String(value); } },
    window: { matchMedia: () => ({ matches: false }) }, document: { documentElement: root } };
  vm.runInNewContext(script, context);
  assert.equal(root.dataset.theme, 'day');
  assert.equal(store['dayjob-theme'], 'time');
  // A choice made after that stays.
  store['dayjob-theme'] = 'dark';
  vm.runInNewContext(script, context);
  assert.equal(root.dataset.theme, 'night');
});
