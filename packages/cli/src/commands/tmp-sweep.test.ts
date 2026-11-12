import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTmpDirs, isPathInUse, tmpSweepVerdict, type TmpSweepInput } from './tmp-sweep.ts';

const HOUR = 60 * 60 * 1000;
const GRACE = 10 * 60 * 1000;

/** A verdict input with sane defaults — each test overrides only what
 *  it exercises. `inUse` defaults to "free"; tests that care pass a
 *  spy to prove the /proc scan never runs for young entries. */
const facts = (over: Partial<TmpSweepInput> = {}): TmpSweepInput => ({
  isDir: true,
  ownedByUs: true,
  ageMs: 2 * HOUR,
  ownerPid: null,
  ownerAlive: true,
  inUse: () => false,
  ...over,
});

/** Backdate a dir's mtime — the sweep's age gate reads stat, not birth. */
const ageDir = (dir: string, ageMs: number): void => {
  const at = new Date(Date.now() - ageMs);
  utimesSync(dir, at, at);
};

/** A pid that just exited — dead now and not reused within the test. */
const deadPid = (): number => {
  const child = spawnSync('true');
  return child.pid ?? -1;
};

describe('tmpSweepVerdict', () => {
  test('stale owned dir nobody uses deletes', () => {
    assert.equal(tmpSweepVerdict(facts()), 'delete');
  });

  test('young dir skips without consulting /proc', () => {
    let consulted = false;
    const inUse = (): boolean => {
      consulted = true;
      return false;
    };
    const v = tmpSweepVerdict(facts({ ageMs: 5 * 60 * 1000, inUse }));
    assert.equal(v, 'skip');
    assert.equal(consulted, false);
  });

  test('foreign-owned and non-dir entries always skip', () => {
    assert.equal(tmpSweepVerdict(facts({ ownedByUs: false })), 'skip');
    assert.equal(tmpSweepVerdict(facts({ isDir: false })), 'skip');
  });

  test('stale but in-use dir keeps', () => {
    assert.equal(tmpSweepVerdict(facts({ inUse: () => true })), 'keep');
  });

  test('dead-owner tmp-<pid>-* dir past grace deletes before the TTL', () => {
    // 30min old — under the 1h TTL, over the 10min dead-owner grace
    assert.equal(
      tmpSweepVerdict(facts({ ageMs: 30 * 60 * 1000, ownerPid: 424242, ownerAlive: false })),
      'delete'
    );
  });

  test('dead-owner tmp-<pid>-* dir inside grace still skips', () => {
    assert.equal(
      tmpSweepVerdict(facts({ ageMs: 2 * 60 * 1000, ownerPid: 424242, ownerAlive: false })),
      'skip'
    );
  });

  test('dead-owner tmp-<pid>-* dir past grace but in use keeps', () => {
    assert.equal(
      tmpSweepVerdict(
        facts({ ageMs: 30 * 60 * 1000, ownerPid: 424242, ownerAlive: false, inUse: () => true })
      ),
      'keep'
    );
  });

  test('live-owner tmp-<pid>-* dir keeps at any age — owner liveness is the use signal', () => {
    // even past the 1h TTL: the /proc scan cannot see a non-descendant
    // owner's fds, so deleting would break a live nx daemon's install
    assert.equal(
      tmpSweepVerdict(facts({ ageMs: 30 * 60 * 1000, ownerPid: 424242, ownerAlive: true })),
      'keep'
    );
    assert.equal(
      tmpSweepVerdict(facts({ ageMs: 2 * HOUR, ownerPid: 424242, ownerAlive: true })),
      'keep'
    );
  });

  test('pid-less tmp-XXXXXX names never take the owner path — TTL only', () => {
    assert.equal(
      tmpSweepVerdict(facts({ ageMs: 30 * 60 * 1000, ownerPid: null, ownerAlive: false })),
      'skip'
    );
    assert.equal(
      tmpSweepVerdict(facts({ ageMs: 2 * HOUR, ownerPid: null, ownerAlive: false })),
      'delete'
    );
  });
});

