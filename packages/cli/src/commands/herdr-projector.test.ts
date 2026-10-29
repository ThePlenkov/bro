import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  type ActEntry,
  gateFrag,
  labelFor,
  prFor,
  prToken,
  projectFleet,
  projectTree,
  silentBucketMin,
  statusString,
  type TreeInput,
  type WorkerCand,
  workerState,
  workerToken,
} from './herdr-projector.ts';

const H = 3_600_000;
const M = 60_000;
const NOW = Date.now();

const run = (
  o: Partial<{ silentMs: number | null; state: string; at: number; beadId: string }>
) => ({
  state: (o.state ?? 'running') as 'running' | 'dead',
  ...(o.beadId !== undefined ? { beadId: o.beadId } : {}),
  silentMs: o.silentMs ?? null,
  at: o.at ?? NOW,
});

const agent = (
  o: Partial<{
    live: boolean;
    terminal: 'exited' | 'interrupted' | 'lost' | 'stopped';
    silentMs: number | null;
    at: number;
    key: string;
  }>
) => ({
  key: o.key ?? 'mol-1',
  live: o.live ?? false,
  ...(o.terminal !== undefined ? { terminal: o.terminal } : {}),
  silentMs: o.silentMs ?? null,
  at: o.at ?? NOW,
});

const tree = (over: Partial<TreeInput> = {}): TreeInput => ({
  path: '/repo/trees/work-1',
  markerArmed: false,
  runs: [],
  agents: [],
  beads: [],
  act: [],
  now: NOW,
  stallMin: 30,
  ...over,
});

describe('workerState — the classifier matrix', () => {
  const runCand = (o: { live: boolean; silentMs?: number | null; at?: number }): WorkerCand => ({
    run: true,
    live: o.live,
    silentMs: o.silentMs ?? null,
    ...(o.live ? {} : { terminal: 'lost' as const }),
    at: o.at ?? NOW,
  });

  test('live run, fresh output → working', () => {
    assert.deepEqual(workerState([runCand({ live: true, silentMs: 5 * M })], 30), {
      state: 'working',
    });
  });

  test('live run silent past the stall window → silent bucket', () => {
    assert.deepEqual(workerState([runCand({ live: true, silentMs: 16.5 * H })], 30), {
      state: 'silent',
      silentMin: 960,
    });
    assert.deepEqual(workerState([runCand({ live: true, silentMs: 45 * M })], 30), {
      state: 'silent',
      silentMin: 45,
    });
  });

  test('silent under the stall floor → working', () => {
    assert.equal(workerState([runCand({ live: true, silentMs: 10 * M })], 30).state, 'working');
  });

  test('stallMin <= 0 disables silence — always working', () => {
    assert.equal(workerState([runCand({ live: true, silentMs: 900 * M })], 0).state, 'working');
  });

  test('dead run, no agent → lost', () => {
    assert.equal(workerState([runCand({ live: false })], 30).state, 'lost');
  });

  test('live run wins over a dead record (the respawn edge)', () => {
    const cands = [
      runCand({ live: false, at: NOW - 10 * M }),
      runCand({ live: true, silentMs: 1 * M, at: NOW }),
      { run: false, live: false, terminal: 'exited' as const, silentMs: null, at: NOW - M },
    ];
    assert.equal(workerState(cands, 30).state, 'working');
  });

  test('a live agent beats a dead run — respawned worker, not a corpse', () => {
    const cands = [runCand({ live: false }), { run: false, live: true, silentMs: 2 * M, at: NOW }];
    assert.equal(workerState(cands, 30).state, 'working');
  });

  test('a silent live agent buckets like a run — detached workers get LEDs', () => {
    const cands = [{ run: false, live: true, silentMs: 16.5 * H, at: NOW }];
    assert.deepEqual(workerState(cands, 30), { state: 'silent', silentMin: 960 });
  });

  test('live run outranks a co-resident live agent', () => {
    const cands = [
      { run: false, live: true, silentMs: 1 * M, at: NOW },
      runCand({ live: true, silentMs: 50 * M }),
    ];
    assert.deepEqual(workerState(cands, 30), { state: 'silent', silentMin: 50 });
  });

  test('no live → newest terminal record decides', () => {
    const cands = [
      { run: true, live: false, terminal: 'lost' as const, silentMs: null, at: NOW - 3 * H },
      { run: false, live: false, terminal: 'exited' as const, silentMs: null, at: NOW - M },
    ];
    assert.equal(workerState(cands, 30).state, 'exited');
    cands[1]!.at = NOW - 4 * H;
    assert.equal(workerState(cands, 30).state, 'lost');
  });

  test('stopped and interrupted are their own verdicts', () => {
    assert.equal(
      workerState([{ run: false, live: false, terminal: 'stopped', silentMs: null, at: NOW }], 30)
        .state,
      'stopped'
    );
    assert.equal(
      workerState(
        [{ run: false, live: false, terminal: 'interrupted', silentMs: null, at: NOW }],
        30
      ).state,
      'interrupted'
    );
  });

  test('nothing running → no verdict', () => {
    assert.deepEqual(workerState([], 30), {});
  });
});

