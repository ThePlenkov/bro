import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupAfterMerge } from './act.ts'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** Bare-bones repo: main checkout on `main` with one commit. */
function initRepo(): { root: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), 'bro-act-cleanup-'))
  const main = join(root, 'main')
  git(['init', '-q', '-b', 'main', main], root)
  git(['config', 'user.email', 't@t'], main)
  git(['config', 'user.name', 't'], main)
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n')
  git(['add', '.gitignore'], main)
  git(['commit', '-qm', 'init'], main)
  return { root, main }
}

/** main checkout + linked worktree on `work/x` with one commit — the
 *  "merged head" a PR would have landed. */
function fixture(): { root: string; main: string; linked: string; sha: string } {
  const { root, main } = initRepo()
  const linked = join(root, 'main--x')
  git(['worktree', 'add', '-q', linked, '-b', 'work/x'], main)
  writeFileSync(join(linked, 'g.txt'), 'y')
  git(['add', 'g.txt'], linked)
  git(['commit', '-qm', 'work'], linked)
  const sha = git(['rev-parse', 'HEAD'], linked).trim()
  return { root, main, linked, sha }
}

function inside<T>(dir: string, root: string, fn: () => T): T {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return fn()
  } finally {
    process.chdir(prev)
    rmSync(root, { recursive: true, force: true })
  }
}

describe('cleanupAfterMerge', () => {
  test('removes the linked worktree and the merged branch', () => {
    const { root, main, linked, sha } = fixture()
    inside(linked, root, () => {
      cleanupAfterMerge('work/x', sha)
      assert.equal(existsSync(linked), false)
      assert.equal(git(['branch', '--list', 'work/x'], main).trim(), '')
      // the command re-roots itself in the main checkout
      assert.equal(process.cwd(), main)
    })
  })

  test('ignored debris (node_modules) does not block removal', () => {
    const { root, main, linked, sha } = fixture()
    mkdirSync(join(linked, 'node_modules'), { recursive: true })
    writeFileSync(join(linked, 'node_modules', 'x.js'), 'x')
    inside(linked, root, () => {
      cleanupAfterMerge('work/x', sha)
      assert.equal(existsSync(linked), false)
      assert.equal(git(['branch', '--list', 'work/x'], main).trim(), '')
    })
  })

  test('an untracked file keeps the worktree and the branch', () => {
    const { root, main, linked, sha } = fixture()
    writeFileSync(join(linked, 'wip.txt'), 'not committed')
    inside(linked, root, () => {
      cleanupAfterMerge('work/x', sha)
      assert.equal(existsSync(join(linked, 'wip.txt')), true)
      assert.notEqual(git(['branch', '--list', 'work/x'], main).trim(), '')
    })
  })

  test('a main checkout on the merged branch switches back to the default branch', () => {
    const { root, main } = initRepo()
    git(['switch', '-qc', 'work/x'], main)
    const sha = git(['rev-parse', 'HEAD'], main).trim()
    inside(main, root, () => {
      cleanupAfterMerge('work/x', sha)
      assert.equal(git(['branch', '--show-current'], main).trim(), 'main')
      assert.equal(git(['branch', '--list', 'work/x'], main).trim(), '')
    })
  })

  test('a branch with commits beyond the merged head is not deleted', () => {
    const { root, main } = initRepo()
    const baseSha = git(['rev-parse', 'HEAD'], main).trim()
    git(['switch', '-qc', 'work/x'], main)
    writeFileSync(join(main, 'later.txt'), 'z')
    git(['add', 'later.txt'], main)
    git(['commit', '-qm', 'extra'], main)
    git(['switch', '-q', 'main'], main)
    inside(main, root, () => {
      // the "merged head" predates the branch tip — extra work is kept
      cleanupAfterMerge('work/x', baseSha)
      assert.notEqual(git(['branch', '--list', 'work/x'], main).trim(), '')
    })
  })
})
