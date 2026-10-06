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
 *  chat-completions prose (POST {baseUrl}/v1/chat/completions —
 *  each wire mounts its versioned prefix on the host root; a base
 *  the author already versioned is kept). */
export type ApiWire = 'systemone' | 'openai-compat'
export const API_WIRES = ['systemone', 'openai-compat'] as const

/** A systemone-family model id — `typesafe/jev-<version|latest>`,
 *  possibly router-prefixed (`kilo/orcarouter/typesafe/jev-1.13`), or a
 *  bare `jev-*` pin. The version anchor is deliberate: `jev-router` is
 *  a router PRODUCT pointing at arbitrary upstreams, not a jev model —
 *  inferring its wire as systemone would let a config silently spend on
 *  it. `latest` must complete the segment for the same reason —
 *  `jev-latest-router` is a product, not the model pin. Lives in core
 *  because api-entry normalization consumes it at parse time, before
 *  any provider binding exists. */
export const isSystemoneFamily = (model: string | undefined): boolean =>
  model !== undefined &&
  /(?:^|\/)typesafe\/jev-(?:latest|\d+(?:\.\d+)*)(?=$|\/)|^jev-(?:latest|\d+(?:\.\d+)*)(?=$|\/)/.test(model)

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

/** One model entry → its wire. A bare string wins; `{wire}` unwraps;
 *  null/absent infers: systemone-family ids get 'systemone',
 *  everything else 'openai-compat'. undefined = the declared wire was
 *  not a known wire name — or the VALUE had a shape the map doesn't
 *  speak (false/42/[...] are errors, never inferences). */
function resolveModelWire(key: string, v: unknown): ApiWire | undefined {
  const infer = (): ApiWire => (isSystemoneFamily(key) ? 'systemone' : 'openai-compat')
  if (v === undefined || v === null) {
    return infer()
  }
  const wire = typeof v === 'string' ? v : isPlainObject(v) ? v.wire : undefined
  // false/42/[...] reach here with wire===undefined — an unknown VALUE
  // shape is a config error, not a license to infer. Same for an object
  // carrying foreign keys ({wrie:…} is a typo, not a pin): only {} and
  // {wire:null} read as the object spelling of "infer".
  if (wire === undefined || wire === null) {
    return isPlainObject(v) && Object.keys(v).every((k) => k === 'wire')
      ? infer()
      : undefined
  }
  return typeof wire === 'string' && (API_WIRES as readonly string[]).includes(wire)
    ? (wire as ApiWire)
    : undefined
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Tagged parse result — a discriminator field, not a key-name probe:
 *  a model literally named 'err' is a valid id, so the failure shape
 *  can't live in the same namespace as the map. */
type ModelsParsed = { ok: true; models: Record<string, ApiWire> } | { ok: false; err: string }

/** One `models` entry → the resolved map key, or the fail string. */
function parseModelEntry(
  out: Record<string, ApiWire>,
  id: string,
  v: unknown
): string | undefined {
  const key = id.trim()
  if (key === '') {
    return 'models keys must be non-empty model ids'
  }
  const resolved = resolveModelWire(key, v)
  if (resolved === undefined) {
    return `models.${key}.wire must be a wire string (${API_WIRES.join('|')}), {wire}, or null`
  }
  // defineProperty, not assignment — a model id like '__proto__'
  // must land as an own key, never trigger the prototype setter
  Object.defineProperty(out, key, {
    value: resolved,
    enumerable: true,
    writable: true,
    configurable: true,
  })
  return undefined
}

/** The api kind's `models` map → resolved wires, or the fail string. */
function parseApiModels(raw: unknown): ModelsParsed {
  if (!isPlainObject(raw)) {
    return { ok: false, err: 'models must be a model→wire map' }
  }
  const out: Record<string, ApiWire> = {}
  for (const [id, v] of Object.entries(raw)) {
    const err = parseModelEntry(out, id, v)
    if (err !== undefined) {
      return { ok: false, err }
    }
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, err: 'models must name at least one served model' }
  }
  return { ok: true, models: out }
}

/** api-kind extras: the models map is required; the pinned default
 *  must sit in the allowlist; a systemone wire needs a key source —
 *  checked here, while the error still names the config field. */
function parseApiEntry(
  picked: Record<string, string | boolean>,
  rawModels: unknown
): ModelsParsed {
  const parsed = parseApiModels(rawModels)
  if (!parsed.ok) {
    return parsed
  }
  const models = parsed.models
  if (typeof picked.model === 'string' && !Object.hasOwn(models, picked.model)) {
    return { ok: false, err: `model '${picked.model}' is not in the models allowlist` }
  }
  // the systemone wire always sends Bearer — an entry resolving a
  // model to it with no key source parses but fails every call
  if (
    Object.values(models).includes('systemone') &&
    picked.apiKeyEnv === undefined &&
    picked.apiKeyCommand === undefined
  ) {
    return {
      ok: false,
      err: 'serves a systemone-wire model with no key source — set apiKeyEnv or apiKeyCommand',
    }
  }
  return parsed
}

