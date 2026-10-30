import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  fleetStatusPath,
  nextSeq,
  parseFleetState,
  pruneFleetStatus,
  readFleetState,
  writeFleetState,
} from './fleet-state.ts';
import {
  type ActEntry,
  gateFrag,
  type HerdrPaneRow,
  labelFor,
  paneLed,
  prFor,
  prToken,
  projectFleet,
  projectTree,
  silentBucketMin,
  statusPaneLive,
  statusString,
  type TreeInput,
  type WorkerCand,
  workerState,
  workerToken,
} from './herdr-projector.ts';
import { PANE_AGENT, PANE_SOURCE } from './herdr-status-view.ts';

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
    agent: string;
    provider: string;
    model: string;
    acpSessionId: string;
    log: string;
    acp: boolean;
    events: string;
  }>
) => ({
  key: o.key ?? 'mol-1',
  live: o.live ?? false,
  ...(o.terminal !== undefined ? { terminal: o.terminal } : {}),
  silentMs: o.silentMs ?? null,
  ...(o.agent !== undefined ? { agent: o.agent } : {}),
  ...(o.provider !== undefined ? { provider: o.provider } : {}),
  ...(o.model !== undefined ? { model: o.model } : {}),
  ...(o.acpSessionId !== undefined ? { acpSessionId: o.acpSessionId } : {}),
  ...(o.log !== undefined ? { log: o.log } : {}),
  ...(o.acp === true ? { acp: true } : {}),
  ...(o.events !== undefined ? { events: o.events } : {}),
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
  });

  test('the label is the lane icon + worktree basename — state lives on the LED', () => {
    assert.equal(labelFor('/repo/trees/bro--bro-x1y2z', {}), '⚙️ bro--bro-x1y2z');
    assert.equal(labelFor('/repo/trees/work-1', {}), '⚙️ work-1');
    // 🤖 stays on the acp lane — a headless robot owns the session
    // pane (spec bro-l8wqu, operator decision)
    assert.equal(labelFor('/repo/trees/bot-1', { acp: true }), '🤖 bot-1');
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
    assert.equal(statusString(projection), 'lost·no PR');
  });

  test('armed session tree, nothing running → no PR in the token when unarmed would carry none', () => {
    const armed = projectTree(tree({ claim: 'b1', markerArmed: false }));
    assert.equal(statusString(armed.projection), 'no PR');
    const idle = projectTree(tree());
    assert.equal(statusString(idle.projection), '');
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

describe('the session owner — who the `bro: session` pane attaches (bro-nwl5g)', () => {
  test('a lone carrier lends its session fields to the projection', () => {
    const { projection } = projectTree(
      tree({
        agents: [
          agent({
            live: true,
            silentMs: M,
            provider: 'oc',
            model: 'm1',
            acpSessionId: 'ses_live',
            log: '/native-1.log',
          }),
        ],
      })
    );
    assert.deepEqual(
      {
        acpSessionId: projection.acpSessionId,
        provider: projection.provider,
        model: projection.model,
        log: projection.log,
      },
      { acpSessionId: 'ses_live', provider: 'oc', model: 'm1', log: '/native-1.log' }
    );
  });

  test('a live carrier outranks a newer dead one — watch the running agent', () => {
    const { projection } = projectTree(
      tree({
        agents: [
          agent({
            key: 'dead-newer',
            terminal: 'exited',
            acpSessionId: 'ses_dead',
            provider: 'oc',
            log: '/dead.log',
            at: NOW,
          }),
          agent({
            key: 'live-older',
            live: true,
            silentMs: M,
            acpSessionId: 'ses_live',
            provider: 'kilo',
            log: '/live.log',
            at: NOW - 10 * M,
          }),
        ],
      })
    );
    assert.equal(projection.acpSessionId, 'ses_live');
    assert.equal(projection.provider, 'kilo');
  });

  test('inside one liveness class the newest carrier wins', () => {
    const { projection } = projectTree(
      tree({
        agents: [
          agent({
            key: 'old',
            terminal: 'exited',
            acpSessionId: 'ses_old',
            log: '/old.log',
            at: NOW - 2 * H,
          }),
          agent({
            key: 'new',
            terminal: 'lost',
            log: '/new.log',
            at: NOW - H,
          }),
        ],
      })
    );
    assert.equal(projection.acpSessionId, undefined);
    assert.equal(projection.log, '/new.log');
  });

  test('a log-only agent still names the pane its stream', () => {
    const { projection } = projectTree(
      tree({
        agents: [agent({ key: 'cli', live: true, silentMs: M, log: '/cli.log' })],
      })
    );
    assert.equal(projection.acpSessionId, undefined);
    assert.equal(projection.log, '/cli.log');
  });

  test('no carrier — no session fields at all', () => {
    const { projection } = projectTree(tree({ agents: [agent({ live: true, silentMs: M })] }));
    assert.equal(projection.acpSessionId, undefined);
    assert.equal(projection.provider, undefined);
    assert.equal(projection.log, undefined);
  });

  test('an acp carrier lends the lane verdict + the events archive (spec bro-l8wqu)', () => {
    const { projection } = projectTree(
      tree({
        agents: [
          agent({
            live: true,
            silentMs: M,
            provider: 'oc',
            acpSessionId: 'ses_live',
            log: '/native-1.log',
            acp: true,
            events: '/repo/.git/bro/agents/a1.events.jsonl',
          }),
        ],
      })
    );
    assert.equal(projection.acp, true);
    assert.equal(projection.events, '/repo/.git/bro/agents/a1.events.jsonl');
  });

  test('a non-acp carrier lends neither lane nor events', () => {
    const { projection } = projectTree(
      tree({
        agents: [agent({ live: true, silentMs: M, provider: 'oc', log: '/cli.log' })],
      })
    );
    assert.equal(projection.acp, undefined);
    assert.equal(projection.events, undefined);
  });
});

describe('paneLed — the pane semantic-state mapping (bro-idsat)', () => {
  test('silent without a bucket falls back to bare working', () => {
    assert.deepEqual(paneLed({ state: 'silent' }), { state: 'working' });
  });

  test('working → working, silent → working + bucket message', () => {
    assert.deepEqual(paneLed({ state: 'working' }), { state: 'working' });
    assert.deepEqual(paneLed({ state: 'silent', silentMin: 45 }), {
      state: 'working',
      message: 'silent45m',
    });
    assert.deepEqual(paneLed({ state: 'silent', silentMin: 960 }), {
      state: 'working',
      message: 'silent16h',
    });
  });

  test('interrupted/lost → blocked carrying the cause word', () => {
    assert.deepEqual(paneLed({ state: 'interrupted' }), {
      state: 'blocked',
      message: 'interrupted',
    });
    assert.deepEqual(paneLed({ state: 'lost' }), { state: 'blocked', message: 'lost' });
  });

  test('exited/stopped → idle — the pane is a dashboard, never released', () => {
    assert.deepEqual(paneLed({ state: 'exited' }), { state: 'idle', message: 'exited' });
    assert.deepEqual(paneLed({ state: 'stopped' }), { state: 'idle', message: 'stopped' });
  });

  test('no worker verdict — armed reads unknown, unarmed reads idle', () => {
    assert.deepEqual(paneLed({ armed: true }), { state: 'unknown' });
    assert.deepEqual(paneLed({}), { state: 'idle' });
    assert.deepEqual(paneLed({ armed: false }), { state: 'idle' });
  });
});

describe('statusPaneLive — the backstop push gate', () => {
  const rows: HerdrPaneRow[] = [
    { pane_id: 'w1:p1' },
    { pane_id: 'w1:p2', agent: 'devin' },
    { pane_id: 'w1:p3', agent: PANE_AGENT },
    { pane_id: 'w1:p4', agent: PANE_SOURCE },
    { pane_id: 'w1:p5', agent: '' },
  ];

  test('an unbound recorded pane is pushable', () => {
    assert.equal(statusPaneLive(rows, 'w1:p1'), true);
  });

  test('a pane bound to bro-status or bro:fleet is pushable', () => {
    assert.equal(statusPaneLive(rows, 'w1:p3'), true);
    assert.equal(statusPaneLive(rows, 'w1:p4'), true);
    assert.equal(statusPaneLive(rows, 'w1:p5'), true);
  });

  test('a foreign detected agent protects the pane', () => {
    assert.equal(statusPaneLive(rows, 'w1:p2'), false);
  });

  test('a pane missing from the list is not pushable', () => {
    assert.equal(statusPaneLive(rows, 'w1:p9'), false);
  });
});

describe('projectFleet — no herdr, no writes, no throw', () => {
  test('unreachable herdr degrades to a quiet skip', () => {
    const prev = process.env.HERDR_BIN_PATH;
    process.env.HERDR_BIN_PATH = '/nonexistent/herdr';
    try {
      const r = projectFleet(mkdtempSync(join(tmpdir(), 'proj-')));
      assert.deepEqual(r, { reachable: false, workspaces: 0, writes: 0, files: 0, leds: 0 });
    } finally {
      if (prev === undefined) delete process.env.HERDR_BIN_PATH;
      else process.env.HERDR_BIN_PATH = prev;
    }
  });
});

/** A fake `herdr` for the projectFleet integration test — every argv
 *  lands in FAKE_HERDR_LOG (one JSON line each); `worktree list` and
 *  `workspace list` answer from FAKE_HERDR_SCENARIO; anything else is
 *  an empty success envelope. */
const FAKE_HERDR = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_HERDR_LOG) {
  fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + '\\n');
}
const s = JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_SCENARIO, 'utf8'));
const verb = args.slice(0, 2).join(' ');
if (verb === 'worktree list') {
  console.log(JSON.stringify({ result: { worktrees: s.worktrees ?? [] } }));
} else if (verb === 'workspace list') {
  console.log(JSON.stringify({ result: { workspaces: s.workspaces ?? [] } }));
} else if (verb === 'pane list') {
  const ws = args[args.indexOf('--workspace') + 1];
  console.log(
    JSON.stringify({
      result: { panes: (s.panes ?? []).filter(p => p.workspace_id === ws) },
    })
  );
} else {
  console.log(JSON.stringify({ result: {} }));
}
`;

/** Bind env keys for one call — the projector reads them per call, so
 *  a fixture only needs them inside its window. */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('projectFleet — a live pass over a fake herdr', () => {
  /** Root + a live claim marker — the cheap arm path: `.git/bro/work`
   *  inside the tree, ownerless and fresh (24h window). */
  const armedRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'proj-fleet-'));
    mkdirSync(join(root, '.git', 'bro'), { recursive: true });
    writeFileSync(join(root, '.git', 'bro', 'work'), 'session test\nb1\n');
    return root;
  };

  const callsOf = (log: string): string[][] =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as string[]);

  /** The `--seq` a call carried — per-source monotonic, so tests assert
   *  it numerically rather than against the pass instant. */
  const seqOf = (call: string[]): number => Number(call[call.indexOf('--seq') + 1]);

  /** One full pass over the fake herdr — scenario + plugin ledger in,
   *  result + the recorded call log out. The ledger scope for a
   *  repo-less root is sha1(root) (no common dir resolves). The log is
   *  truncated per pass so multi-pass tests see each tick's calls. */
  const fleetPass = (
    root: string,
    stateDir: string,
    f: { scenario: Record<string, unknown>; state: Record<string, unknown> },
    now = NOW
  ): { r: ReturnType<typeof projectFleet>; calls: string[][] } => {
    const fake = join(root, 'fake-herdr.js');
    const scenario = join(root, 'scenario.json');
    const log = join(root, 'calls.jsonl');
    writeFileSync(fake, FAKE_HERDR, { mode: 0o755 });
    writeFileSync(scenario, JSON.stringify(f.scenario));
    rmSync(log, { force: true });
    const scope = createHash('sha1').update(root).digest('hex').slice(0, 12);
    writeFileSync(join(stateDir, `state-${scope}.json`), JSON.stringify(f.state));
    const r = withEnv(
      {
        HERDR_BIN_PATH: fake,
        HERDR_PLUGIN_STATE_DIR: stateDir,
        FAKE_HERDR_SCENARIO: scenario,
        FAKE_HERDR_LOG: log,
      },
      () => projectFleet(root, now)
    );
    return { r, calls: callsOf(log) };
  };

  const stateDirOf = (): string => mkdtempSync(join(tmpdir(), 'proj-state-'));
  const plainRoot = (): string => mkdtempSync(join(tmpdir(), 'proj-fleet-'));

  /** A pane row in `pane list` — `agent` only when herdr detected one. */
  const pane = (id: string, ws: string, agent?: string): Record<string, unknown> => ({
    pane_id: id,
    workspace_id: ws,
    ...(agent !== undefined ? { agent } : {}),
  });
  /** The plugin's status-pane record for one tree → pane binding. */
  const statusesOf = (root: string, paneId: string, ws: string): Record<string, unknown> => ({
    [root]: { pane_id: paneId, workspace: ws, worktree: root },
  });

  /** The one-workspace fixture — scenario + plugin state for a managed
   *  worktree, with pane rows and the status-pane binding overlaid.
   *  The envelope lives here so the tests carry only unique data. */
  const statusFixture = (
    root: string,
    ws: string,
    o: { panes?: Record<string, unknown>[]; statuses?: Record<string, unknown> } = {}
  ): { scenario: Record<string, unknown>; state: Record<string, unknown> } => ({
    scenario: {
      worktrees: [{ path: root, open_workspace_id: ws }],
      workspaces: [{ workspace_id: ws, label: 'Old', tokens: {} }],
      ...(o.panes !== undefined ? { panes: o.panes } : {}),
    },
    state: {
      workspaces: { [root]: { ws, label: 'Old', managed: true } },
      ...(o.statuses !== undefined ? { statuses: o.statuses } : {}),
    },
  });

  test('a managed workspace gets its rename + metadata writes', () => {
    const root = plainRoot();
    const { r, calls } = fleetPass(root, stateDirOf(), {
      scenario: {
        worktrees: [{ path: root, open_workspace_id: 'w1' }],
        workspaces: [
          {
            workspace_id: 'w1',
            label: '[working·#1] Old Title',
            tokens: { status: 'old', 'bro.worker': 'stale' },
          },
        ],
      },
      state: {
        workspaces: { [root]: { ws: 'w1', label: '[working·#1] Old Title', managed: true } },
      },
    });
    assert.deepEqual(r, { reachable: true, workspaces: 1, writes: 2, files: 1, leds: 0 });
    const rename = calls.find(c => c.slice(0, 2).join(' ') === 'workspace rename');
    // the label is the lane icon + worktree basename — ⚙️ marks the
    // interactive lane (spec bro-l8wqu); the bead title survives on
    // the state file, not the sidebar row
    assert.deepEqual(rename?.slice(0, 4), ['workspace', 'rename', 'w1', `⚙️ ${basename(root)}`]);
    const meta = calls.find(c => c.slice(0, 2).join(' ') === 'workspace report-metadata');
    assert.ok(meta?.includes('--clear-token'));
    assert.ok(meta?.includes('status'));
    assert.ok(meta?.includes('bro.worker'));
    // and the state file the status pane renders landed under root
    const st = readFleetState(fleetStatusPath(root, root));
    assert.equal(st?.workspace, 'w1');
    assert.equal(st?.title, 'Old Title');
  });

  test('an acp session owner lands lane + events + the 🤖 label (spec bro-l8wqu)', () => {
    const root = mkdtempSync(join(tmpdir(), 'proj-acp-'));
    // the registry read needs a real git common dir — agentsHome and
    // agents.json both resolve through `git rev-parse --git-common-dir`
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, '.git', 'bro', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'bro.config.json'),
      JSON.stringify({ providers: { oc: { type: 'acp', command: 'opencode acp' } } })
    );
    writeFileSync(
      join(root, '.git', 'bro', 'agents.json'),
      JSON.stringify({
        'mol-1': {
          agentId: 'a1',
          backend: 'acp',
          worktree: root,
          provider: 'oc',
          acpSessionId: 'ses_1',
          log: '/a1.log',
          spawnedAt: new Date(NOW).toISOString(),
        },
      })
    );
    // a git root scopes the plugin ledger on the COMMON dir — the
    // repo-less fleetPass helper's sha1(root) file is a second scope
    // this repo never reads
    const stateDir = stateDirOf();
    const scope = createHash('sha1').update(join(root, '.git')).digest('hex').slice(0, 12);
    writeFileSync(
      join(stateDir, `state-${scope}.json`),
      JSON.stringify({ workspaces: { [root]: { ws: 'w1', label: 'old', managed: true } } })
    );
    const { calls } = fleetPass(root, stateDir, {
      scenario: {
        worktrees: [{ path: root, open_workspace_id: 'w1' }],
        workspaces: [{ workspace_id: 'w1', label: 'old' }],
      },
      state: {},
    });
    // the doc the session pane + the plugin's lane read consume
    const st = readFleetState(fleetStatusPath(join(root, '.git'), root));
    assert.equal(st?.lane, 'acp');
    assert.equal(st?.events, join(root, '.git', 'bro', 'agents', 'a1.events.jsonl'));
    assert.equal(st?.acpSessionId, 'ses_1');
    // and the workspace label keeps the robot marker on the acp lane
    const rename = calls.find(c => c.slice(0, 2).join(' ') === 'workspace rename');
    assert.deepEqual(rename?.slice(0, 4), ['workspace', 'rename', 'w1', `🤖 ${basename(root)}`]);
  });

  test('a user-owned workspace is never touched', () => {
    const root = plainRoot();
    const { r, calls } = fleetPass(root, stateDirOf(), {
      scenario: {
        worktrees: [{ path: root, open_workspace_id: 'wUser' }],
        workspaces: [{ workspace_id: 'wUser', label: 'mine' }],
      },
      // recorded but NOT managed — a workspace the user opened themselves
      state: { workspaces: { [root]: { ws: 'wUser', managed: false } } },
    });
    assert.deepEqual(r, { reachable: true, workspaces: 0, writes: 0, files: 0, leds: 0 });
    const flat = calls.flat().join(' ');
    assert.ok(!flat.includes('rename'));
    assert.ok(!flat.includes('report-metadata'));
    assert.ok(!flat.includes('report-agent'));
    assert.equal(readFleetState(fleetStatusPath(root, root)), undefined);
  });

  test('the state file carries the same verdict the label shows', () => {
    const root = armedRoot();
    const { r } = fleetPass(root, stateDirOf(), statusFixture(root, 'wF'));
    assert.equal(r.files, 1);
    const st = readFleetState(fleetStatusPath(root, root));
    assert.equal(st?.v, 1);
    assert.equal(st?.worktree, root);
    assert.equal(st?.workspace, 'wF');
    assert.equal(st?.status, 'no PR');
    assert.deepEqual(st?.led, { state: 'unknown' });
  });

  test('the backstop pushes to the recorded status pane — and only it', () => {
    const root = armedRoot();
    const { r, calls } = fleetPass(
      root,
      stateDirOf(),
      statusFixture(root, 'wB', {
        panes: [pane('wB:p1', 'wB'), pane('wB:p2', 'wB')],
        statuses: statusesOf(root, 'wB:p1', 'wB'),
      })
    );
    assert.equal(r.leds, 1);
    const report = calls.find(c => c.slice(0, 2).join(' ') === 'pane report-agent');
    assert.deepEqual(report?.slice(0, 7), [
      'pane',
      'report-agent',
      'wB:p1',
      '--source',
      'bro:fleet',
      '--agent',
      'bro-status',
    ]);
    assert.ok(report !== undefined && report[7] === '--seq' && seqOf(report) >= NOW * 1e3);
    assert.deepEqual(report?.slice(9), ['--state', 'unknown']);
    // never a release, never a report on the unrecorded pane
    assert.ok(!calls.some(c => c[1] === 'release-agent'));
    assert.ok(!calls.some(c => c.includes('wB:p2') && c[0] === 'pane' && c[1] !== 'list'));
  });

  test('a status pane bound to a foreign agent gets no push', () => {
    const root = armedRoot();
    const { r, calls } = fleetPass(
      root,
      stateDirOf(),
      statusFixture(root, 'wX', {
        panes: [pane('wX:p1', 'wX', 'devin')],
        statuses: statusesOf(root, 'wX:p1', 'wX'),
      })
    );
    assert.equal(r.leds, 0);
    assert.equal(r.files, 1);
    assert.ok(calls.some(c => c.slice(0, 2).join(' ') === 'pane list'));
    assert.ok(!calls.some(c => c[1] === 'report-agent'));
  });

  test('a status pane missing from pane list gets no push', () => {
    const root = armedRoot();
    const { r, calls } = fleetPass(
      root,
      stateDirOf(),
      statusFixture(root, 'wM', {
        panes: [pane('wM:p2', 'wM')],
        statuses: statusesOf(root, 'wM:p1', 'wM'),
      })
    );
    assert.equal(r.leds, 0);
    assert.ok(!calls.some(c => c[1] === 'report-agent'));
  });

  test('no status-pane record → the file still lands, pane list is never read', () => {
    const root = armedRoot();
    const { r, calls } = fleetPass(root, stateDirOf(), statusFixture(root, 'wN'));
    assert.equal(r.files, 1);
    assert.equal(r.leds, 0);
    assert.ok(!calls.some(c => c.slice(0, 2).join(' ').startsWith('pane ')));
  });

  test('an identical projection is a no-op write — the watch only fires on moves', () => {
    const root = armedRoot();
    const dir = stateDirOf();
    const f = statusFixture(root, 'wD');
    assert.equal(fleetPass(root, dir, f).r.files, 1);
    assert.equal(fleetPass(root, dir, f).r.files, 0);
  });

  test('a state file survives a blind ledger and is pruned once the tree is gone', () => {
    const root = armedRoot();
    const dir = stateDirOf();
    const path = fleetStatusPath(root, root);
    // seed as if a previous managed pass wrote it
    const first = fleetPass(root, dir, statusFixture(root, 'wP'));
    assert.equal(first.r.files, 1);
    assert.ok(readFleetState(path) !== undefined);
    // the ledger record vanishes but the workspace is still open —
    // the file stays: a blind read must not blank the pane
    const blind = fleetPass(root, dir, {
      scenario: {
        worktrees: [{ path: root, open_workspace_id: 'wP' }],
        workspaces: [{ workspace_id: 'wP', label: 'x' }],
      },
      state: { workspaces: { [root]: { ws: 'wP', managed: false } } },
    });
    assert.equal(blind.r.workspaces, 0);
    assert.ok(readFleetState(path) !== undefined);
    // the tree leaves herdr's list entirely → residue is swept
    const gone = fleetPass(root, dir, {
      scenario: { worktrees: [], workspaces: [] },
      state: { workspaces: {} },
    });
    assert.equal(gone.r.workspaces, 0);
    assert.equal(readFleetState(path), undefined);
  });

  test('the seq is monotonic per source — a clock regress cannot emit a stale one', () => {
    const root = armedRoot();
    const dir = stateDirOf();
    const f = statusFixture(root, 'wQ', {
      panes: [pane('wQ:p1', 'wQ')],
      statuses: statusesOf(root, 'wQ:p1', 'wQ'),
    });
    const seqOfReport = (calls: string[][]): number => {
      const c = calls.find(x => x[1] === 'report-agent');
      assert.ok(c !== undefined);
      return seqOf(c);
    };
    const a = seqOfReport(fleetPass(root, dir, f).calls);
    // wall clock jumps backward — the second seq must still outrank the first
    const b = seqOfReport(fleetPass(root, dir, f, NOW - 60_000).calls);
    assert.ok(b > a, `${b} should exceed ${a} after a clock regress`);
  });
});

describe('fleet-state — the state file contract', () => {
  const base = (): string => mkdtempSync(join(tmpdir(), 'fstate-'));
  const doc = (over: Record<string, unknown> = {}) => ({
    v: 1 as const,
    worktree: '/repo/trees/t1',
    workspace: 'w1',
    title: 't1',
    status: 'working·#7',
    led: { state: 'working' as const },
    ts: NOW,
    ...over,
  });

  test('the path is basename + realpath hash — same tree resolves identically', () => {
    const b = base();
    const tree = mkdtempSync(join(tmpdir(), 'fstate-tree-'));
    const a = fleetStatusPath(b, tree);
    assert.equal(a, fleetStatusPath(b, tree));
    // same basename, different realpath → different file
    assert.notEqual(fleetStatusPath(b, '/no/such/a'), fleetStatusPath(b, '/no/such2/a'));
    assert.ok(a.endsWith('.json'));
  });

  test('write → read round-trips; identical content is a no-op', () => {
    const b = base();
    const p = fleetStatusPath(b, '/repo/trees/t1');
    assert.equal(writeFleetState(p, doc()), true);
    assert.deepEqual(readFleetState(p), doc());
    assert.equal(writeFleetState(p, doc()), false);
    // a moved verdict rewrites
    assert.equal(writeFleetState(p, doc({ led: { state: 'idle' } })), true);
  });

  test('parse rejects torn or wrong-version documents', () => {
    assert.equal(parseFleetState('not json'), undefined);
    assert.equal(parseFleetState(JSON.stringify({ v: 2 })), undefined);
    assert.equal(parseFleetState(JSON.stringify(doc({ led: { state: 'spinning' } }))), undefined);
    assert.deepEqual(parseFleetState(JSON.stringify(doc())), doc());
  });

  test('session fields ride the doc — good values keep, bad values strip', () => {
    const withSession = doc({
      acpSessionId: 'ses_1',
      provider: 'oc',
      model: 'm1',
      log: '/l.log',
    });
    assert.deepEqual(parseFleetState(JSON.stringify(withSession)), withSession);
    const torn = doc({ acpSessionId: 42, provider: null, model: [], log: '/l.log' });
    const parsed = parseFleetState(JSON.stringify(torn));
    assert.equal(parsed?.acpSessionId, undefined);
    assert.equal(parsed?.provider, undefined);
    assert.equal(parsed?.model, undefined);
    assert.equal(parsed?.log, '/l.log');
    // a stripped malformed field must not invalidate the whole doc
    assert.equal(parsed?.workspace, 'w1');
  });

  test('prune keeps named files and drops the rest', () => {
    const b = base();
    const keep = fleetStatusPath(b, '/repo/trees/keep');
    const drop = fleetStatusPath(b, '/repo/trees/drop');
    writeFleetState(keep, doc());
    writeFleetState(drop, doc());
    pruneFleetStatus(b, new Set([keep]));
    assert.ok(readFleetState(keep) !== undefined);
    assert.equal(readFleetState(drop), undefined);
  });

  test('nextSeq is monotonic through a clock regress', () => {
    const a = nextSeq(NOW);
    const b = nextSeq(NOW - 60_000);
    assert.ok(b > a, `${b} should exceed ${a}`);
  });
});
