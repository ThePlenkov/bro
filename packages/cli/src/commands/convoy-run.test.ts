import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  AgentNotFound,
  SpawnError,
  type AgentCause,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
} from '@broject/core'
import type { ConvoyNext, Molecule } from '@broject/convoy'
import {
  runArgs,
  runnerPrompt,
  runMol,
  runQueue,
  type RunDeps,
} from './convoy-run.ts'

const mol = (id: string): Molecule => ({
  root: { id, title: id, status: 'open', issue_type: 'molecule' },
  issues: [],
  dependencies: [],
})

const next = (
  state: ConvoyNext['state'],
  gates: string[] = [],
  over: Partial<ConvoyNext> = {}
): ConvoyNext => ({
  mol: 'm',
  state,
  ready: [],
  gates,
  inProgress: [],
  blocked: [],
  stuck: [],
  ...over,
})

const agent = (id: string, state: AgentState = 'running', over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  molStep: 'm-1',
  backend: 'native',
  state,
  ...over,
})

interface World {
  deps: RunDeps
  spawns: string[]
  sleeps: number[]
  /** scripted nextStep states per mol — shifted per call, last repeats */
  nexts: Map<string, ConvoyNext[]>
  /** scripted status() returns per agent — shifted per call, last repeats.
   *  An entry is an AgentState or a fuller {state, cause, resetAt, spawnedAt}. */
  states: Map<string, (AgentState | Pick<AgentInfo, 'state' | 'cause' | 'resetAt' | 'spawnedAt'>)[]>
  entries: Map<string, AgentRegistryEntry>
  full: boolean
}

function world(over: Partial<World> = {}): World {
  const w: World = {
    spawns: [],
    sleeps: [],
    nexts: new Map(),
    states: new Map(),
    entries: new Map(),
    full: false,
    ...over,
    deps: undefined as unknown as RunDeps,
  }
  w.deps = {
    loadMol: (id) => {
      if (!w.nexts.has(id)) throw new Error(`molecule ${id} not found`)
      return mol(id)
    },
    next: (m) => {
      const q = w.nexts.get(m.root.id) ?? []
      return q.length > 1 ? q.shift()! : (q[0] ?? next('complete'))
    },
    listOpen: () => [...w.nexts.keys()].map((id) => ({ id })),
    spawn: async (molId) => {
      w.spawns.push(molId)
      return agent(`n-${w.spawns.length}`)
    },
    status: async (id) => {
      const q = w.states.get(id) ?? ['exited']
      const item = q.length > 1 ? q.shift()! : q[0]!
      const d = typeof item === 'string' ? { state: item } : item
      if (d.state === 'lost') throw new AgentNotFound(id)
      return agent(id, d.state, { cause: d.cause, resetAt: d.resetAt, spawnedAt: d.spawnedAt })
    },
    entry: (molId) => w.entries.get(molId),
    entryState: (e) => (e.stopped === true ? 'stopped' : 'exited'),
    fleetFull: () => w.full,
    sleepSec: async (s) => void w.sleeps.push(s),
    now: () => 1_000_000,
    say: () => {},
  }
  return w
}

const CFG = { mols: [], open: false, attempts: 4, pollSec: 15, retryDelaySec: 60, json: false }

describe('runArgs', () => {
  test('defaults', () => {
    assert.deepEqual(runArgs(['m-1']), {
      mols: ['m-1'],
      open: false,
      attempts: 4,
      pollSec: 15,
      retryDelaySec: 60,
      json: false,
    })
  })

  test('flags parse — both spellings', () => {
    const a = runArgs(['m-1', 'm-2', '--open', '--attempts', '2', '--poll=5', '--retry-delay', '9', '--json'])
    assert.equal(a.open, true)
    assert.equal(a.attempts, 2)
    assert.equal(a.pollSec, 5)
    assert.equal(a.retryDelaySec, 9)
    assert.equal(a.json, true)
    assert.deepEqual(a.mols, ['m-1', 'm-2'])
  })
})

