import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
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
  type AgentConnectorEnv,
} from './agent-connectors.ts'
import { initRepo } from './commands/testrepo.ts'

/** bd shim — JSON store at $BEADS_DIR/store.json; covers show,
 *  update --claim, update --assignee, `config get actor`. */
const FAKE_BD = `#!/usr/bin/env node
const fs = require('node:fs')
const DB = process.env.BEADS_DIR + '/store.json'
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')) } catch { return { rows: [] } } }
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db))
const args = process.argv.slice(2).filter((a) => a !== '--json')
if (args[0] === 'config' && args[1] === 'get' && args[2] === 'actor') {
  console.log('actor = tester'); process.exit(0)
}
const row = (id) => load().rows.find((r) => r.id === id)
if (args[0] === 'show') {
  const r = row(args[1])
  if (!r) { console.error('not found: ' + args[1]); process.exit(1) }
  process.stdout.write(JSON.stringify([r]) + '\\n')
} else if (args[0] === 'update') {
  const db = load()
  const r = db.rows.find((x) => x.id === args[1])
  if (!r) { console.error('not found: ' + args[1]); process.exit(1) }
  for (let i = 2; i < args.length; i++) {
    const k = args[i].slice(2)
    if (k === 'claim') {
      if (r.status !== 'open') { console.error('already claimed'); process.exit(1) }
      r.status = 'in_progress'
      r.assignee = 'tester'
    } else {
      r[k] = args[++i]
    }
  }
  save(db)
} else {
  console.error('unhandled: ' + args.join(' ')); process.exit(1)
}
`

/** tmux shim — a state file per socket at $TMUX_FAKE_HOME/<socket>.json
 *  maps session → pid; new-session spawns the pane command detached like
 *  a real server would (pane exit → has-session fails). Covers -V,
 *  new-session (-d -s -c -e), has-session, kill-session, list-panes. */
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
  process.exit(s && alive(s.pid) ? 0 : 1)
}
if (args[0] === 'kill-session') {
  const db = load(); const s = db.sessions[target()]
  if (s && alive(s.pid)) { try { process.kill(-s.pid, 'SIGKILL') } catch {} }
  delete db.sessions[target()]; save(db)
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
  env: AgentConnectorEnv
  prevPath: string
  /** Ambient GIT_/BEADS_/BRO_ pins scrubbed for the test's duration. */
  scrubbed: Record<string, string | undefined>
  dbRows(): Array<Record<string, unknown>>
}

/** Real git repo + fake bd on PATH + a beadsDir store. The agent
 *  command is `node {promptFile}` — the prompt IS the program.
 *  `tmux: true` adds the tmux shim and a tmux knob mirroring native's. */
function fixture(
  rows: Array<Record<string, unknown>>,
  command = 'node {promptFile}',
  opts: { tmux?: boolean } = {}
): Fixture {
  const { root, main } = initRepo('bro-agconn-')
  const beadsDir = join(root, 'beads')
  mkdirSync(beadsDir, { recursive: true })
  const db = join(beadsDir, 'store.json')
  writeFileSync(db, JSON.stringify({ rows }))
  const binDir = join(root, 'bin')
  mkdirSync(binDir)
  writeFileSync(join(binDir, 'bd'), FAKE_BD)
  chmodSync(join(binDir, 'bd'), 0o755)
  const agents: Record<string, Record<string, unknown>> = { native: { command } }
  if (opts.tmux === true) {
    writeFileSync(join(binDir, 'tmux'), FAKE_TMUX)
    chmodSync(join(binDir, 'tmux'), 0o755)
    mkdirSync(join(root, 'tmux-state'), { recursive: true })
    process.env.TMUX_FAKE_HOME = join(root, 'tmux-state')
    agents['tmux'] = { command, socket: 'test' }
  }
  const prevPath = process.env.PATH ?? ''
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
  return {
    root,
    main,
    beadsDir,
    env: { agents, connectors: {} },
    prevPath,
    scrubbed,
    dbRows: () => JSON.parse(readFileSync(db, 'utf8')).rows,
  }
}

