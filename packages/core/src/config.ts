/**
 * bro configuration. Resolution order: bro.config.ts → bro.config.json
 * in cwd → same pair in the main worktree root (linked worktrees inherit
 * the machine-local config) → defaults. The .ts file loads synchronously via createRequire —
 * native type stripping handles it on Node ≥22.18. `export default {…}`
 * is the canonical form (works in ESM and CJS repos); `module.exports`
 * only works where the repo is CommonJS. No bro import is required, so
 * the config resolves under a global install too.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gitTry } from './git.ts'
import { parseProviderEntry, type ProviderEntry } from './providers.ts'

export const STORE_BACKENDS = ['jsonl', 'beads', 'gitref'] as const
export type StoreBackend = (typeof STORE_BACKENDS)[number]
export const PERSONALITIES = ['terse', 'mentor', 'sarcastic'] as const
export type Personality = (typeof PERSONALITIES)[number]

/** A plugin-owned config section: raw JSON value in, normalized section
 *  out. `schema(undefined)` MUST return the section default — that's the
 *  fallback when the raw value is missing or the schema throws. */
export type ConfigSection<T> = (raw: unknown) => T

export const debtSection: ConfigSection<{
  dir: string
  sources: string[]
  stale_days: number
}> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    // dir feeds path.join — a non-string or empty value must fall back to
    // the default, not throw mid-command
    dir:
      typeof obj.dir === 'string' && obj.dir.trim() !== ''
        ? obj.dir
        : DEFAULT_CONFIG.debt.dir,
    // Which collectors `debt collect` runs. Source names are validated by
    // the debt plugin (core stays vendor-neutral) — unknown entries are
    // dropped there with a warning, not silently accepted.
    sources:
      Array.isArray(obj.sources) &&
      obj.sources.every((s) => typeof s === 'string' && s.trim() !== '') &&
      obj.sources.length > 0
        ? obj.sources
        : DEFAULT_CONFIG.debt.sources,
    stale_days:
      typeof obj.stale_days === 'number' &&
      Number.isFinite(obj.stale_days) &&
      obj.stale_days > 0
        ? obj.stale_days
        : DEFAULT_CONFIG.debt.stale_days,
  }
}

export const syncSection: ConfigSection<{
  ref: string
  remote: string
  beads: boolean
}> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  return {
    // only non-blank strings may reach git arg construction — a null,
    // non-string, or empty sync.ref/sync.remote falls back to the default
    ...DEFAULT_CONFIG.sync,
    ...Object.fromEntries(
      Object.entries(obj).filter(
        ([, v]) => typeof v === 'string' && v.trim() !== ''
      )
    ),
    beads: typeof obj.beads === 'boolean' ? obj.beads : DEFAULT_CONFIG.sync.beads,
  }
}

/** A conditional ignoreChecks entry — `name` keeps the bare-string
 *  substring match; the two knobs say when a *failing* check has earned
 *  the quiet ignore: `consecutiveFailures` failing head shas in a row
 *  AND thread activity by the check's bot inside `threadWindowDays`. A
 *  failing check without that evidence is an alert, not a pass. */
export interface IgnoreCheckRule {
  name: string
  consecutiveFailures: number
  threadWindowDays: number
}

export type IgnoreCheckEntry = string | IgnoreCheckRule

export const DEFAULT_IGNORE_CONSECUTIVE_FAILURES = 3
export const DEFAULT_IGNORE_THREAD_WINDOW_DAYS = 7

