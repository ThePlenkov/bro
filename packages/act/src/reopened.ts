/**
 * Reopened-thread detection — the act loop's fourth exit-gate condition.
 *
 * The act skill's exit gate lists four hard conditions. Three are
 * programmatic (open threads, CI, reviewers/SAST). The fourth is a
 * cycle-guard: a thread that was resolved and then commented on again
 * must stop the loop — the user confirms, because the earlier resolution
 * was wrong and a blind re-resolve hides that.
 *
 * Both hosts unresolve a thread when a new comment lands on it, so the
 * observable shape of a reopened thread is:
 *
 *   - the thread is unresolved NOW, and
 *   - bro resolved it earlier (the resolve is in the ledger).
 *
 * The second fact comes from the resolve ledger, not from a cache: the
 * act state cache has a 30-second TTL and its entry is deleted when it
 * expires, so a "previous observation" baseline is gone before the next
 * poll arrives. The ledger records the resolve at the moment bro
 * performs it and survives.
 *
 * The ledger is per (repo, pr, thread) — a thread resolved on one PR
 * says nothing about another PR's thread with the same id.
 *
 * Fail-open throughout: no ledger, an unreadable file, or a thread with
 * no resolve recorded reads as "not reopened" — never a crash, never a
 * false block on a healthy PR.
 */
import type { ReviewComment, ReviewThread } from '@broject/core'
import type { ResolveLedger } from './resolve-log.ts'

export interface ReopenedThread {
  id: string
  /** The author of the comment that reopened the thread. */
  author: string
  /** When the reopening comment landed. */
  reopenedAt: string
  /** 'the thread was resolved before and is open again' */
  reason: string
}

/**
 * Threads that are open now but were resolved before — the ledger is the
 * only source of "before".
 *
 * `ledger` may be null: with no ledger there is no history and the
 * detector reports nothing (fail-open).
 */
export function detectReopenedThreads(
  ledger: ResolveLedger | null | undefined,
  repo: string,
  pr: number,
  current: ReviewThread[]
): ReopenedThread[] {
  if (!ledger) {
    return []
  }
  const reopened: ReopenedThread[] = []

  for (const thread of current) {
    if (thread.resolved) {
      // still resolved — not a reopen
      continue
    }
    if (!ledger.wasResolved(repo, pr, thread.id)) {
      // never resolved by bro — an ordinary open thread
      continue
    }
    const newest = newestComment(thread)
    if (newest === null) {
      continue
    }
    reopened.push({
      id: thread.id,
      author: newest.author,
      reopenedAt: newest.createdAt,
      reason: 'thread was resolved before and is open again',
    })
  }

  return reopened
}

/** The newest comment in the thread — the one that reopened it. Null when
 *  the thread carries no comment at all. */
function newestComment(thread: ReviewThread): ReviewComment | null {
  const comments = thread.comments ?? (thread.comment ? [thread.comment] : [])
  if (comments.length === 0) {
    return null
  }
  return comments.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a))
}
