/** `loopPolicy` FSM tests — the lifecycle verbs over injected deps,
 *  no repo/backend/spawns (bro-u6fp5.1). Moved from
 *  `commands/loop.test.ts`: `wallWaitUntil`/`loopWatch` are policy
 *  internals now, and the member/queue describes drive the policy
 *  through a scripted `LoopDeps` — no CLI imports, no `process.exit`. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { ReviewFacade, TaskStore } from '@broject/core';
import { DEFAULT_LOOP_CONFIG, type LoopConfig, type LoopItem } from '@broject/loop';
import type { ReadyBead } from '../ready.ts';
import {
  freshLoopQueue,
  loopPolicy,
  loopWatch,
  wallWaitUntil,
  type LoopCtx,
  type LoopDeps,
  type LoopLane,
  type LoopMember,
} from './loop.ts';

// --- wallWaitUntil — the wall settle's wait clock (spec bro-36bhc) -------------

describe('wallWaitUntil — the provider wall wait (bro-36bhc)', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');

  test('a rate_limited death with a future reset waits the provider clock', () => {
    assert.equal(
      wallWaitUntil('rate_limited', '2026-10-20T12:15:00Z', now),
      Date.parse('2026-10-20T12:15:00Z')
    );
  });

  test('a stale reset still waits — on a floor that escalates per wall death, capped', () => {
    const stale = '2026-10-20T11:59:00Z';
    assert.equal(wallWaitUntil('rate_limited', stale, now), now + 30_000);
    assert.equal(wallWaitUntil('rate_limited', stale, now, 2), now + 60_000);
    assert.equal(wallWaitUntil('rate_limited', stale, now, 3), now + 120_000);
    // a provider lying about its reset every time can never spin the
    // loop back into the respawn-burn — the floor saturates at 15m
    assert.equal(wallWaitUntil('rate_limited', stale, now, 20), now + 15 * 60_000);
  });

  test('non-waitable causes and unusable resets are never a wait', () => {
    // quota/auth park — they are walls with no honest clock; a
    // rate_limited death whose provider reported no (or garbage)
    // reset is indefinite — the same park the blocked state gives it
    assert.equal(wallWaitUntil('quota', '2026-10-20T12:15:00Z', now), undefined);
    assert.equal(wallWaitUntil('auth', '2026-10-20T12:15:00Z', now), undefined);
    assert.equal(wallWaitUntil('crash', '2026-10-20T12:15:00Z', now), undefined);
    assert.equal(wallWaitUntil('rate_limited', undefined, now), undefined);
    assert.equal(wallWaitUntil('rate_limited', 'not-a-time', now), undefined);
    assert.equal(wallWaitUntil(undefined, '2026-10-20T12:15:00Z', now), undefined);
  });
});

describe('loopWatch — the member watch payload (bro-0aa87)', () => {
  test('claims merge+cleanup supervision and bounds the TTL to the item budget', () => {
    const w = loopWatch(7, '[#7](https://x/pull/7)', '/wt/bro--bro-x', DEFAULT_LOOP_CONFIG);
    assert.equal(w.pr, 7);
    assert.equal(w.merge, true);
    assert.equal(w.cleanup, true);
    assert.equal(w.workdir, '/wt/bro--bro-x');
    // (stall 45 + merge 45) × (fixRounds 3 + 1) — the worst-case item minutes
    assert.equal(w.timeoutMin, (45 + 45) * (3 + 1));
    const scaled = loopWatch(7, 'l', '/wt', { stallMin: 1, mergeTimeoutMin: 2, fixRounds: 0 });
    assert.equal(scaled.timeoutMin, 3);
  });
});

// --- the FSM over a scripted LoopDeps ----------------------------------------

const NOW = Date.parse('2026-10-20T12:00:00Z');

const bead = (id: string, over: Partial<ReadyBead> = {}): ReadyBead => ({
  id,
  title: `bead ${id}`,
  status: 'open',
  priority: 1,
  issue_type: 'task',
  created_at: '2026-10-20T00:00:00Z',
  ...over,
});

const item = (dir: string): LoopItem => ({
  branch: 'loop/bro-x',
  worktreeDir: dir,
  promptFile: join(dir, 'prompt.md'),
});

const member = (beads: ReadyBead[], dir: string, over: Partial<LoopMember> = {}): LoopMember => ({
  beads,
  item: item(dir),
  lane: {} as LoopLane,
  marker: null,
  since: NOW,
  rounds: 0,
  fetchErrors: 0,
  serviceErrors: 0,
  ...over,
});

interface World {
  ctx: LoopCtx;
  said: string[];
  errored: string[];
  updates: { id: string; patch: Record<string, unknown> }[];
  statuses: Map<string, string>;
  /** scripted claimCandidates answers — shifted per call, last repeats */
  candidates: { candidates: ReadyBead[]; foreign: number }[];
  root: string;
}

