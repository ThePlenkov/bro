/**
 * Unified plans (bro-cap): every structured command accepts a TOML plan
 * file carrying a `kind` envelope — `bro run <file>` routes on it to the
 * plugin whose name matches, validates via its planSchema, and executes
 * via runPlan. `retrospect` is the reference implementation.
 */
import { readFileSync } from 'node:fs'
import { parse } from 'smol-toml'

/** A plugin's plan validator: parsed TOML doc in, typed plan out.
 *  Throw with every problem listed — the agent fixes the file once. */
export type PlanSchema<T> = (doc: unknown, source?: string) => T

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads + TOML-parses a plan file. Throws with the file path in the
 *  message — callers never add context of their own. */
export function readPlanDoc(file: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${file}: cannot read plan — ${msg}`)
  }
  let doc: unknown
  try {
    doc = parse(text)
  } catch (err) {
    throw new Error(
      `${file}: invalid TOML — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!isRecord(doc)) {
    throw new Error(`${file}: plan must be a TOML table`)
  }
  return doc
}

/** The envelope's routing key — undefined when absent or non-string. */
export function planKind(doc: Record<string, unknown>): string | undefined {
  return typeof doc.kind === 'string' ? doc.kind : undefined
}

/** The envelope's `version` gate — the schema the producer pinned must
 *  be a positive integer this bro understands (`latest` = the kind's
 *  PLAN_VERSION). Absent is fine: unversioned plans mean "whatever the
 *  installed schema is". Routers and planSchema validators share this
 *  so a pinned version fails the same way on both paths. */
export function checkPlanVersion(
  raw: unknown,
  kind: string,
  latest: number,
  errors: string[]
): void {
  if (raw === undefined) {
    return
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    errors.push('version: must be a positive integer')
    return
  }
  if (raw > latest) {
    errors.push(
      `version: ${kind} schema v${raw} is newer than this bro understands (latest v${latest})`
    )
  }
}
