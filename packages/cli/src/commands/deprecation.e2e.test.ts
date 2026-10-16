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

  // specs/cli phase 4 — per-name flat-spelling retirement: the flat
  // path warns and points at the grouped spelling; the grouped path
  // stays silent (spec bro-vlmrb.3)
  const FLAT_DEPRECATED_PLUGIN = `export default {
  name: 'oldflat',
  summary: 'grouped member, flat deprecated',
  group: 'review',
  flatDeprecated: 'flat spelling retiring',
  run: () => console.log('oldflat ran'),
}`

  test('flatDeprecated warns on the flat path only', () => {
    const { root, main } = initRepo('bro-dep-e2e-', (dir) => {
      writeFileSync(
        join(dir, 'bro.config.json'),
        JSON.stringify({ plugins: ['./dep.ts'] })
      )
      writeFileSync(join(dir, 'dep.ts'), FLAT_DEPRECATED_PLUGIN)
    })
    inside(main, root, () => {
      const flat = runCli(['oldflat'], { cwd: main })
      assert.equal(flat.code, 0, flat.stderr)
      assert.match(
        flat.stderr,
        /warning: 'bro oldflat' is deprecated — flat spelling retiring — prefer 'bro review oldflat'/
      )
      assert.match(flat.stdout, /oldflat ran/)

      const grouped = runCli(['review', 'oldflat'], { cwd: main })
      assert.equal(grouped.code, 0, grouped.stderr)
      assert.doesNotMatch(grouped.stderr, /deprecated/)
      assert.match(grouped.stdout, /oldflat ran/)
    })
  })

  test('flatDeprecated on a group HOST is ignored — no better spelling exists', () => {
    const HOST_FLAT = `export default {
  name: 'myhost',
  summary: 'host override',
  group: 'myhost',
  flatDeprecated: 'nonsense',
  run: () => console.log('host ran'),
}`
    const { root, main } = initRepo('bro-dep-e2e-', (dir) => {
      writeFileSync(
        join(dir, 'bro.config.json'),
        JSON.stringify({ plugins: ['./dep.ts'] })
      )
      writeFileSync(join(dir, 'dep.ts'), HOST_FLAT)
    })
    inside(main, root, () => {
      const r = runCli(['myhost'], { cwd: main })
      assert.doesNotMatch(r.stderr, /deprecated/)
    })
  })
})
