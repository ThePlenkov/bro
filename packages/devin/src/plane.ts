/** The devin session plane — every local devin CLI session
 *  (interactive, `-p`, `acp`) drops a `<name>.lock` under
 *  `$XDG_DATA_HOME/devin/cli/session_locks` holding its pid; live
 *  sessions dedupe by pid because a resumed session leaves a second
 *  lock for the same process. Cloud-side sessions
 *  (devin_session_create via MCP) never write a local lock — this is
 *  a host-local count, and that blind spot is deliberate: the plane
 *  reports what this host can verify.

 *  This is vendor knowledge living at the plugin layer — core's
 *  session-planes module owns the mutex/reservation/quota mechanics,
 *  this file owns ONLY how devin marks and counts its sessions. */
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  pidAlive,
  registerSessionPlane,
  sessionSlotsDir,
  SpawnError,
  type DiscoveredSession,
  type SessionPlane,
} from '@broject/core'
import { countDevinSessionStarts } from './starts.ts'

/** Devin's session-lock dir — `agents.devin.lockDir` overrides for odd
 *  installs/tests; `env` is the environment the derivation reads (a
 *  worker spawned under its own XDG_DATA_HOME/HOME resolves a
 *  different dir — its locks land THERE). */
export function devinLocksDir(
  bag?: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
): string {
  const override = bag?.['lockDir']
  if (typeof override === 'string' && override.trim() !== '') {
    return override
  }
  const xdg = env['XDG_DATA_HOME']
  const base =
    xdg !== undefined && xdg.trim() !== ''
      ? xdg
      : join(env['HOME'] !== undefined && env['HOME'] !== '' ? env['HOME'] : homedir(), '.local', 'share')
  return join(base, 'devin', 'cli', 'session_locks')
}

/** One lock file → its pid. A file that vanished mid-scan was never
 *  counted; anything else unreadable fails the whole count closed.
 *  Non-pid content returns nothing — the strict digit check keeps a
 *  corrupt `123oops`/`0x10` lock from aliasing an unrelated live pid. */
function lockPid(dir: string, name: string): number | undefined {
  let raw: string
  try {
    raw = readFileSync(join(dir, name), 'utf8').trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw new SpawnError(
      `cannot verify devin session count — ${dir}/${name}: ${(err as Error).message}`,
      'unavailable'
    )
  }
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined
}

/** Every dir a count must cover: the spawner's resolved lock dir plus
 *  the worker's own effective one — spec.env can hand the spawned
 *  session a different XDG_DATA_HOME/HOME, and its devin lock lands
 *  THERE, invisible to a scan of only the spawner's dir. */
function devinSessionDirs(
  bag: Record<string, unknown>,
  workerEnv?: Record<string, string>
): string[] {
  const dirs = [devinLocksDir(bag)]
  if (workerEnv !== undefined) {
    const eff = devinLocksDir(bag, { ...process.env, ...workerEnv })
    if (eff !== dirs[0]) {
      dirs.push(eff)
    }
  }
  return dirs
}

/** Is this pid still a devin session? The lock file carries a pid and
 *  nothing else, so a pid that was RECYCLED (the devin session died,
 *  the number now belongs to something else) reads as a live session —
 *  observed on this host: a `tailscaled` pid holding a devin lock.
 *
 *  The identity check reads the process's own command line: a live
 *  devin session's argv[0] is the devin CLI. A lock whose pid belongs
 *  to another program is STALE — the session it named is gone.
 *
 *  The lock dir is not devin's alone: another CLI (`pi`) writes
 *  devin-shaped session locks into the same directory, and those
 *  sessions draw on a different account — counting them would charge
 *  the devin cap for someone else's sessions.
 *
 *  An unreadable /proc entry cannot clear a lock (the count fails
 *  closed — a quota that cannot be established is not walked past), so
 *  it counts as live. */
function isDevinProcess(pid: number, procDir = '/proc'): boolean {
  let cmdline: string
  try {
    cmdline = readFileSync(join(procDir, String(pid), 'cmdline'), 'utf8')
  } catch (err) {
    // the pid is GONE when its /proc entry is gone — a stale lock,
    // proven stale
    if (
      (err as NodeJS.ErrnoException).code === 'ENOENT' &&
      existsSync(procDir) &&
      !existsSync(join(procDir, String(pid)))
    ) {
      return false
    }
    // no /proc at all (a host without it), an unreadable entry, or an
    // entry without a command line: the identity cannot be disproved —
    // count it
    return true
  }
  const argv0 = cmdline.split('\0')[0] ?? ''
  if (argv0 === '') {
    // a zombie: the session is gone, the number is only still there
    return false
  }
  return argv0.slice(argv0.lastIndexOf('/') + 1) === 'devin'
}