describe('runnerPrompt', () => {
  test('carries the mol id, repo, and the convoy contract', () => {
    const p = runnerPrompt('bro-mol-x', '/repo/here')
    assert.match(p, /molecule bro-mol-x/)
    assert.match(p, /bro convoy next --mol bro-mol-x/)
    assert.match(p, /\/repo\/here/)
    assert.match(p, /state: complete/)
    assert.match(p, /bro act merge/)
  })
})

describe('runMol', () => {
  test('already-complete mol skips without spawning', async () => {
    const w = world()
    w.nexts.set('m-1', [next('complete')])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.deepEqual(w.spawns, [])
  })

  test('a ready human gate is gated, never spawned', async () => {
    const w = world()
    w.nexts.set('m-1', [next('gate', ['g-1'])])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'gated')
    assert.equal(r.detail, 'g-1')
    assert.deepEqual(w.spawns, [])
  })

  test('unreadable mol is an error verdict', async () => {
    const w = world()
    const r = await runMol(w.deps, CFG, 'nope')
    assert.equal(r.verdict, 'error')
    assert.match(r.detail ?? '', /not found/)
  })

  test('spawn → run → exit → mol complete = done in one attempt', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step'), next('complete')])
    w.states.set('n-1', ['running', 'exited'])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.equal(r.attempts, 1)
    assert.deepEqual(w.spawns, ['m-1'])
  })

  test('a crash respawns — done on the second attempt', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step'), next('step'), next('step'), next('complete')])
    // lived 400s — past the fast-fail window, flat retry-delay applies
    w.states.set('n-1', [
      { state: 'exited', spawnedAt: new Date(1_000_000 - 400_000).toISOString() },
    ])
    w.states.set('n-2', ['exited'])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.equal(r.attempts, 2)
    assert.deepEqual(w.spawns, ['m-1', 'm-1'])
    assert.deepEqual(w.sleeps, [15, 60, 15]) // poll, retry-delay, poll
  })

  test('fast exits back off — the 900/1800/3600 ramp, capped', async () => {
    const w = world()
    // no spawnedAt → lifetime ~0 — a crash loop, never real work
    w.nexts.set('m-1', [
      next('step'), next('step'), next('step'), next('step'),
      next('step'), next('step'), next('step'), next('complete'),
    ])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.equal(r.attempts, 4)
    assert.deepEqual(w.sleeps, [15, 900, 15, 1800, 15, 3600, 15])
  })

  test('a slow exit pays flat retry-delay and resets the ramp', async () => {
    const w = world()
    w.nexts.set('m-1', [
      next('step'), next('step'), next('step'), next('step'),
      next('step'), next('step'), next('step'), next('complete'),
    ])
    // n-2 did real work (spawned 400s ago) — its death is a crash, not a loop
    w.states.set('n-2', [
      { state: 'exited', spawnedAt: new Date(1_000_000 - 400_000).toISOString() },
    ])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.equal(r.attempts, 4)
    assert.deepEqual(w.sleeps, [15, 900, 15, 60, 15, 900, 15])
  })

  test('a closed dependency loop is reported blocked — never spawned', async () => {
    const w = world()
    w.nexts.set('m-1', [
      next('blocked', [], { blocked: ['s-1', 's-2'], stuck: ['s-1', 's-2'] }),
    ])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'blocked')
    assert.match(r.detail ?? '', /dependency cycle: s-1, s-2/)
    assert.deepEqual(w.spawns, [])
  })

  test('blocked on open work still spawns — a claim is not a cycle', async () => {
    const w = world()
    // blocked, but every blocker is open work (in_progress claim) — a
    // worker can release and re-claim it
    w.nexts.set('m-1', [
      next('blocked', [], { blocked: ['s-1'], inProgress: ['s-0'], stuck: [] }),
      next('complete'),
    ])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.equal(w.spawns.length, 1)
  })

  test('a stuck step discovered after the run is blocked, not a burned retry', async () => {
    const w = world()
    w.nexts.set('m-1', [
      next('step'),
      next('blocked', [], { blocked: ['s-2'], stuck: ['s-2'] }),
    ])
    w.states.set('n-1', ['exited'])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'blocked')
    assert.equal(w.spawns.length, 1)
  })

  test('attempts cap lands — failed', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step')])
    const r = await runMol(w.deps, { ...CFG, attempts: 2 }, 'm-1')
    assert.equal(r.verdict, 'failed')
    assert.equal(r.attempts, 2)
    assert.equal(w.spawns.length, 2)
  })

  test('operator-stopped agent is never respawned', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step')])
    w.states.set('n-1', ['stopped'])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'stopped')
    assert.equal(w.spawns.length, 1)
  })

  test('rate_limited with a reset waits it out — no attempt burned', async () => {
    const w = world()
    // before / after / post-wait re-check / final — each consumes a state
    w.nexts.set('m-1', [next('step'), next('step'), next('step'), next('complete')])
    w.states.set('n-1', [
      {
        state: 'blocked',
        cause: 'rate_limited',
        resetAt: new Date(1_000_000 + 900_000).toISOString(),
      },
    ])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.equal(r.attempts, 1) // the wall wait is not a mol failure
    assert.deepEqual(w.spawns, ['m-1', 'm-1'])
    assert.ok(w.sleeps.includes(900)) // slept until the provider reset
  })

  /** The shared parked-block rig: the worker dies blocked on `cause`,
   *  the registry entry agrees, and the run must park the mol. */
  const parkedBlock = async (w: World, cause: AgentCause) => {
    w.nexts.set('m-1', [next('step')])
    w.states.set('n-1', [{ state: 'blocked', cause }])
    w.entries.set('m-1', {
      agentId: 'n-1',
      backend: 'native',
      spawnedAt: 'x',
      cause,
    })
    return runMol(w.deps, CFG, 'm-1')
  }

  test('quota parks the mol — a wall with no end is reported, not waited', async () => {
    const w = world()
    const r = await parkedBlock(w, 'quota')
    assert.equal(r.verdict, 'parked')
    assert.match(r.detail ?? '', /quota/)
    assert.equal(w.spawns.length, 1)
  })

  test('rate_limited with no reported reset parks, not an infinite wait', async () => {
    const w = world()
    const r = await parkedBlock(w, 'rate_limited')
    assert.equal(r.verdict, 'parked')
    assert.match(r.detail ?? '', /no reset/)
  })

  test('a lost agent counts as an attempt and respawns', async () => {
    const w = world()
    // top-of-loop re-check consumes one 'step' before the respawn
    w.nexts.set('m-1', [next('step'), next('step'), next('step'), next('complete')])
    w.states.set('n-1', ['lost'])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.equal(r.attempts, 2)
    assert.equal(w.spawns.length, 2)
  })

  test('spawn refusal on a blocked entry waits for the reset', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step'), next('step'), next('complete')])
    let refused = true
    w.deps.spawn = async (molId) => {
      w.spawns.push(molId)
      if (refused) {
        refused = false
        throw new SpawnError('respawn of m-1 refused — rate_limited until reset')
      }
      return agent('n-1')
    }
    w.entries.set('m-1', {
      agentId: 'n-0',
      backend: 'native',
      spawnedAt: 'x',
      cause: 'rate_limited',
      resetAt: new Date(1_000_000 + 300_000).toISOString(),
    })
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.ok(w.sleeps.includes(300))
    assert.equal(w.spawns.length, 2)
  })

  test('a full fleet cap waits a poll tick — capacity is not an attempt', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step'), next('step'), next('complete')])
    let calls = 0
    w.deps.spawn = async (molId) => {
      w.spawns.push(molId)
      calls += 1
      if (calls === 1) {
        throw new SpawnError('fleet cap reached — 3/3 agent slots occupied', 'cap')
      }
      return agent('n-1')
    }
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.deepEqual(w.sleeps[0], 15) // waited one poll tick, not an attempt
    assert.equal(r.attempts, 1) // only the successful spawn counted
  })

  test('an untyped refusal while the fleet reads full also waits', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step'), next('step'), next('complete')])
    let calls = 0
    // a foreign connector's cap refusal carries no kind — the
    // occupancy re-check still reads it as capacity, never an attempt
    w.deps.fleetFull = () => calls === 1
    w.deps.spawn = async (molId) => {
      w.spawns.push(molId)
      calls += 1
      if (calls === 1) {
        throw new SpawnError('spawn refused — backend at capacity', 'conflict')
      }
      return agent('n-1')
    }
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'done')
    assert.deepEqual(w.sleeps[0], 15)
  })

  test('a live registry entry on refusal means occupied — never double-work', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step')])
    w.deps.spawn = async () => {
      w.spawns.push('m-1')
      throw new SpawnError('m-1 already has a live agent')
    }
    w.entries.set('m-1', { agentId: 'n-9', backend: 'native', spawnedAt: 'x' })
    w.deps.entryState = () => 'running'
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'occupied')
    assert.equal(w.spawns.length, 1)
  })

  test('a stopped registry entry on refusal is the operator verdict', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step')])
    w.deps.spawn = async () => {
      throw new SpawnError('m-1 is claimed by someone')
    }
    w.entries.set('m-1', { agentId: 'n-9', backend: 'native', spawnedAt: 'x', stopped: true })
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'stopped')
  })

  test('a bare refusal with no entry and a free fleet burns an attempt', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step')])
    w.deps.spawn = async () => {
      throw new SpawnError('claim refused', 'conflict')
    }
    const r = await runMol(w.deps, { ...CFG, attempts: 2, retryDelaySec: 1 }, 'm-1')
    assert.equal(r.verdict, 'failed')
    assert.equal(r.attempts, 2)
  })

  test('gate reached after the run is still gated, not failed', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step'), next('gate', ['g-9'])])
    w.states.set('n-1', ['exited'])
    const r = await runMol(w.deps, CFG, 'm-1')
    assert.equal(r.verdict, 'gated')
    assert.equal(r.detail, 'g-9')
  })
})

