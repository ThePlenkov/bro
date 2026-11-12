/**
 * The decision path — the one way a surface asks "which route serves this
 * task".
 *
 * Two surfaces ask it: `brouter route` (a plan) and `brouter ask` (a live
 * request). They must answer the SAME question the same way, or the
 * explanation of one contradicts the other. So the health, the candidates,
 * the decision model's opinion and the verdict live here, and the surfaces
 * only render.
 *
 * The decision model picks a ROUTE, never a lane: the chain and the health
 * are the code's business. Fail-open — no judge, no opinion, the table's
 * own order stands.
 *
 * A declared formula (`brouter.formula` or `--formula`) takes the same
 * seam: the md file's contract decides — typed questions for `features`,
 * the pick for `pick`, the score for `score` — and the no-formula path
 * below is exactly what a `pick` formula reduces to.
 *
 * Every decision journals once, under a fresh UUID `decisionId` (spec
 * bro-0ykhg.4): the replayable inputs — task text, carried fields, the
 * surviving candidates, the table snapshot and hash, the formula
 * snapshot, the judge configuration, the formula trace — land BEFORE
 * the routed work starts, so a later act verdict can report back by id
 * and .2/.3/.5 can replay the question. The journal is best-effort: an
 * unavailable store costs the row, never the decision — the id still
 * returns for the pins.
 */
import type { BrouterRouter, FleetRouter, HealthSnapshot, JudgeFacade } from '@broject/core';
import { readFileSync } from 'node:fs';
import {
  candidates,
  FormulaError,
  parseFormulaText,
  resolveRoute,
  validateFormulaTable,
} from '@broject/router-routes';
import type {
  CascadeDecider,
  CascadeStage,
  Formula,
  OutcomeStatsSource,
  RouteCandidate,
  RouteDecision,
  RouteTable,
  RouteTask,
} from '@broject/router-routes';
import { newDecisionId, DEFAULT_SUCCESS_PREDICATE } from '@broject/router-store';
import { journalDecision } from './context.ts';
import type { DecisionKind } from '@broject/router-store';
import { decisionJudge } from './decision-model.ts';
import { decideByFormula, type FormulaTaskDecision } from './formula-decide.ts';
import { ledgerHealth } from './ledger.ts';
import { routerOutcomeStats } from './outcome-stats.ts';
import { runT1, shouldInvokeT2, stageRecord, type InvokeMode } from './cascade.ts';
import { recallTuning } from './recall.ts';

/** The verdict for a task — the route, and whether the health was known. */
export interface TaskDecision {
  /** the resolver's verdict — the route, the chain, the why */
  decision: RouteDecision;
  /** the health the verdict read — the walls and the sessions */
  snapshot: HealthSnapshot;
  /** false when the ledger could not be read — no wall was applied */
  healthKnown: boolean;
  /** the decision's UUID — journaled once, the id outcomes report by */
  decisionId: string;
  /** the project namespace the decision journaled under */
  contextId: string;
  /** false when the journal could not take the row — the id is still
   *  valid for pins; an outcome for it will fail unknown */
  journaled: boolean;
}

/** The run links a spawn caller already knows at decision time — the
 *  journal stores them so a crash between journal and pin writes is
 *  repairable from the row itself. */
export interface DecisionLinks {
  beadId?: string;
  worker?: string;
  runId?: string;
  pr?: string;
}

/** The formula the path decides with — the file read ONCE, cross-checked
 *  against the table, and handed back as the same bytes it parsed: the
 *  score shape's stats hash and the journal snapshot derive from this
 *  one read, so the contract and its namespace can never split on a
 *  mid-decision file change. Every problem is a FormulaError, thrown
 *  once: an invalid formula fails loud, never silently routes around
 *  itself. */
function loadFormula(path: string, table: RouteTable): { formula: Formula; text: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FormulaError([`${path}: cannot read formula — ${msg}`], path);
  }
  const formula = parseFormulaText(text, path);
  validateFormulaTable(formula, table, path);
  return { formula, text };
}

/** The decision model's pick — the judge over the candidate routes.
 *  Fail-open: no judge, no verdict, the table's own order stands. */
async function modelPick(opts: {
  /** the working dir — the journal and the config anchor here */
  dir: string;
  /** the decision model's provider + mode */
  router: FleetRouter;
  /** the candidate routes the table and the health left standing */
  found: RouteCandidate[];
  /** the task text the model reads */
  task: string;
  /** the statically resolved route — journaled beside the model's opinion */
  resolved: string;
  /** the T3 escalate judge — asked only on a low-confidence pick */
  escalate?: import('@broject/core').JudgeFacade;
}): Promise<string | undefined> {
  const { dir, router, found, task, resolved, escalate } = opts;
  const { routePick } = await import('@broject/judge');
  const judge = await decisionJudge(dir, router);
  const options = found.map(c => ({
    name: c.route.name,
    description: c.route.description ?? `chain: ${c.route.chain.map(e => e.provider).join(' → ')}`,
  }));
  try {
    return await routePick({
      dir,
      judge,
      options,
      state: { task },
      subject: task.slice(0, 80),
      resolved,
      mode: router.mode,
      ...(escalate === undefined ? {} : { escalate }),
    });
  } catch (err) {
    console.error(
      `warning: brouter.router.provider "${router.provider}" — ` +
        `${err instanceof Error ? err.message : String(err)}; the table's own order stands`
    );
    return undefined;
  }
}

