/**
 * `bro setup` — wire bro into the current repo.
 *
 *   bro setup [--beads] [--skills] [--pack [NAME]] [--personality NAME]
 *
 * Detects gh + bd, writes bro.config.local.json (never clobbers existing
 * keys — setup's stores/personality keys are operator config and land in
 * the gitignored local layer, spec: specs/bro-9vmx.md),
 * optionally runs `bd init --stealth`, and drops thin skill wrappers into
 * .agents/skills/. `--pack` installs the capability pack (skills/ +
 * formulas/ trees) from an npm package — the repo's own node_modules
 * first, then the CLI's — instead of the embedded snapshot.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { initBeadsStealth, PERSONALITIES, type BroConfig } from '@broject/core'
import { loadBroConfig } from '../plugins.ts'
import {
  cliVersion,
  installCommitHook,
  installPostMergeHook,
  installRefGuardHook,
} from './githooks.ts'
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
    console.error(`error: ${basename(path)} is not valid JSON — ${(err as Error).message}`)
    process.exit(1)
  }
  // Valid JSON can still be an invalid config — a non-object or a mistyped
  // `stores` would silently normalize to defaults and get overwritten by
  // setup. Fail before anything mutates.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`error: ${basename(path)} must be a JSON object`)
    process.exit(1)
  }
  if ('stores' in parsed && !Array.isArray(parsed.stores)) {
    console.error(`error: ${basename(path)} "stores" must be an array, e.g. ["jsonl", "beads"]`)
    process.exit(1)
  }
  return parsed as Partial<BroConfig>
}

function writeConfig(opts: { beads: boolean; personality?: string }): string {
  // setup's keys (stores, personality) are operator config — they land in
  // the gitignored local layer, never the committed bro.config.* files
  // (spec: specs/bro-9vmx.md). bro.config.local.ts shadows the .json —
  // writing under it would report success while the .ts stays effective
  if (existsSync(join(process.cwd(), 'bro.config.local.ts'))) {
    // --beads still initialized .beads above — flag it if the effective
    // (.ts) config doesn't actually enable the store
    const orphan =
      opts.beads && !loadBroConfig().stores.includes('beads')
        ? '\n    note: .beads initialized but "beads" is not in bro.config.local.ts stores'
        : ''
    return `bro.config.local.ts present and takes precedence — edit it directly, not writing bro.config.local.json${orphan}`
  }
  const path = join(process.cwd(), 'bro.config.local.json')
  const existed = existsSync(path)
  const existing = readExistingConfig(path)!
  // Only local-layer keys land in the file: spreading the merged
  // effective config here would pin project/global values into the
  // highest-precedence layer and mask later project edits.
  const effective = loadBroConfig()
  const merged: Partial<BroConfig> = { ...existing }
  if (opts.beads && !effective.stores.includes('beads')) {
    merged.stores = [...(merged.stores ?? effective.stores), 'beads']
  }
  if (opts.personality) {
    merged.personality = opts.personality as BroConfig['personality']
  }
  if (existed && JSON.stringify(existing) === JSON.stringify(merged)) {
    return 'bro.config.local.json already up to date'
  }
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  const stores = merged.stores ?? effective.stores
  const hint = existed ? '' : ' — gitignored (machine-local overrides live here)'
  return `${existed ? 'updated' : 'wrote'} bro.config.local.json (stores: ${stores.join(', ')})${hint}`
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
 *  and formulas/ trees are flat capability bundles, not modules.
 *  Symlinks are not followed: a pack must be self-contained, and
 *  lstat over stat keeps the walk inside the package tree. */
export function readPackTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const st = lstatSync(path)
      if (st.isSymbolicLink()) {
        continue
      }
      if (st.isDirectory()) {
        walk(path, rel)
      } else {
        out[rel] = readFileSync(path, 'utf8')
      }
    }
  }
  walk(dir, '')
  return out
}

