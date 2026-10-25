import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewFacade } from '@broject/core'
import { cleanupAfterMerge, resolvePr } from './act.ts'
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

/** A facade exposing only what resolvePr reads — branch state, the
 *  optional open-PR listing, the repo. */
function fakeRev(o: {
  branch?: { pr: number; state: string; url: string } | null
  open?: { pr: number; headRef: string }[]
}): ReviewFacade {
  return {
    resolveRepo: () => 'o/r',
    currentPr: () => o.branch ?? null,
    ...(o.open !== undefined ? { openPrs: () => o.open! } : {}),
  } as unknown as ReviewFacade
}

/** Run fn with process.exit captured — returns the code it would exit
 *  with, or fails when fn returns normally. */
function exitCodeOf(fn: () => unknown): number {
  const orig = process.exit
  class Raised extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`)
    }
  }
  process.exit = ((c?: number) => {
    throw new Raised(c ?? 0)
  }) as typeof process.exit
  try {
    fn()
    assert.fail('expected process.exit')
  } catch (e) {
    if (e instanceof Raised) return e.code
    throw e
  } finally {
    process.exit = orig
  }
}

/** stderr written by fn, with console.error restored. */
function stderrOf(fn: () => unknown): string {
  const orig = console.error
  const lines: string[] = []
  console.error = (...a: unknown[]) => {
    lines.push(a.join(' '))
  }
  try {
    fn()
  } finally {
    console.error = orig
  }
  return lines.join('\n')
}

describe('resolvePr', () => {
  test('an explicit number wins over branch and auto', () => {
    const rev = fakeRev({
      branch: { pr: 11, state: 'OPEN', url: 'u' },
      open: [{ pr: 99, headRef: 'x' }],
    })
    assert.deepEqual(resolvePr(rev, ['--pr', '5']), { repo: 'o/r', pr: 5 })
    assert.deepEqual(resolvePr(rev, ['7']), { repo: 'o/r', pr: 7 })
  })

  test('the open PR of the current branch beats the auto row', () => {
    const rev = fakeRev({
      branch: { pr: 11, state: 'OPEN', url: 'u' },
      open: [{ pr: 99, headRef: 'x' }],
    })
    assert.deepEqual(resolvePr(rev, []), { repo: 'o/r', pr: 11 })
    // no notice when the target came from the branch
    assert.equal(stderrOf(() => resolvePr(rev, [])), '')
  })

  test('read mode falls back to the most recently updated open PR, announced', () => {
    const rev = fakeRev({ branch: null, open: [{ pr: 42, headRef: 'w' }] })
    const err = stderrOf(() => {
      assert.deepEqual(resolvePr(rev, []), { repo: 'o/r', pr: 42 })
    })
    assert.match(err, /resolved current PR #42/)
    // a non-OPEN branch PR is no target either
    const closed = fakeRev({
      branch: { pr: 3, state: 'MERGED', url: 'u' },
      open: [{ pr: 42, headRef: 'w' }],
    })
    assert.deepEqual(resolvePr(closed, []), { repo: 'o/r', pr: 42 })
  })

  test('strict mode refuses the auto row with exit 2', () => {
    const rev = fakeRev({ branch: null, open: [{ pr: 42, headRef: 'w' }] })
    let code = 0
    let err = ''
    err = stderrOf(() => {
      code = exitCodeOf(() => resolvePr(rev, [], 'strict'))
    })
    assert.equal(code, 2)
    assert.match(err, /refusing to act on auto-resolved PR #42/)
    // strict still takes an explicit number and a branch PR
    assert.deepEqual(resolvePr(rev, ['42'], 'strict'), { repo: 'o/r', pr: 42 })
  })

  test('with no auto source at all the resolution exits 2 with guidance', () => {
    const noList = fakeRev({ branch: null })
    let code = 0
    let err = ''
    err = stderrOf(() => {
      code = exitCodeOf(() => resolvePr(noList, []))
    })
    assert.equal(code, 2)
    assert.match(err, /no open PR for current branch/)
    assert.match(err, /bro watch/)
    const empty = fakeRev({ branch: null, open: [] })
    assert.equal(
      exitCodeOf(() => resolvePr(empty, [])),
      2
    )
  })
})
