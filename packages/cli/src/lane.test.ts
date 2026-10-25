import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentRegistryPath,
  laneGateTake,
  procStat,
  scrubEnv,
  writeAgentRegistry,
  type AgentRegistryEntry,
  type SpawnSpec,
} from '@broject/core'
import { laneGateRefusal, laneStatus, reconcileLanePause } from './lane.ts'
import { initRepo, inside, tmpDir } from './commands/testrepo.ts'
import { type AgentConnectorEnv } from './agent-connectors.ts'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

const env = (providers?: AgentConnectorEnv['providers']): AgentConnectorEnv => ({
  agents: {},
  connectors: {},
  ...(providers === undefined ? {} : { providers }),
})

const gatedDevin = {
  type: 'cli' as const,
  command: 'devin -p {promptFile}',
  rateGate: { requestsPerHour: 240, spawnCost: 60, burst: 60 },
}

const batchSpec = (provider?: string): SpawnSpec => ({
  molStep: 'fx-step',
  prompt: 'p',
  repoRoot: process.cwd(),
  beadsDir: process.cwd(),
  env: { BRO_BATCH: '1' },
  provider,
})

const withXdg = <T>(fn: (stateDir: string) => T): T => {
  const stateDir = tmpDir('bro-lane-xdg-')
  const prev = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateDir
  try {
    return fn(stateDir)
  } finally {
    if (prev === undefined) {
      delete process.env.XDG_STATE_HOME
    } else {
      process.env.XDG_STATE_HOME = prev
    }
  }
}

describe('the lane rate gate', () => {
  test('a batch spawn pays its cost; an empty bucket refuses as cap', () => {
    withXdg(() => {
      const e = env({ devin: gatedDevin })
      assert.equal(laneGateRefusal(e, batchSpec('devin')), undefined) // take 1 drains burst=60
      const err = laneGateRefusal(e, batchSpec('devin'))
      assert.ok(err instanceof Error)
      assert.equal((err as { kind?: string }).kind, 'cap')
      assert.match(err.message, /lane 'devin' out of request budget/)
    })
  })

  test('interactive spawns never consult the gate', () => {
    withXdg(() => {
      const e = env({ devin: gatedDevin })
      laneGateTake('devin', '(default)', gatedDevin.rateGate) // drain
      const interactive = { ...batchSpec('devin'), env: {} }
      assert.equal(laneGateRefusal(e, interactive), undefined)
    })
  })

  test('an ungated provider never refuses', () => {
    const e = env({ devin: { type: 'cli', command: 'x {promptFile}' } })
    assert.equal(laneGateRefusal(e, batchSpec('devin')), undefined)
    assert.equal(laneGateRefusal(e, batchSpec()), undefined)
  })

  test('a shared lane name draws one budget across providers', () => {
    withXdg(() => {
      const acp = { type: 'acp' as const, command: 'devin acp', rateGate: { ...gatedDevin.rateGate, lane: 'devin' } }
      const e = env({ devin: gatedDevin, 'devin-acp': acp })
      laneGateRefusal(e, batchSpec('devin')) // drains the shared bucket
      const err = laneGateRefusal(e, batchSpec('devin-acp'))
      assert.ok(err instanceof Error)
      assert.match(err.message, /lane 'devin' out of request budget/)
    })
  })
})

// --- the wall pause -----------------------------------------------------

/** A real detached sleeper to stand in for a worker process group. */
const sleeper = (): { pid: number; pidStart: string | undefined; kill: () => void } => {
  const child = spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' })
  child.unref()
  const pid = child.pid as number
  return {
    pid,
    pidStart: procStat(pid)?.start,
    kill: () => {
      try {
        process.kill(-pid, 'SIGCONT')
      } catch {}
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    },
  }
}

const procState = (pid: number): string | undefined => {
  try {
    return procStat(pid)?.state
  } catch {
    return undefined
  }
}

const deadWallEntry = (resetAt: string): AgentRegistryEntry => ({
  agentId: 'native-dead',
  backend: 'native',
  spawnedAt: '2026-10-20T00:00:00Z',
  provider: 'devin',
  cause: 'rate_limited',
  resetAt,
})

const liveEntry = (pid: number, pidStart: string | undefined): AgentRegistryEntry => ({
  agentId: `native-${pid.toString(16)}`,
  backend: 'native',
  spawnedAt: new Date().toISOString(),
  provider: 'devin',
  pid,
  pidStart,
})

