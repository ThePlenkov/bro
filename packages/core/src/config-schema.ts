/**
 * The bro.config JSON Schema contract (spec: specs/bro-d9dmx.md). Every
 * registered `ConfigSection` carries a `.jsonSchema` next to its parser;
 * this module turns that registry into:
 *
 * - `configSchemaDocument` — the emitted draft-07 document
 *   `schemas/bro.config.schema.json` ships to IDEs and agents;
 * - `configDiagnostics` — per-layer validation errors naming the
 *   layer + file a bad value came from (the audit's layer-provenance
 *   requirement): what `bro doctor` reports and `--strict` fails on;
 * - `configPolicyErrors` — the same restricted to *policy* sections
 *   (CONFIG_SECTION_LAYERS): what the mutation gate refuses on.
 *
 * The validator covers only the keywords the section schemas use —
 * sections describe the accepted input shape, not full semantics
 * (secret-in-command guards, model allowlists stay in the parsers).
 * Fail-open is unchanged everywhere else: `loadConfig` callers and
 * hooks never touch this module.
 */
import {
  CONFIG_LAYER_FILES,
  CONFIG_SECTION_LAYERS,
  CORE_SECTIONS,
  deepMerge,
  loadConfigLayers,
  PERSONALITIES,
  STORE_BACKENDS,
  type ConfigLayerName,
  type ConfigSection,
  type JsonSchema,
} from './config.ts'
import { basename } from 'node:path'

/** The canonical `$schema` URL `bro setup` writes — unpkg serves the
 *  copy shipped inside the published @broject/bro package. */
export const CONFIG_SCHEMA_URL =
  'https://unpkg.com/@broject/bro/schemas/bro.config.schema.json'

export interface SchemaError {
  path: string
  message: string
}

export interface ConfigDiagnostic {
  layer: ConfigLayerName
  file: string
  /** Top-level config key the error lives under. */
  key: string
  /** Dotted path from the config root — `sdd.mode`, `act.ignoreChecks[2].name`. */
  path: string
  message: string
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const jsonTypeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v

/** Diagnostics print to terminals and CI logs — control chars (C0/C1,
 *  ESC) in a config key or value must not reach them intact: an ANSI
 *  sequence in a bad key could rewrite the display. JSON.stringify
 *  already escapes C0, but not DEL/C1 — and the non-serializable
 *  String() fallback carries raw chars. */
const safe = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '�')

const describe = (v: unknown): string => {
  const s = safe(JSON.stringify(v) ?? String(v))
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}

/** A config value under a credential-shaped path — or one that LOOKS
 *  like a credential — never echoes into a diagnostic: `bro doctor`
 *  output is retained in terminals and CI logs (sourcery PR #637). */
const SECRET_PATH = /token|secret|password|credential|authoriz|api[-_]?key|bearer/i
const SECRET_VALUE = /\b(bearer\s+\S+|xox[baprs]-\S+|ghp_[a-zA-Z0-9]{20,}|sk-[a-zA-Z0-9]{20,})/

/** The offending value in a violation message — redacted when its
 *  path or content looks credential-shaped; a literal token in a
 *  mistyped field is exactly the case that must not reach retained
 *  logs. */
const show = (path: string, v: unknown): string =>
  SECRET_PATH.test(path) || (typeof v === 'string' && SECRET_VALUE.test(v))
    ? '[redacted]'
    : describe(v)

function typeMatches(v: unknown, t: string | readonly string[]): boolean {
  return (Array.isArray(t) ? t : [t]).some((k) =>
    k === 'integer'
      ? Number.isInteger(v)
      : k === 'number'
        ? typeof v === 'number' && Number.isFinite(v)
        : jsonTypeOf(v) === k
  )
}

const typeLabel = (t: string | readonly string[]): string =>
  typeof t === 'string' ? t : t.join('|')

const jsonEqual = (a: unknown, b: unknown): boolean => describe(a) === describe(b)

/** Pick the branch whose `type` discriminant names the value's `type`
 *  (providers' kind union) — else the branch with fewest violations.
 *  Reporting all branches' errors is noise; one focused list is what a
 *  human fixes against. */
function bestAltErrors(
  value: unknown,
  variants: readonly JsonSchema[],
  all: SchemaError[][],
  path: string
): SchemaError[] {
  const t = isPlainObject(value) ? value.type : undefined
  if (typeof t === 'string') {
    for (const [i, v] of variants.entries()) {
      // draft-07 allows boolean subschemas — properties.type may carry one
      const d = v.properties?.type as JsonSchema | boolean | undefined
      if (d === undefined || d === true || d === false) {
        continue
      }
      const wants: readonly unknown[] =
        d.const !== undefined ? [d.const] : Array.isArray(d.enum) ? d.enum : []
      if (wants.includes(t)) {
        return all[i]
      }
    }
  }
  let best: SchemaError[] | undefined
  for (const e of all) {
    if (best === undefined || e.length < best.length) {
      best = e
    }
  }
  return best && best.length > 0
    ? best
    : [{ path, message: `does not match any allowed variant — got ${show(path, value)}` }]
}

