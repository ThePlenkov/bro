/**
 * The candidates — which routes may serve this task.
 *
 * Two filters, in this order: the route's MATCH must not contradict the
 * task, and the route's chain must still have a model health left
 * standing. What survives is a candidate, ordered by how much of the
 * task the route actually pins.
 */
import { healthKey, type ChainEntry, type HealthSnapshot } from '@broject/core';
import type { FeatureMatch, FeatureValue, Route, RouteTable } from './types.ts';

/** The task — the shape the operator's route table speaks. */
export interface RouteTask {
  /** the task type ("edit", "design", …) */
  type?: string;
  /** the complexity band ("low", "mid", "high") */
  complexity?: string;
  /** the priority band ("P0", "P1", "P2") */
  priority?: string;
  /** the typed features the task carries — caller-supplied fields, or
   *  the formula's answers merged in by the decision path. Keys name
   *  the formula's declared questions; the match compares literally. */
  features?: Record<string, FeatureValue>;
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

/** One match field — the task's shape, as the table spells it. */
type Field = (typeof FIELDS)[number];

/** The value a route pins on a field — undefined when it pins nothing.
 *  The fields are a closed set, so the read is a literal per field — no
 *  dynamic index, nothing to reach into a prototype with. */
function pinned(route: Route, field: Field): string | undefined {
  switch (field) {
    case 'type':
      return route.match.type;
    case 'complexity':
      return route.match.complexity;
    case 'priority':
      return route.match.priority;
  }
}

/** The value the task carries on a field. */
function carried(task: RouteTask, field: Field): string | undefined {
  switch (field) {
    case 'type':
      return task.type;
    case 'complexity':
      return task.complexity;
    case 'priority':
      return task.priority;
  }
}

/** The field's fit — the route pins it AND the task carries the same
 *  value. A route that pins nothing fits every task. */
function fits(route: Route, task: RouteTask, field: Field): string | undefined {
  const want = pinned(route, field);
  if (want === undefined) {
    return undefined;
  }
  const got = carried(task, field);
  return got === want ? want : undefined;
}

/**
 * The field the route contradicts, or undefined when it fits.
 *
 * A route that PINS a field needs the task to carry it: a route that
 * says "type=edit" does not serve a task that never says what it is.
 * A route that pins nothing fits every task — that is the catch-all.
 */
function conflict(route: Route, task: RouteTask): string | undefined {
  for (const field of FIELDS) {
    const want = pinned(route, field);
    if (want === undefined) {
      continue;
    }
    const got = carried(task, field);
    if (got === undefined) {
      return `the task carries no ${field}`;
    }
    if (want !== got) {
      return `${field}=${want} does not fit ${field}=${got}`;
    }
  }
  return featureConflict(route, task);
}

/** A feature value, rendered for a reason — a list reads as members. */
function featureText(value: FeatureMatch | FeatureValue): string {
  return Array.isArray(value) ? `[${value.map(String).join(', ')}]` : String(value);
}

/** The task's feature — hasOwn-guarded: a feature literally named
 *  "__proto__" must read as data, never the prototype. */
function carriedFeature(task: RouteTask, key: string): FeatureValue | undefined {
  const features = task.features;
  if (features === undefined || !Object.hasOwn(features, key)) {
    return undefined;
  }
  return features[key];
}

/** One pinned feature's fit — the task carries it AND the value
 *  matches: a scalar wants exact equality, a list wants membership. */
function featureFits(want: FeatureMatch, got: FeatureValue): boolean {
  return Array.isArray(want) ? want.includes(got) : want === got;
}

/** The feature the route contradicts, or undefined when they all fit. */
function featureConflict(route: Route, task: RouteTask): string | undefined {
  for (const [key, want] of Object.entries(route.match.features ?? {})) {
    const got = carriedFeature(task, key);
    if (got === undefined) {
      return `the task carries no feature ${key}`;
    }
    if (!featureFits(want, got)) {
      return `feature ${key}=${featureText(want)} does not fit feature ${key}=${featureText(got)}`;
    }
  }
  return undefined;
}

/** The features the route pins AND the task carries — the score and the
 *  reasons, same contract as the scalar fields. */
function featureFit(route: Route, task: RouteTask): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  for (const [key, want] of Object.entries(route.match.features ?? {})) {
    const got = carriedFeature(task, key);
    if (got !== undefined && featureFits(want, got)) {
      score += 1;
      reasons.push(`feature.${key}=${featureText(got)}`);
    }
  }
  return { score, reasons };
}

/** How much of the task the route pins — the score and the reasons. */
function fit(route: Route, task: RouteTask): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  for (const field of FIELDS) {
    const pinnedValue = fits(route, task, field);
    if (pinnedValue !== undefined) {
      score += 1;
      reasons.push(`${field}=${pinnedValue}`);
    }
  }
  const features = featureFit(route, task);
  return { score: score + features.score, reasons: [...reasons, ...features.reasons] };
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
