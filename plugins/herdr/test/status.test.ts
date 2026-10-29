import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { type PrActCacheEntry, silentBucketMin } from '../src/lib.ts';
import { diffKey, type Planes } from '../src/planes.ts';
import { agentTreePath, gateToken, statusFor, statusPrefix } from '../src/status.ts';

const MAIN = mkdtempSync(join(tmpdir(), 'bro-status-main-'));
const TREE = mkdtempSync(join(tmpdir(), 'bro-status-tree-'));

const planes = (over: Partial<Planes> = {}): Planes => ({
  repo: MAIN,
  main: MAIN,
  status: {
    dir: MAIN,
    worktrees: [],
    beads: { inProgress: [] },
    fleet: { maxConcurrent: 4, agents: [] },
    loop: { stallMin: 30, runs: [] },
  },
  worktrees: { source: { source_checkout_path: MAIN }, worktrees: [] },
  workspaces: [],
  registry: {},
  armedDetails: [],
  mirrorPanes: {},
  rendererPanes: {},
  act: [],
  ...over,
});

const withStatus = (p: Planes, over: Partial<Planes['status']> = {}): Planes => ({
  ...p,
  status: { ...p.status, ...over },
});

const H = 3_600_000;
const M = 60_000;

describe('silentBucketMin', () => {
  test('null/undefined stay absent', () => {
    assert.equal(silentBucketMin(null), null);
    assert.equal(silentBucketMin(undefined), null);
  });

  test('under an hour buckets by 5 minutes', () => {
    assert.equal(silentBucketMin(4 * M), 0);
    assert.equal(silentBucketMin(12 * M), 10);
    assert.equal(silentBucketMin(59 * M), 55);
  });

  test('an hour and up buckets hourly', () => {
    assert.equal(silentBucketMin(61 * M), 60);
    assert.equal(silentBucketMin(16.5 * H), 960);
    assert.equal(silentBucketMin(48 * H), 2880);
  });
});

describe('gateToken', () => {
  const st = (o: PrActCacheEntry['state']): PrActCacheEntry['state'] => ({ pr: 1, ...o });

  test('terminal states first', () => {
    assert.equal(gateToken(st({ state: 'MERGED' })), 'merged');
    assert.equal(gateToken(st({ state: 'CLOSED' })), 'closed');
  });

  test('draft beats findings — it is not really blocked', () => {
    assert.equal(gateToken(st({ state: 'OPEN', isDraft: true, openThreads: 3 })), 'draft');
  });

  test('conflict beats blocked counters', () => {
    assert.equal(
      gateToken(st({ state: 'OPEN', mergeable: 'CONFLICTING', ciFailing: 1 })),
      'conflict'
    );
  });

  test('any failing signal is blocked', () => {
    assert.equal(gateToken(st({ state: 'OPEN', openThreads: 2 })), 'blocked');
    assert.equal(gateToken(st({ state: 'OPEN', ciFailing: 1 })), 'blocked');
    assert.equal(gateToken(st({ state: 'OPEN', sastPending: 1 })), 'blocked');
  });

  test('in-flight signals are pending', () => {
    assert.equal(gateToken(st({ state: 'OPEN', ciPending: 2 })), 'pending');
    assert.equal(gateToken(st({ state: 'OPEN', reviewersPending: 1 })), 'pending');
  });

  test('a clean open PR is ok', () => {
    assert.equal(gateToken(st({ state: 'OPEN' })), 'ok');
  });
});

describe('statusPrefix', () => {
  test('no tokens — no prefix (v1 label untouched)', () => {
    assert.equal(statusPrefix({}), '');
  });

  test('worker only', () => {
    assert.equal(statusPrefix({ worker: 'working' }), '[working] ');
  });

  test('full stack — the goal shape', () => {
    assert.equal(
      statusPrefix({ worker: 'silent16h', pr: 765, gate: 'blocked' }),
      '[silent16h·#765 blocked] '
    );
  });

  test('PR without gate stays bare', () => {
    assert.equal(statusPrefix({ pr: 765 }), '[#765] ');
  });
});

describe('agentTreePath', () => {
  test('registry absolute path wins over the name match', () => {
    const p = planes({
      registry: { 'mol-1': { worktree: TREE } },
      status: {
        dir: MAIN,
        worktrees: [
          { name: 'other', path: '/elsewhere' },
          { name: 'reg-tree', path: TREE },
        ],
        beads: { inProgress: [] },
        fleet: { maxConcurrent: 4, agents: [] },
        loop: { stallMin: 30, runs: [] },
      },
    });
    assert.equal(
      agentTreePath({ id: 'mol-1', backend: 'native', state: 'running', worktree: 'other' }, p),
      TREE
    );
  });

  test('name match falls back when the registry has no tree', () => {
    const p = withStatus(planes(), {
      worktrees: [{ name: 'the-tree', path: TREE }],
    });
    assert.equal(
      agentTreePath({ id: 'mol-1', backend: 'native', state: 'running', worktree: 'the-tree' }, p),
      TREE
    );
  });
});

