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
  type ClientAdapter,
  mergeSettings,
  type RouterEndpoint,
} from './adapter.ts';
export {
  type ModelFamily,
  modelFamily,
  modelSource,
  type ServedModel,
  servedModels,
} from './catalog.ts';
export { catalogPlugins } from './catalog-plugins.ts';
export { clientPlugins } from './client-plugins.ts';
export {
  CLAUDE_CODE_BEHAVES_AS,
  type ClaudeCodeRow,
  claudeCodeAdapter,
  claudeCodeRows,
} from './clients/claude-code.ts';
export {
  type ClientOutcome,
  type ClientRequest,
  requireClient,
  runClient,
  runModels,
} from './commands.ts';
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
  routerStatePath,
} from './gateway.ts';
export { routerUrl } from './router-url.ts';
export { expandHome, readSettings, writeSettings } from './settings.ts';
export {
  formatSettingsDiff,
  type SettingsChange,
  settingsDiff,
} from './settings-diff.ts';
export { runStoreCommand } from './store-cmd.ts';
