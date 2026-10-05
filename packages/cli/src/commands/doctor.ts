/**
 * `bro doctor` — environment diagnostics. bro orchestrates gh + bd + git +
 * worktrees + spawned agents — external tools with independent failure
 * modes — and until now there was no diagnostic entrypoint when a setup
 * breaks.
 *
 *   bro doctor [--json]
 *
 * One line per probe: ✓ ok, ! warn, ✗ fail, - skipped. Exit 1 on any
 * failure; warnings pass. Probes are read-only — a broken tool reports as
 * a failing check, never as a crash.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  bdTry,
  gitTry,
  isEnvName,
  janitorDidWork,
  janitorLine,
  probeBdCompat,
  probeConfigFile,
  PROVIDER_REGISTRY,
  runJanitor,
} from '@broject/core'
import type { ProviderEntry, ProviderSurface } from '@broject/core'
import { judgeConfig, synthesizedProviders } from '@broject/judge'
import type { JudgeConfig } from '@broject/judge'
import { loadBroConfig, pluginConfigSections } from '../plugins.ts'
import {
  budgetLines,
  budgetSnapshotFor,
  loadAgentEnv,
  type AgentConnectorEnv,
  type BudgetSnapshot,
} from '../agent-connectors.ts'

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface DoctorCheck {
  name: string
  status: DoctorStatus
  detail: string
  /** remediation — only on warn/fail */
  hint?: string
}

const check = (
  name: string,
  status: DoctorStatus,
  detail: string,
  hint?: string
): DoctorCheck => ({ name, status, detail, ...(hint ? { hint } : {}) })

interface BinProbe {
  found: boolean
  /** true only on ENOENT — a binary that exists but can't spawn (EACCES)
   *  or times out is present-but-broken; reporting it "not found" would
   *  send the user reinstalling a tool that's actually installed */
  missing?: boolean
  version?: string
  err?: string
}

/** `--version` probe — the same PATH-is-the-contract lookup every bro
 *  shell-out uses. */
