/** Shared probes + row plumbing for the plane adapters
 *  (specs/bro-9rls.1.md — `cli/src/planes/*` over existing machinery). */
import { gitTry, PlaneVerbError, taskStoreAsync } from '@broject/core'

/** "Inside a repo" — every plane's floor: `bro mcp` in a non-repo dir
 *  exposes nothing rather than answering with a wrong-repo read. */
export function inRepo(dir: string): boolean {
  return gitTry(['-C', dir, 'rev-parse', '--git-common-dir']).code === 0
}

/** The beads doc db is reachable — the probe for planes whose reads are
 *  bd-only subsystems (molecules, kv lessons). Those planes answer from
 *  the local store no matter which connector serves `tasks`, so a
 *  reachable remote backend must not advertise their reads. */
export async function beadsReachable(dir: string): Promise<boolean> {
  try {
    await taskStoreAsync(dir).list({ limit: 1 })
    return true
  } catch {
    return false
  }
}

/** Bound a probe — a wedged backend must not stall tools/list. */
export function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      const t = setTimeout(() => resolve(fallback), ms)
      t.unref?.()
    }),
  ])
}

/** Read-arg coercion — tool args arrive as untyped JSON; planes take
 *  numbers/strings, so pull them narrowly instead of trusting. */
export function argNumber(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = args?.[key]
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v
  }
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v)
  }
  return undefined
}

/** `limit` read-arg — a bound is a positive integer. The integer
 *  schema admits `0` and negatives, but downstream `slice(-n)` and the
 *  broker's replay bound both read non-positive as "no bound" — an
 *  inversion that would uncap the read. Clamps to [1, cap]. */
export function argLimit(
  args: Record<string, unknown> | undefined,
  key: string,
  def: number,
  cap: number
): number {
  const n = argNumber(args, key)
  return Math.min(Math.max(n === undefined ? def : Math.floor(n), 1), cap)
}

export function argString(
  args: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const v = args?.[key]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

export function argBool(
  args: Record<string, unknown> | undefined,
  key: string
): boolean | undefined {
  const v = args?.[key]
  return typeof v === 'boolean' ? v : undefined
}

/** The named-read dispatcher every plane shares: undeclared names are
 *  a client bug (PlaneVerbError), never a silent miss. */
export async function dispatchRead(
  plane: string,
  reads: Record<string, (args?: Record<string, unknown>) => unknown>,
  name: string,
  args?: Record<string, unknown>
): Promise<unknown> {
  const fn = reads[name]
  if (fn === undefined) {
    throw new PlaneVerbError(
      plane,
      name,
      `undeclared read — declared: ${Object.keys(reads).join(', ')}`
    )
  }
  return fn(args)
}
