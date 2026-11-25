import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowVerdict } from './verdict.ts';

test('an auto-approved permission row is idle, not blocked', () => {
  assert.deepEqual(
    rowVerdict({
      kind: 'permission',
      title: 'Read package.json',
      verdict: 'approved',
      ts: '2026-01-01T12:00:00.000Z',
    }),
    {
      led: { state: 'idle' },
      mode: 'permission — approved · since 01 Jan 12:00',
    }
  );
});

test('a denied permission row remains blocked', () => {
  assert.deepEqual(
    rowVerdict({
      kind: 'permission',
      title: 'Write package.json',
      verdict: 'denied',
      ts: '2026-01-01T12:00:00.000Z',
    }),
    {
      led: { state: 'blocked' },
      mode: 'permission — denied · since 01 Jan 12:00',
    }
  );
});
