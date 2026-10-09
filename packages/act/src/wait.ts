/**
 * Gate-wait — the "don't idle-turn on pending CI" pattern as a poll loop
 * instead of a bespoke watcher prompt. `bro act wait` settles when nothing
 * is pending: gate OK, threads/failures to act on, or timeout.
 */
import type { ExitGate, PrActState } from './types.ts'
import { watchBegin, watchEnd, type PendingWatch } from './pending-watch.ts'

export interface GateWaitResult {
  state: PrActState
  gate: ExitGate
  timedOut: boolean
  polls: number
}

/** An external wake source — a subscription distilled to "something
 *  changed, poll early". `next()` resolves on the next relevant event;
 *  a dead or absent source degrades to pure timer polling (spec
 *  specs/bro-huy5o.7.md). */
export interface GateWake {
  next(): Promise<void>
  close(): void
}

export interface WaitOptions {
  intervalMs?: number
  timeoutMs?: number
  /** Armed once before the loop: each interval sleep then races the
   *  timer against `waker.next()`, so a webhook/check event polls early.
   *  A null or throwing arm leaves the loop exactly as it was —
   *  fail-open, polling stays the default. */
  wake?: () => Promise<GateWake | null>
  /** Repo dir + PR identity for the pending-watch marker: while the loop
   *  polls, `<git-common-dir>/bro/watches/<pr>-<pid>-<nonce>.json` proves a watch
   *  was promised; a dead pid at session start is the stale promise the
   *  act connector flags. Omit to wait markerless. */
  watch?: { dir: string } & Omit<PendingWatch, 'pid' | 'startedAt'>
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

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms))

export async function waitForGate(
  fetch: () => Promise<{ state: PrActState; gate: ExitGate }>,
  opts: WaitOptions = {},
): Promise<GateWaitResult> {
  const intervalMs = opts.intervalMs ?? 60_000
  const maxErrors = opts.maxFetchErrors ?? 3
  const deadline = Date.now() + (opts.timeoutMs ?? 45 * 60_000)
  let marker: string | null = null
  if (opts.watch) {
    // strip dir — it selects the marker root, not part of the stored schema
    const { dir, ...w } = opts.watch
    marker = watchBegin(dir, w)
  }
  // arm the wake source before the first fetch — a source that can't
  // arm (broker down, not a repo) is just null and every nap below is
  // the plain timer it always was
  let waker: GateWake | null = null
  try {
    waker = (await opts.wake?.()) ?? null
  } catch {
    waker = null
  }
  // sleep, or wake early on an event — the loser of the race leaves a
  // pending promise that close() or a later event retires harmlessly
  const nap = (ms: number): Promise<void> =>
    waker === null ? sleep(ms) : Promise.race([sleep(ms), waker.next()])
  let polls = 0
  let fetchErrors = 0
  let updatedSha = ''
  try {
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
        await nap(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
        continue
      }
      polls += 1
      const { state, gate } = result
      opts.onPoll?.(state, gate)
      // BEHIND settles the wait, but it isn't a verdict — when it's the
      // ONLY blocker (gate.blockers is just the behind entry) and the
      // branch still merges cleanly, an update pushes a new head and the
      // gate recomputes. The endpoint answers 202 before the head moves:
      // a poll still showing the sha we just updated means "landing",
      // keep waiting rather than settling or re-updating.
      if (
        !gatePending(state) &&
        state.state === 'OPEN' &&
        state.mergeState === 'BEHIND' &&
        opts.updateBranch &&
        Date.now() < deadline
      ) {
        // The update we requested is still landing — keep polling only
        // while BEHIND remains the sole blocker on a mergeable PR; a new
        // settled blocker (fresh thread, failed check) must fall through
        // and settle immediately, not wait out the deadline.
        if (
          state.headSha === updatedSha &&
          state.mergeable === 'MERGEABLE' &&
          gate.blockers.length === 1
        ) {
          await nap(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
          continue
        }
        if (state.mergeable === 'MERGEABLE' && gate.blockers.length === 1) {
          if (await opts.updateBranch(state)) {
            updatedSha = state.headSha
            await nap(Math.min(5_000, Math.max(0, deadline - Date.now())))
            continue
          }
        }
      }
      if (!gatePending(state) || Date.now() >= deadline) {
        return { state, gate, timedOut: gatePending(state), polls }
      }
      // cap the sleep at the deadline — a full-interval nap can overshoot
      // the configured timeout by up to intervalMs
      await nap(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
    }
  } finally {
    waker?.close()
    watchEnd(marker)
  }
}
