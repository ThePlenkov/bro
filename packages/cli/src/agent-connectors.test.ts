import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentRegistryPath,
  bdActor,
  countSessionReservations,
  DEFAULT_CONFIG,
  patchAgentRegistry,
  procStat,
  readAgentRegistry,
  SpawnError,
  AgentNotFound,
  type AgentCapabilities,
  type AgentConnector,
  type AgentInfo,
  type AgentRegistryEntry,
  type ConnectorCtx,
} from '@broject/core'
import {
  agentConnectorNames,
  broSpawnArgv,
  budgetLines,
  budgetSnapshot,
  BUDGET_LIMITS,
  eachAgentConnector,
  fleetOccupancy,
  fleetProfileOf,
  loadAgentEnv,
  makeGascityConnector,
  makeNativeConnector,
  makeTmuxConnector,
  pidAlive,
  registerAgentConnector,
  resolveAgentConnector,
  resolveSpawnProvider,
  sessionKindOf,
  sessionQuotaOf,
  unregisterAgentConnector,
  type AgentConnectorEnv,
  type BudgetSnapshot,
} from './agent-connectors.ts'
import { initRepo, installFakeBd, readBeads, writeBeads } from './commands/testrepo.ts'

/** tmux shim — a state file per socket at $TMUX_FAKE_HOME/<socket>.json
 *  maps session → pid; new-session spawns the pane command detached like
 *  a real server would (pane exit → has-session fails). Covers -V,
 *  new-session (-d -s -c -e), has-session, kill-session, list-sessions
 *  (-F #{session_name}), list-panes. */
const FAKE_TMUX = `#!/usr/bin/env node
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
let socket = 'default'
if (args[0] === '-L') { socket = args[1]; args.splice(0, 2) }
const DB = process.env.TMUX_FAKE_HOME + '/' + socket + '.json'
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')) } catch { return { sessions: {} } } }
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const target = () => args[args.indexOf('-t') + 1]
// writeSync — console.log is pipe-buffered and process.exit truncates it
if (args[0] === '-V') { fs.writeSync(1, 'tmux 3.7c-fake\\n'); process.exit(0) }
if (args[0] === 'new-session') {
  let name, cwd = process.cwd(), env = {}, cmd
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '-d') continue
    if (a === '-s') name = args[++i]
    else if (a === '-c') cwd = args[++i]
    else if (a === '-e') { const kv = args[++i]; const eq = kv.indexOf('='); env[kv.slice(0, eq)] = kv.slice(eq + 1) }
    else cmd = a
  }
  const db = load()
  if (db.sessions[name] && alive(db.sessions[name].pid)) {
    console.error('duplicate session: ' + name); process.exit(1)
  }
  const child = cp.spawn('sh', ['-c', cmd], {
    cwd, env: { ...process.env, ...env }, detached: true, stdio: 'ignore',
  })
  child.unref()
  db.sessions[name] = { pid: child.pid }
  save(db)
  process.exit(0)
}
if (args[0] === 'has-session') {
  const s = load().sessions[target()]
  if (s && alive(s.pid)) { process.exit(0) }
  console.error("can't find session: " + target()); process.exit(1)
}
if (args[0] === 'kill-session') {
  const db = load(); const s = db.sessions[target()]
  if (s && alive(s.pid)) { try { process.kill(-s.pid, 'SIGKILL') } catch {} }
  delete db.sessions[target()]; save(db)
  process.exit(0)
}
if (args[0] === 'list-sessions') {
  // a real server dies with its last session — zero live sessions means
  // 'no server running', not a clean empty listing
  const live = Object.keys(load().sessions).filter((n) => alive(load().sessions[n].pid))
  if (live.length === 0) { console.error('no server running'); process.exit(1) }
  fs.writeSync(1, live.join('\\n') + '\\n'); process.exit(0)
}
if (args[0] === 'list-panes') {
  const s = load().sessions[target()]
  if (!s || !alive(s.pid)) { console.error('no session'); process.exit(1) }
  fs.writeSync(1, s.pid + '\\n'); process.exit(0)
}
console.error('unhandled tmux args: ' + args.join(' ')); process.exit(1)
`

interface Fixture {
  root: string
  main: string
  beadsDir: string
  /** the fake bd's JSON store (FAKE_BD_DB) */
  db: string
  env: AgentConnectorEnv
  prevPath: string
  /** TMUX_FAKE_HOME before the fixture overwrote it — restored, never
   *  deleted, so a pre-set runner env survives the test. */
  prevTmuxFakeHome?: string
  prevFakeBdDb?: string
  prevBeadsActor?: string
  /** Ambient GIT_/BEADS_/BRO_ pins scrubbed for the test's duration. */
  scrubbed: Record<string, string | undefined>
  dbRows(): Array<Record<string, unknown>>
}

/** Real git repo + the shared fake bd on PATH + a beadsDir the pinned
 *  store's cwd contract needs (bdActor shells out with it as cwd; the
 *  store itself keys off FAKE_BD_DB — same wiring as agents.test.ts).
 *  The agent command is `node {promptFile}` — the prompt IS the
 *  program. `tmux: true` adds the tmux shim and a tmux knob mirroring
 *  native's. */
function fixture(
  rows: Array<Record<string, unknown>>,
  command = 'node {promptFile}',
  opts: { tmux?: boolean } = {}
): Fixture {
  const { root, main } = initRepo('bro-agconn-')
  const { binDir, db } = installFakeBd(root, rows)
  const beadsDir = join(root, 'beads')
  mkdirSync(beadsDir, { recursive: true })
  const agents: Record<string, Record<string, unknown>> = { native: { command } }
  const prevTmuxFakeHome = process.env.TMUX_FAKE_HOME
  if (opts.tmux === true) {
    writeFileSync(join(binDir, 'tmux'), FAKE_TMUX)
    chmodSync(join(binDir, 'tmux'), 0o755)
    mkdirSync(join(root, 'tmux-state'), { recursive: true })
    process.env.TMUX_FAKE_HOME = join(root, 'tmux-state')
    agents['tmux'] = { command, socket: 'test' }
  }
  const prevPath = process.env.PATH ?? ''
  const prevFakeBdDb = process.env.FAKE_BD_DB
  const prevBeadsActor = process.env.BEADS_ACTOR
  // ambient repo/store pins (GIT_DIR, BEADS_DIR, BRO_*) would redirect
  // the connector's git-common-dir resolution into the outer repo —
  // same hazard testrepo's git() strips
  const scrubbed: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) {
    if (/^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|BEADS_DIR|BRO_)/.test(k)) {
      scrubbed[k] = process.env[k]
      delete process.env[k]
    }
  }
  process.env.PATH = `${binDir}:${prevPath}`
  process.env.FAKE_BD_DB = db
  // BEADS_ACTOR is pinned so the rebind-actor check matches the fake's
  // `tester` regardless of session env (same as agents.test.ts)
  process.env.BEADS_ACTOR = 'tester'
  return {
    root,
    main,
    beadsDir,
    db,
    env: { agents, connectors: {} },
    prevPath,
    prevTmuxFakeHome,
    prevFakeBdDb,
    prevBeadsActor,
    scrubbed,
    dbRows: () => readBeads(db),
  }
}

