/**
 * Convoy plans — which molecules to bring into existence and under what
 * gate policy, as one validated document instead of argv. `bro run
 * convoy.toml` materializes the declared molecules; execution then
 * proceeds through `convoy next`/`done` as usual.
 *
 *   kind = "convoy"
 *   gates = "allow"                # plan-wide default gate policy
 *
 *   [[molecules]]                  # pour a registered formula/proto
 *   formula = "debt-pipeline"
 *   gates = "forbid"               # optional per-molecule override
 *   [molecules.vars]
 *   scope = "--last 20"
 *
 *   [[molecules]]                  # ad-hoc molecule — steps inline
 *   title = "ship v0.1"
 *   [[molecules.steps]]
 *   id = "tag"
 *   title = "cut the tag"
 *   type = "agent"                 # "human" declares a gate
 *   needs = ["build"]
 */
import { stepKind } from './molecule.ts'
import type { MolIssue } from './types.ts'

/** Gate policy — how a molecule's human gates are treated at pour time:
 *  `allow` (default) pours gates as declared — they hold the convoy until
 *  a human acts; `forbid` rejects any molecule that would contain a gate —
 *  the plan's contract for unattended execution. */
export const GATE_POLICIES = ['allow', 'forbid'] as const
export type GatePolicy = (typeof GATE_POLICIES)[number]

/** A step declared inline in the plan — the subset of bd's formula Step
 *  that scheduling needs. */
export interface ConvoyStepDecl {
  /** sibling key referenced by `needs` — not the bead id */
  id: string
  title: string
  /** agent | human | any bd type — unregistered types flatten to task
   *  at pour (title heuristics then decide gate-ness) */
  type?: string
  /** ids of sibling steps that must finish first */
  needs?: string[]
  description?: string
  /** bd priority 0–4 */
  priority?: number
}

/** Pour a registered formula/proto — argv `convoy pour` as a table. */
export interface ConvoyPour {
  formula: string
  vars?: Record<string, string>
  gates?: GatePolicy
}

/** A molecule declared inline — materialized through a generated formula
 *  so declared step types survive the pour (`bd create` flattens them). */
export interface ConvoyInline {
  title: string
  description?: string
  steps: ConvoyStepDecl[]
  gates?: GatePolicy
}

export type ConvoyMolecule = ConvoyPour | ConvoyInline

export interface ConvoyPlan {
  /** default gate policy — a molecule's own `gates` wins */
  gates?: GatePolicy
  molecules: ConvoyMolecule[]
}

/** The `kind` value a convoy plan must carry — `bro run` routes on it. */
export const PLAN_KIND = 'convoy'

const TOP_KEYS = new Set(['kind', 'gates', 'molecules'])
const MOL_KEYS = new Set(['formula', 'vars', 'title', 'description', 'steps', 'gates'])
const STEP_KEYS = new Set(['id', 'title', 'type', 'needs', 'description', 'priority'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function gatePolicy(raw: unknown, where: string, errors: string[]): GatePolicy | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string' || !(GATE_POLICIES as readonly string[]).includes(raw)) {
    errors.push(`${where}: gates must be one of ${GATE_POLICIES.join('|')}`)
    return undefined
  }
  return raw as GatePolicy
}

/** A declared step viewed as a molecule issue — the same gate
 *  classification (`stepKind`) that scheduling applies post-pour. */
export const declAsIssue = (s: Pick<ConvoyStepDecl, 'id' | 'title' | 'type'>): MolIssue => ({
  id: s.id,
  title: s.title,
  status: 'open',
  issue_type: s.type ?? 'task',
})

function parseStep(raw: unknown, i: number, where: string, errors: string[]): ConvoyStepDecl | undefined {
  const at = `${where}.steps[${i}]`
  if (!isRecord(raw)) {
    errors.push(`${at}: must be a table`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!STEP_KEYS.has(key)) {
      errors.push(`${at}: unknown key "${key}"`)
    }
  }
  if (!nonEmpty(raw.id)) {
    errors.push(`${at}: id is required — needs[] references it`)
  }
  if (!nonEmpty(raw.title)) {
    errors.push(`${at}: title is required`)
  }
  for (const f of ['type', 'description'] as const) {
    if (raw[f] !== undefined && typeof raw[f] !== 'string') {
      errors.push(`${at}: ${f} must be a string`)
    }
  }
  let needs: string[] | undefined
  if (raw.needs !== undefined) {
    if (!Array.isArray(raw.needs) || !raw.needs.every(nonEmpty)) {
      errors.push(`${at}: needs must be a list of step ids`)
    } else {
      needs = raw.needs.map((n) => n.trim())
    }
  }
  if (
    raw.priority !== undefined &&
    (typeof raw.priority !== 'number' ||
      !Number.isInteger(raw.priority) ||
      raw.priority < 0 ||
      raw.priority > 4)
  ) {
    errors.push(`${at}: priority must be an integer 0-4`)
  }
  if (!nonEmpty(raw.id) || !nonEmpty(raw.title)) {
    return undefined
  }
  return {
    id: raw.id.trim(),
    title: raw.title.trim(),
    type: typeof raw.type === 'string' ? raw.type : undefined,
    needs,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    priority: typeof raw.priority === 'number' ? raw.priority : undefined,
  }
}

/** needs[] edges are a DAG: every ref must be a declared sibling, nothing
 *  may depend on itself, and a cycle would pour a permanently blocked
 *  convoy — all rejected here, before any bead exists. */
