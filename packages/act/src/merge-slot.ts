/**
 * Merge-slot integration — the task store's `slot('merge')` capability
 * serializes the merge critical section across parallel agent sessions
 * (beads backs it with `bd merge-slot`, one slot bead per rig —
 * `<prefix>-merge-slot`; acquire before `gh pr merge`, release after).
 * Two sessions merging at once are the classic "monkey knife fight" —
 * cascading conflict-resolution races.
 *
 * Everything here is fail-open: a connector without a slot primitive, a
 * missing store, or a wedged backend must never gate a merge — the slot
 * is coordination, not enforcement. JSON shapes (bd ≥1.2):
 *   check   → { available: boolean, holder: string|null, waiters }
 *   acquire → { acquired: boolean, holder: string }
 */
import {
  facade,
  loadConfig,
  parseSlotAcquire,
  parseSlotCheck,
  tasksAsync,
} from '@broject/core'
import type { SlotAcquire, TaskSlot } from '@broject/core'

export type MergeSlot = SlotAcquire

/** `bd merge-slot acquire --json` output → slot outcome. Exported for
 *  tests — the shapes are the contract with bd. */
export const parseAcquire = parseSlotAcquire

/** `bd merge-slot check --json` output → current holder or null. */
export const parseCheck = parseSlotCheck

/** The serving task store's merge slot, or undefined when the backend
 *  has no slot primitive / the store is unreachable — callers treat
 *  that as 'unavailable' and proceed. */
function mergeSlot(dir: string = process.cwd()): TaskSlot | undefined {
  try {
    return facade('tasks', { dir }, { prefer: loadConfig(dir).connectors }).slot?.('merge')
  } catch {
    return undefined
  }
}

/** Try to take the merge slot for this actor (the backend defaults
 *  holder to its actor). `unavailable` means the store has no slot
 *  primitive or isn't usable here — callers proceed. */
export function acquireMergeSlot(dir: string = process.cwd()): MergeSlot {
  return mergeSlot(dir)?.acquire() ?? { kind: 'unavailable' }
}

/** Release the merge slot after a merge attempt. Best-effort — the
 *  store reports a failed release on stderr rather than throwing over
 *  released work. */
export function releaseMergeSlot(dir: string = process.cwd()): void {
  mergeSlot(dir)?.release()
}

/** Current holder for context surfaces (session-start line), or null when
 *  the slot is free / the backend has none. */
export function mergeSlotHolder(dir: string = process.cwd()): string | null {
  return mergeSlot(dir)?.holder() ?? null
}

/** Async twin — the session-start probe runs inside a parallel sweep
 *  where a spawnSync would freeze every sibling's timeout timer. */
export async function mergeSlotHolderAsync(
  dir: string = process.cwd()
): Promise<string | null> {
  try {
    const store = await tasksAsync(dir, loadConfig(dir).connectors)
    return (await store.slotHolder?.('merge')) ?? null
  } catch {
    return null
  }
}
