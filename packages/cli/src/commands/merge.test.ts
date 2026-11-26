import assert from 'node:assert/strict';
import test from 'node:test';
import { hasOpenClassifyBeadForPr, mergeCycleActions } from './merge-cycle.ts';

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

test('an open classify bead for the PR makes re-entry a no-op', () => {
  const existing = {
    id: 'bro-existing',
    title:
      'classify merge-cycle findings for [#1405](https://example.test/pull/1405) into prevention actions',
    status: 'open',
  };
  assert.equal(hasOpenClassifyBeadForPr([existing], 1405), true);
  assert.deepEqual(
    mergeCycleActions(existing.title, 1, 1, hasOpenClassifyBeadForPr([existing], 1405)),
    []
  );
});

test('a closed classify bead does not suppress a new action', () => {
  const existing = {
    id: 'bro-closed',
    title:
      'classify merge-cycle findings for [#1405](https://example.test/pull/1405) into prevention actions',
    status: 'closed',
  };
  assert.equal(hasOpenClassifyBeadForPr([existing], 1405), false);
});
