/**
 * Next plans — the backlog-loop selection as a validated TOML document.
 * `bro run next.toml` computes the queue under the plan's filters and
 * ordering, claims up to `limit` beads (`claim = false` for a dry run),
 * and emits one work order per pick — argv `bro next` is the same
 * execution with plan defaults.
 *
 *   kind = "next"
 *   limit = 3                  # beads to claim — default 1
 *   order = "priority"         # priority | oldest | newest
 *   claim = false              # selection only — nothing is claimed
 *   gates = "allow"            # forbid (default) — HUMAN GATE beads are
 *                              #   surfaced but never claimed; allow puts
 *                              #   them in the queue like any other bead
 *   json = true                # machine-readable result
 *
 *   [filters]
 *   types = ["task", "bug"]    # issue_type allowlist — epics and
 *                              #   molecule steps stay excluded regardless
 *   max_priority = 2           # claim only P0..P2
 *   match = "schema|plan"      # case-insensitive regex over the title
 */
export const NEXT_ORDERS = ['priority', 'oldest', 'newest'] as const
export type NextOrder = (typeof NEXT_ORDERS)[number]

/** Gate policy — same vocabulary as convoy plans: `forbid` (default)
 *  keeps HUMAN GATE beads out of the claimable queue; `allow` is the
 *  pre-authorized verdict — gates become claimable work. */
export const NEXT_GATE_POLICIES = ['forbid', 'allow'] as const
export type NextGatePolicy = (typeof NEXT_GATE_POLICIES)[number]

export interface NextFilters {
  /** issue_type allowlist — applied on top of the built-in exclusions */
  types?: string[]
  /** claim only beads with priority <= this (bd priority 0–4) */
  maxPriority?: number
  /** title regex, already compiled case-insensitive */
  match?: RegExp
}

export interface NextPlan {
  limit: number
  order: NextOrder
  claim: boolean
  gates: NextGatePolicy
  json: boolean
  filters: NextFilters
}

/** The `kind` value a next plan must carry — `bro run` routes on it. */
export const PLAN_KIND = 'next'

const TOP_KEYS = new Set(['kind', 'limit', 'order', 'claim', 'gates', 'json', 'filters'])
const FILTER_KEYS = new Set(['types', 'max_priority', 'match'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

const isPosInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0

function checkFilters(raw: unknown, errors: string[]): void {
  if (raw === undefined) {
    return
  }
  if (!isRecord(raw)) {
    errors.push('filters: must be a table ([filters])')
    return
  }
  for (const key of Object.keys(raw)) {
    if (!FILTER_KEYS.has(key)) {
      errors.push(`filters: unknown key "${key}"`)
    }
  }
  if (raw.types !== undefined) {
    if (
      !Array.isArray(raw.types) ||
      raw.types.length === 0 ||
      raw.types.some((t) => !nonEmpty(t))
    ) {
      errors.push('filters.types: must be a non-empty array of issue types')
    }
  }
  if (
    raw.max_priority !== undefined &&
    (typeof raw.max_priority !== 'number' ||
      !Number.isInteger(raw.max_priority) ||
      raw.max_priority < 0 ||
      raw.max_priority > 4)
  ) {
    errors.push('filters.max_priority: must be an integer 0–4')
  }
  if (raw.match !== undefined) {
    if (!nonEmpty(raw.match)) {
      errors.push('filters.match: must be a non-empty string')
    } else {
      try {
        new RegExp(raw.match, 'i')
      } catch (err) {
        errors.push(
          `filters.match: invalid regex — ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
}

function parseFilters(raw: unknown): NextFilters {
  if (!isRecord(raw)) {
    return {}
  }
  return {
    types: Array.isArray(raw.types)
      ? raw.types.filter((t): t is string => typeof t === 'string').map((t) => t.trim())
      : undefined,
    maxPriority: typeof raw.max_priority === 'number' ? raw.max_priority : undefined,
    match: nonEmpty(raw.match) ? new RegExp(raw.match, 'i') : undefined,
  }
}

/** Validate an already-parsed plan document — the plugin planSchema.
 *  Throws one error listing every problem. */
export function parseNextPlan(doc: unknown, source = 'plan'): NextPlan {
  const errors: string[] = []
  if (!isRecord(doc)) {
    throw new Error(`${source}: expected a TOML table`)
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.has(key)) {
      errors.push(`unknown top-level key "${key}"`)
    }
  }
  if (doc.kind !== undefined && doc.kind !== PLAN_KIND) {
    errors.push(`kind: expected "${PLAN_KIND}", got ${JSON.stringify(doc.kind)}`)
  }
  if (doc.limit !== undefined && !isPosInt(doc.limit)) {
    errors.push('limit: must be a positive integer')
  }
  if (
    doc.order !== undefined &&
    (typeof doc.order !== 'string' || !(NEXT_ORDERS as readonly string[]).includes(doc.order))
  ) {
    errors.push(`order: must be one of ${NEXT_ORDERS.join('|')}`)
  }
  if (
    doc.gates !== undefined &&
    (typeof doc.gates !== 'string' ||
      !(NEXT_GATE_POLICIES as readonly string[]).includes(doc.gates))
  ) {
    errors.push(`gates: must be one of ${NEXT_GATE_POLICIES.join('|')}`)
  }
  for (const f of ['claim', 'json'] as const) {
    if (doc[f] !== undefined && typeof doc[f] !== 'boolean') {
      errors.push(`${f}: must be a boolean`)
    }
  }
  checkFilters(doc.filters, errors)
  if (errors.length > 0) {
    throw new Error(`${source}:\n  ${errors.join('\n  ')}`)
  }
  return {
    limit: typeof doc.limit === 'number' ? doc.limit : 1,
    order: typeof doc.order === 'string' ? (doc.order as NextOrder) : 'priority',
    claim: doc.claim !== false,
    gates: typeof doc.gates === 'string' ? (doc.gates as NextGatePolicy) : 'forbid',
    json: doc.json === true,
    filters: parseFilters(doc.filters),
  }
}
