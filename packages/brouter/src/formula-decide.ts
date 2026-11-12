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
  filterPending,
  formulaAnswersToFeatures,
  formulaQuestions,
  inTableOrder,
  mergeTaskFeatures,
  priorOnlyOutcomes,
  resolveRoute,
  scoreCandidates,
} from '@broject/router-routes';
import type {
  CascadeDecider,
  CascadeStage,
  CascadeTrace,
  FeatureValue,
  Formula,
  FormulaAnswerTrace,
  FormulaTrace,
  OutcomeStatsSource,
  PendingRoute,
  RouteCandidate,
  RouteDecision,
  RouteTable,
  RouteTask,
} from '@broject/router-routes';
import type { RecallOutcomeRow, SuccessPredicate } from '@broject/router-store';
import { decisionJudge } from './decision-model.ts';
import { runT1, shouldInvokeT2, stageRecord, type InvokeMode } from './cascade.ts';
import { recallTuning } from './recall.ts';

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
  /** the table's file path — the recall scope's context fallback,
   *  resolved exactly as the journal resolves it (bro-0ykhg.2) */
  tablePath?: string;
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
  /** the cascade's invoke mode — `brouter.router.invoke`; absent =
   *  'ambiguous' (bro-0ykhg.2). `mode` still owns trust, `invoke` owns
   *  whether the judge is ASKED at all */
  invoke?: 'always' | 'ambiguous' | 'never';
  /** T1 recall tuning — `brouter.router.recall` */
  recall?: { k?: number; minAgreement?: number; minRows?: number };
  /** the T3 provider name — `brouter.router.escalate`; bound lazily and
   *  only when T2's answer sits in lowConfidence */
  escalate?: string;
  /** the formula file's raw bytes — the recall scope's formula hash;
   *  the SAME text the journal snapshots */
  formulaText?: string;
  /** the success predicate recall labels outcomes by — the formula's
   *  own `success`, default merged_first_round */
  successPredicate?: SuccessPredicate;
  /** test seam — pre-fetched recall rows; production reads the store */
  recallRows?: RecallOutcomeRow[];
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

/** The cascade's T0 — candidates over the task's CARRIED fields with
 *  the formula's questions inferable, then the hard filters split three
 *  ways: fired on resolved inputs rejects, unresolved inputs pend the
 *  route (its `needs` name the questions still owed), clear filters
 *  leave the candidate standing. Returns the safe candidates, the
 *  pending routes, and every reject. */
function cascadeT0(input: {
  table: RouteTable;
  task: RouteTask;
  snapshot: HealthSnapshot;
  formula: Formula;
}): {
  set: {
    candidates: RouteCandidate[];
    rejected: { route: RouteCandidate['route']; reason: string }[];
  };
  pending: PendingRoute[];
} {
  const { table, task, snapshot, formula } = input;
  const inferable = new Set(Object.keys(formula.questions));
  const raw = candidates(table, task, snapshot, { inferable });
  const kept: RouteCandidate[] = [];
  const pending: PendingRoute[] = [...(raw.pending ?? [])];
  const rejected: { route: RouteCandidate['route']; reason: string }[] = [...raw.rejected];
  // match-pending routes may also owe filter answers — fold them in;
  // a filter already fired on resolved inputs rejects outright
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const p = pending[i]!;
    const fp = filterPending(formula, p.route.name, task);
    if (fp.fired) {
      rejected.push({
        route: p.route,
        reason: 'hard filter — unless matched on the carried inputs',
      });
      pending.splice(i, 1);
      continue;
    }
    p.needs = [...new Set([...p.needs, ...fp.needs])];
  }
  for (const c of raw.candidates) {
    const fp = filterPending(formula, c.route.name, task);
    if (fp.fired) {
      rejected.push({
        route: c.route,
        reason: 'hard filter — unless matched on the carried inputs',
      });
      continue;
    }
    if (fp.needs.length > 0) {
      pending.push({ route: c.route, score: c.score, reasons: c.reasons, needs: fp.needs });
      continue;
    }
    kept.push(c);
  }
  return { set: { candidates: kept, rejected }, pending };
}