function normalizeIgnoreEntry(v: unknown): IgnoreCheckRule | null {
  const posInt = (x: unknown, dflt: number, min: number): number =>
    typeof x === 'number' && Number.isInteger(x) && x >= min ? x : dflt
  if (typeof v === 'string') {
    // a bare substring is a rule with default thresholds — the
    // silent-reviewer detection applies without a config migration
    return v.trim() === ''
      ? null
      : {
          name: v,
          consecutiveFailures: DEFAULT_IGNORE_CONSECUTIVE_FAILURES,
          threadWindowDays: DEFAULT_IGNORE_THREAD_WINDOW_DAYS,
        }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null
  }
  const o = v as { name?: unknown; consecutiveFailures?: unknown; threadWindowDays?: unknown }
  if (typeof o.name !== 'string' || o.name.trim() === '') {
    return null
  }
  return {
    name: o.name,
    consecutiveFailures: posInt(
      o.consecutiveFailures,
      DEFAULT_IGNORE_CONSECUTIVE_FAILURES,
      1
    ),
    threadWindowDays: posInt(
      o.threadWindowDays,
      DEFAULT_IGNORE_THREAD_WINDOW_DAYS,
      1
    ),
  }
}

export const actSection: ConfigSection<{
  ignoreChecks: IgnoreCheckRule[]
  maxRounds: number
  docsPaths: string[]
  docsMaxRounds: number
}> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    ignoreChecks?: unknown
    maxRounds?: unknown
    docsPaths?: unknown
    docsMaxRounds?: unknown
  }
  return {
    // only name substrings (bare or rule objects) may reach the check
    // filter — anything else falls back to the default
    ignoreChecks: Array.isArray(obj.ignoreChecks)
      ? obj.ignoreChecks
          .map(normalizeIgnoreEntry)
          .filter((r): r is IgnoreCheckRule => r !== null)
      : [],
    maxRounds:
      typeof obj.maxRounds === 'number' &&
      Number.isInteger(obj.maxRounds) &&
      obj.maxRounds >= 0
        ? obj.maxRounds
        : DEFAULT_CONFIG.act.maxRounds,
    docsPaths: Array.isArray(obj.docsPaths)
      ? obj.docsPaths.filter(
          // an empty pattern would match EVERY path
          (v): v is string => typeof v === 'string' && v.trim() !== ''
        )
      : [...DEFAULT_CONFIG.act.docsPaths],
    docsMaxRounds:
      typeof obj.docsMaxRounds === 'number' &&
      Number.isInteger(obj.docsMaxRounds) &&
      obj.docsMaxRounds >= 0
        ? obj.docsMaxRounds
        : DEFAULT_CONFIG.act.docsMaxRounds,
  }
}

/** bro.config.json `providers` section — the typed provider registry
 *  (spec: specs/bro-ribc.1.md). A name → entry map, kind-validated via
 *  PROVIDER_REGISTRY with apiKeyEnv checked by isEnvName: unknown types
 *  and entries missing required fields are dropped with a warning. The
 *  absent/empty section is valid — consumers fall back to their
 *  pre-registry behavior, never to a vendor the user didn't name. */
export const providersSection: ConfigSection<Record<string, ProviderEntry>> = (raw) => {
  const out: Record<string, ProviderEntry> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return out
  }
  for (const [name, v] of Object.entries(raw)) {
    if (name.trim() === '') {
      continue
    }
    const entry = parseProviderEntry(name.trim(), v)
    if (entry !== null) {
      out[name.trim()] = entry
    }
  }
  return out
}

/** bro.config.json `connectors` section — facade → connector precedence,
 *  e.g. { "reviews": "gitlab", "tasks": "jira" }. Only string→string
 *  entries survive; anything else is dropped. */
export const connectorsSection: ConfigSection<Record<string, string>> = (raw) => {
  const out: Record<string, string> = {}
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (k.trim() !== '' && typeof v === 'string' && v.trim() !== '') {
        out[k.trim()] = v.trim()
      }
    }
  }
  return out
}

/** Default global-beads store — XDG data dir, not a repo path. */
export const DEFAULT_GLOBAL_BEADS_DIR = join(homedir(), '.local', 'share', 'bro', 'beads')

/** bro.config.json `beads` section — `beads.global` is the global store
 *  dir. BRO_GLOBAL_BEADS wins over the file: a per-machine path should
 *  not need a committed edit. `~` expands against the home dir. */
