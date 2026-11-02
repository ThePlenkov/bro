/** `bro drill` e2e — `--` passthrough and unknown-flag rejection. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { initRepo, installFakeBd, runCli } from './testrepo.ts'

const env = (binDir: string, db: string) => ({
  PATH: `${binDir}:${process.env.PATH ?? ''}`,
  FAKE_BD_DB: db,
})

function fixture() {
  const { root, main } = initRepo('bro-drill-e2e-')
  const { binDir, db } = installFakeBd(root)
  return { main, binDir, db, env: env(binDir, db) }
}

const cli = (main: string, e: ReturnType<typeof env>, args: string[]) =>
  runCli(['drill', ...args], { cwd: main, env: e })

describe('bro drill -- passthrough', () => {
  test('drill down -- --help and -- -h create a title, not help/usage', () => {
    const { main, env: e } = fixture()
    const h1 = cli(main, e, ['down', '--', '--help'])
    assert.equal(h1.code, 0, h1.stderr)
    assert.match(h1.stdout, /drill ↓/)
    assert.match(h1.stdout, /--help/)

    const h2 = cli(main, e, ['down', '--', '-h'])
    assert.equal(h2.code, 0, h2.stderr)
    assert.match(h2.stdout, /drill ↓/)
    assert.match(h2.stdout, /-h/)
  })

  test('drill down --bogus x still exits 2', () => {
    const { main, env: e } = fixture()
    const r = cli(main, e, ['down', '--bogus', 'x'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /unknown option.*--bogus/)
  })

  test('drill down -- --ephemeral creates a title, not ephemeral flag', () => {
    const { main, env: e } = fixture()
    const r = cli(main, e, ['down', '--', '--ephemeral'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /drill ↓/)
    assert.match(r.stdout, /--ephemeral/)
  })

  test('drill up -- --report after separator is rejected as positional', () => {
    const { main, env: e } = fixture()
    const d = cli(main, e, ['down', 'x'])
    assert.equal(d.code, 0)
    const u = cli(main, e, ['up', '--result', 'done', '--', '--report'])
    assert.equal(u.code, 2)
  })
})
