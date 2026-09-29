import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stackSection } from '@broject/core'
import { git, initRepo, inside } from './testrepo.ts'
import {
  hasSubmodules,
  isLinkedGitDir,
  parseWorktreePorcelain,
  resolveEnterBase,
  runWorkCommand,
  unquoteGitPath,
  worktreePathFor,
} from './work.ts'

const PORCELAIN = `worktree /repo/main
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /repo/main--fix
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/work/fix

worktree /repo/main--det
HEAD cccccccccccccccccccccccccccccccccccccccc
detached

worktree /repo/main--gone
HEAD dddddddddddddddddddddddddddddddddddddddd
branch refs/heads/work/gone
prunable gitdir file points to non-existent location
`

describe('parseWorktreePorcelain', () => {
  test('parses main, linked, detached and prunable entries', () => {
    const all = parseWorktreePorcelain(PORCELAIN)
    assert.equal(all.length, 4)
    assert.equal(all[0]!.path, '/repo/main')
    assert.equal(all[0]!.branch, 'main')
    assert.equal(all[1]!.branch, 'work/fix')
    assert.equal(all[2]!.detached, true)
    assert.equal(all[2]!.branch, undefined)
    assert.ok(all[3]!.prunable)
  })

  test('empty output parses to nothing', () => {
    assert.deepEqual(parseWorktreePorcelain(''), [])
    assert.deepEqual(parseWorktreePorcelain('\n'), [])
  })

  test('locked entries carry the flag and optional reason', () => {
    const text = `worktree /repo/main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo/main--held\nHEAD bbb\nbranch refs/heads/work/held\nlocked user is debugging\n\nworktree /repo/main--held2\nHEAD ccc\nbranch refs/heads/work/held2\nlocked\n`
    const [main, held, held2] = parseWorktreePorcelain(text)
    assert.equal(main!.locked, undefined)
    assert.equal(held!.locked, 'user is debugging')
    assert.equal(held2!.locked, '')
  })

  test('C-quoted paths are unquoted', () => {
    const text = 'worktree "/repo/main--we\\"ird"\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ndetached\n'
    assert.equal(parseWorktreePorcelain(text)[0]!.path, '/repo/main--we"ird')
  })
})

describe('unquoteGitPath', () => {
  test('plain paths pass through; quotes unwrap escapes', () => {
    assert.equal(unquoteGitPath('/repo/x'), '/repo/x')
    assert.equal(unquoteGitPath('"/repo/a b"'), '/repo/a b')
    assert.equal(unquoteGitPath('"/repo/a\\\\b"'), '/repo/a\\b')
  })
})

describe('isLinkedGitDir', () => {
  test('linked worktrees carry a .git/worktrees/<name> shape', () => {
    assert.ok(isLinkedGitDir('/repo/main/.git/worktrees/main--fix'))
    assert.ok(!isLinkedGitDir('/repo/main/.git'))
    assert.ok(!isLinkedGitDir('/repo/main'))
  })

  test('a primary checkout living under a worktrees/ dir is not linked', () => {
    assert.ok(!isLinkedGitDir('/home/u/worktrees/repo/.git'))
  })
})

describe('worktreePathFor', () => {
  test('derives a sibling path named <repo>--<slug>', () => {
    assert.equal(worktreePathFor('/ws/bro', 'fix-x'), '/ws/bro--fix-x')
    assert.equal(worktreePathFor('/ws/bro', 'a.b-1'), '/ws/bro--a.b-1')
  })
})

