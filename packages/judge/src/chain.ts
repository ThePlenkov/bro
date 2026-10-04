/**
 * The judge chain — one decide() over primary + optional fallback
 * (spec: specs/sessions/bro-f4ot.2-judge.md). Primary answers →
 * answers under `judge.confidence` are re-asked on the `judge.fallback`
 * connector → merge (fallback answers keep `decidedBy` honest) →
 * `lowConfidence` lists whatever neither backend answered confidently.
 * Facade-internal: the consumer called one decide().
 */
import { facade, facadeName, loadConfig, JudgeUnavailable } from '@broject/core'
import type {
  ConnectorCtx,
  DecideResult,
  JudgeAnswer,
  JudgeFacade,
  JudgeQuestion,
} from '@broject/core'
import { judgeSection, type JudgeConfig } from './config.ts'
import { remaining } from './http.ts'

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

function isDeadlineJudge(f: JudgeFacade): f is DeadlineJudge {
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
function callWithin(
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
    return Promise.reject(new JudgeUnavailable('judge budget spent'))
  }
  return Promise.race([
    backend.decide(state, questions),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new JudgeUnavailable('judge backend timed out')), left)
    ),
  ])
}

const lowKeys = (answers: Record<string, JudgeAnswer>, threshold: number): string[] =>
  Object.entries(answers)
    .filter(([, a]) => a.confidence < threshold)
    .map(([k]) => k)

/** Sum usage across the chained calls — fields absent on either side
 *  stay absent (never fabricate a cost). */
function mergeUsage(
  a: DecideResult['usage'],
  b: DecideResult['usage']
): DecideResult['usage'] {
  if (a === undefined && b === undefined) {
    return undefined
  }
  const out: { inputTokens?: number; costUsd?: number } = {}
  const tokens = (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0)
  if (tokens > 0) {
    out.inputTokens = tokens
  }
  const cost = (a?.costUsd ?? 0) + (b?.costUsd ?? 0)
  if (cost > 0) {
    out.costUsd = cost
  }
  return out
}

/** Primary → fallback composition. `primary`/`fallback` are already
 *  resolved facades; the chain owns the shared deadline and the
 *  confidence threshold, per spec. */
export function chainedJudge(
  primary: JudgeFacade,
  fallback: JudgeFacade | undefined,
  opts: { confidence: number; timeoutMs: number }
): JudgeFacade {
  return {
    async decide(state, questions) {
      const started = Date.now()
      const deadline = started + opts.timeoutMs
      const res = await callWithin(primary, state, questions, deadline)
      // an asked question with no answer at all is as unconfident as a
      // low one — it escalates and lands in lowConfidence the same way
      const unconfident = (ans: Record<string, JudgeAnswer>): string[] => [
        ...Object.keys(questions).filter((k) => !(k in ans)),
        ...lowKeys(ans, opts.confidence),
      ]
      const low = unconfident(res.answers)
      if (low.length === 0) {
        return { ...res, lowConfidence: [] }
      }
      // no fallback configured, or no budget left to spend on one —
      // low-confidence answers mark the list, they aren't hidden
      if (fallback === undefined || Date.now() >= deadline) {
        return { ...res, lowConfidence: low }
      }
      const retry = Object.fromEntries(low.map((k) => [k, questions[k]!]))
      let esc: DecideResult
      try {
        esc = await callWithin(fallback, state, retry, deadline)
      } catch (err) {
        // unavailability is fail-open; an ordinary error is the
        // caller's bug (validation) — propagate, don't masquerade as
        // "no confident answer"
        if (!(err instanceof JudgeUnavailable)) {
          throw err
        }
        return { ...res, lowConfidence: low }
      }
      const answers = { ...res.answers }
      for (const k of low) {
        const a = esc.answers[k]
        if (a !== undefined) {
          answers[k] = a
        }
      }
      return {
        answers,
        model: res.model,
        latencyMs: Date.now() - started,
        usage: mergeUsage(res.usage, esc.usage),
        lowConfidence: unconfident(answers),
      }
    },
  }
}

/** The normalized judge config + connector preferences for a dir —
 *  loadConfig normalizes the section through the same schema the CLI
 *  registers, so package consumers and the command read identical
 *  values. */
export function judgeConfig(dir: string): {
  judge: JudgeConfig
  connectors: Record<string, string>
} {
  try {
    const cfg = loadConfig(dir, { judge: judgeSection }) as Record<string, unknown>
    return {
      judge: cfg.judge as JudgeConfig,
      connectors: cfg.connectors as Record<string, string>,
    }
  } catch {
    return { judge: judgeSection(undefined), connectors: {} }
  }
}

export interface JudgeFacadeOpts {
  /** Explicit primary connector — wins over connectors.judge config. */
  connector?: string
}

/** Resolve the serving judge facade for `dir`: primary via the standard
 *  precedence (explicit → connectors.judge → registry order), the
 *  `judge.fallback` connector (when configured) resolved by name, and
 *  the chain over both. A fallback naming the primary itself is skipped
 *  (double-asking one backend buys nothing); a name with no `judge`
 *  capability throws — a misconfigured name should be loud, not
 *  silently downgrade to primary-only. */
export function judgeFacade(dir: string, opts: JudgeFacadeOpts = {}): JudgeFacade {
  const { judge: cfg, connectors } = judgeConfig(dir)
  const ctx: ConnectorCtx = { dir }
  const serving = facadeName('judge', ctx, {
    connector: opts.connector,
    prefer: connectors,
  })
  const primary = facade('judge', ctx, { connector: opts.connector, prefer: connectors })
  const fallback =
    cfg.fallback !== undefined && cfg.fallback !== serving
      ? facade('judge', ctx, { connector: cfg.fallback })
      : undefined
  return chainedJudge(primary, fallback, cfg)
}
