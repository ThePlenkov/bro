/**
 * bro configuration. Resolution order: bro.config.json in cwd → defaults.
 * Keep it a JSON file — bro runs as a compiled CLI, importing user TS at
 * runtime is not worth the loader dance for v0.
 */
import { existsSync, readFileSync } from 'node:fs'
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

export function loadConfig(cwd: string = process.cwd()): BroConfig {
  const path = join(cwd, 'bro.config.json')
  if (!existsSync(path)) {
    return DEFAULT_CONFIG
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RawConfig
    // a valid-JSON non-object root ("str", […], 42) is not a config —
    // spreading it would silently produce garbage keys
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      console.error('bro.config.json: root must be a JSON object — using jsonl-only stores')
      return { ...DEFAULT_CONFIG, stores: ['jsonl'] }
    }
    const { stores: _s, store: _legacy, ...rest } = raw
    return {
      ...DEFAULT_CONFIG,
      ...rest,
      stores: normalizeStores(raw),
      debt: { ...DEFAULT_CONFIG.debt, ...(rest.debt ?? {}) },
      sync: { ...DEFAULT_CONFIG.sync, ...(rest.sync ?? {}) },
    }
  } catch {
    // Unparseable config ≠ missing config — don't silently enable beads
    // (and its `bd init` side effects) on a file the user broke.
    console.error('warning: bro.config.json is not valid JSON — using jsonl-only stores')
    return { ...DEFAULT_CONFIG, stores: ['jsonl'] }
  }
}
