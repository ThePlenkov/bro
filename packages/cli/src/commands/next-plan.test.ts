import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse as parseToml } from 'smol-toml'
import { parseNextPlan } from './next-plan.ts'

// the same parser `bro run` uses — tests exercise real TOML
const parse = async (toml: string) => parseNextPlan(parseToml(toml), 'test.toml')

describe('next plan schema', () => {
  it('a bare kind is a valid plan — all defaults', async () => {
    const plan = await parse('kind = "next"')
    assert.deepEqual(plan, {
      limit: 1,
      order: 'priority',
      claim: true,
      gates: 'forbid',
      json: false,
      filters: {},
    })
  })

  it('accepts a fully-specified plan', async () => {
    const plan = await parse(`kind = "next"
limit = 3
order = "oldest"
claim = false
gates = "allow"
json = true

[filters]
types = ["task", "bug"]
max_priority = 2
match = "schema|plan"`)
    assert.equal(plan.limit, 3)
    assert.equal(plan.order, 'oldest')
    assert.equal(plan.claim, false)
    assert.equal(plan.gates, 'allow')
    assert.equal(plan.json, true)
    assert.deepEqual(plan.filters.types, ['task', 'bug'])
    assert.equal(plan.filters.maxPriority, 2)
    assert.ok(plan.filters.match instanceof RegExp)
    assert.ok(plan.filters.match!.test('PLAN schema'))
  })

  it('kind mismatch is rejected', async () => {
    await assert.rejects(parse('kind = "debt"'), /kind: expected "next"/)
  })

  it('lists every problem at once', async () => {
    await assert.rejects(
      parse(`kind = "next"
limit = 0
order = "random"
gates = "maybe"
claim = "yes"
bogus = 1

[filters]
types = []
max_priority = 9
match = "([bad"`),
      (err: Error) => {
        for (const needle of [
          'limit: must be a positive integer',
          'order: must be one of priority|oldest|newest',
          'gates: must be one of forbid|allow',
          'claim: must be a boolean',
          'unknown top-level key "bogus"',
          'filters.types: must be a non-empty array',
          'filters.max_priority: must be an integer 0–4',
          'filters.match: invalid regex',
        ]) {
          assert.ok(err.message.includes(needle), `${needle} — got:\n${err.message}`)
        }
        return true
      }
    )
  })

  it('filters must be a table', async () => {
    await assert.rejects(parse('kind = "next"\nfilters = "task"'), /filters: must be a table/)
  })

  it('unknown filter keys are rejected', async () => {
    await assert.rejects(
      parse('kind = "next"\n[filters]\nlabel = "x"'),
      /filters: unknown key "label"/
    )
  })

  it('a non-table doc is rejected', () => {
    assert.throws(() => parseNextPlan(['x'], 'test.toml'), /expected a TOML table/)
  })
})
