/**
 * @broject/router-routes — the route table.
 *
 * A route says which models a task may land on and when it fits. The
 * table is the operator's declaration; the health (the router's own
 * ledger) and the decision model (a judge) read it, they never rewrite
 * it.
 *
 * No IO beyond reading the table itself: the candidates and the resolver
 * are pure, so the spawn path can call them without a round trip.
 */
export {
  candidates,
  survivingChain,
  type CandidateSet,
  type RejectedRoute,
  type RouteCandidate,
  type RouteTask,
} from './candidates.ts';
export { resolveRoute, type RouteDecision } from './resolve.ts';
export {
  unservedChains,
  type ServedDeclaration,
  type UnservedChain,
} from './served.ts';
export {
  parseRouteDoc,
  readRouteTable,
  routeTable,
  ROUTE_KIND,
  ROUTE_VERSION,
  RouteTableError,
} from './schema.ts';
export type { Route, RouteMatch, RouteTable } from './types.ts';
