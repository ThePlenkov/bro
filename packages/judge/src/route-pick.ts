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
import type { DecideResult, JudgeAnswer, JudgeFacade, JudgeQuestion, Verdict } from '@broject/core';
import { appendRow } from './journal.ts';

/** Journal kind — discriminates route verdicts from the fleet's
 * 'route-class' rows. */
export const ROUTE_PICK_KIND = 'route-pick';

const ROUTE_QID = 'route';

/** One candidate route the model may pick. */
export interface RouteOption {
  /** the route's name — the table's key */
  name: string;
  /** the criterion — the chain it lands on, plus the route's own prose */
  description: string;
}

/** The chooser's options. */
export interface RoutePickOpts {
  /** Working dir — the journal anchors to its git common dir. */
  dir: string;
  /** The chained judge — the caller binds it (provider surface + grade
   *  checks live there). */
  judge: JudgeFacade;
  /** the candidate routes the table and the health left standing */
  options: RouteOption[];
  /** the judge-visible task state — the text that names the work */
  state: unknown;
  /** the subject identity — the call-site dedup key */
  subject: string;
  /** the statically resolved route — journaled as the outcome whenever
   *  the pick doesn't win (shadow, enforce with no confident pick). */
  resolved: string;
  mode: 'shadow' | 'enforce' | 'off';
  /** the T3 escalate judge (bro-0ykhg.2) — asked ONLY when the first
   *  judge's answer sits in lowConfidence; its confident answers merge
   *  back before the pick is read. Absent = no escalation. */
  escalate?: JudgeFacade;
}

/** The chooser's one question — a `choice` whose options are exactly the
 * candidate routes. defineProperty per key — a '__proto__' route lands
 * as an own key, same guard as the fleet router's build. */
export function routePickQuestions(options: RouteOption[]): Record<string, JudgeQuestion> {
  const criteria: Record<string, string> = {};
  for (const option of options) {
    Object.defineProperty(criteria, option.name, {
      value: option.description,
      enumerable: true,
      writable: true,
      configurable: true,
    });
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
  };
}

/** The judge's answer for one question — undefined when the judge
 *  answered another question. The answer map is keyed by the judge's own
 *  ids, so the read matches the key instead of indexing with a variable. */
function answerFor(res: DecideResult, qid: string): JudgeAnswer | undefined {
  for (const [id, answer] of Object.entries(res.answers)) {
    if (id === qid) return answer;
  }
  return undefined;
}

/** The model's own choice — a confident answer, or nothing. */
function confidentChoice(res: DecideResult): string | undefined {
  const answer = answerFor(res, ROUTE_QID);
  if (answer?.type !== 'choice') {
    return undefined;
  }
  if (res.lowConfidence.includes(ROUTE_QID)) {
    return undefined;
  }
  return answer.choice;
}

/** The choice, when it names a candidate — the table owns the
 *  candidates, so a name outside the set is "no verdict". */
function candidatePick(options: RouteOption[], choice: string | undefined): string | undefined {
  if (choice === undefined) {
    return undefined;
  }
  return options.some(o => o.name === choice) ? choice : undefined;
}

/** The outcome the journal records — the model's pick when it wins, the
 *  statically resolved route otherwise. */
function outcomeFor(
  mode: RoutePickOpts['mode'],
  pick: string | undefined,
  resolved: string
): string {
  if (mode !== 'enforce') {
    return resolved;
  }
  return pick ?? resolved;
}

/** The verdict — what the journal row carries. */
function verdictOf(
  opts: RoutePickOpts,
  questions: Record<string, JudgeQuestion>,
  res: DecideResult,
  outcome: string
): Verdict {
  const cost = res.usage?.costUsd;
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
  };
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
    return undefined;
  }
  const questions = routePickQuestions(opts.options);
  let res = await opts.judge.decide(opts.state, questions);
  // T3 — the escalate judge re-answers ONLY the keys the first judge
  // left low-confidence; a confident first answer never reaches it, and
  // an escalate failure leaves the first result standing (fail-open)
  if (opts.escalate !== undefined && res.lowConfidence.length > 0) {
    try {
      const esc = await opts.escalate.decide(opts.state, questions);
      const low = new Set(res.lowConfidence);
      const escLow = new Set(esc.lowConfidence);
      const mergedAnswers = { ...res.answers };
      let mergedAny = false;
      for (const [key, answer] of Object.entries(esc.answers)) {
        // the key must have been low-confidence in T2 and confident in
        // T3 — whether or not T2 emitted an answer entry for it: a
        // low-confidence flag with no answer still accepts the
        // escalate verdict, and the lowConfidence filter below clears
        // the flag only when this merge actually landed one
        // (bro-0ykhg.2 review)
        if (!escLow.has(key) && low.has(key)) {
          Object.defineProperty(mergedAnswers, key, {
            value: answer,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          mergedAny = true;
        }
      }
      // the journal bills BOTH calls — T3's tokens and wall-clock are
      // real spend the verdict must carry (bro-0ykhg.2 review). The
      // model names the judge whose answer actually landed: an
      // escalate call that merged nothing keeps the primary's name
      const escCost = esc.usage?.costUsd;
      const baseCost = res.usage?.costUsd;
      const escTokens = esc.usage?.inputTokens;
      const baseTokens = res.usage?.inputTokens;
      const costUsd =
        baseCost === undefined && escCost === undefined
          ? undefined
          : (baseCost ?? 0) + (escCost ?? 0);
      const inputTokens =
        baseTokens === undefined && escTokens === undefined
          ? undefined
          : (baseTokens ?? 0) + (escTokens ?? 0);
      res = {
        ...res,
        answers: mergedAnswers,
        lowConfidence: res.lowConfidence.filter(
          k => escLow.has(k) || !Object.hasOwn(esc.answers, k)
        ),
        model: mergedAny ? (esc.model ?? res.model) : res.model,
        latencyMs: res.latencyMs + esc.latencyMs,
        ...(costUsd === undefined && inputTokens === undefined && res.usage === undefined
          ? {}
          : {
              usage: {
                ...res.usage,
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(costUsd === undefined ? {} : { costUsd }),
              },
            }),
      };
    } catch {
      /* the escalate judge failed — the first answer stands */
    }
  }
  const pick = candidatePick(opts.options, confidentChoice(res));
  const outcome = outcomeFor(opts.mode, pick, opts.resolved);
  appendRow(opts.dir, verdictOf(opts, questions, res, outcome));
  return opts.mode === 'enforce' ? pick : undefined;
}