describe('silentBucketMin', () => {
  test('5m steps under an hour, hourly above', () => {
    assert.equal(silentBucketMin(4 * M), 0);
    assert.equal(silentBucketMin(59 * M), 55);
    assert.equal(silentBucketMin(61 * M), 60);
    assert.equal(silentBucketMin(16.5 * H), 960);
    assert.equal(silentBucketMin(null), null);
  });
});

describe('gateFrag', () => {
  const st = (o: Record<string, unknown>) => ({ pr: 1, ...o });

  test('settled states first', () => {
    assert.equal(gateFrag(st({ state: 'MERGED' })), 'merged');
    assert.equal(gateFrag(st({ state: 'CLOSED' })), 'closed');
  });

  test('draft short-circuits findings', () => {
    assert.equal(gateFrag(st({ state: 'OPEN', isDraft: true, openThreads: 3 })), 'draft');
  });

  test('counts render compactly, conflicts last', () => {
    assert.equal(
      gateFrag(
        st({
          state: 'OPEN',
          openThreads: 4,
          ciFailing: 3,
          sastPending: 6,
          mergeable: 'CONFLICTING',
        })
      ),
      '4t/3f/6sast/conflicts'
    );
    assert.equal(gateFrag(st({ state: 'OPEN', ciFailing: 1 })), '1f');
    assert.equal(gateFrag(st({ state: 'OPEN', mergeable: 'CONFLICTING' })), 'conflicts');
  });

  test('only in-flight → pending; clean → ok', () => {
    assert.equal(gateFrag(st({ state: 'OPEN', ciPending: 2 })), 'pending');
    assert.equal(gateFrag(st({ state: 'OPEN', reviewersPending: 1 })), 'pending');
    assert.equal(gateFrag(st({ state: 'OPEN' })), 'ok');
  });
});

describe('prFor — the orthogonal PR layer', () => {
  const act = (o: Partial<ActEntry['state']> = {}, fetchedAt = NOW): ActEntry[] => [
    { fetchedAt, state: { pr: 765, ...o } },
  ];
  const beads = [{ id: 'b1', link: 'https://github.com/o/r/pull/765' }];

  test('bead link supplies the number without a cache entry', () => {
    assert.deepEqual(prFor(undefined, 'b1', beads, [], NOW), { pr: 765 });
  });

  test('branch joins the act cache by headRef', () => {
    const r = prFor('work/b1', 'b1', [], act({ headRef: 'work/b1', openThreads: 2 }), NOW);
    assert.deepEqual(r, { pr: 765, gate: '2t' });
  });

  test('link PR resolves the gate by number when headRef differs', () => {
    const r = prFor(undefined, 'b1', beads, act({ headRef: 'other', ciPending: 1 }), NOW);
    assert.deepEqual(r, { pr: 765, gate: 'pending' });
  });

  test('a stale cache entry is absent, not a verdict', () => {
    assert.deepEqual(
      prFor('work/b1', 'b1', [], act({ headRef: 'work/b1', openThreads: 9 }, NOW - 2 * H), NOW),
      {}
    );
  });

  test('no bead and no branch match → nothing', () => {
    assert.deepEqual(prFor(undefined, undefined, [], [], NOW), {});
  });
});

