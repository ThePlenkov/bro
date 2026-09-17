import { bd, bdJson } from '@bro/core'
import type { ConvoyNext, ConvoyStep, Molecule, MolIssue, StepInput, StepKind, StepState } from './types.ts'

/** `bd mol show <id> --json` — the whole DAG in one call. */
export function loadMolecule(id: string): Molecule {
  return bdJson<Molecule>(['mol', 'show', id])
}

/** Open molecule roots — convoy candidates in this workspace. */
export function listMolecules(): MolIssue[] {
  const issues = bdJson<MolIssue[]>(['list', '--type', 'molecule'])
  return issues.filter((i) => i.status !== 'closed' && i.status !== 'done')
}

/**
 * Resolve which molecule a subcommand acts on: an explicit id, or the
 * single open molecule in the workspace. Ambiguity is an error — the
 * caller picks an id, never a silent wrong convoy.
 */
export function resolveMolecule(id?: string): Molecule {
  if (id) return loadMolecule(id)
  const open = listMolecules()
  if (open.length === 0) throw new Error('no open molecule — pour one first: bd mol pour <formula>')
  if (open.length > 1)
    throw new Error(`multiple open molecules — pass an id: ${open.map((m) => m.id).join(', ')}`)
  return loadMolecule(open[0]!.id)
}

/**
 * Step classification. bd flattens unregistered custom types to `task`
 * (unless `bd config set types.custom "agent human"` was run before pour),
 * so kind is: declared type if agent|human, else `gate`/`human`-titled
 * a gate title → human, otherwise agent-executable.
 */
export function stepKind(issue: MolIssue): StepKind {
  const t = issue.issue_type
  if (t === 'agent' || t === 'human') return t
  if (/\b(human\s+gate|gate)\b/i.test(issue.title)) return 'human'
  return 'agent'
}

const CLOSED = new Set(['closed', 'done'])
const CLAIMED = new Set(['in_progress'])

/**
 * Flatten a molecule into ordered steps with scheduling state. Children
 * come in pour order (the issues array); a `blocks` edge
 * `X blocks Y` makes Y wait on X. parent-child edges are structural,
 * not scheduling constraints.
 */
export function stepsOf(mol: Molecule): ConvoyStep[] {
  const closed = new Set(mol.issues.filter((i) => CLOSED.has(i.status)).map((i) => i.id))
  const rootId = mol.root.id
  return mol.issues
    .filter((i) => i.id !== rootId)
    .map((i): ConvoyStep => {
      // bd edge {issue_id: A, depends_on_id: B, type: 'blocks'} = "A
      // depends on B" — A waits for B. My blockers are the depends_on_id
      // side of edges where issue_id is me; the other side is dependents.
      const blockedBy = mol.dependencies
        .filter((d) => d.type === 'blocks' && d.issue_id === i.id && !closed.has(d.depends_on_id))
        .map((d) => d.depends_on_id)
      const state: StepState = CLOSED.has(i.status)
        ? 'done'
        : CLAIMED.has(i.status)
          ? 'in_progress'
          : blockedBy.length > 0
            ? 'blocked'
            : 'ready'
      return {
        id: i.id,
        title: i.title,
        description: i.description ?? '',
        type: i.issue_type,
        kind: stepKind(i),
        state,
        blockedBy,
      }
    })
}

/** What the agent should do next — computed from persisted state only. */
export function nextStep(mol: Molecule): ConvoyNext {
  const steps = stepsOf(mol)
  const ready = steps.filter((s) => s.state === 'ready')
  const blocked = steps.filter((s) => s.state === 'blocked').map((s) => s.id)
  const gates = ready.filter((s) => s.kind === 'human').map((s) => s.id)
  const inProgress = steps.filter((s) => s.state === 'in_progress').map((s) => s.id)
  const base = { mol: mol.root.id, ready, gates, inProgress, blocked }
  if (steps.every((s) => s.state === 'done')) return { ...base, state: 'complete' }
  const step = ready[0]
  if (!step) return { ...base, state: 'blocked' }
  return { ...base, state: step.kind === 'human' ? 'gate' : 'step', step }
}

/**
 * The handoff into a step: its closed direct dependencies, with the
 * `--result` each was closed with (bd stores it as close_reason). One
 * `bd show` per closed blocker — bounded by in-degree, usually 1–2.
 */
export function stepInputs(mol: Molecule, stepId: string): StepInput[] {
  const closed = new Set(mol.issues.filter((i) => CLOSED.has(i.status)).map((i) => i.id))
  return mol.dependencies
    .filter((d) => d.type === 'blocks' && d.issue_id === stepId && closed.has(d.depends_on_id))
    .map((d) => {
      // bd show --json returns a single-element array
      const rows = bdJson<{ title: string; close_reason?: string }[]>(['show', d.depends_on_id])
      const dep = rows[0]
      return { id: d.depends_on_id, title: dep?.title ?? '', reason: dep?.close_reason ?? '' }
    })
}

/**
 * `bro convoy claim` — bd's atomic claim: sets assignee + in_progress,
 * refuses if another actor holds it. Parallel agents coordinate through
 * this — whoever claims first owns the step.
 */
export function claimStep(stepId: string): void {
  bd(['update', stepId, '--claim'])
}

/**
 * `bro convoy pour` — register custom step types once so formulas keep
 * agent/human instead of flattening to task, then pour the formula.
 * Returns the new molecule root id.
 */
export function pourFormula(formula: string, vars: Record<string, string> = {}): string {
  try {
    const current = bd(['config', 'get', 'types.custom']).trim()
    const types = new Set(current ? current.split(/[\s,]+/) : [])
    types.add('agent').add('human')
    bd(['config', 'set', 'types.custom', [...types].join(' ')])
  } catch {
    // old bd without types.custom — gates would flatten to task
  }
  let registered: string[] = []
  try {
    registered = bd(['config', 'get', 'types.custom']).trim().split(/[\s,]+/)
  } catch {
    // fall through — registration unverifiable is a failure too
  }
  if (!registered.includes('agent') || !registered.includes('human')) {
    throw new Error(
      'types.custom could not register agent/human — pouring would flatten declared gates to task. ' +
        'Upgrade bd or register the types manually: bd config set types.custom "agent human"',
    )
  }
  const args = ['mol', 'pour', formula]
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}=${v}`)
  const out = bd(args)
  const m = /Root issue:\s*(\S+)/.exec(out)
  if (!m) throw new Error(`bd mol pour did not report a root issue:\n${out}`)
  return m[1]!
}
