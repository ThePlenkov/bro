import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loopRefTails } from './loop.ts'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(): { root: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), 'bro-loop-audit-'))
  const main = join(root, 'main')
  git(['init', '-q', '-b', 'main', main], root)
  git(['config', 'user.email', 't@t'], main)
  git(['config', 'user.name', 't'], main)
  writeFileSync(join(main, 'f.txt'), 'x')
  git(['add', 'f.txt'], main)
  git(['commit', '-qm', 'init'], main)
  return { root, main }
}

function inside<T>(root: string, fn: () => T): T {
  try {
    return fn()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('loopRefTails', () => {
  test('a clean repo reports no tails', () => {
    const { root, main } = initRepo()
    inside(root, () => {
      const { worktrees, branches } = loopRefTails(main)
      assert.deepEqual(worktrees, [])
      assert.deepEqual(branches, [])
    })
  })

  test('a loop worktree and a bare loop branch are both reported', () => {
    const { root, main } = initRepo()
    inside(root, () => {
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
    const { root, main } = initRepo()
    inside(root, () => {
      git(['worktree', 'add', '-q', join(root, 'main--w'), '-b', 'work/z'], main)
      const { worktrees, branches } = loopRefTails(main)
      assert.deepEqual(worktrees, [])
      assert.deepEqual(branches, [])
    })
  })
})