function checkStepGraph(steps: ConvoyStepDecl[], where: string, errors: string[]): void {
  const ids = new Map<string, number>()
  steps.forEach((s, i) => {
    if (ids.has(s.id)) {
      errors.push(`${where}.steps[${i}]: duplicate id "${s.id}"`)
    }
    ids.set(s.id, i)
  })
  // self-refs already errored above — exclude them so DFS doesn't
  // double-report the same step as a one-node cycle
  const edges = new Map(steps.map((s) => [s.id, (s.needs ?? []).filter((n) => n !== s.id)]))
  for (const s of steps) {
    for (const n of s.needs ?? []) {
      if (n === s.id) {
        errors.push(`${where}: step "${s.id}" cannot need itself`)
      } else if (!ids.has(n)) {
        errors.push(`${where}: step "${s.id}" needs undeclared step "${n}"`)
      }
    }
  }
  // DFS — white/gray/black; a gray revisit is a cycle
  const color = new Map<string, number>()
  const visit = (id: string, path: string[]): void => {
    const c = color.get(id)
    if (c === 2) return
    if (c === 1) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(' -> ')
      errors.push(`${where}: needs cycle ${cycle}`)
      return
    }
    color.set(id, 1)
    for (const n of edges.get(id) ?? []) {
      if (ids.has(n)) visit(n, [...path, id])
    }
    color.set(id, 2)
  }
  for (const s of steps) visit(s.id, [])
}

function parseMolecule(raw: unknown, i: number, errors: string[]): ConvoyMolecule | undefined {
  const where = `molecules[${i}]`
  if (!isRecord(raw)) {
    errors.push(`${where}: must be a table`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!MOL_KEYS.has(key)) {
      errors.push(`${where}: unknown key "${key}"`)
    }
  }
  const gates = gatePolicy(raw.gates, where, errors)
  const isPour = raw.formula !== undefined
  if (isPour) {
    // a molecule either pours a registered formula or declares steps
    // inline — mixing them is always a mistake
    for (const k of ['title', 'steps', 'description'] as const) {
      if (raw[k] !== undefined) {
        errors.push(`${where}: ${k} only applies to inline molecules`)
      }
    }
    if (!nonEmpty(raw.formula)) {
      errors.push(`${where}: formula is required`)
      return undefined
    }
    if (raw.vars !== undefined && !isRecord(raw.vars)) {
      errors.push(`${where}: vars must be a table ([molecules.vars])`)
    }
    const vars: Record<string, string> = {}
    if (isRecord(raw.vars)) {
      for (const [k, v] of Object.entries(raw.vars)) {
        if (typeof v !== 'string') {
          errors.push(`${where}: vars.${k} must be a string`)
        } else {
          vars[k] = v
        }
      }
    }
    return { formula: raw.formula.trim(), vars, gates }
  }
  if (raw.title === undefined && raw.steps === undefined && raw.description === undefined) {
    errors.push(`${where}: needs either formula = "…" or title + [[molecules.steps]]`)
    return undefined
  }
  if (!nonEmpty(raw.title)) {
    errors.push(`${where}: title is required for an inline molecule`)
  }
  if (raw.vars !== undefined) {
    errors.push(`${where}: vars only apply to formula pours`)
  }
  const steps: ConvoyStepDecl[] = []
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    errors.push(`${where}: an inline molecule needs at least one [[molecules.steps]]`)
  } else {
    raw.steps.forEach((s, j) => {
      const step = parseStep(s, j, where, errors)
      if (step) steps.push(step)
    })
    checkStepGraph(steps, where, errors)
  }
  if (!nonEmpty(raw.title)) {
    return undefined
  }
  return {
    title: raw.title.trim(),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    steps,
    gates,
  }
}

/** Validate an already-parsed plan document — the plugin planSchema.
 *  Throws one error listing every problem. */
export function parseConvoyPlan(doc: unknown, source = 'plan'): ConvoyPlan {
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
  const gates = gatePolicy(doc.gates, 'plan', errors)
  const molecules: ConvoyMolecule[] = []
  if (!Array.isArray(doc.molecules) || doc.molecules.length === 0) {
    errors.push('molecules: at least one [[molecules]] entry is required')
  } else {
    doc.molecules.forEach((raw, i) => {
      const m = parseMolecule(raw, i, errors)
      if (m) molecules.push(m)
    })
  }
  // gates = "forbid" is a parse-time guarantee for inline molecules —
  // formulas are checked pre-pour via `bd formula show`
  molecules.forEach((m, i) => {
    const policy = m.gates ?? gates ?? 'allow'
    if (policy !== 'forbid' || 'formula' in m) return
    for (const s of m.steps) {
      if (stepKind(declAsIssue(s)) === 'human') {
        errors.push(`molecules[${i}]: step "${s.id}" is a human gate but gates = "forbid"`)
      }
    }
  })
  if (errors.length > 0) {
    throw new Error(`${source}:\n  ${errors.join('\n  ')}`)
  }
  return { gates, molecules }
}

/** Transpile an inline molecule into bd's formula document — the pour
 *  machinery (declared types, needs wiring, cook validation) is reused
 *  instead of re-implemented over `bd create`, which flattens custom
 *  step types to task. */
export function inlineFormulaDoc(
  mol: ConvoyInline,
  name: string
): Record<string, unknown> {
  return {
    formula: name,
    description: mol.description ?? mol.title,
    version: 1,
    type: 'workflow',
    steps: mol.steps.map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.type !== undefined && { type: s.type }),
      ...(s.needs !== undefined && s.needs.length > 0 && { needs: s.needs }),
      ...(s.description !== undefined && { description: s.description }),
      ...(s.priority !== undefined && { priority: s.priority }),
    })),
  }
}
