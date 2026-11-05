/**
 * The route chooser — the decision model for the route table.
 *
 * The route table maps a task to a (provider, model) chain; this picks
 * WHICH route fits a task, among the routes the table and the health
 * already left standing. The pattern is `routeClass` (router.ts) turned
 * on the route table: a typed choice over the candidate routes, shadow →
 * enforce, fail-open at the caller, and the verdict always journaled so
 * the stats can score the model against what actually routed.
 *
 * The model picks a ROUTE. It never names a provider: it cannot see the
 * rate limits, and a route whose chain is walled was never a candidate.
 */
import type { DecideResult, JudgeFacade, JudgeQuestion, Verdict } from '@broject/core'
import { appendRow } from './journal.ts'

/** Journal kind — discriminates route verdicts from the fleet's
 * 'route-class' rows. */
export const ROUTE_PICK_KIND = 'route-pick'

const ROUTE_QID = 'route'

/** One candidate route the model may pick. */
export interface RouteOption {
  /** the route's name — the table's key */
  name: string
  /** the criterion — the chain it lands on, plus the route's own prose */
  description: string
}

/** The chooser's options. */
export interface RoutePickOpts {
  /** Working dir — the journal anchors to its git common dir. */
  dir: string
  /** The chained judge — the caller binds it (provider surface + grade
   *  checks live there). */
  judge: JudgeFacade
  /** the candidate routes the table and the health left standing */
  options: RouteOption[]
  /** the judge-visible task state — the text that names the work */
  state: unknown
  /** the subject identity — the call-site dedup key */
  subject: string
  /** the statically resolved route — journaled as the outcome whenever
   *  the pick doesn't win (shadow, enforce with no confident pick). */
  resolved: string
  mode: 'shadow' | 'enforce' | 'off'
}

/** The chooser's one question — a `choice` whose options are exactly the
 * candidate routes. defineProperty per key — a '__proto__' route lands
 * as an own key, same guard as the fleet router's build. */
export function routePickQuestions(options: RouteOption[]): Record<string, JudgeQuestion> {
  const criteria: Record<string, string> = {}
  for (const option of options) {
    Object.defineProperty(criteria, option.name, {
      value: option.description,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return {
    [ROUTE_QID]: {
      type: 'choice',
      instructions:
        'Pick the route this task belongs to. Each route names the chain a request ' +
        'lands on. The health of every model is already settled — the walled ones are ' +
        'not among the options, so never pick a route by guessing a provider.',
      criteria,
    },
  }
}

/** The model's own choice — a confident answer, or nothing. */
function confidentChoice(res: DecideResult): string | undefined {
  const answer = res.answers[ROUTE_QID]
  if (answer?.type !== 'choice') {
    return undefined
  }
  if (res.lowConfidence.includes(ROUTE_QID)) {
    return undefined
  }
  return answer.choice
}

/** The choice, when it names a candidate — the table owns the
 *  candidates, so a name outside the set is "no verdict". */
function candidatePick(options: RouteOption[], choice: string | undefined): string | undefined {
  if (choice === undefined) {
    return undefined
  }
  return options.some(o => o.name === choice) ? choice : undefined
}

/** The outcome the journal records — the model's pick when it wins, the
 *  statically resolved route otherwise. */
function outcomeFor(
  mode: RoutePickOpts['mode'],
  pick: string | undefined,
  resolved: string
): string {
  if (mode !== 'enforce') {
    return resolved
  }
  return pick ?? resolved
}

/** The verdict — what the journal row carries. */
function verdictOf(
  opts: RoutePickOpts,
  questions: Record<string, JudgeQuestion>,
  res: DecideResult,
  outcome: string
): Verdict {
  const cost = res.usage?.costUsd
  return {
    ts: new Date().toISOString(),
    kind: ROUTE_PICK_KIND,
    subject: { threadId: opts.subject },
    questions,
    answers: res.answers,
    model: res.model,
    latencyMs: res.latencyMs,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(res.lowConfidence.length > 0 ? { lowConfidence: res.lowConfidence } : {}),
    outcome,
  }
}

/** One pick — decide over the task, journal the verdict beside the
 * statically resolved route, and return the route the caller may honor.
 *
 *  `shadow` always returns undefined (the verdict is the whole point);
 *  `enforce` returns the choice only when it cleared the confidence
 *  threshold AND names a candidate route. `off` never calls the judge.
 *  A pick that names a route that is not a candidate is "no verdict". */
export async function routePick(opts: RoutePickOpts): Promise<string | undefined> {
  if (opts.mode === 'off') {
    return undefined
  }
  const questions = routePickQuestions(opts.options)
  const res = await opts.judge.decide(opts.state, questions)
  const pick = candidatePick(opts.options, confidentChoice(res))
  const outcome = outcomeFor(opts.mode, pick, opts.resolved)
  appendRow(opts.dir, verdictOf(opts, questions, res, outcome))
  return opts.mode === 'enforce' ? pick : undefined
}