/** Is this lock a live devin session? A lock names a pid; the pid
 *  must be alive AND still be the devin cli (a recycled number is a
 *  stale lock). */
function lockIsLiveSession(pid: number | undefined, procDir: string): pid is number {
  if (pid === undefined) {
    return false
  }
  return pidAlive(pid) && isDevinProcess(pid, procDir)
}

/** Live devin session pids across the dirs — lock files whose pid is
 *  alive AND still a devin process, deduplicated (a resumed session
 *  leaves a second lock for the same process). A missing dir means no
 *  devin install → empty; any OTHER read failure throws
 *  SpawnError('unavailable') — an unverifiable count fails closed,
 *  never silently admits. */
function liveDevinLockPids(dirs: string[], procDir = '/proc'): Set<number> {
  const live = new Set<number>()
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw new SpawnError(
        `cannot verify devin session count — ${dir}: ${(err as Error).message}`,
        'unavailable'
      )
    }
    for (const name of names) {
      if (!name.endsWith('.lock')) {
        continue
      }
      const pid = lockPid(dir, name)
      if (lockIsLiveSession(pid, procDir)) {
        live.add(pid)
      }
    }
  }
  return live
}

/** A reservation file is `<key>-<8hex>.slot`; for bro spawns the key
 *  IS the worker's `BRO_AGENT_ID` pin. */
// the lane tag rides the name — the sweep must recognise a batch
// reservation too, or a landed batch worker stays in the count twice
const SLOT_KEY_RE = /^(.+)-[0-9a-f]{8}(?:\.batch)?\.slot$/

/** Retire slot claims whose session mark already landed — a live
 *  pid's environ carrying `BRO_AGENT_ID=<key>` proves that spawn's
 *  own lock now holds the count, so its still-fresh `.slot` would
 *  count it a second time (live + reservation) until the TTL. Runs
 *  inside the count so an admission tallying reservations AFTER the
 *  plane sees only still-in-flight claims. Every step is best-effort
 *  — the TTL still bounds anything missed. */
function sweepLandedSlots(resDir: string, live: Set<number>, procDir = '/proc'): void {
  let names: string[]
  try {
    names = readdirSync(resDir)
  } catch {
    return // no/unreadable dir — the tally reports its own verdict
  }
  const landed = new Set<string>()
  for (const pid of live) {
    try {
      const m = /(?:^|\0)BRO_AGENT_ID=([^\0]+)/.exec(
        readFileSync(join(procDir, String(pid), 'environ'), 'utf8')
      )
      if (m !== null) {
        landed.add(m[1]!)
      }
    } catch {
      // unreadable environ — this pid proves no landing
    }
  }
  if (landed.size === 0) {
    return
  }
  for (const name of names) {
    const key = SLOT_KEY_RE.exec(name)?.[1]
    if (key !== undefined && landed.has(key)) {
      try {
        rmSync(join(resDir, name), { force: true })
      } catch {
        // a racing reaper already got it
      }
    }
  }
}

/** Live devin sessions — lock files whose pid is alive, deduplicated.
 *  A missing dir means no devin install → zero sessions; any OTHER
 *  read failure throws SpawnError('unavailable') — an unverifiable
 *  count fails closed, never silently admits. `slotsDir` sweeps
 *  reservations whose spawn already landed so they aren't counted
 *  twice by an admission. */
export function countDevinSessions(
  dirs: string[],
  slotsDir?: string,
  procDir = '/proc'
): number {
  const live = liveDevinLockPids(dirs, procDir)
  if (slotsDir !== undefined) {
    sweepLandedSlots(slotsDir, live, procDir)
  }
  return live.size
}

/** fd/0 targets that mean an interactive session — every terminal
 *  device: pty slaves (`/dev/pts/*`), the controlling-terminal alias
 *  `/dev/tty`, the system console, and the virtual/serial consoles
 *  (`/dev/tty*`). Anything else — pipes, files, sockets, `/dev/null`
 *  — marks a spawned worker. */
const TTY_STDIN = /^\/dev\/(?:pts\/|tty|console)/

