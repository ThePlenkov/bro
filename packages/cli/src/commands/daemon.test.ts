/** `bro daemon` (bro-ybrja) — armer record round-trips, probe liveness,
 *  and the up/down decision matrix. The supervised loop itself is
 *  drive's own (`daemon run` delegates), tested there. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { initRepo } from './testrepo.ts'
import {
  daemonProbe,
  daemonStatePath,
  daemonUpDecision,
  readDaemonRecord,
} from './daemon.ts'
import { driveLockPath } from './drive.ts'

const DEAD = 1 << 30

const writeLock = (main: string, content: string): void => {
  const p = driveLockPath(main)!
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

const writeRecord = (main: string, pid: number): void => {
  const p = daemonStatePath(main)!
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ pid, everySec: 300, spawnedAt: 'x', cmd: 'y' }))
}

describe('daemon state', () => {
  test('daemon.json resolves under <git-common>/bro', () => {
    const { root, main } = initRepo('bro-daemon-path-')
    try {
      assert.equal(daemonStatePath(main), join(main, '.git', 'bro', 'daemon.json'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('absent and malformed records read as null', () => {
    const { root, main } = initRepo('bro-daemon-rec-')
    try {
      assert.equal(readDaemonRecord(main), null)
      const file = daemonStatePath(main)!
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'not json')
      assert.equal(readDaemonRecord(main), null)
      writeFileSync(file, JSON.stringify({ pid: 'abc' }))
      assert.equal(readDaemonRecord(main), null)
      writeFileSync(file, JSON.stringify({ pid: 42, everySec: 300, spawnedAt: 't', cmd: 'c' }))
      assert.deepEqual(readDaemonRecord(main), { pid: 42, everySec: 300, spawnedAt: 't', cmd: 'c' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('daemonProbe', () => {
  test('nothing held, nothing recorded → down', () => {
    const { root, main } = initRepo('bro-daemon-down-')
    try {
      const probe = daemonProbe(main)
      assert.equal(probe.live, false)
      assert.equal(probe.recorded, null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live drive.lock holder is the supervisor — record or not', () => {
    const { root, main } = initRepo('bro-daemon-live-')
    try {
      writeLock(main, `${process.pid}:nonce`)
      const probe = daemonProbe(main)
      assert.equal(probe.live, true)
      assert.equal(probe.pid, process.pid)
      assert.equal(probe.recorded, null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a dead lock holder is not live — a stale file, not a daemon', () => {
    const { root, main } = initRepo('bro-daemon-dead-')
    try {
      writeLock(main, `${DEAD}:nonce`)
      assert.equal(daemonProbe(main).live, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live recorded pid covers the pre-lock window — spawned, not yet holding', () => {
    const { root, main } = initRepo('bro-daemon-wait-')
    try {
      writeLock(main, `${DEAD}:nonce`)
      writeRecord(main, process.pid)
      const probe = daemonProbe(main)
      assert.equal(probe.live, true)
      assert.equal(probe.pid, process.pid)
      assert.equal(probe.recorded?.pid, process.pid)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('dead lock + dead record → down with the record still readable', () => {
    const { root, main } = initRepo('bro-daemon-bothdead-')
    try {
      writeLock(main, `${DEAD}:nonce`)
      writeRecord(main, DEAD)
      const probe = daemonProbe(main)
      assert.equal(probe.live, false)
      assert.equal(probe.recorded?.pid, DEAD)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('daemonUpDecision', () => {
  const ORCH = {} as NodeJS.ProcessEnv

  test('BRO_AGENT_ID refuses — workers never arm the daemon', () => {
    const { root, main } = initRepo('bro-daemon-guard-')
    try {
      assert.equal(daemonUpDecision(main, { BRO_AGENT_ID: 'w-1' }).kind, 'refuse-worker')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('nothing live → spawn', () => {
    const { root, main } = initRepo('bro-daemon-spawn-')
    try {
      assert.equal(daemonUpDecision(main, ORCH).kind, 'spawn')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live supervisor (raw `bro drive --every` counts) → already, no double', () => {
    const { root, main } = initRepo('bro-daemon-already-')
    try {
      writeLock(main, `${process.pid}:nonce`)
      const d = daemonUpDecision(main, ORCH)
      assert.equal(d.kind, 'already')
      assert.equal(d.kind === 'already' && d.pid, process.pid)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('dead holder + dead record → spawn again — staleness never blocks', () => {
    const { root, main } = initRepo('bro-daemon-respawn-')
    try {
      writeLock(main, `${DEAD}:nonce`)
      writeRecord(main, DEAD)
      assert.equal(daemonUpDecision(main, ORCH).kind, 'spawn')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
