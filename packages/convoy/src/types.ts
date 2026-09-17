/**
 * Convoy types — a convoy is a beads molecule (a poured formula): a root
 * issue of type `molecule` whose children are workflow steps wired with
 * `blocks` dependency edges. bd owns storage; bro owns scheduling.
 */

export interface MolIssue {
  id: string
  title: string
  description?: string
  status: string
  issue_type: string
  priority?: number
}

export interface MolDep {
  issue_id: string
  depends_on_id: string
  type: string
}

/** Shape of `bd mol show <id> --json`. */
export interface Molecule {
  root: MolIssue
  issues: MolIssue[]
  dependencies: MolDep[]
}

export type StepKind = 'agent' | 'human'

export type StepState = 'done' | 'ready' | 'blocked' | 'in_progress'

export interface ConvoyStep {
  id: string
  title: string
  description: string
  /** declared issue type — agent | human | task (flattened legacy types land here) */
  type: string
  /** how bro treats it: human steps are gates the agent cannot self-serve */
  kind: StepKind
  state: StepState
  /** open issue ids that still block this step */
  blockedBy: string[]
}

export type ConvoyState = 'step' | 'gate' | 'blocked' | 'complete'

/** A closed direct dependency of the current step — its `--result` handoff. */
export interface StepInput {
  id: string
  title: string
  reason: string
}

export interface ConvoyNext {
  mol: string
  state: ConvoyState
  /** every step currently unblocked — independent ones may run in parallel */
  ready: ConvoyStep[]
  /** first ready step in pour order — what `convoy done` should follow */
  step?: ConvoyStep
  /** ready steps that are human gates — always surfaced so none is skipped */
  gates: string[]
  /** steps claimed (in_progress) — visible so parallel agents don't collide */
  inProgress: string[]
  /** closed direct dependencies of `step` with their close reasons — the handoff */
  inputs?: StepInput[]
  /** open steps still waiting on dependencies */
  blocked: string[]
}
