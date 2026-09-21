/**
 * Plugin registry — every bro capability as a BroPlugin: subcommand +
 * skill + owned config section (+ plan schema later, bro-cap). The CLI
 * dispatches argv[0] through this list; nothing is hardcoded in main.
 */
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
        const src = p.external ? 'ext' : 'core'
        console.log(
          `${p.name.padEnd(12)} ${(p.skill ?? '-').padEnd(10)} ${(p.configKey ?? '-').padEnd(8)} ${src.padEnd(4)} ${p.summary}`
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

function isPlugin(p: unknown): p is BroPlugin {
  const o = p as BroPlugin
  if (
    !o ||
    typeof o !== 'object' ||
    typeof o.name !== 'string' ||
    o.name === '' ||
    typeof o.summary !== 'string' ||
    typeof o.run !== 'function'
  ) {
    return false
  }
  // optional fields must be the right type when present — a truthy
  // non-function configSchema would crash config loading later
  if (o.configSchema !== undefined && typeof o.configSchema !== 'function') return false
  if (o.planSchema !== undefined && typeof o.planSchema !== 'function') return false
  if (o.runPlan !== undefined && typeof o.runPlan !== 'function') return false
  if (o.skill !== undefined && typeof o.skill !== 'string') return false
  if (o.configKey !== undefined && typeof o.configKey !== 'string') return false
  if (o.argvPrefix !== undefined && !Array.isArray(o.argvPrefix)) return false
  return true
}

/** Imports config `plugins` specifiers relative to the repo and registers
 *  valid BroPlugin exports. A bad module or export warns and is skipped —
 *  one broken plugin must never take the whole CLI down. Returns what was
 *  registered (mainly so tests can unload). */
export async function loadExternalPlugins(
  cwd: string = process.cwd(),
  /** injectable for tests/callers that already loaded config */
  specs: string[] = loadConfig(cwd).plugins
): Promise<BroPlugin[]> {
  const loaded: BroPlugin[] = []
  // createRequire anchored at the repo keeps both `./x.ts` and bare
  // package specifiers resolving from the user's install, not the CLI's
  const req = createRequire(resolve(cwd, 'bro.config.json'))
  const root = resolve(cwd)
  for (const spec of specs) {
    let entries: unknown[]
    try {
      const resolved = req.resolve(spec)
      // relative specs must stay inside the repo — `../../etc/evil.ts`
      // must not become a plugin just because the config says so
      const rel = relative(root, resolved)
      if (spec.startsWith('.') && (rel.startsWith('..') || isAbsolute(rel))) {
        throw new Error('plugin path escapes the repo root')
      }
      const mod = (await import(pathToFileURL(resolved).href)) as {
        default?: unknown
      }
      const exported = mod.default ?? mod
      entries = Array.isArray(exported) ? exported : [exported]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`warning: plugin "${spec}" failed to load (${msg}) — skipped`)
      continue
    }
    for (const entry of entries) {
      if (!isPlugin(entry)) {
        console.error(`warning: plugin "${spec}" export is not a BroPlugin — skipped`)
        continue
      }
      if (PLUGINS.some((p) => p.name === entry.name)) {
        console.error(`warning: plugin "${spec}" name "${entry.name}" is taken — skipped`)
        continue
      }
      const plugin: BroPlugin = { ...entry, external: true }
      // a registered configKey is owned — an external plugin must not
      // shadow a builtin (or earlier external) section schema
      if (
        plugin.configKey &&
        PLUGINS.some((p) => p.configKey === plugin.configKey)
      ) {
        console.error(
          `warning: plugin "${spec}" configKey "${plugin.configKey}" is already owned — its configSchema is ignored`
        )
        delete plugin.configKey
        delete plugin.configSchema
      }
      PLUGINS.push(plugin)
      loaded.push(plugin)
    }
  }
  return loaded
}
