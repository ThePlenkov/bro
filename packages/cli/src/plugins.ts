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
  beadsSection,
  checkBeads,
  debtSection,
  definePlugin,
  loadConfig,
  planKind,
  readPlanDoc,
  registerConnector,
  sddSection,
  stackSection,
  syncSection,
  type BroPlugin,
  type ConfigSection,
  type DocType,
} from '@broject/core'
import { actConnector, parseActPlan, type ActPlan } from '@broject/act'
import { parseConvoyPlan, type ConvoyPlan } from '@broject/convoy'
import { debtConnector, parseDebtPlan, type DebtPlan } from '@broject/debt'
import { drillConnector, parseDrillPlan, type DrillPlan } from '@broject/drill'
import { parsePlanDoc, type RetroPlan } from '@broject/retro'
import { loopSection } from '@broject/loop'
import { githubConnector } from '@broject/github'
import { gitlabConnector } from '@broject/gitlab'
import { applyActPlan, runActCommand } from './commands/act.ts'
import { runCleanupCommand } from './commands/cleanup.ts'
import { applyConvoyPlan, runConvoyCommand } from './commands/convoy.ts'
import { runLoopCommand } from './commands/loop.ts'
import { applyNextPlan, runNextCommand } from './commands/next.ts'
import { parseNextPlan, type NextPlan } from './commands/next-plan.ts'
import { applyVerdicts, runDebtCommand } from './commands/debt.ts'
import { runDoctorCommand } from './commands/doctor.ts'
import { applyDrillPlan, runDrillCommand } from './commands/drill.ts'
import { runHooksCommand } from './commands/hooks.ts'
import { cmdRecord, runRetrospectCommand } from './commands/retrospect.ts'
import { runSetupCommand } from './commands/setup.ts'
import { runSpecCommand, sddConnector } from './commands/spec.ts'
import { runSyncCommand } from './commands/sync.ts'
import { runWorkCommand, workConnector } from './commands/work.ts'

// Built-in connectors register at module load, ahead of external
// plugins — registry order is the fallback precedence, and an external
// connector must not shadow a built-in system. Registration order also
// decides stop-gate block priority: drill > work > act.
registerConnector(githubConnector)
registerConnector(gitlabConnector)
registerConnector(drillConnector)
registerConnector(workConnector)
registerConnector(actConnector)
registerConnector(debtConnector)
registerConnector(sddConnector)

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
    planSchema: (doc, source) => parseConvoyPlan(doc, source),
    runPlan: (plan) => applyConvoyPlan(plan as ConvoyPlan),
  }),
  definePlugin({
    name: 'next',
    summary: 'Claim + emit the top ready bead — the autonomous backlog loop',
    run: runNextCommand,
    skill: 'next',
    planSchema: (doc, source) => parseNextPlan(doc, source),
    runPlan: (plan) => applyNextPlan(plan as NextPlan),
  }),
  definePlugin({
    name: 'loop',
    summary: 'Autonomous backlog runner — claim → agent → gate → close → repeat',
    run: runLoopCommand,
    skill: 'loop',
    configKey: 'loop',
    configSchema: loopSection,
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
    name: 'docs',
    summary: 'Doc-type dispatch — `bro <verb> <noun|ref>` (bro <verb> store|task)',
    // dispatch lives in index.ts's argv[0] fallback — this entry owns
    // the beads config section and keeps the registry honest
    hidden: true,
    run: () => process.exit(2),
    skill: 'docs',
    configKey: 'beads',
    configSchema: beadsSection,
  }),
  definePlugin({
    name: 'work',
    summary: 'Parallel-friendly worktrees: enter|leave|list|prune',
    run: runWorkCommand,
    skill: 'work',
    configKey: 'stack',
    configSchema: stackSection,
  }),
  definePlugin({
    name: 'spec',
    summary: 'Spec-driven development policy: check|new (sdd.mode gates hooks)',
    run: runSpecCommand,
    skill: 'sdd',
    configKey: 'sdd',
    configSchema: sddSection,
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
    name: 'doctor',
    summary: 'Environment diagnostics: node, git, gh auth, bd, hooks, config, remotes [--json]',
    run: runDoctorCommand,
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
  return PLUGIN_FIELD_CHECKS.every(([key, ok]) => o[key] === undefined || ok(o[key]))
}

/** Present-but-wrong optional fields — each predicate runs only when
 *  the field is defined. Table form keeps isPlugin flat as fields grow. */
const PLUGIN_FIELD_CHECKS: ReadonlyArray<
  [keyof BroPlugin, (v: unknown) => boolean]
> = [
  ['configSchema', (v) => typeof v === 'function'],
  ['planSchema', (v) => typeof v === 'function'],
  ['runPlan', (v) => typeof v === 'function'],
  ['skill', (v) => typeof v === 'string'],
  ['configKey', (v) => typeof v === 'string'],
  ['argvPrefix', (v) => Array.isArray(v)],
  ['docs', (v) => Array.isArray(v) && v.every(isDocType)],
  ['connectors', (v) => Array.isArray(v) && v.every(isConnector)],
]

/** A connectors entry must be a Connector — name + at least the shape
 *  registerConnector relies on — else facade resolution would crash. */
function isConnector(c: unknown): boolean {
  const o = c as { name?: unknown; matchRemote?: unknown }
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.name === 'string' &&
    o.name !== '' &&
    (o.matchRemote === undefined || typeof o.matchRemote === 'function')
  )
}

/** A docs entry must be a DocType — name + adapter factory — else it
 *  would crash docVerbs/docTypes deep in dispatch or --help. */
function isDocType(d: unknown): d is DocType {
  const o = d as DocType
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.name === 'string' &&
    o.name !== '' &&
    typeof o.adapter === 'function'
  )
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
function registerExternal(
  entry: unknown,
  spec: string,
  reserved?: ReadonlySet<string>
): BroPlugin | undefined {
  if (!isPlugin(entry)) {
    console.error(`warning: plugin "${spec}" export is not a BroPlugin — skipped`)
    return undefined
  }
  // plugin lookup wins argv[0] — a plugin named like a doc verb would
  // shadow `bro list`/`bro show`/`bro init` for every doc type
  if (reserved?.has(entry.name)) {
    console.error(
      `warning: plugin "${spec}" name "${entry.name}" is a doc verb — skipped`
    )
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
  for (const c of plugin.connectors ?? []) {
    registerConnector(c)
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
  specs: string[] = loadConfig(cwd).plugins,
  /** plugin names that must stay dispatchable to other layers (doc verbs) */
  reserved: ReadonlySet<string> = new Set()
): Promise<BroPlugin[]> {
  const loaded: BroPlugin[] = []
  // createRequire anchored at the repo keeps both `./x.ts` and bare
  // package specifiers resolving from the user's install, not the CLI's
  const req = createRequire(resolve(cwd, 'bro.config.json'))
  const root = resolve(cwd)
  for (const spec of specs) {
    const entries = await importPluginModule(spec, req, root)
    for (const entry of entries ?? []) {
      const plugin = registerExternal(entry, spec, reserved)
      if (plugin) {
        loaded.push(plugin)
      }
    }
  }
  return loaded
}
