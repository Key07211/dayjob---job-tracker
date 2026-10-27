import test from 'node:test';
import assert from 'node:assert/strict';
import { TUNES, tuneFor } from '../src/dayjob/groove/sound.js';

const notes = phrase => phrase.flat();

test('every tune gives each of the eight sidebar keys its own short phrase', () => {
  for (const [name, tune] of Object.entries(TUNES)) {
    assert.equal(tune.keys.length, 8, name);
    tune.keys.forEach((phrase, i) => assert.ok(phrase.length >= 2 && phrase.length <= 3, `${name} key ${i} is a short phrase`));
    assert.equal(new Set(tune.keys.map(phrase => JSON.stringify(phrase))).size, 8, `${name}: no two keys sound the same`);
  }
});

// The keys once climbed to F5 and turned shrill; they stay between B2 and D5.
test('no key goes above D5 or below B2', () => {
  for (const [name, tune] of Object.entries(TUNES)) {
    tune.keys.forEach((phrase, i) => notes(phrase).forEach(midi => assert.ok(midi >= 47 && midi <= 74, `${name} key ${i}: ${midi} is out of range`)));
  }
});

test('with the theme, days play Dew and nights the Canon; a tune no longer offered follows the theme', () => {
  assert.equal(tuneFor('auto', 'day'), 'dew');
  assert.equal(tuneFor('auto', 'night'), 'canon');
  assert.equal(tuneFor('canon', 'day'), 'canon');
  assert.equal(tuneFor('dew', 'night'), 'dew');
  assert.equal(tuneFor('prelude', 'day'), 'dew');
  assert.equal(tuneFor('gymnopedie', 'night'), 'canon');
});