/** The no-T2 fallback — the safe candidates keep their (T1-reordered)
 *  standing; every still-pending route rejects as unresolved, never
 *  dispatched on a guess. */
function unresolvedRejects(
  pending: PendingRoute[],
  rejected: { route: RouteCandidate['route']; reason: string }[]
): { route: RouteCandidate['route']; reason: string }[] {
  const out = [...rejected];
  for (const p of pending) {
    out.push({
      route: p.route,
      reason: `unresolved input(s) ${p.needs.join(', ')} — no formula answer arrived, the route cannot dispatch`,
    });
  }
  return out;
}

/** The cascade's shared prefix — T0 partition, T1 recall, the invoke
 *  gate — run once before any shape's T2. Returns the safe candidates
 *  (T1-reordered), the pending routes, the stage records, and whether
 *  the judge should be asked at all. */
async function cascadePrefix(input: {
  dir: string;
  tablePath?: string;
  table: RouteTable;
  task: RouteTask;
  text: string;
  formula: Formula;
  snapshot: HealthSnapshot;
  invoke: 'always' | 'ambiguous' | 'never';
  recall?: { k?: number; minAgreement?: number; minRows?: number };
  formulaText?: string;
  successPredicate?: SuccessPredicate;
  recallRows?: RecallOutcomeRow[];
}): Promise<{
  candidates: RouteCandidate[];
  pending: PendingRoute[];
  rejected: { route: RouteCandidate['route']; reason: string }[];
  stages: CascadeStage[];
  t1Decided?: string;
  askT2: boolean;
  gateReason: string;
}> {
  const { table, task, snapshot, formula } = input;
  const stages: CascadeStage[] = [];
  const tuning = recallTuning(input.recall);
  const predicate = input.successPredicate ?? formula.success ?? 'merged_first_round';

  // T0 — carried fields only; formula questions inferable
  const t0Start = Date.now();
  const t0 = cascadeT0({ table, task, snapshot, formula });
  const contenderNames = t0.set.candidates.map(c => c.route.name);
  const allNames = [...contenderNames, ...t0.pending.map(p => p.route.name)];
  stages.push(
    stageRecord('T0', allNames, contenderNames, Date.now() - t0Start, {
      note:
        t0.pending.length === 0
          ? `${contenderNames.length} candidate(s) survived rules + health`
          : `${contenderNames.length} candidate(s), ${t0.pending.length} pending on formula answers`,
    })
  );

  // T1 — outcome recall over the resolved candidates
  const t1 = await runT1({
    dir: input.dir,
    table,
    text: input.text,
    contenders: contenderNames,
    tuning,
    predicate,
    ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
    ...(input.formulaText === undefined ? {} : { formulaText: input.formulaText }),
    ...(input.recallRows === undefined ? {} : { rows: input.recallRows }),
  });
  stages.push(t1.stage);

  // reorder the resolved candidates by recall order (stable — unvoted
  // keep their standing at the tail)
  const rank = new Map(t1.order.map((name, i) => [name, i]));
  const reordered = [...t0.set.candidates].sort(
    (a, b) =>
      (rank.get(a.route.name) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.route.name) ?? Number.MAX_SAFE_INTEGER)
  );

  const pendingNeeds = t0.pending.some(p => p.needs.length > 0);
  const gate = shouldInvokeT2({
    invoke: input.invoke,
    candidates: reordered.length,
    pending: t0.pending.length,
    pendingNeeds,
  });
  return {
    candidates: reordered,
    pending: t0.pending,
    rejected: t0.set.rejected,
    stages,
    ...(t1.decided === undefined ? {} : { t1Decided: t1.decided }),
    askT2: gate.ask,
    gateReason: gate.reason,
  };
}

/** The T3 judge for the pick paths — the escalate provider bound the
 *  same way the decision model binds, only when configured. */
