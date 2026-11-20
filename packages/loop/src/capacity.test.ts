import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { diskFloorBreach, diskFloorBytes, diskFloorFor, MB } from './capacity.ts';

const cfg = { worktreeMb: 400, diskMinSlots: 2 };
const probe = (path: string, mb: number, totalMb?: number) => ({
  path,
  freeBytes: mb * MB,
  ...(totalMb === undefined ? {} : { totalBytes: totalMb * MB }),
});

describe('diskFloorBytes', () => {
  test('the floor is N slots priced at worktreeMb', () => {
    assert.equal(diskFloorBytes(cfg), 800 * MB);
    assert.equal(diskFloorBytes({ worktreeMb: 350, diskMinSlots: 1 }), 350 * MB);
  });

  test('an absurd product saturates at MAX_SAFE_INTEGER — no garbage math', () => {
    assert.equal(diskFloorBytes({ worktreeMb: 1e20, diskMinSlots: 1e20 }), Number.MAX_SAFE_INTEGER);
    // and a saturated floor still breaches everything real
    assert.equal(
      diskFloorBreach([probe('/wt', 9_000_000)], {
        worktreeMb: 1e20,
        diskMinSlots: 1e20,
      })?.path,
      '/wt'
    );
  });
});

describe('diskFloorBreach', () => {
  test('a probe below the floor breaches — every filesystem must cover', () => {
    const b = diskFloorBreach([probe('/worktrees', 900), probe('/tmp', 500)], cfg);
    assert.equal(b?.path, '/tmp');
  });

  test('every probe above the floor admits', () => {
    assert.equal(
      diskFloorBreach([probe('/worktrees', 800), probe('/tmp', 12_000)], cfg),
      undefined
    );
  });

  test('the boundary value admits — the floor is exclusive', () => {
    // free == floor still buys the slot; the margin is measured AFTER
    // the new worktree lands
    assert.equal(diskFloorBreach([probe('/wt', 800)], cfg), undefined);
    assert.equal(diskFloorBreach([probe('/wt', 799.9)], cfg)?.path, '/wt');
  });

  test('diskMinSlots 0 disables the watermark', () => {
    assert.equal(diskFloorBreach([probe('/wt', 1)], { ...cfg, diskMinSlots: 0 }), undefined);
  });

  test('worktreeMb 0 prices nothing — admits (config floors it at 1)', () => {
    assert.equal(diskFloorBreach([probe('/wt', 1)], { worktreeMb: 0, diskMinSlots: 2 }), undefined);
  });

  test('no probes admits — an unreadable watermark reports, never gates', () => {
    assert.equal(diskFloorBreach([], cfg), undefined);
  });
});

describe('the small-fs leg (bro-v96mp)', () => {
  // a 5.9G tmpfs priced at 2×400M slots trips the absolute floor only
  // at ~86% used — a leak burst from ENOSPC. Proportional headroom
  // holds it at 50% instead.
  const TMPFS_MB = 5900;

  test('a small filesystem demands half free — floor is total/2', () => {
    const p = probe('/tmp', 2000, TMPFS_MB);
    assert.equal(diskFloorFor(cfg, p), Math.floor((TMPFS_MB * MB) / 2));
    // free above half admits, below holds
    assert.equal(diskFloorBreach([probe('/tmp', 2960, TMPFS_MB)], cfg), undefined);
    assert.equal(diskFloorBreach([probe('/tmp', 2900, TMPFS_MB)], cfg)?.path, '/tmp');
  });

  test('the slot price still wins when it is the bigger floor', () => {
    // 1.4G fs: total/2 (700M) < slot floor (800M) — the slot price
    // still governs
    const p = probe('/tmp', 900, 1400);
    assert.equal(diskFloorFor(cfg, p), 800 * MB);
    assert.equal(diskFloorBreach([p], cfg), undefined);
    assert.equal(diskFloorBreach([probe('/tmp', 700, 1400)], cfg)?.path, '/tmp');
  });

  test('a big filesystem keeps the slot-priced floor', () => {
    // > 16 slots of capacity — the absolute price is the honest model
    const p = probe('/disk', 900, 500_000);
    assert.equal(diskFloorFor(cfg, p), 800 * MB);
    assert.equal(diskFloorBreach([p], cfg), undefined);
    assert.equal(diskFloorBreach([probe('/disk', 700, 500_000)], cfg)?.path, '/disk');
  });

  test('totalBytes absent → slot-priced floor exactly as before', () => {
    const p = probe('/tmp', 700);
    assert.equal(diskFloorFor(cfg, p), 800 * MB);
    assert.equal(diskFloorBreach([p], cfg)?.path, '/tmp');
  });
});
