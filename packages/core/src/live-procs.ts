/**
 * Live child-process registry — the hook's exit hygiene. Async spawns
 * (bdAsync/ghAsync and friends) keep node's event loop alive until they
 * close: a probe that raced past its timeout leaves its child running,
 * so the hook process outlives the answer it already sent. Tracking
 * every spawn lets the hooks entrypoint unref the stragglers — command
 * paths never call this, so ordinary `await`ed spawns still pin the
 * process exactly like before.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import type { Socket } from 'node:net'

const live = new Set<ChildProcess>()

/** Register a spawned child for later unref — deregisters itself on
 *  close, so settled spawns cost nothing. */
export function trackChild(proc: ChildProcess): void {
  live.add(proc)
  proc.on('close', () => {
    live.delete(proc)
  })
}

export interface SpawnResult {
  code: number | null
  out: string
  err: string
  /** Set when 'error' (spawn failure) beat 'close' — the raw Error. */
  error?: Error
}

/** Spawn `cmd` with piped stdout/stderr collected — the shared skeleton
 *  behind the async CLI twins (bdAsync, ghTryAsync, …). Timeouts and
 *  exit-code policy stay with the caller; `done` resolves exactly once,
 *  on 'close' or 'error' (a spawn failure still surfaces via `error`
 *  with its message merged into `err`). */
