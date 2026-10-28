import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readAgentRegistry,
  scrubEnv,
  sessionPlane,
  SpawnError,
  AgentNotFound,
  testGit,
  type AgentConnector,
} from '@broject/core';
import {
  agentConnectorNames,
  fleetOccupancyFor,
  makeCopilotConnector,
  type AgentConnectorEnv,
} from './agent-connectors.ts';
import { copilotCountFile } from './session-planes/copilot.ts';
import { initRepo, installFakeBd, readBeads } from './commands/testrepo.ts';
import { clearExternalPlanes } from '@broject/core';

// real host planes would flake spawn tests — fixtures opt out via
// spawn.externalBlock; the registry clear is the belt
clearExternalPlanes();

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv());

/** gh shim — the REST agent-task surface the connector speaks, backed
 *  by a JSON store at $FAKE_GH_DB ({tasks, prs, cancelledRuns, seq}).
 *  FAKE_GH_FAIL lists argv substrings that must exit 1 (the degradation
 *  probe); FAKE_GH_NOCANCEL makes run-cancel a no-op (the surviving-
 *  session probe); FAKE_GH_STATE pins the state a created task reports. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const fails = (process.env.FAKE_GH_FAIL ?? '').split(',').filter(Boolean)
if (fails.some((f) => argv.join(' ').includes(f))) { console.error('fake gh failure'); process.exit(1) }
if (argv[0] !== 'api') { console.error('unhandled: ' + argv.join(' ')); process.exit(1) }
const DB = process.env.FAKE_GH_DB
const load = () => JSON.parse(fs.readFileSync(DB, 'utf8'))
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db))
let method = 'GET', endpoint = '', input
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-X' || a === '--method') { method = argv[++i] }
  else if (a === '--input') { input = fs.readFileSync(argv[++i], 'utf8') }
  else if (a === '-F' || a === '-f' || a === '--raw-field' || a === '--field') { i++ }
  else if (!a.startsWith('-')) { endpoint = a }
}
const [p, qs] = endpoint.split('?')
const params = new URLSearchParams(qs ?? '')
const segs = p.split('/')
const db = load()
db.prs ??= []; db.cancelledRuns ??= []; db.tasks ??= []
// POST /agents/repos/{o}/{r}/tasks — create
if (method === 'POST' && segs[0] === 'agents' && segs[1] === 'repos' && segs[4] === 'tasks') {
  const body = JSON.parse(input ?? '{}')
  const n = db.seq++
  const t = {
    id: 'task-' + n,
    state: process.env.FAKE_GH_STATE ?? 'queued',
    repo: segs[2] + '/' + segs[3],
    artifacts: [
      { type: 'branch', data: { head_ref: 'copilot/fx-' + n, base_ref: body.base_ref ?? 'main' } },
      ...(body.create_pull_request ? [{ type: 'pull', data: { id: 500 + n } }] : []),
    ],
    sessions: [{ id: 'sess-' + n, state: 'queued', workflow_run_id: 700 + n, head_ref: 'copilot/fx-' + n, created_at: '2026-01-01T00:00:0' + n + 'Z' }],
    prompt: body.prompt,
  }
  db.tasks.push(t); save(db)
  console.log(JSON.stringify(t)); process.exit(0)
}
// GET /agents/tasks?state=a,b — the filtered live listing (paginated)
if (segs[0] === 'agents' && segs[1] === 'tasks' && segs.length === 2) {
  const states = (params.get('state') ?? '').split(',').filter(Boolean)
  const tasks = states.length > 0 ? db.tasks.filter((t) => states.includes(t.state)) : db.tasks
  const per = Number(params.get('per_page') ?? '30')
  const page = Number(params.get('page') ?? '1')
  console.log(JSON.stringify({ tasks: tasks.slice((page - 1) * per, page * per) })); process.exit(0)
}
// GET /agents/tasks/{id}
if (segs[0] === 'agents' && segs[1] === 'tasks' && segs.length === 3) {
  const t = db.tasks.find((x) => x.id === segs[2])
  if (!t) { console.error('Not Found'); process.exit(1) }
  console.log(JSON.stringify(t)); process.exit(0)
}
// GET /repos/{o}/{r}/pulls?head=owner:ref
if (segs[0] === 'repos' && segs[3] === 'pulls') {
  const ref = (params.get('head') ?? '').split(':').slice(1).join(':')
  const rows = db.prs.filter((x) => x.head_ref === ref)
    .map((x) => ({ number: x.number, html_url: 'https://github.com/' + segs[1] + '/' + segs[2] + '/pull/' + x.number }))
  console.log(JSON.stringify(rows)); process.exit(0)
}
// POST /repos/{o}/{r}/actions/runs/{id}/cancel
if (method === 'POST' && segs[0] === 'repos' && segs[3] === 'actions' && segs[4] === 'runs' && segs[6] === 'cancel') {
  const runId = Number(segs[5])
  db.cancelledRuns.push(runId)
  if (!process.env.FAKE_GH_NOCANCEL) {
    for (const t of db.tasks) {
      for (const s of t.sessions ?? []) {
        if (s.workflow_run_id === runId) { t.state = 'cancelled'; s.state = 'cancelled' }
      }
    }
  }
  save(db); process.exit(0)
}
console.error('unhandled: ' + argv.join(' ')); process.exit(1)
`;

interface GhDb {
  tasks: {
    id: string;
    state: string;
    repo: string;
    prompt?: string;
    artifacts?: { type: string; data?: { head_ref?: string; base_ref?: string; id?: number } }[];
    sessions?: {
      id: string;
      state: string;
      workflow_run_id?: number;
      head_ref?: string;
      created_at?: string;
    }[];
  }[];
  prs: { number: number; head_ref: string }[];
  cancelledRuns: number[];
  seq: number;
}

interface Fixture {
  root: string;
  main: string;
  beadsDir: string;
  ghDb: string;
  env: AgentConnectorEnv;
  prevPath: string;
  rows(): Array<Record<string, unknown>>;
  gh(): GhDb;
  saveGh(db: GhDb): void;
}

function fixture(
  rows: Array<Record<string, unknown>>,
  knobs: Record<string, unknown> = { repo: 'octo/repo' },
  ghSeed: Partial<GhDb> = {}
): Fixture {
  const { root, main } = initRepo('bro-cpconn-');
  // the shared fake bd — the claim store lives at <root>/beads.json
  // under FAKE_BD_DB; spec.beadsDir is the same dir the connector pins
  const { binDir, db } = installFakeBd(root, rows);
  const beadsDir = root;
  writeFileSync(join(binDir, 'gh'), FAKE_GH);
  chmodSync(join(binDir, 'gh'), 0o755);
  const ghDb = join(root, 'gh.json');
  writeFileSync(ghDb, JSON.stringify({ tasks: [], prs: [], cancelledRuns: [], seq: 1, ...ghSeed }));
  const prevPath = process.env.PATH ?? '';
  process.env.PATH = `${binDir}:${prevPath}`;
  process.env.FAKE_GH_DB = ghDb;
  process.env.FAKE_BD_DB = db;
  return {
    root,
    main,
    beadsDir,
    ghDb,
    env: {
      agents: { copilot: { ...knobs } },
      connectors: {},
      spawn: { externalBlock: false, externalIdleSec: 480 },
    },
    prevPath,
    rows: () => readBeads(db),
    gh: () => JSON.parse(readFileSync(ghDb, 'utf8')),
    saveGh: d => writeFileSync(ghDb, JSON.stringify(d)),
  };
}

function cleanup(fx: Fixture): void {
  process.env.PATH = fx.prevPath;
  delete process.env.FAKE_GH_DB;
  delete process.env.FAKE_GH_FAIL;
  delete process.env.FAKE_GH_NOCANCEL;
  delete process.env.FAKE_GH_STATE;
  delete process.env.FAKE_BD_DB;
  rmSync(fx.root, { recursive: true, force: true });
}

const SPEC = (main: string, beadsDir: string, molStep: string) => ({
  molStep,
  repoRoot: main,
  beadsDir,
  prompt: 'do the work',
});

type SpawnArg = Parameters<AgentConnector['spawn']>[0];

/** conn + one dispatched task + a mutator for the fake store's task
 *  state — the prelude nearly every live-task test shares. */
