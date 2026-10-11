/** The session pulse (bro-killn) — want-marker round-trips, lock
 *  liveness, the orchestrator predicate, and the session-start nudge. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { initRepo } from './testrepo.ts'
import {
  armPulse,
  disarmPulse,
  isOrchestratorSession,
  pulseLive,
  pulseLockPath,
  pulseMarkerPath,
  pulseNudge,
  pulseRearm,
  pulseSpawnPath,
  readPulseMarker,
  readPulseSpawn,
  writePulseSpawn,
} from './watch-pulse.ts'

const DEAD = 1 << 30

const lock = (main: string, content: string): void => {
  const p = pulseLockPath(main)!
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

describe('paths', () => {
  test('marker + lock resolve under <git-common>/bro', () => {
    const { root, main } = initRepo('bro-pulse-path-')
    try {
      assert.equal(pulseMarkerPath(main), join(main, '.git', 'bro', 'pulse.json'))
      assert.equal(pulseLockPath(main), join(main, '.git', 'bro', 'pulse.lock'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('marker', () => {
  test('absent and malformed read as null — never a half-shape rearm', () => {
    const { root, main } = initRepo('bro-pulse-mk-')
    try {
      assert.equal(readPulseMarker(main), null)
      const file = pulseMarkerPath(main)!
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'not json')
      assert.equal(readPulseMarker(main), null)
      writeFileSync(file, JSON.stringify({ everySec: '60' }))
      assert.equal(readPulseMarker(main), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('arm → already → updated; disarm → disarmed → absent', () => {
    const { root, main } = initRepo('bro-pulse-arm-')
    try {
      const a = armPulse(main, 120)
      assert.equal(a.state, 'armed')
      assert.equal(readPulseMarker(main)?.everySec, 120)
      assert.equal(armPulse(main, 120).state, 'already')
      const u = armPulse(main, 60)
      assert.equal(u.state, 'updated')
      assert.equal(readPulseMarker(main)?.everySec, 60)
      assert.equal(disarmPulse(main), 'disarmed')
      assert.equal(readPulseMarker(main), null)
      assert.equal(disarmPulse(main), 'absent')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('pulseLive', () => {
  test('no lock, dead holder, garbage token all read not-live', () => {
    const { root, main } = initRepo('bro-pulse-live-')
    try {
      assert.deepEqual(pulseLive(main), { live: false })
      lock(main, `${DEAD}:tok`)
      assert.deepEqual(pulseLive(main), { live: false })
      lock(main, 'garbage')
      assert.deepEqual(pulseLive(main), { live: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live holder pid reads live', () => {
    const { root, main } = initRepo('bro-pulse-alive-')
    try {
      lock(main, `${process.pid}:tok`)
      assert.deepEqual(pulseLive(main), { live: true, pid: process.pid })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('isOrchestratorSession', () => {
  test('unset/empty BRO_AGENT_ID is the orchestrator; pinned is a worker', () => {
    assert.equal(isOrchestratorSession({}), true)
    assert.equal(isOrchestratorSession({ BRO_AGENT_ID: '' }), true)
    assert.equal(isOrchestratorSession({ BRO_AGENT_ID: 'native-abc' }), false)
  })
})

describe('pulseNudge', () => {
  test('unarmed repo is quiet', () => {
    const { root, main } = initRepo('bro-pulse-n0-')
    try {
      assert.equal(pulseNudge(main, 900, {}), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('armed + dead pulse + orchestrator → the rearm line', () => {
    const { root, main } = initRepo('bro-pulse-n1-')
    try {
      armPulse(main, 120)
      const line = pulseNudge(main, 900, {})
      assert.match(line ?? '', /pulse armed \(every 120s\) but not live/)
      assert.match(line ?? '', /bro watch --every 120 --for 900 --notify/)
      assert.match(line ?? '', /bro drive/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live pulse is quiet — the lock holder answers liveness', () => {
    const { root, main } = initRepo('bro-pulse-n2-')
    try {
      armPulse(main, 120)
      lock(main, `${process.pid}:tok`)
      assert.equal(pulseNudge(main, 900, {}), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a spawned worker never sees the nudge — the GUARD', () => {
    const { root, main } = initRepo('bro-pulse-n3-')
    try {
      armPulse(main, 120)
      assert.equal(pulseNudge(main, 900, { BRO_AGENT_ID: 'native-x' }), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--for never suggests below --every', () => {
    const { root, main } = initRepo('bro-pulse-n4-')
    try {
      armPulse(main, 1200)
      assert.match(pulseNudge(main, 900, {}) ?? '', /--for 1200/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('marker file exists check — install wrote it, not a tmp leftover', () => {
    const { root, main } = initRepo('bro-pulse-n5-')
    try {
      armPulse(main, 60)
      const file = pulseMarkerPath(main)!
      assert.ok(existsSync(file))
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).everySec, 60)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('pulseSpawn record', () => {
  test('round-trip; absent and malformed read as null', () => {
    const { root, main } = initRepo('bro-pulse-sp-')
    try {
      assert.equal(readPulseSpawn(main), null)
      writePulseSpawn(main, { pid: 4242, spawnedAt: '2026-10-10T00:00:00Z' })
      assert.deepEqual(readPulseSpawn(main), { pid: 4242, spawnedAt: '2026-10-10T00:00:00Z' })
      writeFileSync(pulseSpawnPath(main)!, 'not json')
      assert.equal(readPulseSpawn(main), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('pulseRearm', () => {
  test('unarmed repo stays quiet', () => {
    const { root, main } = initRepo('bro-pulse-r0-')
    try {
      assert.deepEqual(pulseRearm(main, 900, {}), { kind: 'quiet' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('armed + live lock holder stays quiet', () => {
    const { root, main } = initRepo('bro-pulse-r1-')
    try {
      armPulse(main, 120)
      lock(main, `${process.pid}:tok`)
      assert.deepEqual(pulseRearm(main, 900, {}), { kind: 'quiet' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a spawned worker never rearms — the GUARD on the write side', () => {
    const { root, main } = initRepo('bro-pulse-r2-')
    try {
      armPulse(main, 120)
      assert.deepEqual(pulseRearm(main, 900, { BRO_AGENT_ID: 'native-x' }), {
        kind: 'quiet',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('armed + dead pulse + no spawned child → rearm, --for floors at --every', () => {
    const { root, main } = initRepo('bro-pulse-r3-')
    try {
      armPulse(main, 120)
      assert.deepEqual(pulseRearm(main, 900, {}), {
        kind: 'rearm',
        everySec: 120,
        forSec: 900,
      })
      armPulse(main, 1200)
      assert.deepEqual(pulseRearm(main, 900, {}), {
        kind: 'rearm',
        everySec: 1200,
        forSec: 1200,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live recorded spawn suppresses rearm — the standby hold', () => {
    const { root, main } = initRepo('bro-pulse-r4-')
    try {
      armPulse(main, 120)
      writePulseSpawn(main, { pid: process.pid, spawnedAt: 'x' })
      assert.deepEqual(pulseRearm(main, 900, {}), { kind: 'quiet' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a dead recorded spawn does not suppress — the next event retries', () => {
    const { root, main } = initRepo('bro-pulse-r5-')
    try {
      armPulse(main, 120)
      writePulseSpawn(main, { pid: DEAD, spawnedAt: 'x' })
      assert.deepEqual(pulseRearm(main, 900, {}), {
        kind: 'rearm',
        everySec: 120,
        forSec: 900,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
