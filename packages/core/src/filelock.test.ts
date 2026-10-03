/** filelock — liveness-based staleness, timeout refusal, exit-hook
 *  release. The lock file IS the lock; the pid:token content is the
 *  ownership proof steal/release check. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { acquireFileLock, withFileLock } from './filelock.ts'

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
      writeFileSync(lock, `${process.pid}:held`) // held — the wait would engage
      assert.throws(() => acquireFileLock(lock, { waitMs: NaN }), RangeError)
      assert.throws(() => acquireFileLock(lock, { waitMs: -1 }), RangeError)
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
