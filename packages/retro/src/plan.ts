/**
 * Retrospection plan files. The agent thinks — what went wrong, why, what
 * prevents recurrence — and writes a TOML plan; `bro retrospect record`
 * validates it and fans it out into beads deterministically.
 */
import { parse } from 'smol-toml'
import { ACTION_SINKS, RETRO_SCOPES } from './types.ts'
import type { ActionSink, RetroAction, RetroPlan, RetroScope } from './types.ts'

const RETRO_KEYS = new Set(['what', 'why', 'scope', 'wtf', 'evidence'])
const ACTION_KEYS = new Set(['title', 'sink', 'scope', 'detail'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function scope(raw: unknown, where: string, errors: string[]): RetroScope | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string' || !(RETRO_SCOPES as readonly string[]).includes(raw)) {
    errors.push(`${where}: scope must be one of ${RETRO_SCOPES.join('|')}`)
    return undefined
  }
  return raw as RetroScope
}

function parseAction(raw: unknown, i: number, errors: string[]): RetroAction | undefined {
  const where = `actions[${i}]`
  if (!isRecord(raw)) {
    errors.push(`${where}: must be a table`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!ACTION_KEYS.has(key)) {
      errors.push(`${where}: unknown key "${key}"`)
    }
  }
  if (!nonEmpty(raw.title)) {
    errors.push(`${where}: title is required`)
  }
  if (!nonEmpty(raw.sink) || !(ACTION_SINKS as readonly string[]).includes(raw.sink)) {
    errors.push(`${where}: sink must be one of ${ACTION_SINKS.join('|')}`)
  }
  if (raw.detail !== undefined && typeof raw.detail !== 'string') {
    errors.push(`${where}: detail must be a string`)
  }
  const actionScope = scope(raw.scope, where, errors)
  if (!nonEmpty(raw.title) || !nonEmpty(raw.sink)) {
    return undefined
  }
  return {
    title: raw.title.trim(),
    sink: raw.sink as ActionSink,
    scope: actionScope,
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
  }
}

/** Parse + validate a plan file. Throws one error listing every problem —
 * the agent fixes the file once instead of iterating on single failures. */
export function parsePlan(text: string, source = 'plan'): RetroPlan {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (err) {
    throw new Error(`${source}: invalid TOML — ${err instanceof Error ? err.message : String(err)}`)
  }

  const errors: string[] = []
  if (isRecord(doc)) {
    // a misspelled `actions`/`retro` key must not silently drop work
    for (const key of Object.keys(doc)) {
      if (key !== 'retro' && key !== 'actions') {
        errors.push(`unknown top-level key "${key}"`)
      }
    }
  }
  const retro = isRecord(doc) ? doc.retro : undefined
  if (!isRecord(retro)) {
    throw new Error(`${source}: [retro] table is required`)
  }
  for (const key of Object.keys(retro)) {
    if (!RETRO_KEYS.has(key)) {
      errors.push(`retro: unknown key "${key}"`)
    }
  }
  if (!nonEmpty(retro.what)) {
    errors.push('retro: what is required — what went wrong')
  }
  if (!nonEmpty(retro.why)) {
    errors.push('retro: why is required — the root cause')
  }
  const retroScope = scope(retro.scope, 'retro', errors) ?? 'project'
  // an empty wtf is the schema template's placeholder — absent, not invalid
  if (retro.wtf !== undefined && typeof retro.wtf !== 'string') {
    errors.push('retro: wtf must be a bead id')
  }
  let evidence: string[] = []
  if (retro.evidence !== undefined) {
    if (!Array.isArray(retro.evidence) || !retro.evidence.every(nonEmpty)) {
      errors.push('retro: evidence must be a list of refs (sha, PR url, bead id)')
    } else {
      evidence = retro.evidence.map((e) => e.trim())
    }
  }

  const rawActions = isRecord(doc) ? (doc.actions ?? []) : []
  const actions: RetroAction[] = []
  if (!Array.isArray(rawActions)) {
    errors.push('actions: must be an array of tables ([[actions]])')
  } else {
    rawActions.forEach((raw, i) => {
      const action = parseAction(raw, i, errors)
      if (action) {
        actions.push(action)
      }
    })
  }

  if (errors.length > 0) {
    throw new Error(`${source}:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  }
  return {
    what: (retro.what as string).trim(),
    why: (retro.why as string).trim(),
    scope: retroScope,
    wtf: nonEmpty(retro.wtf) ? retro.wtf.trim() : undefined,
    evidence,
    actions,
  }
}

/** The commented template `bro retrospect schema` prints — keeps the schema
 * out of skill files so the CLI stays the single source of truth. */
export const PLAN_SCHEMA = `# retrospection plan — written by the agent, executed by \`bro retrospect record\`
#
#   bro retrospect record retro.toml


[retro]
what = ""            # required — what went wrong, one line
why = ""             # required — root cause, not the symptom
scope = "project"    # universal | project | user | agent | session
wtf = ""             # optional — open wtf bead this retro answers (closed on record)
evidence = []        # optional — shas, PR urls, bead ids → bd provenance

# Every action becomes a 'prevention' bead linked discovered-from the retro.
# sink decides where the executor lands it:
#   backlog            tracked follow-up work
#   memory             persist to user or project memory (scope decides)
#   agentic-documents  AGENTS.md / rules / skill update
#   upstream-issue     file an issue in the external repo
#   workaround         code-level fix or guardrail to implement now
#
# [[actions]]
# title = ""
# sink = "backlog"
# scope = "project"    # optional — overrides retro.scope for this action
# detail = ""          # optional — body of the follow-up bead
`
