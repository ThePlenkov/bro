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
import { dirname, join } from 'node:path'
import { readAgentRegistry, SpawnError, AgentNotFound } from '@broject/core'
import {
  agentConnectorNames,
  loadAgentEnv,
  makeGascityConnector,
  resolveAgentConnector,
  type AgentConnectorEnv,
} from './agent-connectors.ts'
import { initRepo } from './commands/testrepo.ts'

/** bd shim — JSON store at $BEADS_DIR/store.json; same coverage as the
 *  native connector tests (show, update --claim/--assignee, actor). */
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

/** gc shim — JSON city store at <city>/.fake-gc.json keyed by --city;
 *  covers init, start, supervisor status, rig list/add, session
 *  new/list/reset/close/submit, sling. FAKE_GC_FAIL lists substrings of
 *  argv (space-joined) that must exit 1 — the degradation probe. */
const FAKE_GC = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
const fails = (process.env.FAKE_GC_FAIL ?? '').split(',').filter(Boolean)
if (fails.some((f) => argv.join(' ').includes(f))) {
  console.error('fake gc failure'); process.exit(1)
}
let city = process.cwd()
for (let i = 0; i < argv.length; i++) if (argv[i] === '--city') city = argv[i + 1]
const args = argv.filter((a, i) => argv[i - 1] !== '--city' && a !== '--city' && !a.startsWith('--'))
const DB = path.join(city, '.fake-gc.json')
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')) } catch { return { sessions: [], rigs: [], supervisor: false, slung: [] } } }
const save = (db) => { fs.mkdirSync(city, { recursive: true }); fs.writeFileSync(DB, JSON.stringify(db)) }
const find = (db, ref) => db.sessions.find((s) => s.id === ref || s.alias === ref)
if (args[0] === 'init') {
  const dir = args[args.length - 1]
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.fake-gc.json'), JSON.stringify({ sessions: [], rigs: [], supervisor: false, slung: [] }))
  process.exit(0)
}
if (args[0] === 'start') {
  const dir = args[1]
  const db = JSON.parse(fs.readFileSync(path.join(dir, '.fake-gc.json'), 'utf8'))
  db.supervisor = true; fs.writeFileSync(path.join(dir, '.fake-gc.json'), JSON.stringify(db))
  // supervisor status is machine-wide (no --city) — the liveness signal
  // lives in a per-test file outside any city store
  if (process.env.FAKE_GC_SUPERVISOR) fs.writeFileSync(process.env.FAKE_GC_SUPERVISOR, 'true')
  process.exit(0)
}
if (args[0] === 'supervisor' && args[1] === 'status') {
  let running = false
  try { running = fs.readFileSync(process.env.FAKE_GC_SUPERVISOR ?? '', 'utf8') === 'true' } catch { running = false }
  console.log(JSON.stringify({ schema_version: '1', ok: true, running, pid: 0, socket_path: '', checked_paths: [] }))
  process.exit(0)
}
if (args[0] === 'rig' && args[1] === 'list') {
  const db = load()
  console.log(JSON.stringify({ schema_version: '1', ok: true, city_path: city, city_name: 'x', rigs: db.rigs.map((p) => ({ name: path.basename(p), path: p, prefix: 'x', hq: false, suspended: false, running: false, beads: true })), summary: {} }))
  process.exit(0)
}
if (args[0] === 'rig' && args[1] === 'add') {
  const db = load(); db.rigs.push(args[2]); save(db); process.exit(0)
}
if (args[0] === 'session' && args[1] === 'new') {
  const aliasIdx = argv.indexOf('--alias')
  const alias = aliasIdx >= 0 ? argv[aliasIdx + 1] : undefined
  const db = load()
  const s = { id: 'gc-' + (db.sessions.length + 1), alias, template: args[2], state: 'active', closed: false, created_at: new Date().toISOString(), last_active: new Date().toISOString(), attached: false }
  db.sessions.push(s); save(db)
  // FAKE_GC_GARBLE_NEW: exit 0 with non-JSON — the session exists but the
  // caller can't learn its id (the orphan-close path under test)
  if (process.env.FAKE_GC_GARBLE_NEW) { console.log('garbage not json'); process.exit(0) }
  console.log(JSON.stringify({ schema_version: '1', ok: true, session_id: s.id, session_name: s.id, alias: s.alias, template: s.template, transport: 'x', work_dir: city, deferred_start: true, attached: false }))
  process.exit(0)
}
if (args[0] === 'session' && args[1] === 'list') {
  const db = load()
  console.log(JSON.stringify({ schema_version: '1', ok: true, filters: {}, sessions: db.sessions, summary: { total: db.sessions.length, active: 0, suspended: 0, closed: 0 } }))
  process.exit(0)
}
if (args[0] === 'session' && args[1] === 'reset') {
  const db = load(); const s = find(db, args[2])
  if (!s) { console.error('not found: ' + args[2]); process.exit(1) }
  s.state = 'active'; s.closed = false; save(db); process.exit(0)
}
if (args[0] === 'session' && args[1] === 'close') {
  const db = load(); const s = find(db, args[2])
  if (!s) { console.error('not found: ' + args[2]); process.exit(1) }
  s.state = 'closed'; s.closed = true; save(db); process.exit(0)
}
if (args[0] === 'session' && args[1] === 'submit') {
  const db = load(); const s = find(db, args[2])
  if (!s) { console.error('not found: ' + args[2]); process.exit(1) }
  process.exit(0)
}
if (args[0] === 'sling') {
  // --force is a claimless dispatch the connector must never use —
  // refuse it so a regression fails these tests instead of passing
  if (argv.includes('--force')) { console.error('refusing --force'); process.exit(1) }
  const db = load(); db.slung.push({ target: args[1], bead: args[2] }); save(db); process.exit(0)
}
console.error('unhandled: ' + argv.join(' ')); process.exit(1)
`

interface Fixture {
  root: string
  main: string
  beadsDir: string
  city: string
  env: AgentConnectorEnv
  prevPath: string
  dbRows(): Array<Record<string, unknown>>
  gcDb(): { sessions: { id: string; alias?: string; state: string; closed?: boolean }[]; rigs: string[]; supervisor: boolean; slung: { target: string; bead: string }[] }
}

function fixture(rows: Array<Record<string, unknown>>, knobs: Record<string, unknown> = {}): Fixture {
  const { root, main } = initRepo('bro-gcconn-')
  const beadsDir = join(root, 'beads')
  mkdirSync(beadsDir, { recursive: true })
  const db = join(beadsDir, 'store.json')
  writeFileSync(db, JSON.stringify({ rows }))
  const city = join(root, 'city')
  const binDir = join(root, 'bin')
  mkdirSync(binDir)
  writeFileSync(join(binDir, 'bd'), FAKE_BD)
  writeFileSync(join(binDir, 'gc'), FAKE_GC)
  chmodSync(join(binDir, 'bd'), 0o755)
  chmodSync(join(binDir, 'gc'), 0o755)
  const prevPath = process.env.PATH ?? ''
  process.env.PATH = `${binDir}:${prevPath}`
  process.env.FAKE_GC_SUPERVISOR = join(root, 'gc-supervisor')
  return {
    root,
    main,
    beadsDir,
    city,
    env: {
      agents: { gascity: { command: 'fake-agent', configDir: city, ...knobs } },
      connectors: {},
    },
    prevPath,
    dbRows: () => JSON.parse(readFileSync(db, 'utf8')).rows,
    gcDb: () => JSON.parse(readFileSync(join(city, '.fake-gc.json'), 'utf8')),
  }
}

function cleanup(fx: Fixture): void {
  process.env.PATH = fx.prevPath
  delete process.env.FAKE_GC_FAIL
  delete process.env.FAKE_GC_GARBLE_NEW
  delete process.env.FAKE_GC_SUPERVISOR
  rmSync(fx.root, { recursive: true, force: true })
}

const SPEC = (main: string, beadsDir: string, molStep: string) => ({
  molStep,
  repoRoot: main,
  beadsDir,
  prompt: 'do the work',
})

describe('gascity connector', () => {
  test('registry order: native first, gascity last', () => {
    assert.deepEqual(agentConnectorNames(), ['native', 'tmux', 'gascity'])
  })

  test('spawn inits the city, adopts the rig, claims, sessions+slings', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'))
      assert.equal(info.backend, 'gascity')
      assert.equal(info.state, 'running')
      // the claim landed in the pinned shared store, rehomed to the
      // session alias — gc's default work_query picks up in_progress
      // work assigned to the session
      assert.equal(fx.dbRows()[0]!.status, 'in_progress')
      assert.equal(fx.dbRows()[0]!.assignee, 'fx-1')
      // registry keeps the session handle alongside the stable agentId
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.agentId, info.id)
      assert.equal(entry.sessionId, 'gc-1')
      // the city was authored: init files + adopted rig + supervisor up
      assert.ok(existsSync(join(fx.city, 'city.toml')))
      // the per-step agent pins the session's work_dir to the spec's
      // repoRoot — gc sling's target operand resolves it as a configured
      // agent, not a session alias
      const agentToml = readFileSync(join(fx.city, 'agents', 'fx-1', 'agent.toml'), 'utf8')
      assert.ok(agentToml.includes(`work_dir = "${fx.main}"`))
      const gdb = fx.gcDb()
      assert.deepEqual(gdb.rigs, [dirname(fx.beadsDir)])
      assert.equal(gdb.supervisor, true)
      assert.deepEqual(gdb.slung, [{ target: 'fx-1', bead: 'fx-1' }])
      assert.equal(gdb.sessions[0]!.alias, 'fx-1')
    } finally {
      cleanup(fx)
    }
  })

  test('spec.env lands in the per-step agent env table', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      await conn.spawn({
        ...SPEC(fx.main, fx.beadsDir, 'fx-1'),
        env: { BRO_PR: '7', BRO_PR_URL: 'https://x/pr/7', 'BAD-KEY': 'x' },
      })
      const agentToml = readFileSync(join(fx.city, 'agents', 'fx-1', 'agent.toml'), 'utf8')
      assert.match(agentToml, /BRO_PR = "7"/)
      assert.match(agentToml, /BRO_PR_URL = "https:\/\/x\/pr\/7"/)
      assert.ok(!agentToml.includes('BAD-KEY'))
      // the connector injects its own identity pins into the table
      assert.match(agentToml, new RegExp(`BEADS_DIR = "${fx.beadsDir.replaceAll('/', '\\/')}"`))
      assert.match(agentToml, /BRO_BEAD_ID = "fx-1"/)
    } finally {
      cleanup(fx)
    }
  })

  test('identity pins in spec.env cannot override the connector-owned values', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      await conn.spawn({
        ...SPEC(fx.main, fx.beadsDir, 'fx-1'),
        env: { BEADS_DIR: '/evil/store', BRO_BEAD_ID: 'other-bead', BRO_AGENT_ID: 'x', SAFE: '1' },
      })
      const agentToml = readFileSync(join(fx.city, 'agents', 'fx-1', 'agent.toml'), 'utf8')
      assert.ok(!agentToml.includes('/evil/store'))
      assert.ok(!agentToml.includes('other-bead'))
      assert.ok(!agentToml.includes('BRO_AGENT_ID'))
      assert.match(agentToml, /BRO_BEAD_ID = "fx-1"/)
      assert.match(agentToml, /SAFE = "1"/)
    } finally {
      cleanup(fx)
    }
  })

  test('TOML escapes every control char in env values', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      await conn.spawn({
        ...SPEC(fx.main, fx.beadsDir, 'fx-1'),
        env: { MSG: 'line1\r\nline2\x07bell', PATHY: 'a\\b"c\td' },
      })
      const agentToml = readFileSync(join(fx.city, 'agents', 'fx-1', 'agent.toml'), 'utf8')
      assert.ok(agentToml.includes('MSG = "line1\\r\\nline2\\u0007bell"'), agentToml)
      assert.ok(agentToml.includes('PATHY = "a\\\\b\\"c\\td"'), agentToml)
      // no raw control bytes survive into the generated config
      assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(agentToml))
    } finally {
      cleanup(fx)
    }
  })

  test('a prompt past the argv cap refuses spawn as bad input', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      const err = await conn
        .spawn({ ...SPEC(fx.main, fx.beadsDir, 'fx-1'), prompt: 'x'.repeat(200_000) })
        .then(() => null)
        .catch((e) => e)
      assert.ok(err instanceof SpawnError, `expected SpawnError, got ${err}`)
      assert.equal(err.kind, 'input')
      assert.match(String(err), /argv/)
      // refused before claiming or touching gc — bead still open, city
      // never even initialized
      assert.equal(fx.dbRows()[0]!.status, 'open')
      assert.ok(!existsSync(join(fx.city, '.fake-gc.json')))
    } finally {
      cleanup(fx)
    }
  })

  test('a live session on the step refuses a second spawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'))
      await assert.rejects(conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1')), SpawnError)
    } finally {
      cleanup(fx)
    }
  })

  test('a foreign claim (no registry entry) refuses spawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'in_progress', assignee: 'human' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      await assert.rejects(conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1')), SpawnError)
    } finally {
      cleanup(fx)
    }
  })

  test('respawn after session close reuses agentId via session reset', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      const first = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'))
      await conn.stop(first.id)
      const second = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'))
      assert.equal(second.id, first.id)
      assert.equal(second.state, 'running')
      // reset, not new — still one session
      assert.equal(fx.gcDb().sessions.length, 1)
      assert.equal(fx.gcDb().sessions[0]!.state, 'active')
    } finally {
      cleanup(fx)
    }
  })

  test('list maps session states; closed → exited', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'))
      assert.equal((await conn.list()).agents[0]!.state, 'running')
      await conn.stop(info.id)
      assert.equal((await conn.list()).agents[0]!.state, 'exited')
    } finally {
      cleanup(fx)
    }
  })

  test('missing session + reachable supervisor → lost; unreachable → degraded, not lost', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'))
      // purge the session record — the worker vanished from gc's ledger
      const db = fx.gcDb()
      db.sessions = []
      writeFileSync(join(fx.city, '.fake-gc.json'), JSON.stringify(db))
      assert.equal((await conn.list()).agents[0]!.state, 'lost')
      // supervisor unreadable → degraded read, agent omitted (fleet's 'unknown')
      process.env.FAKE_GC_FAIL = 'supervisor status'
      const l = await conn.list()
      assert.equal(l.degraded !== undefined, true)
      assert.equal(l.agents.length, 0)
      await conn.status(info.id).then(
        () => assert.fail('status should throw on degraded read'),
        (e) => assert.match(String(e), /supervisor not running/)
      )
    } finally {
      cleanup(fx)
    }
  })

  test('stop is idempotent; unknown ids are a no-op', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'))
      await conn.stop(info.id)
      await conn.stop(info.id)
      await conn.stop('gascity-deadbeef')
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.stopped, true)
    } finally {
      cleanup(fx)
    }
  })

  test('status on an unknown id throws AgentNotFound', async () => {
    const fx = fixture([])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      await assert.rejects(conn.status('gascity-nope'), AgentNotFound)
    } finally {
      cleanup(fx)
    }
  })

  test('no command configured → SpawnError before claiming or init', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, { agents: {}, connectors: {} })
      await assert.rejects(conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1')), SpawnError)
      assert.equal(fx.dbRows()[0]!.status, 'open')
      assert.equal(existsSync(join(fx.city, 'city.toml')), false)
    } finally {
      cleanup(fx)
    }
  })

  test('sling failure leaves a respawn-able lost entry with spawnError', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      process.env.FAKE_GC_FAIL = 'sling'
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      await assert.rejects(conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1')), SpawnError)
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.backend, 'gascity')
      assert.match(String(entry.spawnError), /sling/)
      // the orphan session was closed by the failure path
      assert.equal(fx.gcDb().sessions[0]!.closed, true)
    } finally {
      cleanup(fx)
    }
  })

  test('unparseable session-new output closes the alias orphan', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      process.env.FAKE_GC_GARBLE_NEW = '1'
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      await assert.rejects(conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1')), /unparseable/)
      // the session gc created but never reported is closed by alias
      assert.equal(fx.gcDb().sessions[0]!.closed, true)
    } finally {
      cleanup(fx)
    }
  })

  test('stop refuses to mark stopped when close fails and the session lives', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      const info = await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'))
      process.env.FAKE_GC_FAIL = 'session close'
      await assert.rejects(conn.stop(info.id), /session close/)
      assert.notEqual(readAgentRegistry(fx.main)['fx-1']!.stopped, true)
      // close failing on an already-gone session is still a clean stop
      const db = fx.gcDb()
      db.sessions = []
      writeFileSync(join(fx.city, '.fake-gc.json'), JSON.stringify(db))
      process.env.FAKE_GC_FAIL = ''
      await conn.stop(info.id)
      assert.equal(readAgentRegistry(fx.main)['fx-1']!.stopped, true)
    } finally {
      cleanup(fx)
    }
  })

  test('a stopped supervisor degrades a missing session, never reports lost', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      await conn.spawn(SPEC(fx.main, fx.beadsDir, 'fx-1'))
      const db = fx.gcDb()
      db.sessions = []
      writeFileSync(join(fx.city, '.fake-gc.json'), JSON.stringify(db))
      writeFileSync(join(fx.root, 'gc-supervisor'), 'false')
      const l = await conn.list()
      assert.equal(l.degraded !== undefined, true)
      assert.equal(l.agents.length, 0)
    } finally {
      cleanup(fx)
    }
  })

  test('matchDir claims the configDir layout only after init', async () => {
    const fx = fixture([])
    try {
      const conn = makeGascityConnector({ dir: fx.main }, fx.env)
      assert.equal(conn.matchDir!(fx.main), false)
      mkdirSync(fx.city, { recursive: true })
      writeFileSync(join(fx.city, 'city.toml'), '# city\n')
      assert.equal(conn.matchDir!(fx.main), true)
      // explicit connector pick resolves by name regardless
      assert.equal(
        resolveAgentConnector({ dir: fx.main }, { connector: 'gascity' }, fx.env).name,
        'gascity'
      )
    } finally {
      cleanup(fx)
    }
  })

  test('capabilities: attachable, respawnable, supervisor required', () => {
    const conn = makeGascityConnector({ dir: '/x' }, { agents: {}, connectors: {} })
    assert.deepEqual(conn.capabilities(), {
      attach: true,
      respawn: true,
      supervisor: 'required',
    })
  })

  test('loadAgentEnv reads agents.gascity knobs', () => {
    const { root, main } = initRepo('bro-gcenv-')
    try {
      writeFileSync(
        join(main, 'bro.config.json'),
        JSON.stringify({ agents: { gascity: { configDir: '/c', template: 'w', command: 'gc-agent' } } })
      )
      const env = loadAgentEnv(main)
      assert.equal(env.agents['gascity']!.configDir, '/c')
      assert.equal(env.agents['gascity']!.template, 'w')
      assert.equal(env.agents['gascity']!.command, 'gc-agent')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
