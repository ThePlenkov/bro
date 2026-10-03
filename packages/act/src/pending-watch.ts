/**
 * Pending-watch markers — `bro act wait` polls a PR gate in a
 * session-bound process: when the turn dies the poll dies with it and
 * the promised "I'll report when it merges" never lands (bro-97lk).
 * The wait drops a marker in <git-common-dir>/bro/watches/ for its
 * lifetime; a marker whose pid is dead at the next session start is
 * the stale promise — the act connector surfaces it in session-start
 * lines and retires it so it flags exactly once.
 *
 * Fail-open throughout: no git dir, unwritable dir, unreadable marker —
 * the wait still runs, the hook just has nothing to report.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface PendingWatch {
  pr: number
  /** Display link, e.g. `[#42](https://github.com/o/r/pull/42)`. */
  link: string
  pid: number
  merge: boolean
  startedAt: number
  timeoutMin: number
}

export interface ListedWatch {
  watch: PendingWatch
  /** Marker path — the reporter removes it once flagged. */
  file: string
  /** Watching process still lives — parallel work, not a broken promise. */
  alive: boolean
}

/** A marker older than a day is residue regardless of pid. */
const WATCH_TTL_MS = 24 * 60 * 60 * 1000

/** <git-common-dir>/bro/watches — the common dir so a watch started in
 *  one linked worktree is visible to sessions in every other. */
function watchesDir(dir: string): string | null {
  try {
    const gd = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--git-common-dir'], // NOSONAR — git is the runner's own tool
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return gd ? join(resolve(dir, gd), 'bro', 'watches') : null
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Drop a marker for the running wait — best-effort. A listWatches pass
 *  prunes TTL-expired residue first (dead-pid markers stay — a
 *  session-start report may still flag them). */
export function watchBegin(
  dir: string,
  w: Omit<PendingWatch, 'pid' | 'startedAt'>
): string | null {
  const wd = watchesDir(dir)
  if (!wd) {
    return null
  }
  try {
    mkdirSync(wd, { recursive: true })
    listWatches(dir)
    const path = join(wd, `${w.pr}-${process.pid}.json`)
    writeFileSync(
      path,
      JSON.stringify({ ...w, pid: process.pid, startedAt: Date.now() }, null, 2)
    )
    return path
  } catch {
    return null
  }
}

/** Remove this wait's own marker — called on settle, timeout, or throw. */
export function watchEnd(path: string | null): void {
  if (!path) {
    return
  }
  try {
    rmSync(path)
  } catch {
    // the marker is best-effort — a failed remove leaves residue the TTL prunes
  }
}

/** Remove a reported stale marker — flagged once, then retired. */
export function watchRetire(file: string): void {
  try {
    rmSync(file)
  } catch {
    // best-effort
  }
}

/** All recorded watches with pid liveness — a dead pid means the session
 *  that promised to watch is gone and nobody is polling. */
export function listWatches(dir: string): ListedWatch[] {
  const wd = watchesDir(dir)
  if (!wd) {
    return []
  }
  const out: ListedWatch[] = []
  let files: string[]
  try {
    files = readdirSync(wd)
  } catch {
    return out
  }
  for (const f of files) {
    if (!f.endsWith('.json')) {
      continue
    }
    const file = join(wd, f)
    try {
      const w = JSON.parse(readFileSync(file, 'utf8')) as PendingWatch
      if (
        typeof w.pr !== 'number' ||
        typeof w.pid !== 'number' ||
        typeof w.startedAt !== 'number'
      ) {
        continue
      }
      if (Date.now() - w.startedAt > WATCH_TTL_MS) {
        try {
          rmSync(file)
        } catch {
          // prune is best-effort
        }
        continue
      }
      out.push({ watch: w, file, alive: pidAlive(w.pid) })
    } catch {
      // unreadable marker — skip
    }
  }
  return out
}
