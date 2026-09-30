/** `bro debt watch` e2e — auth-gate semantics over the built CLI. The
 *  watch contract is two-sided: fail fast at startup when the host is
 *  unusable (remediation now, not a spinning failure), but survive a
 *  transient auth blip mid-loop — a `process.exit` inside the per-tick
 *  collect would kill a watcher the surrounding try/catch was built to
 *  keep alive. Spawned, because exit codes are the assertion target. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initRepo, inside, runCli } from './testrepo.ts'

/** A review-host connector whose auth probe is scripted by host.json.
 *  `fail` always reports unauthenticated; `flaky` passes the startup
 *  probe, fails the first in-loop probe, and exits 42 on the third —
 *  reaching the sentinel proves the loop survived the failed tick. */
const WATCH_HOST_PLUGIN = `// e2e fixture — scripted auth probe
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const STATE = join(dirname(fileURLToPath(import.meta.url)), 'host.json')
const load = () => JSON.parse(readFileSync(STATE, 'utf8'))
let probes = 0
export default {
  name: 'watchhost-cmd',
  summary: 'e2e fixture',
  run: () => {},
  connectors: [{
    name: 'watchhost',
    matchRemote: () => false,
    reviews: () => ({}),
    auth: () => {
      probes += 1
      const mode = load().authMode
      if (mode === 'fail') return 'watchhost: run watchhost login'
      if (mode === 'flaky') {
        if (probes === 2) return 'watchhost: transient auth blip'
        if (probes >= 3) process.exit(42)
      }
      return null
    },
  }],
}
`

/** Repo + scripted-auth review host + bro.config wiring. */
function watchFixture(authMode: string): { root: string; main: string } {
  const { root, main } = initRepo('bro-debt-watch-')
  writeFileSync(join(main, 'watchhost.ts'), WATCH_HOST_PLUGIN)
  writeFileSync(join(main, 'host.json'), JSON.stringify({ authMode }))
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./watchhost.ts'],
      connectors: { reviews: 'watchhost' },
    })
  )
  return { root, main }
}

describe('bro debt watch e2e — auth gate', () => {
  test('unauthenticated at startup → exits 1 with remediation, no loop', () => {
    const { root, main } = watchFixture('fail')
    inside(main, root, () => {
      const r = runCli(['debt', 'watch', '--interval', '1'], { cwd: main })
      assert.equal(r.code, 1, r.stderr)
      assert.match(r.stderr, /watchhost: run watchhost login/)
      // the gate fires before the watch banner — no spinning failure
      assert.doesNotMatch(r.stderr, /collecting every/)
    })
  })

  test('auth blip inside the loop → logged, retried — never an exit', () => {
    const { root, main } = watchFixture('flaky')
    inside(main, root, () => {
      const r = runCli(['debt', 'watch', '--interval', '1'], { cwd: main })
      // probe #3 exits 42 — only reachable if tick 1's auth failure was
      // caught and the loop slept into a second collect
      assert.equal(r.code, 42, r.stderr)
      assert.match(r.stderr, /collecting every 1s/)
      assert.match(r.stderr, /collect failed — watchhost: transient auth blip/)
    })
  })
})
