/**
 * The candidates — which routes may serve this task.
 *
 * Two filters, in this order: the route's MATCH must not contradict the
 * task, and the route's chain must still have a model health left
 * standing. What survives is a candidate, ordered by how much of the
 * task the route actually pins.
 */
import { healthKey, type ChainEntry, type HealthSnapshot } from '@broject/core';
import type { Route, RouteTable } from './types.ts';

/** The task — the shape the operator's route table speaks. */
export interface RouteTask {
  /** the task type ("edit", "design", …) */
  type?: string;
  /** the complexity band ("low", "mid", "high") */
  complexity?: string;
  /** the priority band ("P0", "P1", "P2") */
  priority?: string;
}

/** One route that may serve the task. */
export interface RouteCandidate {
  route: Route;
  /** how many of the task's declared fields the route pins exactly */
  score: number;
  /** why it fits, in words */
  reasons: string[];
}

/** One route that may not — and why. */
export interface RejectedRoute {
  route: Route;
  reason: string;
}

/** The candidates, and the routes that did not make it. */
export interface CandidateSet {
  candidates: RouteCandidate[];
  rejected: RejectedRoute[];
}

/** The match fields — the task's shape. */
const FIELDS = ['type', 'complexity', 'priority'] as const;

/**
 * The field the route contradicts, or undefined when it fits.
 *
 * A route that PINS a field needs the task to carry it: a route that
 * says "type=edit" does not serve a task that never says what it is.
 * A route that pins nothing fits every task — that is the catch-all.
 */
function conflict(route: Route, task: RouteTask): string | undefined {
  for (const field of FIELDS) {
    const want = route.match[field];
    if (want === undefined) {
      continue;
    }
    const got = task[field];
    if (got === undefined) {
      return `the task carries no ${field}`;
    }
    if (want !== got) {
      return `${field}=${want} does not fit ${field}=${got}`;
    }
  }
  return undefined;
}

/** How much of the task the route pins — the score and the reasons. */
function fit(route: Route, task: RouteTask): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  for (const field of FIELDS) {
    const want = route.match[field];
    const got = task[field];
    if (want !== undefined && got !== undefined && want === got) {
      score += 1;
      reasons.push(`${field}=${want}`);
    }
  }
  return { score, reasons };
}

/** The chain's surviving entries — the walled models drop out, and the
 *  reason rides with them. */
export function survivingChain(
  route: Route,
  health: HealthSnapshot
): { chain: ChainEntry[]; dropped: { entry: ChainEntry; reason: string }[] } {
  const chain: ChainEntry[] = [];
  const dropped: { entry: ChainEntry; reason: string }[] = [];
  for (const entry of route.chain) {
    const verdict = health[healthKey(entry.provider, entry.model)];
    if (verdict !== undefined && !verdict.available) {
      dropped.push({ entry, reason: verdict.reason ?? 'unavailable' });
      continue;
    }
    chain.push(entry);
  }
  return { chain, dropped };
}

/** The candidates for a task, and the routes that did not make it. */
export function candidates(
  table: RouteTable,
  task: RouteTask,
  health: HealthSnapshot
): CandidateSet {
  const found: RouteCandidate[] = [];
  const rejected: RejectedRoute[] = [];
  for (const route of table.routes) {
    const clash = conflict(route, task);
    if (clash !== undefined) {
      rejected.push({ route, reason: clash });
      continue;
    }
    const live = survivingChain(route, health);
    if (live.chain.length === 0) {
      const why = live.dropped.map(d => d.reason).join(', ');
      rejected.push({ route, reason: `every model is walled — ${why}` });
      continue;
    }
    found.push({ route, ...fit(route, task) });
  }
  // a stable sort keeps the table's own order among equals
  found.sort((a, b) => b.score - a.score);
  return { candidates: found, rejected };
}