const spawnedTask = async (fx: Fixture) => {
  const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
  const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'));
  const setState = (state: string) => {
    const db = fx.gh();
    db.tasks[0]!.state = state;
    fx.saveGh(db);
  };
  return { conn, info, setState };
};

/** A spawn that must throw — returns the SpawnError it threw. */
const spawnErr = async (conn: AgentConnector, spec: SpawnArg): Promise<SpawnError> => {
  const err = await conn
    .spawn(spec)
    .then(() => null)
    .catch(e => e);
  assert.ok(err instanceof SpawnError, `expected SpawnError, got ${err}`);
  return err;
};

/** The armed-quota prelude every plane test shares — returns the
 *  reservations dir the knobs now point at. */
const planeSlots = (fx: Fixture): string => {
  const resDir = join(fx.root, 'slots');
  fx.env.agents['copilot']!['reservationsDir'] = resDir;
  return resDir;
};

const readCount = (resDir: string): { at: number; count: number; ids: string[] } =>
  JSON.parse(readFileSync(copilotCountFile(resDir), 'utf8'));

describe('copilot connector', () => {
  test("spawn claims the bead on the task's behalf, then dispatches and pins taskId", async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'));
      assert.equal(info.backend, 'copilot');
      assert.equal(info.state, 'spawned'); // queued — dispatched, not yet running
      // the claim landed BEFORE the task existed — on-behalf claim is
      // the whole point of the connector (the runner can't reach dolt)
      assert.equal(fx.rows()[0]!.status, 'in_progress');
      // the remote handle pins into the registry
      const entry = readAgentRegistry(fx.main)['fx-1']!;
      assert.equal(entry.agentId, info.id);
      assert.equal(entry.backend, 'copilot');
      assert.equal(entry.taskId, 'task-1');
      assert.equal(entry.taskRepo, 'octo/repo');
      assert.equal(entry.taskState, 'queued');
      assert.equal(entry.branch, 'copilot/fx-1');
      // the dispatch body rode a file in the agents home — prompt never argv
      const ghdb = fx.gh();
      assert.equal(ghdb.tasks[0]!.repo, 'octo/repo');
      assert.equal(ghdb.tasks[0]!.prompt, 'do the work');
      assert.ok(existsSync(join(fx.main, '.git', 'bro', 'agents', `${info.id}.task.json`)));
    } finally {
      cleanup(fx);
    }
  });

  test('no repo target is a config error naming agents.copilot.repo', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], {});
    try {
      const err = await spawnErr(
        makeCopilotConnector({ dir: fx.main }, fx.env),
        SPEC(fx.main, fx.beadsDir, 'fx-1')
      );
      assert.equal(err.kind, 'config');
      assert.match(String(err), /agents\.copilot\.repo/);
      // refused before the claim — the bead is still open
      assert.equal(fx.rows()[0]!.status, 'open');
    } finally {
      cleanup(fx);
    }
  });

  test('the origin remote supplies the dispatch target', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], {});
    try {
      testGit(['-C', fx.main, 'remote', 'add', 'origin', 'git@github.com:octo/origin-repo.git']);
      const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
      await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'));
      assert.equal(readAgentRegistry(fx.main)['fx-1']!.taskRepo, 'octo/origin-repo');
    } finally {
      cleanup(fx);
    }
  });

  test('an enabled-only failure names the coding-agent prerequisite', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      process.env.FAKE_GH_FAIL = 'agents/repos';
      const err = await spawnErr(
        makeCopilotConnector({ dir: fx.main }, fx.env),
        SPEC(fx.main, fx.beadsDir, 'fx-1')
      );
      assert.equal(err.kind, 'unavailable');
      assert.match(String(err), /Copilot coding agent enabled/);
      // the claim+entry stand (respawn-able) with the failure recorded
      const entry = readAgentRegistry(fx.main)['fx-1']!;
      assert.match(String(entry.spawnError), /Copilot coding agent/);
      assert.equal(fx.rows()[0]!.status, 'in_progress');
    } finally {
      cleanup(fx);
    }
  });

  test('a live remote task refuses a second spawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
      await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'));
      await assert.rejects(conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1')), /live agent/);
    } finally {
      cleanup(fx);
    }
  });

  test('queued reads spawned; in_progress reads running', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const { conn, info, setState } = await spawnedTask(fx);
      assert.equal((await conn.status(info.id)).state, 'spawned');
      setState('in_progress');
      assert.equal((await conn.status(info.id)).state, 'running');
    } finally {
      cleanup(fx);
    }
  });

  test('terminal states harvest the exit record: completed → exited/ok, cancelled → stopped', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const { conn, info, setState } = await spawnedTask(fx);
      setState('completed');
      assert.equal((await conn.status(info.id)).state, 'exited');
      let entry = readAgentRegistry(fx.main)['fx-1']!;
      assert.equal(entry.exitStatus, 0);
      assert.equal(entry.cause, 'ok');
      setState('cancelled');
      assert.equal((await conn.status(info.id)).state, 'stopped');
      entry = readAgentRegistry(fx.main)['fx-1']!;
      assert.equal(entry.stopped, true);
    } finally {
      cleanup(fx);
    }
  });

  test('a failed task classifies the session error and resolves the PR', async () => {
    const fx = fixture(
      [{ id: 'fx-1', status: 'open' }],
      { repo: 'octo/repo' },
      { prs: [{ number: 42, head_ref: 'copilot/fx-1' }] }
    );
    try {
      const { conn, info, setState } = await spawnedTask(fx);
      setState('failed');
      const db = fx.gh();
      db.tasks[0]!.sessions![0]!.state = 'failed';
      (db.tasks[0]!.sessions![0] as { error?: { message: string } }).error = {
        message: 'rate limit exceeded — wait for reset',
      };
      fx.saveGh(db);
      const agent = (await conn.list()).agents[0]!;
      assert.equal(agent.state, 'blocked'); // rate_limited reads blocked while the wall holds
      const entry = readAgentRegistry(fx.main)['fx-1']!;
      assert.equal(entry.exitStatus, 1);
      assert.equal(entry.cause, 'rate_limited');
      // the pull artifact resolved the PR and pinned the session handles
      assert.equal(entry.pr, 42);
      assert.match(String(entry.prUrl), /\/pull\/42$/);
      assert.equal(entry.sessionId, 'sess-1');
      assert.match(String(entry.sessionUrl), /pull\/42\/agent-sessions\/sess-1$/);
      assert.match(String(entry.attach), /gh agent-task view sess-1 --log --follow/);
      assert.match(String(agent.log), /agent-sessions\/sess-1$/);
      assert.ok(info.id !== undefined);
    } finally {
      cleanup(fx);
    }
  });

  test('an API failure degrades the list — agents read spawned, never lost', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const { conn, info } = await spawnedTask(fx);
      process.env.FAKE_GH_FAIL = 'agents/tasks';
      const l = await conn.list();
      assert.ok(l.degraded !== undefined);
      assert.equal(l.agents[0]!.state, 'spawned');
      assert.equal((await conn.status(info.id)).state, 'spawned');
    } finally {
      cleanup(fx);
    }
  });

  test('an unrecognised remote state degrades — preview drift is not a corpse', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const { conn, setState } = await spawnedTask(fx);
      setState('paused'); // a state this build predates
      const l = await conn.list();
      assert.match(String(l.degraded), /unrecognised task state/);
      assert.equal(l.agents[0]!.state, 'spawned');
    } finally {
      cleanup(fx);
    }
  });

  test('stop cancels the backing Actions run, then records stopped', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const { conn, info, setState } = await spawnedTask(fx);
      setState('in_progress');
      await conn.stop(info.id);
      assert.deepEqual(fx.gh().cancelledRuns, [701]);
      assert.equal(readAgentRegistry(fx.main)['fx-1']!.stopped, true);
      // the remote reported cancelled — the next read is 'stopped', not live
      assert.equal((await conn.status(info.id)).state, 'stopped');
      await conn.stop(info.id); // idempotent
      await conn.stop('copilot-deadbeef'); // unknown id is a no-op
    } finally {
      cleanup(fx);
    }
  });

  test('a surviving session is reported, not hidden — stopped still records', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      process.env.FAKE_GH_NOCANCEL = '1';
      const { conn, info, setState } = await spawnedTask(fx);
      setState('in_progress');
      const warns: string[] = [];
      const orig = console.error;
      console.error = (m: unknown) => warns.push(String(m));
      try {
        await conn.stop(info.id);
      } finally {
        console.error = orig;
      }
      assert.ok(
        warns.some(w => /still live/.test(w)),
        warns.join('\n')
      );
      assert.equal(readAgentRegistry(fx.main)['fx-1']!.stopped, true);
    } finally {
      cleanup(fx);
    }
  });

  test('respawn after a terminal task mints a new remote task on the same agentId', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const { conn, info: first, setState } = await spawnedTask(fx);
      setState('completed');
      await conn.list(); // harvest the death so the respawn is legal
      const second = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'));
      assert.equal(second.id, first.id);
      const entry = readAgentRegistry(fx.main)['fx-1']!;
      assert.equal(entry.taskId, 'task-2');
      // the previous run's remote handles are gone — exitStatus/cause too
      assert.equal(entry.exitStatus, undefined);
      assert.equal(entry.cause, undefined);
      assert.equal(entry.sessionId, undefined);
      assert.equal(entry.pr, undefined);
    } finally {
      cleanup(fx);
    }
  });

  test('a provider-resolved worker refuses — remote sessions take no local command', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const err = await spawnErr(makeCopilotConnector({ dir: fx.main }, fx.env), {
        ...SPEC(fx.main, fx.beadsDir, 'fx-1'),
        worker: { kind: 'argv', argv: ['x'], cliName: 'x' },
      });
      assert.equal(err.kind, 'config');
      assert.equal(fx.rows()[0]!.status, 'open');
    } finally {
      cleanup(fx);
    }
  });

  test('fleet occupancy counts a live remote task and frees a dead one', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }]);
    try {
      const { setState } = await spawnedTask(fx);
      assert.equal(fleetOccupancyFor(fx.main, fx.env), 1);
      setState('completed');
      assert.equal(fleetOccupancyFor(fx.main, fx.env), 0);
    } finally {
      cleanup(fx);
    }
  });

  test('capabilities: attach + respawn + no supervisor', () => {
    const fx = fixture([]);
    try {
      const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
      assert.deepEqual(conn.capabilities(), { attach: true, respawn: true, supervisor: 'none' });
    } finally {
      cleanup(fx);
    }
  });

  test('registered as a builtin backend', () => {
    assert.ok(agentConnectorNames().includes('copilot'));
    // last of the spawnable built-ins — 'devin' trails the registry but
    // its spawn() refuses, so it never counts against this ordering
    assert.equal(agentConnectorNames().at(-2), 'copilot');
  });

  test('status on an unknown id throws AgentNotFound', async () => {
    const fx = fixture([]);
    try {
      const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
      await assert.rejects(conn.status('copilot-nope'), AgentNotFound);
    } finally {
      cleanup(fx);
    }
  });
});

