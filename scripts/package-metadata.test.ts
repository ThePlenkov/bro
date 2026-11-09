import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBroMetadata } from './package-metadata.ts';

test('metadata accepts each kind and lifecycle label', () => {
  for (const kind of ['core', 'capability', 'connector']) {
    for (const status of ['stable', 'beta', 'planned']) {
      const value = { kind, status, ...(kind === 'connector' ? { facade: 'tasks' } : {}) };
      assert.deepEqual(validateBroMetadata(value), value);
    }
  }
});

test('metadata rejects missing, empty, malformed and unknown fields', () => {
  for (const value of [
    undefined,
    null,
    [],
    {},
    '',
    { kind: 'plugin', status: 'beta' },
    { kind: 'core', status: 'done' },
    { kind: 'connector', status: 'beta' },
    { kind: 'connector', status: 'beta', facade: '' },
    { kind: 'core', status: 'beta', facade: 1 },
    { kind: 'core', status: 'beta', facade: 'bad facade' },
    { kind: 'core', status: 'beta', typo: true },
  ]) {
    assert.throws(() => validateBroMetadata(value));
  }
});
