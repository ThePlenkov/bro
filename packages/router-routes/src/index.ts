/**
 * @broject/router-routes — the route table and the routing formula.
 *
 * A route says which models a task may land on and when it fits. The
 * table is the operator's declaration; the health (the router's own
 * ledger) and the decision model (a judge) read it, they never rewrite
 * it. The formula is the other half of the declaration: one md file
 * whose frontmatter is the machine contract (typed questions, hard
 * filters, score weights) and whose body is the prose the decision
 * model reads.
 *
 * No IO beyond reading the table and the formula themselves: the
 * candidates, the resolver, the filters and the scoring are pure, so
 * the spawn path can call them without a round trip.
 */
export {
  candidates,
  inTableOrder,
  survivingChain,
  type CandidateSet,
  type RejectedRoute,
  type RouteCandidate,
  type RouteTask,
} from './candidates.ts';
export { resolveRoute, type ResolveExtras, type RouteDecision } from './resolve.ts';
export {
  unservedChains,
  type ServedDeclaration,
  type UnservedChain,
} from './served.ts';
export {
  applyFormulaFilters,
  FORMULA_KIND,
  FORMULA_VERSION,
  FormulaError,
  formulaAnswersToFeatures,
  formulaDoc,
  formulaQuestions,
  mergeTaskFeatures,
  parseFormulaText,
  readFormula,
  validateFormulaTable,
  type Formula,
  type FormulaAnswerTrace,
  type FormulaFilter,
  type FormulaFilterTrace,
  type FormulaQuestion,
  type FormulaScoreTrace,
  type FormulaScoreWeights,
  type FormulaShape,
  type FormulaTrace,
  type SuccessPredicate,
} from './formula.ts';
export {
  type CandidateScore,
  priorOnlyOutcomes,
  type OutcomeStatsSource,
  type RouteOutcomeStats,
  type ScoreResult,
  scoreCandidates,
} from './score.ts';
export {
  parseRouteDoc,
  readRouteTable,
  routeTable,
  ROUTE_KIND,
  ROUTE_VERSION,
  RouteTableError,
} from './schema.ts';
export type { FeatureMatch, FeatureValue, Route, RouteMatch, RouteTable } from './types.ts';
