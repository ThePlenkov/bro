/**
 * Published-surface snapshot — records what `npm i -g @broject/bro`
 * dispatches into contract/published.json. Docs mark commands the
 * manifest does not know as unreleased, and check:onboarding validates
 * the onboarding pages against it (spec bro-l8c4f.17).
 *
 *   node scripts/gen-published.ts [--spec @broject/bro@latest] [--next 0.3.0]
 *   node scripts/gen-published.ts --check            # drift check vs live npm
 *
 * Runs the install + `--help` probes inside a non-git scratch dir —
 * published commands like `bro sync`/`bro watch` execute rather than
 * print help, and a git cwd would give them a store to write to.
 * Refresh after every release — the snapshot is the docs' version
 * boundary.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installPublished,
  loadPublishedSurface,
  parseTopLevelHelp,
  PUBLISHED_PATH,
  publishedVersion,
  runBin,
  subsOf,
  type PublishedSurface,
} from './published-surface.ts'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const check = argv.includes('--check')
const spec = flag('--spec') ?? process.env.BRO_PUBLISHED_SPEC ?? '@broject/bro@latest'
const version = publishedVersion(spec)
const existing = loadPublishedSurface()
const next = flag('--next') ?? existing?.next ?? '0.3.0'

if (check && existing && existing.version === version) {
  console.log(`published.json already at ${spec} → ${version}`)
  process.exit(0)
}

const { bin } = installPublished(spec)
// non-git scratch — `bro <name> --help` executes on some commands
// (sync/watch/doctor/fleet) and a repo cwd would give them side effects
const scratch = mkdtempSync(join(tmpdir(), 'bro-published-scratch-'))
const top = parseTopLevelHelp(runBin(bin, ['--help'], scratch))
if (top.commands.size === 0) {
  console.error(`no Commands: block parsed from ${spec} --help`)
  process.exit(1)
}

const commands: Record<string, string[]> = {}
for (const [name, summary] of top.commands) {
  commands[name] = subsOf(name, runBin(bin, [name, '--help'], scratch), summary)
}

const at = spec.lastIndexOf('@')
const surface: PublishedSurface = {
  package: at > 0 ? spec.slice(0, at) : spec,
  spec: at > 0 ? spec.slice(at + 1) : 'latest',
  version,
  next,
  generatedAt: new Date().toISOString(),
  commands,
  docNouns: top.docNouns,
  docVerbs: top.docVerbs,
}

if (check) {
  const have = JSON.stringify({ ...(existing ?? {}), generatedAt: undefined }, null, 2)
  const want = JSON.stringify({ ...surface, generatedAt: undefined }, null, 2)
  if (have === want) {
    console.log(`published.json in sync with ${spec} (${version})`)
    process.exit(0)
  }
  console.error(`published.json differs from ${spec} (${version}) — run \`npm run gen:published\``)
  process.exit(1)
}

writeFileSync(PUBLISHED_PATH, `${JSON.stringify(surface, null, 2)}\n`)
console.log(
  `contract/published.json: ${spec} → ${version} (${Object.keys(commands).length} commands)`
)
