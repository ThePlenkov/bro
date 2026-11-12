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
 */
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
}

/** The formula the path decides with — the file read and cross-checked
 *  against the table. Every problem is a FormulaError, thrown once:
 *  an invalid formula fails loud, never silently routes around itself. */
function loadFormula(path: string, table: RouteTable): Formula {
  const formula = readFormula(path);
  validateFormulaTable(formula, table, path);
  return formula;
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

/** The verdict — the table's own order, plus the decision model's opinion
 *  when one is configured, or the formula's contract when one is declared. */
export async function decideRoute(input: {
  /** the working dir — the journal and the config anchor here */
  dir: string;
  /** the table the decision reads */
  table: RouteTable;
  /** the task's shape */
  task: RouteTask;
  /** the task text the decision model reads */
  text: string;
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
}): Promise<TaskDecision> {
  const { snapshot, known } = await ledgerHealth();
  if (input.formula !== undefined) {
    const formula = loadFormula(input.formula, input.table);
    return decideByFormula({
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
      ...(input.outcomes === undefined ? {} : { outcomes: input.outcomes }),
    });
  }
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
}
