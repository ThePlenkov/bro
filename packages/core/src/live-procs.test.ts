/** live-procs — the orphan classifier and sweep. An orphaned bd holds
 *  the embedded noms LOCK past every caller's timeout (bro-8845g);
 *  the sweep must catch exactly those: right comm, reparented to
 *  init/systemd, cwd inside the repo, older than the age floor. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pickOrphanProcs, spawnSelf, sweepOrphanProcs, type ProcRow } from './live-procs.ts';

const NOW = Date.parse('2026-10-10T07:00:00Z');
const OLD = NOW - 120_000; // well past the 60s age floor
const YOUNG = NOW - 5_000; // a live, in-flight call

function row(partial: Partial<ProcRow>): ProcRow {
  return {
    pid: 1000,
    comm: 'bd',
    ppid: 1,
    parentComm: 'init',
    cwd: '/repo/sub',
    startMs: OLD,
    ...partial,
  };
}

describe('pickOrphanProcs', () => {
  test('a reparented, repo-cwd, old bd is picked', () => {
    assert.deepEqual(pickOrphanProcs([row({ pid: 7 })], 'bd', '/repo', NOW), [7]);
  });

  test('a live parent (non-init comm) is not an orphan', () => {
    assert.deepEqual(
      pickOrphanProcs([row({ pid: 7, ppid: 42, parentComm: 'node' })], 'bd', '/repo', NOW),
      []
    );
  });

  test('ppid 1 and systemd both count as reparented', () => {
    const rows = [
      row({ pid: 1, ppid: 1, parentComm: null }),
      row({ pid: 2, ppid: 55, parentComm: 'systemd' }),
      row({ pid: 3, ppid: 789, parentComm: 'init' }), // WSL /init subreaper
    ];
    assert.deepEqual(pickOrphanProcs(rows, 'bd', '/repo', NOW), [1, 2, 3]);
  });

  test('cwd outside the repo is left alone', () => {
    const rows = [
      row({ pid: 1, cwd: '/other/dir' }),
      row({ pid: 2, cwd: '/repo-sibling/x' }), // prefix-attack guard
      row({ pid: 3, cwd: '/repo' }), // root itself counts
    ];
    assert.deepEqual(pickOrphanProcs(rows, 'bd', '/repo', NOW), [3]);
  });

  test('young procs are in-flight calls, not debris', () => {
    assert.deepEqual(pickOrphanProcs([row({ pid: 7, startMs: YOUNG })], 'bd', '/repo', NOW), []);
  });

  test('other comms are ignored', () => {
    assert.deepEqual(pickOrphanProcs([row({ pid: 7, comm: 'dolt' })], 'bd', '/repo', NOW), []);
  });

  test('unreadable cwd (raced exit) is skipped', () => {
    assert.deepEqual(pickOrphanProcs([row({ pid: 7, cwd: null })], 'bd', '/repo', NOW), []);
  });
});

describe('sweepOrphanProcs', () => {
  test('kills the matched pids through the injected signal', () => {
    const killed: number[] = [];
    const rows = [row({ pid: 7 }), row({ pid: 8, ppid: 42, parentComm: 'node' })];
    const r = sweepOrphanProcs('bd', '/repo', {
      rows,
      now: NOW,
      kill: pid => killed.push(pid),
    });
    assert.deepEqual(killed, [7]);
    assert.equal(r.scanned, 2);
    assert.deepEqual(r.signaled, [{ pid: 7, cwd: '/repo/sub' }]);
    assert.deepEqual(r.failed, []);
  });

  test('a resisting kill lands in failed, not thrown', () => {
    const r = sweepOrphanProcs('bd', '/repo', {
      rows: [row({ pid: 7 })],
      now: NOW,
      kill: () => {
        throw new Error('EPERM');
      },
    });
    assert.deepEqual(r.signaled, []);
    assert.deepEqual(r.failed, [7]);
  });
});

describe('spawnSelf', () => {
  /** argv[1] is the CLI entry the child re-runs — mutable in-process,
   *  restored on exit of every case. */
  function withEntry<T>(entry: string | undefined, fn: () => T): T {
    const prev = process.argv[1];
    if (entry === undefined) {
      process.argv.length = 1;
    } else {
      process.argv[1] = entry;
    }
    try {
      return fn();
    } finally {
      process.argv[1] = prev;
    }
  }

  const tmpRoot = join(tmpdir(), `bro-spawnSelf-${process.pid}`);

  test('a test-runner argv is refused — it would fork the suite', () => {
    withEntry('/usr/bin/tsx', () => {
      assert.equal(spawnSelf(['status'], tmpRoot), false);
    });
    withEntry(join(tmpRoot, 'suite.test.ts'), () => {
      assert.equal(spawnSelf(['status'], tmpRoot), false);
    });
  });

  test('a missing argv[1] or a nonexistent entry refuses', () => {
    withEntry(undefined, () => {
      assert.equal(spawnSelf(['status'], tmpRoot), false);
    });
    withEntry(join(tmpRoot, 'index.js'), () => {
      assert.equal(spawnSelf(['status'], tmpRoot), false);
    });
  });

  test('a bro-shaped entry spawns detached with args and cwd', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const entry = join(tmpRoot, 'index.js');
    writeFileSync(entry, "require('node:fs').writeFileSync(process.argv[2], process.cwd())");
    const sentinel = join(tmpRoot, 'spawned.txt');
    withEntry(entry, () => {
      assert.equal(spawnSelf([sentinel], tmpRoot), true);
    });
    for (let i = 0; i < 100 && !existsSync(sentinel); i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(existsSync(sentinel));
  });

  test('a `bro` bin name is also bro-shaped', () => {
    mkdirSync(tmpRoot, { recursive: true });
    const entry = join(tmpRoot, 'bro');
    writeFileSync(entry, 'process.exit(0)');
    withEntry(entry, () => {
      assert.equal(spawnSelf(['x'], tmpRoot), true);
    });
  });
});
