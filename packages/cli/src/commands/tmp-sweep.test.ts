import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupTmpDirs,
  isPathInUse,
  tmpSweepVerdict,
  type TmpSweepInput,
  workerTmpRoots,
} from './tmp-sweep.ts';

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

  test("an extraRoots worker tmpdir sweeps by the same verdicts — emptied root rmdir'd (bro-v96mp)", () => {
    const pid = deadPid();
    assert.ok(pid > 0);
    withTmp(dir => {
      const agentDir = join(dir, 'bro-tmp', 'agent-x');
      const leaf = join(agentDir, `tmp-${pid}-cccccccccccc`);
      mkdirSync(leaf, { recursive: true, mode: 0o700 });
      writeFileSync(join(leaf, 'marker'), 'x');
      ageDir(leaf, GRACE + 60_000);
      // a live-owner leaf beside it keeps — the daemon's own install
      const live = join(agentDir, `tmp-${process.pid}-dddddddddddd`);
      mkdirSync(live, { recursive: true, mode: 0o700 });
      const out = lines(() => cleanupTmpDirs(false, { extraRoots: [agentDir] }));
      assert.ok(
        out.some(l => l.includes('deleted')),
        `expected a delete line, got: ${out}`
      );
      assert.equal(existsSync(leaf), false);
      assert.ok(existsSync(live));
      // the emptied shell is litter of the same class — rmdir'd only
      // once the live leaf is gone too
      assert.ok(existsSync(agentDir));
      rmSync(live, { recursive: true, force: true });
    });
  });

  test('a missing extraRoots dir warns and skips — never fatal like tmpdir', () => {
    withTmp(dir => {
      const errs: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => errs.push(args.join(' '));
      let out: string[] = [];
      try {
        out = lines(() => cleanupTmpDirs(false, { extraRoots: [join(dir, 'no-such-bro-tmp')] }));
      } finally {
        console.error = orig;
      }
      assert.ok(!out.some(l => l.includes('error')), `got: ${out}`);
      assert.ok(
        errs.some(l => l.includes('cannot list') && l.includes('no-such-bro-tmp')),
        `expected a stderr warning, got: ${errs}`
      );
    });
  });
});

describe('workerTmpRoots (bro-v96mp)', () => {
  /** A real `git init` — gitCommonDir answers via rev-parse, so a .git
   *  shape alone is not enough. */
  const withRepo = (fn: (root: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), 'bro-sweep-repo-'));
    spawnSync('git', ['init', '-q', root]);
    try {
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test('lists the main + linked worktree bro-tmp dirs', () => {
    withRepo(root => {
      const common = join(root, '.git');
      mkdirSync(join(common, 'bro-tmp', 'agent-a'), { recursive: true });
      mkdirSync(join(common, 'worktrees', 'wt1', 'bro-tmp', 'agent-b'), {
        recursive: true,
      });
      // a stray file under bro-tmp is not an agent dir — never a root
      writeFileSync(join(common, 'bro-tmp', 'stray'), 'x');
      assert.deepEqual(workerTmpRoots(root).sort(), [
        join(common, 'bro-tmp', 'agent-a'),
        join(common, 'worktrees', 'wt1', 'bro-tmp', 'agent-b'),
      ]);
    });
  });

  test('[] outside a repository and with no bro-tmp dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sweep-notrepo-'));
    try {
      assert.deepEqual(workerTmpRoots(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    withRepo(root => assert.deepEqual(workerTmpRoots(root), []));
  });
});

