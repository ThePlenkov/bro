/**
 * The plugin declaration — a leaf command.
 *
 * Generic on purpose: the bootstrap knows a plugin's name, its
 * one-liner and how to run it. A host's own extras (a skill directory,
 * a doc type, a connector, a plan schema) ride on the declaration as
 * extra fields — the bootstrap neither reads nor forbids them.
 */

/** A leaf command. */
export interface CommandPlugin {
  /** the command name — argv[0] inside its parent */
  name: string;
  /** the one-liner in the parent's member table */
  summary: string;
  /** the command's own implementation */
  run: (argv: string[]) => void | Promise<void>;
  /** fixed args prepended before the user's argv */
  argvPrefix?: string[];
  /** the capability group this plugin belongs to (the parent table's
   *  grouping) — optional; a host may use it to build its own tree */
  group?: string;
  /** not listed in usage — plumbing commands */
  hidden?: boolean;
  /** deprecation advice for this spelling */
  deprecated?: string;
  /** flat-spelling-only deprecation — the grouped spelling stays silent */
  flatDeprecated?: string;
  /** this entry is a spelling for another plugin */
  aliasOf?: string;
}

/** Identity helper — typed declaration sites. */
export function definePlugin<P extends CommandPlugin>(plugin: P): P {
  return plugin;
}
