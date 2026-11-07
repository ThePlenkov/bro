/**
 * The resolver — which route serves this task, and why.
 *
 * The table's own order is the static answer; the decision model may
 * override it by naming a candidate. A model that names a route that is
 * NOT a candidate never wins — the table owns the candidates, the model
 * only chooses among them.
 */
import type { ChainEntry, HealthSnapshot } from '@broject/core';
import {
  candidates,
  survivingChain,
  type CandidateSet,
  type RouteCandidate,
  type RouteTask,
} from './candidates.ts';
import type { Route, RouteTable } from './types.ts';

/** The verdict — the route, its chain, and the why. */
export interface RouteDecision {
  /** the route that serves the task — absent when none fits */
  route?: Route;
  /** the chain a request lands on — the walled entries are gone */
  chain: ChainEntry[];
  /** the entries health removed, with their reasons */
  dropped: { entry: ChainEntry; reason: string }[];
  /** every candidate, best first */
  candidates: CandidateSet['candidates'];
  /** every route that did not make it, with the reason */
  rejected: CandidateSet['rejected'];
  /** why this route — in words */
  reason: string;
  /** who chose — the table's own order, or the decision model */
  picked: 'static' | 'model';
}

/** Why the winner won — the static order, the model, or a refusal. */
function reasonFor(
  winner: RouteCandidate,
  named: string | undefined,
  chosen: RouteCandidate | undefined
): string {
  if (named !== undefined && chosen === undefined) {
    return `the decision model named "${named}", which is not a candidate — ${winner.route.name} stands`;
  }
  if (chosen !== undefined) {
    return `the decision model picked ${winner.route.name}`;
  }
  const why = winner.reasons.length === 0 ? 'the fallback route' : winner.reasons.join(', ');
  return `the table's own order — ${winner.route.name} (${why})`;
}

/** The decision — the route, its chain, and the why. */
export function resolveRoute(
  table: RouteTable,
  task: RouteTask,
  health: HealthSnapshot,
  pick?: (candidates: RouteCandidate[]) => string | undefined
): RouteDecision {
  const set = candidates(table, task, health);
  const first = set.candidates.at(0);
  if (first === undefined) {
    const why = set.rejected.map(r => `${r.route.name}: ${r.reason}`).join('; ');
    return {
      chain: [],
      dropped: [],
      candidates: [],
      rejected: set.rejected,
      reason: `no route fits — ${why}`,
      picked: 'static',
    };
  }
  const named = pick?.(set.candidates);
  const chosen = named === undefined ? undefined : set.candidates.find(c => c.route.name === named);
  const winner = chosen ?? first;
  const live = survivingChain(winner.route, health);
  return {
    route: winner.route,
    chain: live.chain,
    dropped: live.dropped,
    candidates: set.candidates,
    rejected: set.rejected,
    reason: reasonFor(winner, named, chosen),
    picked: chosen === undefined ? 'static' : 'model',
  };
}