export const beadsSection: ConfigSection<{ global: string }> = (raw) => {
  const fromConfig =
    typeof raw === 'object' && raw !== null ? (raw as { global?: unknown }).global : undefined
  const env = process.env.BRO_GLOBAL_BEADS
  const v =
    (typeof env === 'string' && env.trim() !== '' ? env : undefined) ??
    (typeof fromConfig === 'string' && fromConfig.trim() !== '' ? fromConfig : undefined)
  if (v === undefined) {
    return { global: DEFAULT_GLOBAL_BEADS_DIR }
  }
  const p = v.trim()
  let dir = p
  if (p === '~') {
    dir = homedir()
  } else if (p.startsWith('~/')) {
    dir = join(homedir(), p.slice(2))
  }
  return { global: dir }
}

/** bro.config.json `stack` section — how `bro work enter` picks the base
 *  for a new worktree when a session already produced a PR branch.
 *  'manual' (default): stack only on explicit --stack/--base.
 *  'auto': base on the current worktree's branch whenever it isn't the
 *  main checkout's branch — second+ PR in a session lands on the stack
 *  head; gh-stack then drives submit/sync/merge bottom-up. */
export const stackSection: ConfigSection<{ mode: 'auto' | 'manual' }> = (raw) => {
  const m = typeof raw === 'object' && raw !== null ? (raw as { mode?: unknown }).mode : undefined
  if (m !== undefined && m !== 'auto' && m !== 'manual') {
    console.error(`bro.config: stack.mode must be "auto" or "manual" — got ${JSON.stringify(m)}`)
    return { mode: 'manual' }
  }
  return { mode: m ?? 'manual' }
}

export const SDD_MODES = ['off', 'remind', 'gate'] as const
export type SddMode = (typeof SDD_MODES)[number]

/** bro.config.json `sdd` section — spec-driven development policy.
 *  off (default): nothing emitted. remind: session-start/prompt context
 *  names claimed beads without a spec. gate: the stop gate also blocks
 *  once while an own claim lacks a spec. `dir` is where `specs/<id>.md`
 *  lives; a `spec:` link in the bead description counts too. */
export const sddSection: ConfigSection<{ mode: SddMode; dir: string }> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    mode?: unknown
    dir?: unknown
  }
  if (
    obj.mode !== undefined &&
    !(SDD_MODES as readonly unknown[]).includes(obj.mode)
  ) {
    console.error(
      `bro.config: sdd.mode must be one of ${SDD_MODES.map((m) => `"${m}"`).join('|')} — got ${JSON.stringify(obj.mode)}`
    )
  }
  const mode = (
    obj.mode !== undefined && (SDD_MODES as readonly unknown[]).includes(obj.mode)
      ? obj.mode
      : DEFAULT_CONFIG.sdd.mode
  ) as SddMode
  return {
    mode,
    dir:
      typeof obj.dir === 'string' && obj.dir.trim() !== ''
        ? obj.dir.trim()
        : DEFAULT_CONFIG.sdd.dir,
  }
}

/** bro.config.json `fleet` section — the live-agent ceiling the spawn
 *  prologue enforces. `maxConcurrent` counts registry agents across ALL
 *  backends (the budget wall is per-account, not per-runtime); 0
 *  disables the cap, matching act.maxRounds' convention. */
export const fleetSection: ConfigSection<{ maxConcurrent: number }> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    maxConcurrent?: unknown
  }
  return {
    maxConcurrent:
      typeof obj.maxConcurrent === 'number' &&
      Number.isInteger(obj.maxConcurrent) &&
      obj.maxConcurrent >= 0
        ? obj.maxConcurrent
        : DEFAULT_CONFIG.fleet.maxConcurrent,
  }
}

/** Sections core normalizes itself — identical to what the built-in
 *  plugins declare as their configSchema. */
const CORE_SECTIONS: Record<string, ConfigSection<unknown>> = {
  debt: debtSection as ConfigSection<unknown>,
  sync: syncSection as ConfigSection<unknown>,
  act: actSection as ConfigSection<unknown>,
  connectors: connectorsSection as ConfigSection<unknown>,
  providers: providersSection as ConfigSection<unknown>,
  sdd: sddSection as ConfigSection<unknown>,
  fleet: fleetSection as ConfigSection<unknown>,
}

