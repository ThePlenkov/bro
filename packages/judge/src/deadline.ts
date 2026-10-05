/**
 * The shared-deadline seam for judge backends (spec:
 * specs/sessions/bro-f4ot.2-judge.md). `judge.timeoutMs` bounds the
 * WHOLE chained decide() — primary, retries, and escalation included.
 * Backends built in-package accept the run's absolute deadline
 * (epoch ms) via `decideWithin`; a foreign JudgeFacade without it is
 * raced against the same clock.
 */
import { JudgeUnavailable } from '@broject/core'
import type {
  DecideResult,
  JudgeFacade,
  JudgeQuestion,
} from '@broject/core'
import { remaining } from '@broject/providers'

/** Internal deadline seam — backends built by this package accept the
 *  run's absolute deadline (epoch ms) so `judge.timeoutMs` bounds the
 *  whole chained call: primary, retries, and escalation included. A
 *  foreign JudgeFacade without it is raced against the same clock. */
export interface DeadlineJudge extends JudgeFacade {
  decideWithin(
    state: unknown,
    questions: Record<string, JudgeQuestion>,
    deadline: number
  ): Promise<DecideResult>
}

export function isDeadlineJudge(f: JudgeFacade): f is DeadlineJudge {
  return typeof (f as DeadlineJudge).decideWithin === 'function'
}

/** The decide()/decideWithin() pair every in-package backend returns —
 *  `judge.timeoutMs` is the whole-call budget; a spent deadline fails
 *  open before any fetch. */
export function deadlineJudge(
  timeoutMs: number,
  decideWithin: DeadlineJudge['decideWithin']
): DeadlineJudge {
  return {
    decide: (state, questions) =>
      decideWithin(state, questions, Date.now() + timeoutMs),
    decideWithin: (state, questions, deadline) => {
      if (remaining(deadline) <= 0) {
        return Promise.reject(new JudgeUnavailable('judge budget spent'))
      }
      return decideWithin(state, questions, deadline)
    },
  }
}

/** decide() against the shared deadline — native when the backend
 *  speaks decideWithin, raced otherwise (the foreign call may outlive
 *  its welcome in the background; the chain still returns on time). */
export async function callWithin(
  backend: JudgeFacade,
  state: unknown,
  questions: Record<string, JudgeQuestion>,
  deadline: number
): Promise<DecideResult> {
  if (isDeadlineJudge(backend)) {
    return backend.decideWithin(state, questions, deadline)
  }
  const left = deadline - Date.now()
  if (left <= 0) {
    throw new JudgeUnavailable('judge budget spent')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      backend.decide(state, questions),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new JudgeUnavailable('judge backend timed out')),
          left
        )
      }),
    ])
  } finally {
    // an armed timer pinning the process after the race settled is a
    // resource leak, not patience
    clearTimeout(timer)
  }
}
