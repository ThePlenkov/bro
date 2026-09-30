/**
 * BroPlugin — the unit every bro capability ships as: a CLI subcommand,
 * a skill, an owned config section, and (later) a plan schema (bro-cap).
 *
 * The CLI is a thin host: it dispatches argv[0] through a static registry
 * of BroPlugin entries instead of hardcoding commands.
 */
import type { ConfigSection } from './config.ts'
import type { Connector } from './connectors.ts'
import type { DocType } from './docs.ts'
import type { PlanSchema } from './plan.ts'

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
  /** Document types this plugin exposes to `bro <verb> <noun>` dispatch —
   *  adapter methods are the verb registry (see docs.ts). */
  docs?: DocType[]
  /** External systems this plugin integrates — facades are capability
   *  members (tasks, hooks, …); registered via registerConnector. */
  connectors?: Connector[]
  /** Plan validator — the plugin accepts TOML plans whose `kind` equals
   *  this plugin's name, routed by `bro run`. Pairs with runPlan. */
  planSchema?: PlanSchema<unknown>
  /** The schema version planSchema speaks — the contract `version = N`
   *  pins and `bro plan` advertises. Defaults to 1 when unset. */
  planVersion?: number
  /** Executes a planSchema-validated plan — `bro run <file>` calls this. */
  runPlan?: (plan: unknown) => void | Promise<void>
  /** Deprecation advice ("use `bro drill up`") — dispatch prints one
   *  stderr warning and still runs the command. Pair with `hidden:
   *  true` to drop it from `--help`; removal lands in a later release. */
  deprecated?: string
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
