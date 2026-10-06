/**
 * `bro query <plan.toml>` — validate + run a `kind = "query"` plan in
 * one step, over the same resolvePlanDoc pipeline `bro run` uses
 * (spec bro-14h8.1, milestone 6). There is no second parser — this
 * command is the convenience surface.
 *
 *   bro query <file>    run a query plan — raw JSON on stdout,
 *                       exit 1 when any step failed
 */
import { resolvePlanDoc } from './plan.ts'
import type { BroPlugin } from '@broject/core'

export async function runQueryCommand(
  argv: string[],
  plugins: readonly BroPlugin[]
): Promise<void> {
  const files = argv.filter((a) => !a.startsWith('-'))
  if (files.length !== 1) {
    console.error('usage: bro query <plan.toml>')
    process.exit(2)
  }
  const file = files[0] as string
  const { plugin, plan } = resolvePlanDoc(file, plugins)
  if (plugin.name !== 'query' || !plugin.runPlan) {
    throw new Error(`${file}: expected a kind = "query" plan, got kind = "${plugin.name}"`)
  }
  // the plugin's runPlan owns the exit code — a failed step exits 1
  await plugin.runPlan(plan)
}
