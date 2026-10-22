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
 * admission uses — spec bro-9vmx's reservation lifecycle).
 */
import { SpawnError } from './agents.ts'
import {
  countSessionReservations,
  reserveSessionSlotOnce,
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
}): string[] {
  if (claim.count <= 0) {
    return []
  }
  const dir = sessionReservationsDir(claim.kind, claim.agents)
  const lane = claim.lane ?? 'interactive'
  const paths: string[] = []
  for (let i = 0; i < claim.count; i++) {
    paths.push(reserveSessionSlotOnce(dir, `${claim.key}-${i}`, lane))
  }
  return paths
}