export interface BroConfig {
  /** Active stores. The JSONL ledger is always on — extra backends are
   *  projections written alongside it. beads is on by default; gitref is
   *  opt-in — it pushes artifact dirs to a standalone data ref. */
  stores: StoreBackend[]
  personality: Personality
  debt: {
    /** Directory holding the review-debt ledger, relative to cwd. */
    dir: string
    /** Collectors `bro debt collect` runs. Default: review-threads only —
     *  the pre-multi-source contract. Others opt in: dependabot,
     *  code-scanning, secret-scanning, stale-prs, failed-ci. */
    sources: string[]
    /** Idle days before an open PR counts as stale (stale-prs collector). */
    stale_days: number
  }
  sync: {
    /** Data ref holding synced artifacts — outside refs/heads so it
     *  never shows up as a branch. */
    ref: string
    /** Remote the data ref pushes to / pulls from. */
    remote: string
    /** Also run `bd sync` — beads state (drill frames, wtfs, retros) has
     *  its own transport, not the data ref. Default true; set false to
     *  sync only bro artifacts. */
    beads: boolean
  }
  act: {
    /** Advisory checks excluded from the exit gate — a flaky external
     *  reviewer's infra is not this repo's problem. The ignore is
     *  conditional: a *failing* check stays quiet only after
     *  `consecutiveFailures` failing heads in a row WITH thread
     *  activity inside `threadWindowDays` — otherwise it surfaces as a
     *  silent-reviewer alert (still non-blocking). */
    ignoreChecks: IgnoreCheckRule[]
    /** Inline fix-round cap — past it, remaining threads must defer to
     *  debt beads instead of another push. 0 disables the cap. */
    maxRounds: number
    /** Path patterns classifying a file as docs — a pattern without a
     *  slash matches the basename glob (`*.md`), one ending in `/`
     *  matches the dir anywhere (`docs/`), anything else is a full-path
     *  glob. A PR whose changed files all match is "docs-only". */
    docsPaths: string[]
    /** Round cap applied instead of maxRounds (whichever is tighter)
     *  on a docs-only PR — doc threads churn per push, so inline fixing
     *  converges slower for less value. 0 disables the docs-specific cap. */
    docsMaxRounds: number
  }
  /** Facade → connector precedence, e.g. { reviews: 'gitlab' }. */
  connectors: Record<string, string>
  /** Named provider registry — judge (`judge.provider`) and fleet
   *  (`agents.<backend>.provider`) reference entries by name. Empty
   *  means provider behavior is off, not defaulted to a vendor. */
  providers: Record<string, ProviderEntry>
  /** Spec-driven development policy — spec before code for claimed
   *  beads. `off` (default) emits nothing; `remind` adds session/prompt
   *  context; `gate` also lets the stop gate block once. `dir` holds
   *  `specs/<id>.md` files; a `spec:` link in the description counts. */
  sdd: { mode: SddMode; dir: string }
  /** Fleet size admission — the cap `prepareSpawn` enforces on every
   *  backend's spawn. `maxConcurrent` counts live registry agents
   *  across all backends; 0 means uncapped. Default 3. */
  fleet: { maxConcurrent: number }
  /** External plugin specifiers — relative paths or package names the CLI
   *  resolves from the repo and imports at startup. Each module's default
   *  export must be a BroPlugin (or an array of them). */
  plugins: string[]
  /** Capability pack `bro setup --pack` installs — an npm package name
   *  carrying skills/ + formulas/ trees. Default @broject/bro-pack;
   *  project-local node_modules are resolved before the CLI's own. */
  pack?: string
}

export const DEFAULT_CONFIG: BroConfig = {
  stores: ['jsonl', 'beads'],
  personality: 'terse',
  debt: { dir: '.agents/review-debt', sources: ['review-threads'], stale_days: 14 },
  sync: { ref: 'refs/bro/data', remote: 'origin', beads: true },
  act: {
    ignoreChecks: [],
    maxRounds: 3,
    // no '*.txt' — requirements.txt and test fixtures are not docs
    docsPaths: ['*.md', '*.mdx', '*.rst', 'docs/'],
    docsMaxRounds: 2,
  },
  connectors: {},
  providers: {},
  sdd: { mode: 'off', dir: 'specs' },
  fleet: { maxConcurrent: 3 },
  plugins: [],
}

