/**
 * Command reference generator — one docs page per registry command,
 * emitted from the live `bro contract dump --json` output (the frozen
 * registry — spec bro-k9ces). Curated guides stay in
 * `site/content/docs/commands/`; `reference/` is the complete,
 * never-rotting index.
 *
 *   node scripts/gen-command-docs.ts          # write
 *   node scripts/gen-command-docs.ts --check  # diff-only drift gate
 *
 * Requires `npm run build` first — the registry is read from dist, not
 * re-declared here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasFlagWord, loadPublishedSurface } from './published-surface.ts'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const outDir = join(root, 'site/content/docs/reference')
const distCli = join(root, 'packages/cli/dist/index.js')

// the npm-published surface is the docs' version boundary — commands
// the tarball does not dispatch get an `npm latest` row marking them
// unreleased (spec bro-l8c4f.17); absent manifest → no row
const published = loadPublishedSurface()

interface Row {
  name: string
  group?: string
  summary: string
  skill?: string
  configKey?: string
  hidden: boolean
  aliasOf?: string
  deprecated?: string
  plan: boolean
  planVersion?: number
  external: boolean
}

interface ContractDump {
  commands: Record<string, Row>
}

if (!existsSync(distCli)) {
  console.error('packages/cli/dist/index.js missing — run `npm run build` first')
  process.exit(2)
}

const rows = Object.values(
  (
    JSON.parse(
      execFileSync(process.execPath, [distCli, 'contract', 'dump', '--json'], {
        encoding: 'utf8',
      })
    ) as ContractDump
  ).commands
)

/** command → curated guide page (site/content/docs/commands/<page>.md).
 *  Wrong links are worse than none — only mapped names get a link. */
const GUIDES: Record<string, string> = {
  act: 'act',
  convoy: 'convoy',
  debt: 'debt',
  drill: 'drill',
  fleet: 'fleet',
  agents: 'fleet',
  daemon: 'fleet',
  drive: 'fleet',
  pulse: 'fleet',
  resume: 'fleet',
  rig: 'fleet',
  watch: 'fleet',
  notify: 'events',
  bus: 'events',
  sinks: 'events',
  judge: 'judge',
  guard: 'guard',
  learn: 'learn',
  loop: 'loop',
  next: 'next',
  providers: 'providers',
  query: 'query',
  retrospect: 'retrospect',
  spec: 'spec',
  stack: 'stack',
  work: 'stack',
  status: 'status',
  serve: 'status',
  sweep: 'sweep',
  check: 'utility',
  cleanup: 'utility',
  doctor: 'utility',
  plugins: 'utility',
  setup: 'utility',
  stamp: 'utility',
  sync: 'utility',
}

const GROUP_ORDER = ['flow', 'fleet', 'review', 'work', 'comms', 'self', 'spec', 'plan', 'mesh']
const GROUP_LABELS: Record<string, string> = {
  flow: 'Flow',
  fleet: 'Fleet',
  review: 'Review',
  work: 'Work',
  comms: 'Comms',
  self: 'Self',
  spec: 'Spec',
  plan: 'Plan',
  mesh: 'Mesh',
  utility: 'Utility',
}
const groupOf = (r: Row): string => r.group ?? 'utility'

// YAML double-quoted scalar — backslash first, then the delimiter,
// then newlines (frontmatter must stay single-line)
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
// prose single-line — a summary with a newline would split the entry,
// and a raw <token> parses as an unclosed MDX tag (bro-mcp's
// `bro_<plane>_<read>` broke the site build) — entities, never <, >
const plain = (s: string): string =>
  s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim()

/** The command signature — the `a|b|c` subcommand list a registry
 *  summary embeds ("Agent supervisor — status|up|down over …"),
 *  rendered as `bro <name> <list>`; absent when the summary declares
 *  none. */
function signature(r: Row): string | undefined {
  const m = /[a-z][a-z0-9-]*(?:\|[a-z0-9][a-z0-9-]*)+/.exec(r.summary)
  return m === null ? undefined : `bro ${r.name} ${m[0]}`
}

/** `a|b` subcommand signature in a registry summary — same extraction
 *  `signature()` uses; compared against the published manifest's subs.
 *  Tokens spelled `--x` elsewhere in the summary are flags
 *  (`--json|install|uninstall` leaks `json`), not subs. */
function currentSubs(r: Row): string[] {
  const m = /[a-z][a-z0-9-]*(?:\|[a-z0-9][a-z0-9-]*)+/.exec(r.summary)
  if (m === null) {
    return []
  }
  return m[0].split('|').filter((s) => !hasFlagWord(r.summary, `--${s}`))
}

/** The npm version boundary for this command: the published version
 *  that ships it, a `— new in <next>` tail when main grew subs the
 *  tarball lacks, or `unreleased` when the tarball has no such command. */
