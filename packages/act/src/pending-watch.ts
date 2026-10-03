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
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
    const gd = execFileSync( // NOSONAR — git is the runner's own tool; PATH is trusted config
      'git',
      ['-C', dir, 'rev-parse', '--git-common-dir'],
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

/** Drop a marker for the running wait — best-effort. Cleanup runs
 *  before the new marker is published: a listWatches pass prunes
 *  TTL-expired residue, and dead-pid markers for the same PR are
 *  retired — the new watch supersedes their stale promise. Dead-pid
 *  markers for other PRs stay: a session-start report may still flag
 *  them. The marker is written to a tmp file then renamed so a crash
 *  mid-write never leaves a partial JSON marker behind. */
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
    for (const { watch, file, alive } of listWatches(dir)) {
      if (!alive && watch.pr === w.pr) {
        try {
          rmSync(file)
        } catch {
          // retire is best-effort
        }
      }
    }
    const path = join(wd, `${w.pr}-${process.pid}.json`)
    const tmp = `${path}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({ ...w, pid: process.pid, startedAt: Date.now() }, null, 2)
    )
    renameSync(tmp, path)
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
    const file = join(wd, f)
    if (!f.endsWith('.json')) {
      // residue of an interrupted atomic write — prune
      try {
        rmSync(file)
      } catch {
        // prune is best-effort
      }
      continue
    }
    try {
      const w = JSON.parse(readFileSync(file, 'utf8')) as PendingWatch
      if (
        typeof w.pr !== 'number' ||
        typeof w.pid !== 'number' ||
        typeof w.startedAt !== 'number'
      ) {
        throw new Error('malformed marker')
      }
      if (Date.now() - w.startedAt > WATCH_TTL_MS) {
        rmSync(file)
        continue
      }
      out.push({ watch: w, file, alive: pidAlive(w.pid) })
    } catch {
      // malformed or unreadable marker — prune so it never lingers
      try {
        rmSync(file)
      } catch {
        // prune is best-effort
      }
    }
  }
  return out
}