/** Worker classification for one locked pid — a spawned (never
 *  interactive) devin session. Two /proc probes, either suffices:
 *  the BRO_AGENT_ID env badge every bro backend pins into the worker's
 *  env (inherited by the devin child a wrapper spawns), and a
 *  non-terminal stdin (`fd/0` outside the tty devices — headless
 *  pipes, null, sockets; interactive devin reads a terminal).
 *
 *  A pid neither probe verifies is NOT a worker: unreadable state only
 *  undercounts the worker lane — while phantom workers would refuse
 *  real spawns, re-creating the starvation the lane exists to remove.
 *  `procDir` injectable for tests; absent /proc yields non-workers per
 *  pid, and the counter below refuses outright when the real
 *  classifier has no /proc at all. */
export function devinPidIsWorker(pid: number, procDir = '/proc'): boolean {
  const dir = join(procDir, String(pid))
  try {
    // NUL-anchored: environ entries are NUL-separated and an
    const environ = readFileSync(join(dir, 'environ'), 'utf8')
    // unanchored match would take `XBRO_AGENT_ID=` (proc-owner's
    // AGENT_ENV_RE convention)
    if (/(?:^|\0)BRO_AGENT_ID=/.test(environ)) {
      return true
    }
    if (/(?:^|\0)BRO_HOOKS=0(?:\0|$)/.test(environ)) {
      return false
    }
  } catch {
    // unreadable environ — the stdin probe still applies
  }
  try {
    return !TTY_STDIN.test(readlinkSync(join(dir, 'fd', '0')))
  } catch {
    return false
  }
}

/** Is this worker the FLEET's — a batch spawn (a drive fixer, a loop
 *  member) rather than the operator's own session? The fleet's marker
 *  rides in the spawn's env and the child's env is
 *  `{ ...process.env, ...spec.env }`, so the worker's own environment
 *  answers the question (spec bro-9h86l).
 *
 *  An UNREADABLE environ counts as the fleet's: the pid is a real live
 *  session it simply cannot be classified, and a quota that cannot be
 *  established must fail closed — the fleet yields a slot it may not
 *  have used, rather than a cap the fleet can walk past. A pid that is
 *  GONE (the process exited between the liveness check and this read)
 *  is not a live session at all, so it counts for nobody. */
export function devinPidIsBatch(pid: number, procDir = '/proc'): boolean {
  try {
    const environ = readFileSync(join(procDir, String(pid), 'environ'), 'utf8')
    // NUL-anchored, like the worker predicate — an unanchored match
    // would take XBRO_BATCH= (the AGENT_ENV_RE convention). The value
    // must be non-empty: an empty marker is not a marker, and the
    // spawn-side detection says so too.
    return /(?:^|\0)BRO_BATCH=[^\0]+/.test(environ)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // the process exited between the liveness check and this read —
      // it is gone, not unclassifiable, and a dead pid holds no slot
      return false
    }
    // The environ is unreadable — the pid cannot be classified. It is
    // a REAL live session (not a phantom), so it is counted as the
    // fleet's: the batch cap is the fleet's own share, and a quota
    // must fail closed. The cost is the fleet yields a slot it may not
    // have used; the alternative is a cap the fleet can pass.
    return true
  }
}

/** Live BATCH workers — the fleet's share of the worker pool. The
 *  same live set as countDevinWorkers, filtered by the supervisor
 *  marker in each worker's environment. */
export function countDevinBatchWorkers(
  dirs: string[],
  isBatch?: (pid: number) => boolean,
  procDir = '/proc',
  slotsDir?: string
): number {
  // the default predicate reads the SAME procDir the scan uses — a
  // caller with a scripted /proc tree must not be counted against the
  // real one
  const predicate = isBatch ?? ((pid: number) => devinPidIsBatch(pid, procDir))
  const live = liveDevinLockPids(dirs, procDir)
  if (isBatch === undefined && live.size > 0 && !existsSync(procDir)) {
    // a host without /proc cannot tell the fleet's workers from the
    // operator's — an armed maxBatchWorkers must refuse there like an
    // uncountable plane, never silently count zero and admit freely
    throw new SpawnError(
      `cannot verify devin batch worker count — ${procDir} absent; ` +
        'agents.devin.maxBatchWorkers is unenforceable on this host',
      'unavailable'
    )
  }
  if (slotsDir !== undefined) {
    // a landed spawn's own session mark retires its still-fresh slot —
    // without the sweep the batch lane counts a live worker AND its
    // reservation, and refuses capacity that is free
    sweepLandedSlots(slotsDir, live, procDir)
  }
  let batch = 0
  for (const pid of live) {
    if (predicate(pid)) {
      batch++
    }
  }
  return batch
}

