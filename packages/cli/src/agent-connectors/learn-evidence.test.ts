import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { AgentRegistryEntry } from '@broject/core';
import { initRepo, installFakeBd, writeBeads } from '../commands/testrepo.ts';
import { checkRunLearnEvidence } from './learn-evidence.ts';

// ambient repo/store pins would redirect beadsDir/git resolution into
// the outer repo — same scrub the connector suite runs
const scrubbed: Record<string, string | undefined> = {};
for (const k of Object.keys(process.env)) {
  if (/^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|BEADS_DIR|BRO_)/.test(k)) {
    scrubbed[k] = process.env[k];
    delete process.env[k];
  }
}
after(() => {
  for (const [k, v] of Object.entries(scrubbed)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

interface Fx {
  root: string;
  main: string;
  /** the shared store dir — <main>/.beads, the layout beadsDir() resolves */
  storeDir: string;
  db: string;
  home: string;
  prevPath: string;
  prevFakeDb?: string;
  prevWedge?: string;
}

/** Real git repo + fake bd planted at <main>/.beads — beadsDir(main)
 *  resolves exactly there, so taskStoreAt/listLessonsAt/bdAt all land
 *  on the seeded store. `extra` carries kv/deps/mols into the db doc. */
function fx(rows: Array<Record<string, unknown>> = [], extra: Record<string, unknown> = {}): Fx {
  const { root, main } = initRepo('bro-learnev-');
  const storeDir = join(main, '.beads');
  const { binDir, db } = installFakeBd(storeDir, []);
  writeBeads(db, rows, extra);
  const home = mkdtempSync(join(tmpdir(), 'bro-learnev-home-'));
  const prevPath = process.env.PATH ?? '';
  const prevFakeDb = process.env.FAKE_BD_DB;
  const prevWedge = process.env.FAKE_BD_WEDGE;
  process.env.PATH = `${binDir}:${prevPath}`;
  process.env.FAKE_BD_DB = db;
  delete process.env.FAKE_BD_WEDGE;
  return { root, main, storeDir, db, home, prevPath, prevFakeDb, prevWedge };
}

function cleanup(f: Fx): void {
  process.env.PATH = f.prevPath;
  if (f.prevFakeDb === undefined) {
    delete process.env.FAKE_BD_DB;
  } else {
    process.env.FAKE_BD_DB = f.prevFakeDb;
  }
  if (f.prevWedge === undefined) {
    delete process.env.FAKE_BD_WEDGE;
  } else {
    process.env.FAKE_BD_WEDGE = f.prevWedge;
  }
  rmSync(f.root, { recursive: true, force: true });
  rmSync(f.home, { recursive: true, force: true });
}

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

function entry(over: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    agentId: 'ag-1',
    backend: 'native',
    spawnedAt: iso(NOW - 60_000),
    runId: 'run-1',
    ...over,
  };
}

const check = (
  f: Fx,
  over: {
    molStep?: string;
    entry?: AgentRegistryEntry;
    cause?: string;
    exitAt?: number;
  } = {}
) =>
  checkRunLearnEvidence({
    dir: f.main,
    home: f.home,
    molStep: over.molStep ?? 'fx-step-1',
    entry: over.entry ?? entry(),
    cause: over.cause ?? 'ok',
    exitAt: over.exitAt ?? NOW,
  });

const lesson = (over: Record<string, unknown> = {}) => ({
  id: 'learn-foo',
  trigger: { on: ['session-start'] },
  lesson: 'a rule',
  evidence: [{ kind: 'session', ref: 'ag-1' }],
  confidence: 'tentative',
  source: 'manual',
  createdAt: iso(NOW - 30_000),
  ...over,
});

describe('checkRunLearnEvidence', () => {
  test('clean exit with no evidence → miss', () => {
    const f = fx([
      { id: 'fx-step-1', status: 'closed', close_reason: 'done', closed_at: iso(NOW) },
    ]);
    try {
      const r = check(f);
      assert.equal(r.verdict, 'miss');
      assert.equal(r.evidence, undefined);
    } finally {
      cleanup(f);
    }
  });

  test('learn:-flagged close_reason → ok', () => {
    const f = fx([
      {
        id: 'fx-step-1',
        status: 'closed',
        close_reason: 'shipped it\nlearn: always run the gate before pushing',
        closed_at: iso(NOW),
      },
    ]);
    try {
      const r = check(f);
      assert.equal(r.verdict, 'ok');
      assert.match(r.evidence ?? '', /close_reason/);
    } finally {
      cleanup(f);
    }
  });

  test('unflagged close_reason is a handoff, not evidence → miss', () => {
    const f = fx([
      {
        id: 'fx-step-1',
        status: 'closed',
        close_reason: 'remember to check the gate',
        closed_at: iso(NOW),
      },
    ]);
    try {
      assert.equal(check(f).verdict, 'miss');
    } finally {
      cleanup(f);
    }
  });

  test('close_reason outside the run window does not credit a respawn → miss', () => {
    const f = fx([
      {
        id: 'fx-step-1',
        status: 'closed',
        close_reason: 'learn: stale lesson from a prior attempt',
        closed_at: iso(NOW - 86_400_000),
      },
    ]);
    try {
      // spawnedAt is NOW-60s — yesterday's close predates this run
      assert.equal(check(f).verdict, 'miss');
    } finally {
      cleanup(f);
    }
  });

  test('lesson citing the run session inside the window → ok', () => {
    const f = fx([], {
      kv: { 'learn/learn-foo': JSON.stringify(lesson()) },
    });
    try {
      const r = check(f);
      assert.equal(r.verdict, 'ok');
      assert.match(r.evidence ?? '', /learn-foo/);
    } finally {
      cleanup(f);
    }
  });

  test('lesson citing the bead id → ok', () => {
    const f = fx([], {
      kv: {
        'learn/learn-foo': JSON.stringify(
          lesson({ evidence: [{ kind: 'bead', ref: 'fx-step-1' }] })
        ),
      },
    });
    try {
      assert.equal(check(f).verdict, 'ok');
    } finally {
      cleanup(f);
    }
  });

  test('lesson outside the window → miss', () => {
    const f = fx([], {
      kv: {
        'learn/learn-foo': JSON.stringify(lesson({ createdAt: iso(NOW - 86_400_000) })),
      },
    });
    try {
      assert.equal(check(f).verdict, 'miss');
    } finally {
      cleanup(f);
    }
  });

  test('lesson citing an unrelated session → miss', () => {
    const f = fx([], {
      kv: {
        'learn/learn-foo': JSON.stringify(
          lesson({ evidence: [{ kind: 'session', ref: 'someone-else' }] })
        ),
      },
    });
    try {
      assert.equal(check(f).verdict, 'miss');
    } finally {
      cleanup(f);
    }
  });

  test('retro bead discovered-from the step → ok', () => {
    const f = fx(
      [
        { id: 'fx-step-1', status: 'closed', close_reason: 'done' },
        { id: 'fx-retro-1', status: 'closed', labels: ['retro'], created_at: iso(NOW - 10_000) },
      ],
      {
        deps: [{ issue_id: 'fx-retro-1', depends_on_id: 'fx-step-1', type: 'discovered-from' }],
      }
    );
    try {
      const r = check(f);
      assert.equal(r.verdict, 'ok');
      assert.match(r.evidence ?? '', /fx-retro-1/);
    } finally {
      cleanup(f);
    }
  });

  test('prevention bead discovered-from the molecule parent → ok', () => {
    const f = fx(
      [
        { id: 'fx-step-1', status: 'closed', parent: 'fx-mol-1', close_reason: 'done' },
        {
          id: 'fx-prev-1',
          status: 'open',
          labels: ['prevention', 'sink:skill'],
          created_at: iso(NOW - 10_000),
        },
        { id: 'fx-mol-1', status: 'open', issue_type: 'molecule' },
      ],
      {
        deps: [{ issue_id: 'fx-prev-1', depends_on_id: 'fx-mol-1', type: 'discovered-from' }],
      }
    );
    try {
      const r = check(f);
      assert.equal(r.verdict, 'ok');
      assert.match(r.evidence ?? '', /fx-prev-1/);
    } finally {
      cleanup(f);
    }
  });

  test('wtf → retro two-hop chain → ok', () => {
    const f = fx(
      [
        { id: 'fx-step-1', status: 'closed', close_reason: 'done' },
        { id: 'fx-wtf-1', status: 'closed', labels: ['wtf'], created_at: iso(NOW - 20_000) },
        { id: 'fx-retro-2', status: 'closed', labels: ['retro'], created_at: iso(NOW - 10_000) },
      ],
      {
        deps: [
          { issue_id: 'fx-wtf-1', depends_on_id: 'fx-step-1', type: 'discovered-from' },
          { issue_id: 'fx-retro-2', depends_on_id: 'fx-wtf-1', type: 'discovered-from' },
        ],
      }
    );
    try {
      const r = check(f);
      assert.equal(r.verdict, 'ok');
      assert.match(r.evidence ?? '', /fx-retro-2/);
    } finally {
      cleanup(f);
    }
  });

  test('retro created inside the window with no dep wiring → ok (window attribution)', () => {
    const f = fx(
      [
        { id: 'fx-step-1', status: 'closed', close_reason: 'done' },
        { id: 'fx-retro-9', status: 'closed', labels: ['retro'], created_at: iso(NOW - 5_000) },
      ],
      {}
    );
    try {
      const r = check(f);
      assert.equal(r.verdict, 'ok');
      assert.match(r.evidence ?? '', /run window/);
    } finally {
      cleanup(f);
    }
  });

  test('retro created outside the window → miss', () => {
    const f = fx(
      [
        { id: 'fx-step-1', status: 'closed', close_reason: 'done' },
        {
          id: 'fx-retro-9',
          status: 'closed',
          labels: ['retro'],
          created_at: iso(NOW - 86_400_000),
        },
      ],
      {}
    );
    try {
      assert.equal(check(f).verdict, 'miss');
    } finally {
      cleanup(f);
    }
  });

  test('dep-discovered retro older than the window → miss', () => {
    const f = fx(
      [
        { id: 'fx-step-1', status: 'closed', close_reason: 'done' },
        {
          id: 'fx-retro-1',
          status: 'closed',
          labels: ['retro'],
          created_at: iso(NOW - 86_400_000),
        },
      ],
      {
        deps: [{ issue_id: 'fx-retro-1', depends_on_id: 'fx-step-1', type: 'discovered-from' }],
      }
    );
    try {
      assert.equal(check(f).verdict, 'miss');
    } finally {
      cleanup(f);
    }
  });

  test('molecule-root run: a step close_reason flagged learn: → ok', () => {
    const f = fx(
      [{ id: 'fx-mol-1', status: 'closed', issue_type: 'molecule', close_reason: 'convoy done' }],
      {
        mols: {
          'fx-mol-1': {
            root: { id: 'fx-mol-1', status: 'closed' },
            issues: [
              { id: 'fx-mol-1', status: 'closed', close_reason: 'convoy done' },
              {
                id: 'fx-s1',
                status: 'closed',
                close_reason: 'step landed\nlearn: gate before push',
                closed_at: iso(NOW),
              },
            ],
          },
        },
      }
    );
    try {
      const r = check(f, { molStep: 'fx-mol-1' });
      assert.equal(r.verdict, 'ok');
      assert.match(r.evidence ?? '', /fx-s1/);
    } finally {
      cleanup(f);
    }
  });

  test('dep targets past the walk bound read skipped, never miss', () => {
    // 8 sibling steps + the root = 9 targets > MAX_DEP_TARGETS — the
    // truncated walk can't disprove a retro linked to an omitted
    // target, so the verdict is 'skipped', not 'miss'
    const steps = Array.from({ length: 8 }, (_, i) => ({
      id: `fx-s${i + 1}`,
      status: 'closed',
      closed_at: iso(NOW - 30_000),
    }));
    const f = fx([{ id: 'fx-mol-1', status: 'closed', issue_type: 'molecule' }], {
      mols: {
        'fx-mol-1': {
          root: { id: 'fx-mol-1', status: 'closed' },
          issues: [{ id: 'fx-mol-1', status: 'closed' }, ...steps],
        },
      },
    });
    try {
      const r = check(f, { molStep: 'fx-mol-1' });
      assert.equal(r.verdict, 'skipped');
      assert.match(r.evidence ?? '', /dep targets truncated/);
    } finally {
      cleanup(f);
    }
  });

  test('rate_limited / quota / auth exits skip before any store read → skipped', () => {
    const f = fx();
    try {
      for (const cause of ['rate_limited', 'quota', 'auth']) {
        const r = check(f, { cause });
        assert.equal(r.verdict, 'skipped', cause);
        assert.match(r.evidence ?? '', new RegExp(cause));
      }
    } finally {
      cleanup(f);
    }
  });

  test('entry.storeDir wins over the dir-resolved store — evidence on the pinned store reads ok', () => {
    const f = fx([{ id: 'fx-step-1', status: 'closed', close_reason: 'done' }]);
    try {
      // a second store the run was actually pinned to — the
      // dir-resolved <main>/.beads holds no qualifying evidence, so an
      // 'ok' can only come from the pinned path
      const pinned = join(f.root, 'pinned-beads');
      mkdirSync(pinned, { recursive: true });
      writeBeads(join(pinned, 'beads.json'), [{ id: 'fx-step-1', status: 'open' }], {
        kv: { 'learn/learn-pin': JSON.stringify(lesson({ id: 'learn-pin' })) },
      });
      const r = check(f, { entry: entry({ storeDir: pinned }) });
      assert.equal(r.verdict, 'ok');
      assert.match(r.evidence ?? '', /learn-pin/);
    } finally {
      cleanup(f);
    }
  });

  test('operator-stopped entry → skipped — a downed run never reached closeout', () => {
    const f = fx([{ id: 'fx-step-1', status: 'closed', close_reason: 'done' }]);
    try {
      const r = check(f, { entry: entry({ stopped: true }) });
      assert.equal(r.verdict, 'skipped');
      assert.match(r.evidence ?? '', /stopped/);
    } finally {
      cleanup(f);
    }
  });

  test('remote backend (copilot) skips — cannot inspect the shared store', () => {
    const f = fx();
    try {
      const r = check(f, { entry: entry({ backend: 'copilot' }) });
      assert.equal(r.verdict, 'skipped');
      assert.match(r.evidence ?? '', /copilot/);
    } finally {
      cleanup(f);
    }
  });

  test('wedged store → skipped, never miss', () => {
    const f = fx();
    try {
      const wedge = join(f.home, 'wedge.txt');
      writeFileSync(wedge, 'show\ndep\nlist\nkv\nmol\n');
      process.env.FAKE_BD_WEDGE = wedge;
      const r = check(f);
      assert.equal(r.verdict, 'skipped');
      assert.match(r.evidence ?? '', /probes failed/);
    } finally {
      cleanup(f);
    }
  });

  test('lesson snapshot caches on the store stamp — a same-stamp recheck serves stale, a moved stamp re-reads', () => {
    const f = fx([], {
      kv: { 'learn/learn-foo': JSON.stringify(lesson()) },
    });
    try {
      // a dolt manifest gives the store a stamp — without one every
      // probe reads live (the fake layout has no noms dir)
      const noms = join(f.storeDir, 'embeddeddolt', 'db1', '.dolt', 'noms');
      mkdirSync(noms, { recursive: true });
      const manifest = join(noms, 'manifest');
      writeFileSync(manifest, 'a');
      assert.equal(check(f).verdict, 'ok');
      // delete the lesson — the stamp hasn't moved, so the cached
      // snapshot still answers (over-invalidation is the safe direction)
      writeBeads(f.db, [], { kv: {} });
      assert.equal(check(f).verdict, 'ok', 'cached snapshot serves the prior listing');
      // move the stamp — the next check must read live and see the miss
      writeFileSync(manifest, 'bb');
      assert.equal(check(f).verdict, 'miss');
    } finally {
      cleanup(f);
    }
  });
});
