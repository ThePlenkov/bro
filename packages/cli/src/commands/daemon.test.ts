/** `bro daemon` (bro-ybrja) — armer record round-trips, probe liveness,
 *  and the up/down decision matrix. The supervised loop itself is
 *  drive's own (`daemon run` delegates), tested there. The install
 *  want-marker (bro-y5zon) lives here too: marker round-trips, the
 *  rearm decision, and install/uninstall with injected up/down. */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { initRepo } from './testrepo.ts'
import { lockHolderPid, pidAlive, scrubEnv, testGit } from '@broject/core'
import {
  armDrive,
  daemonProbe,
  daemonStatePath,
  daemonUpDecision,
  daemonUpLockPath,
  disarmDrive,
  driveMarkerPath,
  driveRearm,
  installDrive,
  readDaemonRecord,
  readDriveMarker,
  supervisorDown,
  supervisorUp,
  uninstallDrive,
  type SupervisorDown,
  type SupervisorUp,
} from './daemon.ts'
import { driveLockPath } from './drive.ts'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

const DEAD = 1 << 30

const writeLock = (main: string, content: string, mtimeAgoMs = 0): void => {
  const p = driveLockPath(main)!
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  if (mtimeAgoMs > 0) {
    const t = new Date(Date.now() - mtimeAgoMs)
    utimesSync(p, t, t)
  }
}