/** Live worker sessions — the spawned subset of liveDevinLockPids.
 *  `isWorker` injectable for tests; the default is the /proc
 *  classifier, and a host with no procDir at all cannot tell ONE
 *  worker from an interactive session — an armed maxWorkers must
 *  refuse there like an uncountable plane, never silently unguard
 *  (zero live sessions stay verifiably zero workers on any host).
 *  `slotsDir` sweeps landed reservations like countDevinSessions. */
/** The worker predicate a scan runs — the default one reads the SAME
 *  procDir the scan uses, so a scripted /proc tree is not classified
 *  against the real one. */
function workerPredicate(
  isWorker: (pid: number) => boolean,
  procDir: string
): (pid: number) => boolean {
  if (isWorker === devinPidIsWorker) {
    return (pid: number) => devinPidIsWorker(pid, procDir)
  }
  return isWorker
}

/** A host with no /proc cannot tell ONE worker from an interactive
 *  session — an armed maxWorkers must refuse there, never silently
 *  unguard. Zero live sessions stay verifiably zero workers anywhere. */
function assertWorkerCountVerifiable(
  isWorker: (pid: number) => boolean,
  liveCount: number,
  procDir: string
): void {
  if (isWorker !== devinPidIsWorker || liveCount === 0 || existsSync(procDir)) {
    return
  }
  throw new SpawnError(
    `cannot verify devin worker count — ${procDir} absent; ` +
      'agents.devin.maxWorkers is unenforceable on this host',
    'unavailable'
  )
}

export function countDevinWorkers(
  dirs: string[],
  isWorker: (pid: number) => boolean = devinPidIsWorker,
  slotsDir?: string,
  procDir = '/proc'
): number {
  const live = liveDevinLockPids(dirs, procDir)
  const predicate = workerPredicate(isWorker, procDir)
  assertWorkerCountVerifiable(isWorker, live.size, procDir)
  if (slotsDir !== undefined) {
    sweepLandedSlots(slotsDir, live, procDir)
  }
  let workers = 0
  for (const pid of live) {
    if (predicate(pid)) {
      workers++
    }
  }
  return workers
}

/** The host-shared slot dir this kind's reservations live in — the
 *  same derivation admitSessionSlot applies (`reservationsDir` is the
 *  generic override riding the plane's own bag). The slots live
 *  under the spawner's env, never the worker's. */
function devinSlotsDir(bag: Record<string, unknown>): string {
  const override = bag['reservationsDir']
  return sessionSlotsDir('devin', typeof override === 'string' ? override : undefined)
}

/** The /proc root the pid probes read — `agents.devin.procDir`
 *  overrides for tests (a scripted /proc tree); production reads the
 *  real one. Same override convention as lockDir/logsDir. */
export function devinProcDir(bag?: Record<string, unknown>): string {
  const override = bag?.['procDir']
  return typeof override === 'string' && override.trim() !== '' ? override : '/proc'
}

/** The BRO_AGENT_ID env badge on a live pid — the worker's registry
 *  correlation id. Undefined when the environ is unreadable or carries
 *  no badge (an interactive session, a foreign spawn). */
export function devinPidAgentId(pid: number, procDir = '/proc'): string | undefined {
  try {
    const m = /(?:^|\0)BRO_AGENT_ID=([^\0]+)/.exec(
      readFileSync(join(procDir, String(pid), 'environ'), 'utf8')
    )
    return m === null ? undefined : m[1]
  } catch {
    return undefined
  }
}

/** The BRO_BEAD_ID pin on a live pid — the step a bro-spawned worker
 *  claims. Undefined when unreadable or unpinned (a foreign session). */
export function devinPidBead(pid: number, procDir = '/proc'): string | undefined {
  try {
    const m = /(?:^|\0)BRO_BEAD_ID=([^\0]+)/.exec(
      readFileSync(join(procDir, String(pid), 'environ'), 'utf8')
    )
    return m === null ? undefined : m[1]
  } catch {
    return undefined
  }
}

/** The session's working directory — /proc/<pid>/cwd. For a bro worker
 *  this IS the claimed step's worktree; for a foreign session the
 *  checkout it was launched in. Undefined when unreadable. */
export function devinPidCwd(pid: number, procDir = '/proc'): string | undefined {
  try {
    return readlinkSync(join(procDir, String(pid), 'cwd'))
  } catch {
    return undefined
  }
}

