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

// two stages keep each regex simple — a quoted config path first, then
// a `currently "a", "b"` list within 200 chars after it
const PATH_RE = /`([a-z]\w*(?:\.[a-zA-Z]+)+)`/g
const LIST_RE = /currently[\s`]+((?:"[^"\n]+"[`\s,]*)+)/
const ITEM_RE = /"([^"\n]+)"/g

const resolve = (path: string): unknown =>
  path.split('.').reduce<unknown>(
    (acc, k) => (typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[k] : undefined),
    config
  )

let failed = false
for (const p of agents.matchAll(PATH_RE)) {
  const end = (p.index ?? 0) + p[0].length
  const cm = LIST_RE.exec(agents.slice(end, end + 200))
  if (cm === null) {
    continue
  }
  const path = p[1]!
  const claimed = [...cm[1]!.matchAll(ITEM_RE)]
    .map((q) => q[1]!)
    .sort((a, b) => a.localeCompare(b))
  const actual = resolve(path)
  if (!Array.isArray(actual) || actual.some((v) => typeof v !== 'string')) {
    console.error(`AGENTS.md quotes '${path}' but bro.config.json has no string[] there`)
    failed = true
    continue
  }
  const configured = [...(actual as string[])].sort((a, b) => a.localeCompare(b))
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
