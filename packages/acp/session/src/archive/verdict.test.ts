import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventsVerdict, paintedMode, rowVerdict } from './verdict.ts';

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
      since: '2026-01-01T12:00:00.000Z',
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
      since: '2026-01-01T12:00:00.000Z',
    }
  );
});

test('turn terminal rows use their own journal timestamp', () => {
  const ts = '2026-01-01T12:00:00.000Z';
  assert.deepEqual(rowVerdict({ kind: 'turn', phase: 'stop', ts }), {
    led: { state: 'idle' },
    mode: 'turn complete · since 01 Jan 12:00',
    since: ts,
  });
  assert.deepEqual(rowVerdict({ kind: 'turn', phase: 'stop', error: 'crash', ts }), {
    led: { state: 'blocked' },
    mode: 'turn error · since 01 Jan 12:00',
    since: ts,
  });
});

test('painting a carried stamp re-qualifies the date after midnight', () => {
  const stamp = '2026-01-01T23:45:00.000Z';
  const originalDate = globalThis.Date;
  class NextDay extends originalDate {
    constructor(value?: string | number | Date) {
      super(value ?? '2026-01-02T00:15:00.000Z');
    }
    static now(): number {
      return new originalDate('2026-01-02T00:15:00.000Z').getTime();
    }
  }
  globalThis.Date = NextDay as unknown as DateConstructor;
  try {
    assert.equal(
      paintedMode({ led: { state: 'idle' }, mode: 'turn complete · since 23:45', since: stamp }),
      'turn complete · since 01 Jan 23:45'
    );
  } finally {
    globalThis.Date = originalDate;
  }
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
