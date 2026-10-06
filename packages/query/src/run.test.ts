import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { registerConnector } from '@broject/core'
import type { QueryOpts } from '@broject/core'
import { applyQueryPlan } from './run.ts'
import type { QueryPlan } from './plan.ts'

// --- fake connectors -----------------------------------------------------------

/** Records calls; returns canned data/errors or throws per tag. */
registerConnector({
  name: 'fq',
  queries: () => ({
    graphql: async (doc: string, opts?: QueryOpts) => {
      if (doc.includes('BOOM')) {
        throw new Error('fq: transport blew up')
      }
      if (doc.includes('GQLERR')) {
        return { data: { partial: true }, errors: [{ message: 'denied' }] }
      }
      return { data: { doc: doc.trim(), vars: opts?.vars, env: opts?.env } }
    },
  }),
})

let inFlight = 0
let maxInFlight = 0
registerConnector({
  name: 'fq-slow',
  queries: () => ({
    graphql: async (doc: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return { data: { doc: doc.trim() } }
    },
  }),
})

// --- harness -------------------------------------------------------------------

function withConfigDir<T>(config: Record<string, unknown> | undefined, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'bro-q-'))
  try {
    if (config !== undefined) {
      writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(config))
    }
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function run(plan: QueryPlan, dir?: string): Promise<{ code: number; out: unknown }> {
  const lines: string[] = []
  const orig = console.log
  console.log = (s: string) => lines.push(s)
  try {
    const code = await applyQueryPlan(plan, dir)
    return { code, out: JSON.parse(lines.join('')) }
  } finally {
    console.log = orig
  }
}

const step = (id: string, graphql = 'query { x }', provider = 'fq') => ({ id, graphql, provider })

// --- tests ---------------------------------------------------------------------

describe('applyQueryPlan', () => {
  test('merged JSON: ok + steps keyed by id in declaration order', async () => {
    const { code, out } = await run({
      steps: [step('b'), step('a', 'query { y }'), step('c', 'query { z }')],
    })
    assert.equal(code, 0)
    const o = out as { ok: boolean; steps: Record<string, { provider: string; data: { doc: string } }> }
    assert.equal(o.ok, true)
    assert.deepEqual(Object.keys(o.steps), ['b', 'a', 'c'])
    assert.equal(o.steps['a']!.provider, 'fq')
    assert.equal(o.steps['a']!.data.doc, 'query { y }')
  })

  test('transport failure → { provider, error }, siblings still complete, exit 1', async () => {
    const { code, out } = await run({ steps: [step('ok'), step('bad', 'query BOOM')] })
    assert.equal(code, 1)
    const o = out as {
      ok: boolean
      steps: Record<string, { provider?: string; error?: string; data?: unknown }>
    }
    assert.equal(o.ok, false)
    assert.match(o.steps['bad']!.error!, /transport blew up/)
    assert.equal(o.steps['bad']!.provider, 'fq')
    assert.ok(o.steps['ok']!.data)
  })

  test('graphql errors array → errors pass through verbatim, exit 1 even with data', async () => {
    const { code, out } = await run({ steps: [step('half', 'query GQLERR')] })
    assert.equal(code, 1)
    const o = out as { steps: Record<string, { data: unknown; errors: unknown[] }> }
    assert.deepEqual(o.steps['half']!.errors, [{ message: 'denied' }])
    assert.ok(o.steps['half']!.data)
  })

  test('empty errors array is not a failure', async () => {
    registerConnector({
      name: 'fq-empty-errs',
      queries: () => ({ graphql: async () => ({ data: { x: 1 }, errors: [] }) }),
    })
    const { code } = await run({ steps: [step('a', 'q', 'fq-empty-errs')] })
    assert.equal(code, 0)
  })

  test('concurrency caps in-flight calls', async () => {
    inFlight = 0
    maxInFlight = 0
    const { code } = await run({
      concurrency: 2,
      steps: Array.from({ length: 6 }, (_, i) => step(`s${i}`, `query ${i}`, 'fq-slow')),
    })
    assert.equal(code, 0)
    assert.ok(maxInFlight <= 2, `maxInFlight ${maxInFlight} > cap 2`)
    assert.ok(maxInFlight > 1, 'steps should actually overlap')
  })

  test('query.env config applies UNDER step env', async () => {
    await withConfigDir(
      { query: { env: { GITLAB_HOST: 'gl.corp', SHARED: 'cfg' } } },
      async (dir) => {
        const { code, out } = await run(
          {
            steps: [
              {
                id: 'a',
                provider: 'fq',
                graphql: 'q',
                env: { SHARED: 'step', STEP_ONLY: 'x' },
              },
            ],
          },
          dir
        )
        assert.equal(code, 0)
        const env = (out as { steps: { a: { data: { env: Record<string, string> } } } }).steps.a
          .data.env
        assert.equal(env['GITLAB_HOST'], 'gl.corp')
        assert.equal(env['SHARED'], 'step') // step wins over config
        assert.equal(env['STEP_ONLY'], 'x')
      }
    )
  })

  test('config query.concurrency is the default; the plan wins', async () => {
    inFlight = 0
    maxInFlight = 0
    await withConfigDir({ query: { concurrency: 1 } }, async (dir) => {
      await run(
        {
          steps: [step('a', 'q1', 'fq-slow'), step('b', 'q2', 'fq-slow'), step('c', 'q3', 'fq-slow')],
        },
        dir
      )
    })
    assert.equal(maxInFlight, 1)

    inFlight = 0
    maxInFlight = 0
    await withConfigDir({ query: { concurrency: 1 } }, async (dir) => {
      await run(
        {
          concurrency: 3,
          steps: [step('a', 'q1', 'fq-slow'), step('b', 'q2', 'fq-slow'), step('c', 'q3', 'fq-slow')],
        },
        dir
      )
    })
    assert.equal(maxInFlight, 3)
  })

  test('unknown provider names a connector that fails honestly', async () => {
    const { code, out } = await run({ steps: [step('a', 'q', 'nope-connector')] })
    assert.equal(code, 1)
    const o = out as { steps: { a: { provider: string; error: string } } }
    assert.equal(o.steps.a.provider, 'nope-connector')
    assert.match(o.steps.a.error, /nope-connector|queries|connector/i)
  })

  test('providerless step resolves by connectors.queries pin', async () => {
    await withConfigDir({ connectors: { queries: 'fq' } }, async (dir) => {
      const { code, out } = await run({ steps: [{ id: 'a', graphql: 'q' }] }, dir)
      assert.equal(code, 0)
      assert.equal(
        (out as { steps: { a: { provider: string } } }).steps.a.provider,
        'fq'
      )
    })
  })
})
