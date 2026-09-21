/**
 * Plugin registry — every bro capability as a BroPlugin: subcommand +
 * skill + owned config section (+ plan schema later, bro-cap). The CLI
 * dispatches argv[0] through this list; nothing is hardcoded in main.
 */
import {
  actSection,
  debtSection,
  definePlugin,
  loadConfig,
  syncSection,
  type BroPlugin,
  type ConfigSection,
} from '@bro/core'
import { runActCommand } from './commands/act.ts'
import { runCleanupCommand } from './commands/cleanup.ts'
import { runConvoyCommand } from './commands/convoy.ts'
import { runDebtCommand } from './commands/debt.ts'
import { runDrillCommand } from './commands/drill.ts'
import { runHooksCommand } from './commands/hooks.ts'
import { runRetrospectCommand } from './commands/retrospect.ts'
import { runSetupCommand } from './commands/setup.ts'
import { runSyncCommand } from './commands/sync.ts'

export const PLUGINS: BroPlugin[] = [
  definePlugin({
    name: 'debt',
    summary: 'Review-debt pipeline: collect|status|prs|list|mark|sync|set',
    run: runDebtCommand,
    skill: 'debt',
    configKey: 'debt',
    configSchema: debtSection,
  }),
  definePlugin({
    name: 'act',
    summary: 'Open-PR loop: status|threads|resolve|reply|merge',
    run: runActCommand,
    skill: 'act',
    configKey: 'act',
    configSchema: actSection,
  }),
  definePlugin({
    name: 'convoy',
    summary: 'Convoy execution over beads molecules: status|next|done|pour|list',
    run: runConvoyCommand,
    skill: 'convoy',
  }),
  definePlugin({
    name: 'cleanup',
    summary: 'Delete local branches whose PR merged [--remote] [--dry-run]',
    run: runCleanupCommand,
  }),
  definePlugin({
    name: 'drill',
    summary: 'Scoped descent over beads: down|up|current|tree|list|distill',
    run: runDrillCommand,
    skill: 'drill',
  }),
  definePlugin({
    name: 'unwind',
    summary: 'Alias for `drill up`',
    run: runDrillCommand,
    argvPrefix: ['up'],
  }),
  definePlugin({
    name: 'retrospect',
    summary: 'Self-correction: capture|record|status|list|schema',
    run: runRetrospectCommand,
    skill: 'wtf',
  }),
  definePlugin({
    name: 'wtf',
    summary: 'Alias for `retrospect capture` — vent, verbatim',
    run: runRetrospectCommand,
    argvPrefix: ['capture'],
  }),
  definePlugin({
    name: 'hooks',
    summary: 'Agent lifecycle hooks',
    run: runHooksCommand,
    hidden: true,
  }),
  definePlugin({
    name: 'setup',
    summary: 'Wire bro into the current repo',
    run: runSetupCommand,
  }),
  definePlugin({
    name: 'sync',
    summary: 'Push/pull artifact dirs on refs/bro/data [--pull]',
    run: runSyncCommand,
    skill: 'sync',
    configKey: 'sync',
    configSchema: syncSection,
  }),
  definePlugin({
    name: 'plugins',
    summary: 'List registered plugins — name, skill, config section',
    run() {
      for (const p of PLUGINS) {
        console.log(
          `${p.name.padEnd(12)} ${(p.skill ?? '-').padEnd(10)} ${(p.configKey ?? '-').padEnd(8)} ${p.summary}`
        )
      }
    },
  }),
]

/** configKey → configSchema across the registry — what `loadConfig`
 *  applies on top of core sections. External plugins register here too. */
export function pluginConfigSections(): Record<string, ConfigSection<unknown>> {
  return Object.fromEntries(
    PLUGINS.filter((p) => p.configKey && p.configSchema).map((p) => [
      p.configKey as string,
      p.configSchema as ConfigSection<unknown>,
    ])
  )
}

/** loadConfig + registered plugin sections — the CLI's config entrypoint. */
export function loadBroConfig(cwd: string = process.cwd()) {
  return loadConfig(cwd, pluginConfigSections())
}
