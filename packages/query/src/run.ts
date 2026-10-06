/**
 * applyQueryPlan — pooled fan-out over the `queries` facade (spec
 * bro-14h8.1). Each step resolves its connector independently
 * (`provider` field → connectors.queries pin → auto-detect), runs the
 * raw document, and lands as a keyed entry in one buffered JSON
 * document — output order is declaration order, never completion
 * order. A failed step records `{ provider, error }`; a completed call
 * keeps `{ provider, data?, errors? }` verbatim. Any failure — a
 * transport error or a non-empty GraphQL `errors` — marks `ok: false`
 * and the process exits 1; results still print, partial answers are
 * machine-usable.
 */
import { facade, facadeName, loadConfig } from '@broject/core'
import type { ConnectorCtx } from '@broject/core'
import type { QueryPlan, QueryStep } from './plan.ts'

export interface StepResult {
  provider?: string
  data?: unknown
  errors?: unknown
  error?: string
}

export interface QueryPlanResult {
  ok: boolean
  steps: Record<string, StepResult>
}

/** The resolved connector's name for error attribution — a named
 *  `provider` echoes itself; an auto-detected resolution reports the
 *  connector that actually served. */
function providerName(step: QueryStep, ctx: ConnectorCtx, prefer: Record<string, string>): string {
  if (step.provider !== undefined) {
    return step.provider
  }
  try {
    return facadeName('queries', ctx, { prefer })
  } catch {
    return prefer['queries'] ?? 'auto'
  }
}

/** A step "failed" when the CLI failed (transport `error`) OR the
 *  completed response carries a non-empty top-level `errors` — a
 *  partially denied response is not clean success even when `data`
 *  came back too. */
function stepFailed(r: StepResult): boolean {
  if (r.error !== undefined) {
    return true
  }
  return Array.isArray(r.errors) && r.errors.length > 0
}

/** Run the plan, print the merged JSON to stdout, return the exit
 *  code (1 on any step failure). Never throws for step failures —
 *  parse/resolution errors still throw before any step runs. */
export async function applyQueryPlan(plan: QueryPlan, dir = process.cwd()): Promise<number> {
  const cfg = loadConfig(dir)
  const prefer = cfg.connectors
  const ctx: ConnectorCtx = { dir }
  const cap = Math.max(1, plan.concurrency ?? cfg.query.concurrency)

  const results: Record<string, StepResult> = {}
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(cap, plan.steps.length) }, async () => {
      while (next < plan.steps.length) {
        const step = plan.steps[next++]! // NOSONAR — serial within a worker; workers overlap
        results[step.id] = await runStep(step, ctx, prefer, cfg.query.env)
      }
    })
  )

  const ordered: Record<string, StepResult> = {}
  for (const step of plan.steps) {
    ordered[step.id] = results[step.id]!
  }
  const ok = !Object.values(ordered).some(stepFailed)
  console.log(JSON.stringify({ ok, steps: ordered }, null, 2))
  return ok ? 0 : 1
}

async function runStep(
  step: QueryStep,
  ctx: ConnectorCtx,
  prefer: Record<string, string>,
  configEnv: Record<string, string>
): Promise<StepResult> {
  const provider = providerName(step, ctx, prefer)
  try {
    const f = facade('queries', ctx, { connector: step.provider, prefer })
    const res = await f.graphql(step.graphql, {
      vars: step.vars,
      env: { ...configEnv, ...step.env },
    })
    const out: StepResult = { provider }
    if (res.data !== undefined) {
      out.data = res.data
    }
    if (res.errors !== undefined) {
      out.errors = res.errors
    }
    return out
  } catch (err) {
    return { provider, error: err instanceof Error ? err.message : String(err) }
  }
}