interface RawConfig extends Partial<Omit<BroConfig, 'stores' | 'plugins' | 'pack'>> {
  /** New: explicit backend list. */
  stores?: unknown
  /** External plugin specifiers — normalized to a string list. */
  plugins?: unknown
  /** Capability pack name — must normalize to a string, anything else
   *  (object, array, number) is rejected rather than reaching `pack`. */
  pack?: unknown
  /** Legacy v0.1.0 field — 'beads'/'both' meant jsonl + beads projection. */
  store?: string
}

function normalizePack(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw
  }
  console.error('warning: bro.config "pack" must be a non-empty string — ignoring')
  return undefined
}

function normalizeStores(raw: RawConfig): StoreBackend[] {
  const isBackend = (s: unknown): s is StoreBackend =>
    typeof s === 'string' && (STORE_BACKENDS as readonly string[]).includes(s)
  if (Array.isArray(raw.stores)) {
    return [...new Set<StoreBackend>(['jsonl', ...raw.stores.filter(isBackend)])]
  }
  if (raw.stores !== undefined) {
    // Present but not an array — a malformed config must not silently
    // widen into the beads projection.
    console.error(
      'warning: bro.config.json "stores" must be an array — using jsonl-only'
    )
    return ['jsonl']
  }
  if (raw.store === 'beads' || raw.store === 'both') {
    return ['jsonl', 'beads']
  }
  if (raw.store !== undefined) {
    // Legacy explicit opt-out — and any mistyped value ('beed'): an
    // unrecognized legacy field must fall back to jsonl-only, not silently
    // widen into the beads projection.
    return ['jsonl']
  }
  return [...DEFAULT_CONFIG.stores]
}

/** Identity helper for bro.config.ts: `export default defineConfig({…})`
 *  gives typed sections when @broject/core is a local dep; a plain object
 *  works without it. Extra keys are plugin sections (see bro-akl). */
export function defineConfig<
  T extends Partial<BroConfig> & Record<string, unknown>,
>(config: T): T {
  return config
}

// Unwrap the default export — a real ESM namespace (Module tag) OR tsx's
// plain {default: …} shape — while `export default null` must still hit
// the non-object fallback, not leak a wrapper through `??`
function unwrapDefault(mod: unknown): unknown {
  if (typeof mod !== 'object' || mod === null) {
    return mod
  }
  const m = mod as Record<string | symbol, unknown>
  const wrapper =
    m[Symbol.toStringTag] === 'Module' ||
    Object.keys(m).every((k) => k === 'default' || k === '__esModule')
  return wrapper && 'default' in m ? m.default : mod
}

function loadTsConfig(name: string, path: string): unknown {
  // the published CLI still installs on Node 22.0–22.17 where type
  // stripping is absent — detect it up front, not by catching the
  // require failure
  if (!(process.features as { typescript?: unknown }).typescript) {
    console.error(
      `warning: ${name} needs Node >=22.18 (native type stripping) — using jsonl-only stores`
    )
    return undefined
  }
  // resolving from the config itself keeps any relative imports inside it
  // rooted at the repo, not at the CLI install location. createRequire
  // needs an ABSOLUTE referrer — a relative cwd would throw here while
  // the .json path happily loads.
  const abs = resolve(path)
  const req = createRequire(abs)
  try {
    return unwrapDefault(req(abs))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Node ≤24's require() treats every .ts as CJS-TS — `export default`
    // can't transform there. Fall back to a real ESM import() in a
    // subprocess: same loader semantics, and `import` statements in the
    // config keep working. Config values must be JSON-serializable.
    if (
      !/Transform failed|Expected identifier|Cannot use export|ERR_REQUIRE/.test(msg)
    ) {
      throw err
    }
    const out = execFileSync(
      process.execPath,
      [
        '--eval',
        `import(${JSON.stringify(pathToFileURL(abs).href)}).then(m => process.stdout.write(JSON.stringify(m.default ?? null)))`,
      ],
      { encoding: 'utf8' }
    )
    return JSON.parse(out)
  }
}

