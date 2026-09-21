/**
 * Drill plans — a declared descent tree. The agent writes the
 * investigation shape once, `bro run drill.toml` materializes the
 * frames as beads; investigation fills each frame via `drill up`
 * as usual.
 *
 *   kind = "drill"
 *   title = "why does the cache miss"     # root frame
 *
 *   [[steps]]
 *   title = "check the parser"            # child of root
 *
 *   [[steps]]
 *   title = "narrow the repro"
 *   under = 0                             # child of steps[0]
 *   ephemeral = true
 */
export interface DrillStep {
  title: string
  /** index into `steps` — nested under that step; default = root */
  under?: number
  ephemeral?: boolean
  description?: string
  priority?: number
  type?: string
}

export interface DrillPlan {
  title: string
  steps: DrillStep[]
}

/** The `kind` value a drill plan must carry — `bro run` routes on it. */
export const PLAN_KIND = 'drill'

const STEP_KEYS = new Set(['title', 'under', 'ephemeral', 'description', 'priority', 'type'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

const isPosInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0

function parseStep(raw: unknown, i: number, errors: string[]): DrillStep | undefined {
  const where = `steps[${i}]`
  if (!isRecord(raw)) {
    errors.push(`${where}: must be a table`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!STEP_KEYS.has(key)) {
      errors.push(`${where}: unknown key "${key}"`)
    }
  }
  if (!nonEmpty(raw.title)) {
    errors.push(`${where}: title is required`)
    return undefined
  }
  if (raw.under !== undefined && (typeof raw.under !== 'number' || !Number.isInteger(raw.under) || raw.under < 0)) {
    errors.push(`${where}: under must be a non-negative step index`)
  }
  if (raw.ephemeral !== undefined && typeof raw.ephemeral !== 'boolean') {
    errors.push(`${where}: ephemeral must be a boolean`)
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    errors.push(`${where}: description must be a string`)
  }
  if (raw.priority !== undefined && !isPosInt(raw.priority)) {
    errors.push(`${where}: priority must be a positive integer`)
  }
  if (raw.type !== undefined && typeof raw.type !== 'string') {
    errors.push(`${where}: type must be a string`)
  }
  return {
    title: raw.title.trim(),
    under: typeof raw.under === 'number' ? raw.under : undefined,
    ephemeral: raw.ephemeral === true ? true : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    priority: isPosInt(raw.priority) ? raw.priority : undefined,
    type: typeof raw.type === 'string' ? raw.type : undefined,
  }
}

/** Validate an already-parsed plan document — the plugin planSchema.
 *  Throws one error listing every problem. */
export function parseDrillPlan(doc: unknown, source = 'plan'): DrillPlan {
  const errors: string[] = []
  if (!isRecord(doc)) {
    throw new Error(`${source}: expected a TOML table`)
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'steps' && key !== 'kind' && key !== 'title') {
      errors.push(`unknown top-level key "${key}"`)
    }
  }
  if (doc.kind !== undefined && doc.kind !== PLAN_KIND) {
    errors.push(`kind: expected "${PLAN_KIND}", got ${JSON.stringify(doc.kind)}`)
  }
  if (!nonEmpty(doc.title)) {
    errors.push('title: the root frame title is required')
  }
  const steps: DrillStep[] = []
  if (doc.steps !== undefined && !Array.isArray(doc.steps)) {
    errors.push('steps: must be an array of tables ([[steps]])')
  } else if (Array.isArray(doc.steps)) {
    doc.steps.forEach((raw, i) => {
      const s = parseStep(raw, i, errors)
      if (!s) {
        return
      }
      // under must reference an already-declared step — no forward refs,
      // no self-parenting
      if (s.under !== undefined && s.under >= i) {
        errors.push(`steps[${i}]: under must index a previous step`)
      }
      steps.push(s)
    })
  }
  if (errors.length > 0) {
    throw new Error(`${source}:\n  ${errors.join('\n  ')}`)
  }
  return { title: (doc.title as string).trim(), steps }
}
