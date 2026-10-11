/** The copilot session plane — a remote count.
 *
 *  Copilot coding-agent tasks live on GitHub's runners, not this host:
 *  the "live session" a quota gates is a task in a live-ish state on
 *  the account's `GET /agents/tasks` listing. `SessionPlane.countLive`
 *  is synchronous and runs inside the host-wide admission mutex, so an
 *  awaited fetch cannot run there — the plane is a CACHED count. The
 *  copilot connector refreshes `live-count.json` beside the
 *  reservations on every spawn/list/status; countLive reads it
 *  synchronously and fails closed ('unavailable') when the cache is
 *  absent, corrupt, or stale — an unverifiable remote count never
 *  silently admits.
 *
 *  `countWorkers` is the same count: there is no interactive copilot
 *  task kind — every agent task is a spawned worker, so maxWorkers and
 *  maxSessions read the same evidence. Landed `.slot` reservations are
 *  never swept: task ids can't be correlated to slot keys without the
 *  repo registry (the plane is host-wide, cross-repo), so a landed
 *  spawn double-counts until its TTL lapses — bounded, never wedged.
 *
 *  Vendor knowledge at the plugin layer like devin.ts — core owns the
 *  mutex/reservation mechanics, this file owns the cache shape; the gh
 *  calls that refresh it live with the connector in
 *  agent-connectors.ts. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  registerSessionPlane,
  sessionSlotsDir,
  SpawnError,
  type SessionPlane,
} from '@broject/core'

/** How long a refreshed count stays trustworthy. Remote task state
 *  changes outside bro's view (the session completes server-side), so
 *  the window is the reservation TTL's own bound — a stale count fails
 *  closed rather than admit on evidence the remote may have moved past. */
export const COPILOT_COUNT_TTL_MS = 120_000

/** The cache payload — `ids` is what the refresh observed (occupancy
 *  probes correlate entries against it); `count` is the lane's number. */
export interface CopilotCountCache {
  at: number
  count: number
  ids: string[]
}

/** `<slots>/live-count.json` — inside the reservations dir, invisible
 *  to the `.slot` tally (it reads `*.slot` only). The reservationsDir
 *  override relocates it for tests like the devin plane's lockDir. */
export function copilotCountFile(resDir?: string): string {
  return join(sessionSlotsDir('copilot', resDir), 'live-count.json')
}

/** Parse the cache — anything unreadable/corrupt is "no count", never
 *  a fabricated zero. */
export function readCopilotCount(file: string): CopilotCountCache | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return undefined
    }
    const c = v as { at?: unknown; count?: unknown; ids?: unknown }
    if (typeof c.at !== 'number' || typeof c.count !== 'number' || c.count < 0) {
      return undefined
    }
    const ids = Array.isArray(c.ids) ? c.ids.filter((x): x is string => typeof x === 'string') : []
    return { at: c.at, count: c.count, ids }
  } catch {
    return undefined
  }
}

/** The connector's refresh — the remote live-task id set observed by a
 *  `GET /agents/tasks?state=<live>` listing lands here for the next
 *  synchronous count. `at` injectable for tests. */
export function writeCopilotCount(
  resDir: string | undefined,
  ids: string[],
  at = Date.now()
): CopilotCountCache {
  const file = copilotCountFile(resDir)
  const cache = { at, count: ids.length, ids }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(cache)}\n`)
  } catch {
    // a cache that can't persist just stays absent — the next count
    // fails closed like a stale one
  }
  return cache
}

/** The fail-closed read both lanes share — a fresh cache yields its
 *  count; absent/corrupt/stale throws 'unavailable' so admission
 *  refuses instead of spawning past an unverifiable cap. `now` and the
 *  file are injectable for tests; `label` names the lane in the error. */
function cachedCount(file: string, label: string, now = Date.now()): number {
  const cache = readCopilotCount(file)
  if (cache === undefined) {
    throw new SpawnError(
      `cannot verify copilot ${label} count — ${file} absent or corrupt; ` +
        'the cache refreshes on copilot spawn/list/status',
      'unavailable'
    )
  }
  if (now - cache.at >= COPILOT_COUNT_TTL_MS) {
    throw new SpawnError(
      `cannot verify copilot ${label} count — ${file} is stale ` +
        `(>${Math.round(COPILOT_COUNT_TTL_MS / 1000)}s old); ` +
        'the cache refreshes on copilot spawn/list/status',
      'unavailable'
    )
  }
  return cache.count
}

/** The builtin plane — registers on import. `detectsCli` never fires:
 *  no local cli command starts a remote copilot task, so the kind is
 *  only reached through the copilot backend's fixed `sessionKind`
 *  default or an explicit `agents.<backend>.sessionKind: "copilot"`. */
export const copilotSessionPlane: SessionPlane = {
  kind: 'copilot',
  detectsCli: () => false,
  countLive(bag) {
    const override = bag['reservationsDir']
    return cachedCount(
      copilotCountFile(typeof override === 'string' ? override : undefined),
      'session'
    )
  },
  countWorkers(bag) {
    const override = bag['reservationsDir']
    return cachedCount(
      copilotCountFile(typeof override === 'string' ? override : undefined),
      'worker'
    )
  },
}

registerSessionPlane(copilotSessionPlane)
