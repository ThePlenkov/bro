/**
 * The formula path — the md routing formula decides.
 *
 * `brouter.formula` (or `--formula`) names one md file: the frontmatter
 * is the contract — typed `questions`, hard `filters`, `score` weights —
 * and the body is the prose the decision model reads. Three shapes
 * share the file:
 *
 * - `features` — one `decide()` answers every declared question; the
 *   confident answers become the task's features and the table's
 *   `match` reads them as if the task carried them.
 * - `pick` — today's `routePick`: one choice over the candidates. This
 *   is what the no-formula path already runs, so a pick formula changes
 *   nothing but the prose the model reads.
 * - `score` — `P(success | route, features) − λ·cost − μ·latency` per
 *   surviving candidate (score.ts owns the arithmetic); the outcomes
 *   read model supplies the stats — .4's store plugs into the seam,
 *   the Beta(1,1) prior stands in until it lands.
 *
 * The mode contract is the fleet's own: `off` never asks, `shadow`
 * journals the answers without letting them route, `enforce` trusts
 * them. Filters and scoring are CODE — the model cannot override them,
 * and an unresolved filter input excludes the route rather than waving
 * it through. Fail-open stays the rule for the model's half: no judge,
 * no answers, the formula's inputs stay unresolved and the safe
 * candidates keep the table's order.
 */
import type {
  DecideResult,
  FleetRouter,
  HealthSnapshot,
  JudgeFacade,
  JudgeQuestion,
  Verdict,
} from '@broject/core';
import {
  applyFormulaFilters,
  candidates,
  formulaAnswersToFeatures,
  formulaQuestions,
  inTableOrder,
  mergeTaskFeatures,
  priorOnlyOutcomes,
  resolveRoute,
  scoreCandidates,
} from '@broject/router-routes';
import type {
  FeatureValue,
  Formula,
  FormulaAnswerTrace,
  FormulaTrace,
  OutcomeStatsSource,
  RouteDecision,
  RouteTable,
  RouteTask,
} from '@broject/router-routes';
import { decisionJudge } from './decision-model.ts';

/** The verdict for a formula-decided task — the same shape the table's
 *  own order returns, so the surfaces cannot tell which path answered. */
export interface FormulaTaskDecision {
  /** the resolver's verdict — the route, the chain, the why, the trace */
  decision: RouteDecision;
  /** the health the verdict read — the walls and the sessions */
  snapshot: HealthSnapshot;
  /** false when the ledger could not be read — no wall was applied */
  healthKnown: boolean;
  /** the effective feature map the formula decided with — the caller's
   *  `task.features` merged with the trusted answers under `enforce`
   *  (the task's own map under `shadow`/`off`, and under `pick` where
   *  no questions exist). This is the map `statsFor` buckets by, so the
   *  journal stores it as the decision's feature bucket (spec
   *  bro-0ykhg.7) — absent only on paths that never computed one */
  features?: Record<string, FeatureValue>;
}

/** What the formula path needs — the decision path's own inputs plus
 *  the parsed formula and the two test seams (a ready judge, an outcome
 *  source). */
export interface FormulaDecisionInput {
  /** the working dir — the journal and the config anchor here */
  dir: string;
  /** the table the decision reads */
  table: RouteTable;
  /** the task's shape — caller features merge with the formula's answers */
  task: RouteTask;
  /** the task text the decision model reads */
  text: string;
  /** the decision model — absent means no answers, unresolved inputs */
  router?: FleetRouter;
  /** the parsed formula — the contract plus the prose */
  formula: Formula;
  /** the formula's path — rides the trace so the explanation names it */
  formulaPath?: string;
  /** the health the verdict reads */
  snapshot: HealthSnapshot;
  /** false when the ledger could not be read */
  healthKnown: boolean;
  /** test seam — a ready judge; production binds `decisionJudge` */
  judge?: JudgeFacade;
  /** test seam — the outcomes read model; decideRoute binds the live
   *  store's source for `shape: score` (spec bro-0ykhg.7), the Beta(1,1)
   *  prior stands in when neither is present */
  outcomes?: OutcomeStatsSource;
}

/** The judge the formula asks — the seam's own when a test hands one,
 *  else the decision model bound the one way every route decision binds
 *  it. Config errors (a prose surface under "enforce", a missing
 *  provider) propagate — they are the operator's to fix. */
async function formulaJudge(
  dir: string,
  router: FleetRouter | undefined,
  seam: JudgeFacade | undefined
): Promise<JudgeFacade | undefined> {
  if (seam !== undefined) {
    return seam;
  }
  if (router === undefined) {
    return undefined;
  }
  return decisionJudge(dir, router);
}

/** The state the judge reads — the task text, plus the formula's prose
 *  as the rubric when the file carries one. */
function formulaState(text: string, formula: Formula): unknown {
  return formula.prose === '' ? { task: text } : { task: text, rubric: formula.prose };
}

