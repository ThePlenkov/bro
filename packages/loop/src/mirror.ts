/**
 * The bead→tracker projection (spec specs/backends/bro-z2z7f). At the
 * PR-armed moment the loop mirrors each bead to a native tracker item
 * through the mirror store's `publish` port, and the caller wires the
 * PR body's auto-close. Beads stays the source of truth — the board
 * is a read-facing materialization, never a sync, so internal churn
 * must not project.
 */
import type { MirrorPolicy, TaskRow, TaskStore } from '@broject/core'

/** Sink labels — coordination artifacts and internal churn that never
 *  project (debt ledger rows, drive fixers, retro/drill records).
 *  `mesh:` joins wholesale: federation envelopes are outward-facing
 *  in their own plane already. */
const SINK_LABELS = new Set(['debt', 'fixer', 'wtf', 'retro', 'drill'])

/** A `spec:` link in free text — mirrors spec-drift.ts's SPEC_LINK;
 *  duplicated because the drift engine's copy lives in cli, not in a
 *  package this one may import. */
const SPEC_LINK = /\bspec:\s*\S+/i

/** The projection decision — what makes a bead board-worthy. An
 *  ephemeral row or a sink label vetoes outright; a configured label
 *  forces; a board type admits; and `specLinked` admits any bead the
 *  specs facade or a `spec:` description link speaks for. A wedged
 *  spec probe falls back to the description link — policy fails open,
 *  never silent. */
export function mirrorable(
  task: TaskRow,
  policy: MirrorPolicy,
  hasSpec: (id: string) => boolean
): boolean {
  if (task.ephemeral === true) {
    return false
  }
  const labels = task.labels ?? []
  if (
    labels.some(
      (l) => SINK_LABELS.has(l) || l.startsWith('mesh:') || policy.excludeLabels.includes(l)
    )
  ) {
    return false
  }
  if (labels.some((l) => policy.labels.includes(l))) {
    return true
  }
  if (task.issue_type !== undefined && policy.types.includes(task.issue_type)) {
    return true
  }
  if (!policy.specLinked) {
    return false
  }
  try {
    return hasSpec(task.id) || SPEC_LINK.test(task.description ?? '')
  } catch {
    return SPEC_LINK.test(task.description ?? '')
  }
}

export interface MirrorDeps {
  /** The source-of-truth store — bead rows and the external_ref
   *  write-back both live here. */
  tasks: TaskStore
  /** The tracker store offering `publish` — undefined short-circuits. */
  mirror?: TaskStore
  /** The specs facade's probe for the policy's specLinked rule. */
  hasSpec: (id: string) => boolean
  policy: MirrorPolicy
  /** Progress line — the loop's `say` channel. */
  say?: (msg: string) => void
}

/** A bead's epic parent, when it has one — a non-epic parent is a
 *  molecule step (never claimed, but checked defensively), and an
 *  unreadable parent is no epic at all. */
function epicOf(tasks: TaskStore, task: TaskRow): TaskRow | undefined {
  if (task.parent === undefined) {
    return undefined
  }
  try {
    const parent = tasks.get(task.parent)
    return parent?.issue_type === 'epic' ? parent : undefined
  } catch {
    return undefined
  }
}

/** The dedup map lands on the source row — ONLY into an empty slot:
 *  a foreign external_ref is another system's projection key (debt
 *  thread, mesh envelope, fixer ref), never ours to clobber. The
 *  `replace` escape is the publish port's verdict alone: it fires only
 *  when the old ref mapped to a missing item on that same store —
 *  overwriting the stale map stops the duplicate-every-pass loop. */
function persistRef(tasks: TaskStore, row: TaskRow, ref: string, replace = false): void {
  if (!replace && (row.external_ref ?? '').trim() !== '') {
    return
  }
  try {
    tasks.update(row.id, { 'external-ref': ref })
  } catch (err) {
    console.error(`mirror: ${row.id} external_ref write-back failed — ${String(err)}`)
  }
}

/** Mirror each bead → tracker item; returns the tracker-native ids to
 *  wire for auto-close. Every bead's stamp is best-effort — one failure
 *  never blocks the rest of the clump, and none of it blocks the PR. */
export function projectBeads(deps: MirrorDeps, beadIds: string[]): string[] {
  if (deps.mirror?.publish === undefined) {
    return []
  }
  const refs: string[] = []
  for (const id of beadIds) {
    try {
      const task = deps.tasks.get(id)
      if (task === undefined || !mirrorable(task, deps.policy, deps.hasSpec)) {
        continue
      }
      const epic = epicOf(deps.tasks, task)
      const res = deps.mirror.publish(task, { epic })
      if (res === undefined) {
        deps.say?.(`${id} projection declined — external_ref maps elsewhere`)
        continue
      }
      persistRef(deps.tasks, task, res.item.external_ref ?? res.item.id, res.replaceExternalRef === true)
      if (epic !== undefined && res.epicRef !== undefined) {
        persistRef(deps.tasks, epic, res.epicRef)
      }
      refs.push(res.item.id)
    } catch (err) {
      console.error(
        `mirror: ${id} projection failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return refs
}