/** A sibling dir of session_locks under the same data base — `logs`,
 *  `transcripts`, whatever a plane needs next. The `<name>Dir`
 *  override wins; a custom lockDir broke the real-install sibling
 *  layout, so the fallback nests inside the override instead of
 *  escaping the operator's chosen root via `..`. */
function devinSiblingDir(
  bag: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  overrideKey: string,
  name: string
): string {
  const override = bag?.[overrideKey]
  if (typeof override === 'string' && override.trim() !== '') {
    return override
  }
  const locks = devinLocksDir(bag, env)
  const lockOverride = bag?.['lockDir']
  if (typeof lockOverride === 'string' && lockOverride.trim() !== '') {
    return join(locks, name)
  }
  return join(locks, '..', name)
}

/** Devin's per-process log dir — `devin_<ts>_<pid>.log`, the sibling
 *  of session_locks under the same data base. */
export function devinLogsDir(
  bag?: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
): string {
  return devinSiblingDir(bag, env, 'logsDir', 'logs')
}

/** Devin's transcript dir — `transcripts/<session-name>.json`, the
 *  readable sibling of session_locks (same derivation contract as
 *  devinLogsDir: `transcriptsDir` override wins; a custom lockDir
 *  nests the default inside the override so it never escapes the
 *  operator's chosen root). */
export function devinTranscriptsDir(
  bag?: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
): string {
  return devinSiblingDir(bag, env, 'transcriptsDir', 'transcripts')
}

/** A session's ATIF transcript — `transcripts/<lock-name>.json` when
 *  the file exists. The lock name IS the session name; a resumed
 *  session keeps both. */
export function devinSessionTranscript(name: string, transcriptsDir: string): string | undefined {
  const path = join(transcriptsDir, `${name}.json`)
  return existsSync(path) ? path : undefined
}

/** One ATIF step's display line, or undefined when the step carries
 *  nothing user-facing (system metadata blobs, empty messages). */
function atifStepLines(step: Record<string, unknown>): string[] {
  const ts = typeof step['timestamp'] === 'string' ? step['timestamp'] : ''
  const hhmmss = ts.length >= 19 ? ts.slice(11, 19) : '??:??:??'
  const out: string[] = []
  const message = typeof step['message'] === 'string' ? step['message'] : ''
  const source = typeof step['source'] === 'string' ? step['source'] : 'agent'
  if (source !== 'system' && message.trim() !== '') {
    out.push(`[${hhmmss}] ${source}: ${message.trim()}`)
  }
  const calls = Array.isArray(step['tool_calls']) ? step['tool_calls'] : []
  for (const c of calls) {
    const call = c as Record<string, unknown>
    const fn = typeof call['function_name'] === 'string' ? call['function_name'] : '?'
    const brief = toolCallBrief(call['arguments']).replace(/\s+/g, ' ')
    out.push(`[${hhmmss}] → ${fn}(${brief})`)
  }
  return out
}

/** A tool call's argument brief — `command` wins for exec-shaped args,
 *  otherwise the compact JSON form, capped at one glance. */
function toolCallBrief(args: unknown): string {
  let brief = ''
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const cmd = (args as Record<string, unknown>)['command']
    brief = typeof cmd === 'string' ? cmd : JSON.stringify(args)
  } else if (args !== undefined) {
    brief = JSON.stringify(args)
  }
  return brief.length > 160 ? brief.slice(0, 157) + '...' : brief
}

/** An ATIF transcript rendered to log-shaped lines. `fromStepId`
 *  resumes a follow watermark — only steps past it are emitted.
 *  Returns undefined on a mid-rewrite (torn JSON) or a doc without
 *  steps — the caller retries next tick, never dies on a flush in
 *  flight. */
export function renderDevinTranscript(
  json: string,
  fromStepId = 0
): { lines: string[]; watermark: number } | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return undefined
  }
  if (doc === null || typeof doc !== 'object' || !Array.isArray((doc as Record<string, unknown>)['steps'])) {
    return undefined
  }
  const steps = (doc as Record<string, unknown>)['steps'] as Record<string, unknown>[]
  const lines: string[] = []
  let watermark = fromStepId
  let systemSkipped = 0
  for (const step of steps) {
    // -1 marks a step with no numeric id: it renders on the first pass
    // (id-less steps exist and carry content), but a follow poll skips
    // it — it can't advance the watermark, so it would reprint forever
    const id = typeof step['step_id'] === 'number' ? step['step_id'] : -1
    if (id === -1 ? fromStepId > 0 : id <= fromStepId) {
      continue
    }
    if (step['source'] === 'system') {
      systemSkipped++
    } else {
      lines.push(...atifStepLines(step))
    }
    // consumed steps advance the watermark even when they emit no
    // lines — a system step must elide exactly once, not every poll
    if (id > watermark) {
      watermark = id
    }
  }
  if (systemSkipped > 0) {
    lines.push(`[transcript] (${systemSkipped} system steps elided)`)
  }
  return { lines, watermark }
}

