import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCycleActions } from './merge-cycle.ts';

test('clean merge cycles do not file a classify-findings chore', () => {
  assert.deepEqual(mergeCycleActions('[#42](https://example.test/pull/42)', 0, 0), []);
});

test('merge cycles with threads file the classify-findings chore', () => {
  const actions = mergeCycleActions('[#42](https://example.test/pull/42)', 1, 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.sink, 'backlog');
});

test('merge cycles with fix rounds file the classify-findings chore', () => {
  const actions = mergeCycleActions('[#42](https://example.test/pull/42)', 0, 1);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.sink, 'backlog');
});
