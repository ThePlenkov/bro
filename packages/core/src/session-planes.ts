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
   *  at admission, never a silent unguard. Same fail-closed contract
   *  as countLive — a host where the worker split cannot be verified
   *  at all throws SpawnError('unavailable'). A plane that can see
   *  which of its sessions' pids are already counted may also retire
   *  landed `.slot` reservations inside its count — the admission
   *  tally runs after it, so a landed spawn is not counted twice. */
  countWorkers?(bag: Record<string, unknown>, workerEnv?: Record<string, string>): number
  /** The BATCH subset of countWorkers — the workers the fleet owns
   *  (a drive fixer, a loop member). The split is by the supervisor
   *  marker the spawn's env carries (BRO_PR, BRO_MOL_ID): the marker
   *  rides into the worker process, so a plane that can read its
   *  workers' environment can tell the fleet's workers from the
   *  operator's own sessions. `agents.<kind>.maxBatchWorkers` gates
   *  this population; a plane that cannot split refuses 'config' when
   *  that cap is armed, never silently unguards it (spec bro-9h86l). */
  countBatchWorkers?(bag: Record<string, unknown>, workerEnv?: Record<string, string>): number
  /** The live sessions as rows — the same lock/scan semantics countLive
   *  runs, kept per-session so a board names the session, not just the
   *  count. Optional: a plane without it contributes counts but no
   *  rows. Same SpawnError('unavailable') contract as countLive — an
   *  unverifiable scan throws, never silently reports "no sessions". */
  listLive?(
    bag: Record<string, unknown>,
    workerEnv?: Record<string, string>
  ): DiscoveredSession[]
}

/** One live session a session-plane sees — a worker the registry never
 *  spawned (a foreign or interactive session) or the inner process of
 *  a registered agent. `agentId` handles the second case: the worker's
 *  own BRO_AGENT_ID badge, when the plane can read it, so a board
 *  folds the session into its agent row instead of counting the same
 *  work twice. */
export interface DiscoveredSession {
  pid: number
  /** The plane's name for the session (a lock-name, a socket id) when
   *  the state plane carries one. */
  name?: string
  /** The session's working directory when the plane can read it —
   *  a same-repo similarity/admission check scopes by it. */
  cwd?: string
  /** The plane's own worker classification — the same predicate
   *  countWorkers applies. False is "live, but not a worker" (an
   *  interactive session), not "unknown". */
  worker?: boolean
  /** The worker's BRO_AGENT_ID env badge when readable — the registry
   *  correlation id. */
  agentId?: string
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
  /** The BATCH lane's own worker cap — the fleet's share of the worker
   *  budget. The interactive lane keeps the rest of `maxWorkers`. A
   *  batch spawn is one carrying a supervisor marker (BRO_PR for a drive
   *  fixer, BRO_MOL_ID for a loop member) — the marker rides into the
   *  worker process, so the plane can tell the two populations apart.
   *  Unset = one budget for everyone (spec bro-9h86l). */
  maxBatchWorkers?: number
  reservationsDir?: string
  invalid?: boolean
  invalidKey?: string
}

/** One admission lane's parsed knob: a count, a malformed marker, or
 *  absent (uncapped). A present-but-malformed value is a config bug —
 *  it flags `invalid` and admission refuses loudly. */
type QuotaLane = { n: number } | { invalid: true } | undefined

function quotaLane(
  bag: Record<string, unknown>,
  key: 'maxSessions' | 'maxWorkers' | 'maxBatchWorkers'
): QuotaLane {
  const v = bag[key]
  if (v === undefined || v === 0) {
    return undefined
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    return { invalid: true }
  }
  return { n: v }
}

/** The first malformed lane's knob name — the one admission names when
 *  it refuses a typo. */
function firstBadLane(...lanes: Array<[string, QuotaLane]>): string | undefined {
  for (const [key, lane] of lanes) {
    if (lane !== undefined && 'invalid' in lane) {
      return key
    }
  }
  return undefined
}

