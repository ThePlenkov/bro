/**
 * The resolver — which route serves this task, and why.
 *
 * The table's own order is the static answer; the decision model may
 * override it by naming a candidate, and the formula may rank the
 * survivors itself. A chooser that names a route that is NOT a
 * candidate never wins — the table owns the candidates, the chooser
 * only picks among them.
 */
import type { ChainEntry, HealthSnapshot } from '@broject/core';
import {
  candidates,
  survivingChain,
  type CandidateSet,
  type RouteCandidate,
  type RouteTask,
} from './candidates.ts';
import type { FormulaTrace } from './formula.ts';
import type { CascadeTrace } from './stages.ts';
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
  /** who chose — the table's own order, the decision model, the formula,
   *  or outcome recall */
  picked: 'static' | 'model' | 'formula' | 'recall';
  /** what the formula did — answers, filters, scores — when one ran */
  formula?: FormulaTrace;
  /** the cascade's stage record — every rung's before/after, latency,
   *  and who decided (bro-0ykhg.2) */
  cascade?: CascadeTrace;
}

/** What a caller may hand the resolver beyond the table, task and
 *  health — the formula path's pre-computed, pre-filtered candidate
 *  set, the pick's provenance, and the trace the explanation prints. */
export interface ResolveExtras {
  /** candidates already computed and filtered — the formula path's set */
  set?: CandidateSet;
  /** who the pick speaks for — 'model' (default), 'formula', or
   *  'recall' when outcome history named the winner */
  picked?: 'model' | 'formula' | 'recall';
  /** why the pick won — overrides the default wording */
  reason?: string;
  /** the formula's trace — answers, fired filters, score rows */
  formula?: FormulaTrace;
  /** the cascade's stage record — rides onto the decision */
  cascade?: CascadeTrace;
}

/** Why the winner won — the static order, the chooser, or a refusal. */
function reasonFor(
  winner: RouteCandidate,
  named: string | undefined,
  chosen: RouteCandidate | undefined,
  picked: 'model' | 'formula' | 'recall'
): string {
  if (named !== undefined && chosen === undefined) {
    return `the decision model named "${named}", which is not a candidate — ${winner.route.name} stands`;
  }
  if (chosen !== undefined) {
    if (picked === 'formula') {
      return `the formula picked ${winner.route.name}`;
    }
    if (picked === 'recall') {
      return `outcome recall picked ${winner.route.name}`;
    }
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
  pick?: (candidates: RouteCandidate[]) => string | undefined,
  extras?: ResolveExtras
): RouteDecision {
  const set = extras?.set ?? candidates(table, task, health);
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
      ...(extras?.formula === undefined ? {} : { formula: extras.formula }),
      ...(extras?.cascade === undefined ? {} : { cascade: extras.cascade }),
    };
  }
  // a missing hook and a hook that named nothing are DIFFERENT states:
  // only the second one is the decision model speaking
  const named = pick === undefined ? undefined : pick(set.candidates);
  const chosen = named === undefined ? undefined : set.candidates.find(c => c.route.name === named);
  const winner = chosen ?? first;
  const live = survivingChain(winner.route, health);
  const picked: RouteDecision['picked'] =
    chosen === undefined ? 'static' : (extras?.picked ?? 'model');
  return {
    route: winner.route,
    chain: live.chain,
    dropped: live.dropped,
    candidates: set.candidates,
    rejected: set.rejected,
    reason:
      named !== undefined && chosen === undefined
        ? reasonFor(winner, named, chosen, 'model')
        : (extras?.reason ??
          reasonFor(
            winner,
            named,
            chosen,
            picked === 'formula' || picked === 'recall' ? picked : 'model'
          )),
    picked,
    ...(extras?.formula === undefined ? {} : { formula: extras.formula }),
    ...(extras?.cascade === undefined ? {} : { cascade: extras.cascade }),
  };
}
