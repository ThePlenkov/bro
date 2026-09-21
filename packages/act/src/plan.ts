/**
 * Act thread-verdict plans. The per-thread fix/reject/defer triage as a
 * TOML batch — the agent writes verdicts once, `bro run act.toml`
 * applies them to the PR in one pass.
 *
 *   kind = "act"
 *   pr = 66                    # optional — context for defer beads
 *   [[threads]]
 *   thread_id = "PRRT_..."
 *   action = "defer"           # resolve | reply | defer
 *   comment = "why"            # required for reply; optional elsewhere
 *   title = "bead title"       # required for defer — the debt bead title
 */
export const ACT_ACTIONS = ['resolve', 'reply', 'defer'] as const
export type ActAction = (typeof ACT_ACTIONS)[number]

export interface ActThreadVerdict {
  thread_id: string
  action: ActAction
  comment?: string
  title?: string
}

export interface ActPlan {
  pr?: number
  threads: ActThreadVerdict[]
}

/** The `kind` value an act plan must carry when it has one — lets
 * `bro run <file>` route the plan to this plugin. */
export const PLAN_KIND = 'act'

const THREAD_KEYS = new Set(['thread_id', 'action', 'comment', 'title'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function parseThread(raw: unknown, i: number, errors: string[]): ActThreadVerdict | undefined {
  const where = `threads[${i}]`
  if (!isRecord(raw)) {
    errors.push(`${where}: must be a table`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!THREAD_KEYS.has(key)) {
      errors.push(`${where}: unknown key "${key}"`)
    }
  }
  if (!nonEmpty(raw.thread_id)) {
    errors.push(`${where}: thread_id is required`)
  }
  if (!nonEmpty(raw.action) || !(ACT_ACTIONS as readonly string[]).includes(raw.action)) {
    errors.push(`${where}: action must be one of ${ACT_ACTIONS.join('|')}`)
  }
  if (raw.comment !== undefined && typeof raw.comment !== 'string') {
    errors.push(`${where}: comment must be a string`)
  }
  if (raw.title !== undefined && typeof raw.title !== 'string') {
    errors.push(`${where}: title must be a string`)
  }
  if (raw.action === 'reply' && !nonEmpty(raw.comment)) {
    errors.push(`${where}: reply requires a comment`)
  }
  if (raw.action === 'defer' && !nonEmpty(raw.title)) {
    errors.push(`${where}: defer requires a title — the debt bead's`)
  }
  if (!nonEmpty(raw.thread_id) || !nonEmpty(raw.action)) {
    return undefined
  }
  return {
    thread_id: raw.thread_id.trim(),
    action: raw.action as ActAction,
    comment: typeof raw.comment === 'string' ? raw.comment : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
  }
}

/** Validate an already-parsed plan document — the plugin planSchema.
 *  Throws one error listing every problem. */
export function parseActPlan(doc: unknown, source = 'plan'): ActPlan {
  const errors: string[] = []
  if (!isRecord(doc)) {
    throw new Error(`${source}: expected a TOML table`)
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'threads' && key !== 'kind' && key !== 'pr') {
      errors.push(`unknown top-level key "${key}"`)
    }
  }
  if (doc.kind !== undefined && doc.kind !== PLAN_KIND) {
    errors.push(`kind: expected "${PLAN_KIND}", got ${JSON.stringify(doc.kind)}`)
  }
  if (
    doc.pr !== undefined &&
    (typeof doc.pr !== 'number' || !Number.isInteger(doc.pr) || doc.pr <= 0)
  ) {
    errors.push('pr: must be a positive integer')
  }
  const threads: ActThreadVerdict[] = []
  if (!Array.isArray(doc.threads)) {
    errors.push('threads: must be an array of tables ([[threads]])')
  } else if (doc.threads.length === 0) {
    errors.push('threads: at least one verdict is required')
  } else {
    const seen = new Set<string>()
    doc.threads.forEach((raw, i) => {
      const v = parseThread(raw, i, errors)
      if (!v) {
        return
      }
      if (seen.has(v.thread_id)) {
        errors.push(`threads[${i}]: duplicate thread_id ${JSON.stringify(v.thread_id)}`)
        return
      }
      seen.add(v.thread_id)
      threads.push(v)
    })
  }
  if (errors.length > 0) {
    throw new Error(`${source}:\n  ${errors.join('\n  ')}`)
  }
  return {
    pr: typeof doc.pr === 'number' ? doc.pr : undefined,
    threads,
  }
}
