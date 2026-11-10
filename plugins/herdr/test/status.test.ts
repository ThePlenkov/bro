import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { silentBucketMin } from '../src/lib.ts';
import { diffKey, type Planes } from '../src/planes.ts';
import { agentTreePath } from '../src/status.ts';

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

describe('diffKey — status inputs move the key', () => {
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

  test('a killed renderer pane moves the key', () => {
    const p = planes();
    assert.notEqual(
      diffKey({ ...p, rendererPanes: { pTail: true } }),
      diffKey({ ...p, rendererPanes: { pTail: false } })
    );
  });
});
