import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loopRefTails } from './loop.ts'
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