/** A lane's count — undefined when the knob is absent. */
function laneCount(lane: QuotaLane): number | undefined {
  return lane !== undefined && 'n' in lane ? lane.n : undefined
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
  const sessions = quotaLane(bag, 'maxSessions')
  const workers = quotaLane(bag, 'maxWorkers')
  const batchWorkers = quotaLane(bag, 'maxBatchWorkers')
  if (sessions === undefined && workers === undefined && batchWorkers === undefined) {
    return undefined
  }
  const bad = firstBadLane(
    ['maxSessions', sessions],
    ['maxWorkers', workers],
    ['maxBatchWorkers', batchWorkers]
  )
  if (bad !== undefined) {
    return { maxSessions: 0, reservationsDir, invalid: true, invalidKey: bad }
  }
  const quota: SessionQuota = {
    maxSessions: laneCount(sessions) ?? 0,
    reservationsDir,
  }
  const maxWorkers = laneCount(workers)
  if (maxWorkers !== undefined) {
    quota.maxWorkers = maxWorkers
  }
  const maxBatchWorkers = laneCount(batchWorkers)
  if (maxBatchWorkers !== undefined) {
    quota.maxBatchWorkers = maxBatchWorkers
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
export function countSessionReservations(resDir: string, lane?: ReservationLane): number {
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
    // the batch lane counts only the fleet's reservations
    if (lane === 'batch' && !name.endsWith('.batch.slot')) {
      continue
    }
    if (lane === 'interactive' && name.endsWith('.batch.slot')) {
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
export function reserveSessionSlot(
  resDir: string,
  key: string,
  lane: ReservationLane
): string {
  mkdirSync(resDir, { recursive: true })
  // the lane rides the file name, and it is EXPLICIT: the batch cap
  // counts only the fleet's reservations, so an in-flight interactive
  // spawn never eats the fleet's share — and an untagged reservation
  // (a caller that forgot) would undercount the fleet
  const tag = lane === 'batch' ? '.batch' : ''
  const path = join(resDir, `${key}-${randomBytes(4).toString('hex')}${tag}.slot`)
  writeFileSync(path, String(Date.now()), { flag: 'wx' })
  return path
}

/** Drop a reservation — spawn-failure cleanup; on success the file is
 *  left to expire behind the child's own session mark. */
export function releaseSessionSlot(path: string): void {
  rmSync(path, { force: true })
}

/** The env var that marks a spawn as the FLEET's. The fleet sets it
 *  on every spawn it owns — a drive fixer, a loop member (root bead or
 *  molecule child) — so the marker does not depend on a molecule
 *  parent existing. An interactive spawn (a person at a terminal) never
 *  carries it. The child's env is `{ ...process.env, ...spec.env }`, so
 *  the marker rides into the worker process and a plane can classify a
 *  live worker from its own environment. */
export const BATCH_MARKER_ENV = 'BRO_BATCH'

/** The BATCH lane — a spawn the fleet owns. */
export function isBatchSpawn(env: Record<string, string> | undefined): boolean {
  if (env === undefined) {
    return false
  }
  const marker = env[BATCH_MARKER_ENV]
  return marker !== undefined && marker !== ''
}

/** The lane checks inside the admission mutex. The plane counts run
 *  BEFORE the reservation tally: a plane that can see its own session
 *  marks retires a landed spawn's still-fresh `.slot` inside its own
 *  count, and the tally must see that sweep — otherwise a landed
 *  worker counts twice (live + reservation) and the cap refuses
 *  before reaching its configured capacity. Every remaining
 *  reservation is an in-flight spawn — the slot feed is worker-only
 *  by construction. Throws SpawnError — 'config' when a knob is
 *  unusable, 'cap' when a lane is full, 'unavailable' when a count
 *  can't be established. */
function checkSessionLanes(
  plane: SessionPlane,
  bag: Record<string, unknown>,
  quota: SessionQuota,
  resDir: string,
  opts: { molStep?: string; workerEnv?: Record<string, string> }
): void {
  const refused = opts.molStep !== undefined ? ` — spawn of ${opts.molStep} refused` : ''
  const maxWorkers = quota.maxWorkers ?? 0
  const maxBatchWorkers = quota.maxBatchWorkers ?? 0
  const batch = isBatchSpawn(opts.workerEnv)
  const sessions = quota.maxSessions > 0 ? plane.countLive(bag, opts.workerEnv) : 0
  // The plane counts run BEFORE the reservation tally: a plane that
  // retires a landed spawn's still-fresh `.slot` inside its own count
  // must have that sweep VISIBLE to the tally, or a landed worker
  // counts twice (live + reservation) and the cap refuses a rightful
  // admit. The batch count rides the same rule.
  const workers =
    maxWorkers > 0 && plane.countWorkers !== undefined
      ? plane.countWorkers(bag, opts.workerEnv)
      : 0
  const batchWorkers =
    maxBatchWorkers > 0 && batch && plane.countBatchWorkers !== undefined
      ? plane.countBatchWorkers(bag, opts.workerEnv)
      : 0
  const reservations = countSessionReservations(resDir)
  // the fleet's share counts the fleet's reservations only — an
  // interactive spawn in flight must not eat the batch lane's cap
  const batchReservations = countSessionReservations(resDir, 'batch')
  if (quota.maxSessions > 0 && sessions + reservations >= quota.maxSessions) {
    throw new SpawnError(
      `${plane.kind} session quota reached — ${sessions + reservations}/${quota.maxSessions} live sessions ` +
        `(agents.${plane.kind}.maxSessions in bro.config)` +
        refused,
      'cap'
    )
  }
  if (maxBatchWorkers > 0 && batch) {
    // the fleet's own share of the worker budget
    const budget: LaneBudget = { lane: 'maxBatchWorkers', cap: maxBatchWorkers, live: batchWorkers }
    checkWorkerCap(plane, workerCap(plane, budget), { reservations: batchReservations, refused })
  }
  if (maxWorkers > 0) {
    const budget: LaneBudget = { lane: 'maxWorkers', cap: maxWorkers, live: workers }
    checkWorkerCap(plane, workerCap(plane, budget), { reservations, refused })
  }
}

/**
 * One worker lane's cap — the whole budget (`maxWorkers`) or the fleet's
 * share of it (`maxBatchWorkers`). The two lanes differ in the knob,
 * the population and the wording; the check itself is one shape, so a
 * change to the rule lands in one place.
 */
/** Which lane a budget belongs to — the whole worker pool or the
 *  fleet's share of it. A named lane, not a loose string: the knob,
 *  the wording and the countable check all follow from it. */
type WorkerLane = 'maxWorkers' | 'maxBatchWorkers'

/** Which lane a RESERVATION belongs to — the fleet's or the operator's.
 *  Explicit at every call site: an untagged reservation would be
 *  counted as nobody's, and the fleet's cap would undercount its own
 *  in-flight spawns. */
export type ReservationLane = 'batch' | 'interactive'

/** A lane's numbers — the cap and what is live against it. */
interface LaneBudget {
  lane: WorkerLane
  cap: number
  live: number
}

interface WorkerCap {
  /** the config knob (`agents.<kind>.<knob>`) */
  knob: WorkerLane
  /** the subject in the refusal — "worker" / "batch worker" */
  subject: 'worker' | 'batch worker'
  /** the counted population — "workers" / "batch workers" */
  population: 'workers' | 'batch workers'
  /** what a plane that cannot split would be unable to tell apart */
  undistinguishable: 'worker sessions' | 'batch workers'
  /** the cap */
  cap: number
  /** the lane's live count (the plane counted it before the tally) */
  live: number
  /** can the plane tell this population apart at all? */
  countable: boolean
}

/** One lane's cap — the whole budget (`maxWorkers`) or the fleet's
 *  share of it (`maxBatchWorkers`). One shape for both: the wording
 *  differs, the rule does not. */
function workerCap(plane: SessionPlane, budget: LaneBudget): WorkerCap {
  const batch = budget.lane === 'maxBatchWorkers'
  return {
    knob: budget.lane,
    subject: batch ? 'batch worker' : 'worker',
    population: batch ? 'batch workers' : 'workers',
    undistinguishable: batch ? 'batch workers' : 'worker sessions',
    cap: budget.cap,
    live: budget.live,
    countable: batch
      ? plane.countBatchWorkers !== undefined
      : plane.countWorkers !== undefined,
  }
}

/** The lane's cap: a plane that cannot tell the population apart
 *  refuses 'config' rather than silently unguard-ing the cap the
 *  operator armed. */
function checkWorkerCap(
  plane: SessionPlane,
  cap: WorkerCap,
  ctx: { reservations: number; refused: string }
): void {
  if (!cap.countable) {
    throw new SpawnError(
      `agents.${plane.kind}.${cap.knob} is set but the '${plane.kind}' session plane ` +
        `cannot distinguish ${cap.undistinguishable} from interactive sessions` +
        ctx.refused,
      'config'
    )
  }
  if (cap.live + ctx.reservations >= cap.cap) {
    throw new SpawnError(
      `${plane.kind} ${cap.subject} quota reached — ${cap.live + ctx.reservations}/${cap.cap} live ${cap.population} ` +
        `(agents.${plane.kind}.${cap.knob} in bro.config)` +
        ctx.refused,
      'cap'
    )
  }
}

/** Atomic host-wide admission: the plane's live count + held
 *  reservations and the slot claim run under ONE mutex shared by every
 *  repo — a per-repo registry lock cannot serialize this, so without
 *  it two spawns each count below the cap and both start. The mutex
 *  sits inside the slots dir under a non-`.slot` name so the counter
 *  never reads it as a reservation. Returns the reservation path —
 *  released by the caller when the spawn fails before a session
 *  exists; a landed session needs no release — its own mark is the
 *  count, and a plane that can see its marks retires the slot inside
 *  its next count (the TTL still bounds what's left). Throws
 *  SpawnError — 'config' when the cap is misconfigured, 'cap' when
 *  full, 'unavailable' when the count can't be established or the
 *  mutex outlives its wait. */
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
        checkSessionLanes(plane, bag, quota, resDir, opts)
        return reserveSessionSlot(
          resDir,
          opts.key,
          isBatchSpawn(opts.workerEnv) ? 'batch' : 'interactive'
        )
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
