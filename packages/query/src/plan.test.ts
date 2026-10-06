import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isReadOnly, parseQueryPlan, stripCommentsAndStrings } from './plan.ts'

const base = (steps: unknown[] = [{ id: 'a', graphql: 'query { x }' }]) => ({
  kind: 'query',
  version: 1,
  steps,
})

describe('parseQueryPlan', () => {
  test('a minimal plan parses', () => {
    const plan = parseQueryPlan(base())
    assert.equal(plan.steps.length, 1)
    assert.equal(plan.steps[0]!.id, 'a')
    assert.equal(plan.steps[0]!.graphql, 'query { x }')
    assert.equal(plan.steps[0]!.provider, undefined)
  })

  test('provider, vars, env, concurrency are accepted', () => {
    const plan = parseQueryPlan({
      kind: 'query',
      concurrency: 2,
      steps: [
        {
          id: 'a',
          provider: 'github',
          graphql: 'query { x }',
          vars: { n: 5, s: 'x', b: true },
          env: { GH_HOST: 'ghe.corp' },
        },
      ],
    })
    const s = plan.steps[0]!
    assert.equal(s.provider, 'github')
    assert.deepEqual(s.vars, { n: 5, s: 'x', b: true })
    assert.deepEqual(s.env, { GH_HOST: 'ghe.corp' })
    assert.equal(plan.concurrency, 2)
  })

  test('unknown top-level and step keys are rejected', () => {
    assert.throws(
      () => parseQueryPlan({ kind: 'query', nope: 1, steps: [{ id: 'a', graphql: 'q' }] }),
      /nope: unknown key/
    )
    assert.throws(
      () =>
        parseQueryPlan(base([{ id: 'a', graphql: 'q', needs: ['b'] }])),
      /steps\[0\]\.needs: unknown key/
    )
  })

  test('missing/empty id is rejected; ids are unique', () => {
    assert.throws(() => parseQueryPlan(base([{ graphql: 'q' }])), /steps\[0\]\.id: required/)
    assert.throws(
      () => parseQueryPlan(base([{ id: 'a', graphql: 'q' }, { id: 'a', graphql: 'q' }])),
      /duplicate/
    )
  })

  test('missing/empty graphql is rejected', () => {
    assert.throws(() => parseQueryPlan(base([{ id: 'a' }])), /graphql: required/)
    assert.throws(() => parseQueryPlan(base([{ id: 'a', graphql: '  ' }])), /graphql: required/)
  })

  test('a version pin above PLAN_VERSION fails', () => {
    assert.throws(() => parseQueryPlan({ kind: 'query', version: 9, steps: [] }), /version/)
    assert.throws(() => parseQueryPlan({ kind: 'query', version: 0, steps: [] }), /version/)
  })

  test('concurrency must be an integer ≥1', () => {
    assert.throws(() => parseQueryPlan({ ...base(), concurrency: 0 }), /concurrency/)
    assert.throws(() => parseQueryPlan({ ...base(), concurrency: 1.5 }), /concurrency/)
  })

  test('no steps is an error', () => {
    assert.throws(() => parseQueryPlan({ kind: 'query' }), /steps: required/)
    assert.throws(() => parseQueryPlan({ kind: 'query', steps: 'x' }), /steps: must be an array/)
  })

  test('ATLASSIAN_API_URL is rejected in step env; non-string env rejected', () => {
    assert.throws(
      () =>
        parseQueryPlan(
          base([{ id: 'a', graphql: 'q', env: { ATLASSIAN_API_URL: 'https://x' } }])
        ),
      /ATLASSIAN_API_URL/
    )
    assert.throws(
      () => parseQueryPlan(base([{ id: 'a', graphql: 'q', env: { X: 1 } }])),
      /env\.X: must be a string/
    )
    assert.throws(
      () => parseQueryPlan(base([{ id: 'a', graphql: 'q', env: 's' }])),
      /env: must be a string→string table/
    )
  })

  test('vars must be a table; values are kept verbatim', () => {
    assert.throws(
      () => parseQueryPlan(base([{ id: 'a', graphql: 'q', vars: [1] }])),
      /vars: must be a table/
    )
    const plan = parseQueryPlan(base([{ id: 'a', graphql: 'q', vars: { nested: { a: 1 } } }]))
    assert.deepEqual(plan.steps[0]!.vars, { nested: { a: 1 } })
  })
})

describe('isReadOnly — the v1 gate', () => {
  test('queries pass; mutation/subscription fail', () => {
    assert.ok(isReadOnly('query { x }'))
    assert.ok(isReadOnly('{ x }'))
    assert.ok(!isReadOnly('mutation { createX }'))
    assert.ok(!isReadOnly('subscription { x }'))
  })

  test('keywords inside strings and comments do not trip the gate', () => {
    assert.ok(isReadOnly('query { field(arg: "mutation x") }'))
    assert.ok(isReadOnly('# mutation goes here\nquery { x }'))
    assert.ok(isReadOnly('query { field(arg: """multi\nline mutation""") }'))
  })

  test('word-boundary — a field named mutationCount is legal and rejected-adjacent names pass', () => {
    assert.ok(isReadOnly('query { mutationCount subscription_info }'))
  })

  test('documented over-rejection: a field literally named "mutation" fails', () => {
    // legal GraphQL, still rejected — the safe direction for a read-only gate
    assert.ok(!isReadOnly('query { mutation }'))
  })

  test('escaped quotes inside strings are skipped, not misread', () => {
    assert.ok(isReadOnly('query { f(s: "\\" mutation") }'))
    assert.ok(!isReadOnly('mutation { f(s: "\\"") }'))
  })

  test('stripCommentsAndStrings removes all three forms', () => {
    const stripped = stripCommentsAndStrings('q { f # c\n g:"x" h:"""y""" }')
    assert.ok(!stripped.includes('x'))
    assert.ok(!stripped.includes('y'))
    assert.ok(!stripped.includes('c'))
    assert.ok(stripped.includes('q { f'))
  })
})
