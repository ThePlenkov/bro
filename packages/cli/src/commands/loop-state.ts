/**
 * Loop-agent run records — `<git-common>/bro/loop/<slug>.{json,log}`
 * (spec specs/bro-9lpn3.md). `bro loop`'s worker spawn is synchronous
 * — no registry row, no fleet slot — so the run record plus the tee'd
 * output log are the only artifacts a check-in (`bro watch`,
 * `bro status`) can judge liveness and silence from. The `.json`
 * exists while the agent runs: `{beadId, slug, pid, startedAt,
 * worktree, log}`; the `.log` persists as the audit trail across
 * fix-round respawns (append, like the agents-plane convention). Its
 * mtime IS the last-output signal — readers report silence, never
 * kill.
 *
 * `bro/loop/` and not `bro/agents/`: a record there would pose as a
 * backend-owned agent home, and the janitor's orphan sweep reaps
 * files no live registry entry claims.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { gitTry, pidAlive } from '@broject/core'

/** What the loop records for an in-flight spawn — pid + pidStart are
 *  the liveness pair check-ins read (start disambiguates a recycled
 *  pid); `log` names the output file whose mtime carries the
 *  last-progress signal. */
export interface LoopRunRecord {
  beadId: string
  /** the whole claimed clump — a batch's members share the lead's
   *  worker and record, so their claims trace to this pid too
   *  (bro-ho09d) */
  beadIds?: string[]
  slug: string
  pid: number
  /** /proc starttime at spawn — survives pid-reuse checks. */
  pidStart?: string
  startedAt: string
  worktree: string
  log: string
}

/** A record as a check-in reads it — 'dead' when its pid is gone (a
 *  crashed loop's residue), otherwise 'running' with the output
 *  silence so far. `silentMs` is null when neither the log nor
 *  startedAt could be read — an unverifiable record is reported, not
 *  guessed. */
export interface LoopRunView {
  beadId: string
  /** the claimed clump when the record carries it (see LoopRunRecord) */
  beadIds?: string[]
  slug: string
  pid: number | null
  state: 'running' | 'dead'
  startedAt?: string
  worktree?: string
  log?: string
  silentMs: number | null
}

/** `<git-common>/bro/loop` — shared across every linked worktree, same
 *  anchor as agents.json and the stack edges. Null when git can't name
 *  the common dir (a record-less spawn still works — nothing to read
 *  back is the only cost). */
export function loopRunsDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'loop')
}

/** The output log a spawn record names — may not exist yet at read
 *  time; the writer creates it when the child's first byte arrives
 *  (append mode — respawns continue the same bead's trail). */
export function loopRunLog(dir: string, slug: string): string | null {
  const home = loopRunsDir(dir)
  return home === null ? null : join(home, `${slug}.log`)
}

const recordPath = (dir: string, slug: string): string | null => {
  const home = loopRunsDir(dir)
  return home === null ? null : join(home, `${slug}.json`)
}

/** Record a spawn — tmp+rename so a reader never parses a half file.
 *  Best-effort: the record is a read model, not a lock; a failed write
 *  must never break the spawn it describes. */