/** Validates a pack spec early — setup must fail on a missing/broken
 *  pack BEFORE any mutation (beads init, config write, skill installs). */
export function checkedPackDir(spec: string): string {
  const dir = resolvePackDir(spec)
  if (dir === null) {
    console.error(`error: pack ${spec} not resolvable — install it or check the "pack" config key`)
    process.exit(1)
  }
  if (!existsSync(join(dir, 'skills'))) {
    console.error(`error: ${spec} resolved to ${dir} but has no skills/ tree — not a bro pack`)
    process.exit(1)
  }
  return dir
}

function setupPack(dir: string, spec: string, wantsBeads: boolean): void {
  console.error(`  pack: ${spec} → ${dir}`)
  installFiles(join('.agents', 'skills'), readPackTree(join(dir, 'skills')), 'skill')
  const formulasDir = join(dir, 'formulas')
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
        'or opt out with "stores": ["jsonl"] in bro.config.local.json'
    )
    process.exit(1)
  }
}

export async function runSetupCommand(argv: string[]): Promise<void> {
  const { beads, skills, pack, personality } = parseSetupArgs(argv)
  // A malformed config file must fail BEFORE any mutation (bd init,
  // file installs) — readExistingConfig exits on a parse error; loadConfig
  // alone would silently fall back to defaults and setup would init beads
  // on top of a broken config.
  // …but a .ts shadows the .json in the same layer — validating the
  // inert file would fail setup on a config that isn't even effective.
  if (!existsSync(join(process.cwd(), 'bro.config.ts'))) {
    readExistingConfig(join(process.cwd(), 'bro.config.json'))
  }
  if (!existsSync(join(process.cwd(), 'bro.config.local.ts'))) {
    readExistingConfig(join(process.cwd(), 'bro.config.local.json'))
  }
  // beads is a default store — setup needs bd whenever the effective config
  // keeps it on, not only when --beads was passed explicitly.
  const wantsBeads = beads || loadBroConfig().stores.includes('beads')
  // Validate the pack BEFORE beads init/config/skills mutate anything —
  // a bad spec must fail setup on a clean tree, not a half-written one.
  const packDir = pack === false ? null : checkedPackDir(pack || loadBroConfig().pack || DEFAULT_PACK)
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

  if (packDir !== null) {
    setupPack(packDir, pack || loadBroConfig().pack || DEFAULT_PACK, wantsBeads)
  }

  // git hooks ride setup — a repo that opts into bro gets both
  // without a second step; `bro hooks uninstall` is the opt-out:
  //   commit provenance (bro-fzot): Agent/Session/Bead trailers on
  //     machine-made commits
  //   refguard (bro-1c78): non-ff moves of shared branch refs vetoed
  //   post-merge (bro-sovl3): install → build → patch after a merge
  // Best-effort: a non-git dir just skips.
  const hook = installCommitHook(process.cwd(), cliVersion())
  if (hook.state === 'error') {
    console.error(`  note: commit-provenance hook not installed — ${hook.err}`)
  } else if (hook.state !== 'already') {
    console.error(`  ${hook.state} prepare-commit-msg hook (${hook.path})`)
  }
  const guard = installRefGuardHook(process.cwd(), cliVersion())
  if (guard.state === 'error') {
    console.error(`  note: refguard hook not installed — ${guard.err}`)
  } else if (guard.state !== 'already') {
    console.error(`  ${guard.state} reference-transaction hook (${guard.path})`)
  }
  const fresh = installPostMergeHook(process.cwd(), cliVersion())
  if (fresh.state === 'error') {
    console.error(`  note: post-merge hook not installed — ${fresh.err}`)
  } else if (fresh.state !== 'already') {
    console.error(`  ${fresh.state} post-merge hook (${fresh.path})`)
  }

  console.error('bro setup: done. Next: `bro debt prs` to see the queue, `bro debt collect` to sweep.')
}
