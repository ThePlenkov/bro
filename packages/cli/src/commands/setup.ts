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
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { checkSkillLock, initBeadsStealth, PERSONALITIES, hasHelpFlag, printUsage, readSkillLock, withFileLock, type BroConfig, type LockedSkill, type SkillDrift } from '@broject/core'
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

/** The local layer is machine-local state — the same `.git/info/exclude`
 *  contract the debt ledger and `bd init --stealth` already keep (spec:
 *  specs/bro-9vmx.md): what setup writes must never be committable by
 *  accident. Appends `bro.config.local.*` once; a repo already covering
 *  the pattern (.gitignore / global excludes) is left alone. Outside a
 *  worktree there is nothing to exclude from — quiet skip. */
function ensureLocalConfigExcluded(): void {
  const git = (args: string[], cwd = process.cwd()): string =>
    execFileSync('git', ['-C', cwd, ...args], { // NOSONAR — PATH lookup is the contract
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  let root: string
  try {
    root = git(['rev-parse', '--show-toplevel'])
  } catch (err) {
    // Quiet skip only on a proven "not a worktree" (or missing git) — a
    // transient git/perm failure warns instead, since a silently
    // trackable local config is exactly what this guard prevents.
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    if (e.code === 'ENOENT' || (e.stderr ?? '').includes('not a git repository')) {
      return
    }
    console.error(
      `warning: could not resolve git root — ` +
        `${(e.stderr ?? '').trim() || e.message}; the local config may be trackable`
    )
    return
  }
  // The config lands in cwd — possibly a repo subdir a root-anchored
  // .gitignore rule doesn't reach — so coverage is checked at the write
  // location, and BOTH supported local extensions must be covered
  // before the exclusion step is skipped.
  const isIgnored = (name: string): boolean => {
    try {
      execFileSync('git', ['-C', process.cwd(), 'check-ignore', '-q', '--', name], { // NOSONAR — git PATH lookup is the contract
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }
  const names = ['bro.config.local.json', 'bro.config.local.ts']
  try {
    if (!names.every(isIgnored)) {
      // --git-path answers relative to the -C dir: run it from the root so
      // a relative result is root-relative. From a subdir cwd git would
      // answer ../… and join(root, …) would land outside the repo.
      const excludePath = git(['rev-parse', '--git-path', 'info/exclude'], root)
      const path = isAbsolute(excludePath) ? excludePath : join(root, excludePath)
      // The exclude file is DATA — the lock lives on a sibling path.
      // withFileLock's contract is create-if-absent + stale-lock steal: a
      // pre-existing exclude file at the lock path would be judged a dead
      // hold, renamed aside and deleted, then rewritten as a lock token.
      withFileLock(`${path}.lock`, () => {
        const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
        const entry = 'bro.config.local.*'
        if (!existing.split('\n').includes(entry)) {
          const nl = existing === '' || existing.endsWith('\n') ? '' : '\n'
          // atomic write inside the lock — a truncated exclude would drop
          // unrelated local rules, not just ours
          const tmpPath = `${path}.tmp.${process.pid}`
          writeFileSync(tmpPath, `${existing}${nl}${entry}\n`, 'utf8')
          renameSync(tmpPath, path)
        }
      })
      // .gitignore outranks info/exclude — a `!pattern` negation keeps the
      // file trackable even after the write. Re-check at the write
      // location instead of reporting "gitignored" on faith.
      if (!names.every(isIgnored)) {
        console.error(
          'warning: bro.config.local.* still trackable — a .gitignore ' +
            '"!pattern" negation overrides .git/info/exclude; fix the rule manually'
        )
      }
    }
    // Ignores never override the index — an already-tracked local config
    // stays tracked and any exclusion is a no-op for it. The check runs
    // whether or not a rule covers the name: ignored-but-tracked is the
    // silent case this warning exists for. Untracking is a staged change
    // only the repo owner should make.
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '--', 'bro.config.local.*'], { // NOSONAR — git PATH lookup is the contract
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (tracked !== '') {
      console.error(
        'warning: bro.config.local.* has tracked files — .git/info/exclude ' +
          "can't hide index entries; run `git rm --cached` to untrack"
      )
    }
  } catch (err) {
    console.error(
      `warning: could not git-exclude bro.config.local.* — ` +
        `${err instanceof Error ? err.message : err}; the local config may be trackable`
    )
  }
}

export function writeConfig(opts: { beads: boolean; personality?: string }): string {
  // The written file is called "gitignored" by every doc that mentions
  // it — make that true here, not only in repos whose .gitignore
  // already carries the pattern.
  ensureLocalConfigExcluded()
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
  /** Materialise the locked external skills (skills-lock.json). */
  lock: boolean
  /** Report what --lock would do, without installing. */
  dryRun: boolean
  /** Verify the installed skills against the lock, without installing. */
  checkOnly: boolean
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
    // `--pack off` disables pack install — same false sentinel as bare
    pack = kVal === 'off' ? false : kVal !== undefined && !kVal.startsWith('--') ? kVal : ''
  }
  return {
    beads: argv.includes('--beads'),
    skills: argv.includes('--skills'),
    pack,
    personality: pVal,
    lock: argv.includes('--lock'),
    dryRun: argv.includes('--dry-run'),
    checkOnly: argv.includes('--check'),
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

/**
 * Materialise the locked external skills — the ones bro does not own.
 *
 * The lockfile says which skill came from where and what its content hash
 * was. bro does not re-implement the fetching: `npx skills` already produces
 * this lockfile, so bro drives the same CLI and then checks the installed
 * copies against the lock. A copy whose hash drifted is reported, not
 * silently updated.
 *
 * Fail-open: no lockfile means nothing to do, no `npx` means the install is
 * skipped with a line saying so, and one unreachable upstream does not stop
 * the rest.
 */
function setupLockedSkills(dir: string, dryRun: boolean, checkOnly: boolean): void {
  const locked = readSkillLock(dir)
  if (locked.size === 0) {
    console.error('  no skills-lock.json — nothing locked')
    return
  }
  const skillsDir = join(dir, '.agents', 'skills')

  // Drift check BEFORE any install — the installer replaces the skill
  // directory it owns, so installing over a copy with local edits would
  // erase them. Check first; a drifted skill is reported and left alone.
  const before = checkSkillLock(locked, skillsDir)
  reportBeforeDrift(before, dryRun, checkOnly)

  if (!checkOnly && !dryRun) {
    installLockedSkills(dir, locked, before, skillsDir)
  }

  // `npx skills` rewrites the lockfile as it installs, so the hashes it
  // just wrote are the ones to check against — the copy read before the
  // install is stale by definition. Re-read it.
  const current = checkOnly || dryRun ? locked : readSkillLock(dir)
  reportAfterDrift(current, skillsDir)
}

function reportBeforeDrift(before: SkillDrift[], dryRun: boolean, checkOnly: boolean): void {
  if (before.length === 0) return
  for (const d of before) {
    console.error(
      `  ${d.name}: ${d.kind === 'missing' ? 'not installed' : 'local edits differ from the lock'} (${d.source})`
    )
  }
  if (dryRun || checkOnly) {
    // For dry-run/check, we also need to report the matching skills
    // but we don't have the full locked map here — just return
    // The caller will handle the after-install report
  }
}

function installLockedSkills(dir: string, locked: Map<string, LockedSkill>, before: SkillDrift[], skillsDir: string): void {
  if (!hasBin('npx')) {
    console.error('  npx not on PATH — skipping the locked skills')
    return
  }
  for (const skill of locked.values()) {
    // Skip skills that already have local drift — they were reported above
    const drifted = before.find((d) => d.name === skill.name && d.kind === 'drifted')
    if (drifted !== undefined) {
      continue
    }
    installOneLockedSkill(dir, skill)
  }
}

function installOneLockedSkill(dir: string, skill: LockedSkill): void {
  // `npx skills add` owns the fetch, the symlink and the lockfile
  // update; bro only decides what to ask for.
  try {
    // spawnSync, not execFileSync: `npx` is a PATH lookup and the PATH
    // contract is the same one gh/bd/git already have (doctor.ts probes
    // npx the same way).
    const p = spawnSync('npx', ['--yes', 'skills', 'add', skill.source, '--skill', skill.name], { // NOSONAR — PATH lookup is the contract (same as gh/bd/git)
      cwd: dir,
      stdio: 'pipe',
      timeout: 300_000,
    })
    if (p.error !== undefined || p.status !== 0) {
      const stderr = p.stderr?.toString().trim() || ''
      const stdout = p.stdout?.toString().trim() || ''
      throw new Error(
        `npx skills add exited ${p.status ?? 'with error'}${stderr ? `: ${stderr}` : ''}${stdout ? ` (stdout: ${stdout})` : ''}`
      )
    }
  } catch (err) {
    // one unreachable upstream does not stop the rest
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`  ${skill.name}: could not fetch from ${skill.source} — ${msg}`)
  }
}

function reportAfterDrift(current: Map<string, LockedSkill>, skillsDir: string): void {
  const drift = checkSkillLock(current, skillsDir)
  if (drift.length === 0) {
    console.error(`  ${current.size} locked skill(s) match the lock`)
    return
  }
  for (const d of drift) {
    console.error(
      `  ${d.name}: ${d.kind === 'missing' ? 'not installed' : 'content drifted from the lock'} (${d.source})`
    )
  }
}

export async function runSetupCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(
      'usage: bro setup [--beads] [--skills] [--pack <name|off>] [--personality <name>] [--lock] [--dry-run] [--check]',
      0
    )
  }
  const { beads, skills, pack, personality, lock, dryRun, checkOnly } = parseSetupArgs(argv)
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

  if (lock) {
    setupLockedSkills(process.cwd(), dryRun, checkOnly)
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
