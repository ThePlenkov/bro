import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { debtLabel, partitionByProcessed, prDebtState } from './labels.ts'

describe('debtLabel', () => {
  test('formats state as debt:<state>', () => {
    assert.equal(debtLabel('collected'), 'debt:collected')
    assert.equal(debtLabel('clean'), 'debt:clean')
    assert.equal(debtLabel('skipped'), 'debt:skipped')
  })
})

describe('prDebtState', () => {
  test('returns null for unlabeled PRs', () => {
    assert.equal(prDebtState([]), null)
    assert.equal(prDebtState(['bug', 'enhancement']), null)
  })

  test('reads each debt state case-insensitively', () => {
    assert.equal(prDebtState(['debt:collected']), 'collected')
    assert.equal(prDebtState(['Debt:Clean']), 'clean')
    assert.equal(prDebtState(['debt:skipped']), 'skipped')
  })

  test('skipped wins over machine states (human opt-out)', () => {
    assert.equal(prDebtState(['debt:collected', 'debt:skipped']), 'skipped')
    assert.equal(prDebtState(['debt:clean', 'debt:skipped']), 'skipped')
  })

  test('collected wins over clean', () => {
    assert.equal(prDebtState(['debt:clean', 'debt:collected']), 'collected')
  })
})

describe('partitionByProcessed', () => {
  test('splits PRs into pending and processed', () => {
    const prs = [
      { number: 1, labels: [] },
      { number: 2, labels: ['debt:collected'] },
      { number: 3, labels: ['bug'] },
      { number: 4, labels: ['debt:skipped'] },
      { number: 5, labels: ['debt:clean'] },
    ]
    const { pending, processed } = partitionByProcessed(prs)
    assert.deepEqual(pending.map((p) => p.number), [1, 3])
    assert.deepEqual(processed.map((p) => p.number), [2, 4, 5])
  })

  test('empty input yields empty partitions', () => {
    const { pending, processed } = partitionByProcessed([])
    assert.deepEqual(pending, [])
    assert.deepEqual(processed, [])
  })
})
