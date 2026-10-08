/**
 * The fleet router (spec: specs/fleet-routing/bro-1x7p.md, milestone 7)
 * — `fleet.router.provider` names a call-surface provider that
 * classifies an UNCLASSED mol step: the step's title/description goes
 * in, a typed `choice` over the declared `fleet.routing` classes comes
 * out. `shadow` journals the verdict beside the resolved class and
 * picks nothing; `enforce` lets a confident pick win. The router
 * never invents a class — the choice criteria ARE the table's keys —
 * and never picks a provider directly: it answers *which lane*, the
 * table still owns the chain.
 *
 * Fail-open like every judge call: `JudgeUnavailable` is "no verdict",
 * never a gate input — the caller keeps the resolved class. The
 * verdict always journals (enforce included) so stats can score the
 * router's agreement with what actually routed.
 */
import type {
  JudgeFacade,
  JudgeQuestion,
  RoutingTable,
  Verdict,
} from '@broject/core'
import { appendRow } from './journal.ts'

/** Journal kind — discriminates route verdicts from 'act-thread' rows;
 *  `outcome` records the class that actually routed (the resolved
 *  class, or the enforced pick). */
export const ROUTE_CLASS_KIND = 'route-class'

const ROUTE_QID = 'class'

/** The router's one question — a `choice` whose options are exactly
 *  the declared classes, each described by the provider chain a spawn
 *  on that lane lands on. defineProperty per key — a '__proto__'
 *  class lands as an own key, same guard as fleetRouting's build. */
export function routeClassQuestions(
  routing: RoutingTable
): Record<string, JudgeQuestion> {
  const criteria: Record<string, string> = {}
  for (const [cls, row] of Object.entries(routing)) {
    const chain = row.chain
      .map((e) => (e.model === undefined ? e.provider : `${e.provider}(${e.model})`))
      .join(' → ')
    Object.defineProperty(criteria, cls, {
      value: `spawn chain: ${chain}`,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return {
    [ROUTE_QID]: {
      type: 'choice',
      instructions:
        'Assign this mol step to a fleet routing class — the lane its work fits best. ' +
        'Each class names a lane; the criterion lists the provider chain a spawn on it lands on.',
      criteria,
    },
  }
}

/** One classification — decide over the step's state, journal the
 *  verdict beside the resolved class, return the pick the caller may
 *  honor. `shadow` always returns undefined (the verdict is the whole
 *  point); `enforce` returns the choice only when it cleared the
 *  chain's confidence threshold AND names a declared class — a dimmed
 *  or off-criteria pick is "no verdict" and the resolved class
 *  stands. */
export async function routeClass(opts: {
  /** Working dir — the journal anchors to its git common dir. */
  dir: string
  /** The chained judge over `fleet.router.provider` — the caller binds
   *  it (provider surface + grade checks live there). */
  judge: JudgeFacade
  molStep: string
  /** The step's judge-visible state — title/description. */
  state: unknown
  routing: RoutingTable
  /** The statically resolved class — journaled as the outcome whenever
   *  the pick doesn't win (shadow, enforce with no confident pick). */
  resolved: string
  mode: 'shadow' | 'enforce'
}): Promise<string | undefined> {
  const questions = routeClassQuestions(opts.routing)
  const res = await opts.judge.decide(opts.state, questions)
  const a = res.answers[ROUTE_QID]
  const confident =
    a?.type === 'choice' && !res.lowConfidence.includes(ROUTE_QID) ? a.choice : undefined
  const pick =
    confident !== undefined && Object.hasOwn(opts.routing, confident) ? confident : undefined
  const outcome = opts.mode === 'enforce' && pick !== undefined ? pick : opts.resolved
  const verdict: Verdict = {
    ts: new Date().toISOString(),
    kind: ROUTE_CLASS_KIND,
    subject: { threadId: opts.molStep },
    questions,
    answers: res.answers,
    model: res.model,
    latencyMs: res.latencyMs,
    ...(res.usage?.costUsd !== undefined ? { costUsd: res.usage.costUsd } : {}),
    ...(res.lowConfidence.length > 0 ? { lowConfidence: res.lowConfidence } : {}),
    outcome,
  }
  appendRow(opts.dir, verdict)
  return opts.mode === 'enforce' ? pick : undefined
}
