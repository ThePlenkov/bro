/**
 * Debt triage plans. `bro debt set` verdicts as a TOML batch — the human
 * gate writes verdicts once, `bro run debt.toml` applies them to the
 * ledger deterministically.
 *
 *   kind = "debt"
 *   [[verdicts]]
 *   thread_id = "PRRT_..."
 *   status = "wontfix"     # open|claimed|done|wontfix|duplicate
 *   notes = "why"        # optional
 *   fix_pr = 123         # optional — the PR that landed the fix
 */
import type { DebtStatus } from './types.ts'

export const DEBT_ROW_STATUSES: readonly DebtStatus[] = [
  'open',
  'claimed',
  'done',
  'wontfix',
  'duplicate',
]

export interface DebtVerdict {
  thread_id: string
  status: DebtStatus
  notes?: string
  fix_pr?: number
}

export interface DebtPlan {
  verdicts: DebtVerdict[]
}

/** The `kind` value a debt plan must carry when it has one — lets
 * `bro run <file>` route the plan to this plugin. */
export const PLAN_KIND = 'debt'

const VERDICT_KEYS = new Set(['thread_id', 'status', 'notes', 'fix_pr'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function parseVerdict(raw: unknown, i: number, errors: string[]): DebtVerdict | undefined {
  const where = `verdicts[${i}]`
  if (!isRecord(raw)) {
    errors.push(`${where}: must be a table`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!VERDICT_KEYS.has(key)) {
      errors.push(`${where}: unknown key "${key}"`)
    }
  }
  if (!nonEmpty(raw.thread_id)) {
    errors.push(`${where}: thread_id is required`)
  }
  if (!nonEmpty(raw.status) || !(DEBT_ROW_STATUSES as readonly string[]).includes(raw.status)) {
    errors.push(`${where}: status must be one of ${DEBT_ROW_STATUSES.join('|')}`)
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') {
    errors.push(`${where}: notes must be a string`)
  }
  if (
    raw.fix_pr !== undefined &&
    (typeof raw.fix_pr !== 'number' || !Number.isInteger(raw.fix_pr) || raw.fix_pr <= 0)
  ) {
    errors.push(`${where}: fix_pr must be a positive integer`)
  }
  if (!nonEmpty(raw.thread_id) || !nonEmpty(raw.status)) {
    return undefined
  }
  return {
    thread_id: raw.thread_id.trim(),
    status: raw.status as DebtStatus,
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
    fix_pr: typeof raw.fix_pr === 'number' ? raw.fix_pr : undefined,
  }
}

/** Validate an already-parsed plan document — the plugin planSchema.
 *  Throws one error listing every problem — the agent fixes the file
 *  once instead of iterating on single failures. */
export function parseDebtPlan(doc: unknown, source = 'plan'): DebtPlan {
  const errors: string[] = []
  if (!isRecord(doc)) {
    throw new Error(`${source}: expected a TOML table`)
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'verdicts' && key !== 'kind') {
      errors.push(`unknown top-level key "${key}"`)
    }
  }
  // `bro run` routes on the envelope; a plan claiming a different kind
  // was routed wrong — say so instead of misparsing
  if (doc.kind !== undefined && doc.kind !== PLAN_KIND) {
    errors.push(`kind: expected "${PLAN_KIND}", got ${JSON.stringify(doc.kind)}`)
  }
  const verdicts: DebtVerdict[] = []
  if (!Array.isArray(doc.verdicts)) {
    errors.push('verdicts: must be an array of tables ([[verdicts]])')
  } else if (doc.verdicts.length === 0) {
    errors.push('verdicts: at least one verdict is required')
  } else {
    const seen = new Set<string>()
    doc.verdicts.forEach((raw, i) => {
      const v = parseVerdict(raw, i, errors)
      if (!v) {
        return
      }
      if (seen.has(v.thread_id)) {
        errors.push(`verdicts[${i}]: duplicate thread_id ${JSON.stringify(v.thread_id)}`)
        return
      }
      seen.add(v.thread_id)
      verdicts.push(v)
    })
  }
  if (errors.length > 0) {
    throw new Error(`${source}:\n  ${errors.join('\n  ')}`)
  }
  return { verdicts }
}
