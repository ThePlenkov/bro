import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { flagZone } from './args.ts';

describe('flagZone', () => {
  test('stops option validation at the -- separator', () => {
    assert.deepEqual(flagZone(['--known', '--', '--unknown', '-x']), ['--known']);
  });

  test('keeps the complete argv when no separator is present', () => {
    const argv = ['--known', 'value'];
    assert.strictEqual(flagZone(argv), argv);
  });
});