describe('extra-root rmdir guard (bro-v96mp)', () => {
  /** A real repo carrying a `bro-tmp/<agent>` shell — the emptied-root
   *  rmdir only fires inside a gitdir the registry can be read from.
   *  TMPDIR redirects to an empty fixture so the os.tmpdir() leg never
   *  sweeps the real /tmp. */
  const withRepo = (fn: (root: string, common: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), 'bro-sweep-rmdir-'));
    spawnSync('git', ['init', '-q', root]);
    const common = join(root, '.git');
    const tmp = join(root, 'faketmp');
    mkdirSync(tmp);
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      fn(root, common);
    } finally {
      if (prev === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = prev;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };

  /** A registry entry whose agentId owns the shell — the fields
   *  registryEntryState's liveness ladder reads. */
  const writeAgents = (common: string, entries: Record<string, unknown>): void => {
    mkdirSync(join(common, 'bro'), { recursive: true });
    writeFileSync(join(common, 'bro', 'agents.json'), JSON.stringify(entries));
  };

  test("a stale emptied shell with no registry is orphan litter — rmdir'd", () => {
    withRepo((_root, common) => {
      const shell = join(common, 'bro-tmp', 'agent-gone');
      mkdirSync(shell, { recursive: true, mode: 0o700 });
      ageDir(shell, HOUR + 60_000);
      cleanupTmpDirs(false, { extraRoots: [shell] });
      assert.equal(existsSync(shell), false);
    });
  });

  test('a fresh emptied shell keeps — the mtime is inside the TTL', () => {
    withRepo((_root, common) => {
      const shell = join(common, 'bro-tmp', 'agent-new');
      mkdirSync(shell, { recursive: true, mode: 0o700 });
      cleanupTmpDirs(false, { extraRoots: [shell] });
      assert.ok(existsSync(shell));
    });
  });

  test('a stale shell a live registry agent owns keeps — its TMPDIR is not litter', () => {
    withRepo((_root, common) => {
      const shell = join(common, 'bro-tmp', 'agent-live');
      mkdirSync(shell, { recursive: true, mode: 0o700 });
      ageDir(shell, HOUR + 60_000);
      writeAgents(common, {
        'mol-step-1': {
          agentId: 'agent-live',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: process.pid,
        },
      });
      cleanupTmpDirs(false, { extraRoots: [shell] });
      assert.ok(existsSync(shell));
    });
  });

  test("a stale shell whose registry agent already exited is litter — rmdir'd", () => {
    withRepo((_root, common) => {
      const shell = join(common, 'bro-tmp', 'agent-dead');
      mkdirSync(shell, { recursive: true, mode: 0o700 });
      ageDir(shell, HOUR + 60_000);
      writeAgents(common, {
        'mol-step-1': {
          agentId: 'agent-dead',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          exitStatus: 0,
        },
      });
      cleanupTmpDirs(false, { extraRoots: [shell] });
      assert.equal(existsSync(shell), false);
    });
  });

  test('a stale shell whose registry is corrupt keeps — unknown is not orphan proof', () => {
    withRepo((_root, common) => {
      const shell = join(common, 'bro-tmp', 'agent-corrupt');
      mkdirSync(shell, { recursive: true, mode: 0o700 });
      ageDir(shell, HOUR + 60_000);
      mkdirSync(join(common, 'bro'), { recursive: true });
      writeFileSync(join(common, 'bro', 'agents.json'), '{torn write — never valid json');
      cleanupTmpDirs(false, { extraRoots: [shell] });
      assert.ok(existsSync(shell));
    });
  });

  test('a stale shell outside any repo keeps — the registry path cannot resolve', () => {
    // agentRegistryPath answers null off-repo: 'unknown', never the
    // empty-registry 'free' a failed probe would fake — the pinned
    // TMPDIR of a worker whose registry can't be read is not litter
    const norepo = mkdtempSync(join(tmpdir(), 'bro-sweep-norepo-'));
    try {
      const shell = join(norepo, 'bro-tmp', 'agent-offrepo');
      mkdirSync(shell, { recursive: true, mode: 0o700 });
      ageDir(shell, HOUR + 60_000);
      cleanupTmpDirs(false, { extraRoots: [shell] });
      assert.ok(existsSync(shell));
    } finally {
      rmSync(norepo, { recursive: true, force: true });
    }
  });
});
