import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan } from './plan.ts'

const VALID = `
[retro]
what = "merged a fix that broke the ledger"
why = "assumed collect was idempotent without checking the label path"
scope = "project"
wtf = "bro-x1"
evidence = ["https://github.com/x/y/pull/1", "0123456789abcdef0123456789abcdef01234567"]

[[actions]]
title = "add a guardrail test for relabeling"
sink = "backlog"

[[actions]]
title = "persist the convention"
sink = "memory"
scope = "user"
detail = "always label after the file lands"
`

describe('parsePlan', () => {
  test('parses a full plan', () => {
    const plan = parsePlan(VALID)
    assert.equal(plan.what, 'merged a fix that broke the ledger')
    assert.equal(plan.why, 'assumed collect was idempotent without checking the label path')
    assert.equal(plan.scope, 'project')
    assert.equal(plan.wtf, 'bro-x1')
    assert.equal(plan.evidence.length, 2)
    assert.equal(plan.actions.length, 2)
    assert.deepEqual(plan.actions[0], {
      title: 'add a guardrail test for relabeling',
      sink: 'backlog',
      scope: undefined,
      detail: undefined,
    })
    assert.equal(plan.actions[1]!.scope, 'user')
  })

  test('defaults scope to project and actions to empty', () => {
    const plan = parsePlan('[retro]\nwhat = "x"\nwhy = "y"\n')
    assert.equal(plan.scope, 'project')
    assert.deepEqual(plan.actions, [])
    assert.deepEqual(plan.evidence, [])
    assert.equal(plan.wtf, undefined)
  })

  test('rejects invalid TOML', () => {
    assert.throws(() => parsePlan('[[['), /invalid TOML/)
  })

  test('requires the [retro] table', () => {
    assert.throws(() => parsePlan('what = "x"'), /\[retro\] table is required/)
  })

  test('collects every problem in one error', () => {
    const bad = `
[retro]
what = ""
scope = "galaxy"
wat = "typo"

[[actions]]
title = "x"
sink = "narnia"

[[actions]]
sink = "backlog"
`
    try {
      parsePlan(bad, 'retro.toml')
      assert.fail('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      assert.match(msg, /retro\.toml:/)
      for (const part of [
        'what is required',
        'why is required',
        'scope must be one of',
        'unknown key "wat"',
        'sink must be one of',
        'title is required',
      ]) {
        assert.match(msg, new RegExp(part))
      }
    }
  })

  test('rejects a bad action scope', () => {
    const bad = '[retro]\nwhat="x"\nwhy="y"\n\n[[actions]]\ntitle="t"\nsink="memory"\nscope="zzz"\n'
    assert.throws(() => parsePlan(bad), /actions\[0\]: scope must be one of/)
  })

  test('rejects unknown top-level keys', () => {
    const bad = '[retro]\nwhat="x"\nwhy="y"\n\n[actionz]\ntitle="t"\n'
    assert.throws(() => parsePlan(bad), /unknown top-level key "actionz"/)
  })

  test('trims evidence refs', () => {
    const plan = parsePlan('[retro]\nwhat="x"\nwhy="y"\nevidence=["  abc123  "]\n')
    assert.deepEqual(plan.evidence, ['abc123'])
  })

  test('rejects non-array actions', () => {
    const bad = '[retro]\nwhat="x"\nwhy="y"\n\n[actions]\ntitle="t"\n'
    assert.throws(() => parsePlan(bad), /must be an array of tables/)
  })
})
