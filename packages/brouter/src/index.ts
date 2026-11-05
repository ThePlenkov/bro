/**
 * @broject/brouter — the model router's client half.
 *
 * The router serves a catalog of models; every thin client holds that
 * list in its OWN vocabulary. This package owns the translation: the
 * served model, the client adapter seam, the adapters themselves, and
 * the reader that pulls the catalog off a running router.
 *
 * Nothing here depends on bro's rig — no beads, no bus, no fleet. The
 * router is a process with a published endpoint; this package talks to
 * it over HTTP.
 */
export {
  modelFamily,
  modelSource,
  servedModels,
  type ModelFamily,
  type ServedModel,
} from './catalog.ts';
export {
  mergeSettings,
  type ClientAdapter,
  type RouterEndpoint,
} from './adapter.ts';
export {
  CLAUDE_CODE_BEHAVES_AS,
  claudeCodeAdapter,
  claudeCodeRows,
  type ClaudeCodeRow,
} from './clients/claude-code.ts';
export { CLIENTS, clientById, clientIds } from './registry.ts';
export { routerPlugins, type RouterPolicy } from './plugins.ts';
export { catalogPlugins } from './catalog-plugins.ts';
export { clientPlugins } from './client-plugins.ts';
export { routePlugins } from './route-plugins.ts';
export { decisionProvider, requireTypedGrade, type DecisionProvider } from './decision-model.ts';
export { runHealthCommand } from './health-cmd.ts';
export { runRouteCommand } from './route-cmd.ts';
export { routeTablePath, runRoutesCommand } from './routes-cmd.ts';
export { runStoreCommand } from './store-cmd.ts';
export { configuredProviders, type ProviderRow } from './providers.ts';
export {
  requireClient,
  runClient,
  runModels,
  type ClientOutcome,
  type ClientRequest,
} from './commands.ts';
export {
  gitCommonDir,
  readCatalog,
  readRouterEndpoint,
  routerStatePath,
} from './gateway.ts';
export { expandHome, readSettings, writeSettings } from './settings.ts';
