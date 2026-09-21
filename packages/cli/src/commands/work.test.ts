import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLinkedGitDir,
  parseWorktreePorcelain,
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