function cleanup(fx: Fixture): void {
  // detached agents outlive a failed assertion — kill whatever the
  // registry still points at before the tmpdir (and it) goes away
  try {
    for (const e of Object.values(readAgentRegistry(fx.main))) {
      // a tmux pane is the server's child, not a detached group leader —
      // the recorded session id is its reliable termination handle, and
      // it covers an entry whose pane pid never reached the registry
      if (typeof e.session === 'string') {
        const socket = fx.env.agents['tmux']?.socket
        spawnSync(
          'tmux',
          [...(typeof socket === 'string' ? ['-L', socket] : []), 'kill-session', '-t', e.session],
          { stdio: 'ignore' }
        )
      }
      // never signal our own pid/pgid — a group-leader test process
      // would take the whole runner down
      if (typeof e.pid === 'number' && e.pid > 0 && e.pid !== process.pid && e.pid !== process.ppid) {
        try {
          process.kill(-e.pid, 'SIGKILL') // detached → own process group
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // no readable registry — nothing spawned
  }
  process.env.PATH = fx.prevPath
  if (fx.prevTmuxFakeHome === undefined) {
    delete process.env.TMUX_FAKE_HOME
  } else {
    process.env.TMUX_FAKE_HOME = fx.prevTmuxFakeHome
  }
  for (const [k, v] of [
    ['FAKE_BD_DB', fx.prevFakeBdDb],
    ['BEADS_ACTOR', fx.prevBeadsActor],
  ] as const) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  for (const [k, v] of Object.entries(fx.scrubbed)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  rmSync(fx.root, { recursive: true, force: true })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll until fn() holds or the budget runs out — process death and
 *  exit-file writes are async from the test's point of view. */
async function until(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) {
      return
    }
    await sleep(50)
  }
  assert.ok(await fn(), 'condition did not hold within budget')
}

const SPEC = (main: string, beadsDir: string, molStep: string, prompt: string) => ({
  molStep,
  repoRoot: main,
  beadsDir,
  prompt,
})

describe('resolveAgentConnector', () => {
  test('explicit pick wins; unknown names name the registry', () => {
    const { root, main } = initRepo('bro-agconn-')
    const env: AgentConnectorEnv = { agents: {}, connectors: {} }
    try {
      assert.equal(resolveAgentConnector({ dir: main }, { connector: 'native' }, env).name, 'native')
      assert.throws(
        () => resolveAgentConnector({ dir: main }, { connector: 'nope' }, env),
        /agent connector "nope" is not registered.*native/
      )
      // connectors.agents config selects when no explicit pick
      assert.equal(
        resolveAgentConnector({ dir: main }, {}, { ...env, connectors: { agents: 'native' } }).name,
        'native'
      )
      // registry order — native is the designed default
      assert.equal(resolveAgentConnector({ dir: main }, {}, env).name, 'native')
      assert.deepEqual(agentConnectorNames(), ['native', 'tmux', 'gascity'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** One backend under test — the connector contract is identical across
 *  backends, so the suite runs once per entry. `tmux` puts the tmux shim
 *  on PATH; `foreign` names the OTHER backend for the no-cross-adopt
 *  case; `kill` takes out the agent's process group (the native child
 *  and the fake pane are both detached group leaders). */
interface BackendCase {
  name: string
  make: (ctx: ConnectorCtx, env: AgentConnectorEnv) => AgentConnector
  tmux?: boolean
  foreign: string
  idRe: RegExp
  capabilities: AgentCapabilities
  /** backend-private assertions on the registry entry after spawn */
  entryChecks?: (entry: AgentRegistryEntry, info: AgentInfo) => void
}

function connectorContract(b: BackendCase): void {
  const fx = (rows: Array<Record<string, unknown>>) =>
    fixture(rows, undefined, { tmux: b.tmux === true })
  const conn = (f: Fixture) => b.make({ dir: f.main }, f.env)
  const kill = (info: AgentInfo) => process.kill(-info.pid!, 'SIGKILL')

  test('spawn claims the step, registers the agent, leaves a .work marker', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const info = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      assert.equal(info.backend, b.name)
      assert.equal(info.state, 'running')
      assert.ok(typeof info.pid === 'number' && pidAlive(info.pid))
      // the claim landed in the pinned store
      assert.equal(f.dbRows()[0]!.status, 'in_progress')
      // registry entry keeps pid + worktree + log alongside the id
      const entry = readAgentRegistry(f.main)['fx-1']!
      assert.equal(entry.agentId, info.id)
      assert.equal(entry.pid, info.pid)
      assert.equal(entry.worktree, f.main)
      b.entryChecks?.(entry, info)
      // parallel-session detection sees the agent as live work
      const marker = join(f.main, '.git', 'bro', 'hooks', `agent-${info.id}.work`)
      assert.ok(existsSync(marker))
      assert.match(readFileSync(marker, 'utf8'), /fx-1/)
      await c.stop(info.id)
    } finally {
      cleanup(f)
    }
  })

  test('a test failing before stop still reaps the spawned agent', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    let pid: number | undefined
    try {
      const info = await conn(f).spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      pid = info.pid
      assert.ok(pid !== undefined && pidAlive(pid))
    } finally {
      // tmux: hide the recorded pid so the session-id path is the only
      // reaper — the fake pane is itself a detached group leader, so the
      // generic -pid kill would mask a broken kill-session
      if (b.tmux === true && pid !== undefined) {
        patchAgentRegistry(f.main, 'fx-1', { pid: undefined })
      }
      // the assertion-failure path — cleanup runs with no stop() first
      cleanup(f)
    }
    await until(() => !pidAlive(pid!))
  })

  test('a live agent on the step refuses a second spawn', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const first = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      await assert.rejects(
        c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')),
        SpawnError
      )
      await c.stop(first.id)
    } finally {
      cleanup(f)
    }
  })

  test('the fleet cap refuses a spawn at maxConcurrent — names cap and occupancy', async () => {
    const f = fx([
      { id: 'fx-1', status: 'open' },
      { id: 'fx-2', status: 'open' },
    ])
    try {
      const env = { ...f.env, fleet: { maxConcurrent: 1 } }
      const c = b.make({ dir: f.main }, env)
      const first = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      // a second step's spawn hits the cap — the refusal names both numbers
      await assert.rejects(
        c.spawn(SPEC(f.main, f.beadsDir, 'fx-2', 'setTimeout(() => {}, 30000)')),
        /fleet cap reached — 1\/1 agent slots occupied.*fx-2/
      )
      // the refused spawn left no claim and no registry entry
      assert.equal(f.dbRows().find((r) => r.id === 'fx-2')!.status, 'open')
      assert.equal(readAgentRegistry(f.main)['fx-2'], undefined)
      // a dead worker frees its slot — the same spawn now lands
      kill(first)
      await until(() => !pidAlive(first.pid!))
      const second = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-2', 'setTimeout(() => {}, 30000)'))
      assert.equal(second.state, 'running')
      await c.stop(second.id)
    } finally {
      cleanup(f)
    }
  })

  test('the devin session quota refuses a spawn at maxSessions — nothing half-lands', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    const lockDir = mkdtempSync(join(tmpdir(), 'bro-devin-locks-'))
    const reservationsDir = mkdtempSync(join(tmpdir(), 'bro-devin-resv-'))
    // one live devin session (this process) fills the cap of 1
    writeFileSync(join(lockDir, 'me.lock'), String(process.pid))
    const env: AgentConnectorEnv = {
      ...f.env,
      agents: {
        ...f.env.agents,
        // whichever backend this suite's connector is — it claims a
        // devin session, so the quota applies
        native: { ...f.env.agents['native'], sessionKind: 'devin' },
        tmux: { ...f.env.agents['tmux'], sessionKind: 'devin' },
        devin: { maxSessions: 1, lockDir, reservationsDir },
      },
    }
    try {
      const c = b.make({ dir: f.main }, env)
      await assert.rejects(
        c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')),
        /devin session quota reached — 1\/1 live sessions.*fx-1/
      )
      // a refused spawn leaves no claim and no registry entry
      assert.equal(f.dbRows().find((r) => r.id === 'fx-1')!.status, 'open')
      assert.equal(readAgentRegistry(f.main)['fx-1'], undefined)
    } finally {
      rmSync(lockDir, { recursive: true, force: true })
      rmSync(reservationsDir, { recursive: true, force: true })
      cleanup(f)
    }
  })

  test('an admitted devin spawn holds a host-wide reservation the next admission sees', async () => {
    const f = fx([
      { id: 'fx-1', status: 'open' },
      { id: 'fx-2', status: 'open' },
    ])
    const lockDir = mkdtempSync(join(tmpdir(), 'bro-devin-locks-'))
    const reservationsDir = mkdtempSync(join(tmpdir(), 'bro-devin-resv-'))
    // cap 2: one live lock + one reservation = full — the second devin
    // spawn must refuse even though its own repo registry is empty
    writeFileSync(join(lockDir, 'other.lock'), String(process.pid))
    const env: AgentConnectorEnv = {
      ...f.env,
      agents: {
        ...f.env.agents,
        native: { ...f.env.agents['native'], sessionKind: 'devin' },
        tmux: { ...f.env.agents['tmux'], sessionKind: 'devin' },
        devin: { maxSessions: 2, lockDir, reservationsDir },
      },
    }
    try {
      const c = b.make({ dir: f.main }, env)
      const first = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      assert.equal(first.state, 'running')
      assert.equal(readAgentRegistry(f.main)['fx-1']?.sessionKind, 'devin')
      // the spawned run claimed a reservation — its devin lock would
      // land here in production; in the fixture the file IS the slot
      assert.equal(countSessionReservations(reservationsDir), 1)
      await assert.rejects(
        c.spawn(SPEC(f.main, f.beadsDir, 'fx-2', 'setTimeout(() => {}, 30000)')),
        /devin session quota reached — 2\/2 live sessions.*fx-2/
      )
      assert.equal(readAgentRegistry(f.main)['fx-2'], undefined)
      await c.stop(first.id)
    } finally {
      rmSync(lockDir, { recursive: true, force: true })
      rmSync(reservationsDir, { recursive: true, force: true })
      cleanup(f)
    }
  })

  test('a non-devin spawn ignores the session quota entirely', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    const lockDir = mkdtempSync(join(tmpdir(), 'bro-devin-locks-'))
    writeFileSync(join(lockDir, 'me.lock'), String(process.pid))
    // quota configured and FULL — but the node command isn't a devin
    // session, so sessionQuotaOf never engages and the spawn lands
    const env: AgentConnectorEnv = {
      ...f.env,
      agents: {
        ...f.env.agents,
        devin: { maxSessions: 1, lockDir },
      },
    }
    try {
      const c = b.make({ dir: f.main }, env)
      const info = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      assert.equal(info.state, 'running')
      await c.stop(info.id)
    } finally {
      rmSync(lockDir, { recursive: true, force: true })
      cleanup(f)
    }
  })

  test('sessionKindOf — declared override beats argv detection', () => {
    const spec = SPEC('/r', '/b', 'fx-1', 'p')
    const env: AgentConnectorEnv = { agents: {}, connectors: {} }
    // command basename detection
    assert.equal(sessionKindOf(env, 'native', spec, 'devin -p {promptFile}'), 'devin')
    assert.equal(sessionKindOf(env, 'native', spec, '/usr/bin/devin acp'), 'devin')
    assert.equal(sessionKindOf(env, 'native', spec, 'node {promptFile}'), undefined)
    // declared sessionKind wins over a non-devin command (wrapper script)
    const declared: AgentConnectorEnv = {
      agents: { tmux: { sessionKind: 'devin' } },
      connectors: {},
    }
    assert.equal(sessionKindOf(declared, 'tmux', spec, 'my-wrapper {promptFile}'), 'devin')
    // a worker payload's own command drives detection, not the backend's
    const withWorker = { ...spec, worker: { kind: 'argv' as const, argv: ['/opt/devin', '-p'], cliName: 'devin' } }
    assert.equal(sessionKindOf(env, 'native', withWorker, 'node {promptFile}'), 'devin')
  })

  test('sessionQuotaOf — uncapped or non-devin → undefined (no scan paid)', () => {
    const spec = SPEC('/r', '/b', 'fx-1', 'p')
    const uncapped: AgentConnectorEnv = { agents: {}, connectors: {} }
    assert.equal(sessionQuotaOf(uncapped, 'native', spec, 'devin -p'), undefined)
    const capped: AgentConnectorEnv = {
      agents: { devin: { maxSessions: 6, lockDir: '/l' } },
      connectors: {},
    }
    const lane = sessionQuotaOf(capped, 'native', spec, 'devin -p')
    assert.equal(lane?.plane.kind, 'devin')
    assert.equal(lane?.agents, capped.agents)
    // a devin kind with a non-devin command → still undefined
    assert.equal(sessionQuotaOf(capped, 'native', spec, 'node {promptFile}'), undefined)
    // a malformed cap still yields a lane — admission refuses it loudly
    const bad: AgentConnectorEnv = {
      agents: { devin: { maxSessions: 'six' } },
      connectors: {},
    }
    assert.equal(sessionQuotaOf(bad, 'native', spec, 'devin -p')?.plane.kind, 'devin')
    // a declared kind with NO registered plane + a configured cap →
    // loud config refusal, never a silent ungoverned spawn
    const unregistered: AgentConnectorEnv = {
      agents: { native: { sessionKind: 'nope' }, nope: { maxSessions: 1 } },
      connectors: {},
    }
    assert.throws(
      () => sessionQuotaOf(unregistered, 'native', spec, 'whatever'),
      (e: unknown) => e instanceof SpawnError && e.kind === 'config'
    )
  })

  test('fleet.maxConcurrent 0 means uncapped', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `fx-${i + 1}`, status: 'open' }))
    const f = fx(rows)
    const c = b.make({ dir: f.main }, { ...f.env, fleet: { maxConcurrent: 0 } })
    const spawned: string[] = []
    try {
      // four live at once — one over the default cap, so the last spawn
      // only succeeds when the knob itself disables admission
      for (const r of rows) {
        const info = await c.spawn(
          SPEC(f.main, f.beadsDir, String(r.id), 'setTimeout(() => {}, 30000)')
        )
        assert.equal(info.state, 'running')
        spawned.push(info.id)
      }
    } finally {
      for (const id of spawned) {
        await c.stop(id).catch(() => {})
      }
      cleanup(f)
    }
  })

  test('a foreign claim (no registry entry) refuses spawn', async () => {
    const f = fx([{ id: 'fx-1', status: 'in_progress', assignee: 'human' }])
    try {
      await assert.rejects(
        conn(f).spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 1)')),
        SpawnError
      )
    } finally {
      cleanup(f)
    }
  })

  test('respawn: dead agent + live claim → rebinds, reuses agentId', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const first = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      // kill -9 — no exit file written → 'lost'
      kill(first)
      await until(() => !pidAlive(first.pid!))
      const l = await c.list()
      assert.equal(l.agents[0]!.state, 'lost')
      const second = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      assert.equal(second.id, first.id)
      assert.equal(second.state, 'running')
      // the claim moved to the respawning actor
      assert.equal(f.dbRows()[0]!.assignee, bdActor(f.main))
      await c.stop(second.id)
    } finally {
      cleanup(f)
    }
  })

  test('a claim held by another actor is not stolen on respawn', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const first = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      kill(first)
      await until(() => !pidAlive(first.pid!))
      // someone else claimed the step while our worker was dead
      const rows = f.dbRows()
      rows[0]!.assignee = 'other-actor'
      writeBeads(f.db, rows)
      await assert.rejects(
        c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')),
        /claimed by other-actor/
      )
      await c.stop(first.id)
    } finally {
      cleanup(f)
    }
  })

  test('spec.env cannot override the identity pins', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const spec = {
        ...SPEC(
          f.main,
          f.beadsDir,
          'fx-1',
          "require('fs').writeFileSync('env.out', [process.env.BEADS_DIR, process.env.BRO_BEAD_ID, process.env.BRO_AGENT_ID].join('|'))"
        ),
        env: { BEADS_DIR: '/evil', BRO_BEAD_ID: 'spoofed', BRO_AGENT_ID: 'spoofed' },
      }
      const info = await c.spawn(spec)
      await until(() => existsSync(join(f.main, 'env.out')))
      const out = readFileSync(join(f.main, 'env.out'), 'utf8')
      assert.equal(out, `${f.beadsDir}|fx-1|${info.id}`)
      // the claim landed in the pinned store, not the overridden one
      assert.equal(f.dbRows()[0]!.status, 'in_progress')
      await c.stop(info.id)
    } finally {
      cleanup(f)
    }
  })

  test('exit status harvests into the registry — dead agent + .exit → exited', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const info = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'process.exit(3)'))
      await until(() => !pidAlive(info.pid!))
      const st = await c.status(info.id)
      assert.equal(st.state, 'exited')
      assert.equal(readAgentRegistry(f.main)['fx-1']!.exitStatus, 3)
    } finally {
      cleanup(f)
    }
  })

  // the taxonomy contract (bro-7xgk.2): the same rc=1 splits on the log
  // tail — a crash is respawnable, a budget wall reads 'blocked' and
  // refuses respawn until the provider's reset (or `down` clears it).
  // spawnRun exits the agent with `program`, waits on the .exit file
  // (pid death can beat the write), and returns the classified status.
  const spawnRun = async (f: Fixture, c: AgentConnector, program: string) => {
    const info = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', program))
    await until(() =>
      existsSync(join(f.main, '.git', 'bro', 'agents', `${info.id}.exit`))
    )
    // the .exit file can beat the wrapper's death — a single read may
    // still report running/spawned, so poll for a terminal state
    let status = await c.status(info.id)
    await until(async () => {
      status = await c.status(info.id)
      return status.state !== 'running' && status.state !== 'spawned'
    })
    return { info, status }
  }
  const respawn = (c: AgentConnector, f: Fixture) =>
    c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))

  test('rc=1 rate-limit output reads blocked and refuses respawn until reset', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const { info, status: st } = await spawnRun(
        f,
        c,
        "console.log('Reached free model rate limit — try again in 90 minutes'); process.exit(1)"
      )
      assert.equal(st.state, 'blocked')
      assert.equal(st.cause, 'rate_limited')
      assert.ok(st.resetAt !== undefined && Date.parse(st.resetAt) > Date.now())
      // the registry carries the cause
      const entry = readAgentRegistry(f.main)['fx-1']!
      assert.equal(entry.cause, 'rate_limited')
      assert.equal(typeof entry.resetAt, 'string')
      // respawn into the same wall is refused, naming the reset
      await assert.rejects(respawn(c, f), /respawn of fx-1 refused — rate_limited until/)
      // the claim stayed with the blocked agent — no rebind happened
      assert.equal(f.dbRows()[0]!.status, 'in_progress')
      // down is the manual clear — the block lifts and respawn proceeds
      await c.stop(info.id)
      const second = await respawn(c, f)
      assert.equal(second.id, info.id)
      assert.equal(second.state, 'running')
      // the fresh run did not inherit the previous life's cause
      assert.equal(readAgentRegistry(f.main)['fx-1']!.cause, undefined)
      await c.stop(second.id)
    } finally {
      cleanup(f)
    }
  })

  test('rc=1 with no infra text is a crash — exited and respawnable', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const { info, status: st } = await spawnRun(
        f,
        c,
        "console.error('kaboom'); process.exit(1)"
      )
      assert.equal(st.state, 'exited')
      assert.equal(st.cause, 'crash')
      const second = await respawn(c, f)
      assert.equal(second.id, info.id)
      assert.equal(second.state, 'running')
      await c.stop(second.id)
    } finally {
      cleanup(f)
    }
  })

  test('a quota exit blocks respawn until an operator clears it', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const { info, status: st } = await spawnRun(
        f,
        c,
        "console.log('insufficient credits — quota exhausted'); process.exit(1)"
      )
      assert.equal(st.state, 'blocked')
      assert.equal(st.cause, 'quota')
      await assert.rejects(respawn(c, f), /respawn of fx-1 refused — quota exhausted.*down/)
      await c.stop(info.id)
    } finally {
      cleanup(f)
    }
  })

  test('stop is idempotent and marks the entry stopped', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      const info = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      await c.stop(info.id)
      await c.stop(info.id) // idempotent
      await c.stop(`${b.name}-deadbeef`) // unknown id → no-op
      const st = await c.status(info.id)
      assert.equal(st.state, 'stopped')
      // the .work marker is gone with the agent
      assert.ok(!existsSync(join(f.main, '.git', 'bro', 'hooks', `agent-${info.id}.work`)))
    } finally {
      cleanup(f)
    }
  })

  test('status on an unknown id throws AgentNotFound', async () => {
    const f = fx([])
    try {
      await assert.rejects(conn(f).status(`${b.name}-nope`), AgentNotFound)
    } finally {
      cleanup(f)
    }
  })

  test('no agent command configured → SpawnError before claiming', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = b.make({ dir: f.main }, { agents: {}, connectors: {} })
      await assert.rejects(c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'true')), SpawnError)
      // nothing claimed, nothing registered
      assert.equal(f.dbRows()[0]!.status, 'open')
      const reg = agentRegistryPath(f.main)
      assert.equal(reg !== null && existsSync(reg), false)
    } finally {
      cleanup(f)
    }
  })

  test('a foreign-backend registry entry refuses spawn — no cross-backend adopt', async () => {
    const f = fx([{ id: 'fx-1', status: 'open' }])
    try {
      const c = conn(f)
      patchAgentRegistry(f.main, 'fx-1', {
        agentId: `${b.foreign}-ab12`,
        backend: b.foreign,
        spawnedAt: new Date().toISOString(),
      })
      await assert.rejects(
        c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 1)')),
        new RegExp(`registered to backend "${b.foreign}"`)
      )
      // nothing claimed, nothing spawned
      assert.equal(f.dbRows()[0]!.status, 'open')
    } finally {
      cleanup(f)
    }
  })

  test('an unsafe registry agentId is reminted, never trusted as a path', async () => {
    const f = fx([{ id: 'fx-1', status: 'in_progress', assignee: 'tester' }])
    const prevActor = process.env.BEADS_ACTOR
    process.env.BEADS_ACTOR = 'tester'
    try {
      const c = conn(f)
      patchAgentRegistry(f.main, 'fx-1', {
        agentId: '../evil',
        backend: b.name,
        spawnedAt: new Date().toISOString(),
      })
      const info = await c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      assert.match(info.id, b.idRe)
      await c.stop(info.id)
    } finally {
      if (prevActor === undefined) {
        delete process.env.BEADS_ACTOR
      } else {
        process.env.BEADS_ACTOR = prevActor
      }
      cleanup(f)
    }
  })

  test('capabilities', () => {
    const c = b.make({ dir: '/x' }, { agents: {}, connectors: {} })
    assert.deepEqual(c.capabilities(), b.capabilities)
  })
}