describe('hasSubmodules', () => {
  test('true only when the worktree declares .gitmodules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-work-'))
    assert.ok(!hasSubmodules(dir))
    writeFileSync(join(dir, '.gitmodules'), '[submodule "v"]\n\tpath = v\n')
    assert.ok(hasSubmodules(dir))
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('stackSection', () => {
  test('defaults to manual; auto opts in; junk warns and falls back', () => {
    assert.deepEqual(stackSection(undefined), { mode: 'manual' })
    assert.deepEqual(stackSection({}), { mode: 'manual' })
    assert.deepEqual(stackSection({ mode: 'auto' }), { mode: 'auto' })
    assert.deepEqual(stackSection({ mode: 'bogus' }), { mode: 'manual' })
  })
})

describe('resolveEnterBase', () => {
  test('explicit --base always wins', () => {
    assert.deepEqual(resolveEnterBase('origin/dev', true, true, 'work/a', 'main'), { base: 'origin/dev' })
    assert.deepEqual(resolveEnterBase('abc123', false, false, 'work/a', 'main'), { base: 'abc123' })
  })

  test('manual mode pins the main branch — no accidental stacking on HEAD', () => {
    assert.deepEqual(resolveEnterBase(undefined, false, false, 'work/a', 'main'), { base: 'main' })
  })

  test('auto mode bases on the current work branch, quiet on main', () => {
    assert.deepEqual(resolveEnterBase(undefined, false, true, 'work/a', 'main'), { base: 'work/a' })
    assert.deepEqual(resolveEnterBase(undefined, false, true, 'main', 'main'), { base: 'main' })
    assert.deepEqual(resolveEnterBase(undefined, false, true, undefined, 'main'), { base: 'main' })
  })

  test('explicit --stack errors on the default branch or detached', () => {
    assert.ok(resolveEnterBase(undefined, true, false, 'main', 'main').err)
    assert.ok(resolveEnterBase(undefined, true, false, undefined, 'main').err)
    assert.deepEqual(resolveEnterBase(undefined, true, false, 'work/a', 'main'), { base: 'work/a' })
  })

  test('a detached main still pins a base — its commit, not ambient HEAD', () => {
    assert.deepEqual(resolveEnterBase(undefined, false, false, 'work/a', 'c0ffee'), { base: 'c0ffee' })
    assert.deepEqual(resolveEnterBase(undefined, false, true, 'work/a', 'c0ffee'), { base: 'work/a' })
  })
})

/** Real-repo enter: linked worktree on work/a + --stack/auto must base
 *  work/b on work/a and record the edge in <common>/bro/stack. */
describe('work enter --stack', () => {
  function fixture(): { root: string; main: string; linked: string } {
    const { root, main } = initRepo('bro-stack-')
    const linked = join(root, 'main--a')
    git(['worktree', 'add', '-q', linked, '-b', 'work/a'], main)
    git(['commit', '-qm', 'a-work', '--allow-empty'], linked)
    return { root, main, linked }
  }

  function headOf(root: string, ref: string): string {
    return git(['rev-parse', ref], root).trim()
  }

  test('--stack bases the new branch on the current worktree branch', () => {
    const { root, main, linked } = fixture()
    inside(linked, root, () => {
      runWorkCommand(['enter', 'b', '--stack'])
      // work/b points at work/a's tip, not at main
      assert.equal(headOf(main, 'work/b'), headOf(main, 'work/a'))
      const edge = join(main, '.git', 'bro', 'stack', encodeURIComponent('work/b'))
      assert.equal(readFileSync(edge, 'utf8').trim(), 'work/a')
    })
  })

  test('manual mode (default) pins main — no accidental stack on HEAD', () => {
    const { root, main, linked } = fixture()
    inside(linked, root, () => {
      runWorkCommand(['enter', 'b'])
      assert.equal(headOf(main, 'work/b'), headOf(main, 'main'))
    })
  })

  test('stack.mode=auto stacks without the flag', () => {
    const { root, main, linked } = fixture()
    writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ stack: { mode: 'auto' } }))
    inside(linked, root, () => {
      runWorkCommand(['enter', 'b'])
      assert.equal(headOf(main, 'work/b'), headOf(main, 'work/a'))
    })
  })

  test('an existing branch is checked out — the resolved default base must not block it', () => {
    const { root, main, linked } = fixture()
    git(['branch', 'work/b'], main)
    inside(linked, root, () => {
      runWorkCommand(['enter', 'b'])
      const tree = join(root, 'main--b')
      assert.ok(readFileSync(join(tree, '.git'), 'utf8').startsWith('gitdir:'))
      assert.equal(headOf(tree, 'HEAD'), headOf(main, 'work/b'))
    })
  })
})
