/**
 * @broject/client-adapters — the router's client half.
 *
 * The router serves a catalog of models; every thin client holds that
 * list in its OWN vocabulary. This package owns the translation: the
 * client adapter seam, the adapters themselves, the settings-file
 * merge and its dry-run diff, and the `client` command that runs it.
 *
 * The catalog is READ through `@broject/brouter`'s public API — the
 * dependency points one way only: brouter never imports the adapters.
 * Nothing here depends on bro's rig — no beads, no bus, no fleet.
 */

export { type ClientAdapter, mergeSettings, type RouterEndpoint } from './adapter.ts';
export {
  type ClientOutcome,
  type ClientRequest,
  requireClient,
  runClient,
} from './commands.ts';
export {
  CLAUDE_CODE_BEHAVES_AS,
  type ClaudeCodeRow,
  claudeCodeAdapter,
  claudeCodeRows,
} from './clients/claude-code.ts';
export { clientAdapterPlugins } from './plugins.ts';
export { CLIENTS, clientById, clientIds } from './registry.ts';
export { expandHome, readSettings, writeSettings } from './settings.ts';
export {
  formatSettingsDiff,
  type SettingsChange,
  settingsDiff,
} from './settings-diff.ts';
