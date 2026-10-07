/**
 * Fleet routing — task-class → ordered provider chain plus provider
 * walls derived from the agent registry (spec:
 * specs/fleet-routing/bro-1x7p.md). M2 scope: the routing config
 * sections, step-class resolution, and wall derivation rendered by
 * `bro fleet`/`bro watch`. The re-dispatch chain walk is M3 — an M2
 * spawn always lands on chain[0].
 */
import { bdAt, SpawnError, type AgentRegistryEntry } from './agents.ts'
import {
  ProviderSurfaceError,
  requireProviderSurface,
  UnknownProviderError,
  type ProviderEntry,
} from './providers.ts'

export const ON_WALL = ['park', 'fallthrough'] as const
/** A walled step's verdict — `park` waits the current provider's wall
 *  out, `fallthrough` walks the chain to the next un-walled entry. */
export type OnWall = (typeof ON_WALL)[number]

/** One chain link — a `providers.<name>` plus an optional inline model
 *  pin for where the bare string form isn't enough. */
export interface ChainEntry {
  provider: string
  model?: string
}

/** One `fleet.routing.<class>` row — the ordered provider chain plus
 *  the class's wall policy. */
export interface RoutingClass {
  chain: ChainEntry[]
  onWall?: OnWall
}

/** `fleet.routing` — task class → routing row. */
export type RoutingTable = Record<string, RoutingClass>

/** `fleet.router` — the optional judge classifier (M7): a call-surface
 *  provider that picks which lane an unclassed step takes. `off` is
 *  the spelled-out absent — static classes only, same as no section. */
