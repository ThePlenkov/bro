/**
 * The draft-07 subset validator behind `configDiagnostics` — section
 * schemas declare shapes with the `js` helpers; this module validates
 * raw layer values against them and reports `SchemaError[]` (empty =
 * valid). Kept apart from config-schema.ts: that file owns layer
 * provenance and the emitted document, this one owns value→errors.
 * A wrong `type` reports one error and stops — descending cascades
 * noise. Patterns are cached compile-once; an invalid pattern is a
 * schema defect reported inline, never a crash.
 */
import type { JsonSchema } from './config.ts'

export interface SchemaError {
  path: string
  message: string
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const jsonTypeOf = (v: unknown): string => {
  if (v === null) {
    return 'null'
  }
  return Array.isArray(v) ? 'array' : typeof v
}

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
  return (Array.isArray(t) ? t : [t]).some((k) => {
    if (k === 'integer') {
      return Number.isInteger(v)
    }
    if (k === 'number') {
      return typeof v === 'number' && Number.isFinite(v)
    }
    return jsonTypeOf(v) === k
  })
}

/** Schema `pattern`/`patternProperties` strings are code, not user
 *  input — but a typo'd pattern must report as a schema error, not a
 *  SyntaxError that takes the whole validation chain down. Compiled
 *  once per distinct pattern: schemas are few and hot. */
const patternCache = new Map<string, RegExp | null>()

function compileSchemaPattern(pattern: string): RegExp | null {
  let re = patternCache.get(pattern)
  if (re === undefined) {
    try {
      // schema patterns come from bro's own registered section schemas
      // (code), never from config data — the non-literal sink is inherent
      re = new RegExp(pattern) // nosemgrep
    } catch {
      re = null
    }
    patternCache.set(pattern, re)
  }
  return re
}

const typeLabel = (t: string | readonly string[]): string =>
  typeof t === 'string' ? t : t.join('|')

const typeRejected = (value: unknown, schema: JsonSchema): boolean =>
  schema.type !== undefined && !typeMatches(value, schema.type)

const jsonEqual = (a: unknown, b: unknown): boolean => describe(a) === describe(b)

/** The `type` discriminant a variant branch wants — draft-07 boolean
 *  subschemas and absent `type` constraints carry none. */
function variantDiscriminant(v: JsonSchema | boolean): readonly unknown[] | undefined {
  if (typeof v !== 'object' || v === null) {
    return undefined
  }
  const d = v.properties?.type as JsonSchema | boolean | undefined
  if (d === undefined || typeof d === 'boolean') {
    return undefined
  }
  if (d.const !== undefined) {
    return [d.const]
  }
  return Array.isArray(d.enum) ? d.enum : undefined
}

/** The variant index whose `type` discriminant names the value's own
 *  `type` — undefined when the value isn't an object or no branch
 *  discriminates it. */
function discriminantIndex(value: unknown, variants: readonly JsonSchema[]): number | undefined {
  const t = isPlainObject(value) ? value.type : undefined
  if (typeof t !== 'string') {
    return undefined
  }
  for (const [i, v] of variants.entries()) {
    if (variantDiscriminant(v)?.includes(t) === true) {
      return i
    }
  }
  return undefined
}

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
  const i = discriminantIndex(value, variants)
  if (i !== undefined) {
    return all[i]
  }
  let best: SchemaError[] | undefined
  for (const e of all) {
    if (best === undefined || e.length < best.length) {
      best = e
    }
  }
  return best !== undefined && best.length > 0
    ? best
    : [{ path, message: `does not match any allowed variant — got ${show(path, value)}` }]
}

/** The per-call context every shape validator shares — one bundle
 *  keeps each helper's signature at two arguments. `fail` stamps the
 *  CURRENT path; recursion into properties/items pushes child paths
 *  onto `errors` directly. */
interface VCtx {
  schema: JsonSchema
  path: string
  errors: SchemaError[]
  fail: (message: string) => void
}

/** anyOf needs ≥1 clean variant; oneOf needs exactly one. */
const variantFailed = (keyword: 'anyOf' | 'oneOf', passed: number): boolean =>
  keyword === 'anyOf' ? passed === 0 : passed !== 1

/** anyOf/oneOf — validate every variant, then report the focused
 *  branch's errors (see bestAltErrors), never the union. */
function pushVariantErrors(ctx: VCtx, value: unknown): void {
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const variants = ctx.schema[keyword]
    if (variants === undefined) {
      continue
    }
    const all = variants.map((v) => validateSchemaValue(value, v, ctx.path))
    const passed = all.filter((e) => e.length === 0).length
    if (variantFailed(keyword, passed)) {
      ctx.errors.push(...bestAltErrors(value, variants, all, ctx.path))
    }
  }
}

function pushScalarErrors(ctx: VCtx, value: unknown): void {
  const { schema, path } = ctx
  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    ctx.fail(`must be ${describe(schema.const)} — got ${show(path, value)}`)
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => jsonEqual(e, value))) {
    ctx.fail(`must be one of ${schema.enum.map(describe).join('|')} — got ${show(path, value)}`)
  }
}

/** bound key → violated-when + the operator its message shows. */
const NUMBER_BOUNDS: readonly [
  keyof JsonSchema,
  (value: number, bound: number) => boolean,
  string,
][] = [
  ['minimum', (v, b) => v < b, '≥'],
  ['maximum', (v, b) => v > b, '≤'],
  ['exclusiveMinimum', (v, b) => v <= b, '>'],
  ['exclusiveMaximum', (v, b) => v >= b, '<'],
]

