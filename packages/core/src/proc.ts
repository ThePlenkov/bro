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
  let signaled = false
  try {
    process.kill(pid, 0)
    signaled = true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') {
      return false
    }
  }
  const st = procStat(pid)
  if (st?.state === 'Z') {
    return false
  }
  if (!signaled) {
    return true
  }
  return (
    pidStart === undefined || st === null || st.start === '' || st.start === pidStart
  )
}
