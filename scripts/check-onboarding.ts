/**
 * Onboarding↔release gate — the copy/paste path the docs offer a fresh
 * user must dispatch on the published npm tarball (spec bro-l8c4f.17).
 *
 *   node scripts/check-onboarding.ts [--spec @broject/bro@latest] [file…]
 *
 * The isolated fixture is real: `npm i -g --prefix <tmp> <spec>` is what
 * a clean install runs; `bro --version`/`bro --help` are asserted. Every
 * fenced `bro …`/`npx @broject/bro …` line in the onboarding pages is
 * then checked at dispatch level — its first token must name a
 * published command/doc noun/doc verb, and its second token (when not a
 * flag or placeholder) must be a recorded subcommand in
 * contract/published.json. Documented argv is never executed — several
 * published commands run on `--help` and carry side effects.
 *
 * Needs network (npm registry) — CI only. A published.json version
 * behind npm latest downgrades subcommand assertions to warnings:
 * refreshing the manifest is a release chore (`npm run gen:published`),
 * not a PR blocker.
 */
import { join } from 'node:path'
import {
  extractDocLines,
  loadPublishedSurface,
  NpmSpec,
  root,
} from './published-surface.ts'

const argv = process.argv.slice(2)
const spec = NpmSpec.resolve(argv)
const files = argv
  .filter((a) => a.endsWith('.md') || a.endsWith('.mdx'))
  .map((f) => (f.startsWith('/') ? f : join(root, f)))
const pages =
  files.length > 0
    ? files
    : [join(root, 'site/content/docs/index.mdx'), join(root, 'README.md')]

const { install, top, version } = spec.probe()

// the literal install steps — --version and --help are the two
// invocations every onboarding page leads with
const vout = install.run(['--version'])
if (!vout.includes(version)) {
  console.error(`${spec}: \`bro --version\` printed ${vout.trim() || '(nothing)'}, expected ${version}`)
  process.exit(1)
}
if (top.commands.size === 0) {
  console.error(`${spec}: no Commands: block parsed from \`bro --help\``)
  process.exit(1)
}
const liveNames = new Set([...top.commands.keys(), ...top.docNouns, ...top.docVerbs])

const manifest = loadPublishedSurface()
const manifestFresh = manifest?.version === version
if (manifest === undefined) {
  console.error('warning: contract/published.json missing — subcommand checks skipped')
} else if (!manifestFresh) {
  console.error(
    `warning: published.json is at ${manifest.version}, npm latest is ${version} — subcommand checks downgraded to warnings; run \`npm run gen:published\``
  )
}

let failed = 0
let warned = 0
let checked = 0
for (const page of pages) {
  for (const { file, line, argv: args, raw } of extractDocLines(page)) {
    const [t1, t2] = args
    if (t1 === undefined || t1.startsWith('-')) {
      continue // `--help`/`--version`/bare `bro` — covered by the fixture above
    }
    checked++
    const where = `${file}:${line}`
    if (!liveNames.has(t1)) {
      console.error(`${where} \`${raw}\` — '${t1}' is not a published command on ${spec} (${version})`)
      failed++
      continue
    }
    if (
      t2 === undefined ||
      t2.startsWith('-') ||
      t2.startsWith('<') ||
      top.docNouns.includes(t1) ||
      top.docVerbs.includes(t1)
    ) {
      continue // flag, placeholder, or a doc-verb whose noun is data
    }
    const subs = manifest?.commands[t1]
    if (subs === undefined || subs.length === 0) {
      continue // no published subs recorded — nothing to assert against
    }
    if (!subs.includes(t2)) {
      const msg = `${where} \`${raw}\` — '${t2}' is not a published 'bro ${t1}' subcommand on ${version}`
      if (manifestFresh) {
        console.error(msg)
        failed++
      } else {
        console.error(`warning: ${msg}`)
        warned++
      }
    }
  }
}

if (failed > 0) {
  console.error(`check-onboarding: ${failed} doc line(s) do not dispatch on ${spec} (${version})`)
  process.exit(1)
}
const tail = warned === 0 ? '' : ` — ${warned} warning(s)`
console.log(`check-onboarding: ${checked} doc line(s) dispatch on ${spec} (${version})${tail}`)
