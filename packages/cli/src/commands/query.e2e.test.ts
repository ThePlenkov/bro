/** `bro query` e2e — validate+run over the built CLI with a scripted
 *  `queries` connector. Asserts the merged stdout JSON, the exit code
 *  contract (1 on any step failure), and that `bro plan validate`
 *  catches a mutating plan before any provider runs. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initRepo, inside, runCli } from './testrepo.ts'

/** A `queries` connector scripted by host.json — `mode`:
 *  ok returns {data:{q}}, gqlerr returns data+errors, fail throws. */
const QUERY_HOST_PLUGIN = `// e2e fixture — scripted queries facade
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const STATE = join(dirname(fileURLToPath(import.meta.url)), 'host.json')
const load = () => JSON.parse(readFileSync(STATE, 'utf8'))
export default {
  name: 'queryhost-cmd',
  summary: 'e2e fixture',
  run: () => {},
  connectors: [{
    name: 'qhost',
    matchRemote: () => true,
    queries: () => ({
      graphql: async (doc) => {
        const mode = load().mode
        if (mode === 'fail') throw new Error('qhost: transport down')
        if (mode === 'gqlerr' || doc.includes('deny')) {
          return { data: { partial: 1 }, errors: [{ message: 'denied' }] }
        }
        return { data: { q: doc.trim() } }
      },
    }),
  }],
}
`

function fixture(mode = 'ok'): { root: string; main: string } {
  const { root, main } = initRepo('bro-query-e2e-')
  writeFileSync(join(main, 'qhost.ts'), QUERY_HOST_PLUGIN)
  writeFileSync(join(main, 'host.json'), JSON.stringify({ mode }))
  writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ plugins: ['./qhost.ts'] }))
  return { root, main }
}

const PLAN = `kind = "query"
version = 1

[[steps]]
id = "one"
provider = "qhost"
graphql = "query { a }"

[[steps]]
id = "two"
provider = "qhost"
graphql = "query { b }"
`

describe('bro query e2e', () => {
  test('merged JSON in declaration order, exit 0', () => {
    const { root, main } = fixture('ok')
    inside(main, root, () => {
      writeFileSync(join(main, 'p.toml'), PLAN)
      const r = runCli(['query', 'p.toml'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout)
      assert.equal(out.ok, true)
      assert.deepEqual(Object.keys(out.steps), ['one', 'two'])
      assert.equal(out.steps.one.provider, 'qhost')
      assert.equal(out.steps.one.data.q, 'query { a }')
    })
  })

  test('graphql errors → exit 1, data still prints', () => {
    const { root, main } = fixture('gqlerr')
    inside(main, root, () => {
      writeFileSync(join(main, 'p.toml'), PLAN)
      const r = runCli(['query', 'p.toml'], { cwd: main })
      assert.equal(r.code, 1, r.stdout)
      const out = JSON.parse(r.stdout)
      assert.equal(out.ok, false)
      assert.deepEqual(out.steps.one.errors, [{ message: 'denied' }])
    })
  })

  test('transport failure → { provider, error }, sibling survives', () => {
    const { root, main } = fixture('ok')
    inside(main, root, () => {
      writeFileSync(
        join(main, 'p.toml'),
        `kind = "query"
[[steps]]
id = "ok"
provider = "qhost"
graphql = "query { a }"
[[steps]]
id = "bad"
provider = "qhost"
graphql = "query deny { b }"
`
      )
      const r = runCli(['query', 'p.toml'], { cwd: main })
      assert.equal(r.code, 1)
      const out = JSON.parse(r.stdout)
      assert.ok(out.steps.ok.data)
      assert.deepEqual(out.steps.bad.errors, [{ message: 'denied' }])
    })
  })

  test('plan validate rejects a mutation before any provider runs', () => {
    const { root, main } = fixture('ok')
    inside(main, root, () => {
      writeFileSync(
        join(main, 'p.toml'),
        `kind = "query"\n[[steps]]\nid = "m"\nprovider = "qhost"\ngraphql = "mutation { x }"\n`
      )
      const r = runCli(['plan', 'validate', 'p.toml'], { cwd: main })
      assert.notEqual(r.code, 0)
      assert.match(r.stderr + r.stdout, /read-only|mutation/i)
    })
  })

  test('a valid plan validates', () => {
    const { root, main } = fixture('ok')
    inside(main, root, () => {
      writeFileSync(join(main, 'p.toml'), PLAN)
      const r = runCli(['plan', 'validate', 'p.toml'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /query plan, schema v1/)
    })
  })
})
