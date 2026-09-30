/**
 * `bro setup` — wire bro into the current repo.
 *
 *   bro setup [--beads] [--skills] [--pack [NAME]] [--personality NAME]
 *
 * Detects gh + bd, writes bro.config.json (never clobbers existing keys),
 * optionally runs `bd init --stealth`, and drops thin skill wrappers into
 * .agents/skills/. `--pack` installs the capability pack (skills/ +
 * formulas/ trees) from an npm package — the repo's own node_modules
 * first, then the CLI's — instead of the embedded snapshot.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { initBeadsStealth, PERSONALITIES, type BroConfig } from '@broject/core'
import { loadBroConfig } from '../plugins.ts'
import { FORMULA_FILES, SKILL_FILES } from '../skills-data.ts'

function hasBin(name: string): boolean {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' }) // NOSONAR — user-installed CLI; PATH lookup is the contract
    return true
  } catch {
    return false
  }
}

function ghAuthed(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }) // NOSONAR — PATH lookup is the contract
    return true
  } catch {
    return false
  }
}

function readExistingConfig(path: string): Partial<BroConfig> | null {
  if (!existsSync(path)) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(`error: bro.config.json is not valid JSON — ${(err as Error).message}`)
    process.exit(1)
  }
  // Valid JSON can still be an invalid config — a non-object or a mistyped
  // `stores` would silently normalize to defaults and get overwritten by
  // setup. Fail before anything mutates.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('error: bro.config.json must be a JSON object')
    process.exit(1)
  }
  if ('stores' in parsed && !Array.isArray(parsed.stores)) {
    console.error('error: bro.config.json "stores" must be an array, e.g. ["jsonl", "beads"]')
    process.exit(1)
  }
  return parsed as Partial<BroConfig>
}

function writeConfig(opts: { beads: boolean; personality?: string }): string {
  // bro.config.ts shadows bro.config.json — writing the .json under it
  // would report success while the .ts stays effective
  if (existsSync(join(process.cwd(), 'bro.config.ts'))) {
    // --beads still initialized .beads above — flag it if the effective
    // (.ts) config doesn't actually enable the store
    const orphan =
      opts.beads && !loadBroConfig().stores.includes('beads')
        ? '\n    note: .beads initialized but "beads" is not in bro.config.ts stores'
        : ''
    return `bro.config.ts present and takes precedence — edit it directly, not writing bro.config.json${orphan}`
  }
  const path = join(process.cwd(), 'bro.config.json')
  const existed = existsSync(path)
  const existing = readExistingConfig(path)!
  // loadConfig normalizes legacy `store` into `stores`, so writing the
  // merged shape back migrates v0.1.0 configs in place.
  const merged: BroConfig = { ...loadBroConfig() }
  if (opts.beads && !merged.stores.includes('beads')) {
    merged.stores = [...merged.stores, 'beads']
  }
  if (opts.personality) {
    merged.personality = opts.personality as BroConfig['personality']
  }
  if (existed && JSON.stringify(existing) === JSON.stringify(merged)) {
    return 'bro.config.json already up to date'
  }
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return `${existed ? 'updated' : 'wrote'} bro.config.json (stores: ${merged.stores.join(', ')})`
}

/** Install files under root; returns installed count. Warns on drift. */
function installFiles(root: string, files: Record<string, string>, what: string): number {
  let n = 0
  for (const [rel, content] of Object.entries(files)) {
    const path = join(process.cwd(), root, rel)
    if (existsSync(path)) {
      if (readFileSync(path, 'utf8') === content) {
        continue
      }
      console.error(`  warning: overwriting modified ${what} ${rel}`)
    }
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
    n += 1
    console.error(`  installed ${root}/${rel}`)
  }
  return n
}

const DEFAULT_PACK = '@broject/bro-pack'

/** Resolves `<spec>/package.json` — the repo's node_modules first (a
 *  project-installed pack wins), then the CLI's own install tree so the
 *  published binary finds its bundled dependency. */
export function resolvePackDir(spec: string, cwd = process.cwd()): string | null {
  for (const referrer of [join(cwd, 'noop.js'), fileURLToPath(import.meta.url)]) {
    try {
      return dirname(createRequire(referrer).resolve(`${spec}/package.json`))
    } catch {
      // specifier not visible from this referrer — try the next
    }
  }
  return null
}

/** Reads every file under dir into {relpath: utf8} — the pack's skills/
 *  and formulas/ trees are flat capability bundles, not modules. */
export function readPackTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(path).isDirectory()) {
        walk(path, rel)
      } else {
        out[rel] = readFileSync(path, 'utf8')
      }
    }
  }
  walk(dir, '')
  return out
}

