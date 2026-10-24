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
 *   - it carries more than one comment — the first is the original
 *     finding, the rest are the re-comments that reopened it.
 *
 * A thread that was never resolved has exactly one comment too (the
 * original finding) unless someone replied to it — and a reply to an
 * *open* thread is a discussion, not a reopen. So "more than one
 * comment" alone would misfire.
 *
 * The reliable discriminator is the *resolved* thread's comment count
 * against the host's own re-resolve semantics: a thread that bro
 * resolved and that now carries a comment authored after the resolve
 * is the reopen. bro resolves threads itself, so the resolve is
 * observable in the thread's own history only for hosts that record it
 * (GitHub does not expose a resolve timestamp on the thread).
 *
 * So the detector takes the previous observed state — the act state
 * cache holds exactly that — and compares:
 *
 *   thread was resolved in the previous observation, is unresolved now,
 *   and carries a comment newer than the previous observation.
 *
 * That is the honest signal, and it is fail-open: with no previous
 * observation the detector reports nothing rather than guessing. A
 * reopen that happens between two observations (a poll that missed the
 * resolved window) is not detected — the cost is a missed cycle-guard,
 * never a false block on a healthy PR.
 */
import type { ReviewThread } from '@broject/core'

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
 * Threads that were resolved in `previous` and are open in `current`
 * with a comment newer than the previous observation.
 *
 * `previous` is null when there is no earlier observation — the
 * detector then reports nothing (fail-open).
 */
export function detectReopenedThreads(
  previous: ReviewThread[] | null | undefined,
  current: ReviewThread[]
): ReopenedThread[] {
  if (!previous || previous.length === 0) {
    return []
  }
  const before = new Map(previous.map((t) => [t.id, t]))
  const reopened: ReopenedThread[] = []

  for (const thread of current) {
    const was = before.get(thread.id)
    if (!was || !was.resolved || thread.resolved) {
      // not previously resolved, or still resolved — not a reopen
      continue
    }
    const comments = thread.comments ?? (thread.comment ? [thread.comment] : [])
    if (comments.length === 0) {
      continue
    }
    // The newest comment is the one that reopened it.
    const newest = comments.reduce((a, b) =>
      Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a
    )
    reopened.push({
      id: thread.id,
      author: newest.author,
      reopenedAt: newest.createdAt,
      reason: 'thread was resolved before and is open again',
    })
  }

  return reopened
}
