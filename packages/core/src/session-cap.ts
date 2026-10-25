/**
 * The host-wide session cap — one policy, every call site (spec
 * bro-bww9v).
 *
 * `agents.<kind>.maxSessions` is a cap on the ACCOUNT, not on bro's own
 * spawns: the operator's interactive session, the fleet's workers and a
 * foreign agent's session all draw on the same provider budget. The
 * admission (bro's spawn path) has always enforced it; the ACP surface
 * and the guard plane did not, so unbudgeted sessions drained the shared
 * free tier while the fleet was refused with "8/6 live sessions".
 *
 * This module is the policy, and it is VENDOR-BLIND: the kind, the live
 * count and the CLI's grammar all come from the plane registry
 * (`SessionPlane.countLive`, `SessionPlane.startsSessions`). Core names
 * no provider — the vendor knowledge lives in the vendor's package.
 *
 * The budget is shared, not per-call-site: every caller reserves the
 * slot in the kind's reservation dir before it opens a session, so a
 * burst cannot slip through the window between "the count says there is
 * headroom" and "the session wrote its own mark" (the same mechanism the
 * admission uses — spec bro-9vmx's reservation lifecycle). And the
 * check+claim runs under the kind's admission mutex
 * (`admitSessionStart`) — the same lock the spawn's admission takes —
 * so two callers racing a burst see each other's claims, not the same
 * headroom.
 */
import { SpawnError } from './agents.ts'
import { withFileLock } from './filelock.ts'
import {
  countSessionReservations,
  releaseSessionSlot,
  reserveSessionSlotOnce,
  sessionAdmissionLock,
  sessionPlanes,
  sessionQuotaConfig,
  sessionSlotsDir,
  type ReservationLane,
  type SessionPlane,
} from './session-planes.ts'

/** One kind's budget, as the policy sees it. */
export interface SessionCapView {
  /** The kind id — the `agents.<kind>` bag key. */
  kind: string
  /** Live sessions of this kind on the host, reservations included. */
  live: number
  /** The configured cap (`agents.<kind>.maxSessions`); 0 = uncapped. */
  cap: number
  /** How many sessions the command about to run would start. */
  starts: number
}

/** The reason a start is refused, or undefined when it fits.
 *
 *  The wording names the kind, the numbers and the knob — a refusal the
 *  operator can act on without reading the source. */
export function sessionCapRefusal(view: SessionCapView): string | undefined {
  if (view.cap <= 0 || view.starts <= 0) {
    return undefined
  }
  if (view.live + view.starts <= view.cap) {
    return undefined
  }
  return (
    `${view.kind} session quota reached — ${view.live} live + ${view.starts} starting ` +
    `> ${view.cap} (agents.${view.kind}.maxSessions in bro.config)`
  )
}

/** The budget of every kind this command would start a session of.
 *
 *  A kind is asked only when its plane claims the command (the plane
 *  owns the grammar); a kind with no cap armed contributes nothing.
 *  The count is the plane's own (`countLive`) plus the reservations
 *  bro holds for in-flight starts — the same arithmetic the admission
 *  runs, so all call sites share one budget.
 *
 *  Throws `SpawnError('unavailable')` when a plane cannot establish its
 *  count: a quota that cannot be verified must not be walked past. The
 *  CALLER decides what that means — a quota fails closed, a hook fails
 *  open (REVIEW.md: hooks must never stall a client). */
export function sessionCapViews(
  command: string,
  agents: Record<string, Record<string, unknown>> | undefined,
  workerEnv?: Record<string, string>
): SessionCapView[] {
  if (command.trim() === '') {
    return []
  }
  const views: SessionCapView[] = []
  for (const plane of sessionPlanes()) {
    const view = capViewFor(plane, command, agents, workerEnv)
    if (view !== undefined) {
      views.push(view)
    }
  }
  return views
}

/** One plane's budget for a command — undefined when the plane does not
 *  claim the command, or when no cap is armed for its kind. */