function probeBin(name: string): BinProbe {
  const p = spawnSync(name, ['--version'], { // NOSONAR — PATH lookup is the contract (same as gh/bd/git)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (p.error) {
    const code = (p.error as NodeJS.ErrnoException).code
    return { found: false, missing: code === 'ENOENT', err: p.error.message }
  }
  if (p.status !== 0) {
    return { found: false, err: (p.stderr ?? '').trim() || `exit ${p.status}` }
  }
  const m = /\d+(\.\d+)+/.exec(`${p.stdout ?? ''} ${p.stderr ?? ''}`)
  return { found: true, version: m?.[0] }
}

/** Present-but-broken vs absent — a spawn failure is never "not found". */
function binProblem(p: BinProbe): string {
  if (p.missing === true) {
    return 'not found'
  }
  const err = p.err ? ` (${p.err})` : ''
  return `not usable${err}`
}

/** Repo root for dir, or null outside a worktree. */
function repoRoot(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--show-toplevel'])
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null
}

/** Main checkout root — mirrors loadConfig's linked-worktree config
 *  inheritance (`--git-common-dir` → `<main>/.git`). */
function mainRoot(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
  if (r.code !== 0 || r.out.trim() === '') {
    return null
  }
  const common = resolve(dir, r.out.trim())
  return basename(common) === '.git' ? dirname(common) : null
}

function isDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

// --- individual probes ------------------------------------------------------

function checkNode(): DoctorCheck {
  // the real capability gate is type stripping (bro.config.ts loads via
  // createRequire), not the version number — same probe config.ts uses
  const ts = (process.features as { typescript?: unknown }).typescript
  if (ts) {
    return check('node', 'ok', `v${process.versions.node}`)
  }
  return check(
    'node',
    'warn',
    `v${process.versions.node} — no native type stripping`,
    'bro.config.ts needs Node ≥22.18 — bro.config.json still works'
  )
}

function checkGh(): DoctorCheck {
  const gh = probeBin('gh')
  if (!gh.found) {
    return check('gh', 'fail', binProblem(gh), 'install the GitHub CLI — https://cli.github.com')
  }
  const auth = spawnSync('gh', ['auth', 'status'], { // NOSONAR — PATH lookup is the contract
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (auth.status !== 0) {
    return check('gh', 'fail', `${gh.version ?? 'present'} not authenticated`, 'run `gh auth login`')
  }
  return check('gh', 'ok', `${gh.version ?? 'present'} authed`)
}

/** Hooks replay run.sh's resolution order: local dist walking up from the
 *  plugin root → `bro` on PATH passing the `bro hooks` probe → npx
 *  fallback. Nothing resolving is a warn, not a fail — hooks fail open
 *  by design, so a broken chain degrades to silent no-ops, not errors. */
function checkHooks(dir: string): DoctorCheck {
  const envRoot =
    process.env.DEVIN_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? process.env.PLUGIN_ROOT
  let d = resolve(envRoot?.startsWith('/') ? envRoot : dir)
  for (;;) {
    const dist = join(d, 'packages', 'cli', 'dist', 'index.js')
    if (statSync(dist, { throwIfNoEntry: false })?.isFile()) {
      return check('hooks', 'ok', `resolves via local dist — ${dist}`)
    }
    const parent = dirname(d)
    if (parent === d) {
      break
    }
    d = parent
  }
  if (probeBin('bro').found) {
    // `bro hooks` with no event is a silent no-op — same probe run.sh runs
    const probe = spawnSync('bro', ['hooks'], { // NOSONAR — PATH lookup is the contract
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    if (probe.status === 0) {
      return check('hooks', 'ok', 'resolves via `bro` on PATH')
    }
  }
  if (probeBin('npx').found) {
    return check(
      'hooks',
      'warn',
      'npx @broject/bro fallback only',
      'every lifecycle event pays the npx resolution — `npm i -g @broject/bro` or the agent plugin resolves locally'
    )
  }
  return check(
    'hooks',
    'warn',
    'no resolution — lifecycle hooks silently no-op',
    'install @broject/bro or the agent plugin to get session-start context and the stop gate'
  )
}

/** Top-level keys bro knows — anything else in bro.config.json is almost
 *  certainly a typo'd section that silently no-ops. */
function knownConfigKeys(): Set<string> {
  return new Set([
    'stores',
    'store', // legacy v0.1.0
    'personality',
    'plugins',
    ...Object.keys(pluginConfigSections()),
  ])
}

/** One config file → verdict, or null when absent. Existence alone proves
 *  nothing — a throwing .ts silently falls back to jsonl-only stores, so
 *  the probe loads through the same readConfigFile path loadConfig uses. */
function configFileVerdict(path: string, name: string): DoctorCheck | null {
  const state = probeConfigFile(path)
  if (state === null) {
    return null
  }
  if (state === 'broken') {
    return check(
      'config',
      'fail',
      `${name} failed to load`,
      'fix or remove it — a broken config silently falls back to jsonl-only stores'
    )
  }
  if (name.endsWith('.ts')) {
    return check('config', 'ok', `${name} loads (takes precedence over .json)`)
  }
  return jsonKeysVerdict(path, name)
}

function jsonKeysVerdict(path: string, name: string): DoctorCheck {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return check('config', 'ok', name) // probe already ok'd it — can't happen, stay honest anyway
  }
  const unknown = Object.keys(raw).filter((k) => !knownConfigKeys().has(k))
  if (unknown.length === 0) {
    return check('config', 'ok', name)
  }
  return check(
    'config',
    'warn',
    `${name} — unknown keys: ${unknown.join(', ')}`,
    'unknown sections silently no-op — check for typos'
  )
}

/** Config-file probe: which file wins (loadConfig order — cwd .ts, cwd
 *  .json, main-root .ts, main-root .json). */
function checkConfig(dirs: string[]): DoctorCheck {
  for (const dir of dirs) {
    for (const name of ['bro.config.ts', 'bro.config.json']) {
      const verdict = configFileVerdict(join(dir, name), name)
      if (verdict !== null) {
        return verdict
      }
    }
  }
  return check('config', 'ok', 'no bro.config — running on defaults')
}

/** Compat probe — verifies the contract bro calls (read-path --json
 *  shapes, subcommand/flag surface, store schema) rather than trusting a
 *  pre-1.0 version number. Drift fails when beads is an active store. */
function bdCompatCheck(dir: string, beadsActive: boolean): DoctorCheck {
  const compat = probeBdCompat(dir)
  if (!compat.ok) {
    return check(
      'bd-compat',
      beadsActive ? 'fail' : 'warn',
      compat.problems.join('; '),
      'bd moved past the contract bro speaks — upgrade/downgrade beads or set "stores": ["jsonl"]'
    )
  }
  const v = compat.version ?? '?'
  if (compat.store === 'error') {
    return check(
      'bd-compat',
      'warn',
      `v${v} — read contract unproven: ${compat.storeErr ?? 'probe failed'}`
    )
  }
  return check(
    'bd-compat',
    'ok',
    compat.store === 'reachable'
      ? `v${v} contract verified`
      : `v${v} — read contract unproven (no store)`
  )
}

/** bd group: presence (fail only when beads is an active store), Dolt-era
 *  compat (`bd dolt` exists at all → the backend bro assumes), and store
 *  readability when a store is live. */
function bdChecks(
  dir: string,
  bd: BinProbe,
  beadsDir: boolean,
  beadsActive: boolean
): DoctorCheck[] {
  if (!bd.found) {
    const fix = 'install beads (https://github.com/gastownhall/beads) or set "stores": ["jsonl"]'
    return [
      beadsActive
        ? check('bd', 'fail', binProblem(bd), fix)
        : check('bd', 'warn', binProblem(bd), 'beads store is off — nothing needs it'),
    ]
  }
  const out: DoctorCheck[] = [check('bd', 'ok', bd.version ?? 'present'), bdCompatCheck(dir, beadsActive)]
  const dolt = bdTry(['dolt', 'remote', 'list'], 15_000, dir)
  if (dolt.code !== 0) {
    const err = dolt.err ? ` (${dolt.err})` : ''
    out.push(
      check('bd-backend', 'warn', '`bd dolt` failed', `bd predates the Dolt backend — upgrade beads${err}`)
    )
  } else {
    out.push(check('bd-backend', 'ok', 'dolt remotes reachable'))
  }
  if (beadsDir) {
    const list = bdTry(['list', '--json', '-n', '1'], 15_000, dir)
    out.push(
      list.code === 0
        ? check('bd-store', 'ok', 'beads store readable')
        : check('bd-store', 'fail', 'beads store present but `bd list` failed', list.err || 'inspect the store or re-run `bd init`')
    )
  } else if (beadsActive) {
    out.push(check('bd-store', 'ok', 'no .beads — auto-inits stealth on first use'))
  }
  return out
}

/** Remote group: the git remote `bro sync` pushes to, and the beads Dolt
 *  remote when a store is live (beads state is local-only without it). */
function remoteChecks(
  dir: string,
  root: string | null,
  syncRemote: string,
  beadsDir: boolean,
  bdFound: boolean
): DoctorCheck[] {
  if (root === null) {
    return []
  }
  const remote = gitTry(['-C', dir, 'remote', 'get-url', syncRemote])
  const out: DoctorCheck[] = [
    remote.code === 0
      ? check('git-remote', 'ok', `${syncRemote} → ${remote.out.trim()}`)
      : check('git-remote', 'warn', `no "${syncRemote}" remote`, 'bro sync and beads replication stay local-only'),
  ]
  if (!beadsDir) {
    return out
  }
  if (!bdFound) {
    out.push(check('dolt-remote', 'skip', 'needs bd'))
    return out
  }
  const remotes = bdTry(['dolt', 'remote', 'list'], 15_000, dir)
  if (remotes.code !== 0) {
    out.push(check('dolt-remote', 'skip', '`bd dolt remote list` failed'))
    return out
  }
  const names = remotes.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (names.length === 0) {
    out.push(
      check(
        'dolt-remote',
        'warn',
        'none configured',
        'beads state is local-only — `bd dolt remote add` inside .beads syncs it across machines'
      )
    )
    return out
  }
  out.push(check('dolt-remote', 'ok', names.join(', ')))
  return out
}

// --- providers (specs/bro-ribc.1.md milestone 6) ----------------------
// The configured registry as doctor rows: a listing line, an auth-env
// row per entry, and a warn per consumer ref that dangles or asks a
// kind for a surface it lacks — use-time resolution errors out either
// way; doctor just says it first.

/** The listing row — entries as `name (kind, model)`. */
function providerListCheck(providers: Record<string, ProviderEntry>): DoctorCheck {
  const names = Object.keys(providers)
  if (names.length === 0) {
    return check('providers', 'ok', 'none configured')
  }
  const label = (n: string): string => {
    const e = providers[n]!
    const model = 'model' in e && typeof e.model === 'string' ? `, ${e.model}` : ''
    return `${n} (${e.type}${model})`
  }
  return check('providers', 'ok', `${names.length} configured: ${names.map(label).join(', ')}`)
}

/** One entry's auth env var — the NAME is config; the value is never
 *  echoed (an all-caps pasted key passes isEnvName), so messages name
 *  the config field only. */
function providerAuthCheck(name: string, entry: ProviderEntry): DoctorCheck | null {
  const keyName = 'apiKeyEnv' in entry ? entry.apiKeyEnv : undefined
  if (keyName === undefined) {
    return null
  }
  if (!isEnvName(keyName)) {
    return check(
      'providers',
      'warn',
      `providers.${name}.apiKeyEnv is not a valid env var name`,
      'name the variable holding the key (SCREAMING_SNAKE) — config never holds the key itself'
    )
  }
  if (process.env[keyName] === undefined || process.env[keyName] === '') {
    return check(
      'providers',
      'warn',
      `the env var named by providers.${name}.apiKeyEnv is not set`,
      'export it — the provider fails at first use without it'
    )
  }
  return check('providers', 'ok', `providers.${name} auth env set`)
}

type ProviderRef = [field: string, name: string, surface: ProviderSurface]

/** Every provider name a consumer config references — `judge.provider`
 *  (and `judge.fallback` — provider mode only: a connector-mode
 *  fallback names a connector, not this check's business),
 *  `agents.<backend>.provider`, `fleet.profiles.*.provider`. */
function providerRefs(jcfg: JudgeConfig, env: AgentConnectorEnv): ProviderRef[] {
  return [
    ...(jcfg.provider === undefined || jcfg.provider === ''
      ? []
      : ([['judge.provider', jcfg.provider, 'call']] as ProviderRef[])),
    ...(jcfg.provider === undefined || jcfg.fallback === undefined || jcfg.fallback === ''
      ? []
      : ([['judge.fallback', jcfg.fallback, 'call']] as ProviderRef[])),
    ...Object.entries(env.agents).flatMap(
      ([b, a]): ProviderRef[] =>
        typeof a.provider === 'string' && a.provider !== ''
          ? [[`agents.${b}.provider`, a.provider, 'spawn']]
          : []
    ),
    ...Object.entries(env.fleet?.profiles ?? {}).map(
      ([p, f]): ProviderRef => [`fleet.profiles.${p}.provider`, f.provider, 'spawn']
    ),
  ]
}

/** One ref row → a warn when the name resolves to no entry, or to a
 *  kind lacking the asked surface. Judge names resolve against the
 *  effective registry — the user's entries plus the synthesized legacy
 *  aliases ('systemone' always, 'llm-judge' when judge.llm is set). */
function providerRefCheck(
  effective: Record<string, ProviderEntry>,
  [field, name, surface]: ProviderRef
): DoctorCheck | null {
  const entry = effective[name]
  if (entry === undefined) {
    return check(
      'providers',
      'warn',
      `${field} names '${name}' — no such provider entry`,
      'add it under providers{} or fix the reference — use-time resolution errors out'
    )
  }
  const kind = PROVIDER_REGISTRY[entry.type]
  if (surface === 'call' ? kind.call === null : !kind.spawn) {
    return check(
      'providers',
      'warn',
      `${field} names '${name}' (${entry.type}) — no ${surface} surface`,
      'the kind lacks that surface — use-time resolution errors out'
    )
  }
  return null
}

function providerChecks(dir: string): DoctorCheck[] {
  const env = loadAgentEnv(dir)
  const providers = env.providers ?? {}
  const { judge: jcfg } = judgeConfig(dir)
  const effective = synthesizedProviders(jcfg, providers)
  const present = (c: DoctorCheck | null): c is DoctorCheck => c !== null
  return [
    providerListCheck(providers),
    ...Object.entries(providers)
      .map(([n, e]) => providerAuthCheck(n, e))
      .filter(present),
    ...providerRefs(jcfg, env)
      .map((r) => providerRefCheck(effective, r))
      .filter(present),
  ]
}

/** Janitor probe — a dry run over `<git-common>/bro/` reporting the
 *  retention debris the next `bro watch` tick would reap. Probes stay
 *  read-only: this counts, it never unlinks (bro-f6zp). */
function checkJanitor(dir: string): DoctorCheck | null {
  let r
  try {
    r = runJanitor(dir, { dryRun: true })
  } catch {
    return check('janitor', 'ok', 'probe failed — reaping still runs on `bro watch` ticks')
  }
  if (r === null || !janitorDidWork(r)) {
    return check('janitor', 'ok', 'no retention debris')
  }
  // pending debris is routine, not a defect — the line says what the
  // next watch tick removes
  return check('janitor', 'ok', janitorLine(r))
}

export function runDoctorChecks(dir: string = process.cwd()): DoctorCheck[] {
  const checks: DoctorCheck[] = [checkNode()]

  const git = probeBin('git')
  checks.push(
    git.found
      ? check('git', 'ok', git.version ?? 'present')
      : check('git', 'fail', binProblem(git), 'every bro command shells out to git')
  )

  const root = repoRoot(dir)
  const cfg = loadBroConfig(dir)
  checks.push(
    root === null
      ? check('repo', 'warn', 'not inside a git worktree', 'worktree/branch/sync commands need a repo')
      : check('repo', 'ok', `worktree root ${root} · stores: ${cfg.stores.join(', ')}`)
  )
  // a store is live when .beads exists at the root OR BEADS_DIR pins one
  // (the loop harness runs worktrees against a shared store that way)
  const envDir = process.env.BEADS_DIR
  const beadsDir =
    (root !== null && isDir(join(root, '.beads'))) ||
    (typeof envDir === 'string' && envDir !== '' && isDir(envDir))
  const bd = probeBin('bd')
  const janitor = checkJanitor(dir)
  checks.push(
    checkGh(),
    ...bdChecks(dir, bd, beadsDir, cfg.stores.includes('beads')),
    checkHooks(dir),
    checkConfig([dir, root, mainRoot(dir)].filter((d): d is string => d !== null)),
    ...providerChecks(dir),
    ...(janitor === null ? [] : [janitor]),
    ...remoteChecks(dir, root, cfg.sync.remote, beadsDir, bd.found)
  )

  return checks
}

export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some((c) => c.status === 'fail') ? 1 : 0
}

const ICONS: Record<DoctorStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' }

/** The budget section (specs/bro-7xgk.3.md) — bro's own registry as a
 *  local proxy for the provider's hourly window: live agents, spawns in
 *  the last hour, observed resets, last failure causes. The snapshot is
 *  telemetry, not a probe — it never affects the exit code, and a broken
 *  registry degrades the section instead of crashing the run. */
function readBudget(dir: string): { snap: BudgetSnapshot | null; err?: string } {
  try {
    return { snap: budgetSnapshotFor(dir, loadAgentEnv(dir)) }
  } catch (err) {
    return { snap: null, err: err instanceof Error ? err.message : String(err) }
  }
}

/** The text report — check lines, the budget section, the summary. */
function printDoctor(checks: DoctorCheck[], budget: ReturnType<typeof readBudget>): void {
  for (const c of checks) {
    console.log(`${ICONS[c.status]} ${c.name.padEnd(10)} ${c.detail}`)
    if (c.hint) {
      console.log(`  ${' '.repeat(10)} → ${c.hint}`)
    }
  }
  console.log('\nbudget — local estimates (bro registry only, not provider quota data)')
  if (budget.snap === null) {
    console.log(`  unreadable — ${budget.err ?? 'unknown error'}`)
  } else {
    for (const l of budgetLines(budget.snap)) {
      console.log(l)
    }
  }
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  console.log(
    fails === 0 && warns === 0
      ? '\nbro doctor: all checks pass'
      : `\nbro doctor: ${fails} failure(s), ${warns} warning(s)`
  )
}

export function runDoctorCommand(argv: string[]): void {
  const json = argv.includes('--json')
  const dir = process.cwd()
  const checks = runDoctorChecks(dir)
  const budget = readBudget(dir)
  if (json) {
    console.log(
      JSON.stringify({ ok: doctorExitCode(checks) === 0, checks, budget: budget.snap }, null, 2)
    )
  } else {
    printDoctor(checks, budget)
  }
  process.exit(doctorExitCode(checks))
}