/** The newest `devin_*_<pid>.log` — a live session's own output, the
 *  `bro agents log` reach for sessions the registry never spawned.
 *  Undefined when no file names the pid. */
export function devinPidLog(pid: number, logsDir: string): string | undefined {
  let newest: { path: string; mtime: number } | undefined
  try {
    for (const name of readdirSync(logsDir)) {
      if (!name.startsWith('devin_') || !name.endsWith(`_${pid}.log`)) {
        continue
      }
      const path = join(logsDir, name)
      const mtime = statSync(path).mtimeMs
      if (newest === undefined || mtime > newest.mtime) {
        newest = { path, mtime }
      }
    }
  } catch {
    return undefined
  }
  return newest?.path
}

/** Live devin sessions as rows — the same lock scan liveDevinLockPids
 *  runs, kept per-lock so each row carries the session's lock-name. A
 *  resumed session's second lock for one pid dedupes like the count
 *  does (first name wins); worker/agentId ride the /proc classifier —
 *  unreadable state means "not verifiably a worker", same undercount
 *  contract as devinPidIsWorker. `procDir` injectable for tests. */
export function listDevinSessions(dirs: string[], procDir = '/proc'): DiscoveredSession[] {
  const seen = new Set<number>()
  const out: DiscoveredSession[] = []
  for (const dir of dirs) {
    for (const name of lockNames(dir)) {
      const pid = lockPid(dir, name)
      if (pid === undefined || seen.has(pid)) {
        continue
      }
      // the same identity the count applies — a board that lists a
      // recycled pid's session contradicts the count beside it
      if (!lockIsLiveSession(pid, procDir)) {
        continue
      }
      seen.add(pid)
      out.push(sessionRow(pid, name, procDir))
    }
  }
  return out
}

/** The lock files of a dir — a missing dir means no sessions; any OTHER
 *  read failure is an unverifiable list (fails closed). */
function lockNames(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw new SpawnError(
      `cannot verify devin session list — ${dir}: ${(err as Error).message}`,
      'unavailable'
    )
  }
  return names.filter((name) => name.endsWith('.lock'))
}

/** One session's row — the lock's name, the pid's working directory and
 *  the /proc classifier's verdicts. */
function sessionRow(pid: number, lockName: string, procDir: string): DiscoveredSession {
  return {
    pid,
    name: lockName.slice(0, -'.lock'.length),
    cwd: devinPidCwd(pid, procDir),
    worker: devinPidIsWorker(pid, procDir),
    agentId: devinPidAgentId(pid, procDir),
  }
}

/** The builtin plane — registers on import. */
export const devinSessionPlane: SessionPlane = {
  kind: 'devin',
  detectsCli: (cliName) => cliName === 'devin',
  startsSessions(command) {
    return countDevinSessionStarts(command)
  },
  countLive(bag, workerEnv) {
    return countDevinSessions(
      devinSessionDirs(bag, workerEnv),
      devinSlotsDir(bag),
      devinProcDir(bag)
    )
  },
  countWorkers(bag, workerEnv) {
    return countDevinWorkers(
      devinSessionDirs(bag, workerEnv),
      devinPidIsWorker,
      devinSlotsDir(bag),
      devinProcDir(bag)
    )
  },
  countBatchWorkers(bag, workerEnv) {
    // the predicate reads the SAME procDir the scan uses — a scripted
    // /proc tree would be counted against the real one otherwise
    const procDir = devinProcDir(bag)
    return countDevinBatchWorkers(
      devinSessionDirs(bag, workerEnv),
      undefined,
      procDir,
      devinSlotsDir(bag)
    )
  },
  listLive(bag, workerEnv) {
    return listDevinSessions(devinSessionDirs(bag, workerEnv), devinProcDir(bag))
  },
}

registerSessionPlane(devinSessionPlane)
