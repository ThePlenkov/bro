import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { planCleanup } from './cleanup.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

const branch = (name: string, tip = A) => ({ name, tip })
const merged = (entries: Array<[string, string]>) => new Map(entries)
/** test predicate: ancestry is simulated by a lookup table */
const ancestorOf = (pairs: Array<[string, string]>) => {
  const set = new Set(pairs.map(([t, o]) => `${t}:${o}`))
  return (tip: string, oid: string) => set.has(`${tip}:${oid}`)
}
const none = ancestorOf([])

describe('planCleanup', () => {
  test('deletes a branch whose tip equals the merged head', () => {
    const plan = planCleanup([branch('feat/a', A)], merged([['feat/a', A]]), {}, none)
    assert.deepEqual(plan.delete, ['feat/a'])
  })

  test('deletes a branch whose tip is an ancestor of the merged head', () => {
    const plan = planCleanup(
      [branch('feat/a', A)],
      merged([['feat/a', B]]),
      {},
      ancestorOf([[A, B]]),
    )
    assert.deepEqual(plan.delete, ['feat/a'])
  })

  test('keeps a branch with commits beyond the merged head — data loss guard', () => {
    const plan = planCleanup([branch('feat/a', C)], merged([['feat/a', A]]), {}, none)
    assert.deepEqual(plan.delete, [])
    assert.equal(plan.skip[0]?.reason, 'tip has commits beyond the merged head')
  })

  test('same-named local branch on a fork PR is kept — tip mismatch', () => {
    // fork PR head sha B never matches the local same-named branch at C
    const plan = planCleanup([branch('contrib', C)], merged([['contrib', B]]), {}, none)
    assert.deepEqual(plan.delete, [])
  })

  test('never deletes the current branch', () => {
    const plan = planCleanup([branch('feat/a', A)], merged([['feat/a', A]]), {
      current: 'feat/a',
    }, none)
    assert.deepEqual(plan.delete, [])
    assert.equal(plan.skip[0]?.reason, 'current branch')
  })

  test('never deletes main/master even with a merged PR', () => {
    const plan = planCleanup(
      [branch('main', A), branch('master', A)],
      merged([['main', A], ['master', A]]),
      {},
      none,
    )
    assert.deepEqual(plan.delete, [])
    assert.deepEqual(plan.skip.map((s) => s.reason), ['protected', 'protected'])
  })

  test('never deletes a branch checked out in another worktree', () => {
    const plan = planCleanup([branch('feat/a', A)], merged([['feat/a', A]]), {
      checkedOut: new Set(['feat/a']),
    }, none)
    assert.deepEqual(plan.delete, [])
    assert.equal(plan.skip[0]?.reason, 'checked out in another worktree')
  })

  test('branches without a merged PR are kept', () => {
    const plan = planCleanup([branch('feat/open-pr'), branch('feat/local-only')], merged([]), {}, none)
    assert.deepEqual(plan.delete, [])
    assert.equal(plan.skip.length, 2)
  })
})
