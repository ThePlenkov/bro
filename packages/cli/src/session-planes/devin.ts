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

/** Live devin session pids across the dirs — lock files whose pid is
 *  alive, deduplicated (a resumed session leaves a second lock for the
 *  same process). A missing dir means no devin install → empty; any
 *  OTHER read failure throws SpawnError('unavailable') — an
 *  unverifiable count fails closed, never silently admits. */
function liveDevinLockPids(dirs: string[]): Set<number> {
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
      if (pid !== undefined && pidAlive(pid)) {
        live.add(pid)
      }
    }
  }
  return live
}

/** A reservation file is `<key>-<8hex>.slot`; for bro spawns the key
 *  IS the worker's `BRO_AGENT_ID` pin. */
const SLOT_KEY_RE = /^(.+)-[0-9a-f]{8}\.slot$/

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
  const live = liveDevinLockPids(dirs)
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
    // unanchored match would take `XBRO_AGENT_ID=` (proc-owner's
    // AGENT_ENV_RE convention)
    if (/(?:^|\0)BRO_AGENT_ID=/.test(readFileSync(join(dir, 'environ'), 'utf8'))) {
      return true
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

/** Live worker sessions — the spawned subset of liveDevinLockPids.
 *  `isWorker` injectable for tests; the default is the /proc
 *  classifier, and a host with no procDir at all cannot tell ONE
 *  worker from an interactive session — an armed maxWorkers must
 *  refuse there like an uncountable plane, never silently unguard
 *  (zero live sessions stay verifiably zero workers on any host).
 *  `slotsDir` sweeps landed reservations like countDevinSessions. */
export function countDevinWorkers(
  dirs: string[],
  isWorker: (pid: number) => boolean = devinPidIsWorker,
  slotsDir?: string,
  procDir = '/proc'
): number {
  const live = liveDevinLockPids(dirs)
  if (isWorker === devinPidIsWorker && live.size > 0 && !existsSync(procDir)) {
    throw new SpawnError(
      `cannot verify devin worker count — ${procDir} absent; ` +
        'agents.devin.maxWorkers is unenforceable on this host',
      'unavailable'
    )
  }
  if (slotsDir !== undefined) {
    sweepLandedSlots(slotsDir, live, procDir)
  }
  let workers = 0
  for (const pid of live) {
    if (isWorker(pid)) {
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

/** Devin's per-process log dir — `devin_<ts>_<pid>.log`, the sibling
 *  of session_locks under the same data base. */
export function devinLogsDir(
  bag?: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
): string {
  const override = bag?.['logsDir']
  if (typeof override === 'string' && override.trim() !== '') {
    return override
  }
  const locks = devinLocksDir(bag, env)
  const lockOverride = bag?.['lockDir']
  if (typeof lockOverride === 'string' && lockOverride.trim() !== '') {
    // a custom lockDir broke the real-install sibling layout — a
    // `../logs` escape would land outside the operator's chosen root,
    // so the fallback nests inside the override instead
    return join(locks, 'logs')
  }
  return join(locks, '..', 'logs')
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
  const override = bag?.['transcriptsDir']
  if (typeof override === 'string' && override.trim() !== '') {
    return override
  }
  const locks = devinLocksDir(bag, env)
  const lockOverride = bag?.['lockDir']
  if (typeof lockOverride === 'string' && lockOverride.trim() !== '') {
    return join(locks, 'transcripts')
  }
  return join(locks, '..', 'transcripts')
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
    const args = call['arguments']
    let brief = ''
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
      const cmd = (args as Record<string, unknown>)['command']
      brief = typeof cmd === 'string' ? cmd : JSON.stringify(args)
    } else if (args !== undefined) {
      brief = JSON.stringify(args)
    }
    if (brief.length > 160) {
      brief = brief.slice(0, 157) + '...'
    }
    out.push(`[${hhmmss}] → ${fn}(${brief.replace(/\s+/g, ' ')})`)
  }
  return out
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
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw new SpawnError(
        `cannot verify devin session list — ${dir}: ${(err as Error).message}`,
        'unavailable'
      )
    }
    for (const name of names) {
      if (!name.endsWith('.lock')) {
        continue
      }
      const pid = lockPid(dir, name)
      if (pid === undefined || !pidAlive(pid) || seen.has(pid)) {
        continue
      }
      seen.add(pid)
      out.push({
        pid,
        name: name.slice(0, -'.lock'.length),
        worker: devinPidIsWorker(pid, procDir),
        agentId: devinPidAgentId(pid, procDir),
      })
    }
  }
  return out
}

/** The builtin plane — registers on import. */
export const devinSessionPlane: SessionPlane = {
  kind: 'devin',
  detectsCli: (cliName) => cliName === 'devin',
  countLive(bag, workerEnv) {
    return countDevinSessions(devinSessionDirs(bag, workerEnv), devinSlotsDir(bag))
  },
  countWorkers(bag, workerEnv) {
    return countDevinWorkers(
      devinSessionDirs(bag, workerEnv),
      devinPidIsWorker,
      devinSlotsDir(bag)
    )
  },
  listLive(bag, workerEnv) {
    return listDevinSessions(devinSessionDirs(bag, workerEnv), devinProcDir(bag))
  },
}

registerSessionPlane(devinSessionPlane)