function capViewFor(
  plane: SessionPlane,
  command: string,
  agents: Record<string, Record<string, unknown>> | undefined,
  workerEnv?: Record<string, string>
): SessionCapView | undefined {
  if (plane.startsSessions === undefined) {
    return undefined
  }
  const starts = plane.startsSessions(command)
  if (starts <= 0) {
    return undefined
  }
  const quota = sessionQuotaConfig(agents, plane.kind)
  if (quota === undefined) {
    return undefined
  }
  if (quota.invalid === true) {
    // a present-but-malformed cap is a config bug: the admission
    // refuses it loudly, and the cap must not read as UNCAPPED here
    throw new SpawnError(
      `agents.${plane.kind}.${quota.invalidKey ?? 'maxSessions'} must be a positive integer`,
      'config'
    )
  }
  if (quota.maxSessions <= 0) {
    return undefined
  }
  const bag = agents?.[plane.kind] ?? {}
  const live = plane.countLive(bag, workerEnv)
  const reservations = countSessionReservations(
    sessionSlotsDir(plane.kind, quota.reservationsDir)
  )
  return { kind: plane.kind, live: live + reservations, cap: quota.maxSessions, starts }
}

/** The first refusal among the kinds a command touches, or undefined. */
export function sessionCapRefusalFor(
  command: string,
  agents: Record<string, Record<string, unknown>> | undefined,
  workerEnv?: Record<string, string>
): string | undefined {
  for (const view of sessionCapViews(command, agents, workerEnv)) {
    const refusal = sessionCapRefusal(view)
    if (refusal !== undefined) {
      return refusal
    }
  }
  return undefined
}

/** The plane that claims a command's sessions — the registry's answer,
 *  for callers that need the plane itself (the vendor package's own
 *  reservation, a status row). */
export function planeStartingSessions(command: string): SessionPlane | undefined {
  for (const plane of sessionPlanes()) {
    if (plane.startsSessions !== undefined && plane.startsSessions(command) > 0) {
      return plane
    }
  }
  return undefined
}

/** Every plane claiming sessions of `command` — a compound command can
 *  start more than one kind's session, so callers running the locked
 *  admission judge them all. */
export function planesStartingSessions(command: string): SessionPlane[] {
  return sessionPlanes().filter(
    (plane) => plane.startsSessions !== undefined && plane.startsSessions(command) > 0
  )
}

/** Drop the claims a refused start took — the budget must not keep
 *  a slot for a call that never ran. */
export function releaseSessionStart(paths: string[]): void {
  for (const path of paths) {
    releaseSessionSlot(path)
  }
}

/** The dir a kind's in-flight starts are claimed in — the same files
 *  the admission counts, so every call site shares ONE budget. */
export function sessionReservationsDir(
  kind: string,
  agents: Record<string, Record<string, unknown>> | undefined
): string {
  const quota = sessionQuotaConfig(agents, kind)
  return sessionSlotsDir(kind, quota?.reservationsDir)
}

/** Claim the slots a start is about to take.
 *
 *  The count is taken before the session writes its own mark, so a
 *  burst of parallel starts would all see the same headroom. The
 *  claim closes that window: the next start sees the slot taken.
 *
 *  The claim expires with the shared TTL (`SESSION_SLOT_TTL_MS`), and
 *  the session's own mark joins the count when it lands — so the
 *  budget errs LOW for a couple of minutes, never high. That is the
 *  right direction for a shared account. */
export function reserveSessionStart(claim: {
  kind: string
  agents: Record<string, Record<string, unknown>> | undefined
  key: string
  count: number
  /** The lane the claim belongs to — the batch cap counts only the
   *  fleet's claims, so an interactive start never eats the fleet's
   *  share. */
  lane?: ReservationLane
}): { paths: string[]; fresh: boolean } {
  if (claim.count <= 0) {
    return { paths: [], fresh: false }
  }
  const dir = sessionReservationsDir(claim.kind, claim.agents)
  const lane = claim.lane ?? 'interactive'
  const paths: string[] = []
  let fresh = false
  for (let i = 0; i < claim.count; i++) {
    const claimed = reserveSessionSlotOnce(dir, `${claim.key}-${i}`, lane)
    paths.push(claimed.path)
    fresh = fresh || claimed.fresh
  }
  return { paths, fresh }
}