/** Reads one config file; undefined = failed (caller falls back to
 *  jsonl-only — a broken file must not silently enable beads). */
function readConfigFile(name: string, path: string): unknown {
  try {
    if (name.endsWith('.ts')) {
      return loadTsConfig(name, path)
    }
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    let hint = ` (${msg})`
    if (/module is not defined|exports is not defined/.test(msg)) {
      hint = ' (this repo is ESM — use `export default`, not module.exports)'
    } else if (/Transform failed|Expected identifier/.test(msg)) {
      hint =
        ' (this dir resolves as CommonJS — use `module.exports` or add `"type": "module"` to package.json)'
    }
    console.error(`warning: ${name} failed to load — skipping${hint}`)
    return undefined
  }
}

/** Diagnostic probe for `bro doctor` — loads ONE config file through the
 *  same readConfigFile path loadConfig uses (so a throwing bro.config.ts
 *  reports broken here exactly when loadConfig would skip it). Returns
 *  'ok' | 'broken' | null (file absent). */
export function probeConfigFile(path: string): 'ok' | 'broken' | null {
  if (!existsSync(path)) {
    return null
  }
  const raw = readConfigFile(basename(path), path)
  if (raw === undefined) {
    return 'broken' // warned inside readConfigFile
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? 'ok' : 'broken'
}

/** Runs every section schema over the raw file — a throwing schema warns
 *  and falls back to schema(undefined), never crashes the load. */
function applySections(
  config: BroConfig & Record<string, unknown>,
  raw: Record<string, unknown>,
  sections: Record<string, ConfigSection<unknown>>
): void {
  // core wins on a key collision — an external configKey must never
  // shadow a section whose semantics the CLI enforces (fleet cap)
  for (const [key, schema] of Object.entries({ ...sections, ...CORE_SECTIONS })) {
    try {
      config[key] = schema(raw[key])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`warning: bro.config "${key}" invalid (${msg}) — using defaults`)
      config[key] = schema(undefined)
    }
  }
}

/** The main checkout's root when cwd sits in a linked worktree —
 *  `--git-common-dir` resolves to `<main>/.git` there (and to
 *  `<cwd>/.git` in the main checkout itself, which dedupes). */
function mainWorktreeRoot(cwd: string): string | null {
  const r = gitTry(['-C', cwd, 'rev-parse', '--git-common-dir'])
  if (r.code !== 0 || r.out.trim() === '') {
    return null
  }
  // linked worktrees print the main checkout's absolute .git path; the
  // main worktree prints a relative `.git` — resolve covers both, and
  // unlike --path-format this works on older git too
  const common = resolve(cwd, r.out.trim())
  if (basename(common) === '.git') {
    return dirname(common)
  }
  // `--separate-git-dir` detaches the git dir from the checkout and git
  // keeps no back-pointer (`worktree list` reports the git dir itself).
  // The only link is the checkout's own `.git` file (`gitdir: <common>`)
  // — scan the common dir's siblings for it. A worktree of a BARE repo
  // finds no such checkout (linked worktrees point at
  // `<bare>/worktrees/<name>`, not the common dir) → nothing to inherit.
  const parent = dirname(common)
  let names: string[] = []
  try {
    names = readdirSync(parent)
  } catch {
    return null
  }
  for (const name of names) {
    const dir = join(parent, name)
    const gitfile = join(dir, '.git')
    try {
      if (!statSync(gitfile).isFile()) {
        continue
      }
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitfile, 'utf8'))
      if (m && resolve(dir, m[1].trim()) === common) {
        return dir
      }
    } catch {
      // unreadable sibling — skip
    }
  }
  return null
}

