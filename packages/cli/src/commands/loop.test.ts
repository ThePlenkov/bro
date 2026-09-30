import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { bdTry } from '@broject/core'
import { loopRefTails, resolveBeadsDir } from './loop.ts'
import { git, initRepo, inside } from './testrepo.ts'

describe('loopRefTails', () => {
  test('a clean repo reports no tails', () => {
    const { root, main } = initRepo('bro-loop-audit-')
    inside(main, root, () => {
      const { worktrees, branches } = loopRefTails(main)
      assert.deepEqual(worktrees, [])
      assert.deepEqual(branches, [])
    })
  })

  test('a loop worktree and a bare loop branch are both reported', () => {
    const { root, main } = initRepo('bro-loop-audit-')
    inside(main, root, () => {
      const linked = join(root, 'main--bro-x')
      git(['worktree', 'add', '-q', linked, '-b', 'loop/bro-x'], main)
      git(['branch', 'loop/bro-y'], main)
      git(['branch', 'work/not-a-loop'], main)
      const { worktrees, branches } = loopRefTails(main)
      assert.deepEqual(worktrees, [`${linked} [loop/bro-x]`])
      assert.deepEqual(branches, ['loop/bro-y'])
    })
  })

  test('non-loop worktrees are not tails', () => {
    const { root, main } = initRepo('bro-loop-audit-')
    inside(main, root, () => {
      git(['worktree', 'add', '-q', join(root, 'main--w'), '-b', 'work/z'], main)
      const { worktrees, branches } = loopRefTails(main)
      assert.deepEqual(worktrees, [])
      assert.deepEqual(branches, [])
    })
  })
})

describe('resolveBeadsDir', () => {
  // bdTry inherits process.env — an ambient BEADS_DIR would redirect the
  // bd init/where calls below to an external store instead of the temp repo
  const ambientBeadsDir = process.env.BEADS_DIR
  delete process.env.BEADS_DIR
  after(() => {
    if (ambientBeadsDir !== undefined) process.env.BEADS_DIR = ambientBeadsDir
  })

  test('a repo without beads resolves nothing', () => {
    const { root, main } = initRepo('bro-loop-beads-')
    inside(main, root, () => {
      assert.equal(resolveBeadsDir(main), undefined)
    })
  })

  test('an initialized repo resolves its .beads dir', (t) => {
    if (bdTry(['--version']).code !== 0) {
      t.skip('bd not installed')
      return
    }
    const { root, main } = initRepo('bro-loop-beads-')
    inside(main, root, () => {
      const init = bdTry(['init', '--stealth', '--skip-agents', '--skip-hooks', '--quiet'], 30_000, main)
      assert.equal(init.code, 0, init.err)
      assert.equal(resolveBeadsDir(main), join(main, '.beads'))
    })
  })
})
