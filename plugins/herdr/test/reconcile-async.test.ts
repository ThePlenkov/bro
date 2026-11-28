import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_OUTPUT } from '../src/lib.ts';
import { quickRunAsync } from '../src/reconcile.ts';

test('quickRunAsync bounds both streams when either stream exceeds the limit', async () => {
  const script = `process.stdout.write('x'.repeat(${MAX_OUTPUT + 1})); process.stderr.write('y'.repeat(${MAX_OUTPUT + 1}))`;
  const result = await quickRunAsync(process.execPath, ['-e', script]);
  assert.equal(result.code, -1);
  assert.ok(result.out.length <= MAX_OUTPUT);
  assert.ok(result.err.length <= MAX_OUTPUT);
});
