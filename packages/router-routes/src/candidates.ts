/**
 * The candidates — which routes may serve this task.
 *
 * Two filters, in this order: the route's MATCH must not contradict the
 * task, and the route's chain must still have a model health left
 * standing. What survives is a candidate, ordered by how much of the
 * task the route actually pins.
 */
import { healthKey, type ChainEntry, type HealthSnapshot } from '@broject/core';
import { matchGlob } from './glob.ts';
import type { FeatureMatch, FeatureValue, Route, RouteTable } from './types.ts';

/** The task — the shape the operator's route table speaks. */
export interface RouteTask {
  /** the task type ("edit", "design", …) */
  type?: string;
  /** the complexity band ("low", "mid", "high") */
  complexity?: string;
  /** the priority band ("P0", "P1", "P2") */
  priority?: string;
  /** the labels the task carries (bead labels, caller-supplied) —
   *  `match.labels` reads them; absent satisfies no label pin */
  labels?: string[];
  /** repo-relative paths the task touches — `match.paths` globs read
   *  them; absent satisfies no path pin */
  paths?: string[];
  /** the canonical repository id the task belongs to — `match.repo`
   *  reads it; absent satisfies no repo pin */
  repo?: string;
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

/** One route whose match needs formula answers the task does not carry
 *  yet — pending, not rejected: the cascade's T2 may still resolve it.
 *  `needs` names the declared question ids the route waits on (match
 *  pins and hard-filter inputs alike). */
export interface PendingRoute {
  route: Route;
  /** how much of the task the route already pins — same contract as a
   *  candidate's score */
  score: number;
  /** why it fits so far, in words */
  reasons: string[];
  /** the question ids whose answers the route still needs */
  needs: string[];
}

/** The candidates, the pending routes, and the routes that did not
 *  make it. `pending` is empty unless the caller declared inferable
 *  inputs (the formula's questions) — without them every missing field
 *  is a plain reject, exactly the pre-cascade contract. */
export interface CandidateSet {
  candidates: RouteCandidate[];
  pending?: PendingRoute[];
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

/** The feature the route contradicts, or undefined when they all fit —
 *  split three ways under the cascade: a carried non-fit rejects, a
 *  missing INFERABLE key pends (the formula may still answer it), a
 *  missing non-inferable key rejects (nothing can ever answer it). */
function featureConflict(
  route: Route,
  task: RouteTask,
  inferable: ReadonlySet<string>
): { reject?: string; needs: string[] } {
  const needs: string[] = [];
  for (const [key, want] of Object.entries(route.match.features ?? {})) {
    const got = carriedFeature(task, key);
    if (got === undefined) {
      if (inferable.has(key)) {
        needs.push(key);
        continue;
      }
      return {
        reject: `the task carries no feature ${key}`,
        needs,
      };
    }
    if (!featureFits(want, got)) {
      return {
        reject: `feature ${key}=${featureText(want)} does not fit feature ${key}=${featureText(got)}`,
        needs,
      };
    }
  }
  return { needs };
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

/** The labels the route pins — EVERY listed label must be carried. */
function labelConflict(route: Route, task: RouteTask): string | undefined {
  const want = route.match.labels;
  if (want === undefined || want.length === 0) {
    return undefined;
  }
  const got = task.labels;
  if (got === undefined || got.length === 0) {
    return 'the task carries no labels';
  }
  const held = new Set(got);
  const missing = want.find(label => !held.has(label));
  return missing === undefined ? undefined : `the task carries no label ${missing}`;
}

/** The labels the route pins AND the task carries — score and reasons.
 *  Duplicated pins count once: `['ui','ui']` is one restriction, not
 *  two (bro-0ykhg.2 review). */
function labelFit(route: Route, task: RouteTask): { score: number; reasons: string[] } {
  const want = [...new Set(route.match.labels ?? [])];
  const got = new Set(task.labels ?? []);
  const reasons: string[] = [];
  let score = 0;
  for (const label of want) {
    if (got.has(label)) {
      score += 1;
      reasons.push(`label=${label}`);
    }
  }
  return { score, reasons };
}

/** The paths the route pins — at least one task path must match at
 *  least one declared glob. */
function pathConflict(route: Route, task: RouteTask): string | undefined {
  const want = route.match.paths;
  if (want === undefined || want.length === 0) {
    return undefined;
  }
  const got = task.paths;
  if (got === undefined || got.length === 0) {
    return 'the task carries no paths';
  }
  const hit = got.some(path => want.some(glob => matchGlob(glob, path)));
  return hit ? undefined : `no task path matches ${want.map(g => `"${g}"`).join(', ')}`;
}

/** The paths the route pins AND the task touches — score and reasons.
 *  Duplicated globs count once, same contract as labels. */
function pathFit(route: Route, task: RouteTask): { score: number; reasons: string[] } {
  const want = [...new Set(route.match.paths ?? [])];
  const reasons: string[] = [];
  let score = 0;
  // score the task's PATHS, not the route's globs — the pins are
  // OR-alternatives, so one task path is one piece of evidence no
  // matter how many globs it satisfies; redundant overlapping globs
  // can't inflate the score (bro-0ykhg.2 review)
  for (const path of task.paths ?? []) {
    const hit = want.find(glob => matchGlob(glob, path));
    if (hit !== undefined) {
      score += 1;
      reasons.push(`path~${hit} (${path})`);
    }
  }
  return { score, reasons };
}

/** The repo the route pins — exact equality on the canonical id. */
function repoConflict(route: Route, task: RouteTask): string | undefined {
  const want = route.match.repo;
  if (want === undefined) {
    return undefined;
  }
  const got = task.repo;
  if (got === undefined) {
    return 'the task carries no repo';
  }
  return got === want ? undefined : `repo=${want} does not fit repo=${got}`;
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
  const labels = labelFit(route, task);
  const paths = pathFit(route, task);
  const features = featureFit(route, task);
  const repoFit = route.match.repo !== undefined && task.repo === route.match.repo ? 1 : 0;
  return {
    score: score + labels.score + paths.score + features.score + repoFit,
    reasons: [
      ...reasons,
      ...labels.reasons,
      ...paths.reasons,
      ...(repoFit === 1 ? [`repo=${route.match.repo}`] : []),
      ...features.reasons,
    ],
  };
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

/** The carried-field conflict, or undefined — scalars, labels, paths,
 *  repo. Carried fields are never inferable: a route pinning one the
 *  task lacks is rejected outright, never pending. */
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
  return labelConflict(route, task) ?? pathConflict(route, task) ?? repoConflict(route, task);
}

/** The candidates for a task, the routes pending on inferable answers,
 *  and the routes that did not make it.
 *
 *  `inferable` names the formula's declared questions (bro-0ykhg.2): a
 *  `match.features` key the task lacks pends instead of rejecting when
 *  the formula could still answer it. Everything else — a carried
 *  non-fit, a walled chain, a missing non-inferable field — rejects
 *  exactly as before. With no `inferable` set the output is identical
 *  to the pre-cascade contract: `pending` is empty. */
export function candidates(
  table: RouteTable,
  task: RouteTask,
  health: HealthSnapshot,
  opts?: { inferable?: ReadonlySet<string> }
): CandidateSet {
  const inferable = opts?.inferable ?? EMPTY_SET;
  const found: RouteCandidate[] = [];
  const pending: PendingRoute[] = [];
  const rejected: RejectedRoute[] = [];
  for (const route of table.routes) {
    const clash = conflict(route, task);
    if (clash !== undefined) {
      rejected.push({ route, reason: clash });
      continue;
    }
    const features = featureConflict(route, task, inferable);
    if (features.reject !== undefined) {
      rejected.push({ route, reason: features.reject });
      continue;
    }
    const live = survivingChain(route, health);
    if (live.chain.length === 0) {
      const why = live.dropped.map(d => d.reason).join(', ');
      rejected.push({ route, reason: `every model is walled — ${why}` });
      continue;
    }
    const shape = fit(route, task);
    if (features.needs.length > 0) {
      pending.push({
        route,
        score: shape.score,
        reasons: shape.reasons,
        needs: features.needs,
      });
      continue;
    }
    found.push({ route, ...shape });
  }
  // a stable sort keeps the table's own order among equals
  found.sort((a, b) => b.score - a.score);
  pending.sort((a, b) => b.score - a.score);
  return { candidates: found, pending, rejected };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** The set reordered into the table's DECLARATION order — the order the
 *  routes appear in the file. Fit order is candidates()' ranking; "table
 *  order" in the score contract (score.ts — tie-breaks and the skip
 *  fallback) is declaration order, and the two must not be conflated. */
export function inTableOrder(set: CandidateSet, table: RouteTable): CandidateSet {
  const at = new Map(table.routes.map((r, i) => [r.name, i]));
  const rank = (name: string): number => at.get(name) ?? Number.MAX_SAFE_INTEGER;
  return {
    candidates: [...set.candidates].sort((a, b) => rank(a.route.name) - rank(b.route.name)),
    rejected: set.rejected,
  };
}