/** The verdict — the table's own order plus the decision model's
 *  opinion when one is configured, or the formula's contract when one
 *  is declared. The decision journals under a fresh id before it
 *  returns: every route/ask/spawn decision is replayable and
 *  outcome-addressable. */
export async function decideRoute(input: {
  /** the working dir — the journal and the config anchor here */
  dir: string;
  /** the table the decision reads */
  table: RouteTable;
  /** the table's file path — the context fallback when no repo id exists */
  tablePath?: string;
  /** the task's shape */
  task: RouteTask;
  /** the task text the decision model reads */
  text: string;
  /** the feature map the outcome stats bucket by — the task's declared
   *  features when it carries them */
  features?: Record<string, string | number | boolean>;
  /** the decision model — absent means the table's own order decides;
   *  the cascade's invoke/escalate/recall knobs ride it (bro-0ykhg.2) */
  router?: BrouterRouter;
  /** the formula's path — `--formula` wins over `brouter.formula` at the
   *  surface; absent means the table's order plus the model pick, exactly
   *  the behavior before formulas existed */
  formula?: string;
  /** test seam — a ready judge for the formula path */
  judge?: JudgeFacade;
  /** test seam — the outcomes read model for the score shape; .4's store
   *  plugs in here, the Beta(1,1) prior stands in until it lands */
  outcomes?: OutcomeStatsSource;
  /** who is asking — 'route' (default), 'ask', or 'spawn' */
  kind?: DecisionKind;
  /** the run links already known — bead/worker/run/PR */
  links?: DecisionLinks;
}): Promise<TaskDecision> {
  const { snapshot, known } = await ledgerHealth();
  // the formula's bytes, read once — the verdict parses them, the score
  // shape's stats source hashes them, the journal snapshots them: one
  // read, one contract, one namespace (no read-twice TOCTOU)
  const loaded = input.formula === undefined ? undefined : loadFormula(input.formula, input.table);
  const formula = loaded?.formula;
  const formulaText = loaded?.text;
  // the score shape's outcome stats — the live read-model over router.db
  // unless a test seam supplied one; built only for `shape: score`, the
  // one shape that consumes it (spec bro-0ykhg.7)
  const outcomes =
    input.outcomes ??
    (formula?.shape === 'score'
      ? await routerOutcomeStats({
          dir: input.dir,
          ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
          table: input.table,
          ...(formulaText === undefined ? {} : { formulaText }),
        })
      : undefined);
  // the verdict — the formula's contract when one is declared, else the
  // table's own order plus the decision model's opinion
  const verdict: FormulaTaskDecision =
    formula === undefined
      ? await (async (): Promise<FormulaTaskDecision> => {
          const found = candidates(input.table, input.task, snapshot);
          const invoke: InvokeMode = input.router?.invoke ?? 'ambiguous';
          const stages: CascadeStage[] = [];
          // T0 — rules + health over the carried fields
          const t0Start = Date.now();
          const names = found.candidates.map(c => c.route.name);
          stages.push(
            stageRecord('T0', names, names, Date.now() - t0Start, {
              note: `${names.length} candidate(s) survived rules + health`,
            })
          );
          // T1 — outcome recall over the candidates (bro-0ykhg.2)
          const t1 = await runT1({
            dir: input.dir,
            table: input.table,
            text: input.text,
            contenders: names,
            tuning: recallTuning(input.router?.recall),
            predicate: DEFAULT_SUCCESS_PREDICATE,
            ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
          });
          stages.push(t1.stage);
          // reorder the candidates by recall standing
          const rank = new Map(t1.order.map((n, i) => [n, i]));
          const reordered = [...found.candidates].sort(
            (a, b) =>
              (rank.get(a.route.name) ?? Number.MAX_SAFE_INTEGER) -
              (rank.get(b.route.name) ?? Number.MAX_SAFE_INTEGER)
          );
          const set = { candidates: reordered, rejected: found.rejected };
          // T1 decided and no trusted T2 pick can override it — recall
          // settles it. invoke=always yields ONLY to an enforce-mode
          // router: shadow journals but never routes, off never asks,
          // and an absent router has no judge at all (bro-0ykhg.2)
          const t2CanOverride = invoke === 'always' && input.router?.mode === 'enforce';
          if (t1.decided !== undefined && !t2CanOverride) {
            stages.push(
              stageRecord('T2', [], [], 0, { note: 'skipped — outcome recall already decided' })
            );
            const decision = resolveRoute(input.table, input.task, snapshot, () => t1.decided, {
              set,
              picked: 'recall',
              cascade: { stages, decidedBy: 'recall' },
              reason: `outcome recall picked ${t1.decided}`,
            });
            return { decision, snapshot, healthKnown: known };
          }
          // the invoke gate — 'never' never asks, 'ambiguous' asks only
          // on ambiguity, 'always' asks every task; mode=off never asks
          const gate = shouldInvokeT2({
            invoke,
            candidates: reordered.length,
            pending: 0,
            pendingNeeds: false,
          });
          const mayAsk =
            gate.ask &&
            input.router !== undefined &&
            input.router.mode !== 'off' &&
            reordered.length > 0;
          let named: string | undefined;
          let decidedBy: CascadeDecider = 'rules';
          if (mayAsk) {
            // T3 — the escalate judge rides routePick on low-confidence
            const escalate =
              input.router!.escalate === undefined
                ? undefined
                : await decisionJudge(input.dir, {
                    provider: input.router!.escalate,
                    mode: input.router!.mode,
                  }).catch(() => undefined);
            const t2Start = Date.now();
            named = await modelPick({
              dir: input.dir,
              router: input.router!,
              found: reordered,
              task: input.text,
              resolved: reordered[0]?.route.name ?? '',
              ...(escalate === undefined ? {} : { escalate }),
            });
            stages.push(
              stageRecord(
                'T2',
                reordered.map(c => c.route.name),
                // the pick narrows the set to the named route — an
                // unanswered judge leaves every contender standing
                named !== undefined ? [named] : reordered.map(c => c.route.name),
                Date.now() - t2Start,
                {
                  note:
                    named === undefined
                      ? 'the judge named no confident candidate'
                      : `the judge picked ${named}`,
                }
              )
            );
            decidedBy = input.router!.mode === 'enforce' && named !== undefined ? 'judge' : 'rules';
          } else {
            stages.push(
              stageRecord('T2', [], [], 0, {
                note:
                  gate.reason +
                  (input.router === undefined
                    ? ' — no decision model configured'
                    : input.router.mode === 'off'
                      ? ' — the decision model is off'
                      : ''),
              })
            );
          }
          const decision = resolveRoute(input.table, input.task, snapshot, () => named, {
            set,
            cascade: { stages, decidedBy },
          });
          return { decision, snapshot, healthKnown: known };
        })()
      : await decideByFormula({
          dir: input.dir,
          table: input.table,
          task: input.task,
          text: input.text,
          ...(input.router === undefined ? {} : { router: input.router }),
          formula,
          formulaPath: input.formula,
          snapshot,
          healthKnown: known,
          ...(input.judge === undefined ? {} : { judge: input.judge }),
          ...(outcomes === undefined ? {} : { outcomes }),
          // the cascade's knobs + the recall scope's formula bytes —
          // the SAME text the journal snapshots (bro-0ykhg.2)
          ...(input.router?.invoke === undefined ? {} : { invoke: input.router.invoke }),
          ...(input.router?.recall === undefined ? {} : { recall: input.router.recall }),
          ...(input.router?.escalate === undefined ? {} : { escalate: input.router.escalate }),
          ...(formulaText === undefined ? {} : { formulaText }),
          ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
        });
  const decisionId = newDecisionId();
  const journaled = await journalDecision({
    dir: input.dir,
    kind: input.kind ?? 'route',
    decisionId,
    ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
    taskText: input.text,
    task: input.task,
    // the feature bucket — a formula decision journals the EFFECTIVE
    // features it decided and scored with (task.features merged with
    // the trusted answers): the same map statsFor buckets by, so the
    // outcome rows this decision later produces join the score shape's
    // stats (spec bro-0ykhg.7). Formula-less decisions keep the .4
    // contract: the caller's map when it carries one, else the task's
    // own declared shape (type/complexity/priority)
    ...(verdict.features !== undefined
      ? { features: verdict.features }
      : input.features !== undefined
        ? { features: input.features }
        : Object.keys(input.task).length === 0
          ? {}
          : { features: input.task as Record<string, string | number | boolean> }),
    // the surviving candidates — post-filter under a formula
    candidates: verdict.decision.candidates,
    table: input.table,
    ...(input.formula === undefined
      ? {}
      : {
          formulaPath: input.formula,
          ...(formulaText === undefined ? {} : { formulaText }),
        }),
    // the formula's trace — answers, fired filters, score rows — plus
    // the cascade's stage record ride the stage-answers slot for replay
    ...(verdict.decision.formula === undefined && verdict.decision.cascade === undefined
      ? {}
      : {
          stages: {
            ...(verdict.decision.formula === undefined
              ? {}
              : { formula: verdict.decision.formula }),
            ...(verdict.decision.cascade === undefined
              ? {}
              : { cascade: verdict.decision.cascade }),
          },
        }),
    ...(input.router === undefined
      ? {}
      : { judge: { provider: input.router.provider, mode: input.router.mode } }),
    route: verdict.decision.route?.name,
    provider: verdict.decision.chain[0]?.provider,
    model: verdict.decision.chain[0]?.model,
    picked: verdict.decision.picked,
    ...(input.links ?? {}),
  });
  return {
    decision: verdict.decision,
    snapshot,
    healthKnown: known,
    decisionId: journaled.decisionId,
    contextId: journaled.contextId,
    journaled: journaled.recorded,
  };
}