describe('native connector', () => {
  connectorContract({
    name: 'native',
    make: makeNativeConnector,
    foreign: 'tmux',
    idRe: /^native-[0-9a-f]{8}$/,
    capabilities: { attach: false, respawn: true, supervisor: 'none' },
  })
})

describe('tmux connector', () => {
  connectorContract({
    name: 'tmux',
    make: makeTmuxConnector,
    tmux: true,
    foreign: 'native',
    idRe: /^tmux-[0-9a-f]{8}$/,
    capabilities: { attach: true, respawn: true, supervisor: 'none' },
    entryChecks: (entry, info) => {
      assert.equal(entry.session, `bro-${info.id}`)
      // pane_pid carries the identity pin native's child pid has — a
      // recycled pid must not keep a dead session 'running' (bro-i5oq)
      assert.equal(
        entry.pidStart ?? null,
        typeof entry.pid === 'number' ? (procStat(entry.pid)?.start ?? null) : null
      )
    },
  })

  test('a live native agent counts against tmux spawns — the cap is fleet-wide', async () => {
    const f = fixture(
      [
        { id: 'fx-1', status: 'open' },
        { id: 'fx-2', status: 'open' },
      ],
      undefined,
      { tmux: true }
    )
    try {
      const env = { ...f.env, fleet: { maxConcurrent: 1 } }
      const n = makeNativeConnector({ dir: f.main }, env)
      const first = await n.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)'))
      const t = makeTmuxConnector({ dir: f.main }, env)
      await assert.rejects(
        t.spawn(SPEC(f.main, f.beadsDir, 'fx-2', 'setTimeout(() => {}, 30000)')),
        /fleet cap reached — 1\/1 agent slots occupied/
      )
      await n.stop(first.id)
    } finally {
      cleanup(f)
    }
  })

  test('a failing tmux binary degrades list() and refuses spawn', async () => {
    const f = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      // tmux that can't even report a version — the backend is down
      writeFileSync(
        join(f.root, 'bin', 'tmux'),
        '#!/bin/sh\necho "tmux exploded" >&2\nexit 1\n'
      )
      const c = makeTmuxConnector({ dir: f.main }, f.env)
      const l = await c.list()
      assert.deepEqual(l.agents, [])
      assert.match(l.degraded ?? '', /tmux exploded/)
      await assert.rejects(
        c.spawn(SPEC(f.main, f.beadsDir, 'fx-1', 'true')),
        /tmux unavailable/
      )
      assert.equal(f.dbRows()[0]!.status, 'open')
    } finally {
      cleanup(f)
    }
  })
})

