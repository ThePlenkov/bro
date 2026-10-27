import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOCK_SKEW_MS,
  clockPlane,
  clockSkewText,
  clockVerdict,
  dateHeader,
} from './watch-clock.ts';

const INCLUDE_OK = [
  'HTTP/2 200 OK',
  'Server: github.com',
  'Date: Sun, 25 Oct 2026 23:23:00 GMT',
  'Content-Type: application/json; charset=utf-8',
  '',
  '{"current_user_url":"https://api.github.com/user"}',
].join('\r\n');

const probe = (
  res: { code: number; out: string; err: string } | Error
): (() => Promise<{ code: number; out: string; err: string }>) =>
  res instanceof Error ? () => Promise.reject(res) : () => Promise.resolve(res);

describe('dateHeader', () => {
  test('the Date response header parses out of the --include block', () => {
    assert.equal(dateHeader(INCLUDE_OK), 'Sun, 25 Oct 2026 23:23:00 GMT');
  });

  test('header names match case-insensitively', () => {
    const out = 'HTTP/2 200 OK\r\ndate: Sun, 25 Oct 2026 23:23:00 GMT\r\n\r\n{}';
    assert.equal(dateHeader(out), 'Sun, 25 Oct 2026 23:23:00 GMT');
  });

  test('a body field named Date is not the header — the blank line bounds the scan', () => {
    const out = 'HTTP/2 200 OK\nContent-Type: application/json\n\n{"Date":"forged"}';
    assert.equal(dateHeader(out), undefined);
    assert.equal(dateHeader(''), undefined);
  });
});

describe('clockVerdict', () => {
  test('inside the bound the tick is verified', () => {
    assert.deepEqual(clockVerdict(1_000, 1_000 + CLOCK_SKEW_MS), {
      skewMs: CLOCK_SKEW_MS,
      skewed: false,
    });
    assert.deepEqual(clockVerdict(1_000, 1_000 - CLOCK_SKEW_MS), {
      skewMs: -CLOCK_SKEW_MS,
      skewed: false,
    });
  });

  test('past the bound either direction is skew — reported times are unverifiable', () => {
    assert.deepEqual(clockVerdict(1_000, 1_000 + CLOCK_SKEW_MS + 1).skewed, true);
    assert.deepEqual(clockVerdict(1_000, 1_000 - CLOCK_SKEW_MS - 1).skewed, true);
  });
});

describe('clockSkewText', () => {
  test('signed seconds', () => {
    assert.equal(clockSkewText(135_000), '+135s');
    assert.equal(clockSkewText(-90_000), '-90s');
    assert.equal(clockSkewText(400), '+0s');
  });
});

describe('clockPlane', () => {
  test('a non-github host has no gh clock — absent, never probed', async () => {
    let called = false;
    const res = await clockPlane('/repo', { name: 'fakehost' }, async () => {
      called = true;
      return { code: 0, out: INCLUDE_OK, err: '' };
    });
    assert.equal(res, undefined);
    assert.equal(called, false);
    assert.equal(await clockPlane('/repo', {}), undefined);
  });

  test('an aligned clock verifies — local + remote + skewMs ride the snapshot', async () => {
    const now = Date.parse('2026-10-25T23:22:45.000Z');
    const res = await clockPlane(
      '/repo',
      { name: 'github' },
      probe({ code: 0, out: INCLUDE_OK, err: '' }),
      now
    );
    assert.deepEqual(res, {
      local: '2026-10-25T23:22:45.000Z',
      remote: '2026-10-25T23:23:00.000Z',
      skewMs: 15_000,
      skewed: false,
    });
  });

  test('past the bound either direction flags the tick — remote ahead or future-dated local stamps', async () => {
    for (const [now, skewMs] of [
      ['2026-10-25T23:20:00.000Z', 180_000],
      ['2026-10-25T23:30:00.000Z', -420_000],
    ] as const) {
      const res = await clockPlane(
        '/repo',
        { name: 'github' },
        probe({ code: 0, out: INCLUDE_OK, err: '' }),
        Date.parse(now)
      );
      assert.equal(res?.skewed, true);
      assert.equal(res?.skewMs, skewMs);
    }
  });

  test('a failed gh is unverified — error, never a fabricated remote', async () => {
    const res = await clockPlane(
      '/repo',
      { name: 'github' },
      probe({ code: 1, out: '', err: 'gh: auth required' }),
      1_000
    );
    assert.equal(res?.remote, undefined);
    assert.equal(res?.skewed, false);
    assert.equal(res?.error, 'gh: auth required');
  });

  test('a spawn failure is unverified, not a throw', async () => {
    const res = await clockPlane(
      '/repo',
      { name: 'github' },
      probe(new Error('spawn gh ENOENT')),
      1_000
    );
    assert.equal(res?.error, 'spawn gh ENOENT');
  });

  test('no Date header and a malformed one are both unverified', async () => {
    const noDate = await clockPlane(
      '/repo',
      { name: 'github' },
      probe({ code: 0, out: 'HTTP/2 200 OK\nServer: x\n\n{}', err: '' }),
      1_000
    );
    assert.match(noDate?.error ?? '', /no Date header/);
    const badDate = await clockPlane(
      '/repo',
      { name: 'github' },
      probe({ code: 0, out: 'HTTP/2 200 OK\nDate: not a date\n\n{}', err: '' }),
      1_000
    );
    assert.match(badDate?.error ?? '', /unparseable Date header — not a date/);
  });
});
