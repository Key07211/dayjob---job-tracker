import test from 'node:test';
import assert from 'node:assert/strict';
import { inOrder } from '../src/dayjob/in-order.js';

// A service that keeps what arrives last. The first request is slow on the way (a busy start), the second is not.
function slowFirst() {
  const state = { language: null, arrived: [], atOnce: 0, most: 0 };
  let calls = 0;
  const save = async language => {
    calls += 1;
    state.atOnce += 1;
    state.most = Math.max(state.most, state.atOnce);
    await new Promise(resolve => setTimeout(resolve, calls === 1 ? 40 : 1));
    state.language = language;
    state.arrived.push(language);
    state.atOnce -= 1;
  };
  return { state, save };
}

test('two saves sent at once can arrive the wrong way round; in a line the last choice stays', async () => {
  // Sent side by side, as the language switch used to: the first click's save arrives last and stays.
  const loose = slowFirst();
  await Promise.all([loose.save('zh'), loose.save('en')]);
  assert.deepEqual(loose.state.arrived, ['en', 'zh']);
  assert.equal(loose.state.language, 'zh');

  const lined = slowFirst();
  const save = inOrder(lined.save);
  save('zh');
  await save('en');
  assert.deepEqual(lined.state.arrived, ['zh', 'en']);
  assert.equal(lined.state.language, 'en');
  assert.equal(lined.state.most, 1);
});

test('a save that fails does not hold up the next one', async () => {
  const done = [];
  const save = inOrder(async value => { if (value === 'bad') throw new Error('refused'); done.push(value); });
  save('a');
  save('bad');
  await save('b');
  assert.deepEqual(done, ['a', 'b']);
});