/** The mode the answers are trusted under — a judge with no router
 *  config is a test seam, and a test's answers are the point: enforce. */
function formulaMode(router: FleetRouter | undefined): 'off' | 'shadow' | 'enforce' {
  return router?.mode ?? 'enforce';
}

/** One note on the trace — answers-not-applied and skipped scoring can
 *  both be true, and the explanation prints both. */
function addNote(trace: FormulaTrace, note: string): void {
  trace.note = trace.note === undefined ? note : `${trace.note}; ${note}`;
}

/** The pick shape — today's routePick over the surviving candidates.
 *  The journal kind stays 'route-pick': the stats read it the same
 *  whether a formula file declared the prose or not. */
async function pickByFormula(input: {
  dir: string;
  table: RouteTable;
  task: RouteTask;
  text: string;
  router?: FleetRouter;
  formula: Formula;
  judge: JudgeFacade;
  snapshot: HealthSnapshot;
  healthKnown: boolean;
  trace: FormulaTrace;
}): Promise<FormulaTaskDecision> {
  const { dir, table, task, text, router, formula, judge, snapshot, healthKnown, trace } = input;
  const { routePick } = await import('@broject/judge');
  const set0 = candidates(table, task, snapshot);
  const { set, fired } = applyFormulaFilters(set0, formula, task);
  trace.filtered = fired;
  const resolved = set.candidates[0]?.route.name ?? '';
  const options = set.candidates.map(c => ({
    name: c.route.name,
    description: c.route.description ?? `chain: ${c.route.chain.map(e => e.provider).join(' → ')}`,
  }));
  let named: string | undefined;
  if (set.candidates.length > 0) {
    try {
      named = await routePick({
        dir,
        judge,
        options,
        state: formulaState(text, formula),
        subject: text.slice(0, 80),
        resolved,
        mode: formulaMode(router),
      });
    } catch (err) {
      console.error(
        `warning: ${router === undefined ? 'the decision model' : `brouter.router.provider "${router.provider}"`} — ` +
          `${err instanceof Error ? err.message : String(err)}; the table's own order stands`
      );
    }
  }
  const decision = resolveRoute(table, task, snapshot, () => named, {
    set,
    formula: trace,
  });
  return { decision, snapshot, healthKnown, features: task.features ?? {} };
}

/** The decide() for the question shapes — one call answers every
 *  declared question. A judge that cannot answer warns and returns
 *  undefined: the formula's inputs stay unresolved, never guessed. */
async function askQuestions(input: {
  router?: FleetRouter;
  judge: JudgeFacade;
  formula: Formula;
  text: string;
}): Promise<{
  res: DecideResult;
  questions: Record<string, JudgeQuestion>;
  features: Record<string, FeatureValue>;
  answers: FormulaAnswerTrace[];
} | null> {
  const { router, judge, formula, text } = input;
  const questions = formulaQuestions(formula);
  let res: DecideResult;
  try {
    res = await judge.decide(formulaState(text, formula), questions);
  } catch (err) {
    console.error(
      `warning: ${router === undefined ? 'the decision model' : `brouter.router.provider "${router.provider}"`} — ` +
        `${err instanceof Error ? err.message : String(err)}; the formula's inputs stay unresolved`
    );
    return null;
  }
  const { features, answers } = formulaAnswersToFeatures(formula, res);
  return { res, questions, features, answers };
}

/** The formula verdict's journal row — kind 'route-formula', the
 *  outcome the route that actually served. Written AFTER the decision
 *  so the outcome is the truth, not the static guess. */
async function journalFormula(input: {
  dir: string;
  subject: string;
  questions: Record<string, JudgeQuestion>;
  res: DecideResult;
  outcome: string;
}): Promise<void> {
  const { appendRow } = await import('@broject/judge');
  const cost = input.res.usage?.costUsd;
  const verdict: Verdict = {
    ts: new Date().toISOString(),
    kind: 'route-formula',
    subject: { threadId: input.subject },
    questions: input.questions,
    answers: input.res.answers,
    model: input.res.model,
    latencyMs: input.res.latencyMs,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(input.res.lowConfidence.length > 0 ? { lowConfidence: input.res.lowConfidence } : {}),
    outcome: input.outcome,
  };
  appendRow(input.dir, verdict);
}

/** The features and score shapes — the judge answers the questions,
 *  the answers (enforce only) become features, the filters cut, and the
 *  shape's own rule picks: `features` keeps the table's order over the
 *  enriched task, `score` ranks by the formula. */
