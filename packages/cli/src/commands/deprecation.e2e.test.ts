/** Deprecation contract e2e — `BroPlugin.deprecated` on an external
 *  plugin must warn on stderr at dispatch and still run the command.
 *  Spawned because the warning lives in index.ts's argv[0] dispatch —
 *  in-process tests can't reach it. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initRepo, inside, runCli } from './testrepo.ts'

const DEPRECATED_PLUGIN = `export default {
  name: 'oldcmd',
  summary: 'legacy shim',
  deprecated: "use 'bro newcmd'",
  run: () => console.log('oldcmd ran'),
}`

describe('command deprecation', () => {
  test('a deprecated plugin warns once on stderr and still runs', () => {
    const { root, main } = initRepo('bro-dep-e2e-', (dir) => {
      writeFileSync(
        join(dir, 'bro.config.json'),
        JSON.stringify({ plugins: ['./dep.ts'] })
      )
      writeFileSync(join(dir, 'dep.ts'), DEPRECATED_PLUGIN)
    })
    inside(main, root, () => {
      const r = runCli(['oldcmd'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stderr, /warning: 'bro oldcmd' is deprecated — use 'bro newcmd'/)
      assert.match(r.stdout, /oldcmd ran/)
    })
  })

  test('a deprecated plugin omitted from config dispatch is quiet', () => {
    const { root, main } = initRepo('bro-dep-e2e-', (dir) => {
      writeFileSync(
        join(dir, 'bro.config.json'),
        JSON.stringify({ plugins: ['./dep.ts'] })
      )
      writeFileSync(join(dir, 'dep.ts'), DEPRECATED_PLUGIN)
    })
    inside(main, root, () => {
      // --version never reaches plugin dispatch — nothing may warn
      const r = runCli(['--version'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.doesNotMatch(r.stderr, /deprecated/)
    })
  })
})
