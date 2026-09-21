import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parse } from 'smol-toml'
import { parseDebtPlan } from './plan.ts'

const parsePlan = (toml: string) => parseDebtPlan(parse(toml))

describe('parseDebtPlan', () => {
  test('parses verdicts with all fields', () => {
    const plan = parsePlan(`
kind = "debt"

[[verdicts]]
thread_id = "T1"
status = "done"
fix_pr = 58
notes = "landed"

[[verdicts]]
thread_id = "T2"
status = "wontfix"
`)
    assert.equal(plan.verdicts.length, 2)
    assert.deepEqual(plan.verdicts[0], {
      thread_id: 'T1',
      status: 'done',
      fix_pr: 58,
      notes: 'landed',
    })
    assert.equal(plan.verdicts[1]!.fix_pr, undefined)
  })

  test('rejects a foreign kind', () => {
    assert.throws(
      () => parsePlan('kind = "retrospect"\n[[verdicts]]\nthread_id="T1"\nstatus="done"'),
      /kind: expected "debt"/
    )
  })

  test('rejects missing verdicts', () => {
    assert.throws(() => parsePlan('kind = "debt"'), /verdicts: must be an array/)
    assert.throws(() => parsePlan('kind = "debt"\nverdicts = []'), /at least one/)
  })

  test('aggregates per-verdict errors', () => {
    assert.throws(
      () =>
        parsePlan(`
[[verdicts]]
thread_id = "T1"
status = "narnia"

[[verdicts]]
status = "done"
fix_pr = -3
`),
      /verdicts\[0\]: status must be one of/
    )
    try {
      parsePlan(`
[[verdicts]]
thread_id = "T1"
status = "narnia"

[[verdicts]]
status = "done"
fix_pr = -3
`)
      assert.fail('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      assert.match(msg, /verdicts\[1\]: thread_id is required/)
      assert.match(msg, /verdicts\[1\]: fix_pr must be a positive integer/)
    }
  })

  test('rejects duplicate thread_id verdicts', () => {
    assert.throws(
      () =>
        parsePlan(`
[[verdicts]]
thread_id = "T1"
status = "done"

[[verdicts]]
thread_id = "T1"
status = "wontfix"
`),
      /verdicts\[1\]: duplicate thread_id "T1"/
    )
  })

  test('flags unknown keys instead of dropping them', () => {
    assert.throws(
      () => parsePlan('[[verdicts]]\nthread_id="T1"\nstatus="done"\nverdict="x"'),
      /verdicts\[0\]: unknown key "verdict"/
    )
    assert.throws(
      () => parsePlan('foo = 1\n[[verdicts]]\nthread_id="T1"\nstatus="done"'),
      /unknown top-level key "foo"/
    )
  })
})
