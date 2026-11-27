import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unsupportedPlatform } from './proc.ts';

test('unsupported process probes carry an explicit platform explanation', () => {
  const result = unsupportedPlatform();
  assert.equal(result.kind, 'unsupported-platform');
  assert.match(result.message, /^unsupported on /);
  assert.equal(result.platform, process.platform);
});
