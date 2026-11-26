import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandError } from '@broject/core';
import { dispatchFatal } from './dispatch-error.ts';

function captureExit(run: () => void): { code: number; errors: string[] } {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  let code = -1;
  process.exit = ((value?: number) => {
    code = value ?? 0;
    throw new Error('exit intercepted');
  }) as typeof process.exit;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    assert.throws(run, /exit intercepted/);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  return { code, errors };
}

test('CommandError is presented on stderr and exits with its code', () => {
  const result = captureExit(() => dispatchFatal(new CommandError('bad config', 2)));

  assert.equal(result.code, 2);
  assert.deepEqual(result.errors, ['bad config']);
});

test('non-CommandError keeps the existing generic failure behavior', () => {
  const result = captureExit(() => dispatchFatal(new Error('unexpected')));

  assert.equal(result.code, 1);
  assert.deepEqual(result.errors, ['unexpected']);
});
