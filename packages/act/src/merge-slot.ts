/**
 * Merge-slot integration — `bd merge-slot` serializes the merge critical
 * section across parallel agent sessions. One slot bead per rig
 * (`<prefix>-merge-slot`); acquire before `gh pr merge`, release after.
 * Two sessions merging at once are the classic "monkey knife fight" —
 * cascading conflict-resolution races.
 *
 * Everything here is fail-open: no bd binary, no `.beads` database, or a
 * wedged dolt must never gate a merge — the slot is coordination, not
 * enforcement. JSON shapes (bd ≥1.2):
 *   check   → { available: boolean, holder: string|null, waiters }
 *   acquire → { acquired: boolean, holder: string }
 */
import { bdTry } from '@bro/core'

export type MergeSlot =
  | { kind: 'acquired' }
  | { kind: 'held'; holder: string }
  | { kind: 'unavailable' }

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** `bd merge-slot acquire --json` output → slot outcome. Exported for
 *  tests — the shapes are the contract with bd. */
export function parseAcquire(out: string): MergeSlot {
  const body = parseJson(out)
  if (body?.acquired === true) {
    return { kind: 'acquired' }
  }
  // a held slot reports acquired:false + the current holder — distinguish
  // real contention from "no beads here" by whether we got JSON at all
  if (body && typeof body.holder === 'string') {
    return { kind: 'held', holder: body.holder }
  }
  return { kind: 'unavailable' }
}

/** `bd merge-slot check --json` output → current holder or null. */
export function parseCheck(out: string): string | null {
  const body = parseJson(out)
  return body && body.available === false && typeof body.holder === 'string'
    ? body.holder
    : null
}

/** Try to take the merge slot for this actor (bd defaults holder to
 *  BEADS_ACTOR/git user.name). Creates the slot bead on first use —
 *  `create` is idempotent, so a missing slot is not a failure path.
 *  `unavailable` means beads isn't usable here — callers proceed. */
export function acquireMergeSlot(): MergeSlot {
  // slot bead may not exist yet in a fresh db — create is idempotent
  bdTry(['merge-slot', 'create'])
  const res = bdTry(['merge-slot', 'acquire', '--json'])
  return parseAcquire(res.out)
}

/** Release the merge slot after a merge attempt. Best-effort — a wedged
 *  bd must not turn a successful merge into a failure. */
export function releaseMergeSlot(): void {
  bdTry(['merge-slot', 'release', '--json'])
}

/** Current holder for context surfaces (session-start line), or null when
 *  the slot is free / beads is absent. */
export function mergeSlotHolder(): string | null {
  // hooks call this inline on every lifecycle event — a wedged dolt must
  // cost ~seconds, not the default 15s budget
  const res = bdTry(['merge-slot', 'check', '--json'], 3_000)
  return res.code === 0 ? parseCheck(res.out) : null
}
