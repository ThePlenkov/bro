/**
 * `kind = "query"` plans (spec bro-14h8.1) — an ordered list of raw
 * GraphQL steps fanned out over connectors. v1 is read-only: the gate
 * strips comments and string literals, then rejects any word-boundary
 * `mutation`/`subscription` keyword. A field literally named
 * `mutation` is legal GraphQL but still rejected — the safe direction
 * is the documented one; a real parser is a spec revision, not a dep.
 */
import { checkPlanVersion } from '@broject/core'

export const PLAN_KIND = 'query'
export const PLAN_VERSION = 1

const TOP_KEYS = new Set(['kind', 'version', 'concurrency', 'steps'])
const STEP_KEYS = new Set(['id', 'provider', 'graphql', 'vars', 'env'])

/** Env names a plan may never set — `env` is a literal overlay, so
 *  these smuggle control the operator never agreed to:
 *  ATLASSIAN_API_URL redirects an authenticated endpoint; PATH swaps
 *  which binary the connector spawns; HOME repoints gh/glab config
 *  (hosts.yml) at attacker files. Operator config (`query.env`) may
 *  still set them; a committed plan may not. */
const FORBIDDEN_ENV = new Set(['ATLASSIAN_API_URL', 'PATH', 'HOME'])

export interface QueryStep {
  id: string
  /** Data-plane connector name — `providers[]` (the model plane) is a
   *  different registry and never a valid value here. */
  provider?: string
  graphql: string
  vars?: Record<string, unknown>
  env?: Record<string, string>
}

export interface QueryPlan {
  concurrency?: number
  steps: QueryStep[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** Index just past the token starting at `i`, or doc.length when the
 *  token never terminates — a malformed doc scans what remains either
 *  way, and the gate only ever errs toward rejection. */
function skipToken(doc: string, i: number): number {
  if (doc.startsWith('"""', i)) {
    const end = doc.indexOf('"""', i + 3)
    return end === -1 ? doc.length : end + 3
  }
  const ch = doc[i]!
  if (ch === '"') {
    i++
    while (i < doc.length && doc[i] !== '"') {
      i += doc[i] === '\\' ? 2 : 1
    }
    return i + 1 // past the closing quote (or EOF)
  }
  if (ch === '#') {
    const nl = doc.indexOf('\n', i)
    return nl === -1 ? doc.length : nl
  }
  return i
}

/** Strip GraphQL comments (# …) and string literals ("…" plus the
 *  """…""" block form) so the keyword scan sees only operations and
 *  field names. Handles backslash escapes inside short strings. */
export function stripCommentsAndStrings(doc: string): string {
  let out = ''
  let i = 0
  while (i < doc.length) {
    const next = skipToken(doc, i)
    if (next === i) {
      out += doc[i]!
    }
    i = next === i ? i + 1 : next
  }
  return out
}

const WRITE_KEYWORD = /\b(?:mutation|subscription)\b/

/** Read-only gate: true when the document declares neither mutation
 *  nor subscription. Word-boundary after stripping — `commentary`,
 *  `mutationCount`, string contents and `# mutation` comments pass. */
export function isReadOnly(doc: string): boolean {
  return !WRITE_KEYWORD.test(stripCommentsAndStrings(doc))
}

function stepEnv(raw: unknown, at: string, errors: string[]): Record<string, string> | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isRecord(raw)) {
    errors.push(`${at}.env: must be a string→string table ([steps.env])`)
    return undefined
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_ENV.has(k)) {
      errors.push(
        `${at}.env.${k}: execution-shaping var — operator config only, never a plan`
      )
    } else if (typeof v !== 'string') {
      errors.push(`${at}.env.${k}: must be a string — env is a literal overlay`)
    } else {
      env[k] = v
    }
  }
  return env
}

function stepDoc(raw: unknown, at: string, errors: string[]): string {
  if (!nonEmpty(raw)) {
    errors.push(`${at}.graphql: required non-empty string — the raw document`)
    return ''
  }
  if (!isReadOnly(raw)) {
    errors.push(`${at}.graphql: v1 is read-only — mutation/subscription rejected`)
  }
  return raw
}

function stepVars(raw: unknown, at: string, errors: string[]): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isRecord(raw)) {
    errors.push(`${at}.vars: must be a table ([steps.vars])`)
    return undefined
  }
  return raw
}

function parseStep(raw: unknown, i: number, errors: string[]): QueryStep | undefined {
  const at = `steps[${i}]`
  if (!isRecord(raw)) {
    errors.push(`${at}: must be a table ([[steps]])`)
    return undefined
  }
  for (const k of Object.keys(raw)) {
    if (!STEP_KEYS.has(k)) {
      errors.push(`${at}.${k}: unknown key — allowed: ${[...STEP_KEYS].join(', ')}`)
    }
  }
  const step: QueryStep = { id: '', graphql: '' }
  if (!nonEmpty(raw.id)) {
    errors.push(`${at}.id: required non-empty string — it is the output key`)
  } else {
    step.id = raw.id.trim()
  }
  if (raw.provider !== undefined && !nonEmpty(raw.provider)) {
    errors.push(`${at}.provider: must be a non-empty string naming a connector`)
  } else if (typeof raw.provider === 'string') {
    step.provider = raw.provider.trim()
  }
  step.graphql = stepDoc(raw.graphql, at, errors)
  step.vars = stepVars(raw.vars, at, errors)
  step.env = stepEnv(raw.env, at, errors)
  return errors.length > 0 && !nonEmpty(step.id) ? undefined : step
}

/** Validate an already-parsed plan document — the plugin planSchema.
 *  Throws one error listing every problem so the author fixes the
 *  file once instead of iterating on single failures. */
export function parseQueryPlan(doc: unknown, source = 'plan'): QueryPlan {
  const errors: string[] = []
  if (!isRecord(doc)) {
    throw new Error(`${source}: plan must be a TOML table`)
  }
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.has(k)) {
      errors.push(`${k}: unknown key — allowed: ${[...TOP_KEYS].join(', ')}`)
    }
  }
  checkPlanVersion(doc.version, PLAN_KIND, PLAN_VERSION, errors)

  if (doc.concurrency !== undefined) {
    const c = doc.concurrency
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 1) {
      errors.push(`concurrency: must be an integer ≥1 (got ${JSON.stringify(c)})`)
    }
  }

  const rawSteps = doc.steps
  const steps: QueryStep[] = []
  if (rawSteps === undefined) {
    errors.push('steps: required — a query plan with no steps runs nothing')
  } else if (!Array.isArray(rawSteps)) {
    errors.push('steps: must be an array of tables ([[steps]])')
  } else {
    const seen = new Set<string>()
    rawSteps.forEach((raw, i) => {
      const step = parseStep(raw, i, errors)
      if (step && step.id !== '') {
        if (seen.has(step.id)) {
          errors.push(`steps[${i}].id "${step.id}": duplicate — ids are output keys`)
        } else {
          seen.add(step.id)
        }
      }
      if (step && step.id !== '' && nonEmpty(step.graphql)) {
        steps.push(step)
      }
    })
  }

  if (errors.length > 0) {
    throw new Error(`${source}:\n  ${errors.join('\n  ')}`)
  }
  return {
    concurrency: doc.concurrency as number | undefined,
    steps,
  }
}
