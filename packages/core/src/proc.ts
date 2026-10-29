/**
 * Process liveness over /proc — the shared probe behind pending-watch
 * markers, the agents registry lock, and session work markers. Kill(0)
 * alone lies twice: it answers for zombies (nobody polling) and can't
 * tell a reused pid from the process that recorded it.
 */
import { readFileSync } from 'node:fs'

/** The process's /proc identity — state byte (field 3: 'Z' marks an
 *  unreaped zombie) and starttime (field 22). Post-comm fields split
 *  from index 0 = field 3. Null where /proc is absent or unreadable. */
export function procStat(
  pid: number
): { state: string; start: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { state: rest[0] ?? '', start: rest[19] ?? '' }
  } catch {
    return null
  }
}

/** pid alive = kill(pid, 0) doesn't throw, or throws EPERM (a live
 *  process owned by another uid — not ours to verify, still alive).
 *  Two exceptions where a surviving answer still means dead:
 *
 *  - an unreaped zombie ('Z' state) — kill succeeds, nobody is there;
 *  - pid reuse — when the caller recorded pidStart, a live pid with a
 *    different starttime is a different process.
 *
 *  Unverifiable identity (no /proc, unreadable stat) stays fail-open:
 *  alive, never a false stale report. A non-positive or non-integer
 *  pid is dead input, not unverifiable: kill(0) and kill(-pid) answer
 *  for process groups, so the signal cannot attest that pid. */
export function pidAlive(pid: number, pidStart?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
  } catch (e) {
    // EPERM = exists but owned by another uid — still subject to the
    // zombie and reuse checks below; /proc stat is world-readable, so
    // foreign ownership doesn't make identity unverifiable
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') {
      return false
    }
  }
  const st = procStat(pid)
  if (st?.state === 'Z') {
    return false
  }
  return (
    pidStart === undefined || st === null || st.start === '' || st.start === pidStart
  )
}

/** An attempt handle's identity — `<pid> [starttime]`: the worker
 *  publishes its /proc starttime beside the pid so a reader can pin
 *  identity against pid reuse (the same pair markerOwner carries). A
 *  bare pid — a pre-identity handle, or a platform with no /proc for
 *  the worker to read — parses with `start` undefined: unverifiable,
 *  so callers stay fail-open the way pidAlive documents. Null when no
 *  positive integer pid is there at all. */
export function handleOwner(text: string): { pid: number; start?: string } | null {
  const parts = text.trim().split(/\s+/)
  const pid = Number(parts[0])
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  const start = parts[1]
  return start === undefined || start === '' ? { pid } : { pid, start }
}

/** Line 1 of a session/work marker: `<millis> [pid start]` — the pid
 *  pair is the owning process's identity (start disambiguates reuse).
 *  A pid without a start can't disambiguate, so it reads as ownerless:
 *  a reuse-blind owner would suppress the mtime fallback while still
 *  trusting a recycled pid — the worst of both planes. */
export function markerOwner(
  firstLine: string | undefined
): { pid: number; start: string } | null {
  const parts = (firstLine ?? '').trim().split(' ')
  const pid = Number(parts[1])
  const start = parts[2] ?? ''
  return Number.isInteger(pid) && pid > 0 && start !== ''
    ? { pid, start }
    : null
}

/** Is this marker's owning session alive? A recorded owner decides by
 *  pid liveness alone — a dead session's marker is residue even when
 *  its mtime is fresh, and a live session's marker stays live past the
 *  freshness window. Ownerless markers fall back to the window. */
export function markerLive(
  firstLine: string | undefined,
  mtimeMs: number,
  liveMs: number,
  now: number = Date.now()
): boolean {
  const owner = markerOwner(firstLine)
  return owner === null
    ? mtimeMs >= now - liveMs
    : pidAlive(owner.pid, owner.start || undefined)
}
