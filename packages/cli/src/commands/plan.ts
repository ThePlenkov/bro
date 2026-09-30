/**
 * `bro plan` — the plan contract surface: which kinds exist and at what
 * schema version, plus `validate` so an author can check a file before
 * `bro run` executes it.
 *
 *   bro plan                    list plan kinds + schema versions
 *   bro plan validate <file>    validate without executing — same TOML
 *                               parse → kind routing → version gate →
 *                               planSchema pipeline `bro run` applies,
 *                               minus runPlan
 *
 * resolvePlanDoc is the shared resolve step — `bro run` (plugins.ts)
 * calls it too, so validate can never disagree with execute.
 */
import { checkPlanVersion, planKind, readPlanDoc } from '@broject/core'
import type { BroPlugin } from '@broject/core'

/** Parse + route + schema-validate a plan file — the `bro run` pipeline
 *  minus execution. Returns the owning plugin and the validated plan;
 *  the caller decides whether to runPlan or just report. */
export function resolvePlanDoc(
  file: string,
  plugins: readonly BroPlugin[]
): { plugin: BroPlugin; plan: unknown } {
  const kinds = plugins.filter((p) => p.planSchema && p.runPlan).map((p) => p.name)
  const doc = readPlanDoc(file)
  const kind = planKind(doc)
  if (!kind) {
    throw new Error(`${file}: no kind field — known plan kinds: ${kinds.join(', ')}`)
  }
  const plugin = plugins.find((p) => p.name === kind)
  if (!plugin) {
    throw new Error(`${file}: kind "${kind}" is unknown — known plan kinds: ${kinds.join(', ')}`)
  }
  if (!plugin.planSchema || !plugin.runPlan) {
    throw new Error(`${file}: plugin "${kind}" does not accept plans`)
  }
  // the version gate runs before the schema: a contract pinned newer
  // than this bro understands must fail loudly, never misparse
  const verrs: string[] = []
  checkPlanVersion(doc.version, kind, plugin.planVersion ?? 1, verrs)
  if (verrs.length > 0) {
    throw new Error(`${file}:\n  ${verrs.join('\n  ')}`)
  }
  return { plugin, plan: plugin.planSchema(doc, file) }
}

function usage(): never {
  console.error(`Usage: bro plan [command]

Commands:
  list              plan kinds and their schema versions (default)
  validate <file>   validate a plan file without executing it`)
  process.exit(2)
}

export function runPlanCommand(argv: string[], plugins: readonly BroPlugin[]): void {
  const [sub, ...rest] = argv
  const positional = rest.filter((a) => !a.startsWith('-'))
  if (sub === undefined || sub === 'list') {
    for (const p of plugins.filter((x) => x.planSchema && x.runPlan)) {
      console.log(
        `${p.name.padEnd(12)} v${p.planVersion ?? 1}${p.external ? ' (external)' : ''}`
      )
    }
    return
  }
  if (sub === 'validate') {
    if (positional.length !== 1) {
      console.error('error: bro plan validate takes exactly one file — `bro plan validate <plan.toml>`')
      process.exit(2)
    }
    const file = positional[0] as string
    const { plugin } = resolvePlanDoc(file, plugins)
    console.log(`${file}: ok — ${plugin.name} plan, schema v${plugin.planVersion ?? 1}`)
    return
  }
  usage()
}
