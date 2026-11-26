import assert from 'node:assert';
import test from 'node:test';
import { call } from './exec.ts';

test('call — returns without waiting for a wedged herdr binary', () => {
  const previous = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = process.execPath;
  const started = performance.now();
  try {
    call(['-e', 'setTimeout(() => {}, 5000)']);
  } finally {
    if (previous === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = previous;
  }
  assert.ok(performance.now() - started < 500, 'call waited for the child process');
});

test('call — swallows an unavailable herdr binary', () => {
  const previous = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = '/path/to/missing-herdr';
  try {
    assert.doesNotThrow(() => call([]));
  } finally {
    if (previous === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = previous;
  }
});
