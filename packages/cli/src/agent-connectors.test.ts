import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  agentRegistryPath,
  bdActor,
  patchAgentRegistry,
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
  eachAgentConnector,
  loadAgentEnv,
  makeNativeConnector,
  makeTmuxConnector,
  pidAlive,
  registerAgentConnector,
  resolveAgentConnector,
  unregisterAgentConnector,
  type AgentConnectorEnv,
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
if (args[0] === '-V') { console.log('tmux 3.7c-fake'); process.exit(0) }
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
  for (const n of live) { console.log(n) }
  process.exit(0)
}
if (args[0] === 'list-panes') {
  const s = load().sessions[target()]
  if (!s || !alive(s.pid)) { console.error('no session'); process.exit(1) }
  console.log(s.pid); process.exit(0)
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
async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) {
      return
    }
    await sleep(50)
  }
  assert.ok(fn(), 'condition did not hold within budget')
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
    },
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
