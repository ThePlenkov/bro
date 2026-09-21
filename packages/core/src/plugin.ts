/**
 * BroPlugin — the unit every bro capability ships as: a CLI subcommand,
 * a skill, an owned config section, and (later) a plan schema (bro-cap).
 *
 * The CLI is a thin host: it dispatches argv[0] through a static registry
 * of BroPlugin entries instead of hardcoding commands.
 */
import type { ConfigSection } from './config.ts'

export interface BroPlugin {
  /** Subcommand name — argv[0]. */
  name: string
  /** One-liner for `bro --help` / `bro plugins`. */
  summary: string
  run: (argv: string[]) => void | Promise<void>
  /** Fixed args prepended before user argv — how `wtf` maps to
   *  `retrospect capture` without a second plugin entry. */
  argvPrefix?: string[]
  /** skills/<name> source dir the adapter generators emit. */
  skill?: string
  /** bro.config.* top-level key this plugin owns. */
  configKey?: string
  /** Normalizer for the configKey section — raw file value in, typed
   *  section out. Required when configKey is set. */
  configSchema?: ConfigSection<unknown>
  /** Not listed in usage — plumbing commands like `hooks`. */
  hidden?: boolean
  /** Set by the registry when the plugin came from config `plugins` —
   *  not part of the author-facing contract. */
  external?: boolean
}

/** Identity helper — typed declaration sites, same role as defineConfig. */
export function definePlugin<P extends BroPlugin>(plugin: P): P {
  return plugin
}
