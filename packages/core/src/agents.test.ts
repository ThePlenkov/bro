import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  acquireAgentRegistryLock,
  agentRegistryPath,
  agentsSection,
  bdAt,
  claimStep,
  mintAgentId,
  patchAgentRegistry,
  probeStep,
  readAgentRegistry,
  rebindStep,
  SpawnError,
  withAgentRegistryLock,
  writeAgentRegistry,
} from './agents.ts'

const withRepo = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-agents-'))
  try {
    execFileSync('git', ['init', '-q', dir])
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Minimal bd shim — a JSON-file store. `show`/`update --claim`/
 *  `update --assignee` cover the claim probes the facade makes. */
const FAKE_BD = `#!/usr/bin/env node
const fs = require('node:fs')
const DB = process.env.BEADS_DIR + '/store.json'
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')) } catch { return { rows: [] } } }
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db))
const args = process.argv.slice(2).filter((a) => a !== '--json')
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
      r.assignee = 'claimer'
    } else {
      r[k] = args[++i]
    }
  }
  save(db)
} else {
  console.error('unhandled: ' + args.join(' ')); process.exit(1)
}
`

const withFakeBd = (fn: (binDir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fakebd-'))
  try {
    writeFileSync(join(dir, 'bd'), FAKE_BD)
    execFileSync('chmod', ['+x', join(dir, 'bd')])
    const prev = process.env.PATH
    process.env.PATH = `${dir}:${prev}`
    try {
      fn(dir)
    } finally {
      process.env.PATH = prev
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const seedStore = (dir: string, rows: Record<string, unknown>[]): string => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'store.json'), JSON.stringify({ rows }))
  return dir
}

const withStore = (rows: Record<string, unknown>[], fn: (store: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-beads-'))
  try {
    fn(seedStore(dir, rows))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('agentRegistryPath', () => {
  test('resolves to <git-common-dir>/bro/agents.json', () => {
    withRepo((dir) => {
      assert.equal(agentRegistryPath(dir), join(dir, '.git', 'bro', 'agents.json'))
    })
  })

  test('null outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-agents-'))
    try {
      assert.equal(agentRegistryPath(dir), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('agent registry IO', () => {
  test('round-trips entries; absent dir reads empty', () => {
    withRepo((dir) => {
      assert.deepEqual(readAgentRegistry(dir), {})
      writeAgentRegistry(dir, {
        'bro-x': { agentId: 'native-ab12', backend: 'native', spawnedAt: '2026-01-01T00:00:00Z', pid: 42 },
      })
      const reg = readAgentRegistry(dir)
      assert.equal(reg['bro-x']!.agentId, 'native-ab12')
      assert.equal(reg['bro-x']!.pid, 42)
    })
  })

  test('torn entries (no agentId/backend) are dropped on read', () => {
    withRepo((dir) => {
      const path = agentRegistryPath(dir)!
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(
        path,
        JSON.stringify({ good: { agentId: 'a', backend: 'native', spawnedAt: 't' }, bad: { pid: 1 } })
      )
      const reg = readAgentRegistry(dir)
      assert.equal(Object.keys(reg).length, 1)
      assert.equal(reg['good']!.agentId, 'a')
    })
  })

  test('malformed json reads empty, not a crash', () => {
    withRepo((dir) => {
      const path = agentRegistryPath(dir)!
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, '{oops')
      assert.deepEqual(readAgentRegistry(dir), {})
    })
  })

  test('patch merges over the existing entry and preserves extras', () => {
    withRepo((dir) => {
      patchAgentRegistry(dir, 'bro-x', {
        agentId: 'native-ab12',
        backend: 'native',
        spawnedAt: 't0',
        pid: 42,
      })
      patchAgentRegistry(dir, 'bro-x', { exitStatus: 3 })
      const e = readAgentRegistry(dir)['bro-x']!
      assert.equal(e.pid, 42)
      assert.equal(e.exitStatus, 3)
      assert.equal(e.agentId, 'native-ab12')
    })
  })
})

describe('registry lock', () => {
  test('withAgentRegistryLock re-enters — a patch inside the section works', () => {
    withRepo((dir) => {
      const order: string[] = []
      withAgentRegistryLock(dir, () => {
        order.push('outer')
        patchAgentRegistry(dir, 'bro-x', {
          agentId: 'native-ab12',
          backend: 'native',
          spawnedAt: 't0',
        })
        order.push('inner')
      })
      assert.deepEqual(order, ['outer', 'inner'])
      assert.equal(readAgentRegistry(dir)['bro-x']!.agentId, 'native-ab12')
      // released — no lock file left behind
      assert.equal(existsSync(`${agentRegistryPath(dir)!}.lock`), false)
    })
  })

  test('a stale lock file (crashed holder) is broken, not waited on', () => {
    withRepo((dir) => {
      const lock = `${agentRegistryPath(dir)!}.lock`
      mkdirSync(dirname(lock), { recursive: true })
      writeFileSync(lock, 'dead holder')
      const past = new Date(Date.now() - 120_000)
      utimesSync(lock, past, past)
      const release = acquireAgentRegistryLock(dir)
      release()
      assert.equal(existsSync(lock), false)
    })
  })

  test('a live holder’s lock is never stolen — the contender fails, the lock survives', () => {
    withRepo((dir) => {
      const lock = `${agentRegistryPath(dir)!}.lock`
      mkdirSync(dirname(lock), { recursive: true })
      // a real holder token is <pid>:<hex>; our own pid is alive and the
      // file is way past the old age-only break — a slow-but-alive
      // backend start (gascity's multi-minute section) must not be
      // double-entered
      writeFileSync(lock, `${process.pid}:cafe`)
      const past = new Date(Date.now() - 10 * 60_000)
      utimesSync(lock, past, past)
      assert.throws(() => acquireAgentRegistryLock(dir, { waitMs: 200 }), /lock held/)
      assert.equal(readFileSync(lock, 'utf8'), `${process.pid}:cafe`)
    })
  })

  test('a dead-pid lock is broken — the contender recovers the section', () => {
    withRepo((dir) => {
      const lock = `${agentRegistryPath(dir)!}.lock`
      mkdirSync(dirname(lock), { recursive: true })
      // a pid that has already exited — spawnSync returns after death
      const dead = spawnSync(process.execPath, ['-e', '']).pid!
      writeFileSync(lock, `${dead}:cafe`)
      const past = new Date(Date.now() - 120_000)
      utimesSync(lock, past, past)
      const release = acquireAgentRegistryLock(dir, { waitMs: 5_000 })
      release()
      assert.equal(existsSync(lock), false)
    })
  })

  test('release never removes a lock a contender re-acquired', () => {
    withRepo((dir) => {
      const lock = `${agentRegistryPath(dir)!}.lock`
      mkdirSync(dirname(lock), { recursive: true })
      const release = acquireAgentRegistryLock(dir)
      // our section overran the stale window: the file was broken and
      // re-created by another holder — releasing must not delete THEIRS
      rmSync(lock)
      writeFileSync(lock, 'other-holder')
      release()
      assert.equal(readFileSync(lock, 'utf8'), 'other-holder')
    })
  })

  test('a lost patch is impossible under the lock — concurrent writers serialize', () => {
    withRepo((dir) => {
      // two writers, one lock each at a time — both patches land
      withAgentRegistryLock(dir, () => {
        const reg = readAgentRegistry(dir)
        reg['a'] = { agentId: 'a1', backend: 'native', spawnedAt: 't' }
        writeAgentRegistry(dir, reg)
      })
      patchAgentRegistry(dir, 'b', { agentId: 'b1', backend: 'native', spawnedAt: 't' })
      const reg = readAgentRegistry(dir)
      assert.equal(reg['a']!.agentId, 'a1')
      assert.equal(reg['b']!.agentId, 'b1')
    })
  })
})

describe('mintAgentId', () => {
  test('backend-prefixed hex, unique per call', () => {
    const a = mintAgentId('native')
    const b = mintAgentId('native')
    assert.match(a, /^native-[0-9a-f]{8}$/)
    assert.notEqual(a, b)
  })
})

describe('shared-store claims', () => {
  test('probeStep reads status/assignee; missing bead → undefined', () => {
    withFakeBd(() => {
      withStore([{ id: 'fx-1', status: 'in_progress', assignee: 'me' }], (store) => {
        const p = probeStep(store, 'fx-1')
        assert.equal(p!.status, 'in_progress')
        assert.equal(p!.assignee, 'me')
        assert.equal(probeStep(store, 'fx-nope'), undefined)
      })
    })
  })

  test('claimStep flips to in_progress; a second claim throws SpawnError', () => {
    withFakeBd(() => {
      withStore([{ id: 'fx-1', status: 'open' }], (store) => {
        claimStep(store, 'fx-1')
        assert.equal(probeStep(store, 'fx-1')!.status, 'in_progress')
        assert.throws(() => claimStep(store, 'fx-1'), SpawnError)
      })
    })
  })

  test('rebindStep moves the assignee without touching status', () => {
    withFakeBd(() => {
      withStore([{ id: 'fx-1', status: 'in_progress', assignee: 'dead-worker' }], (store) => {
        rebindStep(store, 'fx-1', 'new-worker')
        const p = probeStep(store, 'fx-1')
        assert.equal(p!.status, 'in_progress')
        assert.equal(p!.assignee, 'new-worker')
      })
    })
  })

  test('bdAt reports bd failure without throwing', () => {
    withFakeBd(() => {
      withStore([], (store) => {
        const r = bdAt(store, ['bogus'])
        assert.equal(r.code, 1)
        assert.match(r.err, /unhandled/)
      })
    })
  })
})

describe('agentsSection', () => {
  test('keeps per-backend object bags, drops scalars and arrays', () => {
    const s = agentsSection({
      native: { command: 'devin -p' },
      gascity: { configDir: '~/.gascity' },
      bad: 'string',
      worse: [1, 2],
    })
    assert.deepEqual(s, {
      native: { command: 'devin -p' },
      gascity: { configDir: '~/.gascity' },
    })
  })

  test('missing/non-object section → empty', () => {
    assert.deepEqual(agentsSection(undefined), {})
    assert.deepEqual(agentsSection('nope'), {})
    assert.deepEqual(agentsSection([]), {})
  })
})
