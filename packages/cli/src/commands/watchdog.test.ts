import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBaselines,
  logStats,
  renderWatchdogBrief,
  splitSlots,
  type WatchdogBaselines,
} from './watchdog.ts';
import type { LoopRunView } from './loop-state.ts';
import { initRepo, inside, runCli } from './testrepo.ts';

/** Every plane filled — the brief's happy path, values pinched from a
 *  real tick-0 snapshot so the rendered strings are the ones an
 *  orchestrator actually reads. */
const full = (over: Partial<WatchdogBaselines> = {}): WatchdogBaselines => ({
  ts: '2026-11-03T10:42:01Z',
  unit: { state: 'active', mainPid: 1583595, nRestarts: 0 },
  daemon: { pid: 6936, alive: true, logAgeSec: 10, etimedout: 24061 },
  loopOut: { lines: 17042, ageSec: 12, etimedout: 11888 },
  prs: { open: 77, ours: 57, foreign: 20 },
  disk: { path: '/tmp', usePercent: 90 },
  memory: { swapUsedBytes: 8.5 * 1024 ** 3, memAvailableBytes: 5.4 * 1024 ** 3 },
  worktrees: { count: 87 },
  slots: [
    { slug: 'bro-tdndq', beadId: 'bro-tdndq', pid: 3971542, state: 'running', silentMs: 4000 },
  ],
  residue: 0,
  ...over,
});

describe('logStats', () => {
  test('wc -l semantics: newline count, trailing newline included', () => {
    assert.equal(logStats('a\nb\nc\n').lines, 3);
    assert.equal(logStats('a\nb\nc').lines, 3);
    assert.equal(logStats('').lines, 0);
  });

  test('the sticky ETIMEDOUT baseline is the LAST match, numbered like grep -n', () => {
    assert.equal(logStats('a\nb\nboom ETIMEDOUT\nc\n').etimedout, 3);
    // an append-only log's newest match wins — that is the escalation
    // reference a fresh line must exceed
    assert.equal(logStats('ETIMEDOUT old\nmid\nETIMEDOUT new\n').etimedout, 3);
    assert.equal(logStats('nothing to see\n').etimedout, null);
  });
});

describe('splitSlots', () => {
  const run = (over: Partial<LoopRunView> = {}): LoopRunView => ({
    beadId: 'bro-x',
    slug: 'bro-x',
    pid: 4242,
    state: 'running',
    silentMs: 0,
    ...over,
  });

  test('a live worker is in flight; a dead record is residue', () => {
    const { slots, residue } = splitSlots(
      [run({ slug: 'bro-live', pid: 4242 }), run({ slug: 'bro-dead', pid: 4343, state: 'dead' })],
      1583595
    );
    assert.deepEqual(
      slots.map(s => s.slug),
      ['bro-live']
    );
    assert.equal(residue, 1);
  });

  test("a record stamped with the loop's own pid is residue, never a phantom worker", () => {
    // the real-world shape: 25 loop/ records carried the supervisor pid
    // because the run never settled — reporting them as in flight would
    // send the orchestrator chasing ghosts
    const { slots, residue } = splitSlots(
      [run({ slug: 'bro-ghost', pid: 1583595 }), run({ slug: 'bro-real', pid: 4242 })],
      1583595
    );
    assert.deepEqual(
      slots.map(s => s.slug),
      ['bro-real']
    );
    assert.equal(residue, 1);
  });

  test('unit degraded (mainPid null): the filter falls silent and reports records as they are', () => {
    const { slots, residue } = splitSlots([run({ slug: 'bro-ghost', pid: 1583595 })], null);
    assert.equal(slots.length, 1);
    assert.equal(residue, 0);
  });
});

