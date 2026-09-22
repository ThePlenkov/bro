/**
 * Gate-wait — the "don't idle-turn on pending CI" pattern as a poll loop
 * instead of a bespoke watcher prompt. `bro act wait` settles when nothing
 * is pending: gate OK, threads/failures to act on, or timeout.
 */
import type { ExitGate, PrActState } from './types.ts'

export interface GateWaitResult {
  state: PrActState
  gate: ExitGate
  timedOut: boolean
  polls: number
}

export interface WaitOptions {
  intervalMs?: number
  timeoutMs?: number
  onPoll?: (state: PrActState, gate: ExitGate) => void
}

/** Still settling: pending CI/reviewers or GitHub computing mergeability.
 *  Everything else — threads, failures, BEHIND — is a settled verdict the
 *  caller should act on now, not wait out. A merged/closed PR is settled. */
export function gatePending(state: PrActState): boolean {
  return (
    state.state === 'OPEN' &&
    (state.ciPending > 0 || state.reviewersPending > 0 || state.mergeable === 'UNKNOWN')
  )
}

export async function waitForGate(
  fetch: () => Promise<{ state: PrActState; gate: ExitGate }>,
  opts: WaitOptions = {},
): Promise<GateWaitResult> {
  const intervalMs = opts.intervalMs ?? 60_000
  const deadline = Date.now() + (opts.timeoutMs ?? 45 * 60_000)
  let polls = 0
  for (;;) {
    const { state, gate } = await fetch()
    polls += 1
    opts.onPoll?.(state, gate)
    if (!gatePending(state) || Date.now() >= deadline) {
      return { state, gate, timedOut: gatePending(state), polls }
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