const writeRegistry = (dir: string, entries: Record<string, AgentRegistryEntry>): void => {
  const path = agentRegistryPath(dir)
  assert.ok(path !== null)
  mkdirSync(join(path, '..'), { recursive: true })
  writeAgentRegistry(dir, entries)
}

describe('the wall pause', () => {
  test('a walled provider freezes its live workers; a lifted wall thaws them', () => {
    const { root, main } = initRepo('bro-lane-')
    inside(main, root, () => {
      const s = sleeper()
      try {
        const future = new Date(Date.now() + 3600_000).toISOString()
        writeRegistry(main, { 'fx-dead': deadWallEntry(future), 'fx-live': liveEntry(s.pid, s.pidStart) })
        const r = reconcileLanePause(main, env({ devin: { type: 'cli', command: 'x' } }))
        assert.equal(r.paused, 1)
        assert.equal(procState(s.pid), 'T')
        // the record landed — a re-run holds the pause, not re-stops
        const pause = JSON.parse(
          readFileSync(join(agentRegistryPath(main)!, '..', 'lane-pause.json'), 'utf8')
        )
        assert.equal(pause.paused[String(s.pid)].provider, 'devin')
        assert.equal(reconcileLanePause(main, env()).paused, 1)
        // lift the wall — the dead record stops, the lane thaws
        writeRegistry(main, {
          'fx-dead': { ...deadWallEntry(future), stopped: true },
          'fx-live': liveEntry(s.pid, s.pidStart),
        })
        const r2 = reconcileLanePause(main, env())
        assert.equal(r2.paused, 0)
        assert.equal(r2.thawed, 1)
        assert.notEqual(procState(s.pid), 'T')
      } finally {
        s.kill()
      }
    })
  })

  test('wallPause: false leaves the provider alone', () => {
    const { root, main } = initRepo('bro-lane-')
    inside(main, root, () => {
      const s = sleeper()
      try {
        const future = new Date(Date.now() + 3600_000).toISOString()
        writeRegistry(main, { 'fx-dead': deadWallEntry(future), 'fx-live': liveEntry(s.pid, s.pidStart) })
        const r = reconcileLanePause(
          main,
          env({ devin: { type: 'cli', command: 'x', wallPause: false } })
        )
        assert.equal(r.paused, 0)
        assert.notEqual(procState(s.pid), 'T')
      } finally {
        s.kill()
      }
    })
  })

  test('dead pids drop from the pause file without a signal', () => {
    const { root, main } = initRepo('bro-lane-')
    inside(main, root, () => {
      const s = sleeper()
      const future = new Date(Date.now() + 3600_000).toISOString()
      writeRegistry(main, { 'fx-dead': deadWallEntry(future), 'fx-live': liveEntry(s.pid, s.pidStart) })
      reconcileLanePause(main, env())
      assert.equal(procState(s.pid), 'T')
      s.kill()
      // the group is gone — the record drops, nothing signaled
      const r = reconcileLanePause(main, env())
      assert.equal(r.paused, 0)
      const pause = JSON.parse(
        readFileSync(join(agentRegistryPath(main)!, '..', 'lane-pause.json'), 'utf8')
      )
      assert.deepEqual(pause.paused, {})
    })
  })
})

describe('the lane status', () => {
  test('walls, paused counts, and armed gates render', () => {
    const { root, main } = initRepo('bro-lane-')
    inside(main, root, () =>
      withXdg(() => {
        const future = new Date(Date.now() + 3600_000).toISOString()
        writeRegistry(main, { 'fx-dead': deadWallEntry(future) })
        laneGateTake('devin', '(default)', gatedDevin.rateGate)
        const rows = laneStatus(main, env({ devin: gatedDevin }))
        const devin = rows.find((r) => r.provider === 'devin')
        assert.ok(devin !== undefined)
        assert.equal(devin.wall?.cause, 'rate_limited')
        assert.deepEqual(devin.gate, [{ model: '(default)', tokens: 0, capacity: 60 }])
      })
    )
  })

  test('no walls, no pause, no gate — an empty section', () => {
    const { root, main } = initRepo('bro-lane-')
    inside(main, root, () => {
      assert.deepEqual(laneStatus(main, env()), [])
    })
  })
})