describe('renderWatchdogBrief', () => {
  test('launch steps plus every measured plane', () => {
    const text = renderWatchdogBrief(full());
    assert.match(text, /Load the `watchdog` skill/);
    assert.match(text, /tick 0 — measured now, never remembered/);
    assert.match(text, /baselines @ 2026-11-03T10:42:01Z/);
    assert.match(text, /unit\s+active MainPID=1583595 NRestarts=0/);
    assert.match(text, /daemon\s+pid 6936 alive · log age 10s · ETIMEDOUT 24061/);
    assert.match(text, /loop\.out\s+17042 lines · age 12s · ETIMEDOUT 11888/);
    assert.match(text, /prs\s+77 open · ours 57 · foreign 20/);
    assert.match(text, /disk\s+\/tmp 90%/);
    assert.match(text, /memory\s+swap used 8\.5G · avail 5\.4G/);
    assert.match(text, /worktrees\s+87/);
    assert.match(text, /slots\s+1 — bro-tdndq pid=3971542 running/);
  });

  test('a dead daemon record is shouted, not smoothed over', () => {
    const text = renderWatchdogBrief(
      full({ daemon: { pid: 6936, alive: false, logAgeSec: 120, etimedout: 24061 } })
    );
    assert.match(text, /pid 6936 DEAD/);
  });

  test('a degraded plane never kills the launch — it says what it could not measure', () => {
    const text = renderWatchdogBrief(
      full({
        prs: { unavailable: 'gh pr list failed: no git remotes' },
        loopOut: { unavailable: 'loop.out unreadable or absent' },
        slots: [],
      })
    );
    assert.match(text, /Launch:/);
    assert.match(text, /unavailable \(gh pr list failed: no git remotes\)/);
    assert.match(text, /unavailable \(loop\.out unreadable or absent\)/);
    assert.match(text, /slots\s+none in flight/);
  });

  test('a no-record daemon prints the log facts it still has', () => {
    const text = renderWatchdogBrief(
      full({ daemon: { pid: null, alive: null, logAgeSec: null, etimedout: 24061 } })
    );
    assert.match(text, /no record/);
    assert.match(text, /ETIMEDOUT 24061/);
  });

  test('residue is reported when there is some, silent when there is not', () => {
    const dirty = renderWatchdogBrief(full({ residue: 25 }));
    assert.match(dirty, /residue\s+25 loop\/ record\(s\) not in flight/);
    assert.match(dirty, /stamped with the loop's own pid/);
    const clean = renderWatchdogBrief(full());
    assert.doesNotMatch(clean, /residue/);
  });
});

describe('collectBaselines', () => {
  test('a fresh repo measures what exists and degrades honestly on the rest', () => {
    const { root, main } = initRepo('bro-watchdog-');
    inside(main, root, () => {
      const b = collectBaselines(main, Date.UTC(2026, 10, 3, 10, 42, 1));
      assert.equal(b.ts, '2026-11-03T10:42:01Z');
      // git works here — a count, never a guess
      assert.ok(!('unavailable' in b.worktrees), JSON.stringify(b.worktrees));
      assert.ok(!('unavailable' in b.worktrees) && b.worktrees.count >= 1);
      // no loop.out, no daemon record in a fresh repo → honest degradation
      assert.ok('unavailable' in b.loopOut, JSON.stringify(b.loopOut));
      assert.ok('unavailable' in b.daemon, JSON.stringify(b.daemon));
      // no remote → gh must degrade rather than report zero PRs (a zero
      // would read as "everything merged", the exact lie to avoid)
      assert.ok('unavailable' in b.prs, JSON.stringify(b.prs));
      // no loop run records → none in flight, nothing to count as residue
      assert.deepEqual(b.slots, []);
      assert.equal(b.residue, 0);
      // host planes: well-formed either way, never a half-object
      for (const [name, plane] of [
        ['unit', b.unit],
        ['disk', b.disk],
        ['memory', b.memory],
      ] as const) {
        assert.ok(plane && typeof plane === 'object', name);
        assert.ok(
          'unavailable' in plane || Object.keys(plane).length > 0,
          `${name}: ${JSON.stringify(plane)}`
        );
      }
      if (!('unavailable' in b.disk)) {
        assert.ok(b.disk.usePercent >= 0 && b.disk.usePercent <= 100);
        assert.equal(b.disk.path, '/tmp');
      }
      if (!('unavailable' in b.unit)) {
        assert.equal(typeof b.unit.state, 'string');
      }
      if (!('unavailable' in b.memory)) {
        assert.ok(b.memory.swapUsedBytes >= 0);
        assert.ok(b.memory.memAvailableBytes >= 0);
      }
    });
  });
});

describe('bro watchdog dispatch', () => {
  test('--json exits 0 and carries the skill pointer plus every plane', () => {
    const { root, main } = initRepo('bro-watchdog-e2e-');
    inside(main, root, () => {
      const r = runCli(['watchdog', '--json'], { cwd: main });
      assert.equal(r.code, 0, r.stderr);
      const parsed = JSON.parse(r.stdout) as {
        ts: string;
        skill: string;
        baselines: Record<string, unknown>;
      };
      assert.equal(parsed.skill, 'watchdog');
      assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      for (const key of [
        'unit',
        'daemon',
        'loopOut',
        'prs',
        'disk',
        'memory',
        'worktrees',
        'slots',
        'residue',
      ]) {
        assert.ok(key in parsed.baselines, `baseline missing: ${key}`);
      }
    });
  });

  test('an unknown flag is a usage error on stderr, exit 2', () => {
    const { root, main } = initRepo('bro-watchdog-flag-');
    inside(main, root, () => {
      const r = runCli(['watchdog', '--nope'], { cwd: main });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /usage: bro watchdog/);
    });
  });

  test('--help is the stdout+0 contract', () => {
    const { root, main } = initRepo('bro-watchdog-help-');
    inside(main, root, () => {
      const r = runCli(['watchdog', '--help'], { cwd: main });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /usage: bro watchdog/);
    });
  });
});