const writeRecord = (main: string, pid: number, extra: object = {}): void => {
  const p = daemonStatePath(main)!
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(
    p,
    JSON.stringify({
      pid,
      everySec: 300,
      spawnedAt: new Date().toISOString(),
      cmd: 'y',
      ...extra,
    })
  )
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
      assert.deepEqual(readDaemonRecord(main), {
        pid: 42,
        everySec: 300,
        spawnedAt: 't',
        cmd: 'c',
        pidStart: undefined,
      })
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

  test('a live pid on a heartbeat-dead lock is not live — pid reuse masks one window at most', () => {
    const { root, main } = initRepo('bro-daemon-reuse-')
    try {
      // alive pid (this process — a recycled pid's stand-in) but the
      // hold is older than LOCK_ABANDONED_MS (15m): the contender's
      // steal rule calls it stale, so the probe must too — otherwise
      // the dead daemon is masked forever
      writeLock(main, `${process.pid}:nonce`, 20 * 60_000)
      assert.equal(daemonProbe(main).live, false)
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

  test('a pidStart-pinned record is checked, not just the pid — a reused pid never passes', () => {
    const { root, main } = initRepo('bro-daemon-pstart-')
    try {
      // a record carrying a start time that does NOT match the live
      // pid's real start must not read as the daemon — pid reuse guard
      writeRecord(main, process.pid, { pidStart: 'bogus-start' })
      assert.equal(daemonProbe(main).live, false)
      // and a stale no-pidStart record (spawnedAt beyond the trust
      // window) stays dead even when the pid is alive
      const p = daemonStatePath(main)!
      writeFileSync(
        p,
        JSON.stringify({
          pid: process.pid,
          everySec: 300,
          spawnedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          cmd: 'y',
        })
      )
      assert.equal(daemonProbe(main).live, false)
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

  test('an aged live-pid lock does not count — spawn again, reuse cannot suppress', () => {
    const { root, main } = initRepo('bro-daemon-aged-')
    try {
      writeLock(main, `${process.pid}:nonce`, 20 * 60_000)
      assert.equal(daemonUpDecision(main, ORCH).kind, 'spawn')
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

// --- the install want-marker (bro-y5zon) ---------------------------------------

describe('drive marker', () => {
  test('drive.json resolves under <git-common>/bro', () => {
    const { root, main } = initRepo('bro-dmarker-path-')
    try {
      assert.equal(driveMarkerPath(main), join(main, '.git', 'bro', 'drive.json'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('absent and malformed read as null — never a half-shape rearm', () => {
    const { root, main } = initRepo('bro-dmarker-mal-')
    try {
      assert.equal(readDriveMarker(main), null)
      const file = driveMarkerPath(main)!
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'not json')
      assert.equal(readDriveMarker(main), null)
      writeFileSync(file, JSON.stringify({ everySec: '300' }))
      assert.equal(readDriveMarker(main), null)
      writeFileSync(file, JSON.stringify({ everySec: 0, armedAt: 't' }))
      assert.equal(readDriveMarker(main), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('arm → already → updated; disarm → disarmed → absent', () => {
    const { root, main } = initRepo('bro-dmarker-arm-')
    try {
      const a = armDrive(main, 300)
      assert.equal(a.state, 'armed')
      assert.equal(readDriveMarker(main)?.everySec, 300)
      assert.equal(armDrive(main, 300).state, 'already')
      assert.equal(armDrive(main, 120).state, 'updated')
      assert.equal(readDriveMarker(main)?.everySec, 120)
      assert.equal(disarmDrive(main), 'disarmed')
      assert.equal(readDriveMarker(main), null)
      assert.equal(disarmDrive(main), 'absent')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('driveRearm', () => {
  const ORCH = {} as NodeJS.ProcessEnv

  test('unarmed repo stays quiet', () => {
    const { root, main } = initRepo('bro-drearm-0-')
    try {
      assert.deepEqual(driveRearm(main, ORCH), { kind: 'quiet' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('armed + dead supervisor → rearm at the marker cadence', () => {
    const { root, main } = initRepo('bro-drearm-1-')
    try {
      armDrive(main, 120)
      assert.deepEqual(driveRearm(main, ORCH), { kind: 'rearm', everySec: 120 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('armed + a live lock holder stays quiet — raw drive counts', () => {
    const { root, main } = initRepo('bro-drearm-2-')
    try {
      armDrive(main, 120)
      writeLock(main, `${process.pid}:nonce`)
      assert.deepEqual(driveRearm(main, ORCH), { kind: 'quiet' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('armed + an aged live-pid lock rearms — reuse is bounded by the steal rule', () => {
    const { root, main } = initRepo('bro-drearm-2b-')
    try {
      armDrive(main, 120)
      writeLock(main, `${process.pid}:nonce`, 20 * 60_000)
      assert.deepEqual(driveRearm(main, ORCH), { kind: 'rearm', everySec: 120 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('armed + a live recorded child stays quiet — the standby hold', () => {
    const { root, main } = initRepo('bro-drearm-3-')
    try {
      armDrive(main, 120)
      writeRecord(main, process.pid)
      assert.deepEqual(driveRearm(main, ORCH), { kind: 'quiet' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a dead recorded pid does not suppress — the next event retries', () => {
    const { root, main } = initRepo('bro-drearm-4-')
    try {
      armDrive(main, 120)
      writeRecord(main, DEAD)
      assert.deepEqual(driveRearm(main, ORCH), { kind: 'rearm', everySec: 120 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a spawned worker never rearms — the GUARD on the write side', () => {
    const { root, main } = initRepo('bro-drearm-5-')
    try {
      armDrive(main, 120)
      assert.deepEqual(driveRearm(main, { BRO_AGENT_ID: 'native-x' }), { kind: 'quiet' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('installDrive', () => {
  const spawned = (pid: number): SupervisorUp => ({ kind: 'spawned', pid, log: '/x/log' })
  const downed: SupervisorDown = { pids: [], hadRecord: false }

  test('--print is pure — no marker, no spawn', () => {
    const { root, main } = initRepo('bro-dinst-print-')
    try {
      let ups = 0
      const r = installDrive(main, { everySec: 300, print: true }, {
        up: () => {
          ups += 1
          return spawned(1)
        },
      })
      assert.equal(r.state, 'printed')
      assert.match(r.detail, /drive\.json/)
      assert.equal(ups, 0)
      assert.equal(readDriveMarker(main), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('install arms the marker and brings the supervisor up', () => {
    const { root, main } = initRepo('bro-dinst-up-')
    try {
      const ups: number[] = []
      const r = installDrive(main, { everySec: 240 }, {
        up: (_dir, every) => {
          ups.push(every)
          return spawned(4242)
        },
      })
      assert.equal(r.state, 'installed')
      assert.match(r.detail, /armed \(every 240s\) — supervisor up — pid 4242/)
      assert.deepEqual(ups, [240])
      assert.equal(JSON.parse(readFileSync(driveMarkerPath(main)!, 'utf8')).everySec, 240)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live supervisor reports already — never doubles', () => {
    const { root, main } = initRepo('bro-dinst-already-')
    try {
      const r = installDrive(main, { everySec: 300 }, {
        up: () => ({ kind: 'already', pid: 777 }),
      })
      assert.equal(r.state, 'installed')
      assert.match(r.detail, /already supervising \(pid 777\)/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a second install with a new cadence updates the marker', () => {
    const { root, main } = initRepo('bro-dinst-upd-')
    try {
      installDrive(main, { everySec: 300 }, { up: () => spawned(1) })
      const r = installDrive(main, { everySec: 60 }, { up: () => ({ kind: 'already', pid: 2 }) })
      assert.equal(r.state, 'updated')
      assert.equal(readDriveMarker(main)?.everySec, 60)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a throwing spawn stays installed — the checkpoint retries', () => {
    const { root, main } = initRepo('bro-dinst-throw-')
    try {
      const r = installDrive(main, { everySec: 300 }, {
        up: () => {
          throw new Error('spawn broke')
        },
      })
      assert.equal(r.state, 'installed')
      assert.match(r.detail, /spawn failed \(spawn broke\) — the session checkpoint retries/)
      assert.equal(readDriveMarker(main)?.everySec, 300)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('uninstall disarms the marker and sweeps the supervisor', () => {
    const { root, main } = initRepo('bro-dinst-down-')
    try {
      armDrive(main, 300)
      let downs = 0
      const r = uninstallDrive(main, {
        down: () => {
          downs += 1
          return { pids: [111, 222], hadRecord: true }
        },
      })
      assert.equal(r.state, 'removed')
      assert.match(r.detail, /install marker removed — supervisor signalled \(111, 222\) — armer record cleared/)
      assert.equal(downs, 1)
      assert.equal(readDriveMarker(main), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('uninstall on a bare repo reports absent', () => {
    const { root, main } = initRepo('bro-dinst-none-')
    try {
      const r = uninstallDrive(main, { down: () => downed })
      assert.equal(r.state, 'absent')
      assert.match(r.detail, /nothing installed/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('uninstall disarms + sweeps inside daemon.up.lock — the rearm race', () => {
    const { root, main } = initRepo('bro-dinst-lock-')
    try {
      armDrive(main, 300)
      let heldByUs = false
      let markerInside: unknown = 'unread'
      uninstallDrive(main, {
        down: (d) => {
          const lock = daemonUpLockPath(d)
          heldByUs = lock !== null && lockHolderPid(lock) === process.pid
          markerInside = readDriveMarker(d)
          return { pids: [1], hadRecord: true }
        },
      })
      assert.equal(heldByUs, true, 'down sweep ran outside the up lock')
      assert.equal(markerInside, null, 'marker still armed inside the locked sweep')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a racing uninstall reports disarmed — never a markerless supervisor', () => {
    const { root, main } = initRepo('bro-dinst-disarm-')
    try {
      const r = installDrive(main, { everySec: 300 }, {
        up: () => ({ kind: 'disarmed' }),
      })
      assert.match(r.detail, /racing uninstall disarmed/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('supervisorUp requireMarker', () => {
  const ORCH = {} as NodeJS.ProcessEnv

  test('no marker inside the lock → disarmed, never a spawn', () => {
    const { root, main } = initRepo('bro-dsup-disarm-')
    try {
      assert.deepEqual(supervisorUp(main, 120, ORCH, { requireMarker: true }), {
        kind: 'disarmed',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live supervisor still reports already — the recheck is spawn-only', () => {
    const { root, main } = initRepo('bro-dsup-already-')
    try {
      writeLock(main, `${process.pid}:nonce`)
      // no marker — requireMarker must not fire on the already path
      assert.deepEqual(supervisorUp(main, 120, ORCH, { requireMarker: true }), {
        kind: 'already',
        pid: process.pid,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a worker never reaches the marker — the spawn guard wins', () => {
    const { root, main } = initRepo('bro-dsup-worker-')
    try {
      armDrive(main, 120)
      assert.equal(supervisorUp(main, 120, { BRO_AGENT_ID: 'w-1' }).kind, 'refuse-worker')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('supervisorDown', () => {
  const pause = (ms: number) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

  /** A live process wearing a supervisor cmdline, parked at cwd — the
   *  pgrep pattern matches it, so only the repo scope decides whether
   *  the sweep may signal it. */
  const fakeSupervisor = (cwd: string): number => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1e9)', 'daemon', 'run', '--every', '4242'],
      { cwd, detached: true, stdio: 'ignore' }
    )
    child.unref()
    return child.pid!
  }

  /** What pgrep -f reads — invisible until execve lands. */
  const cmdlineVisible = (pid: number): boolean => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--every')
    } catch {
      return false
    }
  }

  test('the standby sweep is repo-scoped — foreign supervisors are spared', () => {
    const a = initRepo('bro-dsweep-a-')
    const b = initRepo('bro-dsweep-b-')
    const pids: number[] = []
    const fake = (cwd: string): number => {
      const pid = fakeSupervisor(cwd)
      pids.push(pid)
      return pid
    }
    try {
      // a linked worktree shares the common dir — a supervisor running
      // there is still ours
      testGit(['-C', a.main, 'worktree', 'add', '-b', 'sweep-wt', join(a.root, 'wt')])
      const own = fake(a.main)
      const linked = fake(join(a.root, 'wt'))
      const foreign = fake(b.main)
      const stray = fake(a.root)
      const all = [own, linked, foreign, stray]
      // a spared assertion on a pgrep-invisible candidate proves nothing
      for (let i = 0; i < 100 && !all.every(cmdlineVisible); i++) {
        pause(10)
      }
      assert.ok(all.every(cmdlineVisible), 'fake supervisors never became pgrep-visible')
      const down = supervisorDown(a.main)
      assert.ok(down.pids.includes(own), `own supervisor missed: ${down.pids}`)
      assert.ok(down.pids.includes(linked), `linked-worktree supervisor missed: ${down.pids}`)
      assert.ok(!down.pids.includes(foreign), 'foreign supervisor was signalled')
      assert.ok(!down.pids.includes(stray), 'non-repo process was signalled')
      assert.ok(pidAlive(foreign), 'foreign supervisor was killed')
      assert.ok(pidAlive(stray), 'non-repo process was killed')
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      rmSync(a.root, { recursive: true, force: true })
      rmSync(b.root, { recursive: true, force: true })
    }
  })
})
