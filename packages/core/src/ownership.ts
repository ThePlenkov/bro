/**
 * PR ownership marking (spec specs/bro-c650l.md) — two mutually
 * exclusive labels name who lands a PR:
 *
 *   bro-managed — a bro plane (the loop's gate stack, `bro drive`)
 *                 drives the gate to merge
 *   bro-review  — bro opened the PR but a human merges: the
 *                 merge=human/draft contract
 *
 * Absence of both = human-owned. The `<!-- bro: {...} -->` body trailer
 * carries the machine-readable provenance ({managed, bead, mode, run})
 * an attribution read parses later — the same trailer task bodies
 * already use (taskmeta.ts).
 */
import { bodyMeta, withMeta } from './taskmeta.ts'
import type { PrTarget, ReviewFacade } from './review.ts'

export const PR_MANAGED_LABEL = 'bro-managed'
export const PR_REVIEW_LABEL = 'bro-review'

/** Who lands the PR, derived from its labels — 'human' is the absence
 *  of both markers, never a label itself. */
export type PrOwnership = 'managed' | 'review' | 'human'

export function prOwnership(labels: string[]): PrOwnership {
  if (labels.includes(PR_MANAGED_LABEL)) {
    return 'managed'
  }
  if (labels.includes(PR_REVIEW_LABEL)) {
    return 'review'
  }
  return 'human'
}

/** Stamp colors — managed reads "owned by the machine" (green), review
 *  "handed to a human" (yellow). createLabel is idempotent so the
 *  choice only lands on a fresh label. */
const STAMP_COLORS: Record<'managed' | 'review', string> = {
  managed: '0e8a16',
  review: 'fbca04',
}

export interface PrStamp {
  ownership: 'managed' | 'review'
  /** Fields merged into the body's bro trailer — provenance a later
   *  read parses ({managed, bead, mode, run}). Prior keys survive
   *  unless overwritten; a drive adoption keeps the loop's `bead`. */
  meta: Record<string, unknown>
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Stamp the ownership label + provenance trailer on a PR — best-effort
 *  by contract. Each half is independently guarded: a host without
 *  labels skips the label half, a host without body access (no
 *  prBody/updatePrBody) skips the trailer, and a failed write is
 *  reported through `warn`, never thrown — discovery must not die on a
 *  stamp. The two labels are exclusive: stamping one removes the other
 *  (a drive adoption moves the claim off the review marker). */
export function stampPrOwnership(
  rev: ReviewFacade,
  t: PrTarget,
  stamp: PrStamp,
  warn: (msg: string) => void = () => {}
): void {
  const want = stamp.ownership === 'managed' ? PR_MANAGED_LABEL : PR_REVIEW_LABEL
  const drop = stamp.ownership === 'managed' ? PR_REVIEW_LABEL : PR_MANAGED_LABEL
  try {
    const have = rev.labels(t)
    if (!have.includes(want)) {
      rev.createLabel(t.repo, want, STAMP_COLORS[stamp.ownership])
      rev.addLabel(t, want)
    }
    if (have.includes(drop)) {
      rev.removeLabel(t, drop)
    }
  } catch (err) {
    warn(`ownership label on ${rev.prLink(t.repo, t.pr)} failed — ${errText(err)}`)
  }
  if (rev.prBody === undefined || rev.updatePrBody === undefined) {
    return
  }
  try {
    const body = rev.prBody(t)
    const next = withMeta(body, { ...bodyMeta(body), ...stamp.meta })
    if (next !== body) {
      rev.updatePrBody(t, next)
    }
  } catch (err) {
    warn(`provenance trailer on ${rev.prLink(t.repo, t.pr)} failed — ${errText(err)}`)
  }
}
