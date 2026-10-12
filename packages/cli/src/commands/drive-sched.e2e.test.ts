/** Drive sched beads-gate ordering e2e — `drive uninstall` and
 *  `drive install --print` only touch marker/proc state, so they must
 *  run without a beads store: a repo whose store is gone still needs
 *  the cleanup path. The real `install` spawns the supervisor (which
 *  needs the store itself), so it keeps the checkBeads gate. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
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
})
