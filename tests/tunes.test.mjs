import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY_NOTES, TUNES, tuneFor } from '../src/dayjob/groove/sound.js';

const C_MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);

test('each sidebar key has its own note, C at the top up to the C above at the bottom', () => {
  assert.deepEqual(KEY_NOTES, [60, 62, 64, 65, 67, 69, 71, 72]);
});

test('in every piece each key\'s fragment ends on that key\'s note and stays in C major', () => {
  for (const [name, tune] of Object.entries(TUNES)) {
    assert.equal(tune.keys.length, KEY_NOTES.length, name);
    tune.keys.forEach((notes, i) => {
      assert.ok(notes.length >= 2 && notes.length <= 3, `${name} key ${i} is a short fragment`);
      assert.equal(notes.at(-1), KEY_NOTES[i], `${name} key ${i} lands on its note`);
      notes.forEach(midi => assert.ok(C_MAJOR.has(midi % 12), `${name} key ${i}: ${midi} is in C major`));
    });
    if (tune.bass) {
      assert.equal(tune.bass.length, KEY_NOTES.length, `${name} bass`);
      tune.bass.forEach((midi, i) => assert.ok(C_MAJOR.has(midi % 12) && midi < 60, `${name} bass ${i} is a low note in C major`));
    }
  }
});

test('with the theme, days play the prelude and nights the Gymnopédie; a piece no longer offered follows the theme', () => {
  assert.equal(tuneFor('auto', 'day'), 'prelude');
  assert.equal(tuneFor('auto', 'night'), 'gymnopedie');
  assert.equal(tuneFor('traumerei', 'night'), 'traumerei');
  assert.equal(tuneFor('moon', 'night'), 'gymnopedie');
  assert.equal(tuneFor('elise', 'day'), 'prelude');
});
