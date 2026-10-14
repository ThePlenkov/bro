/** Drive sched beads-gate ordering e2e — `drive uninstall` and
 *  `drive install --print` only touch marker/proc state, so they must
 *  run without a beads store: a repo whose store is gone still needs
 *  the cleanup path. The real `install` spawns the supervisor (which
 *  needs the store itself), so it keeps the checkBeads gate. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { pidAlive } from '@broject/core'
import { initRepo, inside, runCli } from './testrepo.ts'

describe('bro drive install/uninstall — beads-gate ordering', () => {
  const run = (main: string, args: string[]) => runCli(['drive', ...args], { cwd: main })

  test('uninstall runs without a beads store', () => {
    const { root, main } = initRepo('bro-drive-sched-')
    inside(main, root, () => {
      const r = run(main, ['uninstall'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /nothing installed/)
    })
  })

  test('install --print runs without a beads store', () => {
    const { root, main } = initRepo('bro-drive-sched-')
    inside(main, root, () => {
      const r = run(main, ['install', '--print'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /drive\.json/)
    })
  })

  test('a real install keeps the gate — the spawned supervisor needs the store', () => {
    const { root, main } = initRepo('bro-drive-sched-')
    inside(main, root, () => {
      const r = run(main, ['install'])
      assert.notEqual(r.code, 0)
    })
  })

  test('uninstall spares a foreign repo’s supervisor — the standby sweep is repo-scoped', () => {
    const { root, main } = initRepo('bro-drive-sched-')
    const other = initRepo('bro-drive-sched-foreign-')
    // a live process wearing the supervisor cmdline but owned by a
    // different repo — the pre-fix sweep SIGTERMed every machine-wide
    // pgrep match (a rig's real daemon died to this)
    const foreign = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1e9)', 'daemon', 'run', '--every', '4242'],
      { cwd: other.main, detached: true, stdio: 'ignore' }
    )
    foreign.unref()
    const pid = foreign.pid!
    try {
      // pgrep reads /proc/<pid>/cmdline — wait for execve so the sweep
      // provably saw the candidate and still spared it
      const visible = (): boolean => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--every')
        } catch {
          return false
        }
      }
      for (let i = 0; i < 100 && !visible(); i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
      assert.ok(visible(), 'foreign supervisor never became pgrep-visible')
      inside(main, root, () => {
        const r = run(main, ['uninstall'])
        assert.equal(r.code, 0, r.stderr)
        assert.doesNotMatch(r.stdout, new RegExp(`signalled.*${pid}`))
      })
      assert.ok(pidAlive(pid), 'foreign supervisor was killed')
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      rmSync(other.root, { recursive: true, force: true })
    }
  })
})
