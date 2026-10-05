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

/** Closed union — kinds exist for *connection shape* differences, not
 *  vendors or wires (an api host serves many models on many wires; two
 *  OpenAI-compat hosts are two entries, one kind). A fourth kind is a
 *  spec discussion, not a PR. */
export const PROVIDER_KINDS = ['api', 'acp', 'cli'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/** The wire protocol one served model speaks — the api kind's per-model
 *  knob: 'systemone' is the native typed-judgment contract
 *  (POST {baseUrl}/v1/systemone), 'openai-compat' is generic
 *  chat-completions prose (POST {baseUrl}/chat/completions). */
export type ApiWire = 'systemone' | 'openai-compat'
export const API_WIRES = ['systemone', 'openai-compat'] as const

/** A systemone-family model id — `typesafe/jev-<version|latest>`,
 *  possibly router-prefixed (`kilo/orcarouter/typesafe/jev-1.13`), or a
 *  bare `jev-*` pin. The version anchor is deliberate: `jev-router` is
 *  a router PRODUCT pointing at arbitrary upstreams, not a jev model —
 *  inferring its wire as systemone would let a config silently spend on
 *  it. Lives in core because api-entry normalization consumes it at
 *  parse time, before any provider binding exists. */
export const isSystemoneFamily = (model: string | undefined): boolean =>
  model !== undefined &&
  /(?:^|\/)typesafe\/jev-(?:\d|latest)|^jev-(?:\d|latest)/.test(model)

export type ProviderEntry =
  | {
      type: 'api'
      /** Host root — every model is served under it on its own wire. */
      baseUrl: string
      /** The allowlist: served model id → resolved wire. Values in
       *  config may be a wire string, {wire}, or null (wire inferred —
       *  systemone-family ids land on 'systemone', the rest on
       *  'openai-compat'); parsing always materializes the wire. */
      models: Record<string, ApiWire>
      /** Default model — must be a key of models. */
      model?: string
      apiKeyEnv?: string
      /** Secret-store command (secret-tool/pass/op …) whose stdout is
       *  the key — the secure alternative to apiKeyEnv. */
      apiKeyCommand?: string
    }
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
  // call is 'auto': the resolved model's wire picks the surface —
  // systemone → typed, openai-compat → prose
  api: {
    call: 'auto',
    spawn: false,
    required: ['baseUrl'],
    optional: ['model', 'apiKeyEnv', 'apiKeyCommand'],
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

/** The api kind's `models` map → resolved wires, or the fail string.
 *  A model's wire may be written as a bare string ('systemone'), an
 *  object {wire}, or null — null/absent infers: systemone-family ids
 *  get 'systemone', everything else 'openai-compat'. */
function parseApiModels(
  raw: unknown
): Record<string, ApiWire> | { err: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { err: 'models must be a model→wire map' }
  }
  const out: Record<string, ApiWire> = {}
  for (const [id, v] of Object.entries(raw)) {
    const key = id.trim()
    if (key === '') {
      return { err: 'models keys must be non-empty model ids' }
    }
    const wire =
      typeof v === 'string'
        ? v
        : typeof v === 'object' && v !== null
          ? (v as Record<string, unknown>).wire
          : undefined
    if (wire === undefined || wire === null) {
      out[key] = isSystemoneFamily(key) ? 'systemone' : 'openai-compat'
      continue
    }
    if (typeof wire !== 'string' || !(API_WIRES as readonly string[]).includes(wire)) {
      return { err: `models.${key}.wire must be one of ${API_WIRES.join('|')}` }
    }
    out[key] = wire as ApiWire
  }
  if (Object.keys(out).length === 0) {
    return { err: 'models must name at least one served model' }
  }
  return out
}

export function parseProviderEntry(name: string, raw: unknown): ProviderEntry | null {
  const fail = (why: string): null => {
    console.error(`bro.config: providers.${name} ${why} — entry dropped`)
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('must be an object')
  }
  const o = raw as Record<string, unknown>
  // the retired per-protocol kinds fold into one api host entry — name
  // the old spelling so the error IS the migration note
  if (o.type === 'systemone' || o.type === 'openai-compat') {
    return fail(
      `type '${o.type}' is retired — use type 'api' with models: { "<model>": "${o.type}" }`
    )
  }
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
  let models: Record<string, ApiWire> | undefined
  if (type === 'api') {
    const parsed = parseApiModels(o.models)
    if ('err' in parsed) {
      return fail(parsed.err)
    }
    models = parsed
    if (typeof picked.model === 'string' && models[picked.model] === undefined) {
      return fail(`model '${picked.model}' is not in the models allowlist`)
    }
  }
  if (typeof picked.apiKeyEnv === 'string' && !isEnvName(picked.apiKeyEnv)) {
    return fail('apiKeyEnv must NAME an env var (SCREAMING_SNAKE) — config never holds a key value')
  }
  // an `echo sk-…`/`printf ts_live_…` "command" smuggles the key into
  // config — the whole point of apiKeyCommand is that the file never
  // holds the value
  if (
    typeof picked.apiKeyCommand === 'string' &&
    /sk-[A-Za-z0-9]|ts_(?:live|test)_|Bearer\s/i.test(picked.apiKeyCommand)
  ) {
    return fail('apiKeyCommand must RUN a secret lookup — it may not contain a key value')
  }
  return { type, ...picked, ...(models === undefined ? {} : { models }) } as ProviderEntry
}

export type ApiEntry = Extract<ProviderEntry, { type: 'api' }>

/** One served model resolved out of an api entry — baseUrl + auth live
 *  on the host, the wire is the model's. `requested` is the consumer's
 *  pin (judge.model, spawn --model); the entry's `model` is the default.
 *  A model outside the allowlist is a config error — a provider that
 *  silently reroutes to a model the user never declared is the
 *  jev-router failure, rebuilt. */
export function resolveApiModel(
  entry: ApiEntry,
  requested: string | undefined
): { model: string; wire: ApiWire } {
  const model = requested ?? entry.model ?? (Object.keys(entry.models).length === 1 ? Object.keys(entry.models)[0] : undefined)
  if (model === undefined) {
    throw new Error(
      `api provider serves ${Object.keys(entry.models).length} models — name one (e.g. judge.model)`
    )
  }
  // hasOwn pins the check to a declared key — an inherited member
  // ('constructor' & co) must not satisfy the allowlist either
  const wire = Object.hasOwn(entry.models, model)
    ? (entry.models as Record<string, ApiWire | undefined>)[model]
    : undefined
  if (wire === undefined) {
    throw new Error(
      `model '${model}' is not served by this provider — declared: ${Object.keys(entry.models).join(', ')}`
    )
  }
  return { model, wire }
}

/** Lookup by consumer reference — `judge.provider`, `agents.*.provider`.
 *  Throws UnknownProviderError naming the missing key. */
export function getProvider(
  providers: Record<string, ProviderEntry>,
  name: string
): ProviderEntry {
  // hasOwn pins the lookup to configured keys — 'constructor' must not
  // resolve to an inherited member instead of UnknownProviderError
  const entry = Object.hasOwn(providers, name) ? providers[name] : undefined
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