describe('rendering — label + status token', () => {
  test('worker token formats the bucket', () => {
    assert.equal(workerToken({ state: 'silent', silentMin: 45 }), 'silent45m');
    assert.equal(workerToken({ state: 'silent', silentMin: 960 }), 'silent16h');
    assert.equal(workerToken({ state: 'working' }), 'working');
    assert.equal(workerToken({ state: 'lost' }), 'lost');
  });

  test('pr token carries the gate fragment', () => {
    assert.equal(prToken({ pr: 765, gate: '4t/3f' }), '#765 4t/3f');
    assert.equal(prToken({ pr: 765 }), '#765');
    assert.equal(prToken({ state: 'lost' }), 'no PR');
    assert.equal(prToken({ armed: true }), 'no PR');
    assert.equal(prToken({}), undefined);
  });

  test('the full stack — the goal shape', () => {
    const p = { state: 'silent' as const, silentMin: 960, pr: 765, gate: '4t/3f/6sast/conflicts' };
    assert.equal(statusString(p), 'silent16h·#765 4t/3f/6sast/conflicts');
    assert.equal(labelFor(p, 'Ship it'), '[silent16h·#765 4t/3f/6sast/conflicts] Ship it');
  });

  test('an idle tree carries no bracket', () => {
    assert.equal(labelFor({}, 'Title'), 'Title');
  });
});

describe('projectTree — end to end over injected planes', () => {
  test('crashed loop run → [lost·no PR]', () => {
    const { projection, title } = projectTree(
      tree({
        runs: [run({ state: 'dead', at: NOW - H, beadId: 'b1' })],
        beads: [{ id: 'b1', title: 'Fix it' }],
      })
    );
    assert.equal(title, 'Fix it');
    assert.equal(projection.state, 'lost');
    assert.equal(labelFor(projection, title), '[lost·no PR] Fix it');
  });

  test('armed session tree, nothing running → [no PR] when unarmed would carry none', () => {
    const armed = projectTree(tree({ claim: 'b1', markerArmed: false }));
    assert.equal(labelFor(armed.projection, armed.title), '[no PR] work-1');
    const idle = projectTree(tree());
    assert.equal(labelFor(idle.projection, idle.title), 'work-1');
  });

  test('live run + fresh act entry → silent bucket + PR fragment', () => {
    const { projection } = projectTree(
      tree({
        branch: 'work/b1',
        runs: [run({ silentMs: 16.5 * H, beadId: 'b1' })],
        act: [
          {
            fetchedAt: NOW,
            state: { pr: 765, headRef: 'work/b1', state: 'OPEN', ciFailing: 1 },
          },
        ],
      })
    );
    assert.equal(statusString(projection), 'silent16h·#765 1f');
  });

  test('agent stopped beats an older dead run', () => {
    const { projection } = projectTree(
      tree({
        runs: [run({ state: 'dead', at: NOW - 3 * H })],
        agents: [agent({ terminal: 'stopped', at: NOW - M })],
      })
    );
    assert.equal(projection.state, 'stopped');
  });
});

describe('projectFleet — no herdr, no writes, no throw', () => {
  test('unreachable herdr degrades to a quiet skip', () => {
    const prev = process.env.HERDR_BIN_PATH;
    process.env.HERDR_BIN_PATH = '/nonexistent/herdr';
    try {
      const r = projectFleet(mkdtempSync(join(tmpdir(), 'proj-')));
      assert.deepEqual(r, { reachable: false, workspaces: 0, writes: 0 });
    } finally {
      if (prev === undefined) delete process.env.HERDR_BIN_PATH;
      else process.env.HERDR_BIN_PATH = prev;
    }
  });
});