/** Validate one value against a draft-07 subset schema. Returns the
 *  errors, empty = valid. A wrong `type` reports one error and stops —
 *  descending would only cascade noise. */
export function validateSchemaValue(
  value: unknown,
  schema: JsonSchema | boolean,
  path: string
): SchemaError[] {
  const errors: SchemaError[] = []
  const fail = (message: string): void => {
    errors.push({ path, message })
  }
  if (schema === true) {
    return errors
  }
  if (schema === false || typeof schema !== 'object' || schema === null) {
    fail('is not allowed')
    return errors
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const variants = schema[keyword]
    if (variants === undefined) {
      continue
    }
    const all = variants.map((v) => validateSchemaValue(value, v, path))
    const passed = all.filter((e) => e.length === 0).length
    if ((keyword === 'anyOf' && passed === 0) || (keyword === 'oneOf' && passed !== 1)) {
      errors.push(...bestAltErrors(value, variants, all, path))
    }
  }
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    fail(`must be ${typeLabel(schema.type)} — got ${show(path, value)}`)
    return errors
  }
  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    fail(`must be ${describe(schema.const)} — got ${show(path, value)}`)
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => jsonEqual(e, value))) {
    fail(`must be one of ${schema.enum.map(describe).join('|')} — got ${show(path, value)}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(`must be ≥${schema.minimum} — got ${show(path, value)}`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(`must be ≤${schema.maximum} — got ${show(path, value)}`)
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      fail(`must be >${schema.exclusiveMinimum} — got ${show(path, value)}`)
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      fail(`must be <${schema.exclusiveMaximum} — got ${show(path, value)}`)
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(`must be ≥${schema.minLength} char(s) — got ${show(path, value)}`)
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(`must be ≤${schema.maxLength} char(s) — got ${show(path, value)}`)
    }
    if (schema.pattern !== undefined) {
      // a typo'd pattern in a section schema is a schema defect, not a
      // crash — an invalid regex must not take the whole gate down
      let re: RegExp | undefined
      try {
        re = new RegExp(schema.pattern)
      } catch {
        fail(`schema error: invalid pattern /${safe(schema.pattern)}/`)
      }
      if (re !== undefined && !re.test(value)) {
        fail(`must match /${safe(schema.pattern)}/ — got ${show(path, value)}`)
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`must have ≥${schema.minItems} item(s) — got ${show(path, value)}`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`must have ≤${schema.maxItems} item(s) — got ${show(path, value)}`)
    }
    // tuple-form items are unhandled — single-schema only (the section
    // schemas never declare tuples)
    const items = schema.items
    if (items !== undefined && !Array.isArray(items)) {
      for (const [i, v] of value.entries()) {
        errors.push(...validateSchemaValue(v, items as JsonSchema, `${path}[${i}]`))
      }
    }
  }
  if (isPlainObject(value)) {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      fail(`must have ≥${schema.minProperties} key(s)`)
    }
    for (const k of schema.required ?? []) {
      if (!(k in value)) {
        fail(`requires "${k}"`)
      }
    }
    const declared = schema.properties ?? {}
    const patterns = Object.entries(schema.patternProperties ?? {})
    for (const [k, v] of Object.entries(value)) {
      let matched = false
      if (Object.hasOwn(declared, k)) {
        matched = true
        errors.push(...validateSchemaValue(v, declared[k], `${path}.${safe(k)}`))
      }
      for (const [re, sub] of patterns) {
        let compiled: RegExp
        try {
          compiled = new RegExp(re)
        } catch {
          fail(`schema error: invalid patternProperties key /${safe(re)}/`)
          continue
        }
        if (compiled.test(k)) {
          matched = true
          errors.push(...validateSchemaValue(v, sub, `${path}.${safe(k)}`))
        }
      }
      if (!matched) {
        const ap = schema.additionalProperties
        if (ap === false) {
          fail(`unknown key ${describe(k)}`)
        } else if (typeof ap === 'object') {
          errors.push(...validateSchemaValue(v, ap, `${path}.${safe(k)}`))
        }
      }
    }
  }
  return errors
}

/** `configKey → jsonSchema` over the same merged registry loadConfig
 *  normalizes through — core wins a collision, sections without a
 *  declared schema are uncheckable and skipped. */
export function jsonSchemasFor(
  sections: Record<string, ConfigSection<unknown>> = {}
): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {}
  for (const [key, fn] of Object.entries({ ...sections, ...CORE_SECTIONS })) {
    if (typeof fn === 'function' && fn.jsonSchema !== undefined) {
      out[key] = fn.jsonSchema
    }
  }
  return out
}

/** Top-level scalars that are not plugin sections — validated like
 *  sections and emitted into the document. `store` is the legacy v0.1.0
 *  spelling; `$schema` is the self-reference IDEs write. */
const TOP_LEVEL_JSON_SCHEMAS: Record<string, JsonSchema> = {
  $schema: { type: 'string' },
  stores: { type: 'array', items: { enum: STORE_BACKENDS } },
  store: { enum: STORE_BACKENDS },
  personality: { enum: PERSONALITIES },
  plugins: { type: 'array', items: { type: 'string', minLength: 1, pattern: '\\S' } },
  pack: { type: 'string', minLength: 1, pattern: '\\S' },
}

/** Validate every loaded layer's raw config against the registered
 *  schemas — the diagnostic counterpart of loadConfig, reading through
 *  the SAME loadConfigLayers path so worktree inheritance and layer
 *  precedence are identical. Unknown keys are skipped — the
 *  unknown-key typo check is doctor's job (external plugin configKeys
 *  can't be enumerated statically). */
/** `ConfigDiagnostic.key` value for a file that failed to load at all —
 *  no section key exists to name, and the unreadable file is what the
 *  diagnostic (and the policy gate) must see. */
export const BROKEN_FILE_KEY = '(unreadable)'

/** The layer a broken file belonged to — the basename names it since
 *  each layer's candidate names are distinct. */
function layerOfFile(file: string): ConfigLayerName {
  const name = basename(file)
  for (const layer of ['local', 'project', 'global'] as const) {
    if ((CONFIG_LAYER_FILES[layer] as readonly string[]).includes(name)) {
      return layer
    }
  }
  return 'project'
}

export function configDiagnostics(
  cwd: string = process.cwd(),
  sections: Record<string, ConfigSection<unknown>> = {},
  only?: readonly ConfigLayerName[]
): ConfigDiagnostic[] {
  const { layers, broken } = loadConfigLayers(cwd, only)
  const schemas = { ...TOP_LEVEL_JSON_SCHEMAS, ...jsonSchemasFor(sections) }
  const out: ConfigDiagnostic[] = []
  // The merged view is what loadConfig actually consumes — a `required`
  // field completed by ANOTHER layer is layered composition, not a
  // violation in each layer alone (spec fields compose via deepMerge).
  let merged: Record<string, unknown> = {}
  for (const hit of layers) {
    merged = deepMerge(merged, hit.raw)
  }
  const mergedErrs = new Set<string>()
  for (const [key, v] of Object.entries(merged)) {
    const schema = schemas[key]
    if (schema === undefined) {
      continue
    }
    for (const e of validateSchemaValue(v, schema, key)) {
      mergedErrs.add(`${e.path} ${e.message}`)
    }
  }
  for (const hit of layers) {
    for (const [key, v] of Object.entries(hit.raw)) {
      const schema = schemas[key]
      if (schema === undefined) {
        continue
      }
      // `plugins` is normalized in raw (bad entries filtered out) —
      // validate what the file actually says
      const input = key === 'plugins' && hit.pluginsRaw !== undefined ? hit.pluginsRaw : v
      for (const e of validateSchemaValue(input, schema, key)) {
        // a 'requires' the merged config satisfies is cross-layer
        // completion — every other violation stands on its own layer
        if (
          e.message.startsWith('requires ') &&
          !mergedErrs.has(`${e.path} ${e.message}`)
        ) {
          continue
        }
        out.push({ layer: hit.layer, file: hit.file, key, path: e.path, message: e.message })
      }
    }
  }
  // A file that failed to load contributes nothing to the merged view —
  // silently reporting "all layers validate" for an unparsed file is a
  // false negative the gate can't afford
  for (const file of broken) {
    out.push({
      layer: layerOfFile(file),
      file,
      key: BROKEN_FILE_KEY,
      path: BROKEN_FILE_KEY,
      message: 'config file exists but failed to load — skipped',
    })
  }
  return out
}

/** Diagnostics restricted to *policy* sections — the committed config
 *  everyone shares. Operator sections (providers, fleet, agents, …) are
 *  machine-local by definition: they warn, they never gate a mutation. */
export function configPolicyErrors(
  cwd: string = process.cwd(),
  sections: Record<string, ConfigSection<unknown>> = {}
): ConfigDiagnostic[] {
  return configDiagnostics(cwd, sections).filter((d) =>
    d.key === BROKEN_FILE_KEY
      ? // a broken project/local file could hold invalid policy we
        // can't see — refuse; a broken global file is the user's own
        // and never gates repo work
        d.layer !== 'global'
      : CONFIG_SECTION_LAYERS[d.key] === 'policy'
  )
}

/** Assemble the emitted document — top scalars + every registered
 *  section, keys sorted so `check:config-schema` diffs meaningfully.
 *  `additionalProperties: true` at the root: external plugin configKeys
 *  can't be enumerated statically, and the unknown-key typo check stays
 *  doctor's job. */
export function configSchemaDocument(
  sections: Record<string, ConfigSection<unknown>> = {}
): JsonSchema {
  const properties = { ...TOP_LEVEL_JSON_SCHEMAS, ...jsonSchemasFor(sections) }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: CONFIG_SCHEMA_URL,
    title: 'bro.config',
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))
    ),
    additionalProperties: true,
  }
}