describe('statusFor — worker token', () => {
  const run = (o: Record<string, unknown>) => ({
    beadId: 'bead-1',
    slug: 'bead-1',
    state: 'running',
    worktree: TREE,
    ...o,
  });

  test('silent run → bucketed token', () => {
    const p = withStatus(planes(), { loop: { stallMin: 30, runs: [run({ silentMs: 16.5 * H })] } });
    assert.equal(statusFor(TREE, undefined, p, []).worker, 'silent16h');
  });

  test('under the stall floor is just working', () => {
    const p = withStatus(planes(), { loop: { stallMin: 30, runs: [run({ silentMs: 10 * M })] } });
    assert.equal(statusFor(TREE, undefined, p, []).worker, 'working');
  });

  test('dead run → dead', () => {
    const p = withStatus(planes(), {
      loop: { stallMin: 30, runs: [run({ state: 'dead', silentMs: null })] },
    });
    assert.equal(statusFor(TREE, undefined, p, []).worker, 'dead');
  });

  test('a running fleet agent without a loop run is working', () => {
    const p = withStatus(planes(), {
      worktrees: [{ name: 'the-tree', path: TREE }],
      fleet: {
        maxConcurrent: 4,
        agents: [{ id: 'mol-1', backend: 'native', state: 'running', worktree: 'the-tree' }],
      },
    });
    assert.equal(statusFor(TREE, undefined, p, []).worker, 'working');
  });

  test('a running fleet agent beats a retained dead run — respawn is a worker', () => {
    const p = withStatus(planes(), {
      worktrees: [{ name: 'the-tree', path: TREE }],
      fleet: {
        maxConcurrent: 4,
        agents: [{ id: 'mol-1', backend: 'native', state: 'running', worktree: 'the-tree' }],
      },
      loop: { stallMin: 30, runs: [run({ state: 'dead', silentMs: null })] },
    });
    assert.equal(statusFor(TREE, undefined, p, []).worker, 'working');
  });

  test('nothing running → no worker token', () => {
    assert.equal(statusFor(TREE, undefined, planes(), []).worker, undefined);
  });
});

describe('statusFor — PR joins', () => {
  const act = (o: Partial<PrActCacheEntry['state']> = {}, fetchedAt = Date.now()) => [
    { fetchedAt, state: { pr: 765, ...o } },
  ];

  test('bead link supplies the PR number', () => {
    const p = withStatus(planes(), {
      beads: {
        inProgress: [{ id: 'bead-1', title: 'T', link: 'https://github.com/o/r/pull/765' }],
      },
    });
    assert.equal(statusFor(TREE, 'bead-1', p, []).pr, 765);
  });

  test('branch joins the act cache by headRef', () => {
    const p = withStatus(planes(), {
      worktrees: [{ name: 't', path: TREE, branch: 'work/bead-1' }],
    });
    const st = statusFor(TREE, 'bead-1', p, act({ headRef: 'work/bead-1', openThreads: 2 }));
    assert.equal(st.pr, 765);
    assert.equal(st.gate, 'blocked');
  });

  test('a stale cache entry is absent, not a verdict', () => {
    const p = withStatus(planes(), {
      worktrees: [{ name: 't', path: TREE, branch: 'work/bead-1' }],
    });
    const st = statusFor(
      TREE,
      'bead-1',
      p,
      act({ headRef: 'work/bead-1', openThreads: 9 }, Date.now() - 2 * H)
    );
    assert.equal(st.pr, undefined);
    assert.equal(st.gate, undefined);
  });

  test('link PR resolves the gate by number when headRef differs', () => {
    const p = withStatus(planes(), {
      beads: {
        inProgress: [{ id: 'bead-1', title: 'T', link: 'https://github.com/o/r/pull/765' }],
      },
    });
    const st = statusFor(TREE, 'bead-1', p, act({ headRef: 'whatever', ciPending: 1 }));
    assert.equal(st.pr, 765);
    assert.equal(st.gate, 'pending');
  });
});

describe('diffKey — new status inputs move the key', () => {
  test('silence inside a bucket does not churn the key', () => {
    const mk = (ms: number) =>
      withStatus(planes(), {
        loop: {
          stallMin: 30,
          runs: [{ beadId: 'b', slug: 'b', state: 'running', worktree: TREE, silentMs: ms }],
        },
      });
    assert.equal(diffKey(mk(10 * M)), diffKey(mk(11 * M)));
    assert.notEqual(diffKey(mk(59 * M)), diffKey(mk(61 * M)));
  });

  test('a vanished worktree moves the key — the reaper must see it', () => {
    const p = planes();
    const live = {
      ...p,
      worktrees: { ...p.worktrees, worktrees: [{ path: TREE, open_workspace_id: 'w1' }] },
    };
    const dead = {
      ...p,
      worktrees: {
        ...p.worktrees,
        worktrees: [{ path: join(TREE, 'no-such-dir'), open_workspace_id: 'w1' }],
      },
    };
    assert.notEqual(diffKey(live), diffKey(dead));
  });

  test('an act-state gate flip moves the key', () => {
    const mk = (ciFailing: number) => ({
      ...planes(),
      act: [{ fetchedAt: Date.now(), state: { pr: 1, ciFailing } }],
    });
    assert.notEqual(diffKey(mk(0)), diffKey(mk(1)));
  });

  test('a killed renderer pane moves the key', () => {
    const p = planes();
    assert.notEqual(
      diffKey({ ...p, rendererPanes: { pTail: true } }),
      diffKey({ ...p, rendererPanes: { pTail: false } })
    );
  });
});
