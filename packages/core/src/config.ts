/**
 * bro configuration. Resolution order: bro.config.ts → bro.config.json
 * in cwd → defaults. The .ts file loads synchronously via createRequire —
 * native type stripping handles it on Node ≥22.18 (the repo floor);
 * `export default {…}` and `module.exports = {…}` both work, and no bro
 * import is required so the config resolves under a global install too.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const STORE_BACKENDS = ['jsonl', 'beads', 'gitref'] as const
export type StoreBackend = (typeof STORE_BACKENDS)[number]
export const PERSONALITIES = ['terse', 'mentor', 'sarcastic'] as const
export type Personality = (typeof PERSONALITIES)[number]

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
  }
}

export const DEFAULT_CONFIG: BroConfig = {
  stores: ['jsonl', 'beads'],
  personality: 'terse',
  debt: { dir: '.agents/review-debt' },
  sync: { ref: 'refs/bro/data', remote: 'origin' },
}

interface RawConfig extends Partial<Omit<BroConfig, 'stores'>> {
  /** New: explicit backend list. */
  stores?: unknown
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
export function defineConfig(
  config: Partial<BroConfig> & Record<string, unknown>
): Record<string, unknown> {
  return config
}

/** Reads one config file; undefined = failed (caller falls back to
 *  jsonl-only — a broken file must not silently enable beads). */
function readConfigFile(name: string, path: string): unknown {
  try {
    if (name.endsWith('.ts')) {
      // resolving from the config itself keeps any relative imports
      // inside it rooted at the repo, not at the CLI install location
      const mod = createRequire(path)(path) as { default?: unknown }
      return mod.default ?? mod
    }
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const hint =
      e.code === 'ERR_UNKNOWN_FILE_EXTENSION'
        ? ' (bro.config.ts needs Node >=22.18 — native type stripping)'
        : ''
    console.error(`warning: ${name} failed to load — using jsonl-only stores${hint}`)
    return undefined
  }
}

export function loadConfig(cwd: string = process.cwd()): BroConfig {
  for (const name of ['bro.config.ts', 'bro.config.json']) {
    const path = join(cwd, name)
    if (!existsSync(path)) {
      continue
    }
    const raw = readConfigFile(name, path)
    if (raw === undefined) {
      return { ...DEFAULT_CONFIG, stores: ['jsonl'] }
    }
    // a valid non-object root ("str", […], 42) is not a config —
    // spreading it would silently produce garbage keys
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      console.error(`${name}: root must be an object — using jsonl-only stores`)
      return { ...DEFAULT_CONFIG, stores: ['jsonl'] }
    }
    const { stores: _s, store: _legacy, ...rest } = raw as RawConfig
    return {
      ...DEFAULT_CONFIG,
      ...rest,
      stores: normalizeStores(raw as RawConfig),
      debt: { ...DEFAULT_CONFIG.debt, ...(rest.debt ?? {}) },
      // only string fields may reach git arg construction — a null or
      // non-string sync.ref/sync.remote must fall back to the default
      sync: {
        ...DEFAULT_CONFIG.sync,
        ...(typeof rest.sync === 'object' && rest.sync !== null
          ? Object.fromEntries(
              Object.entries(rest.sync).filter(([, v]) => typeof v === 'string')
            )
          : {}),
      },
    }
  }
  return DEFAULT_CONFIG
}