describe('eachAgentConnector', () => {
  // registers LAST — the registry is module-global, so a throwing factory
  // would break connector-resolution probes in earlier tests
  test('a throwing factory degrades to a note; without the callback it still throws', () => {
    registerAgentConnector('explody', () => {
      throw new Error('backend exploded')
    })
    const notes: string[] = []
    const conns = eachAgentConnector(
      { dir: '/x' },
      { agents: {}, connectors: {} },
      (name, err) => notes.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    )
    assert.deepEqual(conns.map((c) => c.name), ['native', 'tmux', 'gascity'])
    assert.deepEqual(notes, ['explody: backend exploded'])
    assert.throws(
      () => eachAgentConnector({ dir: '/x' }, { agents: {}, connectors: {} }),
      /backend exploded/
    )
  })
})

describe('unregisterAgentConnector', () => {
  test('built-ins refuse removal; unknown names are a no-op', () => {
    const before = agentConnectorNames()
    // warns + skips — a misnamed fixture cleanup must not take 'native' down
    unregisterAgentConnector('native')
    unregisterAgentConnector('never-registered')
    assert.deepEqual(agentConnectorNames(), before)
  })

  test('a disposer drops only the entry its registration added', () => {
    const dispose = registerAgentConnector('pin-dup', makeNativeConnector)
    // a duplicate registration is skipped and hands back no disposer —
    // the loser's cleanup cannot remove the entry that won the name
    assert.equal(registerAgentConnector('pin-dup', makeTmuxConnector), undefined)
    dispose!()
    assert.ok(!agentConnectorNames().includes('pin-dup'))
    assert.ok(agentConnectorNames().includes('native'))
  })
})

