/**
 * @broject/brouter — the model router.
 *
 * The router serves a catalog of models and drives the agents behind
 * it: the served model, the catalog read off a running router, the
 * route table and the decision model, the outcome ledger. The thin-
 * client adapters — rendering the catalog in each client's own
 * vocabulary (Claude Code's `modelPicker` and its kin) — are
 * `@broject/client-adapters`, which reads this package's public API;
 * brouter never imports the adapters.
 *
 * Nothing here depends on bro's rig — no beads, no bus, no fleet. The
 * router is a process with a published endpoint; this package talks to
 * it over HTTP.
 */

export { agentPlugins } from './agent-plugins.ts';
export {
  type ModelFamily,
  modelFamily,
  type ServedModel,
  servedModels,
} from './catalog.ts';
export { catalogPlugins } from './catalog-plugins.ts';
export { decisionContextId, journalDecision, taskTextRetentionDays } from './context.ts';
export { runModels } from './commands.ts';
export { type DecisionProvider, decisionProvider, requireTypedGrade } from './decision-model.ts';
export {
  chainModelFacts,
  costFacts,
  healthFacts,
  type ModelPick,
  type ModelPin,
  modelFacts,
  routeFacts,
  type TurnUsage,
  type WindowCounters,
} from './explain.ts';
export {
  gitCommonDir,
  readCatalog,
  readRouterEndpoint,
  type RouterEndpoint,
  routerStatePath,
} from './gateway.ts';
export { runOutcomeCommand } from './outcome-cmd.ts';
export { runHealthCommand } from './health-cmd.ts';
export { ledgerHealth, recordTurn, windowCounters } from './ledger.ts';
export { BOOL_FLAGS, endpointFor, VALUE_FLAGS } from './policy.ts';
export { type RouterPolicy, routerPlugins } from './plugins.ts';
export { configuredProviders, type ProviderRow } from './providers.ts';
export { runRouteCommand } from './route-cmd.ts';
export { decideRoute, type DecisionLinks, type TaskDecision } from './route-decide.ts';
export { routePlugins } from './route-plugins.ts';
export { routerUrl } from './router-url.ts';
export { routeTablePath, runRoutesCommand } from './routes-cmd.ts';
export { runStatsOutcomesCommand } from './stats-cmd.ts';
export { runStoreCommand } from './store-cmd.ts';
