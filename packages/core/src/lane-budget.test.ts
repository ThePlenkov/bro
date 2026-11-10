import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  laneBudgetAdmit,
  laneBudgetCheck,
  laneBudgetKey,
  laneBudgetLevel,
  laneBudgetPause,
  laneBudgetResume,
} from './lane-budget.ts';
import { scrubEnv } from './testkit.ts';

after(scrubEnv());

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-lanebudget-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const MIN = 60_000;
const cfg = { minutes: 30, windowMinutes: 60 };

describe('the lane work budget (bro-tdndq)', () => {
  test('an admission opens a segment that accrues running time', () => {
    withDir(dir => {
      const r = laneBudgetAdmit('devin', laneBudgetKey('repo', 'a-1'), cfg, {
        now: 0,
        dir,
      });
      assert.ok(r.ok);
      // 20 minutes later the open segment reports 20 worker-minutes
      const level = laneBudgetCheck('devin', cfg, { now: 20 * MIN, dir });
      assert.equal(level.spentMin, 20);
      assert.equal(level.spent, false);
    });
  });

  test('a spent budget refuses with a retry wait', () => {
    withDir(dir => {
      // three workers admitted 40 minutes ago, still running: 120
      // worker-minutes open — the 30-minute budget is long spent
      for (const id of ['a-1', 'a-2', 'a-3']) {
        assert.ok(
          laneBudgetAdmit('devin', laneBudgetKey('repo', id), cfg, { now: 0, dir }).ok
        );
      }
      const r = laneBudgetAdmit('devin', laneBudgetKey('repo', 'a-4'), cfg, {
        now: 40 * MIN,
        dir,
      });
      assert.equal(r.ok, false);
      if (!r.ok) {
        // 120 spent — the window sheds 30+budget only after segments
        // slide: the earliest decay breakpoint is a-1's capped end (60m
        // cap) + window edge; the wait is positive and bounded
        assert.ok(r.retryAfterSec > 0);
        assert.ok(r.retryAfterSec <= 80 * 60);
      }
    });
  });

  test('the rolling window resets the budget — old segments slide out', () => {
    withDir(dir => {
      assert.ok(laneBudgetAdmit('devin', laneBudgetKey('repo', 'a-1'), cfg, { now: 0, dir }).ok);
      // an open segment's contribution caps at one window (60m): at
      // t=70m the zombie reports 50 worker-minutes — still spent
      const level = laneBudgetCheck('devin', cfg, { now: 70 * MIN, dir });
      assert.equal(level.spentMin, 50);
      assert.equal(level.spent, true);
      const r = laneBudgetAdmit('devin', laneBudgetKey('repo', 'a-2'), cfg, {
        now: 70 * MIN,
        dir,
      });
      assert.equal(r.ok, false);
      // at t=120m the capped end (60m) slides out of the trailing
      // window — the budget is whole again and the lane re-admits
      const r2 = laneBudgetAdmit('devin', laneBudgetKey('repo', 'a-3'), cfg, {
        now: 120 * MIN + 1,
        dir,
      });
      assert.equal(r2.ok, true);
    });
  });

  test('dead workers stop spending — liveKeys closes their segments', () => {
    withDir(dir => {
      laneBudgetAdmit('devin', laneBudgetKey('repo', 'a-1'), cfg, {
        now: 0,
        dir,
        scope: 'repo',
      });
      // a-1 is gone from the registry — the next check closes its
      // segment at `now` instead of letting it bleed a whole window
      const level = laneBudgetCheck('devin', cfg, {
        now: 10 * MIN,
        dir,
        scope: 'repo',
        liveKeys: new Set(),
      });
      assert.equal(level.spentMin, 10);
      // and the closed segment no longer accrues
      const later = laneBudgetCheck('devin', cfg, { now: 20 * MIN, dir });
      assert.equal(later.spentMin, 10);
    });
  });

  test('a foreign scope never prunes another repo’s live workers', () => {
    withDir(dir => {
      laneBudgetAdmit('devin', laneBudgetKey('other', 'x-1'), cfg, {
        now: 0,
        dir,
        scope: 'other',
      });
      // my registry knows nothing of 'other' — its open segment must
      // survive the prune and keep accruing
      const level = laneBudgetCheck('devin', cfg, {
        now: 10 * MIN,
        dir,
        scope: 'repo',
        liveKeys: new Set(),
      });
      assert.equal(level.spentMin, 10);
      const later = laneBudgetCheck('devin', cfg, { now: 25 * MIN, dir });
      assert.equal(later.spentMin, 25);
    });
  });

  test('a frozen worker stops accruing; a thawed one resumes', () => {
    withDir(dir => {
      const key = laneBudgetKey('repo', 'a-1');
      laneBudgetAdmit('devin', key, cfg, { now: 0, dir });
      laneBudgetPause('devin', key, { now: 5 * MIN, dir });
      // frozen at 5m — the level at 30m still reads 5 worker-minutes
      assert.equal(laneBudgetCheck('devin', cfg, { now: 30 * MIN, dir }).spentMin, 5);
      laneBudgetResume('devin', key, { now: 30 * MIN, dir });
      // 10 more minutes running → 15 total
      assert.equal(laneBudgetCheck('devin', cfg, { now: 40 * MIN, dir }).spentMin, 15);
    });
  });

  test('level is null before anything was ever metered', () => {
    withDir(dir => {
      assert.equal(laneBudgetLevel('devin', cfg, { dir }), null);
      laneBudgetAdmit('devin', laneBudgetKey('repo', 'a-1'), cfg, { now: 0, dir });
      assert.ok(laneBudgetLevel('devin', cfg, { now: MIN, dir }) !== null);
    });
  });
});