export function spawnCollect(
  cmd: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
  /** `detached` puts the child at the head of its own process group so a
   *  caller can `process.kill(-proc.pid)` the whole supervised tree
   *  (bd's `timeout` supervisor + bd) instead of just the direct child. */
  opts?: { detached?: boolean }
): { proc: ChildProcess; done: Promise<SpawnResult> } {
  const proc = spawn(cmd, args, { // NOSONAR — PATH lookup is the contract (same as gh/git)
    cwd,
    detached: opts?.detached,
    env: env === undefined ? undefined : { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  trackChild(proc)
  let out = ''
  let err = ''
  proc.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
  proc.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
  const done = new Promise<SpawnResult>((resolve) => {
    proc.on('error', (error) =>
      resolve({ code: null, out, err: (err + '\n' + error.message).trim(), error })
    )
    proc.on('close', (code) => resolve({ code, out, err: err.trim() }))
  })
  return { proc, done }
}

/** Unref every still-running child and its stdio pipes — the pipes are
 *  handles too and would keep the loop alive on their own. Called by the
 *  hooks entrypoint after dispatch: any child still open belongs to a
 *  probe that already timed out, and its late output is discarded. */
export function unrefPendingChildren(): void {
  for (const proc of live) {
    proc.unref()
    // piped stdio are Sockets under the Readable type — handles that
    // keep the loop alive on their own
    ;(proc.stdout as Socket | null)?.unref()
    ;(proc.stderr as Socket | null)?.unref()
  }
}

// --- orphan `bd` sweep ---------------------------------------------------------

/** One /proc row as the classifier needs it — the reader fills this,
 *  the classifier never touches the filesystem (unit-testable). */
export interface ProcRow {
  pid: number
  comm: string
  ppid: number
  /** Parent's comm — init/systemd means reparented = orphaned. */
  parentComm: string | null
  /** readlink(/proc/pid/cwd) — null when unreadable (raced exit). */
  cwd: string | null
  /** Process start, ms epoch — parsed from stat starttime jiffies. */
  startMs: number
}

/** Parents an orphaned process lands on: pid 1, the WSL /init
 *  subreaper, or a systemd instance — never a live supervisor. */
const ORPHAN_PARENT_COMMS = new Set(['init', 'systemd'])

/** A legit bd call lasts seconds; a minute-old orphan holds the
 *  embedded noms LOCK past every caller's timeout — debris. */
const ORPHAN_BD_MIN_AGE_MS = 60_000

/** Decide which rows are wedging candidates: `comm`, reparented onto an
 *  init/systemd parent, cwd inside `repoRoot`, older than the age
 *  floor. Pure — the /proc reader feeds it. */
export function pickOrphanProcs(
  rows: ProcRow[],
  comm: string,
  repoRoot: string,
  now = Date.now()
): number[] {
  const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`
  return rows
    .filter(
      (r) =>
        r.comm === comm &&
        r.cwd !== null &&
        (r.cwd === repoRoot || r.cwd.startsWith(root)) &&
        (r.ppid === 1 || (r.parentComm !== null && ORPHAN_PARENT_COMMS.has(r.parentComm))) &&
        now - r.startMs >= ORPHAN_BD_MIN_AGE_MS
    )
    .map((r) => r.pid)
}

/** Read the rows pickOrphanProcs needs out of /proc — linux-only;
 *  anything else returns []. Races are the norm: a pid vanishing
 *  mid-scan just drops out. */
export function readProcRows(procDir = '/proc'): ProcRow[] {
  if (process.platform !== 'linux') return []
  let uptimeSec = 0
  try {
    uptimeSec = Number(readFileSync(`${procDir}/uptime`, 'utf8').split(' ')[0])
  } catch {
    return []
  }
  const bootMs = Date.now() - uptimeSec * 1000
  const rows: ProcRow[] = []
  for (const ent of readdirSync(procDir)) {
    if (!/^\d+$/.test(ent)) continue
    try {
      const stat = readFileSync(`${procDir}/${ent}/stat`, 'utf8')
      // comm sits in parens and may itself hold parens — parse after ')'
      const close = stat.lastIndexOf(')')
      const comm = stat.slice(stat.indexOf('(') + 1, close)
      const f = stat.slice(close + 2).split(' ')
      const ppid = Number(f[1])
      // fields after comm are 1-indexed from state: starttime is
      // field 22 → index 19; jiffies run at 100 ticks/s on linux
      const startMs = bootMs + (Number(f[19]) / 100) * 1000
      let parentComm: string | null = null
      if (ppid > 0) {
        try {
          parentComm = readFileSync(`${procDir}/${ppid}/comm`, 'utf8').trim()
        } catch { /* parent exited mid-scan — orphan race, next tick decides */ }
      }
      let cwd: string | null = null
      try {
        cwd = readlinkSync(`${procDir}/${ent}/cwd`)
      } catch { /* kernel threads and raced exits have no cwd */ }
      rows.push({ pid: Number(ent), comm, ppid, parentComm, cwd, startMs })
    } catch {
      continue
    }
  }
  return rows
}

export interface OrphanSweepReport {
  scanned: number
  /** pids the signal was DELIVERED to — delivery, not exit: a bd
   *  parked in an uninterruptible flock wait may outlive the SIGTERM
   *  and needs the supervisor's -k backstop or a later sweep to die. */
  signaled: { pid: number; cwd: string }[]
  /** pids that matched but the injected signal never reached. */
  failed: number[]
}

/** SIGTERM `comm` processes reparented to init whose cwd sits under
 *  `repoRoot` — the debris a dead supervisor leaves behind. A bd
 *  orphan holds the embedded noms LOCK forever (its caller's timeout
 *  died with the caller) and wedges the whole store; the watch tick
 *  sweeps them the same way it sweeps dead session markers. */
export function sweepOrphanProcs(
  comm: string,
  repoRoot: string,
  opts: {
    procDir?: string
    kill?: (pid: number) => void
    now?: number
    rows?: ProcRow[]
  } = {}
): OrphanSweepReport {
  const rows = opts.rows ?? readProcRows(opts.procDir)
  const pids = pickOrphanProcs(rows, comm, repoRoot, opts.now)
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM'))
  const report: OrphanSweepReport = { scanned: rows.length, signaled: [], failed: [] }
  for (const pid of pids) {
    try {
      kill(pid)
      report.signaled.push({ pid, cwd: byPid.get(pid)?.cwd ?? '' })
    } catch {
      report.failed.push(pid)
    }
  }
  return report
}
