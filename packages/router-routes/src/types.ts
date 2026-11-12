/**
 * The route table's shapes — a route, its match, and the table itself.
 *
 * A route says WHICH models a task may land on (the chain) and WHEN it
 * fits (the match). The table is the operator's declaration; the health
 * and the decision model read it, they never rewrite it.
 */
import type { ChainEntry, OnWall } from '@broject/core';

/** A typed feature value — what a formula question answers, and what a
 *  task may carry. Choice answers are strings, bool answers booleans,
 *  score answers numbers; the match compares them literally — no
 *  implicit conversion between levels. */
export type FeatureValue = string | number | boolean;

/** What a `match.features` entry accepts — one value (exact fit) or a
 *  list (membership fit). */
export type FeatureMatch = FeatureValue | FeatureValue[];

/** When a route fits — the task's shape, as the operator sees it. A
 *  route that pins nothing fits every task (the catch-all); a route that
 *  pins a field needs the task to carry it. */
export interface RouteMatch {
  /** the task type ("edit", "design", …) */
  type?: string;
  /** the complexity band ("low", "mid", "high") */
  complexity?: string;
  /** the priority band ("P0", "P1", "P2") */
  priority?: string;
  /** the formula features the task must carry — keys name the formula's
   *  declared questions; values match literally (scalar = exact, list =
   *  membership). Only `choice` and `bool` questions may drive these —
   *  a numeric `score` answer is not a level. */
  features?: Record<string, FeatureMatch>;
}

/** One route — a name, a match, and the chain a request lands on. */
export interface Route {
  /** the route's name — the table's key */
  name: string;
  match: RouteMatch;
  chain: ChainEntry[];
  /** what to do when the chain is walled — the fleet's vocabulary */
  onWall?: OnWall;
  /** the md file with the prose the decision model reads */
  prompt?: string;
  /** the one-liner the decision model sees as the criterion */
  description?: string;
}

/** The table — the routes, and the schema it was written against. */
export interface RouteTable {
  kind: 'route';
  version: number;
  routes: Route[];
}