describe('isPathInUse', () => {
  test('a tmp dir nobody references is free', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sweep-test-'));
    try {
      assert.equal(isPathInUse(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a live child holding the dir as cwd reads as in use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sweep-test-'));
    const child = spawn('sleep', ['30'], { cwd: dir });
    try {
      // give the child a beat to exec and set its cwd
      const deadline = Date.now() + 2000;
      let inUse = false;
      while (Date.now() < deadline) {
        if (isPathInUse(dir)) {
          inUse = true;
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      assert.equal(inUse, true);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cleanupTmpDirs', () => {
  /** Run the sweep against a private TMPDIR fixture. `os.tmpdir()` reads
   *  $TMPDIR per call, so overriding the env var redirects the scan. */
  const withTmp = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sweep-root-'));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = dir;
    try {
      fn(dir);
    } finally {
      // env assignment stringifies — restore means delete, not = undefined
      if (prev === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = prev;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const lines = (fn: () => void): string[] => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => out.push(args.join(' '));
    try {
      fn();
    } finally {
      console.log = orig;
    }
    return out;
  };

  test('deletes a stale tmp-<pid>-* dir whose owner pid is dead', () => {
    const pid = deadPid();
    assert.ok(pid > 0);
    withTmp(dir => {
      const victim = join(dir, `tmp-${pid}-aaaaaaaaaaaa`);
      // 0700 like the real creators (mkdtempSync, tmp-package DIR_MODE) —
      // a group/other-accessible dir reads conservatively in-use on
      // multi-user hosts and would never reach the verdict under test
      mkdirSync(victim, { recursive: true, mode: 0o700 });
      writeFileSync(join(victim, 'marker'), 'x');
      ageDir(victim, GRACE + 60_000);
      const out = lines(() => cleanupTmpDirs(false));
      assert.ok(
        out.some(l => l.includes('deleted')),
        `expected a delete line, got: ${out}`
      );
      assert.equal(existsSync(victim), false);
    });
  });

  test('keeps a tmp-<pid>-* dir whose owner pid is alive (this process)', () => {
    withTmp(dir => {
      const mine = join(dir, `tmp-${process.pid}-bbbbbbbbbbbb`);
      mkdirSync(mine, { recursive: true, mode: 0o700 });
      ageDir(mine, GRACE + 60_000);
      const out = lines(() => cleanupTmpDirs(false));
      // owner pid is this live process → keep verdict at ANY age, and the
      // keep line says why (owner liveness, not a /proc in-use read)
      assert.ok(existsSync(mine));
      assert.ok(
        out.some(l => l.includes(mine) && l.includes('owner pid alive')),
        `got: ${out}`
      );
    });
  });

  test('dry-run reports but does not delete', () => {
    withTmp(dir => {
      const victim = join(dir, 'bro-published-zzzzzz');
      mkdirSync(victim, { recursive: true, mode: 0o700 });
      ageDir(victim, HOUR + 60_000);
      const out = lines(() => cleanupTmpDirs(true));
      assert.ok(
        out.some(l => l.includes('would delete')),
        `got: ${out}`
      );
      assert.ok(existsSync(victim));
    });
  });

  test('a fresh bro-published-* dir is left alone', () => {
    withTmp(dir => {
      const fresh = join(dir, 'bro-published-yyyyyy');
      mkdirSync(fresh, { recursive: true, mode: 0o700 });
      cleanupTmpDirs(false);
      assert.ok(existsSync(fresh));
    });
  });

  test('quietKeeps suppresses keep lines but still reports deletes', () => {
    withTmp(dir => {
      const held = join(dir, 'npm-heldtest');
      mkdirSync(held, { recursive: true, mode: 0o700 });
      ageDir(held, HOUR + 60_000);
      const child = spawn('sleep', ['30'], { cwd: held });
      try {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && !isPathInUse(held)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
        const loud = lines(() => cleanupTmpDirs(false));
        const quiet = lines(() => cleanupTmpDirs(false, { quietKeeps: true }));
        assert.ok(
          loud.some(l => l.includes('keep')),
          `expected keep lines, got: ${loud}`
        );
        assert.ok(
          !quiet.some(l => l.trim().startsWith('keep')),
          `quiet leaked keep lines: ${quiet}`
        );
        assert.ok(existsSync(held));
      } finally {
        child.kill();
      }
    });
  });
});
