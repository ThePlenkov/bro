/**
 * Command reference generator — one docs page per registry command,
 * emitted from the live `bro plugins --json` output (the same registry
 * `--help` reads). Curated guides stay in `site/content/docs/commands/`;
 * `reference/` is the complete, never-rotting index.
 *
 *   node scripts/gen-command-docs.ts          # write
 *   node scripts/gen-command-docs.ts --check  # diff-only drift gate
 *
 * Requires `npm run build` first — the registry is read from dist, not
 * re-declared here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const outDir = join(root, 'site/content/docs/reference')
const distCli = join(root, 'packages/cli/dist/index.js')

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

if (!existsSync(distCli)) {
  console.error('packages/cli/dist/index.js missing — run `npm run build` first')
  process.exit(2)
}

const rows = JSON.parse(
  execFileSync(process.execPath, [distCli, 'plugins', '--json'], { encoding: 'utf8' })
) as Row[]

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

const esc = (s: string): string => s.replace(/"/g, '\\"')

function page(r: Row, visible: Set<string>): string {
  const lines: string[] = [
    '---',
    `title: bro ${r.name}`,
    `description: "${esc(r.summary)}"`,
    '---',
    '',
    `**\`bro ${r.name}\`** — ${r.summary}`,
    '',
    '| | |',
    '| --- | --- |',
    `| group | \`${groupOf(r)}\` |`,
  ]
  if (r.skill !== undefined) lines.push(`| skill | \`${r.skill}\` |`)
  if (r.configKey !== undefined) lines.push(`| config | \`${r.configKey}\` in bro.config |`)
  if (r.plan) lines.push(`| plan | \`kind = "${r.name}"\` (v${r.planVersion ?? 1}) |`)
  const guide = GUIDES[r.name]
  if (guide !== undefined) lines.push(`| guide | [commands/${guide}](/docs/commands/${guide}) |`)
  lines.push('')
  if (r.aliasOf !== undefined) {
    const target = r.aliasOf.split(' ')[0]!
    const link = visible.has(target)
      ? `[\`bro ${target}\`](/docs/reference/${target})`
      : `\`bro ${r.aliasOf}\``
    lines.push(`Alias for ${link} — see that page.`)
    if (r.deprecated !== undefined) {
      lines.push('', `> Deprecated — ${r.deprecated}`)
    }
    lines.push('')
  }
  return lines.join('\n') + '\n'
}

const visible = new Set(rows.filter((r) => !r.hidden).map((r) => r.name))
const files = new Map<string, string>()

for (const r of rows) {
  if (r.hidden) continue
  files.set(`${r.name}.md`, page(r, visible))
}

// meta.json — grouped sections in fixed order, registry order inside
const grouped = new Map<string, string[]>()
for (const r of rows) {
  if (r.hidden) continue
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
  }
}
if (check && drift > 0) {
  console.error(`${drift} stale file(s) — run \`npm run gen:command-docs\``)
  process.exit(1)
}
if (!check) {
  console.log(`reference/: ${files.size - 1} pages + meta.json`)
}
