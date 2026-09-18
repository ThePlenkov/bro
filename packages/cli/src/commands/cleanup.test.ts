import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { planCleanup } from './cleanup.ts'

const merged = (...names: string[]) => new Set(names)

describe('planCleanup', () => {
  test('deletes local branches with a merged PR', () => {
    const plan = planCleanup(['feat/a', 'feat/b'], merged('feat/a'), {})
    assert.deepEqual(plan.delete, ['feat/a'])
    assert.deepEqual(plan.skip, [{ branch: 'feat/b', reason: 'no merged PR' }])
  })

  test('never deletes the current branch', () => {
    const plan = planCleanup(['feat/a'], merged('feat/a'), { current: 'feat/a' })
    assert.deepEqual(plan.delete, [])
    assert.equal(plan.skip[0]?.reason, 'current branch')
  })

  test('never deletes main/master even with a merged PR', () => {
    const plan = planCleanup(['main', 'master'], merged('main', 'master'), {})
    assert.deepEqual(plan.delete, [])
    assert.deepEqual(plan.skip.map((s) => s.reason), ['protected', 'protected'])
  })

  test('never deletes a branch checked out in another worktree', () => {
    const plan = planCleanup(['feat/a'], merged('feat/a'), {
      current: 'main',
      checkedOut: new Set(['feat/a']),
    })
    assert.deepEqual(plan.delete, [])
    assert.equal(plan.skip[0]?.reason, 'checked out in another worktree')
  })

  test('branches without a merged PR are kept — open or no PR at all', () => {
    const plan = planCleanup(['feat/open-pr', 'feat/local-only'], merged(), {})
    assert.deepEqual(plan.delete, [])
    assert.equal(plan.skip.length, 2)
  })
})