describe('loadAgentEnv', () => {
  test('reads agents + connectors + loop sections from bro.config.json', () => {
    const { root, main } = initRepo('bro-agenv-')
    try {
      writeFileSync(
        join(main, 'bro.config.json'),
        JSON.stringify({
          agents: { native: { command: 'x' } },
          connectors: { agents: 'native' },
          loop: { agent: 'devin -p' },
        })
      )
      const env = loadAgentEnv(main)
      assert.equal(env.agents['native']!.command, 'x')
      assert.equal(env.connectors['agents'], 'native')
      assert.equal(env.loop?.agent, 'devin -p')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// the taxonomy reads (bro-7xgk.3): the snapshot is the registry rendered
// as a budget picture — fail-closed liveness, spawn hour-buckets, and the
// resets/causes the death ladder recorded. NOW is fixed so the hour
// buckets and the 60-minute window are deterministic.
describe('budgetSnapshot', () => {
  const NOW = Date.parse('2026-10-05T14:30:00Z')
  const ENV: AgentConnectorEnv = { agents: {}, connectors: {} }
  const agentsHomeOf = (main: string) => join(main, '.git', 'bro', 'agents')

  test('empty registry → zeroed local-estimate that names its limits', () => {
    const { root, main } = initRepo('bro-budget-')
    try {
      const snap = budgetSnapshot(main, agentsHomeOf(main), {}, ENV, NOW)
      assert.equal(snap.basis, 'local-estimate')
      assert.deepEqual(snap.limits, [...BUDGET_LIMITS])
      assert.ok(snap.limits.length >= 3)
      assert.equal(snap.entries, 0)
      assert.equal(snap.live, 0)
      assert.equal(snap.blocked, 0)
      assert.equal(snap.spawnedLastHour, 0)
      assert.deepEqual(snap.spawnedPerHour, [])
      assert.deepEqual(snap.resets, [])
      assert.deepEqual(snap.causes, [])
      assert.equal(snap.maxConcurrent, DEFAULT_CONFIG.fleet.maxConcurrent)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('live count, hour buckets, resets and causes ride the registry', () => {
    const { root, main } = initRepo('bro-budget-')
    try {
      const registry: Record<string, AgentRegistryEntry> = {
        // pid: process.pid — a verifiably-live agent without a spawn
        'step-live': {
          agentId: 'native-1',
          backend: 'native',
          spawnedAt: '2026-10-05T14:10:00Z',
          pid: process.pid,
        },
        // a budget wall still holding — the reset is in the future
        'step-wall': {
          agentId: 'native-2',
          backend: 'native',
          spawnedAt: '2026-10-05T14:20:00Z',
          exitStatus: 1,
          cause: 'rate_limited',
          resetAt: '2026-10-05T15:00:00Z',
        },
        // a plain crash — a cause, no reset, no block
        'step-old': {
          agentId: 'native-3',
          backend: 'native',
          spawnedAt: '2026-10-05T12:40:00Z',
          exitStatus: 1,
          cause: 'crash',
        },
        // a rate-limit whose reset already passed — history, not a block
        'step-past': {
          agentId: 'native-4',
          backend: 'native',
          spawnedAt: '2026-10-05T11:05:00Z',
          exitStatus: 1,
          cause: 'rate_limited',
          resetAt: '2026-10-05T12:00:00Z',
        },
      }
      const snap = budgetSnapshot(main, agentsHomeOf(main), registry, ENV, NOW)
      assert.equal(snap.entries, 4)
      assert.equal(snap.live, 1)
      assert.equal(snap.blocked, 1)
      assert.equal(snap.spawnedLastHour, 2) // 14:10 + 14:20 — the window excludes the rest
      assert.deepEqual(snap.spawnedPerHour, [
        { hour: '2026-10-05T11:00:00.000Z', count: 1 },
        { hour: '2026-10-05T12:00:00.000Z', count: 1 },
        { hour: '2026-10-05T14:00:00.000Z', count: 2 },
      ])
      assert.deepEqual(
        snap.resets.map((r) => [r.step, r.cause, r.resetAt, r.holding]),
        [
          ['step-wall', 'rate_limited', '2026-10-05T15:00:00Z', true],
          ['step-past', 'rate_limited', '2026-10-05T12:00:00Z', false],
        ]
      )
      assert.deepEqual(
        snap.causes.map((c) => [c.step, c.backend, c.cause]),
        [
          ['step-wall', 'native', 'rate_limited'],
          ['step-old', 'native', 'crash'],
          ['step-past', 'native', 'rate_limited'],
        ]
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an unharvested death classifies during the walk — .exit + log tail', () => {
    const { root, main } = initRepo('bro-budget-')
    try {
      const home = agentsHomeOf(main)
      mkdirSync(home, { recursive: true })
      const log = join(home, 'native-9.log')
      writeFileSync(join(home, 'native-9.exit'), '1')
      // an absolute reset far in the future — the block holds at any real now
      writeFileSync(log, 'boom\nReached free model rate limit — resets at 2999-01-01T00:00:00Z\n')
      const registry: Record<string, AgentRegistryEntry> = {
        'step-x': {
          agentId: 'native-9',
          backend: 'native',
          spawnedAt: '2026-10-05T14:00:00Z',
          log,
        },
      }
      const snap = budgetSnapshot(main, home, registry, ENV, NOW)
      assert.equal(snap.causes.length, 1)
      assert.equal(snap.causes[0]!.cause, 'rate_limited')
      assert.equal(snap.blocked, 1)
      assert.equal(snap.resets[0]!.resetAt, '2999-01-01T00:00:00.000Z')
      assert.equal(snap.resets[0]!.holding, true)
      // the harvest landed on the entry object, not just the report
      assert.equal(registry['step-x']!.cause, 'rate_limited')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an unharvested death on an unknown backend frees the slot and classifies', () => {
    const { root, main } = initRepo('bro-budget-')
    try {
      const home = agentsHomeOf(main)
      mkdirSync(home, { recursive: true })
      // a backend this build doesn't know occupies whenever exitStatus
      // is absent — harvesting first turns the .exit into a proven
      // death: no slot held, and the cause lands in the section
      const dead = (id: string, tail: string): AgentRegistryEntry => {
        writeFileSync(join(home, `${id}.exit`), '1')
        const log = join(home, `${id}.log`)
        writeFileSync(log, tail)
        return {
          agentId: id,
          backend: 'gone-plugin',
          spawnedAt: '2026-10-05T14:00:00Z',
          log,
        }
      }
      const registry: Record<string, AgentRegistryEntry> = {
        'step-wall': dead(
          'x-1',
          'boom\nReached free model rate limit — resets at 2999-01-01T00:00:00Z\n'
        ),
        // a wall with no reported reset — the block holds anyway
        'step-noreset': dead('x-2', 'boom\n429 too many requests\n'),
      }
      assert.equal(fleetOccupancy(main, home, registry, ENV), 0)
      const snap = budgetSnapshot(main, home, registry, ENV, NOW)
      assert.equal(snap.live, 0)
      assert.equal(snap.blocked, 2)
      assert.deepEqual(
        snap.causes.map((c) => [c.step, c.cause]),
        [
          ['step-wall', 'rate_limited'],
          ['step-noreset', 'rate_limited'],
        ]
      )
      assert.deepEqual(
        snap.resets.map((r) => [r.step, r.resetAt, r.holding]),
        [['step-wall', '2999-01-01T00:00:00.000Z', true]]
      )
      assert.equal(registry['step-wall']!.cause, 'rate_limited')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an unparseable spawnedAt skips the histogram but keeps the row', () => {
    const { root, main } = initRepo('bro-budget-')
    try {
      const registry: Record<string, AgentRegistryEntry> = {
        'step-x': { agentId: 'native-1', backend: 'native', spawnedAt: 'not a date' },
      }
      const snap = budgetSnapshot(main, agentsHomeOf(main), registry, ENV, NOW)
      assert.equal(snap.entries, 1)
      assert.equal(snap.spawnedLastHour, 0)
      assert.deepEqual(snap.spawnedPerHour, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('budgetLines', () => {
  const snap = (over: Partial<BudgetSnapshot> = {}): BudgetSnapshot => ({
    basis: 'local-estimate',
    limits: [...BUDGET_LIMITS],
    entries: 0,
    live: 0,
    blocked: 0,
    maxConcurrent: 3,
    spawnedLastHour: 0,
    spawnedPerHour: [],
    resets: [],
    causes: [],
    ...over,
  })

  test('renders live/spawned and always carries the limits line', () => {
    const lines = budgetLines(snap({ live: 2, blocked: 1, spawnedLastHour: 5 }))
    assert.match(lines[0]!, /live\s+2\/3 agent slots · 1 blocked/)
    assert.match(lines[1]!, /spawned\s+5 in the last hour/)
    assert.match(lines.at(-1)!, /limits\s+.*registry agents only/)
  })

  test('uncapped cap renders without a ceiling; resets and causes list entries', () => {
    const lines = budgetLines(
      snap({
        maxConcurrent: 0,
        resets: [
          { step: 'a', agent: 'native-1', cause: 'rate_limited', resetAt: 't1', holding: true },
        ],
        causes: [{ step: 'b', agent: 'native-2', backend: 'native', cause: 'crash' }],
      })
    )
    assert.match(lines[0]!, /live\s+0 \(uncapped\) agent slots/)
    assert.match(lines.join('\n'), /resets\s+a rate_limited til t1 \(holding\)/)
    assert.match(lines.join('\n'), /causes\s+b: crash/)
  })
})

// --- provider resolution (spec bro-5hx1.1) -------------------------------------

describe('resolveSpawnProvider', () => {
  const providers = {
    kilo: { type: 'acp', command: 'kilo --acp', model: 'jev' },
    local: { type: 'cli', command: 'devin -p', model: 'devin-1' },
    zen: { type: 'cli', command: 'opencode run --model {model} -f {promptFile}', model: 'zen/free' },
    'zen-unpinned': { type: 'cli', command: 'opencode run --model {model} -f {promptFile}' },
    typesafe: {
   type: 'api',
   baseUrl: 'https://api.typesafe.ai',
   apiKeyEnv: 'K',
   models: { ['jev']: 'systemone' },
 },
    'backend-p': { type: 'cli', command: 'backend-cli {promptFile}' },
  } as const
  const env: AgentConnectorEnv = {
    agents: { native: { command: 'node {promptFile}', provider: 'backend-p' } },
    connectors: {},
    providers,
  }

  test('no provider named anywhere → legacy template, a model pin only', async () => {
    const bare: AgentConnectorEnv = { agents: {}, connectors: {} }
    assert.deepEqual(await resolveSpawnProvider(bare, 'native', {}), { model: undefined })
    assert.deepEqual(await resolveSpawnProvider(bare, 'native', { model: 'm1' }), { model: 'm1' })
  })

  test('agents.<backend>.provider names the entry when nothing explicit', async () => {
    const pick = await resolveSpawnProvider(env, 'native', {})
    assert.equal(pick.provider, 'backend-p')
    assert.deepEqual(pick.worker, { kind: 'template', command: 'backend-cli {promptFile}' })
  })

  test('an explicit provider beats the backend knob; unknown names classify by origin', async () => {
    const pick = await resolveSpawnProvider(env, 'native', { provider: 'local' }, 'flag')
    assert.equal(pick.provider, 'local')
    // a flag's typo is caller input
    await assert.rejects(
      resolveSpawnProvider(env, 'native', { provider: 'nope' }, 'flag'),
      (e: unknown) =>
        e instanceof SpawnError && e.kind === 'input' && /providers\.nope/.test(e.message)
    )
    // the same name written in config is a config error
    await assert.rejects(
      resolveSpawnProvider(
        { ...env, agents: { native: { provider: 'nope' } } },
        'native',
        {}
      ),
      (e: unknown) => e instanceof SpawnError && e.kind === 'config'
    )
  })

  test('a non-spawnable kind is a surface error — even when a flag named it', async () => {
    await assert.rejects(
      resolveSpawnProvider(env, 'native', { provider: 'typesafe' }, 'flag'),
      (e: unknown) =>
        e instanceof SpawnError &&
        e.kind === 'config' &&
        /providers\.typesafe \(type 'api'\) has no spawn surface/.test(e.message)
    )
  })

  test('cli resolves to a template worker carrying the entry command', async () => {
    const pick = await resolveSpawnProvider(env, 'native', { provider: 'local' }, 'flag')
    assert.deepEqual(pick.worker, { kind: 'template', command: 'devin -p' })
    assert.equal(pick.model, 'devin-1')
  })

  test('acp resolves to an argv worker — `bro acp-worker` slots, never a shell string', async () => {
    const pick = await resolveSpawnProvider(
      env,
      'native',
      { provider: 'kilo', model: 'qwen3-coder', autoApprove: true },
      'flag'
    )
    assert.equal(pick.provider, 'kilo')
    assert.equal(pick.model, 'qwen3-coder')
    assert.equal(pick.worker?.kind, 'argv')
    const argv = pick.worker?.kind === 'argv' ? pick.worker.argv : []
    const i = argv.indexOf('acp-worker')
    assert.ok(i > 0, `argv: ${argv.join(' ')}`)
    assert.deepEqual(argv.slice(i + 1), [
      '--command',
      'kilo --acp',
      '--model',
      'qwen3-coder',
      '--auto-approve',
    ])
    assert.equal(pick.worker?.kind === 'argv' ? pick.worker.cliName : undefined, 'kilo')
  })

  test('cli {model} placeholder wires the resolved model into the worker command', async () => {
    const pin = await resolveSpawnProvider(env, 'native', { provider: 'zen' }, 'flag')
    assert.equal(pin.model, 'zen/free')
    assert.deepEqual(pin.worker, {
      kind: 'template',
      command: "opencode run --model 'zen/free' -f {promptFile}",
    })
    const over = await resolveSpawnProvider(
      env,
      'native',
      { provider: 'zen', model: 'zen/pro' },
      'flag'
    )
    assert.equal(over.model, 'zen/pro')
    assert.deepEqual(over.worker, {
      kind: 'template',
      command: "opencode run --model 'zen/pro' -f {promptFile}",
    })
  })

  test('cli override a verbatim command cannot consume is a loud error — never a relabel', async () => {
    // 'local' pins devin-1 in a command with no {model}: reporting 'm2'
    // while devin-1 runs would be provenance the worker never ran
    await assert.rejects(
      resolveSpawnProvider(env, 'native', { provider: 'local', model: 'm2' }, 'flag'),
      (e: unknown) =>
        e instanceof SpawnError &&
        e.kind === 'input' &&
        /cannot honor model 'm2'.*\{model\} placeholder/.test(e.message)
    )
    // an override matching the pin reports truthfully — verbatim is fine
    const same = await resolveSpawnProvider(
      env,
      'native',
      { provider: 'local', model: 'devin-1' },
      'flag'
    )
    assert.equal(same.model, 'devin-1')
    assert.deepEqual(same.worker, { kind: 'template', command: 'devin -p' })
    // a {model} placeholder with no model to resolve is a config bug
    await assert.rejects(
      resolveSpawnProvider(env, 'native', { provider: 'zen-unpinned' }, 'flag'),
      (e: unknown) =>
        e instanceof SpawnError &&
        e.kind === 'config' &&
        /uses \{model\} but pins no default model/.test(e.message)
    )
  })

  test('model precedence — explicit pin > profile merge > entry pin', async () => {
    const pinned = await resolveSpawnProvider(env, 'native', { provider: 'kilo' }, 'flag')
    assert.equal(pinned.model, 'jev') // the entry's own pin
    const over = await resolveSpawnProvider(
      env,
      'native',
      { provider: 'kilo', model: 'm2' },
      'flag'
    )
    assert.equal(over.model, 'm2')
  })
})

describe('fleetProfileOf', () => {
  const env: AgentConnectorEnv = {
    agents: {},
    connectors: {},
    fleet: { maxConcurrent: 3, profiles: { cheap: { provider: 'kilo' } } },
  }

  test('a configured preset returns; a missing name is an input error naming the key', () => {
    assert.deepEqual(fleetProfileOf(env, 'cheap'), { provider: 'kilo' })
    assert.throws(
      () => fleetProfileOf(env, 'nope'),
      (e: unknown) =>
        e instanceof SpawnError &&
        e.kind === 'input' &&
        /fleet\.profiles\.nope is not configured/.test(e.message)
    )
    // inherited members are not configured profiles — 'constructor'
    // must take the missing-profile error, not resolve via the chain
    assert.throws(() => fleetProfileOf(env, 'constructor'), SpawnError)
  })
})

describe('broSpawnArgv', () => {
  test('bro on PATH wins; an empty PATH falls back to the npx shim', () => {
    assert.deepEqual(broSpawnArgv({ PATH: '' }), ['npx', '-y', '@broject/bro@0'])
    // whatever dir holds this test's node binary doubles as a fake bin dir
    const binDir = join(process.execPath, '..')
    assert.deepEqual(broSpawnArgv({ PATH: binDir }), ['npx', '-y', '@broject/bro@0'])
    // drop a `bro` shim next to it — PATH-first picks the plain name
    const dir = mkdtempSync(join(tmpdir(), 'bro-bin-'))
    try {
      writeFileSync(join(dir, 'bro'), '#!/bin/sh\n')
      chmodSync(join(dir, 'bro'), 0o755)
      assert.deepEqual(broSpawnArgv({ PATH: dir }), ['bro'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Provider-driven spawns through the real backends — env pins, registry
// provenance, and the worker payloads (spec bro-5hx1.1).
describe('provider-resolved spawns', () => {
  test('native: provider/model pin env + registry + info; spec.env cannot forge them', async () => {
    const f = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const env = {
        ...f.env,
        // {model} placeholder — the override must reach the command,
        // a verbatim cli command refuses an honorless pin
        providers: { local: { type: 'cli', command: 'node {promptFile} -m {model}' } },
      } as AgentConnectorEnv
      const pick = await resolveSpawnProvider(
        env,
        'native',
        { provider: 'local', model: 'm1' },
        'flag'
      )
      const c = makeNativeConnector({ dir: f.main }, env)
      const info = await c.spawn({
        ...SPEC(f.main, f.beadsDir, 'fx-1', "require('fs').writeFileSync('env.out', [process.env.BRO_AGENT_PROVIDER, process.env.BRO_AGENT_MODEL].join('|'))"),
        provider: pick.provider,
        model: pick.model,
        worker: pick.worker,
        env: { BRO_AGENT_PROVIDER: 'forged', BRO_AGENT_MODEL: 'forged' },
      })
      await until(() => existsSync(join(f.main, 'env.out')))
      assert.equal(readFileSync(join(f.main, 'env.out'), 'utf8'), 'local|m1')
      const entry = readAgentRegistry(f.main)['fx-1']!
      assert.equal(entry.provider, 'local')
      assert.equal(entry.model, 'm1')
      assert.equal(info.provider, 'local')
      assert.equal(info.model, 'm1')
      await c.stop(info.id)
    } finally {
      cleanup(f)
    }
  })

  test('native: an argv worker execs slots verbatim — promptFile is the appended last element', async () => {
    const f = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const script = join(f.main, 'agent.mjs')
      writeFileSync(
        script,
        "import { writeFileSync } from 'node:fs'\nwriteFileSync('argv.out', process.argv.slice(2).join('|'))\n"
      )
      const c = makeNativeConnector({ dir: f.main }, f.env)
      const info = await c.spawn({
        ...SPEC(f.main, f.beadsDir, 'fx-1', 'unused — the worker owns the program'),
        worker: { kind: 'argv', argv: [process.execPath, script] },
      })
      await until(() => existsSync(join(f.main, 'argv.out')))
      // exactly one appended arg — the rendered prompt file's path
      const entry = readAgentRegistry(f.main)['fx-1']!
      const out = readFileSync(join(f.main, 'argv.out'), 'utf8')
      assert.ok(out.endsWith(`${entry.agentId}.prompt.md`), out)
      await until(() => !pidAlive(info.pid!))
    } finally {
      cleanup(f)
    }
  })

  test('tmux: an argv worker pane execs slots verbatim', async () => {
    const f = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const script = join(f.main, 'agent.mjs')
      writeFileSync(
        script,
        "import { writeFileSync } from 'node:fs'\nwriteFileSync('argv.out', process.argv.slice(2).join('|'))\n"
      )
      const c = makeTmuxConnector({ dir: f.main }, f.env)
      const info = await c.spawn({
        ...SPEC(f.main, f.beadsDir, 'fx-1', 'unused'),
        worker: { kind: 'argv', argv: [process.execPath, script] },
      })
      await until(() => existsSync(join(f.main, 'argv.out')))
      const entry = readAgentRegistry(f.main)['fx-1']!
      assert.ok(
        readFileSync(join(f.main, 'argv.out'), 'utf8').endsWith(`${entry.agentId}.prompt.md`)
      )
      await c.stop(info.id)
    } finally {
      cleanup(f)
    }
  })

  test('tmux: provenance pins ride -e, never the ambient env file', async () => {
    const f = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const env = {
        ...f.env,
        providers: { local: { type: 'cli', command: 'node {promptFile}' } },
      } as AgentConnectorEnv
      const pick = await resolveSpawnProvider(env, 'tmux', { provider: 'local' }, 'flag')
      const c = makeTmuxConnector({ dir: f.main }, env)
      const info = await c.spawn({
        ...SPEC(
          f.main,
          f.beadsDir,
          'fx-1',
          "require('fs').writeFileSync('env.out', [process.env.BRO_AGENT_PROVIDER, process.env.BRO_AGENT_MODEL ?? 'none'].join('|'))"
        ),
        provider: pick.provider,
        model: pick.model,
        worker: pick.worker,
        env: { BRO_AGENT_PROVIDER: 'forged' },
      })
      await until(() => existsSync(join(f.main, 'env.out')))
      assert.equal(readFileSync(join(f.main, 'env.out'), 'utf8'), 'local|none')
      // and the env file itself never carried the forged key
      assert.equal(existsSync(join(f.main, '.git', 'bro', 'agents', `${info.id}.env`)), false)
      await c.stop(info.id)
    } finally {
      cleanup(f)
    }
  })

  test('gascity: a provider-resolved worker refuses before any gc call', async () => {
    const f = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const c = makeGascityConnector({ dir: f.main }, f.env)
      await assert.rejects(
        c.spawn({
          ...SPEC(f.main, f.beadsDir, 'fx-1', 'x'),
          provider: 'kilo',
          worker: { kind: 'template', command: 'kilo {promptFile}' },
        }),
        (e: unknown) =>
          e instanceof SpawnError && e.kind === 'config' && /gascity/.test(e.message)
      )
      // no claim landed — the refusal precedes everything
      assert.equal(f.dbRows()[0]!.status, 'open')
    } finally {
      cleanup(f)
    }
  })
})
