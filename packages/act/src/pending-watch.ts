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
import { dirname, join, resolve } from 'node:path'
import { pidAlive, procStat } from '@broject/core'

export interface PendingWatch {
  pr: number
  /** Display link, e.g. `[#42](https://github.com/o/r/pull/42)`. */
  link: string
  pid: number
  /** Watcher's /proc start identity — a live pid with a different start
   *  is a reused pid, not the watch that recorded this marker. */
  pidStart?: string
  merge: boolean
  /** The original wait's --cleanup — rearm replays it so a resurrected
   *  watch keeps the whole promise, not just the poll. */
  cleanup?: boolean
  startedAt: number
  timeoutMin: number
}

export interface ListedWatch {
  watch: PendingWatch
  /** Marker path — the reporter removes it once flagged. */
  file: string
  /** Watching process still lives — parallel work, not a broken promise. */
  alive: boolean
  /** Renamed to `.retired` — a session already claimed the report, but
   *  the claim says nothing about delivery; a fresh retired marker is
   *  still listed so a lost warning re-flags at the next session start. */
  reported?: boolean
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
        killSignal: 'SIGKILL',
      }
    ).trim()
    return gd ? join(resolve(dir, gd), 'bro', 'watches') : null
  } catch {
    return null
  }
}

/** Does watch `a` keep marker `b`'s promise? Same PR, and `a`'s merge
 *  mode at least as strong: a merge wait also watches, so merge:true
 *  covers both modes; a watch-only wait covers only another watch-only
 *  promise — a dead merge:true marker left behind by a merge:false
 *  replacement still has to flag, or the merge intent dies silently
 *  with the old process. */
function covers(a: PendingWatch, b: PendingWatch): boolean {
  return a.pr === b.pr && (a.merge || !b.merge)
}

function coveredBy(live: ListedWatch[], w: PendingWatch): boolean {
  return live.some((l) => covers(l.watch, w))
}

/** Drop a marker for the running wait — best-effort. The marker is
 *  published via tmp write + atomic rename so a crash mid-write never
 *  leaves a partial marker. Dead markers the new wait covers are NOT
 *  retired here — the replacement hasn't kept the promise yet, so they
 *  stay on disk (hidden from reports by listWatches) until the covering
 *  watch ends. A replacement that crashes leaves both records
 *  flaggable; one that completes retires them in watchEnd. */
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
    return path
  } catch {
    return null
  }
}

/** Remove this wait's own marker — called on settle, timeout, or throw.
 *  Ending is also the retire point for dead markers this watch covered:
 *  while it lived they were a promise still being kept (listWatches hid
 *  them), and the ending session reported the outcome itself, so the
 *  superseded record must not resurface as a false stale flag. Dead
 *  markers it never covered — or another live watch still covers —
 *  stay. */
export function watchEnd(path: string | null): void {
  if (!path) {
    return
  }
  const w = readMarker(path)
  try {
    rmSync(path)
  } catch {
    // the marker is best-effort — a failed remove leaves residue the TTL prunes
  }
  if (w === null) {
    return
  }
  const listed = listWatchesIn(dirname(path))
  const live = listed.filter((l) => l.alive)
  for (const d of listed) {
    if (!d.alive && covers(w, d.watch) && !coveredBy(live, d.watch)) {
      try {
        rmSync(d.file)
      } catch {
        // retire is best-effort
      }
    }
  }
}

/** A heartbeat marker for a long-lived supervisor (`bro drive --every`)
 *  that can't bracket its coverage with begin/end — it polls forever, so
 *  the marker's name is deterministic per (pr, kind, pid) and each sweep
 *  rewrites the same file. Coverage lives exactly as long as the
 *  supervisor's pid: a dead drive leaves a dead marker, which is exactly
 *  the stale-supervision flag the session-start hook reports. */
export function watchHeartbeat(
  dir: string,
  w: Omit<PendingWatch, 'pid' | 'startedAt'>,
  kind = 'supervisor'
): string | null {
  const wd = watchesDir(dir)
  if (!wd) {
    return null
  }
  try {
    mkdirSync(wd, { recursive: true })
    const path = join(wd, `${w.pr}-${kind}-${process.pid}.json`)
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
    return path
  } catch {
    return null
  }
}

/** Is a live watch covering `pr`? Tri-state for gate decisions:
 *  `true`/`false` are verdicts; `null` means the store could not be
 *  read (no git dir, EACCES, ...) — callers that block on "unwatched"
 *  must treat `null` as fail-open, since listWatches' empty list cannot
 *  distinguish "no markers" from "markers unreadable". A missing dir
 *  (ENOENT) IS a verdict: no markers have ever been written. */
