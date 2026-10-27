/**
 * AGENTS.md prose quotes live config values ("`act.ignoreChecks` …
 * currently `"kilo"`") — the quote is trusted as current, so drift is
 * worse than silence (bro-opoj). This check resolves each quoted config
 * path in bro.config.json and fails when the claimed set differs from
 * the configured one.
 *
 * Claim shape:  `<dot.path>` in bro.config.json … currently `"a"`, `"b"`
 *
 * Two more doc-vs-code contracts ride the same gate (bro-l8c4f.18):
 *
 *  - the Node floor: every `Node ≥ x` / `node >= x` / `node-%3E%3Dx`
 *    badge claim in the doc set must equal the workspace `engines.node`
 *    floor — onboarding once promised `≥ 22` while engines require
 *    `>=22.18`
 *  - the setup contract: docs must name `bro.config.local.json` as what
 *    `bro setup` writes, and never present the committed
 *    `bro.config.json` as setup-written or gitignored — the local
 *    layer's spellings can't produce a bare `bro.config.json` match
 *    (`local.` sits between `config.` and `json`)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

// --- the doc set every contract check scans ----------------------------------
const DOCS: string[] = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md']
for (const name of readdirSync(join(root, 'packages'))) {
  const readme = join(root, 'packages', name, 'README.md')
  try {
    if (statSync(readme).isFile()) {
      DOCS.push(join('packages', name, 'README.md'))
    }
  } catch {
    /* not a package dir */
  }
}
const docsSite = join(root, 'site', 'content', 'docs')
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) {
      return walk(join(dir, e.name))
    }
    return /\.mdx?$/.test(e.name) ? [join(dir, e.name)] : []
  })
DOCS.push(
  ...walk(docsSite).map((p) => p.slice(root.length + 1))
)

// --- Node floor: doc claims must equal the workspace engines floor ------------
const engines = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    engines?: { node?: string }
  }
).engines?.node
const floorM = /^>=\s*(\d+(?:\.\d+)*)$/.exec(engines ?? '')
if (floorM === null) {
  console.error(`package.json engines.node ${JSON.stringify(engines)} is not a '>=x' floor`)
  failed = true
}
const floor = (floorM?.[1] ?? '0').split('.').map(Number)
const sameVersion = (claimed: number[]): boolean => {
  const n = Math.max(claimed.length, floor.length)
  for (let i = 0; i < n; i++) {
    if ((claimed[i] ?? 0) !== (floor[i] ?? 0)) {
      return false
    }
  }
  return true
}
const NODE_TEXT_RE = /[Nn]ode(?:\.js)?\s*(?:≥|>=)\s*(\d+(?:\.\d+){0,2})/g
const NODE_BADGE_RE = /node-%3E%3D(\d+(?:\.\d+){0,2})/g

// --- setup contract: the committed bro.config.json is never setup-written
//     or gitignored in prose — those claims belong to bro.config.local.*.
//     (`bro.config.local.json` and `bro.config.{ts,json}` cannot produce a
//     bare `bro.config.json` match.) Written/gitignored claims with an
//     explicit negation on the same line pass.
const BARE_PROJECT = /bro\.config\.json/
const WRITE_OR_IGNORE = /gitignored|\bwrites?\b|\bwritten\b/
const NEGATED = /(?:never|not|n't)\b/

for (const doc of DOCS) {
  const text = readFileSync(join(root, doc), 'utf8')
  for (const m of [...text.matchAll(NODE_TEXT_RE), ...text.matchAll(NODE_BADGE_RE)]) {
    const claimed = m[1]!.split('.').map(Number)
    if (!sameVersion(claimed)) {
      console.error(
        `${doc}: claims Node ${m[0].replace(/node-%3E%3D/, '>= ')} — engines floor is ${engines}`
      )
      failed = true
    }
  }
  text.split('\n').forEach((line, i) => {
    if (BARE_PROJECT.test(line) && WRITE_OR_IGNORE.test(line) && !NEGATED.test(line)) {
      console.error(
        `${doc}:${i + 1}: presents committed bro.config.json as setup-written/gitignored — ` +
          `the machine-local file is bro.config.local.*: ${line.trim().slice(0, 100)}`
      )
      failed = true
    }
  })
}

const indexMdx = 'site/content/docs/index.mdx'
if (!readFileSync(join(root, indexMdx), 'utf8').includes('bro.config.local.json')) {
  console.error(`${indexMdx}: getting-started never names bro.config.local.json — the file bro setup writes`)
  failed = true
}

if (failed) {
  process.exit(1)
}
console.log('AGENTS.md config claims match bro.config.json')
console.log(`doc contract holds — Node floor ${engines}, setup writes bro.config.local.json`)
