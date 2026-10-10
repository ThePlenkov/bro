/** filelock — liveness-based staleness, timeout refusal, exit-hook
 *  release. The lock file IS the lock; the pid:token content is the
 *  ownership proof steal/release check. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  acquireFileLock,
  awaitFileLock,
  holdFileLock,
  lockHolderPid,
  staleLock,
  withFileLock,
} from './filelock.ts'

const here = dirname(fileURLToPath(import.meta.url))

function tmp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-filelock-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('filelock', () => {
  test("a dead holder's lock is stolen at once — liveness, not age, is the signal", () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      writeFileSync(lock, '99999999:gone') // a pid that cannot be alive
      // a wait this short proves no stale window was waited out
      const release = acquireFileLock(lock, { waitMs: 500 })
      release()
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('a live holder is never robbed — the waiter times out instead of racing', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      writeFileSync(lock, `${process.pid}:not-ours`) // alive, foreign token
      assert.throws(() => acquireFileLock(lock, { waitMs: 300, label: 'x lock' }), /held over/)
      assert.equal(existsSync(lock), true) // the live hold survives
    } finally {
      done()
    }
  })

  test('a non-finite waitMs is rejected — a NaN deadline would hang forever', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      // run in a child — a validation regression sends the NaN deadline
      // into an unbounded synchronous Atomics.wait the runner cannot
      // interrupt, so the spawn timeout is the guardrail
      const script = join(dir, 'wait.ts')
      writeFileSync(
        script,
        `import assert from 'node:assert/strict'\n` +
          `import { writeFileSync } from 'node:fs'\n` +
          `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\n` +
          `const lock = ${JSON.stringify(lock)}\n` +
          `writeFileSync(lock, process.pid + ':held') // held — the wait would engage\n` +
          `assert.throws(() => acquireFileLock(lock, { waitMs: NaN }), RangeError)\n` +
          `assert.throws(() => acquireFileLock(lock, { waitMs: Infinity }), RangeError)\n` +
          `assert.throws(() => acquireFileLock(lock, { waitMs: -1 }), RangeError)\n`
      )
      const child = spawnSync('npx', ['tsx', script], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(child.status, 0, child.error ? String(child.error) : child.stderr)
    } finally {
      done()
    }
  })

  test('a held lock is released on process.exit — finally-bypassing exits are covered', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const script = join(dir, 'hold.ts')
      writeFileSync(
        script,
        `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\nacquireFileLock(${JSON.stringify(lock)})\nprocess.exit(0)\n`
      )
      const child = spawnSync('npx', ['tsx', script], { encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('a crashed staged token is swept on acquire; a fresh one is not', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const old = join(dir, 'x.lock.1.aaaa.tmp')
      const fresh = join(dir, 'x.lock.2.bbbb.tmp')
      writeFileSync(old, 'gone')
      writeFileSync(fresh, 'inflight')
      const past = new Date(Date.now() - 120_000)
      utimesSync(old, past, past)
      const release = acquireFileLock(lock)
      release()
      assert.equal(existsSync(old), false)
      assert.equal(existsSync(fresh), true)
    } finally {
      done()
    }
  })

  test('lockHolderPid reads the holder from pid:token and bare-pid tokens', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      writeFileSync(lock, '12345:abc')
      assert.equal(lockHolderPid(lock), 12345)
      writeFileSync(lock, '777')
      assert.equal(lockHolderPid(lock), 777)
      writeFileSync(lock, 'garbage')
      assert.equal(lockHolderPid(lock), null)
      rmSync(lock)
      assert.equal(lockHolderPid(lock), null)
    } finally {
      done()
    }
  })

  test('holdFileLock heartbeats the mtime — a live hold never reads stale', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const release = holdFileLock(lock, { heartbeatMs: 25 })
      try {
        // age the hold past the abandoned bound — without the beat a
        // contender (or the janitor) would steal it while we live
        const past = new Date(Date.now() - 20 * 60_000)
        utimesSync(lock, past, past)
        assert.equal(staleLock(lock), true)
        await new Promise((r) => setTimeout(r, 100))
        assert.equal(staleLock(lock), false)
        assert.equal(lockHolderPid(lock), process.pid)
      } finally {
        release()
      }
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('holdFileLock re-links a vanished lock file with our token', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const release = holdFileLock(lock, { heartbeatMs: 25 })
      try {
        rmSync(lock)
        await new Promise((r) => setTimeout(r, 100))
        assert.equal(existsSync(lock), true)
        assert.equal(lockHolderPid(lock), process.pid)
      } finally {
        release()
      }
    } finally {
      done()
    }
  })

  test('holdFileLock re-acquire in the same process is re-entrant', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const release = holdFileLock(lock, { heartbeatMs: 25 })
      // same-process re-acquire is re-entrant (heldLocks) — contention
      // is proven cross-process in the awaitFileLock test below
      const again = acquireFileLock(lock, { waitMs: 0 })
      again()
      release()
    } finally {
      done()
    }
  })

  test('awaitFileLock resolves at once over a dead holder — no standby', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      writeFileSync(lock, '99999999:gone')
      const standby: Array<number | null> = []
      const release = await awaitFileLock(lock, {
        waitMs: 500,
        onStandby: (pid) => standby.push(pid),
      })
      release()
      assert.deepEqual(standby, [])
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('awaitFileLock stands by behind a live foreign holder, then takes over', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      // a foreign process holds the lock ~1.2s, then exits — the
      // standby must report the incumbent and acquire once it releases
      const pidFile = join(dir, 'incumbent.pid')
      const script = join(dir, 'incumbent.ts')
      writeFileSync(
        script,
        `import { writeFileSync } from 'node:fs'\n` +
          `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\n` +
          `acquireFileLock(${JSON.stringify(lock)})\n` +
          // the holder's real pid — npx spawns a grandchild, so
          // child.pid is the wrapper's, not the lock token's
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n` +
          `setTimeout(() => {}, 1200)\n`
      )
      const child = spawn('npx', ['tsx', script], { stdio: 'ignore' })
      // the incumbent signals its hold by writing the pid file — npx
      // startup time varies, so poll rather than sleep a fixed beat
      for (let i = 0; i < 50 && !existsSync(pidFile); i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(existsSync(pidFile), 'incumbent never acquired')
      const standby: Array<number | null> = []
      const release = await awaitFileLock(lock, {
        waitMs: 100,
        heartbeatMs: 25,
        onStandby: (pid) => standby.push(pid),
      })
      release()
      assert.ok(standby.length >= 1, 'standby never reported')
      const holderPid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.equal(standby[0], holderPid)
      if (child.exitCode === null) {
        await new Promise((r) => child.once('exit', r))
      }
    } finally {
      done()
    }
  })

  test('withFileLock releases on fn throw', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      assert.throws(
        () =>
          withFileLock(lock, () => {
            throw new Error('boom')
          }),
        /boom/
      )
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })
})