/** The entry's `type` field → a known kind, or the fail string. The
 *  retired per-protocol spellings fold into the api kind — their error
 *  IS the migration note. Tagged, not raw-string: ProviderKind ⊆ string
 *  would collapse the union. */
function parseProviderKind(
  o: Record<string, unknown>
): { kind: ProviderKind } | { err: string } {
  const t = o.type
  if (t === 'systemone' || t === 'openai-compat') {
    return { err: `type '${t}' is retired — use type 'api' with models: { "<model>": "${t}" }` }
  }
  return typeof t === 'string' && (PROVIDER_KINDS as readonly string[]).includes(t)
    ? { kind: t as ProviderKind }
    : { err: `type must be one of ${PROVIDER_KINDS.join('|')} — got ${JSON.stringify(t)}` }
}

/** required + optional + optionalBool field sweeps → the picked bag,
 *  or the fail string on a missing required field. */
function pickSpecFields(
  name: string,
  spec: ProviderKindSpec,
  o: Record<string, unknown>
): { picked: Record<string, string | boolean> } | { err: string } {
  const picked: Record<string, string | boolean> = {}
  for (const f of spec.required) {
    const v = str(o[f])
    if (v === undefined) {
      return { err: `requires "${f}"` }
    }
    picked[f] = v
  }
  for (const f of spec.optional) {
    pickOptStr(name, o, f, picked)
  }
  for (const f of spec.optionalBool ?? []) {
    pickOptBool(name, o, f, picked)
  }
  return { picked }
}

export function parseProviderEntry(name: string, raw: unknown): ProviderEntry | null {
  const fail = (why: string): null => {
    console.error(`bro.config: providers.${name} ${why} — entry dropped`)
    return null
  }
  if (!isPlainObject(raw)) {
    return fail('must be an object')
  }
  const kindRes = parseProviderKind(raw)
  if ('err' in kindRes) {
    return fail(kindRes.err)
  }
  const kind = kindRes.kind
  const spec = PROVIDER_REGISTRY[kind]
  const fields = pickSpecFields(name, spec, raw)
  if ('err' in fields) {
    return fail(fields.err)
  }
  const picked = fields.picked
  let models: Record<string, ApiWire> | undefined
  if (kind === 'api') {
    const parsed = parseApiEntry(picked, raw.models)
    if (!parsed.ok) {
      return fail(parsed.err)
    }
    models = parsed.models
  }
  const keyErr = keySourceErr(picked)
  if (keyErr !== null) {
    return fail(keyErr)
  }
  return { type: kind, ...picked, ...(models === undefined ? {} : { models }) } as ProviderEntry
}

/** Key-source guards shared by every kind: apiKeyEnv names an env var
 *  (config never holds a value); apiKeyCommand must RUN a lookup — an
 *  `echo sk-…`/`printf ts_live_…` "command" smuggles the key into
 *  config, which is the whole point the field exists to prevent. */
function keySourceErr(picked: Record<string, string | boolean>): string | null {
  if (typeof picked.apiKeyEnv === 'string' && !isEnvName(picked.apiKeyEnv)) {
    return 'apiKeyEnv must NAME an env var (SCREAMING_SNAKE) — config never holds a key value'
  }
  if (
    typeof picked.apiKeyCommand === 'string' &&
    /sk-[A-Za-z0-9]|ts_(?:live|test)_|Bearer\s/i.test(picked.apiKeyCommand)
  ) {
    return 'apiKeyCommand must RUN a secret lookup — it may not contain a key value'
  }
  return null
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

/** `{model}` — a cli command template's only wire for a model
 *  override: expands to the resolved effective model, quoted for
 *  `sh -c` like `{promptFile}` (an id could carry shell metachars).
 *  Absent the placeholder the command is returned verbatim — call
 *  sites own the rule that an override a bare command can't consume
 *  is a loud error, never a relabel. */
export function expandModelArg(command: string, model: string): string {
  const esc = model.replaceAll("'", String.raw`'\''`) // codeql[js/shell-command-constructed-from-input] — operator-authored template, resolved value quoted
  return command.replaceAll('{model}', `'${esc}'`) // codeql[js/shell-command-constructed-from-input] — see above
}

/** The cli kind's model resolution — `resolveApiModel`'s analogue for
 *  a bare command template, shared by the call and spawn surfaces:
 *  `{model}` present → the resolved model (override > entry pin) must
 *  exist to substitute, else the entry uses the placeholder with no
 *  default (a config bug); absent → an override differing from the
 *  pin can never reach the process, so recording it would be
 *  provenance the worker never ran. Returns the effective model and
 *  the command to run, or throws the caller's error — the surfaces
 *  disagree on error type (CliConfigError vs SpawnError) but not on
 *  the rule. */
export function cliCommandModel(
  command: string,
  pinned: string | undefined,
  override: string | undefined,
  unhonorable: (model: string) => Error,
  unpinned: () => Error
): { command: string; model: string | undefined } {
  const model = override ?? pinned
  if (command.includes('{model}')) {
    if (model === undefined) {
      throw unpinned()
    }
    return { command: expandModelArg(command, model), model }
  }
  if (override !== undefined && override !== pinned) {
    throw unhonorable(override)
  }
  return { command, model }
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