export function beginLoopRun(dir: string, rec: LoopRunRecord): void {
  const path = recordPath(dir, rec.slug)
  if (path === null) {
    return
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`)
    renameSync(tmp, path)
  } catch {
    // advisory record — a failed write loses the check-in row, not the run
  }
}

/** Retire a settled spawn's record. Idempotent — a missing file is the
 *  desired end state. The .log stays: it is the audit trail. */
export function endLoopRun(dir: string, slug: string): void {
  const path = recordPath(dir, slug)
  if (path === null) {
    return
  }
  try {
    rmSync(path, { force: true })
  } catch {
    // residue a reader flags as 'dead' — never a failure path
  }
}

function readRecord(path: string, slug: string): LoopRunRecord | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof v !== 'object' || v === null) {
      return null
    }
    const r = v as Record<string, unknown>
    if (typeof r.pid !== 'number') {
      return null
    }
    return {
      beadId: typeof r.beadId === 'string' && r.beadId !== '' ? r.beadId : slug,
      beadIds: Array.isArray(r.beadIds)
        ? r.beadIds.filter((b): b is string => typeof b === 'string' && b !== '')
        : undefined,
      slug,
      pid: r.pid,
      pidStart: typeof r.pidStart === 'string' && r.pidStart !== '' ? r.pidStart : undefined,
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
      worktree: typeof r.worktree === 'string' ? r.worktree : '',
      log: typeof r.log === 'string' ? r.log : '',
    }
  } catch {
    return null
  }
}

function silenceMs(rec: LoopRunRecord | null, recordMtime: number, now: number): number | null {
  // the log's mtime is the last-output signal; a never-written log (or
  // a record that couldn't name one) falls back to the record's own
  // stamp — silence since spawn is still honest
  const logMtime =
    rec?.log !== undefined && rec.log !== ''
      ? (() => {
          try {
            return statSync(rec.log).mtimeMs
          } catch {
            return null
          }
        })()
      : null
  // the append-only .log survives fix-round respawns — a stale log
  // mtime must not predate this spawn's record stamp, or a fresh agent
  // reads as long-silent on its first check-in
  const base =
    logMtime === null
      ? recordMtime
      : Number.isFinite(recordMtime)
        ? Math.max(logMtime, recordMtime)
        : logMtime
  return Number.isFinite(base) ? now - base : null
}

function fileView(home: string, f: string, now: number): LoopRunView {
  const slug = f.slice(0, -'.json'.length)
  const path = join(home, f)
  let mtime = Number.NaN
  try {
    mtime = statSync(path).mtimeMs
  } catch {
    // unreadable — still reported as residue below
  }
  const rec = readRecord(path, slug)
  const pid = rec?.pid ?? null
  const live = pid !== null && pidAlive(pid, rec?.pidStart)
  return {
    beadId: rec?.beadId ?? slug,
    beadIds: rec?.beadIds,
    slug,
    pid,
    state: live ? 'running' : 'dead',
    startedAt: rec === null || rec.startedAt === '' ? undefined : rec.startedAt,
    worktree: rec === null || rec.worktree === '' ? undefined : rec.worktree,
    log: rec === null || rec.log === '' ? undefined : rec.log,
    silentMs: live ? silenceMs(rec, mtime, now) : null,
  }
}

/** Every run record in `<git-common>/bro/loop/` — live first, oldest
 *  silence first, then dead residue. Read-only by contract (watch and
 *  status embed it); the loop's own start reap is the only mutator. */
export function collectLoopRuns(dir: string, now: number = Date.now()): LoopRunView[] {
  const home = loopRunsDir(dir)
  if (home === null) {
    return []
  }
  let files: string[]
  try {
    files = readdirSync(home).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return files
    .map((f) => fileView(home, f, now))
    .sort((a, b) => {
      if (a.state !== b.state) {
        return a.state === 'running' ? -1 : 1
      }
      return (b.silentMs ?? 0) - (a.silentMs ?? 0)
    })
}

/** Reap records whose pid is gone — run at `bro loop` start so a
 *  crashed run's residue doesn't accumulate (a live pid is never
 *  touched: two loops may not run, but a foreign record's owner check
 *  keeps this safe anyway). */
export function reapLoopRuns(dir: string): void {
  const home = loopRunsDir(dir)
  if (home === null) {
    return
  }
  let files: string[]
  try {
    files = readdirSync(home)
  } catch {
    return
  }
  for (const f of files) {
    if (!f.endsWith('.json')) {
      continue
    }
    const path = join(home, f)
    const rec = readRecord(path, f.slice(0, -'.json'.length))
    // unparseable or dead-owned — both are residue, not a live record
    if (rec === null || !pidAlive(rec.pid, rec.pidStart)) {
      try {
        rmSync(path, { force: true })
      } catch {
        // a lost unlink is reported by the next reader as 'dead'
      }
    }
  }
}