export interface FleetRouter {
  provider: string
  mode: 'shadow' | 'enforce' | 'off'
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** One chain entry — a bare provider name or {provider, model}.
 *  Bad entries drop with a warning; an empty surviving chain drops the
 *  whole class (providers.ts' field-vs-entry convention). */
function chainEntry(cls: string, i: number, v: unknown): ChainEntry | null {
  const key = `fleet.routing.${cls}.chain[${i}]`
  if (typeof v === 'string') {
    const s = v.trim()
    if (s !== '') {
      return { provider: s }
    }
  } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    const provider = str(o.provider)
    if (provider === undefined) {
      console.error(`bro.config: ${key} requires "provider" — entry dropped`)
      return null
    }
    const e: ChainEntry = { provider }
    if (o.model !== undefined) {
      const model = str(o.model)
      if (model === undefined) {
        console.error(`bro.config: ${key}.model must be a non-empty string — field dropped`)
      } else {
        e.model = model
      }
    }
    return e
  }
  console.error(`bro.config: ${key} must be a provider name or {provider, model} — entry dropped`)
  return null
}

/** `fleet.routing` section parse — shape only; chain entries resolve
 *  against `providers` at class-resolution time (the sections parse
 *  independently, so an unknown name or an api entry is a use-time
 *  config error naming class + key, not a parse-time drop). */
export function fleetRouting(raw: unknown): RoutingTable {
  if (raw === undefined) {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error('bro.config: fleet.routing must be an object — section dropped')
    return {}
  }
  const out: RoutingTable = {}
  for (const [cls, v] of Object.entries(raw)) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      console.error(`bro.config: fleet.routing.${cls} must be an object — class dropped`)
      continue
    }
    const o = v as Record<string, unknown>
    if (!Array.isArray(o.chain)) {
      console.error(`bro.config: fleet.routing.${cls}.chain must be an array — class dropped`)
      continue
    }
    const chain = o.chain
      .map((e, i) => chainEntry(cls, i, e))
      .filter((e): e is ChainEntry => e !== null)
    if (chain.length === 0) {
      console.error(`bro.config: fleet.routing.${cls}.chain has no usable entries — class dropped`)
      continue
    }
    const rc: RoutingClass = { chain }
    if (o.onWall !== undefined) {
      if ((ON_WALL as readonly unknown[]).includes(o.onWall)) {
        rc.onWall = o.onWall as OnWall
      } else {
        console.error(
          `bro.config: fleet.routing.${cls}.onWall must be one of ${ON_WALL.join('|')} — field dropped`
        )
      }
    }
    // defineProperty, not assignment — a class literally named
    // '__proto__' must land as an own key, never trigger the
    // prototype setter (same guard as providers' model ids)
    Object.defineProperty(out, cls, {
      value: rc,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/** `fleet.router` section parse — {provider, mode} or nothing; either
 *  missing field drops the section (a router that can't name its
 *  provider is no router). */
export function fleetRouter(raw: unknown): FleetRouter | undefined {
  if (raw === undefined) {
    return undefined
  }
  const o = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const provider = str(o.provider)
  const mode = str(o.mode)
  if (
    provider === undefined ||
    (mode !== 'shadow' && mode !== 'enforce' && mode !== 'off')
  ) {
    console.error(
      'bro.config: fleet.router requires provider + mode (shadow|enforce|off) — section dropped'
    )
    return undefined
  }
  return { provider, mode }
}

// --- class resolution -----------------------------------------------------------

export const DEFAULT_STEP_CLASS = 'default'
export const CLASS_LABEL_PREFIX = 'class:'

/** The step bead's routing inputs — one `bd show` read: labels carry
 *  the `class:<name>` lane pin, priority feeds the onWall default.
 *  Best-effort like probeStep: a missing bead or dead store reads as
 *  "no lane declared". */
export function stepClassInfo(
  beadsDir: string,
  molStep: string
): { label?: string; priority?: number } {
  const r = bdAt(beadsDir, ['show', molStep, '--json'])
  if (r.code !== 0) {
    return {}
  }
  try {
    const row = (JSON.parse(r.out) as { labels?: unknown; priority?: unknown }[])[0]
    const labels = Array.isArray(row?.labels) ? row.labels : []
    const hit = labels.find(
      (l): l is string => typeof l === 'string' && l.startsWith(CLASS_LABEL_PREFIX)
    )
    const name = hit === undefined ? undefined : hit.slice(CLASS_LABEL_PREFIX.length).trim()
    return {
      ...(name === undefined || name === '' ? {} : { label: name }),
      ...(typeof row?.priority === 'number' ? { priority: row.priority } : {}),
    }
  } catch {
    return {}
  }
}

/** The resolution verdict — the lane name, its declared chain, the
 *  effective wall policy, and where THIS spawn lands (chain[0] —
 *  the fallthrough walk is M3). */
export interface ResolvedClass {
  class: string
  chain: ChainEntry[]
  /** `entry.onWall` ?? priority default — P0/P1 park, P2+ fallthrough. */
  onWall: OnWall
  /** chain[0]'s slot — `provider`/`model` are a PAIR: the pin applies
   *  only when the routed provider is the one used; a provider
   *  override must not inherit this model (it belongs to chain[0]'s
   *  provider, not the override's). */
  provider: string
  model?: string
}

/** Total class resolution, first hit wins (spec §"Class resolution"):
 *  the explicit request field → the bead's `class:<name>` label →
 *  `default`. A resolved class with no routing entry is a config error
 *  naming the class — never a silent `default`. Every chain entry must
 *  resolve to a configured provider with a spawn surface; a bad entry
 *  is a config error naming class + key, same rule as
 *  `agents.<backend>.provider`. */
export function resolveStepClass(
  routing: RoutingTable,
  providers: Record<string, ProviderEntry>,
  sel: { class?: string; label?: string; priority?: number } = {}
): ResolvedClass {
  const cls = sel.class ?? sel.label ?? DEFAULT_STEP_CLASS
  const row = Object.hasOwn(routing, cls) ? routing[cls] : undefined
  if (row === undefined) {
    throw new SpawnError(
      `fleet.routing has no class "${cls}" — declare fleet.routing.${cls}.chain`,
      'config'
    )
  }
  for (const [i, e] of row.chain.entries()) {
    try {
      requireProviderSurface(providers, e.provider, 'spawn')
    } catch (err) {
      if (err instanceof UnknownProviderError || err instanceof ProviderSurfaceError) {
        throw new SpawnError(`fleet.routing.${cls}.chain[${i}] — ${err.message}`, 'config')
      }
      throw err
    }
  }
  const onWall = row.onWall ?? ((sel.priority ?? 2) <= 1 ? 'park' : 'fallthrough')
  const head = row.chain[0]!
  return { class: cls, chain: row.chain, onWall, provider: head.provider, model: head.model }
}

/** The spawn-side seam — reads the bead for label/priority and
 *  resolves the lane. `undefined` when no `fleet.routing` is declared:
 *  absent (or declared-empty) routing leaves today's static
 *  resolution untouched — bro never picks a route the operator didn't
 *  declare. */
export function routeStepClass(
  fleet: { routing?: RoutingTable } | undefined,
  providers: Record<string, ProviderEntry>,
  beadsDir: string,
  molStep: string,
  explicitClass?: string
): ResolvedClass | undefined {
  const routing = fleet?.routing
  if (routing === undefined || Object.keys(routing).length === 0) {
    return undefined
  }
  const info = stepClassInfo(beadsDir, molStep)
  return resolveStepClass(routing, providers, {
    class: explicitClass,
    label: info.label,
    priority: info.priority,
  })
}

// --- provider walls ---------------------------------------------------------------

/** A provider-level blocked state — derived from the registry's newest
 *  wallable classified death, never stored (spec §"Provider walls —
 *  derived, not stored"). */
export interface ProviderWall {
  provider: string
  cause: 'rate_limited' | 'quota'
  /** rate_limited only — the provider-reported reset the wall holds
   *  until; absent when none was reported (indefinite). */
  until?: string
}

/** The spec's render: `<provider> walled — <cause>[ til <resetAt>]`. */
export function wallText(w: ProviderWall): string {
  const til = w.until === undefined ? '' : ` til ${w.until}`
  return `${w.provider} walled — ${w.cause}${til}`
}

/** Provider walls accumulate per provider — `quota` sticks (a stopped
 *  entry clears it, nothing else does); `rate` keeps the newest
 *  unstopped rate_limited death (spawnedAt — a respawn re-stamps it). */
interface WallAcc {
  quota: boolean
  rate?: AgentRegistryEntry
}

/** A wallable death with provider provenance — `crash`/`auth`/`ok` say
 *  something about the worker, never the service, and a legacy spawn
 *  without provider provenance can't map to a wall. */
function wallable(e: AgentRegistryEntry): e is AgentRegistryEntry & { provider: string } {
  return (
    typeof e.provider === 'string' &&
    e.provider !== '' &&
    e.stopped !== true &&
    (e.cause === 'rate_limited' || e.cause === 'quota')
  )
}

function foldEntry(acc: WallAcc, e: AgentRegistryEntry): void {
  if (e.cause === 'quota') {
    acc.quota = true
  } else if (acc.rate === undefined || e.spawnedAt > acc.rate.spawnedAt) {
    acc.rate = e
  }
}

/** One provider's verdict — quota dominates; otherwise the newest
 *  rate_limited walls until its resetAt (indefinitely when none or an
 *  unparseable one was reported); a passed resetAt is the proof of
 *  lift. */
function accWall(provider: string, acc: WallAcc, now: number): ProviderWall | undefined {
  if (acc.quota) {
    return { provider, cause: 'quota' }
  }
  const e = acc.rate
  if (e === undefined) {
    return undefined // unreachable — a non-quota acc exists only via a rate death
  }
  const until = typeof e.resetAt === 'string' && e.resetAt !== '' ? e.resetAt : undefined
  const t = until === undefined ? Number.NaN : Date.parse(until)
  if (until !== undefined && Number.isFinite(t) && t <= now) {
    return undefined
  }
  return until === undefined
    ? { provider, cause: 'rate_limited' }
    : { provider, cause: 'rate_limited', until }
}

/** Derive walls from registry entries — `rate_limited`/`quota` deaths
 *  wall the provider; `crash`/`auth`/`ok` say something about the
 *  worker, never the service. `stopped` entries are the manual clear
 *  (`bro agents down`, same as the per-entry respawn block).
 *
 *  quota dominates: ANY unstopped quota death walls until every
 *  quota-caused entry on the provider is stopped. Otherwise the
 *  newest unstopped `rate_limited` death (spawnedAt — a respawn
 *  re-stamps it) walls until its `resetAt`, indefinitely when none
 *  was reported; a passed resetAt is the proof of lift. Deliberately
 *  pessimistic — one worker's rate limit may not be the provider's,
 *  but routing around a healthy provider costs seconds while a
 *  retry-storm burns the budget the taxonomy protects. */
export function deriveProviderWalls(
  registry: Record<string, AgentRegistryEntry>,
  now = Date.now()
): ProviderWall[] {
  const byProvider = new Map<string, WallAcc>()
  for (const e of Object.values(registry)) {
    if (!wallable(e)) {
      continue
    }
    const acc = byProvider.get(e.provider) ?? { quota: false }
    foldEntry(acc, e)
    byProvider.set(e.provider, acc)
  }
  return [...byProvider]
    .map(([provider, acc]) => accWall(provider, acc, now))
    .filter((w): w is ProviderWall => w !== undefined)
    .sort((a, b) => a.provider.localeCompare(b.provider))
}