function setupPack(spec: string, wantsBeads: boolean): void {
  const dir = resolvePackDir(spec)
  if (dir === null) {
    console.error(`error: pack ${spec} not resolvable — install it or check the "pack" config key`)
    process.exit(1)
  }
  const skillsDir = join(dir, 'skills')
  const formulasDir = join(dir, 'formulas')
  if (!existsSync(skillsDir)) {
    console.error(`error: ${spec} resolved to ${dir} but has no skills/ tree — not a bro pack`)
    process.exit(1)
  }
  console.error(`  pack: ${spec} → ${dir}`)
  installFiles(join('.agents', 'skills'), readPackTree(skillsDir), 'skill')
  if (wantsBeads && existsSync(formulasDir)) {
    installFiles(join('.beads', 'formulas'), readPackTree(formulasDir), 'formula')
  }
}

function setupBeads(): void {
  if (initBeadsStealth()) {
    console.error('  initialized .beads (stealth — nothing lands in git)')
  } else {
    console.error('  .beads already initialized')
  }
  installFiles(join('.beads', 'formulas'), FORMULA_FILES, 'formula')
}

interface SetupArgs {
  beads: boolean
  skills: boolean
  /** --pack without a value means "the configured/default pack". */
  pack: false | string
  personality?: string
}

function parseSetupArgs(argv: string[]): SetupArgs {
  const pIdx = argv.indexOf('--personality')
  const pVal = pIdx >= 0 ? argv[pIdx + 1] : undefined
  if (pIdx >= 0 && (!pVal || pVal.startsWith('--'))) {
    console.error('error: --personality requires a value')
    process.exit(2)
  }
  if (pVal && !(PERSONALITIES as readonly string[]).includes(pVal)) {
    console.error(`error: --personality must be one of: ${PERSONALITIES.join(', ')}`)
    process.exit(2)
  }
  const kIdx = argv.indexOf('--pack')
  let pack: SetupArgs['pack'] = false
  if (kIdx >= 0) {
    const kVal = argv[kIdx + 1]
    pack = kVal !== undefined && !kVal.startsWith('--') ? kVal : ''
  }
  return {
    beads: argv.includes('--beads'),
    skills: argv.includes('--skills'),
    pack,
    personality: pVal,
  }
}

function checkPrereqs(needBeads: boolean): void {
  const gh = hasBin('gh')
  const ghOk = gh && ghAuthed()
  const bd = hasBin('bd')
  let ghState = '✗ missing'
  if (gh) {
    ghState = ghOk ? '✓ authed' : '✗ not authed'
  }
  console.error(`bro setup: gh ${ghState} | bd ${bd ? '✓' : '✗ missing'}`)

  if (!gh) {
    console.error('error: gh CLI is required — https://cli.github.com')
    process.exit(1)
  }
  if (!ghOk) {
    console.error('error: gh not authenticated — run `gh auth login` first')
    process.exit(1)
  }
  // Validate prerequisites before writing anything — a config pointing at a
  // store we can't run would strand the repo.
  if (needBeads && !bd) {
    console.error(
      'error: bd not found — install beads (https://github.com/gastownhall/beads) ' +
        'or opt out with "stores": ["jsonl"] in bro.config.json'
    )
    process.exit(1)
  }
}

export async function runSetupCommand(argv: string[]): Promise<void> {
  const { beads, skills, pack, personality } = parseSetupArgs(argv)
  // A malformed bro.config.json must fail BEFORE any mutation (bd init,
  // file installs) — readExistingConfig exits on a parse error; loadConfig
  // alone would silently fall back to defaults and setup would init beads
  // on top of a broken config.
  // …but a bro.config.ts shadows the .json entirely — validating the
  // inert file would fail setup on a config that isn't even effective.
  if (!existsSync(join(process.cwd(), 'bro.config.ts'))) {
    readExistingConfig(join(process.cwd(), 'bro.config.json'))
  }
  // beads is a default store — setup needs bd whenever the effective config
  // keeps it on, not only when --beads was passed explicitly.
  const wantsBeads = beads || loadBroConfig().stores.includes('beads')
  checkPrereqs(wantsBeads)

  // bd init + formulas land BEFORE the config write — if beads setup fails,
  // no config claiming store=both is left behind.
  if (wantsBeads) {
    setupBeads()
  }

  console.error(`  ${writeConfig({ beads, personality })}`)

  if (skills) {
    if (installFiles(join('.agents', 'skills'), SKILL_FILES, 'skill') === 0) {
      console.error('  skills already installed and current')
    }
  }

  if (pack !== false) {
    setupPack(pack || loadBroConfig().pack || DEFAULT_PACK, wantsBeads)
  }

  console.error('bro setup: done. Next: `bro debt prs` to see the queue, `bro debt collect` to sweep.')
}
