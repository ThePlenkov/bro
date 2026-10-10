/** Session planes — the host-wide admission seam.

 *  A plane is one agent ecosystem's notion of "a live session on this
 *  machine": how to recognize a spawn command that starts one, and how
 *  to count the ones already running (lock files, sockets, a local
 *  API — the plane owns its state plane). Core owns only the ABSTRACT
 *  mechanics: the quota config shape, the reservation lifecycle, and
 *  the serialized admit. Vendor names never reach this file — planes
 *  register themselves, callers ask the registry. */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SpawnError } from './agents.ts'
import { LockTimeout, withFileLock } from './filelock.ts'

/** A session-kind admission plane. */
export interface SessionPlane {
  /** The kind id — also the config bag key (`agents.<kind>`). */
  readonly kind: string
  /** Does this CLI identity (basename of the resolved spawn command)
   *  start one of this plane's sessions? Called with the worker's
   *  wrapped cliName for argv workers — never the driver argv[0]. */
  detectsCli(cliName: string): boolean
  /** Live sessions of this kind on the host, per the plane's own state
   *  plane (lock dir, socket listing, local API). `bag` is the
   *  `agents.<kind>` config section — plane-local knobs (like a lockDir
   *  override) ride it; `workerEnv` is the env the spawned child will
   *  run under, so a count can include the state dir the child will
   *  actually write to. Throws SpawnError('unavailable') when the
   *  count can't be established — admission fails closed. */
  countLive(bag: Record<string, unknown>, workerEnv?: Record<string, string>): number
  /** The spawned-worker subset of countLive — the sessions
   *  `agents.<kind>.maxWorkers` gates. Planes that cannot tell a
   *  spawned worker from an interactive session leave this
   *  unimplemented; arming maxWorkers on such a plane refuses 'config'
   *  at admission, never a silent unguard. */
  countWorkers?(bag: Record<string, unknown>, workerEnv?: Record<string, string>): number
}

// --- plane registry ------------------------------------------------------------

const planes = new Map<string, SessionPlane>()

/** Register a plane — builtins register at import; external plugins
 *  register through the connector surface. Re-registering a kind the
 *  host already knows replaces it (tests reset via clearSessionPlanes). */
export function registerSessionPlane(plane: SessionPlane): void {
  planes.set(plane.kind, plane)
}

export function sessionPlane(kind: string): SessionPlane | undefined {
  return planes.get(kind)
}

export function sessionPlanes(): SessionPlane[] {
  return [...planes.values()]
}

/** The plane a spawn command belongs to — first registered detector
 *  that claims the cliName wins. */
export function sessionPlaneForCli(cliName: string): SessionPlane | undefined {
  for (const p of planes.values()) {
    if (p.detectsCli(cliName)) {
      return p
    }
  }
  return undefined
}

/** Test hook — drop all registrations. */
export function clearSessionPlanes(): void {
  planes.clear()
}

// --- quota config ----------------------------------------------------------------

/** `agents.<kind>` → the admission lanes. `maxSessions`/`maxWorkers`
 *  absent or an explicit 0 mean uncapped (same convention as
 *  fleet.maxConcurrent); a quota exists when EITHER lane is armed. A
 *  present-but-malformed value flags `invalid` with `invalidKey`
 *  naming the bad knob — a typo must refuse loudly at admission, never
 *  silently unguard. `reservationsDir` is a generic override
 *  (reservations are bro's own files); every other key in the bag is
 *  the plane's private config, handed to countLive/countWorkers. */
export interface SessionQuota {
  maxSessions: number
  maxWorkers?: number
  reservationsDir?: string
  invalid?: boolean
  invalidKey?: string
}

export function sessionQuotaConfig(
  agents: Record<string, Record<string, unknown>> | undefined,
  kind: string
): SessionQuota | undefined {
  const bag = agents?.[kind]
  if (bag === undefined) {
    return undefined
  }
  const reservationsDir =
    typeof bag['reservationsDir'] === 'string' ? bag['reservationsDir'] : undefined
  const lane = (
    key: 'maxSessions' | 'maxWorkers'
  ): { n: number } | { invalid: true } | undefined => {
    const v = bag[key]
    if (v === undefined || v === 0) {
      return undefined
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return { invalid: true }
    }
    return { n: v }
  }
  const sessions = lane('maxSessions')
  const workers = lane('maxWorkers')
  if (sessions === undefined && workers === undefined) {
    return undefined
  }
  const bad = sessions !== undefined && 'invalid' in sessions
    ? 'maxSessions'
    : workers !== undefined && 'invalid' in workers
      ? 'maxWorkers'
      : undefined
  if (bad !== undefined) {
    return { maxSessions: 0, reservationsDir, invalid: true, invalidKey: bad }
  }
  const quota: SessionQuota = {
    maxSessions: sessions !== undefined && 'n' in sessions ? sessions.n : 0,
    reservationsDir,
  }
  if (workers !== undefined && 'n' in workers) {
    quota.maxWorkers = workers.n
  }
  return quota
}

// --- slot reservations -----------------------------------------------------------

/** How long a claimed-but-not-yet-started session counts. The plane's
 *  own session mark lands within seconds of the child starting; 120s
 *  covers that handoff plus failure cleanup, then the file
 *  self-expires — a crashed parent never wedges the quota. */
export const SESSION_SLOT_TTL_MS = 120_000

/** Host-shared reservation dir per kind — `$XDG_DATA_HOME/bro/
 *  session-slots/<kind>`. Cross-repo by construction: every bro
 *  process on this host admits against the same set, closing the
 *  window between "count says headroom" and "the spawned session wrote
 *  its own mark in the plane's state". */