describe('copilot session plane', () => {
  test('an absent or stale count cache fails closed unavailable', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], {
      repo: 'octo/repo',
      maxSessions: 1,
      reservationsDir: '',
    });
    try {
      const resDir = planeSlots(fx);
      const plane = sessionPlane('copilot')!;
      // no cache at all — the remote count is unverifiable, not zero
      assert.throws(() => plane.countLive({ reservationsDir: resDir }), /absent or corrupt/);
      assert.throws(() => plane.countWorkers!({ reservationsDir: resDir }), /absent or corrupt/);
      // and with the API unreachable the spawn's own refresh can't
      // produce one either — a quota never spawns blind
      process.env.FAKE_GH_FAIL = 'agents/tasks';
      const err = await spawnErr(
        makeCopilotConnector({ dir: fx.main }, fx.env),
        SPEC(fx.main, fx.beadsDir, 'fx-1')
      );
      assert.equal(err.kind, 'unavailable');
    } finally {
      cleanup(fx);
    }
  });

  test('a first spawn on a reachable API refreshes the count itself', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], {
      repo: 'octo/repo',
      maxSessions: 2,
      reservationsDir: '',
    });
    try {
      const resDir = planeSlots(fx);
      const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
      // no status/list ran — spawn's own pre-admission refresh lands
      // the cache (here: zero remote tasks) instead of failing closed
      await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'));
      assert.equal(readCount(resDir).count, 1);
    } finally {
      cleanup(fx);
    }
  });

  test('a landed spawn retires its slot reservation on the next refresh', async () => {
    const fx = fixture(
      [
        { id: 'fx-1', status: 'open' },
        { id: 'fx-2', status: 'open' },
      ],
      { repo: 'octo/repo', maxSessions: 2, reservationsDir: '' }
    );
    try {
      const resDir = planeSlots(fx);
      const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'));
      // the spawn's post-dispatch refresh already swept the slot —
      // live remote count (1) + reservation (0), not 2
      const remaining = readdirSync(resDir).filter(n => n.endsWith('.slot'));
      assert.deepEqual(remaining, []);
      // the second spawn therefore fits under maxSessions: 2 —
      // before the sweep it would refuse on the phantom double count
      const info2 = await conn.spawn({ ...SPEC(fx.main, fx.beadsDir, 'fx-2') });
      assert.equal(info2.backend, 'copilot');
      assert.ok(info.id !== info2.id);
    } finally {
      cleanup(fx);
    }
  });

  test('the remote count paginates past one page', async () => {
    const tasks = Array.from({ length: 150 }, (_, i) => ({
      id: `task-x${i}`,
      state: 'in_progress',
      repo: 'octo/repo',
      sessions: [{ id: `sess-x${i}`, state: 'in_progress' }],
    }));
    const fx = fixture(
      [],
      { repo: 'octo/repo', maxSessions: 200, reservationsDir: '' },
      { tasks, seq: 200 }
    );
    try {
      const resDir = planeSlots(fx);
      await makeCopilotConnector({ dir: fx.main }, fx.env).list();
      assert.equal(readCount(resDir).count, 150);
    } finally {
      cleanup(fx);
    }
  });

  test('a list refresh lands the remote count; an armed quota refuses at cap', async () => {
    const fx = fixture(
      [{ id: 'fx-1', status: 'open' }],
      { repo: 'octo/repo', maxSessions: 1, reservationsDir: '' },
      {
        tasks: [
          {
            id: 'task-ext',
            state: 'in_progress',
            repo: 'octo/repo',
            sessions: [{ id: 'sess-ext', state: 'in_progress' }],
          },
        ],
        seq: 2,
      }
    );
    try {
      const resDir = planeSlots(fx);
      const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
      // the refresh rides a connector read — one external live task lands in the cache
      await conn.list();
      const cache = readCount(resDir);
      assert.equal(cache.count, 1);
      assert.deepEqual(cache.ids, ['task-ext']);
      assert.equal(sessionPlane('copilot')!.countLive({ reservationsDir: resDir }), 1);
      // and admission honors it — the spawn refuses under the mutex
      const err = await spawnErr(conn, SPEC(fx.main, fx.beadsDir, 'fx-1'));
      assert.equal(err.kind, 'cap');
    } finally {
      cleanup(fx);
    }
  });

  test('an admitted spawn pins the copilot sessionKind lane', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], {
      repo: 'octo/repo',
      maxSessions: 2,
      reservationsDir: '',
    });
    try {
      planeSlots(fx);
      const conn = makeCopilotConnector({ dir: fx.main }, fx.env);
      await conn.list(); // refresh the (empty) count cache
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'));
      assert.equal(info.backend, 'copilot');
      assert.equal(readAgentRegistry(fx.main)['fx-1']!.sessionKind, 'copilot');
    } finally {
      cleanup(fx);
    }
  });
});
