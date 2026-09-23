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
  checkBeads,
  debtSection,
  definePlugin,
  loadConfig,
  planKind,
  readPlanDoc,
  syncSection,
  type BroPlugin,
  type ConfigSection,
} from '@bro/core'
import { parseActPlan, type ActPlan } from '@bro/act'
import { parseDebtPlan, type DebtPlan } from '@bro/debt'
import { parseDrillPlan, type DrillPlan } from '@bro/drill'
import { parsePlanDoc, type RetroPlan } from '@bro/retro'
import { applyActPlan, runActCommand } from './commands/act.ts'
import { runCleanupCommand } from './commands/cleanup.ts'
import { runConvoyCommand } from './commands/convoy.ts'
import { runNextCommand } from './commands/next.ts'
import { applyVerdicts, runDebtCommand } from './commands/debt.ts'
import { applyDrillPlan, runDrillCommand } from './commands/drill.ts'
import { runHooksCommand } from './commands/hooks.ts'
import { cmdRecord, runRetrospectCommand } from './commands/retrospect.ts'
import { runSetupCommand } from './commands/setup.ts'
import { runSyncCommand } from './commands/sync.ts'
import { runWorkCommand } from './commands/work.ts'

export const PLUGINS: BroPlugin[] = [
  definePlugin({
    name: 'debt',
    summary: 'Review-debt pipeline: collect|status|prs|list|mark|sync|set',
    run: runDebtCommand,
    skill: 'debt',
    configKey: 'debt',
    configSchema: debtSection,
    planSchema: (doc, source) => parseDebtPlan(doc, source),
    runPlan: (plan) => applyVerdicts((plan as DebtPlan).verdicts),
  }),
  definePlugin({
    name: 'act',
    summary: 'Open-PR loop: status|threads|resolve|reply|merge',
    run: runActCommand,
    skill: 'act',
    configKey: 'act',
    configSchema: actSection,
    planSchema: (doc, source) => parseActPlan(doc, source),
    runPlan: (plan) => applyActPlan(plan as ActPlan),
  }),
  definePlugin({
    name: 'convoy',
    summary: 'Convoy execution over beads molecules: status|next|done|pour|list',
    run: runConvoyCommand,
    skill: 'convoy',
  }),
  definePlugin({
    name: 'next',
    summary: 'Claim + emit the top ready bead — the autonomous backlog loop',
    run: runNextCommand,
    skill: 'next',
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
    planSchema: (doc, source) => parseDrillPlan(doc, source),
    runPlan: (plan) => applyDrillPlan(plan as DrillPlan),
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
    planSchema: (doc, source) => parsePlanDoc(doc, source),
    runPlan: (plan) => {
      checkBeads()
      cmdRecord(plan as RetroPlan)
    },
  }),
  definePlugin({
    name: 'wtf',
    summary: 'Alias for `retrospect capture` — vent, verbatim',
    // bare `bro wtf` has nothing to capture — report open wtfs instead
    run: (argv) =>
      runRetrospectCommand(argv.length === 0 ? ['status'] : ['capture', ...argv]),
  }),
  definePlugin({
    name: 'work',
    summary: 'Parallel-friendly worktrees: enter|leave|list|prune',
    run: runWorkCommand,
    skill: 'work',
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
    name: 'run',
    summary: 'Execute a plan file — `kind` routes to the owning plugin',
    run: (argv) => runPlanFile(argv),
  }),
  definePlugin({
    name: 'plugins',
    summary: 'List registered plugins — name, skill, config section',
    run() {
      for (const p of PLUGINS) {
        const src = p.external ? 'ext' : 'core'
        const plan = p.planSchema ? 'plan' : '-'
        console.log(
          `${p.name.padEnd(12)} ${(p.skill ?? '-').padEnd(10)} ${(p.configKey ?? '-').padEnd(8)} ${src.padEnd(4)} ${plan.padEnd(4)} ${p.summary}`
        )
      }
    },
  }),
]

/** `bro run <plan.toml>` — parse the file, route on `kind`, validate with
 *  the owning plugin's planSchema, execute via runPlan. */
export async function runPlanFile(argv: string[]): Promise<void> {
  const files = argv.filter((a) => !a.startsWith('-'))
  const kinds = PLUGINS.filter((p) => p.planSchema).map((p) => p.name)
  if (files.length !== 1) {
    console.error(`usage: bro run <plan.toml> — plan kinds: ${kinds.join(', ') || '(none)'}`)
    process.exit(2)
  }
  const file = files[0] as string
  const doc = readPlanDoc(file)
  const kind = planKind(doc)
  if (!kind) {
    throw new Error(`${file}: no kind field — known plan kinds: ${kinds.join(', ')}`)
  }
  const plugin = PLUGINS.find((p) => p.name === kind)
  if (!plugin) {
    throw new Error(`${file}: kind "${kind}" is unknown — known plan kinds: ${kinds.join(', ')}`)
  }
  if (!plugin.planSchema || !plugin.runPlan) {
    throw new Error(`${file}: plugin "${kind}" does not accept plans`)
  }
  await plugin.runPlan(plugin.planSchema(doc, file))
}

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

/** Imports one specifier → exported candidate entries, or undefined on
 *  failure (warned). Relative specs must resolve inside the repo root —
 *  `../../etc/evil.ts` must not become a plugin just because config says so. */
async function importPluginModule(
  spec: string,
  req: ReturnType<typeof createRequire>,
  root: string
): Promise<unknown[] | undefined> {
  try {
    const resolved = req.resolve(spec)
    const rel = relative(root, resolved)
    if (spec.startsWith('.') && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new Error('plugin path escapes the repo root')
    }
    const mod = (await import(pathToFileURL(resolved).href)) as {
      default?: unknown
    }
    const exported = mod.default ?? mod
    return Array.isArray(exported) ? exported : [exported]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`warning: plugin "${spec}" failed to load (${msg}) — skipped`)
    return undefined
  }
}

/** Validates + registers one export; undefined = rejected (warned). */
function registerExternal(entry: unknown, spec: string): BroPlugin | undefined {
  if (!isPlugin(entry)) {
    console.error(`warning: plugin "${spec}" export is not a BroPlugin — skipped`)
    return undefined
  }
  if (PLUGINS.some((p) => p.name === entry.name)) {
    console.error(`warning: plugin "${spec}" name "${entry.name}" is taken — skipped`)
    return undefined
  }
  const plugin: BroPlugin = { ...entry, external: true }
  // a registered configKey is owned — an external plugin must not
  // shadow a builtin (or earlier external) section schema
  if (plugin.configKey && PLUGINS.some((p) => p.configKey === plugin.configKey)) {
    console.error(
      `warning: plugin "${spec}" configKey "${plugin.configKey}" is already owned — its configSchema is ignored`
    )
    delete plugin.configKey
    delete plugin.configSchema
  }
  PLUGINS.push(plugin)
  return plugin
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
    const entries = await importPluginModule(spec, req, root)
    for (const entry of entries ?? []) {
      const plugin = registerExternal(entry, spec)
      if (plugin) {
        loaded.push(plugin)
      }
    }
  }
  return loaded
}
