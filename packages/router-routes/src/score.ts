/**
 * The score shape's arithmetic —
 * `score(r) = P(success | r, features) − λ·cost(r) − μ·latency(r)`.
 *
 * `P` is the posterior mean over verified terminal outcomes in the same
 * routing context and feature bucket (bro-0ykhg.4's read model), with
 * the Beta(1,1) prior mean 0.5 at `n = 0` — a judge score is not a
 * calibrated success probability and never stands in for one. `cost` is
 * mean task cost in USD and `latency` mean task wall time in seconds,
 * over the last 30 days — NOT the request/token counters.
 *
 * Unknown is unknown, never zero: a measure the outcomes cannot supply
 * stays undefined. If ANY surviving candidate has an unknown measure
 * under a POSITIVE weight, scoring is skipped for the whole set and the
 * table's order stands — with the reason on the trace. A zero weight
 * needs no measure.
 */
import type { RouteCandidate } from './candidates.ts';
import type { Formula, FormulaScoreTrace } from './formula.ts';
import type { FeatureValue, Route, RouteTable } from './types.ts';

/** What the outcomes know about one route in this task's context. */
export interface RouteOutcomeStats {
  /** P(success | route, features) — the posterior mean; 0.5 at n = 0 */
  p: number;
  /** the verified outcome rows behind p */
  n: number;
  /** mean task cost in USD — undefined = unknown, never zero */
  costUsd?: number;
  /** mean task wall time in seconds — undefined = unknown, never zero */
  wallSec?: number;
}

/** The outcomes read-model — .4's store plugs in here. Synchronous:
 *  the ledger is node:sqlite, and a scoring pass never awaits IO it
 *  does not need. */
export interface OutcomeStatsSource {
  /** The stats for one route under this task's features and the
   *  formula's declared `success` predicate. */
  statsFor(
    route: Route,
    features: Record<string, FeatureValue>,
    formula: Formula,
    table: RouteTable
  ): RouteOutcomeStats;
}

/** The empty store — no outcomes table exists yet (bro-0ykhg.4 lands
 *  it): every route reads the Beta(1,1) prior — p = 0.5 at n = 0 — and
 *  both measures stay unknown. With positive λ/μ weights this skips
 *  scoring and retains table order, exactly as the spec requires. */
export const priorOnlyOutcomes: OutcomeStatsSource = {
  statsFor: () => ({ p: 0.5, n: 0 }),
};

/** One candidate's score row — the trace the explanation prints. */
export type CandidateScore = FormulaScoreTrace;

/** The scoring verdict — every candidate's row, the winner when scoring
 *  ran, and the reason it did not when it skipped. */
export interface ScoreResult {
  scores: CandidateScore[];
  /** the winning route's name — absent when scoring skipped or no
   *  candidate survived */
  winner?: string;
  /** why scoring did not run — the explicit explanation */
  skipped?: string;
}

/** The weights the formula declared — absent means λ = μ = 0. */
function weights(formula: Formula): { lambda: number; mu: number } {
  return formula.score ?? { lambda: 0, mu: 0 };
}

/** The first unknown measure under a positive weight — the skip
 *  reason, or undefined when every needed measure is known. */
function unknownMeasure(
  name: string,
  route: string,
  value: number | undefined,
  weight: number
): string | undefined {
  if (weight > 0 && value === undefined) {
    return `${name} for route "${route}" is unknown and its weight is positive — scoring skipped`;
  }
  return undefined;
}

/** The formula score for one candidate — p − λ·cost − μ·latency, with
 *  a zero weight needing no measure (unknown cost stays unknown, it is
 *  simply never read). */
function scoreOf(stats: RouteOutcomeStats, w: { lambda: number; mu: number }): number {
  const costTerm = w.lambda > 0 ? w.lambda * (stats.costUsd ?? 0) : 0;
  const latencyTerm = w.mu > 0 ? w.mu * (stats.wallSec ?? 0) : 0;
  return stats.p - costTerm - latencyTerm;
}

/** Score every surviving candidate — highest wins, ties keep table
 *  order. `order` maps route name → table position for the tiebreak. */
export function scoreCandidates(
  candidates: RouteCandidate[],
  formula: Formula,
  features: Record<string, FeatureValue>,
  source: OutcomeStatsSource,
  table: RouteTable
): ScoreResult {
  const w = weights(formula);
  const order = new Map(table.routes.map((r, i) => [r.name, i]));
  const rows = candidates.map(candidate => {
    const stats = source.statsFor(candidate.route, features, formula, table);
    const row: CandidateScore = {
      route: candidate.route.name,
      p: stats.p,
      n: stats.n,
      ...(stats.costUsd === undefined ? {} : { costUsd: stats.costUsd }),
      ...(stats.wallSec === undefined ? {} : { wallSec: stats.wallSec }),
    };
    return { candidate, stats, row };
  });

  // the whole set skips on the FIRST unknown positively-weighted
  // measure — partial scoring would silently rank on incomplete data
  for (const { candidate, stats } of rows) {
    const name = candidate.route.name;
    const problem =
      unknownMeasure('cost', name, stats.costUsd, w.lambda) ??
      unknownMeasure('latency', name, stats.wallSec, w.mu);
    if (problem !== undefined || !Number.isFinite(stats.p)) {
      return {
        scores: rows.map(r => r.row),
        skipped: problem ?? `outcome stats for route "${name}" are not finite — scoring skipped`,
      };
    }
  }

  let winner: string | undefined;
  let best = Number.NEGATIVE_INFINITY;
  let bestOrder = Number.POSITIVE_INFINITY;
  for (const { candidate, stats, row } of rows) {
    const score = scoreOf(stats, w);
    row.score = score;
    const at = order.get(candidate.route.name) ?? Number.MAX_SAFE_INTEGER;
    if (score > best || (score === best && at < bestOrder)) {
      best = score;
      bestOrder = at;
      winner = candidate.route.name;
    }
  }
  return { scores: rows.map(r => r.row), winner };
}