async function escalateJudgeFor(
  dir: string,
  router: FleetRouter | undefined,
  provider: string | undefined
): Promise<JudgeFacade | undefined> {
  if (provider === undefined) {
    return undefined;
  }
  // an unresolvable escalate provider must never break the pick — the
  // same fail-open escalateLowConfidence keeps on the question path
  try {
    return await decisionJudge(dir, { provider, mode: router?.mode ?? 'enforce' });
  } catch {
    return undefined;
  }
}

async function pickByFormula(input: {
  dir: string;
  tablePath?: string;
  table: RouteTable;
  task: RouteTask;
  text: string;
  router?: FleetRouter;
  formula: Formula;
  judge: JudgeFacade;
  snapshot: HealthSnapshot;
  healthKnown: boolean;
  trace: FormulaTrace;
  invoke?: InvokeMode;
  recall?: { k?: number; minAgreement?: number; minRows?: number };
  escalate?: string;
  formulaText?: string;
  successPredicate?: SuccessPredicate;
  recallRows?: RecallOutcomeRow[];
}): Promise<FormulaTaskDecision> {
  const {
    dir,
    tablePath,
    table,
    task,
    text,
    router,
    formula,
    judge,
    snapshot,
    healthKnown,
    trace,
  } = input;
  const invoke: InvokeMode = input.invoke ?? 'ambiguous';
  const { routePick } = await import('@broject/judge');

  // the cascade's shared prefix — a pick formula declares no questions,
  // so T0 reduces to rules+health and nothing pends; T1 recall and the
  // invoke gate still run (bro-0ykhg.2)
  const cascade = await cascadePrefix({
    dir,
    table,
    task,
    text,
    formula,
    snapshot,
    invoke,
    ...(tablePath === undefined ? {} : { tablePath }),
    ...(input.recall === undefined ? {} : { recall: input.recall }),
    ...(input.formulaText === undefined ? {} : { formulaText: input.formulaText }),
    ...(input.successPredicate === undefined ? {} : { successPredicate: input.successPredicate }),
    ...(input.recallRows === undefined ? {} : { recallRows: input.recallRows }),
  });
  const stages = [...cascade.stages];

  // T1 decided and no trusted T2 pick can override it — recall settles
  // the route. invoke=always yields ONLY to an enforce-mode judge that
  // can actually route; shadow/off/absent judges leave recall standing
  const t2CanOverride = invoke === 'always' && formulaMode(router) === 'enforce';
  if (cascade.t1Decided !== undefined && !t2CanOverride) {
    stages.push(stageRecord('T2', [], [], 0, { note: 'skipped — outcome recall already decided' }));
    const decision = resolveRoute(table, task, snapshot, () => cascade.t1Decided, {
      set: { candidates: cascade.candidates, rejected: cascade.rejected },
      picked: 'recall',
      formula: trace,
      cascade: { stages, decidedBy: 'recall' },
      reason: `outcome recall picked ${cascade.t1Decided}`,
    });
    return { decision, snapshot, healthKnown, features: task.features ?? {} };
  }

  // the gate — 'never'/single-candidate-ambiguous/mode-off never ask;
  // the safe candidates keep their T1-reordered standing
  const mayAsk = cascade.askT2 && formulaMode(router) !== 'off';
  const set = {
    candidates: cascade.candidates,
    rejected: unresolvedRejects(cascade.pending, cascade.rejected),
  };
  if (!mayAsk) {
    stages.push(
      stageRecord('T2', [], [], 0, {
        note: `${cascade.gateReason}${formulaMode(router) === 'off' ? ' — the decision model is off' : ''}`,
      })
    );
    const decision = resolveRoute(table, task, snapshot, undefined, {
      set,
      formula: trace,
      cascade: { stages, decidedBy: 'rules' },
    });
    return { decision, snapshot, healthKnown, features: task.features ?? {} };
  }

  const t2Start = Date.now();
  const resolved = set.candidates[0]?.route.name ?? '';
  const options = set.candidates.map(c => ({
    name: c.route.name,
    description: c.route.description ?? `chain: ${c.route.chain.map(e => e.provider).join(' → ')}`,
  }));
  // T3 — the escalate judge rides routePick; it answers only when T2's
  // pick sits in lowConfidence (bro-0ykhg.2)
  const escalate = await escalateJudgeFor(dir, router, input.escalate);
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
        ...(escalate === undefined ? {} : { escalate }),
      });
    } catch (err) {
      console.error(
        `warning: ${router === undefined ? 'the decision model' : `brouter.router.provider "${router.provider}"`} — ` +
          `${err instanceof Error ? err.message : String(err)}; the table's own order stands`
      );
    }
  }
  stages.push(
    stageRecord(
      'T2',
      cascade.candidates.map(c => c.route.name),
      set.candidates.map(c => c.route.name),
      Date.now() - t2Start,
      {
        note:
          named === undefined
            ? 'the judge named no confident candidate'
            : `the judge picked ${named}`,
      }
    )
  );
  const trusted = formulaMode(router) === 'enforce' && named !== undefined;
  const decision = resolveRoute(table, task, snapshot, () => named, {
    set,
    formula: trace,
    cascade: { stages, decidedBy: trusted ? 'judge' : 'rules' },
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

/** T3 — re-ask only the low-confidence keys on the escalate provider
 *  and merge the confident answers back, the same merge the judge
 *  chain keeps. Returns the merged ask, or null when the escalate
 *  provider could not answer (T2's result stands). */
async function escalateLowConfidence(input: {
  dir: string;
  router?: FleetRouter;
  provider: string;
  judge: JudgeFacade;
  formula: Formula;
  text: string;
  asked: NonNullable<Awaited<ReturnType<typeof askQuestions>>>;
}): Promise<NonNullable<Awaited<ReturnType<typeof askQuestions>>> | null> {
  const { dir, router, provider, formula, text, asked } = input;
  try {
    const escJudge = await decisionJudge(dir, {
      provider,
      mode: router?.mode ?? 'enforce',
    });
    const questions = formulaQuestions(formula);
    const retry: Record<string, JudgeQuestion> = {};
    for (const key of asked.res.lowConfidence) {
      const q = questions[key];
      if (q !== undefined) {
        Object.defineProperty(retry, key, {
          value: q,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    if (Object.keys(retry).length === 0) {
      return null;
    }
    const res = await escJudge.decide(formulaState(text, formula), retry);
    // merge: confident escalate answers replace low-confidence T2 ones
    const mergedAnswers = { ...asked.res.answers };
    const mergedLow = new Set(res.lowConfidence);
    for (const [key, answer] of Object.entries(res.answers)) {
      if (!mergedLow.has(key) && Object.hasOwn(mergedAnswers, key)) {
        Object.defineProperty(mergedAnswers, key, {
          value: answer,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    const mergedRes: DecideResult = {
      ...asked.res,
      answers: mergedAnswers,
      lowConfidence: asked.res.lowConfidence.filter(
        k => mergedLow.has(k) || !Object.hasOwn(res.answers, k)
      ),
      model: res.model ?? asked.res.model,
    };
    const { features, answers } = formulaAnswersToFeatures(formula, mergedRes);
    return { res: mergedRes, questions: asked.questions, features, answers };
  } catch {
    return null;
  }
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
  const invoke: InvokeMode = input.invoke ?? 'ambiguous';

  // the cascade's shared prefix — T0 partition, T1 recall, the gate
  const cascade = await cascadePrefix({
    dir,
    table,
    task,
    text,
    formula,
    snapshot,
    invoke,
    ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
    ...(input.recall === undefined ? {} : { recall: input.recall }),
    ...(input.formulaText === undefined ? {} : { formulaText: input.formulaText }),
    ...(input.successPredicate === undefined ? {} : { successPredicate: input.successPredicate }),
    ...(input.recallRows === undefined ? {} : { recallRows: input.recallRows }),
  });
  const stages = [...cascade.stages];
  let decidedBy: CascadeDecider | undefined;

  // T1 decided and no trusted T2 pick can override it — recall settles
  // the route; pending routes reject unresolved (no formula answer ever
  // arrived). invoke=always yields ONLY to an enforce-mode judge that
  // is actually bound — shadow/off/absent judges leave recall standing
  const t2CanOverride = invoke === 'always' && judge !== undefined && mode === 'enforce';
  if (cascade.t1Decided !== undefined && !t2CanOverride) {
    decidedBy = 'recall';
    stages.push(stageRecord('T2', [], [], 0, { note: 'skipped — outcome recall already decided' }));
    const set = {
      candidates: cascade.candidates,
      rejected: unresolvedRejects(cascade.pending, cascade.rejected),
    };
    const decision = resolveRoute(table, task, snapshot, () => cascade.t1Decided, {
      set,
      picked: 'recall',
      formula: trace,
      cascade: { stages, decidedBy },
      reason: `outcome recall picked ${cascade.t1Decided}`,
    });
    return { decision, snapshot, healthKnown, features: task.features ?? {} };
  }

  // the judge is asked only when the gate says so, one is configured,
  // and the mode allows it — 'off' never calls decide(), shadow calls
  // it to journal the opinion. When it is not asked the shared post-eval
  // below still runs: pending routes reject unresolved, filters fire on
  // resolved inputs, and the score shape still ranks by outcome stats —
  // invoke gates the JUDGE call, never the code's own contract.
  const mayAsk = cascade.askT2 && judge !== undefined && mode !== 'off';
  let asked: Awaited<ReturnType<typeof askQuestions>> = null;
  let t3Used = false;
  if (mayAsk) {
    const t2Start = Date.now();
    asked = await askQuestions({ router, judge: judge!, formula, text });

    // T3 — the escalate provider answers ONLY the keys T2 left in
    // lowConfidence; a confident T2 never reaches it, and an absent
    // escalate leaves the table order standing
    if (asked !== null && asked.res.lowConfidence.length > 0 && input.escalate !== undefined) {
      const escalated = await escalateLowConfidence({
        dir,
        router,
        provider: input.escalate,
        judge: judge!,
        formula,
        text,
        asked,
      });
      if (escalated !== null) {
        asked = escalated;
        t3Used = true;
      }
    }
    stages.push(
      stageRecord(
        t3Used ? 'T3' : 'T2',
        cascade.candidates.map(c => c.route.name),
        [],
        Date.now() - t2Start,
        {
          note: t3Used
            ? 'T2 low-confidence — the escalate provider re-answered'
            : asked === null
              ? 'the judge did not answer — inputs stay unresolved'
              : 'the judge answered the formula questions',
        }
      )
    );
  } else {
    stages.push(
      stageRecord('T2', [], [], 0, {
        note:
          cascade.gateReason +
          (judge === undefined
            ? ' — no decision model configured'
            : mode === 'off'
              ? ' — the decision model is off'
              : ''),
      })
    );
  }

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
    // the judge was never asked or did not answer — say which, the way
    // the pre-cascade trace always did
    addNote(
      trace,
      router === undefined
        ? "no decision model configured — the formula's inputs stay unresolved"
        : mode === 'off'
          ? "the decision model is off — the formula's inputs stay unresolved"
          : !cascade.askT2
            ? `${cascade.gateReason} — the formula's inputs stay unresolved`
            : "the decision model did not answer — the formula's inputs stay unresolved"
    );
  }

  const set0 = candidates(table, effective, snapshot);
  const { set: filteredSet, fired } = applyFormulaFilters(set0, formula, effective);
  trace.filtered = fired;
  // T1's reorder rides the post-eval set ONLY on the rules fallback —
  // evidence orders the survivors when no trusted answer picked, but a
  // judge-decided set keeps the formula's own ordering (fit order for
  // features, score for score). Routes the recall never saw sink to the
  // tail of the fallback order.
  const trustedPick = asked !== null && mode === 'enforce';
  const recallRank = new Map(cascade.candidates.map((c, i) => [c.route.name, i]));
  const set = trustedPick
    ? { candidates: filteredSet.candidates, rejected: filteredSet.rejected }
    : {
        candidates: [...filteredSet.candidates].sort(
          (a, b) =>
            (recallRank.get(a.route.name) ?? Number.MAX_SAFE_INTEGER) -
            (recallRank.get(b.route.name) ?? Number.MAX_SAFE_INTEGER)
        ),
        rejected: filteredSet.rejected,
      };

  // who decided — a trusted T2/T3 answer fed the pick; anything else is
  // the rules standing (shadow journals but never routes, a failed
  // judge leaves inputs unresolved, the gate never asked)
  decidedBy = asked !== null && mode === 'enforce' ? (t3Used ? 'escalate' : 'judge') : 'rules';
  const cascadeTrace = { stages, decidedBy };

  let decision: RouteDecision;
  if (formula.shape === 'features') {
    decision = resolveRoute(table, effective, snapshot, undefined, {
      set,
      formula: trace,
      cascade: cascadeTrace,
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
        cascade: cascadeTrace,
        reason: `the table's own order — ${scoring.skipped}`,
      });
    } else if (scoring.winner === undefined) {
      decision = resolveRoute(table, effective, snapshot, undefined, {
        set,
        formula: trace,
        cascade: cascadeTrace,
      });
    } else {
      const winner = scoring.winner;
      decision = resolveRoute(table, effective, snapshot, () => winner, {
        set,
        picked: 'formula',
        formula: trace,
        cascade: cascadeTrace,
        reason: `the formula scored ${winner} highest`,
      });
    }
  }

  // the named refusal — routes whose required inputs stayed unresolved
  // are excluded, and when nothing safe remains AND no trusted answer
  // ever arrived the result says so by name rather than reading as an
  // ordinary "no route fits" (bro-0ykhg.2). When the judge DID answer,
  // resolveRoute's own reason already tells the truth.
  if (decision.route === undefined && cascade.pending.length > 0 && !trustedPick) {
    decision = {
      ...decision,
      reason: `no eligible route — ${cascade.pending.length} route(s) needed formula answers that never arrived`,
    };
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
      // no judge — but T0/T1 still run: recall may decide or reorder,
      // the gate never asks (bro-0ykhg.2)
      const cascade = await cascadePrefix({
        dir,
        table,
        task,
        text,
        formula,
        snapshot,
        invoke: input.invoke ?? 'ambiguous',
        ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
        ...(input.recall === undefined ? {} : { recall: input.recall }),
        ...(input.formulaText === undefined ? {} : { formulaText: input.formulaText }),
        ...(input.successPredicate === undefined
          ? {}
          : { successPredicate: input.successPredicate }),
        ...(input.recallRows === undefined ? {} : { recallRows: input.recallRows }),
      });
      const stages = [...cascade.stages];
      stages.push(
        stageRecord('T2', [], [], 0, {
          note: 'no decision model configured — the judge is never called',
        })
      );
      // no judge exists on this path — invoke=always has nothing to ask,
      // so decided recall always stands (bro-0ykhg.2 review)
      const decidedBy: CascadeDecider = cascade.t1Decided !== undefined ? 'recall' : 'rules';
      const set = {
        candidates: cascade.candidates,
        rejected: unresolvedRejects(cascade.pending, cascade.rejected),
      };
      const pick = decidedBy === 'recall' ? () => cascade.t1Decided : undefined;
      const decision = resolveRoute(table, task, snapshot, pick, {
        set,
        picked: decidedBy === 'recall' ? 'recall' : undefined,
        formula: trace,
        cascade: { stages, decidedBy },
        ...(decidedBy === 'recall' ? { reason: `outcome recall picked ${cascade.t1Decided}` } : {}),
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
      // the cascade's knobs + recall scope — same contract the question
      // shapes get (bro-0ykhg.2)
      ...(input.invoke === undefined ? {} : { invoke: input.invoke }),
      ...(input.recall === undefined ? {} : { recall: input.recall }),
      ...(input.escalate === undefined ? {} : { escalate: input.escalate }),
      ...(input.formulaText === undefined ? {} : { formulaText: input.formulaText }),
      ...(input.successPredicate === undefined ? {} : { successPredicate: input.successPredicate }),
      ...(input.recallRows === undefined ? {} : { recallRows: input.recallRows }),
      ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
    });
  }
  return decideByQuestions(input, judge, trace);
}
