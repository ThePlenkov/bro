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
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gitTry } from './git.ts'

export const STORE_BACKENDS = ['jsonl', 'beads', 'gitref'] as const
export type StoreBackend = (typeof STORE_BACKENDS)[number]
export const PERSONALITIES = ['terse', 'mentor', 'sarcastic'] as const
export type Personality = (typeof PERSONALITIES)[number]

/** A plugin-owned config section: raw JSON value in, normalized section
 *  out. `schema(undefined)` MUST return the section default — that's the
 *  fallback when the raw value is missing or the schema throws. */
export type ConfigSection<T> = (raw: unknown) => T

export const debtSection: ConfigSection<{ dir: string }> = (raw) => ({
  // dir feeds path.join — a non-string or empty value must fall back to
  // the default, not throw mid-command
  dir:
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { dir?: unknown }).dir === 'string' &&
    (raw as { dir: string }).dir.trim() !== ''
      ? (raw as { dir: string }).dir
      : DEFAULT_CONFIG.debt.dir,
})

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

export const actSection: ConfigSection<{
  ignoreChecks: string[]
  maxRounds: number
}> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    ignoreChecks?: unknown
    maxRounds?: unknown
  }
  return {
    // only a list of substrings may reach the check filter — anything
    // else falls back to the default
    ignoreChecks: Array.isArray(obj.ignoreChecks)
      ? obj.ignoreChecks.filter(
          // an empty substring would match EVERY check name
          (v): v is string => typeof v === 'string' && v.trim() !== ''
        )
      : [],
    maxRounds:
      typeof obj.maxRounds === 'number' &&
      Number.isInteger(obj.maxRounds) &&
      obj.maxRounds >= 0
        ? obj.maxRounds
        : DEFAULT_CONFIG.act.maxRounds,
  }
}

/** Sections core normalizes itself — identical to what the built-in
 *  plugins declare as their configSchema. */
const CORE_SECTIONS: Record<string, ConfigSection<unknown>> = {
  debt: debtSection as ConfigSection<unknown>,
  sync: syncSection as ConfigSection<unknown>,
  act: actSection as ConfigSection<unknown>,
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
    /** Check-name substrings (case-insensitive) excluded from the exit
     *  gate — advisory-only checks like a flaky external reviewer whose
     *  infra is not this repo's problem. */
    ignoreChecks: string[]
    /** Inline fix-round cap — past it, remaining threads must defer to
     *  debt beads instead of another push. 0 disables the cap. */
    maxRounds: number
  }
  /** External plugin specifiers — relative paths or package names the CLI
   *  resolves from the repo and imports at startup. Each module's default
   *  export must be a BroPlugin (or an array of them). */
  plugins: string[]
}

export const DEFAULT_CONFIG: BroConfig = {
  stores: ['jsonl', 'beads'],
  personality: 'terse',
  debt: { dir: '.agents/review-debt' },
  sync: { ref: 'refs/bro/data', remote: 'origin', beads: true },
  act: { ignoreChecks: [], maxRounds: 3 },
  plugins: [],
}

interface RawConfig extends Partial<Omit<BroConfig, 'stores' | 'plugins'>> {
  /** New: explicit backend list. */
  stores?: unknown
  /** External plugin specifiers — normalized to a string list. */
  plugins?: unknown
  /** Legacy v0.1.0 field — 'beads'/'both' meant jsonl + beads projection. */
  store?: string
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
 *  gives typed sections when @bro/core is a local dep; a plain object
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

/** Runs every section schema over the raw file — a throwing schema warns
 *  and falls back to schema(undefined), never crashes the load. */
function applySections(
  config: BroConfig & Record<string, unknown>,
  raw: Record<string, unknown>,
  sections: Record<string, ConfigSection<unknown>>
): void {
  for (const [key, schema] of Object.entries({ ...CORE_SECTIONS, ...sections })) {
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
  return dirname(resolve(cwd, r.out.trim()))
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
  const dirs = [cwd, mainWorktreeRoot(cwd)].filter(
    (d): d is string => d !== null && d.trim() !== ''
  )
  // a config that exists but fails never silently enables beads — the
  // flag keeps the final fallback at jsonl-only in that case
  let sawBroken = false
  for (const dir of new Set(dirs)) {
    for (const name of ['bro.config.ts', 'bro.config.json']) {
      const path = join(dir, name)
      if (!existsSync(path)) {
        continue
      }
      const raw = readConfigFile(name, path)
      // broken file (warned inside readConfigFile) or invalid root: skip
      // the rest of THIS dir — .ts precedence means a broken winner never
      // promotes the sibling .json — but the next dir still gets tried
      if (raw === undefined) {
        sawBroken = true
        break
      }
      // a valid non-object root ("str", […], 42) is not a config —
      // spreading it would silently produce garbage keys
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        console.error(`${name}: root must be an object — skipping`)
        sawBroken = true
        break
      }
      const { stores: _s, store: _legacy, plugins: _p, ...rest } = raw as RawConfig
      const config: BroConfig & Record<string, unknown> = {
        ...DEFAULT_CONFIG,
        ...rest,
        stores: normalizeStores(raw as RawConfig),
        plugins: Array.isArray((raw as RawConfig).plugins)
          ? ((raw as RawConfig).plugins as unknown[])
              .filter((v): v is string => typeof v === 'string')
              .map((v) => v.trim())
              .filter((v) => v !== '')
              // relative specs anchor at the config's own dir — an
              // inherited config's `./x.ts` plugin must resolve in the
              // main worktree, not the linked one
              .map((v) => (v.startsWith('.') ? resolve(dir, v) : v))
          : [],
      }
      applySections(config, raw as Record<string, unknown>, sections)
      return config
    }
  }
  return fallback(sawBroken ? ['jsonl'] : [...DEFAULT_CONFIG.stores])
}
