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
  /** Called when the PR is settled but only because it's BEHIND the base
   *  (still mergeable — no conflicts). Return true to keep waiting: the
   *  update pushes a new head and checks re-run. This is the "Update
   *  branch" button wired into the wait loop. */
  updateBranch?: (state: PrActState) => boolean | Promise<boolean>
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
  let updatedSha = ''
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
    // BEHIND settles the wait, but it isn't a verdict — when the branch
    // still merges cleanly, an update just pushes a new head and the
    // gate recomputes. Guard on the sha so a stuck update can't spin.
    if (
      !gatePending(state) &&
      state.state === 'OPEN' &&
      state.mergeState === 'BEHIND' &&
      state.mergeable === 'MERGEABLE' &&
      opts.updateBranch &&
      state.headSha !== updatedSha &&
      Date.now() < deadline
    ) {
      if (await opts.updateBranch(state)) {
        updatedSha = state.headSha
        await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())))
        continue
      }
    }
    if (!gatePending(state) || Date.now() >= deadline) {
      return { state, gate, timedOut: gatePending(state), polls }
    }
    // cap the sleep at the deadline — a full-interval nap can overshoot
    // the configured timeout by up to intervalMs
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  }
}