function npmRow(r: Row): string | undefined {
  if (published === undefined) {
    return undefined
  }
  const subs = published.commands[r.name]
  if (subs === undefined) {
    return `unreleased — lands in \`${published.next}\``
  }
  const missing = currentSubs(r).filter((s) => !subs.includes(s))
  if (missing.length === 0) {
    return `\`${published.version}\``
  }
  return `\`${published.version}\` — new in \`${published.next}\`: ${missing.join(', ')}`
}

function page(r: Row, visible: Set<string>): string {
  const lines: string[] = [
    '---',
    `title: "${esc(`bro ${r.name}`)}"`,
    `description: "${esc(r.summary)}"`,
    '---',
    '',
    `**\`bro ${r.name}\`** — ${plain(r.summary)}`,
  ]
  const sig = signature(r)
  if (sig !== undefined) lines.push('', `\`${sig}\``)
  lines.push(
    '',
    '| | |',
    '| --- | --- |',
    `| group | \`${groupOf(r)}\` |`
  )
  const npm = npmRow(r)
  if (npm !== undefined) lines.push(`| npm latest | ${npm} |`)
  if (r.skill !== undefined) lines.push(`| skill | \`${r.skill}\` |`)
  if (r.configKey !== undefined) lines.push(`| config | \`${r.configKey}\` in bro.config |`)
  if (r.plan) lines.push(`| plan | \`kind = "${r.name}"\` (v${r.planVersion ?? 1}) |`)
  const guide = GUIDES[r.name]
  if (guide !== undefined) lines.push(`| guide | [commands/${guide}](/docs/commands/${guide}) |`)
  lines.push('')
  // the loader doesn't type-check aliasOf — a non-string would throw
  // here and abort the whole generation; treat drift as "no alias"
  if (typeof r.aliasOf === 'string' && r.aliasOf !== '') {
    const target = r.aliasOf.split(' ')[0]!
    lines.push(
      visible.has(target)
        ? `Alias for [\`bro ${target}\`](/docs/reference/${target}) — see that page.`
        : // a hidden/internal target has no page to link — name it, don't promise one
          `Alias for \`bro ${r.aliasOf}\` (internal — no reference page).`
    )
    if (r.deprecated !== undefined) {
      lines.push('', `> Deprecated — ${r.deprecated}`)
    }
    lines.push('')
  }
  return lines.join('\n') + '\n'
}

const visible = new Set(rows.filter((r) => !r.hidden).map((r) => r.name))
const files = new Map<string, string>()

/** A page name must be a filename — an external plugin's name lands in
 *  `<name>.md` verbatim, so `../../../../README` would write outside
 *  reference/. Anything else is skipped loudly, never written. */
const SAFE_PAGE = /^[a-z0-9][a-z0-9._-]*$/

for (const r of rows) {
  // external plugins resolve from the CALLER's config — generated
  // pages must be the core registry only or output varies by checkout
  if (r.hidden || r.external) continue
  if (!SAFE_PAGE.test(r.name)) {
    console.error(`skip: unsafe page name "${r.name}" — not a filename`)
    continue
  }
  files.set(`${r.name}.md`, page(r, visible))
}

// meta.json — grouped sections in fixed order, registry order inside
const grouped = new Map<string, string[]>()
for (const r of rows) {
  if (r.hidden || r.external || !SAFE_PAGE.test(r.name)) continue
  const g = groupOf(r)
  if (!grouped.has(g)) grouped.set(g, [])
  grouped.get(g)!.push(r.name)
}
const pages: string[] = []
for (const g of [...GROUP_ORDER, ...[...grouped.keys()].filter((k) => !GROUP_ORDER.includes(k))]) {
  const names = grouped.get(g)
  if (names === undefined) continue
  pages.push(`---${GROUP_LABELS[g] ?? g}---`, ...names)
}
files.set('meta.json', JSON.stringify({ pages }, null, 2) + '\n')

const check = process.argv.includes('--check')
if (!check) {
  mkdirSync(outDir, { recursive: true })
}
const onDisk = existsSync(outDir) ? new Set(readdirSync(outDir)) : new Set<string>()
let drift = 0
for (const [name, content] of files) {
  const p = join(outDir, name)
  if (!existsSync(p) || readFileSync(p, 'utf8') !== content) {
    if (check) {
      console.error(`stale: reference/${name}`)
      drift++
    } else {
      writeFileSync(p, content)
    }
  }
  onDisk.delete(name)
}
for (const extra of onDisk) {
  if (check) {
    console.error(`stray: reference/${extra} — not in the registry`)
    drift++
  } else {
    rmSync(join(outDir, extra))
  }
}
if (check && drift > 0) {
  console.error(`${drift} stale file(s) — run \`npm run gen:command-docs\``)
  process.exit(1)
}
if (!check) {
  console.log(`reference/: ${files.size - 1} pages + meta.json`)
}
