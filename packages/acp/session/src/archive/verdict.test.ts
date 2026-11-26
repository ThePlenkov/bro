import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventsVerdict, rowVerdict } from './verdict.ts';

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

test('turn terminal rows use their own journal timestamp', () => {
  const ts = '2026-01-01T12:00:00.000Z';
  assert.deepEqual(rowVerdict({ kind: 'turn', phase: 'stop', ts }), {
    led: { state: 'idle' },
    mode: 'turn complete · since 01 Jan 12:00',
  });
  assert.deepEqual(rowVerdict({ kind: 'turn', phase: 'stop', error: 'crash', ts }), {
    led: { state: 'blocked' },
    mode: 'turn error · since 01 Jan 12:00',
  });
});

test('an archive with no row preserves an unknown worker verdict', () => {
  assert.deepEqual(eventsVerdict({ state: 'unknown' }, undefined), {
    led: { state: 'unknown' },
    mode: 'session events',
  });
});

test('an archive with no row preserves a proven worker verdict', () => {
  assert.deepEqual(eventsVerdict({ state: 'working' }, undefined), {
    led: { state: 'working' },
    mode: 'session events',
  });
  assert.deepEqual(eventsVerdict({ state: 'idle' }, undefined), {
    led: { state: 'idle' },
    mode: 'session events',
  });
});