describe('runQueue', () => {
  test('runs mols in order; a failure does not stop the queue', async () => {
    const w = world()
    w.nexts.set('m-1', [next('step'), next('complete')])
    w.nexts.set('m-2', [next('step'), next('step'), next('step'), next('step'), next('step')])
    w.nexts.set('m-3', [next('complete')])
    const rs = await runQueue(w.deps, { ...CFG, mols: ['m-1', 'm-2', 'm-3'], attempts: 2 })
    assert.deepEqual(rs.map((r) => r.verdict), ['done', 'failed', 'done'])
  })

  test('a gated verdict fires onGated at settle — before the next mol runs', async () => {
    const w = world()
    const seq: string[] = []
    w.nexts.set('m-gate', [next('gate', ['g-1'])])
    w.nexts.set('m-done', [next('complete')])
    w.deps.onGated = async (r) => void seq.push(`gated:${r.mol}`)
    const origNext = w.deps.next
    w.deps.next = (m) => {
      seq.push(`next:${m.root.id}`)
      return origNext(m)
    }
    const rs = await runQueue(w.deps, { ...CFG, mols: ['m-gate', 'm-done'] })
    assert.equal(rs[0].verdict, 'gated')
    assert.deepEqual(seq, ['next:m-gate', 'gated:m-gate', 'next:m-done'])
  })

  test('--open merges the open set without duplicating named mols', async () => {
    const w = world()
    w.nexts.set('m-1', [next('complete')])
    w.nexts.set('m-2', [next('complete')])
    const rs = await runQueue(w.deps, { ...CFG, mols: ['m-1'], open: true })
    assert.deepEqual(rs.map((r) => r.mol), ['m-1', 'm-2'])
    assert.equal(w.spawns.length, 0)
  })
})