export function hasLiveWatch(dir: string, pr: number): boolean | null {
  const wd = watchesDir(dir)
  if (!wd) {
    return null
  }
  try {
    readdirSync(wd)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
  return listWatchesIn(wd).some((l) => l.alive && l.watch.pr === pr)
}

/** Claim a reported stale marker — the rename is the atomic claim:
 *  exactly one concurrent caller wins it. The `.retired` file is kept,
 *  not deleted — the claim proves nothing about delivery, so the marker
 *  stays listed as `reported` and re-flags at the next session start if
 *  the warning was lost; the normal TTL prune (or a covering watchEnd)
 *  is what finally removes it. Returns true only for the winner. */
export function watchRetire(file: string): boolean {
  try {
    renameSync(file, `${file}.retired`)
  } catch {
    return false // gone or claimed by a racing retire — it reports
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
      (w.cleanup === undefined || typeof w.cleanup === 'boolean') &&
      // an Infinity/NaN startedAt poisons the TTL check — Date.now() -
      // Infinity is never > ttl, so the marker would never be pruned
      typeof w.startedAt === 'number' &&
      Number.isFinite(w.startedAt) &&
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
function listWatchesIn(wd: string): ListedWatch[] {
  let files: string[]
  try {
    files = readdirSync(wd)
  } catch {
    return []
  }
  const out: ListedWatch[] = []
  for (const f of files) {
    const file = join(wd, f)
    const retired = f.endsWith('.json.retired')
    if (!f.endsWith('.json') && !retired) {
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
    // a retired marker is stale by definition — pid reuse since the
    // claim must not resurrect it into a live watch
    out.push({ watch: w, file, alive: !retired && pidAlive(w.pid, w.pidStart), reported: retired })
  }
  return out
}

/** All recorded watches with pid liveness — a dead pid means the session
 *  that promised to watch is gone and nobody is polling. Anything that
 *  isn't a fresh, well-formed marker (abandoned tmp write, malformed
 *  JSON, TTL-expired, retire residue) is pruned on the way through. A
 *  dead marker superseded by a live watcher that covers its merge mode
 *  is not reported — the replacement already keeps the promise, so
 *  flagging the old one would be a false stale flag. */
export function listWatches(dir: string): ListedWatch[] {
  const wd = watchesDir(dir)
  if (!wd) {
    return []
  }
  const out = listWatchesIn(wd)
  const live = out.filter((l) => l.alive)
  return out.filter((l) => l.alive || !coveredBy(live, l.watch))
}

/** Dead watches deduped to one rearm plan per PR — the strongest
 *  recorded mode wins (a dead merge:true marker re-arms as --merge even
 *  when a watch-only marker died alongside). The caller checks the PR
 *  is still open before respawning; `files` are this PR's dead markers
 *  to drop once the replacement watch is up. */
export function deadWatchPlan(
  dir: string
): Array<{ pr: number; merge: boolean; cleanup: boolean; timeoutMin: number; files: string[] }> {
  const byPr = new Map<
    number,
    { merge: boolean; cleanup: boolean; timeoutMin: number; files: string[] }
  >()
  for (const l of listWatches(dir)) {
    if (l.alive) {
      continue
    }
    const cur = byPr.get(l.watch.pr)
    if (cur === undefined) {
      byPr.set(l.watch.pr, {
        merge: l.watch.merge,
        cleanup: l.watch.cleanup === true,
        timeoutMin: l.watch.timeoutMin,
        files: [l.file],
      })
      continue
    }
    cur.files.push(l.file)
    cur.merge = cur.merge || l.watch.merge
    cur.cleanup = cur.cleanup || l.watch.cleanup === true
    cur.timeoutMin = Math.max(cur.timeoutMin, l.watch.timeoutMin)
  }
  return [...byPr.entries()].map(([pr, p]) => ({ pr, ...p }))
}

/** Resurrect dead watchers: host reboot / turn teardown kills the
 *  polling process but the promise — and a still-open PR — stays. Per
 *  open PR `respawn` puts a fresh `act wait` up (its marker covers the
 *  dead one); a settled PR's markers just get swept — reality already
 *  kept the promise. A host probe that can't answer keeps the marker:
 *  dropping the flag on an unverified PR is exactly the silent loss the
 *  marker exists to prevent. */
export async function rearmWatches(opts: {
  dir: string
  isOpen: (pr: number) => Promise<boolean>
  /** Absent → plan-only dry run: nothing respawns, no marker moves,
   *  open PRs report as `rearmed` with pid 0. */
  respawn?: (plan: {
    pr: number
    merge: boolean
    cleanup: boolean
    timeoutMin: number
  }) => number | undefined
}): Promise<{
  rearmed: Array<{ pr: number; pid: number }>
  settled: number[]
  kept: Array<{ pr: number; reason: string }>
}> {
  const rearmed: Array<{ pr: number; pid: number }> = []
  const settled: number[] = []
  const kept: Array<{ pr: number; reason: string }> = []
  for (const plan of deadWatchPlan(opts.dir)) {
    let open: boolean
    try {
      open = await opts.isOpen(plan.pr)
    } catch (err) {
      kept.push({ pr: plan.pr, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (!open) {
      settled.push(plan.pr)
      // a dry run reports but never mutates — markers move only on a
      // real sweep
      if (opts.respawn !== undefined) {
        for (const f of plan.files) {
          pruneFile(f)
        }
      }
      continue
    }
    if (opts.respawn === undefined) {
      rearmed.push({ pr: plan.pr, pid: 0 })
      continue
    }
    const pid = opts.respawn(plan)
    if (pid === undefined) {
      kept.push({ pr: plan.pr, reason: 'respawn failed' })
      continue
    }
    rearmed.push({ pr: plan.pr, pid })
    for (const f of plan.files) {
      pruneFile(f)
    }
  }
  return { rearmed, settled, kept }
}

