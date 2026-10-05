/**
 * Typed provider registry (spec: specs/bro-ribc.1.md). One `providers`
 * map in bro.config.json; consumers (judge, fleet) pick entries by name.
 * Core holds types + registry config only — SDK bindings live in
 * @broject/providers so a repo without providers never pays the import.
 */

/** Env var NAME sanity — `apiKeyEnv` names a variable, never holds the
 *  key value. Names must be SCREAMING_SNAKE: a pasted key value
 *  (`ts_live_…`, `sk-…`) fails here — but an ALL-CAPS key passes too,
 *  so a validated name is still never echoed back in a missing-key
 *  message (it may be the secret itself). */
export const isEnvName = (v: string): boolean => /^[A-Z_][A-Z0-9_]*$/.test(v)

/** Closed union — kinds exist for *protocol* differences, not vendors
 *  (two OpenAI-compat hosts are two entries, one kind). A fifth kind is
 *  a spec discussion, not a PR. */
export const PROVIDER_KINDS = ['systemone', 'openai-compat', 'acp', 'cli'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export type ProviderEntry =
  | { type: 'systemone'; baseUrl?: string; apiKeyEnv: string; model: string }
  | { type: 'openai-compat'; baseUrl: string; apiKeyEnv?: string; model: string }
  | {
      type: 'acp'
      command: string
      profile?: string
      model?: string
      apiKeyEnv?: string
      /** Permission policy for the spawn surface's driver (spec
       *  bro-5hx1.1 §7): answer `session/request_permission` with the
       *  allow option. Default false — a headless worker denies and
       *  logs. */
      autoApprove?: boolean
    }
  | { type: 'cli'; command: string; model?: string }

/** A `fleet.profiles.<name>` spawn preset (spec bro-5hx1.1) — the
 *  convoy vocabulary for "sweeps go here, features go there". Lives
 *  under `fleet` deliberately: `agents` is a per-backend knob bag, so
 *  `agents.profiles` would parse as a phantom backend. `backend`
 *  redirects connector resolution only when no explicit connector was
 *  named. */
export interface FleetProfile {
  provider: string
  model?: string
  backend?: string
  autoApprove?: boolean
}

/** Judge-surface fidelity: `typed` = native judgments (choice/score/
 *  noul + probabilities), `prose` = prompt-and-parse (llm-judge
 *  semantics — never counted as calibrated), `auto` = decided per
 *  session by the served model (acp: typed on a systemone-family
 *  model, prose otherwise). */
export type CallSurfaceGrade = 'typed' | 'prose' | 'auto'

/** Which consumer surface an entry is being asked to serve. */
export type ProviderSurface = 'call' | 'spawn'

/** Kind registry — the capability matrix plus the fields each kind's
 *  entry may carry. `call` null means the kind has no judge surface;
 *  `spawn` true means a fleet worker can live inside it. */
export interface ProviderKindSpec {
  call: CallSurfaceGrade | null
  spawn: boolean
  required: readonly string[]
  optional: readonly string[]
  /** Boolean knobs — a flag's value type is boolean, not the string
   *  contract `optional` enforces. */
  optionalBool?: readonly string[]
}

export const PROVIDER_REGISTRY: Record<ProviderKind, ProviderKindSpec> = {
  systemone: { call: 'typed', spawn: false, required: ['apiKeyEnv', 'model'], optional: ['baseUrl'] },
  'openai-compat': {
    call: 'prose',
    spawn: false,
    required: ['baseUrl', 'model'],
    optional: ['apiKeyEnv'],
  },
  acp: {
    call: 'auto',
    spawn: true,
    required: ['command'],
    optional: ['profile', 'model', 'apiKeyEnv'],
    optionalBool: ['autoApprove'],
  },
  cli: { call: 'prose', spawn: true, required: ['command'], optional: ['model'] },
}

/** A consumer named a provider no entry resolves to — startup error,
 *  never a silent fallthrough to a vendor the user didn't pick. */
export class UnknownProviderError extends Error {
  constructor(name: string) {
    super(`providers.${name} is not configured — name a configured provider entry`)
    this.name = 'UnknownProviderError'
  }
}

/** A consumer asked an entry for a surface its kind doesn't have —
 *  a config error naming kind + surface, not a runtime surprise. */
export class ProviderSurfaceError extends Error {
  constructor(
    public providerName: string,
    entry: ProviderEntry,
    surface: ProviderSurface
  ) {
    super(`providers.${providerName} (type '${entry.type}') has no ${surface} surface`)
    this.name = 'ProviderSurfaceError'
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** Optional string field — a present-but-blank value drops the field
 *  with a warning, never the entry (the required fields do that). */
function pickOptStr(
  name: string,
  o: Record<string, unknown>,
  f: string,
  picked: Record<string, string | boolean>
): void {
  const v = o[f]
  if (v === undefined) {
    return
  }
  const s = str(v)
  if (s === undefined) {
    console.error(`bro.config: providers.${name}.${f} must be a non-empty string — field dropped`)
    return
  }
  picked[f] = s
}

function pickOptBool(
  name: string,
  o: Record<string, unknown>,
  f: string,
  picked: Record<string, string | boolean>
): void {
  const v = o[f]
  if (v === undefined) {
    return
  }
  if (typeof v !== 'boolean') {
    console.error(`bro.config: providers.${name}.${f} must be a boolean — field dropped`)
    return
  }
  picked[f] = v
}

/** Validates one raw entry against its kind spec. Returns the typed
 *  entry, or null after warning — a malformed entry is dropped, never
 *  half-registered (a pasted key value in apiKeyEnv drops the whole
 *  entry rather than silently downgrading auth). */
export function parseProviderEntry(name: string, raw: unknown): ProviderEntry | null {
  const fail = (why: string): null => {
    console.error(`bro.config: providers.${name} ${why} — entry dropped`)
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('must be an object')
  }
  const o = raw as Record<string, unknown>
  if (typeof o.type !== 'string' || !(PROVIDER_KINDS as readonly string[]).includes(o.type)) {
    return fail(`type must be one of ${PROVIDER_KINDS.join('|')} — got ${JSON.stringify(o.type)}`)
  }
  const type = o.type as ProviderKind
  const spec = PROVIDER_REGISTRY[type]
  const picked: Record<string, string | boolean> = {}
  for (const f of spec.required) {
    const v = str(o[f])
    if (v === undefined) {
      return fail(`requires "${f}"`)
    }
    picked[f] = v
  }
  for (const f of spec.optional) {
    pickOptStr(name, o, f, picked)
  }
  for (const f of spec.optionalBool ?? []) {
    pickOptBool(name, o, f, picked)
  }
  if (typeof picked.apiKeyEnv === 'string' && !isEnvName(picked.apiKeyEnv)) {
    return fail('apiKeyEnv must NAME an env var (SCREAMING_SNAKE) — config never holds a key value')
  }
  return { type, ...picked } as ProviderEntry
}

/** Lookup by consumer reference — `judge.provider`, `agents.*.provider`.
 *  Throws UnknownProviderError naming the missing key. */
export function getProvider(
  providers: Record<string, ProviderEntry>,
  name: string
): ProviderEntry {
  const entry = providers[name]
  if (entry === undefined) {
    throw new UnknownProviderError(name)
  }
  return entry
}

/** Lookup + surface assertion in one — `requireProviderSurface(cfg,
 *  name, 'spawn')` returns the entry or throws ProviderSurfaceError
 *  naming kind + surface (e.g. asking a `systemone` entry to spawn a
 *  fleet worker). */
export function requireProviderSurface(
  providers: Record<string, ProviderEntry>,
  name: string,
  surface: ProviderSurface
): ProviderEntry {
  const entry = getProvider(providers, name)
  const spec = PROVIDER_REGISTRY[entry.type]
  if (surface === 'call' ? spec.call === null : !spec.spawn) {
    throw new ProviderSurfaceError(name, entry, surface)
  }
  return entry
}
