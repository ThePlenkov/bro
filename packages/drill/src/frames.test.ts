import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assertHydratedRows, planPreventions, refKind } from './frames.ts'
import type { DrillRow } from './types.ts'

const prevention = (id: string, title: string, status = 'open'): DrillRow => ({
  id,
  title,
  status,
  labels: ['prevention'],
})

describe('refKind', () => {
  test('pull/merge-request URLs → pr', () => {
    assert.equal(refKind('https://github.com/o/r/pull/17'), 'pr')
    assert.equal(refKind('https://gitlab.com/o/r/-/merge_requests/3'), 'pr')
  })

  test('full 40-char lowercase hex → git-sha', () => {
    assert.equal(refKind('a'.repeat(40)), 'git-sha')
    assert.equal(refKind('e59d025f1ab2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), 'git-sha')
  })

  test('short shas are not git-sha → work-id', () => {
    assert.equal(refKind('abc1234'), 'work-id')
  })

  test('uppercase hex is not git-sha → work-id', () => {
    assert.equal(refKind('A'.repeat(40)), 'work-id')
  })

  test('arbitrary text → work-id', () => {
    assert.equal(refKind('transcript-2026-09-16'), 'work-id')
  })
})

describe('planPreventions', () => {
  test('no priors → everything creates', () => {
    const plan = planPreventions(['a', 'b'], [])
    assert.deepEqual(plan.create, ['a', 'b'])
    assert.equal(plan.reuse.size, 0)
  })

  test('open same-title prevention bead is reused, not recreated', () => {
    const plan = planPreventions(['a', 'b'], [prevention('bd-1', 'a')])
    assert.deepEqual(plan.create, ['b'])
    assert.equal(plan.reuse.get('a'), 'bd-1')
  })

  test('closed priors do not block re-filing', () => {
    const plan = planPreventions(['a'], [prevention('bd-1', 'a', 'closed')])
    assert.deepEqual(plan.create, ['a'])
  })

  test('non-prevention beads with the same title are ignored', () => {
    const other: DrillRow = { id: 'bd-9', title: 'a', status: 'open', labels: ['task'] }
    const plan = planPreventions(['a'], [other])
    assert.deepEqual(plan.create, ['a'])
  })

  test('duplicate items within one call collapse to a single create', () => {
    const plan = planPreventions(['a', 'a', 'b'], [])
    assert.deepEqual(plan.create, ['a', 'b'])
  })

  test('a retry after partial failure converges: created bead is reused', () => {
    // first attempt created bd-1 for 'a', then died — retry sees it in priors
    const plan = planPreventions(['a', 'b'], [prevention('bd-1', 'a')])
    assert.deepEqual(plan.create, ['b'])
    assert.equal(plan.reuse.get('a'), 'bd-1')
  })
})

describe('assertHydratedRows', () => {
  test('passes hydrated rows through', () => {
    assert.doesNotThrow(() => assertHydratedRows([prevention('d1', 'a')], 'f1'))
    assert.doesNotThrow(() => assertHydratedRows([], 'f1'))
  })

  test('throws on dependency-edge shaped rows instead of degrading', () => {
    const edge = { issue_id: 'f1', depends_on_id: 'p1', type: 'discovered-from' }
    assert.throws(
      () => assertHydratedRows([edge] as never, 'f1'),
      /unexpected row shape/,
    )
  })

  test('throws on rows missing title', () => {
    assert.throws(
      () => assertHydratedRows([{ id: 'd1', status: 'open' }] as never, 'f1'),
      /unexpected row shape/,
    )
  })
})
