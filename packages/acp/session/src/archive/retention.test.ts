import assert from 'node:assert/strict';
import test from 'node:test';
import { retentionVerdict } from './retention.ts';

const clean = { gitClean: true, unpushed: false, prOpen: false, sessionActive: false };

test('allows only a clean, pushed, merged, inactive session', () => {
  assert.deepEqual(retentionVerdict(clean), {
    archivable: true,
    blockedBy: [],
    led: { state: 'idle' },
  });
});

test('reports every blocking leg', () => {
  assert.deepEqual(
    retentionVerdict({ gitClean: false, unpushed: true, prOpen: true, sessionActive: true })
      .blockedBy,
    ['dirty', 'unpushed', 'pr', 'active']
  );
});

test('fails closed when a caller cannot prove a leg', () => {
  assert.equal(retentionVerdict({ ...clean, gitClean: false }).archivable, false);
});
