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
  readAgentRegistry,
  SpawnError,
  AgentNotFound,
} from '@broject/core'
import {
  agentConnectorNames,
  eachAgentConnector,
  loadAgentEnv,
  makeNativeConnector,
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
      if (r.status === 'in_progress') { console.error('already claimed'); process.exit(1) }
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

interface Fixture {
  root: string
  main: string
  beadsDir: string
  env: AgentConnectorEnv
  prevPath: string
  dbRows(): Array<Record<string, unknown>>
}

/** Real git repo + fake bd on PATH + a beadsDir store. The agent
 *  command is `node {promptFile}` — the prompt IS the program. */
function fixture(
  rows: Array<Record<string, unknown>>,
  command = 'node {promptFile}'
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
  const prevPath = process.env.PATH ?? ''
  process.env.PATH = `${binDir}:${prevPath}`
  return {
    root,
    main,
    beadsDir,
    env: { agents: { native: { command } }, connectors: {} },
    prevPath,
    dbRows: () => JSON.parse(readFileSync(db, 'utf8')).rows,
  }
}

function cleanup(fx: Fixture): void {
  process.env.PATH = fx.prevPath
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
      assert.deepEqual(agentConnectorNames(), ['native'])
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

  test('capabilities: self-supervised, respawnable, no attach', () => {
    const conn = makeNativeConnector({ dir: '/x' }, { agents: {}, connectors: {} })
    assert.deepEqual(conn.capabilities(), {
      attach: false,
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
    assert.deepEqual(conns.map((c) => c.name), ['native'])
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