function world(over: Partial<LoopCtx> = {}, cfgOver: Partial<LoopConfig> = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'bro-loop-policy-'));
  const said: string[] = [];
  const errored: string[] = [];
  const updates: World['updates'] = [];
  const statuses = new Map<string, string>();
  const candidates: World['candidates'] = [];
  const tasks = {
    get: (id: string) => {
      const s = statuses.get(id);
      return s === undefined ? undefined : { id, status: s };
    },
    getMany: (ids: string[]) =>
      ids.filter(id => statuses.has(id)).map(id => ({ id, status: statuses.get(id) })),
    update: (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
    },
  } as unknown as TaskStore;
  const deps: LoopDeps = {
    tasks,
    rev: {} as ReviewFacade,
    stateCache: null,
    specHas: () => false,
    say: m => said.push(m),
    error: m => errored.push(m),
    out: () => {},
    emitJson: () => {},
    now: () => NOW,
    sleepMs: async () => {},
    reapRuns: () => {},
    beginRun: () => {},
    endRun: () => {},
    runLog: () => null,
    projectScope: () => ({ kind: 'test' }),
    claimCandidates: () => {
      const next = candidates.length > 1 ? candidates.shift() : candidates[0];
      return next ?? { candidates: [], foreign: 0 };
    },
    claimUpTo: () => [],
    laneFor: async () => ({}) as LoopLane,
    matrixHold: () => false,
    spawnWorker: async () => {},
    spawnTemplate: async () => 0,
    admitTemplate: () => ({ reservation: undefined, crossKind: [] }),
    providerWall: () => undefined,
    bootstrap: () => ({ status: 0, signal: null }),
    mergePr: async () => {},
    settleSessions: () => {},
    reportOutcome: async () => {},
    syncStackLines: () => [],
    stackSlotFor: () => undefined,
    stackLockPath: () => null,
    recordStackEdge: () => {},
    defaultBranch: () => 'main',
    worktrees: () => null,
    openFleetPrs: () => [],
    finishAudit: () => {},
  };
  const ctx: LoopCtx = {
    deps,
    cfg: { ...DEFAULT_LOOP_CONFIG, ...cfgOver },
    act: {},
    intervalS: 60,
    json: false,
    backend: 'beads',
    repo: 'o/r',
    root,
    tails: [],
    stage: 'test',
    mirrorPolicy: { labels: [], excludeLabels: [], types: [], specLinked: true },
    q: freshLoopQueue(),
    ...over,
  };
  return { ctx, said, errored, updates, statuses, candidates, root };
}

describe('loopPolicy.select — the claim pick', () => {
  test('a drained queue selects nothing', () => {
    const w = world();
    w.candidates.push({ candidates: [], foreign: 0 });
    assert.equal(loopPolicy.select(w.ctx), undefined);
  });

  test('a foreign-only remainder reports and selects nothing', () => {
    const w = world();
    w.candidates.push({ candidates: [], foreign: 3 });
    assert.equal(loopPolicy.select(w.ctx), undefined);
    assert.deepEqual(w.said, [
      'loop: 3 foreign-scope bead(s) remain — not claimable in this project',
    ]);
  });
});

describe('loopPolicy.onPark — the park transition', () => {
  test('defers open beads with the wake stamp and leaves parked', () => {
    const w = world({}, { parkedWakeMin: 30 });
    w.statuses.set('b1', 'in_progress');
    const m = member([bead('b1')], w.root);
    const result = loopPolicy.onPark(w.ctx, m, 'loop: test park', NOW + 60_000);
    assert.equal(result, 'parked');
    // noteBead + the defer patch — the wake stamp overrides the cooldown
    const defer = w.updates.find(u => u.id === 'b1' && 'defer' in u.patch);
    assert.ok(defer !== undefined, 'expected a defer update for b1');
    assert.equal(defer.patch.defer, new Date(NOW + 60_000).toISOString());
    assert.equal(defer.patch.assignee, '');
    assert.ok(w.updates.some(u => u.id === 'b1' && typeof u.patch.notes === 'string'));
  });

  test('the default cooldown derives the wake from parkedWakeMin', () => {
    const w = world({}, { parkedWakeMin: 45 });
    w.statuses.set('b1', 'in_progress');
    const m = member([bead('b1')], w.root);
    loopPolicy.onPark(w.ctx, m, 'loop: test park');
    const defer = w.updates.find(u => u.id === 'b1' && 'defer' in u.patch);
    assert.equal(defer?.patch.defer, new Date(NOW + 45 * 60_000).toISOString());
  });
});

describe('loopPolicy.serviceMember — cadence and wall waits', () => {
  test('a member inside its wall wait is kept and re-polls at expiry', async () => {
    const w = world();
    const until = NOW + 120_000;
    const m = member([bead('b1')], w.root, { wallWaitUntil: until });
    const v = await loopPolicy.serviceMember(w.ctx, m);
    assert.equal(v, 'kept');
    assert.equal(m.nextPollAt, until);
    assert.equal(m.wallWaitUntil, until);
  });

  test('a member inside nextPollAt backoff is kept without dispatch', async () => {
    const w = world();
    const m = member([bead('b1')], w.root, {
      pr: 7,
      nextPollAt: NOW + 30_000,
    });
    const v = await loopPolicy.serviceMember(w.ctx, m);
    assert.equal(v, 'kept');
    // the backoff stamp survives — the member re-polls AT it, not before
    assert.equal(m.nextPollAt, NOW + 30_000);
  });
});
