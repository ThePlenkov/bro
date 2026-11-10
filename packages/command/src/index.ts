/**
 * @broject/command — a bootstrap for ANY CLI.
 *
 * A command IS a CLI: it holds plugins (leaf commands) and commands
 * (nested commands). A BIN mounts a command and decides what is
 * executable — and because a command is self-contained, any command can
 * be mounted as a bin of its own.
 *
 * Zero dependencies: the bootstrap is the bottom of the stack. Every
 * CLI above it may differ in everything but the dispatch.
 */
export {
  defineCommand,
  groupTable,
  membersOf,
  pluginsOf,
  runCommand,
  usageText,
  type Command,
  type CommandSpec,
  type PluginSource,
} from './command.ts';
export {
  EXIT,
  printUsage,
  setUsageWriter,
  warnDeprecated,
  type ExitCode,
  type UsageWriter,
} from './exits.ts';
export { definePlugin, type CommandPlugin } from './plugin.ts';
export {
  isPlugin,
  pluginGroups,
  registerExternal,
  type ExternalRefusal,
} from './registry.ts';