/** One start's admission — the claim taken under the kind's mutex plus
 *  the cap's verdict computed on the pre-claim count. */
export interface SessionStartAdmission {
  /** the slots this call holds — release with `releaseSessionStart`
   *  when the start never ran. Empty when `refusal` is set: fresh
   *  claims are dropped inside the section, held ones belong to the
   *  earlier event that claimed them. */
  paths: string[]
  /** false when every slot was already held — a repeat event of the
   *  same call (its start is already inside the count). */
  fresh: boolean
  /** the refusal line when the cap is full. */
  refusal?: string
}

/** The cap's check+claim under the kind's OWN admission mutex — the
 *  same file `admitSessionSlot` locks, so a start through the guard,
 *  the conductor, or a bro spawn serializes on ONE budget: the count
 *  inside the mutex already holds every earlier claim. A check taken
 *  before the lock is exactly the stale read the race runs on, so the
 *  view is re-counted inside the section.
 *
 *  Returns undefined when the plane does not claim the command or no
 *  cap is armed for the kind. Throws: `SpawnError('config')` on a
 *  malformed knob and `SpawnError('unavailable')` on a count that
 *  cannot be established — both from `capViewFor` inside the lock —
 *  plus the claim's own fs error. `LockTimeout` propagates
 *  UNtranslated: the caller owns the degradation — a hook falls back
 *  to the un-locked path and never stalls the client, a quota surface
 *  keeps its own posture. */
export function admitSessionStart(args: {
  /** the plane claiming the command — the caller resolves it (every
   *  plane for a multi-kind command via `planesStartingSessions`). */
  plane: SessionPlane
  command: string
  agents: Record<string, Record<string, unknown>> | undefined
  /** the claim key — idempotent per call: the two hook events of one
   *  call share it, a conductor request gets its own. */
  key: string
  lane?: ReservationLane
  workerEnv?: Record<string, string>
  /** sessions the caller itself holds that the plane cannot see — the
   *  conductor's retained conversations riding one shared peer —
   *  counted with the host's inside the lock. */
  extraLive?: number
  /** lock wait bound — a hook passes a small one (never stalls). */
  waitMs?: number
}): SessionStartAdmission | undefined {
  const plane = args.plane
  if (plane.startsSessions === undefined || plane.startsSessions(args.command) <= 0) {
    return undefined
  }
  const quota = sessionQuotaConfig(args.agents, plane.kind)
  if (quota === undefined) {
    return undefined
  }
  return withFileLock(
    sessionAdmissionLock(plane.kind, quota.reservationsDir),
    () => {
      const view = capViewFor(plane, args.command, args.agents, args.workerEnv)
      if (view === undefined) {
        return undefined
      }
      // claim first — a repeat event's slot is already inside the
      // count, so its start is judged once (starts: 0), never twice
      const claim = reserveSessionStart({
        kind: view.kind,
        agents: args.agents,
        key: args.key,
        count: view.starts,
        lane: args.lane,
      })
      const refusal = sessionCapRefusal({
        ...view,
        live: view.live + (args.extraLive ?? 0),
        starts: claim.fresh ? view.starts : 0,
      })
      if (refusal !== undefined) {
        if (claim.fresh) {
          releaseSessionStart(claim.paths)
        }
        return { paths: [], fresh: claim.fresh, refusal }
      }
      return { paths: claim.paths, fresh: claim.fresh }
    },
    { label: `${plane.kind} session cap admission`, waitMs: args.waitMs }
  )
}