function pushNumberErrors(ctx: VCtx, value: number): void {
  for (const [key, violates, symbol] of NUMBER_BOUNDS) {
    const bound = ctx.schema[key]
    if (typeof bound === 'number' && violates(value, bound)) {
      ctx.fail(`must be ${symbol}${bound} — got ${show(ctx.path, value)}`)
    }
  }
}

function pushStringErrors(ctx: VCtx, value: string): void {
  const { schema, path } = ctx
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    ctx.fail(`must be ≥${schema.minLength} char(s) — got ${show(path, value)}`)
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    ctx.fail(`must be ≤${schema.maxLength} char(s) — got ${show(path, value)}`)
  }
  if (schema.pattern === undefined) {
    return
  }
  const re = compileSchemaPattern(schema.pattern)
  if (re === null) {
    ctx.fail(`schema error: invalid pattern /${safe(schema.pattern)}/`)
  } else if (!re.test(value)) {
    ctx.fail(`must match /${safe(schema.pattern)}/ — got ${show(path, value)}`)
  }
}

function pushArrayErrors(ctx: VCtx, value: unknown[]): void {
  const { schema, path } = ctx
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    ctx.fail(`must have ≥${schema.minItems} item(s) — got ${show(path, value)}`)
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    ctx.fail(`must have ≤${schema.maxItems} item(s) — got ${show(path, value)}`)
  }
  // tuple-form items are unhandled — single-schema only (the section
  // schemas never declare tuples)
  const items = schema.items
  if (items !== undefined && !Array.isArray(items)) {
    for (const [i, v] of value.entries()) {
      ctx.errors.push(...validateSchemaValue(v, items as JsonSchema, `${path}[${i}]`))
    }
  }
}

/** A declared `properties` match — validates and reports at the key's
 *  own path. */
function declaredMatch(ctx: VCtx, k: string, v: unknown): boolean {
  const declared = ctx.schema.properties ?? {}
  if (!Object.hasOwn(declared, k)) {
    return false
  }
  ctx.errors.push(...validateSchemaValue(v, declared[k], `${ctx.path}.${safe(k)}`))
  return true
}

/** `patternProperties` matches — an invalid key reports a schema
 *  error, never a crash. */
function patternMatches(ctx: VCtx, k: string, v: unknown): boolean {
  let matched = false
  for (const [re, sub] of Object.entries(ctx.schema.patternProperties ?? {})) {
    const compiled = compileSchemaPattern(re)
    if (compiled === null) {
      ctx.fail(`schema error: invalid patternProperties key /${safe(re)}/`)
      continue
    }
    if (compiled.test(k)) {
      matched = true
      ctx.errors.push(...validateSchemaValue(v, sub, `${ctx.path}.${safe(k)}`))
    }
  }
  return matched
}

/** One value-key against declared/pattern/additional properties. */
function pushKeyErrors(ctx: VCtx, k: string, v: unknown): void {
  const d = declaredMatch(ctx, k, v)
  const p = patternMatches(ctx, k, v)
  if (d || p) {
    return
  }
  const ap = ctx.schema.additionalProperties
  if (ap === false) {
    ctx.fail(`unknown key ${describe(k)}`)
  } else if (typeof ap === 'object') {
    ctx.errors.push(...validateSchemaValue(v, ap, `${ctx.path}.${safe(k)}`))
  }
}

function pushObjectErrors(ctx: VCtx, value: Record<string, unknown>): void {
  const { schema } = ctx
  if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
    ctx.fail(`must have ≥${schema.minProperties} key(s)`)
  }
  for (const k of schema.required ?? []) {
    if (!(k in value)) {
      ctx.fail(`requires "${k}"`)
    }
  }
  for (const [k, v] of Object.entries(value)) {
    pushKeyErrors(ctx, k, v)
  }
}

/** Validate one value against a draft-07 subset schema. Returns the
 *  errors, empty = valid. A wrong `type` reports one error and stops —
 *  descending would only cascade noise. */
export function validateSchemaValue(
  value: unknown,
  schema: JsonSchema | boolean,
  path: string
): SchemaError[] {
  if (schema === true) {
    return []
  }
  // `false` is already non-object — this also refuses boolean schema
  // literals, non-object junk, and null alike
  if (typeof schema !== 'object' || schema === null) {
    return [{ path, message: 'is not allowed' }]
  }
  const errors: SchemaError[] = []
  const ctx: VCtx = {
    schema,
    path,
    errors,
    fail: (message: string): void => {
      errors.push({ path, message })
    },
  }
  pushVariantErrors(ctx, value)
  if (typeRejected(value, schema)) {
    ctx.fail(`must be ${typeLabel(schema.type ?? '')} — got ${show(path, value)}`)
    return errors
  }
  pushShapeErrors(ctx, value)
  return errors
}

/** Value-shape checks — scalar keywords apply to every shape; the rest
 *  dispatch on the value's actual type. */
function pushShapeErrors(ctx: VCtx, value: unknown): void {
  pushScalarErrors(ctx, value)
  if (typeof value === 'number') {
    pushNumberErrors(ctx, value)
  }
  if (typeof value === 'string') {
    pushStringErrors(ctx, value)
  }
  if (Array.isArray(value)) {
    pushArrayErrors(ctx, value)
  }
  if (isPlainObject(value)) {
    pushObjectErrors(ctx, value)
  }
}
