import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stackSection } from '@broject/core'
import { git, initRepo, inside } from './testrepo.ts'
import {
  claimWorktree,
  finishWorktreeEnter,
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

describe('claimWorktree', () => {
  test('a vanished worktree reports gone — no claim lands on a dead path', () => {
    assert.equal(claimWorktree(join(tmpdir(), 'bro-claim-gone-nope'), 'x'), 'gone')
  })

  test('a real worktree stamps its marker and reports stamped', () => {
    const { root, main } = initRepo('bro-claim-')
    const tree = join(root, 'main--w')
    git(['worktree', 'add', '-q', tree, '-b', 'work/w'], main)
    inside(main, root, () => {
      assert.equal(claimWorktree(tree, 'w'), 'stamped')
      const marker = join(main, '.git', 'worktrees', 'main--w', 'bro', 'work')
      assert.equal(readFileSync(marker, 'utf8').split('\n')[1], 'w')
    })
  })

  test('finishWorktreeEnter returns gone instead of reporting a dead path ready', () => {
    const { root, main } = initRepo('bro-gone-')
    inside(main, root, () => {
      const r = finishWorktreeEnter(
        { slug: 'w', branch: 'work/w', main: { path: main, head: '', bare: false, detached: false } },
        {
          path: join(root, 'vanished'),
          branch: 'work/w',
          branchExists: false,
          reused: false,
          stacked: false,
        }
      )
      assert.equal(r.gone, true)
    })
  })

  /** A claim.lock held by a live foreign owner — our own pid reads
   *  alive, so the lock is never stealable and the wait expires. */
  function heldClaimLock(main: string): void {
    const gd = join(main, '.git', 'worktrees', 'main--w')
    mkdirSync(join(gd, 'bro'), { recursive: true })
    writeFileSync(join(gd, 'bro', 'claim.lock'), `${process.pid}:cafe`)
  }

  const finishOpts = (main: string) => ({
    slug: 'w',
    branch: 'work/w',
    main: { path: main, head: '', bare: false, detached: false },
    claimWaitMs: 100,
  })

  const createdFor = (tree: string) => ({
    path: tree,
    branch: 'work/w',
    branchExists: false,
    reused: false,
    stacked: false,
  })

  test('a held claim lock times out — the fresh tree is retired so retry works (bro-0fiq)', () => {
    const { root, main } = initRepo('bro-claim-timeout-')
    const tree = join(root, 'main--w')
    git(['worktree', 'add', '-q', tree, '-b', 'work/w'], main)
    inside(main, root, () => {
      heldClaimLock(main)
      const r = finishWorktreeEnter(finishOpts(main), createdFor(tree))
      assert.equal(r.claimLockTimedOut, true)
      assert.equal(r.partialRemoved, true)
      assert.equal(existsSync(tree), false)
    })
  })

  test('a tree an agent moved into during the lock wait is kept (bro-0fiq)', () => {
    const { root, main } = initRepo('bro-claim-timeout-')
    const tree = join(root, 'main--w')
    git(['worktree', 'add', '-q', tree, '-b', 'work/w'], main)
    inside(main, root, () => {
      heldClaimLock(main)
      // a driver spawned a fixer here — its registry entry pins the path
      mkdirSync(join(main, '.git', 'bro'), { recursive: true })
      writeFileSync(
        join(main, '.git', 'bro', 'agents.json'),
        JSON.stringify({
          'fx-1': { agentId: 'native-x', backend: 'native', spawnedAt: 't', worktree: tree },
        })
      )
      const r = finishWorktreeEnter(finishOpts(main), createdFor(tree))
      assert.equal(r.claimLockTimedOut, true)
      assert.equal(r.partialRemoved, false)
      assert.equal(existsSync(tree), true)
    })
  })

  test('a tree a sibling enter claimed via its in-tree marker is kept', () => {
    const { root, main } = initRepo('bro-claim-timeout-')
    const tree = join(root, 'main--w')
    git(['worktree', 'add', '-q', tree, '-b', 'work/w'], main)
    inside(main, root, () => {
      heldClaimLock(main)
      // a racing enter won the stamp during our wait — sessions don't
      // write the agent registry, only the in-tree claim marker
      const gd = join(main, '.git', 'worktrees', 'main--w', 'bro')
      writeFileSync(join(gd, 'work'), `${Date.now()}\nw\n`)
      const r = finishWorktreeEnter(finishOpts(main), createdFor(tree))
      assert.equal(r.claimLockTimedOut, true)
      assert.equal(r.partialRemoved, false)
      assert.equal(existsSync(tree), true)
    })
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

  test('enter stamps the in-worktree claim marker the driver reads (bro-pywx)', () => {
    const { root, main, linked } = fixture()
    inside(linked, root, () => {
      runWorkCommand(['enter', 'b'])
      const marker = join(main, '.git', 'worktrees', 'main--b', 'bro', 'work')
      assert.equal(readFileSync(marker, 'utf8').split('\n')[1], 'b')
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
