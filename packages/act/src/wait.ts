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
  /** Consecutive fetch failures tolerated before giving up — one transient
   *  gh/network blip must not kill a long-running watcher. Default 3. */
  maxFetchErrors?: number
  onPoll?: (state: PrActState, gate: ExitGate) => void
  onError?: (err: unknown, consecutive: number) => void
}

/** Still settling: pending CI/reviewers or GitHub computing mergeability.
 *  ciPending counts only *running* checks — a settled red check is a
 *  verdict to act on, not to wait out. Everything else — threads,
 *  failures, BEHIND — is settled too. A merged/closed PR is settled. */
export function gatePending(state: PrActState): boolean {
  return (
    state.state === 'OPEN' &&
    (state.ciPending > 0 || state.reviewersPending > 0 || state.mergeable === 'UNKNOWN')
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitForGate(
  fetch: () => Promise<{ state: PrActState; gate: ExitGate }>,
  opts: WaitOptions = {},
): Promise<GateWaitResult> {
  const intervalMs = opts.intervalMs ?? 60_000
  const maxErrors = opts.maxFetchErrors ?? 3
  const deadline = Date.now() + (opts.timeoutMs ?? 45 * 60_000)
  let polls = 0
  let fetchErrors = 0
  for (;;) {
    let result: { state: PrActState; gate: ExitGate }
    try {
      result = await fetch()
      fetchErrors = 0
    } catch (err) {
      fetchErrors += 1
      opts.onError?.(err, fetchErrors)
      if (fetchErrors >= maxErrors || Date.now() >= deadline) {
        throw err
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
      continue
    }
    polls += 1
    const { state, gate } = result
    opts.onPoll?.(state, gate)
    if (!gatePending(state) || Date.now() >= deadline) {
      return { state, gate, timedOut: gatePending(state), polls }
    }
    // cap the sleep at the deadline — a full-interval nap can overshoot
    // the configured timeout by up to intervalMs
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  }
}
