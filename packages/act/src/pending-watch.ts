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
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

export interface PendingWatch {
  pr: number
  /** Display link, e.g. `[#42](https://github.com/o/r/pull/42)`. */
  link: string
  pid: number
  /** Watcher's /proc start identity — a live pid with a different start
   *  is a reused pid, not the watch that recorded this marker. */
  pidStart?: string
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

/** A marker older than a day is residue regardless of pid — unless the
 *  wait recorded a longer timeout; the marker must outlive its poll. */
const WATCH_TTL_MS = 24 * 60 * 60 * 1000

function watchTtlMs(w: PendingWatch): number {
  const configured = Number.isFinite(w.timeoutMin) ? w.timeoutMin * 60_000 : 0
  return Math.max(WATCH_TTL_MS, configured)
}

/** <git-common-dir>/bro/watches — the common dir so a watch started in
 *  one linked worktree is visible to sessions in every other. */
function watchesDir(dir: string): string | null {
  try {
    const gd = execFileSync(
      'git', // NOSONAR — git is the runner's own tool; PATH is trusted config
      ['-C', dir, 'rev-parse', '--git-common-dir'],
      // a hung git must not stall a wait start or the session-start hook —
      // bound the lookup so a stalled process fails open
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }
    ).trim()
    return gd ? join(resolve(dir, gd), 'bro', 'watches') : null
  } catch {
    return null
  }
}

/** The process's /proc identity — state byte (field 3: 'Z' marks an
 *  unreaped zombie) and starttime (field 22). Post-comm fields split
 *  from index 0 = field 3. Null where /proc is absent. */
function procStat(pid: number): { state: string; start: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { state: rest[0] ?? '', start: rest[19] ?? '' }
  } catch {
    return null
  }
}

function pidAlive(pid: number, pidStart?: string): boolean {
  try {
    process.kill(pid, 0)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
  const st = procStat(pid)
  // a zombie answers kill(pid, 0) but nobody is polling — the watching
  // session is gone for reporting purposes
  if (st?.state === 'Z') {
    return false
  }
  // verify it is the same process the marker recorded; an unverifiable
  // identity stays fail-open (alive, not a stale promise)
  return (
    pidStart === undefined || st === null || st.start === '' || st.start === pidStart
  )
}

/** Drop a marker for the running wait — best-effort. The new marker is
 *  published first (tmp write + atomic rename), and only then are
 *  dead-pid markers for the same PR retired — a failed write or
 *  cleanup must never strand a stale promise unreported while also
 *  losing the replacement. Dead-pid markers for other PRs stay: a
 *  session-start report may still flag them. */
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
    // unique per wait — two waits on the same PR in one process each own
    // their marker, so neither publish nor watchEnd clobbers the other's
    const path = join(
      wd,
      `${w.pr}-${process.pid}-${randomBytes(6).toString('hex')}.json`
    )
    const tmp = `${path}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          ...w,
          pid: process.pid,
          pidStart: procStat(process.pid)?.start ?? undefined,
          startedAt: Date.now(),
        },
        null,
        2
      )
    )
    renameSync(tmp, path)
    // the new promise is durable — now retire dead-pid markers for this
    // PR; listWatches also prunes TTL-expired residue on the way through
    for (const { watch, file, alive } of listWatches(dir)) {
      if (!alive && watch.pr === w.pr) {
        try {
          rmSync(file)
        } catch {
          // retire is best-effort
        }
      }
    }
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

/** Remove a reported stale marker — flagged once, then retired. The
 *  rename is the atomic claim: exactly one concurrent caller wins it,
 *  so a dead marker is reported once even when two session starts race.
 *  Returns true only for the caller that claimed the retire. */
export function watchRetire(file: string): boolean {
  try {
    renameSync(file, `${file}.retired`)
  } catch {
    return false // gone or claimed by a racing retire — it reports
  }
  try {
    rmSync(`${file}.retired`)
  } catch {
    // claimed already — a racing prune beating this delete is equivalent
  }
  return true
}

function readMarker(file: string): PendingWatch | null {
  try {
    const w = JSON.parse(readFileSync(file, 'utf8')) as PendingWatch
    return typeof w.pr === 'number' &&
      typeof w.link === 'string' &&
      typeof w.pid === 'number' &&
      (w.pidStart === undefined || typeof w.pidStart === 'string') &&
      typeof w.merge === 'boolean' &&
      typeof w.startedAt === 'number' &&
      typeof w.timeoutMin === 'number'
      ? w
      : null
  } catch {
    return null
  }
}

function pruneFile(file: string): void {
  try {
    rmSync(file)
  } catch {
    // prune is best-effort
  }
}

function fileAge(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0 // vanished — the prune attempt below fails silently too
  }
}

/** All recorded watches with pid liveness — a dead pid means the session
 *  that promised to watch is gone and nobody is polling. Anything that
 *  isn't a fresh, well-formed marker (abandoned tmp write, malformed
 *  JSON, TTL-expired, retire residue) is pruned on the way through. */
export function listWatches(dir: string): ListedWatch[] {
  const wd = watchesDir(dir)
  if (!wd) {
    return []
  }
  let files: string[]
  try {
    files = readdirSync(wd)
  } catch {
    return []
  }
  const out: ListedWatch[] = []
  for (const f of files) {
    const file = join(wd, f)
    if (!f.endsWith('.json')) {
      // a .tmp between write and rename is a marker mid-publication —
      // prune it only once it is old enough to be crash residue
      if (!f.endsWith('.tmp') || Date.now() - fileAge(file) > WATCH_TTL_MS) {
        pruneFile(file)
      }
      continue
    }
    const w = readMarker(file)
    if (w === null || Date.now() - w.startedAt > watchTtlMs(w)) {
      pruneFile(file)
      continue
    }
    out.push({ watch: w, file, alive: pidAlive(w.pid, w.pidStart) })
  }
  return out
}