export function sessionSlotsDir(kind: string, resDir?: string): string {
  if (typeof resDir === 'string' && resDir.trim() !== '') {
    return resDir
  }
  const xdg = process.env['XDG_DATA_HOME']
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'bro', 'session-slots', kind)
}

/** Fresh reservations — files younger than the TTL count as claimed
 *  slots; stale files are reaped in passing. A missing dir is zero
 *  reservations; other read failures throw 'unavailable' — an
 *  unverifiable count fails closed, never silently admits. */
export function countSessionReservations(resDir: string): number {
  let names: string[]
  try {
    names = readdirSync(resDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw new SpawnError(
      `cannot verify session reservations — ${resDir}: ${(err as Error).message}`,
      'unavailable'
    )
  }
  const now = Date.now()
  let fresh = 0
  for (const name of names) {
    if (!name.endsWith('.slot')) {
      continue
    }
    const path = join(resDir, name)
    try {
      if (now - statSync(path).mtimeMs < SESSION_SLOT_TTL_MS) {
        fresh++
      } else {
        rmSync(path, { force: true })
      }
    } catch {
      // stat raced a reap — ignore
    }
  }
  return fresh
}

/** Claim a host-wide slot — `wx` exclusive create plus a random suffix,
 *  so a same-named spawn from another repo never overwrites a live
 *  claim. Returns the reservation path for release on failure. */
export function reserveSessionSlot(resDir: string, key: string): string {
  mkdirSync(resDir, { recursive: true })
  const path = join(resDir, `${key}-${randomBytes(4).toString('hex')}.slot`)
  writeFileSync(path, String(Date.now()), { flag: 'wx' })
  return path
}

/** Drop a reservation — spawn-failure cleanup; on success the file is
 *  left to expire behind the child's own session mark. */
export function releaseSessionSlot(path: string): void {
  rmSync(path, { force: true })
}

/** Atomic host-wide admission: the plane's live count + held
 *  reservations and the slot claim run under ONE mutex shared by every
 *  repo — a per-repo registry lock cannot serialize this, so without
 *  it two spawns each count below the cap and both start. The mutex
 *  sits inside the slots dir under a non-`.slot` name so the counter
 *  never reads it as a reservation. Returns the reservation path —
 *  released by the caller when the spawn fails before a session
 *  exists; a landed session needs no release (its own mark is the
 *  count, the file ages out). Throws SpawnError — 'config' when the
 *  cap is misconfigured, 'cap' when full, 'unavailable' when the count
 *  can't be established or the mutex outlives its wait. */
export function admitSessionSlot(
  plane: SessionPlane,
  agents: Record<string, Record<string, unknown>> | undefined,
  opts: { key: string; molStep?: string; workerEnv?: Record<string, string> }
): string | undefined {
  const bag = agents?.[plane.kind] ?? {}
  const quota = sessionQuotaConfig(agents, plane.kind)
  if (quota === undefined) {
    return undefined
  }
  const resDir = sessionSlotsDir(plane.kind, quota.reservationsDir)
  try {
    return withFileLock(
      join(resDir, 'admission.mutex'),
      () => {
        if (quota.invalid === true) {
          // a present-but-unparsable cap is a config bug — refuse
          // loudly rather than spawn past a quota the operator armed
          throw new SpawnError(
            `agents.${plane.kind}.${quota.invalidKey ?? 'maxSessions'} must be a positive integer` +
              (opts.molStep !== undefined ? ` — spawn of ${opts.molStep} refused` : ''),
            'config'
          )
        }
        const reservations = countSessionReservations(resDir)
        if (quota.maxSessions > 0) {
          const live = plane.countLive(bag, opts.workerEnv) + reservations
          if (live >= quota.maxSessions) {
            throw new SpawnError(
              `${plane.kind} session quota reached — ${live}/${quota.maxSessions} live sessions ` +
                `(agents.${plane.kind}.maxSessions in bro.config)` +
                (opts.molStep !== undefined ? ` — spawn of ${opts.molStep} refused` : ''),
              'cap'
            )
          }
        }
        if (quota.maxWorkers !== undefined && quota.maxWorkers > 0) {
          if (plane.countWorkers === undefined) {
            // arming a worker cap on a plane that cannot tell workers
            // from interactive sessions is a config bug — refuse
            // loudly rather than spawn past it
            throw new SpawnError(
              `agents.${plane.kind}.maxWorkers is set but the '${plane.kind}' session plane ` +
                `cannot distinguish worker sessions` +
                (opts.molStep !== undefined ? ` — spawn of ${opts.molStep} refused` : ''),
              'config'
            )
          }
          // every reservation is an in-flight worker spawn — the slot
          // feed is worker-only by construction
          const workers = plane.countWorkers(bag, opts.workerEnv) + reservations
          if (workers >= quota.maxWorkers) {
            throw new SpawnError(
              `${plane.kind} worker quota reached — ${workers}/${quota.maxWorkers} live workers ` +
                `(agents.${plane.kind}.maxWorkers in bro.config)` +
                (opts.molStep !== undefined ? ` — spawn of ${opts.molStep} refused` : ''),
              'cap'
            )
          }
        }
        return reserveSessionSlot(resDir, opts.key)
      },
      { label: `${plane.kind} session quota admission` }
    )
  } catch (err) {
    if (err instanceof LockTimeout) {
      throw new SpawnError(`${plane.kind} quota admission lock held — ${err.message}`, 'unavailable')
    }
    throw err
  }
}