function cleanup(fx: Fixture): void {
  // detached agents outlive a failed assertion — kill whatever the
  // registry still points at before the tmpdir (and it) goes away
  try {
    for (const e of Object.values(readAgentRegistry(fx.main))) {
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
  delete process.env.TMUX_FAKE_HOME
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
      assert.deepEqual(agentConnectorNames(), ['native', 'tmux'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('native connector', () => {
  test('spawn claims the step, registers the agent, leaves a .work marker', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      assert.equal(info.backend, 'native')
      assert.equal(info.state, 'running')
      assert.ok(typeof info.pid === 'number' && pidAlive(info.pid))
      // the claim landed in the pinned store
      assert.equal(fx.dbRows()[0]!.status, 'in_progress')
      // registry entry keeps pid + worktree + log alongside the id
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.agentId, info.id)
      assert.equal(entry.pid, info.pid)
      assert.equal(entry.worktree, fx.main)
      // parallel-session detection sees the agent as live work
      const marker = join(fx.main, '.git', 'bro', 'hooks', `agent-${info.id}.work`)
      assert.ok(existsSync(marker))
      assert.match(readFileSync(marker, 'utf8'), /fx-1/)
      await conn.stop(info.id)
    } finally {
      cleanup(fx)
    }
  })

  test('a live agent on the step refuses a second spawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      const first = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')),
        SpawnError
      )
      await conn.stop(first.id)
    } finally {
      cleanup(fx)
    }
  })

  test('a foreign claim (no registry entry) refuses spawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'in_progress', assignee: 'human' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 1)')),
        SpawnError
      )
    } finally {
      cleanup(fx)
    }
  })

  test('respawn: dead agent + live claim → rebinds, reuses agentId', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      const first = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      // kill -9 — no exit file written → 'lost'
      process.kill(-first.pid!, 'SIGKILL')
      await until(() => !pidAlive(first.pid!))
      const l = await conn.list()
      assert.equal(l.agents[0]!.state, 'lost')
      const second = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      assert.equal(second.id, first.id)
      assert.equal(second.state, 'running')
      // the claim moved to the respawning actor
      assert.equal(fx.dbRows()[0]!.assignee, bdActor(fx.main))
      await conn.stop(second.id)
    } finally {
      cleanup(fx)
    }
  })

  test('a claim held by another actor is not stolen on respawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      const first = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      process.kill(-first.pid!, 'SIGKILL')
      await until(() => !pidAlive(first.pid!))
      // someone else claimed the step while our worker was dead
      const db = join(fx.beadsDir, 'store.json')
      const rows = JSON.parse(readFileSync(db, 'utf8')).rows
      rows[0].assignee = 'other-actor'
      writeFileSync(db, JSON.stringify({ rows }))
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')),
        /claimed by other-actor/
      )
      await conn.stop(first.id)
    } finally {
      cleanup(fx)
    }
  })

  test('spec.env cannot override the identity pins', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      const spec = {
        ...SPEC(
          fx.main,
          fx.beadsDir,
          'fx-1',
          "require('fs').writeFileSync('env.out', [process.env.BEADS_DIR, process.env.BRO_BEAD_ID, process.env.BRO_AGENT_ID].join('|'))"
        ),
        env: { BEADS_DIR: '/evil', BRO_BEAD_ID: 'spoofed', BRO_AGENT_ID: 'spoofed' },
      }
      const info = await conn.spawn(spec)
      await until(() => existsSync(join(fx.main, 'env.out')))
      const out = readFileSync(join(fx.main, 'env.out'), 'utf8')
      assert.equal(out, `${fx.beadsDir}|fx-1|${info.id}`)
      // the claim landed in the pinned store, not the overridden one
      assert.equal(fx.dbRows()[0]!.status, 'in_progress')
      await conn.stop(info.id)
    } finally {
      cleanup(fx)
    }
  })

  test('exit status harvests into the registry — dead pid + .exit → exited', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'process.exit(3)'))
      await until(() => !pidAlive(info.pid!))
      const st = await conn.status(info.id)
      assert.equal(st.state, 'exited')
      assert.equal(readAgentRegistry(fx.main)['fx-1']!.exitStatus, 3)
    } finally {
      cleanup(fx)
    }
  })

  test('stop is idempotent and marks the entry stopped', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      await conn.stop(info.id)
      await conn.stop(info.id) // idempotent
      await conn.stop('native-deadbeef') // unknown id → no-op
      const st = await conn.status(info.id)
      assert.equal(st.state, 'stopped')
      // the .work marker is gone with the agent
      assert.ok(!existsSync(join(fx.main, '.git', 'bro', 'hooks', `agent-${info.id}.work`)))
    } finally {
      cleanup(fx)
    }
  })

  test('status on an unknown id throws AgentNotFound', async () => {
    const fx = fixture([])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      await assert.rejects(conn.status('native-nope'), AgentNotFound)
    } finally {
      cleanup(fx)
    }
  })

  test('no agent command configured → SpawnError before claiming', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, { agents: {}, connectors: {} })
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'true')),
        SpawnError
      )
      // nothing claimed, nothing registered
      assert.equal(fx.dbRows()[0]!.status, 'open')
      const reg = agentRegistryPath(fx.main)
      assert.equal(reg !== null && existsSync(reg), false)
    } finally {
      cleanup(fx)
    }
  })

  test('a foreign-backend registry entry refuses spawn — no cross-backend adopt', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      patchAgentRegistry(fx.main, 'fx-1', {
        agentId: 'tmux-ab12',
        backend: 'tmux',
        spawnedAt: new Date().toISOString(),
      })
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 1)')),
        /registered to backend "tmux"/
      )
      // nothing claimed, nothing spawned
      assert.equal(fx.dbRows()[0]!.status, 'open')
    } finally {
      cleanup(fx)
    }
  })

  test('an unsafe registry agentId is reminted, never trusted as a path', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'in_progress', assignee: 'tester' }])
    const prevActor = process.env.BEADS_ACTOR
    process.env.BEADS_ACTOR = 'tester'
    try {
      const conn = makeNativeConnector({ dir: fx.main }, fx.env)
      patchAgentRegistry(fx.main, 'fx-1', {
        agentId: '../evil',
        backend: 'native',
        spawnedAt: new Date().toISOString(),
      })
      const info = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      assert.match(info.id, /^native-[0-9a-f]{8}$/)
      await conn.stop(info.id)
    } finally {
      if (prevActor === undefined) {
        delete process.env.BEADS_ACTOR
      } else {
        process.env.BEADS_ACTOR = prevActor
      }
      cleanup(fx)
    }
  })

  test('capabilities: self-supervised, respawnable, no attach', () => {
    const conn = makeNativeConnector({ dir: '/x' }, { agents: {}, connectors: {} })
    assert.deepEqual(conn.capabilities(), {
      attach: false,
      respawn: true,
      supervisor: 'none',
    })
  })
})

