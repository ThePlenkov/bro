/**
 * AGENTS.md prose quotes live config values ("`act.ignoreChecks` …
 * currently `"kilo"`") — the quote is trusted as current, so drift is
 * worse than silence (bro-opoj). This check resolves each quoted config
 * path in bro.config.json and fails when the claimed set differs from
 * the configured one.
 *
 * Claim shape:  `<dot.path>` in bro.config.json … currently `"a"`, `"b"`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
const config: unknown = JSON.parse(readFileSync(join(root, 'bro.config.json'), 'utf8'))

const CLAIM_RE = /`([a-z][\w]*)((?:\.[a-zA-Z]+)+)`[\s\S]{0,200}?currently\s+((?:`?"[^"]+"`?[,\s]*)+)/g

const resolve = (path: string): unknown =>
  path.split('.').reduce<unknown>(
    (acc, k) => (typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[k] : undefined),
    config
  )

let failed = false
for (const m of agents.matchAll(CLAIM_RE)) {
  const path = `${m[1]}${m[2]}`
  const claimed = [...m[3]!.matchAll(/"([^"]+)"/g)].map((q) => q[1]!).sort()
  const actual = resolve(path)
  if (!Array.isArray(actual) || actual.some((v) => typeof v !== 'string')) {
    console.error(`AGENTS.md quotes '${path}' but bro.config.json has no string[] there`)
    failed = true
    continue
  }
  const configured = [...(actual as string[])].sort()
  if (JSON.stringify(claimed) !== JSON.stringify(configured)) {
    console.error(
      `AGENTS.md claims ${path} is ${JSON.stringify(claimed)} — bro.config.json has ${JSON.stringify(configured)}`
    )
    failed = true
  }
}

if (failed) {
  process.exit(1)
}
console.log('AGENTS.md config claims match bro.config.json')