export function loadConfig(
  cwd: string = process.cwd(),
  /** Plugin-registered section schemas — key = configKey, applied over the
   *  raw file. A throwing schema falls back to schema(undefined). */
  sections: Record<string, ConfigSection<unknown>> = {}
): BroConfig & Record<string, unknown> {
  // every exit path applies section schemas — a registered plugin
  // section must resolve to its defaults even with no usable config file
  const fallback = (stores: StoreBackend[]): BroConfig & Record<string, unknown> => {
    const config = { ...DEFAULT_CONFIG, stores } as BroConfig & Record<string, unknown>
    applySections(config, {}, sections)
    return config
  }
  // Linked worktrees share the main checkout's machine-local config —
  // bro.config.* is gitignored, so a fresh `git worktree add` otherwise
  // loses act.ignoreChecks and store choices (a bare `act wait` stalls on
  // a flaky reviewer the main checkout knows to ignore).
  // Resolve once up front: mainWorktreeRoot returns an absolute path, so
  // a relative cwd must be absolute too or the Set dedupe compares
  // 'foo' against '/abs/foo' and loads the same dir twice.
  const base = resolve(cwd)
  const dirs = [base, mainWorktreeRoot(base)].filter(
    (d): d is string => d !== null && d.trim() !== ''
  )
  // a config that exists but fails never silently enables beads — the
  // flag keeps the final fallback at jsonl-only in that case
  let sawBroken = false
  for (const dir of new Set(dirs)) {
    const r = loadDirConfig(dir, sections)
    if (r === 'broken') {
      sawBroken = true
    } else if (r !== null) {
      return r
    }
  }
  return fallback(sawBroken ? ['jsonl'] : [...DEFAULT_CONFIG.stores])
}

/** Tries bro.config.ts → bro.config.json inside one dir. 'broken' = a
 *  config exists but failed (the dir's remaining names are skipped —
 *  .ts precedence never promotes the sibling .json); null = nothing
 *  here. */
function loadDirConfig(
  dir: string,
  sections: Record<string, ConfigSection<unknown>>
): (BroConfig & Record<string, unknown>) | 'broken' | null {
  for (const name of ['bro.config.ts', 'bro.config.json']) {
    const path = join(dir, name)
    if (!existsSync(path)) {
      continue
    }
    const raw = readConfigFile(name, path)
    if (raw === undefined) {
      return 'broken' // warned inside readConfigFile
    }
    // a valid non-object root ("str", […], 42) is not a config —
    // spreading it would silently produce garbage keys
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      console.error(`${name}: root must be an object — skipping`)
      return 'broken'
    }
    const { stores: _s, store: _legacy, plugins: _p, pack: _pk, ...rest } = raw as RawConfig
    const pack = normalizePack(_pk)
    const config: BroConfig & Record<string, unknown> = {
      ...DEFAULT_CONFIG,
      ...rest,
      ...(pack !== undefined ? { pack } : {}),
      stores: normalizeStores(raw as RawConfig),
      plugins: normalizePluginSpecs(dir, (raw as RawConfig).plugins),
    }
    applySections(config, raw as Record<string, unknown>, sections)
    return config
  }
  return null
}

/** Relative specs anchor at the config's own dir — an inherited config's
 *  `./x.ts` plugin must resolve in the main worktree, not the linked
 *  one. Containment is kept here: a spec escaping its anchor is dropped,
 *  so the absolute path reaching importPluginModule can't bypass its
 *  repo-root guard. */
function normalizePluginSpecs(dir: string, plugins: unknown): string[] {
  if (!Array.isArray(plugins)) {
    return []
  }
  return plugins
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .flatMap((v) => {
      if (!v.startsWith('.')) {
        return [v]
      }
      // anchor must be absolute too — a relative cwd would compare an
      // absolute path against 'foo/' and drop every legit spec
      const anchor = resolve(dir)
      const abs = resolve(dir, v)
      if (abs !== anchor && !abs.startsWith(anchor + sep)) {
        console.error(`warning: plugin spec "${v}" escapes ${dir} — skipped`)
        return []
      }
      return [abs]
    })
}