async function decideByQuestions(
  input: FormulaDecisionInput,
  judge: JudgeFacade | undefined,
  trace: FormulaTrace
): Promise<FormulaTaskDecision> {
  const { dir, table, task, text, router, formula, snapshot, healthKnown } = input;
  const mode = formulaMode(router);

  // the judge is asked only when there is one and the mode allows it —
  // 'off' never calls decide(), shadow calls it to journal the opinion
  const asked =
    judge === undefined || mode === 'off'
      ? null
      : await askQuestions({ router, judge, formula, text });

  let effective = task;
  if (asked !== null) {
    trace.answers = asked.answers;
    if (mode === 'enforce') {
      // a caller/answer conflict throws — two sources disagreeing about
      // the task's shape is a bug to fix, never a precedence to pick
      effective = { ...task, features: mergeTaskFeatures(task.features, asked.features) };
    } else {
      addNote(trace, 'shadow — the formula answered but its answers did not route');
    }
  } else {
    addNote(
      trace,
      router === undefined
        ? "no decision model configured — the formula's inputs stay unresolved"
        : mode === 'off'
          ? "the decision model is off — the formula's inputs stay unresolved"
          : "the decision model did not answer — the formula's inputs stay unresolved"
    );
  }

  const set0 = candidates(table, effective, snapshot);
  const { set, fired } = applyFormulaFilters(set0, formula, effective);
  trace.filtered = fired;

  let decision: RouteDecision;
  if (formula.shape === 'features') {
    decision = resolveRoute(table, effective, snapshot, undefined, {
      set,
      formula: trace,
    });
  } else {
    const scoring = scoreCandidates(
      set.candidates,
      formula,
      effective.features ?? {},
      input.outcomes ?? priorOnlyOutcomes,
      table
    );
    trace.scores = scoring.scores;
    if (scoring.skipped !== undefined) {
      addNote(trace, scoring.skipped);
      // scoring never ran — the table's DECLARATION order stands, the
      // same order the score tie-break uses; fit order is candidates()'s
      // ranking, not the fallback the formula contract names
      decision = resolveRoute(table, effective, snapshot, undefined, {
        set: inTableOrder(set, table),
        formula: trace,
        reason: `the table's own order — ${scoring.skipped}`,
      });
    } else if (scoring.winner === undefined) {
      decision = resolveRoute(table, effective, snapshot, undefined, {
        set,
        formula: trace,
      });
    } else {
      const winner = scoring.winner;
      decision = resolveRoute(table, effective, snapshot, () => winner, {
        set,
        picked: 'formula',
        formula: trace,
        reason: `the formula scored ${winner} highest`,
      });
    }
  }

  // the verdict journals AFTER the decision — the outcome is the route
  // that actually served, not the static guess routePick journals with.
  // The journal is observability, never a gate: a write failure warns
  // and the decision stands, the same fail-open the pick path keeps
  if (asked !== null) {
    try {
      await journalFormula({
        dir,
        subject: text.slice(0, 80),
        questions: asked.questions,
        res: asked.res,
        outcome: decision.route?.name ?? '',
      });
    } catch (err) {
      console.error(
        `warning: the route-formula journal — ` +
          `${err instanceof Error ? err.message : String(err)}; the decision stands unrecorded`
      );
    }
  }
  // the effective features ride the verdict — the journal stores them
  // as the outcome stats' feature bucket (spec bro-0ykhg.7)
  return { decision, snapshot, healthKnown, features: effective.features ?? {} };
}

/** The formula path — parse already happened (the caller owns the loud
 *  failure); here the formula decides. */
export async function decideByFormula(input: FormulaDecisionInput): Promise<FormulaTaskDecision> {
  const { dir, table, task, text, router, formula, snapshot, healthKnown } = input;
  // 'off' never resolves the decision model — binding the provider can
  // throw (no lane, no running router) and a mode whose whole point is
  // not asking must not break on a judge it would never call. A test
  // seam still passes through: it costs nothing and keeps the trace honest
  const judge =
    router?.mode === 'off' && input.judge === undefined
      ? undefined
      : await formulaJudge(dir, router, input.judge);
  const trace: FormulaTrace = {
    shape: formula.shape,
    ...(input.formulaPath === undefined ? {} : { file: input.formulaPath }),
    answers: [],
    filtered: [],
  };

  if (formula.shape === 'pick') {
    // a pick formula with no judge still resolves — the table's order
    // stands, exactly the no-judge fail-open the table path keeps
    if (judge === undefined) {
      addNote(trace, "no decision model configured — the table's own order stands");
      const { set, fired } = applyFormulaFilters(candidates(table, task, snapshot), formula, task);
      trace.filtered = fired;
      const decision = resolveRoute(table, task, snapshot, undefined, {
        set,
        formula: trace,
      });
      return { decision, snapshot, healthKnown, features: task.features ?? {} };
    }
    return pickByFormula({
      dir,
      table,
      task,
      text,
      ...(router === undefined ? {} : { router }),
      formula,
      judge,
      snapshot,
      healthKnown,
      trace,
    });
  }
  return decideByQuestions(input, judge, trace);
}
