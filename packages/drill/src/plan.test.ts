import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parse } from 'smol-toml'
import { parseDrillPlan } from './plan.ts'

const parsePlan = (toml: string) => parseDrillPlan(parse(toml))

describe('parseDrillPlan', () => {
  test('parses a root with flat and nested steps', () => {
    const plan = parsePlan(`
kind = "drill"
title = "why does the cache miss"

[[steps]]
title = "check the parser"

[[steps]]
title = "narrow the repro"
under = 0
ephemeral = true
priority = 1
`)
    assert.equal(plan.title, 'why does the cache miss')
    assert.equal(plan.steps.length, 2)
    assert.deepEqual(plan.steps[1], {
      title: 'narrow the repro',
      under: 0,
      ephemeral: true,
      description: undefined,
      priority: 1,
      type: undefined,
    })
  })

  test('title required; steps optional', () => {
    assert.equal(parsePlan('title = "solo frame"').steps.length, 0)
    assert.throws(() => parsePlan('kind = "drill"'), /title: the root frame/)
  })

  test('under must index a previous step — no forward refs or self-parent', () => {
    assert.throws(
      () => parsePlan('title="r"\n[[steps]]\ntitle="a"\nunder=0'),
      /steps\[0\]: under must index a previous step/
    )
    assert.throws(
      () => parsePlan('title="r"\n[[steps]]\ntitle="a"\nunder=5'),
      /under must index a previous step/
    )
  })

  test('rejects foreign kind and unknown keys', () => {
    assert.throws(() => parsePlan('kind="debt"\ntitle="r"'), /kind: expected "drill"/)
    assert.throws(
      () => parsePlan('title="r"\n[[steps]]\ntitle="a"\nfoo=1'),
      /steps\[0\]: unknown key "foo"/
    )
    assert.throws(() => parsePlan('title="r"\nbogus=1'), /unknown top-level key "bogus"/)
  })

  test('aggregates step field errors', () => {
    try {
      parsePlan('title="r"\n[[steps]]\ntitle="a"\nephemeral="yes"\npriority=-1')
      assert.fail('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      assert.match(msg, /ephemeral must be a boolean/)
      assert.match(msg, /priority must be a positive integer/)
    }
  })
})