describe('tmux connector', () => {
  test('spawn claims the step, registers the agent, leaves a .work marker', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      assert.equal(info.backend, 'tmux')
      assert.equal(info.state, 'running')
      assert.ok(typeof info.pid === 'number' && pidAlive(info.pid))
      // the claim landed in the pinned store
      assert.equal(fx.dbRows()[0]!.status, 'in_progress')
      // the registry records the session handle alongside the id
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.agentId, info.id)
      assert.equal(entry.session, `bro-${info.id}`)
      assert.equal(entry.worktree, fx.main)
      // parallel-session detection sees the agent as live work
      const marker = join(fx.main, '.git', 'bro', 'hooks', `agent-${info.id}.work`)
      assert.ok(existsSync(marker))
      await conn.stop(info.id)
    } finally {
      cleanup(fx)
    }
  })

  test('a live agent on the step refuses a second spawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      const first = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')),
        SpawnError
      )
      await conn.stop(first.id)
    } finally {
      cleanup(fx)
    }
  })

  test('a foreign claim (no registry entry) refuses spawn', async () => {
    const fx = fixture(
      [{ id: 'fx-1', status: 'in_progress', assignee: 'human' }],
      undefined,
      { tmux: true }
    )
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 1)')),
        SpawnError
      )
    } finally {
      cleanup(fx)
    }
  })

  test('respawn: dead agent + live claim → rebinds, reuses agentId', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      const first = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      // kill the pane's process group — no exit file written → 'lost'
      process.kill(-first.pid!, 'SIGKILL')
      await until(() => !pidAlive(first.pid!))
      const l = await conn.list()
      assert.equal(l.agents[0]!.state, 'lost')
      const second = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      assert.equal(second.id, first.id)
      assert.equal(second.state, 'running')
      // the claim moved to the respawning actor
      assert.equal(fx.dbRows()[0]!.assignee, bdActor(fx.main))
      await conn.stop(second.id)
    } finally {
      cleanup(fx)
    }
  })

  test('a claim held by another actor is not stolen on respawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      const first = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      process.kill(-first.pid!, 'SIGKILL')
      await until(() => !pidAlive(first.pid!))
      // someone else claimed the step while our worker was dead
      const db = join(fx.beadsDir, 'store.json')
      const rows = JSON.parse(readFileSync(db, 'utf8')).rows
      rows[0].assignee = 'other-actor'
      writeFileSync(db, JSON.stringify({ rows }))
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')),
        /claimed by other-actor/
      )
      await conn.stop(first.id)
    } finally {
      cleanup(fx)
    }
  })

  test('spec.env cannot override the identity pins', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      const spec = {
        ...SPEC(
          fx.main,
          fx.beadsDir,
          'fx-1',
          "require('fs').writeFileSync('env.out', [process.env.BEADS_DIR, process.env.BRO_BEAD_ID, process.env.BRO_AGENT_ID].join('|'))"
        ),
        env: { BEADS_DIR: '/evil', BRO_BEAD_ID: 'spoofed', BRO_AGENT_ID: 'spoofed' },
      }
      const info = await conn.spawn(spec)
      await until(() => existsSync(join(fx.main, 'env.out')))
      const out = readFileSync(join(fx.main, 'env.out'), 'utf8')
      assert.equal(out, `${fx.beadsDir}|fx-1|${info.id}`)
      // the claim landed in the pinned store, not the overridden one
      assert.equal(fx.dbRows()[0]!.status, 'in_progress')
      await conn.stop(info.id)
    } finally {
      cleanup(fx)
    }
  })

  test('exit status harvests into the registry — dead session + .exit → exited', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'process.exit(3)'))
      await until(() => !pidAlive(info.pid!))
      const st = await conn.status(info.id)
      assert.equal(st.state, 'exited')
      assert.equal(readAgentRegistry(fx.main)['fx-1']!.exitStatus, 3)
    } finally {
      cleanup(fx)
    }
  })

  test('stop is idempotent and marks the entry stopped', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      await conn.stop(info.id)
      await conn.stop(info.id) // idempotent
      await conn.stop('tmux-deadbeef') // unknown id → no-op
      const st = await conn.status(info.id)
      assert.equal(st.state, 'stopped')
      assert.ok(!existsSync(join(fx.main, '.git', 'bro', 'hooks', `agent-${info.id}.work`)))
    } finally {
      cleanup(fx)
    }
  })

  test('status on an unknown id throws AgentNotFound', async () => {
    const fx = fixture([], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      await assert.rejects(conn.status('tmux-nope'), AgentNotFound)
    } finally {
      cleanup(fx)
    }
  })

  test('no agent command configured → SpawnError before claiming', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, { agents: {}, connectors: {} })
      await assert.rejects(conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'true')), SpawnError)
      assert.equal(fx.dbRows()[0]!.status, 'open')
      const reg = agentRegistryPath(fx.main)
      assert.equal(reg !== null && existsSync(reg), false)
    } finally {
      cleanup(fx)
    }
  })

  test('a foreign-backend registry entry refuses spawn — no cross-backend adopt', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      patchAgentRegistry(fx.main, 'fx-1', {
        agentId: 'native-ab12',
        backend: 'native',
        spawnedAt: new Date().toISOString(),
      })
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 1)')),
        /registered to backend "native"/
      )
      assert.equal(fx.dbRows()[0]!.status, 'open')
    } finally {
      cleanup(fx)
    }
  })

  test('an unsafe registry agentId is reminted, never trusted as a path', async () => {
    const fx = fixture(
      [{ id: 'fx-1', status: 'in_progress', assignee: 'tester' }],
      undefined,
      { tmux: true }
    )
    const prevActor = process.env.BEADS_ACTOR
    process.env.BEADS_ACTOR = 'tester'
    try {
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      patchAgentRegistry(fx.main, 'fx-1', {
        agentId: '../evil',
        backend: 'tmux',
        spawnedAt: new Date().toISOString(),
      })
      const info = await conn.spawn(
        SPEC(fx.main, fx.beadsDir, 'fx-1', 'setTimeout(() => {}, 30000)')
      )
      assert.match(info.id, /^tmux-[0-9a-f]{8}$/)
      await conn.stop(info.id)
    } finally {
      if (prevActor === undefined) {
        delete process.env.BEADS_ACTOR
      } else {
        process.env.BEADS_ACTOR = prevActor
      }
      cleanup(fx)
    }
  })

  test('a failing tmux binary degrades list() and refuses spawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }], undefined, { tmux: true })
    try {
      // tmux that can't even report a version — the backend is down
      writeFileSync(
        join(fx.root, 'bin', 'tmux'),
        '#!/bin/sh\necho "tmux exploded" >&2\nexit 1\n'
      )
      const conn = makeTmuxConnector({ dir: fx.main }, fx.env)
      const l = await conn.list()
      assert.deepEqual(l.agents, [])
      assert.match(l.degraded ?? '', /tmux exploded/)
      await assert.rejects(
        conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1', 'true')),
        /tmux unavailable/
      )
      assert.equal(fx.dbRows()[0]!.status, 'open')
    } finally {
      cleanup(fx)
    }
  })

  test('capabilities: attachable, respawnable, self-supervised', () => {
    const conn = makeTmuxConnector({ dir: '/x' }, { agents: {}, connectors: {} })
    assert.deepEqual(conn.capabilities(), {
      attach: true,
      respawn: true,
      supervisor: 'none',
    })
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
    assert.deepEqual(conns.map((c) => c.name), ['native', 'tmux'])
    assert.deepEqual(notes, ['explody: backend exploded'])
    assert.throws(
      () => eachAgentConnector({ dir: '/x' }, { agents: {}, connectors: {} }),
      /backend exploded/
    )
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
