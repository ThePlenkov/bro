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
import { readFileSync } from 'node:fs';
import type { FleetRouter, HealthSnapshot, JudgeFacade } from '@broject/core';
import {
  candidates,
  readFormula,
  resolveRoute,
  validateFormulaTable,
} from '@broject/router-routes';
import type {
  Formula,
  OutcomeStatsSource,
  RouteCandidate,
  RouteDecision,
  RouteTable,
  RouteTask,
} from '@broject/router-routes';
import { newDecisionId } from '@broject/router-store';
import { journalDecision } from './context.ts';
import type { DecisionKind } from '@broject/router-store';
import { decisionJudge } from './decision-model.ts';
import { decideByFormula } from './formula-decide.ts';
import { ledgerHealth } from './ledger.ts';

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

/** The formula the path decides with — the file read and cross-checked
 *  against the table. Every problem is a FormulaError, thrown once:
 *  an invalid formula fails loud, never silently routes around itself. */
function loadFormula(path: string, table: RouteTable): Formula {
  const formula = readFormula(path);
  validateFormulaTable(formula, table, path);
  return formula;
}

/** The formula file's raw text for the journal — best-effort: the
 *  decision stands even when the snapshot cannot be re-read (the path
 *  still records). */
function formulaTextOf(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
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
}): Promise<string | undefined> {
  const { dir, router, found, task, resolved } = opts;
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
  /** the decision model — absent means the table's own order decides */
  router?: FleetRouter;
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
  // the verdict — the formula's contract when one is declared, else the
  // table's own order plus the decision model's opinion
  const verdict =
    input.formula !== undefined
      ? await decideByFormula({
          dir: input.dir,
          table: input.table,
          task: input.task,
          text: input.text,
          ...(input.router === undefined ? {} : { router: input.router }),
          formula: loadFormula(input.formula, input.table),
          formulaPath: input.formula,
          snapshot,
          healthKnown: known,
          ...(input.judge === undefined ? {} : { judge: input.judge }),
          ...(input.outcomes === undefined ? {} : { outcomes: input.outcomes }),
        })
      : await (async () => {
          const found = candidates(input.table, input.task, snapshot);
          const resolved = found.candidates[0]?.route.name ?? '';
          const named =
            input.router === undefined || found.candidates.length === 0
              ? undefined
              : await modelPick({
                  dir: input.dir,
                  router: input.router,
                  found: found.candidates,
                  task: input.text,
                  resolved,
                });
          return {
            decision: resolveRoute(input.table, input.task, snapshot, () => named),
            snapshot,
            healthKnown: known,
          };
        })();
  const decisionId = newDecisionId();
  const formulaText = input.formula === undefined ? undefined : formulaTextOf(input.formula);
  const journaled = await journalDecision({
    dir: input.dir,
    kind: input.kind ?? 'route',
    decisionId,
    ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
    taskText: input.text,
    task: input.task,
    // the feature bucket — the caller's map when it carries one, else
    // the task's own declared shape (type/complexity/priority). A
    // formula's ANSWER-derived features stay out on purpose: they are
    // volatile model output, replayed through the trace below, not a
    // stable bucket the stats should group by
    ...(input.features !== undefined
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
    // the formula's trace — answers, fired filters, score rows — rides
    // the stage-answers slot for replay
    ...(verdict.decision.formula === undefined ? {} : { stages: verdict.decision.formula }),
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
