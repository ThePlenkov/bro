import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupAfterMerge } from './act.ts'
import { git, initRepo, inside } from './testrepo.ts'

const repo = () => initRepo('bro-act-cleanup-', (m) =>
  writeFileSync(join(m, '.gitignore'), 'node_modules/\n')
)

/** main checkout + linked worktree on `work/x` with one commit — the
 *  "merged head" a PR would have landed. */
function fixture(): { root: string; main: string; linked: string; sha: string } {
  const { root, main } = repo()
  const linked = join(root, 'main--x')
  git(['worktree', 'add', '-q', linked, '-b', 'work/x'], main)
  writeFileSync(join(linked, 'g.txt'), 'y')
  git(['add', 'g.txt'], linked)
  git(['commit', '-qm', 'work'], linked)
  const sha = git(['rev-parse', 'HEAD'], linked).trim()
  return { root, main, linked, sha }
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

  test('run from a subdirectory still removes the containing worktree', () => {
    const { root, main, linked, sha } = fixture()
    const sub = join(linked, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    inside(sub, root, () => {
      cleanupAfterMerge('work/x', sha)
      assert.equal(existsSync(linked), false)
      assert.equal(git(['branch', '--list', 'work/x'], main).trim(), '')
    })
  })

  test('a main checkout on the merged branch switches back to the default branch', () => {
    const { root, main } = repo()
    git(['switch', '-qc', 'work/x'], main)
    const sha = git(['rev-parse', 'HEAD'], main).trim()
    inside(main, root, () => {
      cleanupAfterMerge('work/x', sha)
      assert.equal(git(['branch', '--show-current'], main).trim(), 'main')
      assert.equal(git(['branch', '--list', 'work/x'], main).trim(), '')
    })
  })

  test('a branch with commits beyond the merged head is not deleted', () => {
    const { root, main } = repo()
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
