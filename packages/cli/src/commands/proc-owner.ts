/**
 * Session-owner liveness over /proc — the occupancy plane shared by
 * drive, hooks, and work markers.
 *
 * A `.work`/`work` marker's first line carries `<millis> [pid start]`.
 * Writers stamp the owning process (the agent ancestor for hook-armed
 * markers, the spawned child for connector markers) so readers can
 * prove liveness: a marker whose recorded owner is dead is residue the
 * moment the session dies, not after the freshness window expires
 * (bro-b87b), and a live owner keeps its marker past the window for a
 * >24h-idle session (bro-xlhm). Ownerless markers — old format, no
 * /proc, a human shell — fall back to the mtime window.
 */
import {
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  agentEntryBlocked,
  gitTry,
  markerLive,
  pidAlive,
  procStat,
  type AgentRegistryEntry,
  type AgentState,
} from '@broject/core'

export interface ProcHit {
  pid: number
  cmd: string
}

/** A live process inside a spawned unit. `inGroup` marks the
 *  kill(-pgid) cohort — same-session members in another pgrp are
 *  setpgid'd descendants the group signal never reached (bro-l8c4f.3). */
export interface UnitMember {
  pid: number
  inGroup: boolean
}

/** The whole-table picture behind one spawned unit: session members
 *  (sid === leader — only the leader's own descendants can carry it,
 *  setpgid never crosses sessions) plus `escapees` — procs still
 *  carrying the inherited BRO_AGENT_ID pin after setsid broke the
 *  session link. `unverified` marks entries that existed but could not
 *  be attributed: an unreadable live proc may BE ours, so it must never
 *  read as absent. 'unknown' return = the scan itself could not run
 *  (no /proc) — same fail-open rule pidAlive documents. */
export interface UnitScan {
  members: UnitMember[]
  escapees: number[]
  unverified: boolean
}

/** The post-comm fields of one /proc/<pid>/stat — the same split
 *  procStat uses: (state ppid pgrp session …). Undefined when the
 *  entry can't be read or parsed. */
function procStatFields(
  dir: string
): { state: string; pgrp: number; sid: number } | undefined {
  const stat = readProcText(dir, 'stat')
  const close = stat.lastIndexOf(')')
  if (close < 0) {
    return undefined
  }
  const rest = stat.slice(close + 2).split(' ')
  const pgrp = Number(rest[2])
  const sid = Number(rest[3])
  return Number.isInteger(pgrp) && Number.isInteger(sid)
    ? { state: rest[0] ?? '', pgrp, sid }
    : undefined
}

/** sid of a live proc — undefined when dead or unreadable. The
 *  signal-time identity re-check: a pid may recycle between the scan
 *  and the kill, so the membership proof is re-read immediately before
 *  the signal. */
export function procSessionId(pid: number, procDir = '/proc'): number | undefined {
  const f = procStatFields(join(procDir, String(pid)))
  return f !== undefined && f.state !== 'Z' ? f.sid : undefined
}

/** Does a live proc still carry `BRO_AGENT_ID=<agentId>` — the same
 *  re-verify rule as procSessionId, for escapees. */
export function procHasBadge(pid: number, agentId: string, procDir = '/proc'): boolean {
  let env: string
  try {
    env = readFileSync(join(procDir, String(pid), 'environ'), 'utf8')
  } catch {
    return false
  }
  return env.split('\0').includes(`BRO_AGENT_ID=${agentId}`)
}

/** One /proc pass answering both unit questions: who is still in the
 *  leader's session, and who outside it still carries the agent badge.
 *  The leader itself counts as a member while it lives. Our own pid is
 *  excluded — a `bro` run inside the worker inherits the badge and the
 *  session, and is not the unit's member to count or signal. */
export function procUnitScan(
  leader: number | undefined,
  agentId: string | undefined,
  procDir = '/proc'
): UnitScan | 'unknown' {
  let names: string[]
  try {
    names = readdirSync(procDir)
  } catch {
    return 'unknown'
  }
  const scan: UnitScan = { members: [], escapees: [], unverified: false }
  const pin = agentId === undefined || agentId === '' ? undefined : `BRO_AGENT_ID=${agentId}`
  for (const name of names) {
    if (!/^\d+$/.test(name)) {
      continue
    }
    const pid = Number(name)
    if (pid === process.pid) {
      continue
    }
    const dir = join(procDir, name)
    let member = false
    if (leader !== undefined) {
      const f = procStatFields(dir)
      if (f === undefined) {
        // a vanished entry is nobody; a present-but-unreadable one
        // cannot be attributed — it may be ours
        try {
          statSync(dir)
          scan.unverified = true
        } catch {
          // gone mid-scan — dead already
        }
      } else if (f.state !== 'Z' && f.sid === leader) {
        member = true
        scan.members.push({ pid, inGroup: f.pgrp === leader })
      }
    }
    if (pin !== undefined && !member) {
      let env: string
      try {
        env = readFileSync(join(dir, 'environ'), 'utf8')
      } catch (e) {
        // EACCES is a foreign-owned (or non-dumpable) proc — it cannot
        // be our worker's descendant; ENOENT/ESRCH vanished mid-scan.
        // Anything else cannot be attributed — flag it unverified.
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'ESRCH' && code !== 'ENOTDIR') {
          scan.unverified = true
        }
        continue
      }
      if (env.split('\0').includes(pin)) {
        scan.escapees.push(pid)
      }
    }
  }
  return scan
}

/** Whole-unit liveness for a detached spawn — the pinned leader, its
 *  session members, and badged escapees; 'unknown' when the process
 *  table cannot answer (bro-l8c4f.3). `pidStart` is the reuse pin from
 *  the registry; `agentId` is the BRO_AGENT_ID escapee badge. On a
 *  host without /proc the kill(-pgid, 0) group probe is the whole
 *  answer — a live group counts, escapees are undetectable (documented
 *  platform limit, never a silent "dead"). */
export function procUnitState(
  pid: number | undefined,
  pidStart: string | undefined,
  agentId: string | undefined,
  procDir = '/proc'
): 'dead' | 'alive' | 'unknown' {
  if (pid !== undefined && pidAlive(pid, pidStart)) {
    return 'alive'
  }
  let groupExists = false
  if (pid !== undefined) {
    try {
      process.kill(-pid, 0)
      groupExists = true
    } catch (e) {
      // ESRCH is a group that no longer exists; EPERM is a live group
      // we cannot signal — both are verdicts, not silence
      groupExists = (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  const procPresent = existsSyncProc()
  if (groupExists) {
    const scan = procUnitScan(pid, agentId, procDir)
    if (scan === 'unknown') {
      // no /proc: group existence is all the platform offers (a
      // zombie-held group resolves on the next poll); with /proc an
      // incomplete scan is genuinely 'unknown'
      return procPresent ? 'unknown' : 'alive'
    }
    if (scan.members.length > 0 || scan.escapees.length > 0) {
      return 'alive'
    }
    return scan.unverified ? 'unknown' : 'dead'
  }
  // the group is gone — only a setsid'd escapee can still carry the
  // unit, and only /proc can find it
  if (procPresent && agentId !== undefined && agentId !== '') {
    const scan = procUnitScan(undefined, agentId, procDir)
    if (scan === 'unknown') {
      return 'unknown'
    }
    if (scan.escapees.length > 0) {
      return 'alive'
    }
    return scan.unverified ? 'unknown' : 'dead'
  }
  return 'dead'
}

/** Agent-shaped executable name — the fallback for sessions that never
 *  armed a marker. Checked against argv[0] (and argv[1] when argv[0] is
 *  a launcher like npx/node): matching inside arbitrary arguments would
 *  let `grep claude` occupy a worktree. An optional script extension
 *  covers `node devin.js`-style invocations. */
const AGENT_NAME_RE = /^(devin|claude|codex|gemini|aider|opencode|amp)(\.\w+)?$/
const AGENT_LAUNCHERS = new Set(['node', 'npx', 'bun', 'bunx', 'tsx', 'uvx', 'deno'])

/** True when the process's own argv names an agent — the executable or
 *  the launcher's script argument, never a free-floating argument. */
function procIsAgentCmd(dir: string): boolean {
  const argv = readProcText(dir, 'cmdline').split('\0')
  if (AGENT_NAME_RE.test(basename(argv[0] ?? ''))) {
    return true
  }
  return (
    AGENT_LAUNCHERS.has(basename(argv[0] ?? '')) &&
    AGENT_NAME_RE.test(basename(argv[1] ?? ''))
  )
}

/** Env badges agent runtimes pin on themselves — every descendant
 *  inherits them, so a detached tool shell counts even after a setsid
 *  broke the ancestry chain. NUL-anchored: /proc environ entries are
 *  NUL-separated and an unanchored match would take `XAI_AGENT=`. */
const AGENT_ENV_RE = /(?:^|\0)(?:BRO_AGENT_ID|AI_AGENT)=/

function readProcText(dir: string, file: string): string {
  try {
    return readFileSync(join(dir, file), 'utf8')
  } catch {
    return ''
  }
}

/** ppid of a /proc entry — the `PPid:` line of status; 0 when unreadable. */
function procPpid(dir: string): number {
  const m = /^PPid:[ \t]*(\d+)/m.exec(readProcText(dir, 'status'))
  return m === null ? 0 : Number(m[1])
}

/** Pid of the nearest agent-shaped process at-or-above `dir` — agent
 *  CLIs keep their own cwd at the launch dir while their tool shells
 *  (bash, node, git) are what cd into the worktree; bro-pywx's raced
 *  spawn was exactly that shape — the devin process sat in the main
 *  checkout, invisible to an own-cmdline-only scan. Bounded so a wedged
 *  or cyclic chain can never loop the pass. Null when no ancestor
 *  matches. */
function procAgentPid(dir: string, depth = 0): number | null {
  if (depth > 16) {
    return null
  }
  if (procIsAgentProc(dir)) {
    return Number(basename(dir))
  }
  const ppid = procPpid(dir)
  return ppid > 1 ? procAgentPid(join(dirname(dir), String(ppid)), depth + 1) : null
}

/** Agent shape by cmdline or env badge — the shared predicate behind
 *  procAgentPid (occupancy: nearest match suffices) and procAgentRoot
 *  (ownership: topmost match wins). */
function procIsAgentProc(dir: string): boolean {
  return procIsAgentCmd(dir) || AGENT_ENV_RE.test(readProcText(dir, 'environ'))
}

/** The topmost agent-shaped ancestor — the owner tag's pid. The env
 *  badge is inherited by every descendant, so the NEAREST agent
 *  ancestor is usually a transient tool shell that exits mid-session
 *  while the session still works; a marker owned by it drops early and
 *  frees the worktree under a live session. The chain root outlives
 *  its tool shells, so the walk keeps climbing past matches. */
function procAgentRoot(dir: string): number | null {
  let top: number | null = null
  let cur: string | null = dir
  for (let depth = 0; depth <= 16 && cur !== null; depth++) {
    if (procIsAgentProc(cur)) {
      top = Number(basename(cur))
    }
    const ppid = procPpid(cur)
    cur = ppid > 1 ? join(dirname(cur), String(ppid)) : null
  }
  return top
}

function procIsAgent(dir: string): boolean {
  return procAgentPid(dir) !== null
}

/** Monitor shape — a process that OBSERVES the repo but never works
 *  in the tree: bro's own watcher/status/serve verbs and act waits
 *  (bro-dkw3e). The badge is inherited from the spawning session, so
 *  the ancestry scan alone can't tell a monitor from a worker — this
 *  test reads the process's OWN argv. Shells stay workers: a bare
 *  bash inside the tree is indistinguishable from a raced worker's
 *  tool shell (bro-pywx), and false-positive beats false-negative. */
const MONITOR_VERBS = new Set(['watch', 'wait', 'status', 'serve', 'pulse', 'notify', 'daemon'])

function procIsMonitor(dir: string): boolean {
  const argv = readProcText(dir, 'cmdline').split('\0').filter(Boolean)
  const exe = basename(argv[0] ?? '')
  const positionals = argv.slice(1).filter((a) => !a.startsWith('-'))
  // monitor verbs only count when the process is actually bro — exe
  // `bro`, a `bro` first positional under setsid/nohup/npx, or the
  // shipped `…/dist/index.js` entry. `node worker.js wait` carries a
  // monitor-ish arg but isn't bro — it stays a worker.
  const first = positionals[0] ?? ''
  const broShaped =
    exe === 'bro' || first === 'bro' || /[/\\]dist[/\\]index\.js$/.test(first)
  if (!broShaped) {
    return false
  }
  // `node <dist>/index.js serve` — the script path is the entry, the
  // verb follows it; `bro watch` needs no drop
  const cmdTokens =
    exe !== 'bro' && /\.(?:js|ts|mjs|cjs)$/.test(first) ? positionals.slice(1) : positionals
  return cmdTokens.some((t) => MONITOR_VERBS.has(t))
}

/** Live processes ROOTED in `worktree` — cwd inside, or an argv token
 *  that is a path inside the tree. The argv leg catches
 *  `node <wt>/dist/index.js serve`: the code a long-lived service is
 *  executing IS the tree even when its cwd sits elsewhere; removing
 *  the worktree strands a zombie running deleted files (bro-1usa8).
 *  Wider than agentProcessesIn by design — removal guards need every
 *  occupant, not only agent-shaped ones. A missing /proc reads as
 *  "no data" (same contract as agentProcessesIn). `procDir` injectable. */
export function processesRootedIn(worktree: string, procDir = '/proc'): ProcHit[] {
  const hits: ProcHit[] = []
  let names: string[]
  try {
    names = readdirSync(procDir)
  } catch {
    return hits
  }
  const root = resolve(worktree)
  const inside = (p: string): boolean => p === root || p.startsWith(root + sep)
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) {
      continue
    }
    const dir = join(procDir, name)
    const cmdline = readProcText(dir, 'cmdline')
    let cwd: string
    try {
      cwd = readlinkSync(join(dir, 'cwd'))
    } catch {
      continue // gone between readdir and readlink
    }
    // argv tokens may be relative (node ../wt/dist/index.js serve) —
    // resolve them against the process cwd, not the ambient one.
    let rooted =
      inside(cwd) || cmdline.split('\0').some((tok) => tok !== '' && inside(resolve(cwd, tok)))
    if (rooted) {
      hits.push({ pid: Number(name), cmd: cmdline.replaceAll('\0', ' ').trim() })
    }
  }
  return hits
}

/** Live agent-shaped processes with cwd inside `worktree` — Linux-only
 *  layer; a missing /proc is "no data", not "occupied" (the facade and
 *  marker planes still apply). `procDir` is injectable for tests. */
export function agentProcessesIn(worktree: string, procDir = '/proc'): ProcHit[] {
  const hits: ProcHit[] = []
  let names: string[]
  try {
    names = readdirSync(procDir)
  } catch {
    return hits
  }
  const root = resolve(worktree)
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) {
      continue
    }
    const dir = join(procDir, name)
    let cwd: string
    try {
      cwd = readlinkSync(join(dir, 'cwd'))
    } catch {
      continue
    }
    if (cwd !== root && !cwd.startsWith(root + sep)) {
      continue
    }
    // a monitor (bro watch/serve, act wait, a parked shell) inherits
    // the agent badge but never works the tree — exclude it before
    // the agent-shape verdict (bro-dkw3e)
    if (procIsMonitor(dir)) {
      continue
    }
    if (procIsAgent(dir)) {
      const cmd = readProcText(dir, 'cmdline').replaceAll('\0', ' ').trim()
      hits.push({ pid: Number(name), cmd })
    }
  }
  return hits
}

let cachedOwner: { pid: number; start: string } | null | undefined

/** This process's owning agent — the topmost agent-shaped ancestor.
 *  A `bro` invocation runs as a tool-call child (bro → shell → agent),
 *  so the recorded pid must be the session root's, not our own (ours
 *  dies when the CLI exits) and not the nearest badged ancestor's
 *  (a tool shell that exits mid-session). Null when no ancestor is
 *  agent-shaped (human
 *  shell, CI, no /proc, or an ancestor whose start won't read) — the
 *  caller's marker then stays ownerless and readers keep the mtime
 *  fallback. A start-less owner is strictly worse than none: it keeps
 *  a marker live past the window under a reused pid while still
 *  suppressing the freshness check. Cached per process: hooks arm
 *  markers on every tool call and the owner never changes. */
export function agentOwner(): { pid: number; start: string } | null {
  if (cachedOwner === undefined) {
    const pid = existsSyncProc() ? procAgentRoot(`/proc/${process.ppid}`) : null
    const start = pid === null ? '' : (procStat(pid)?.start ?? '')
    cachedOwner = pid === null || start === '' ? null : { pid, start }
  }
  return cachedOwner
}

function existsSyncProc(): boolean {
  try {
    statSync('/proc')
    return true
  } catch {
    return false
  }
}

/** Line-1 suffix writers append to a session/work marker:
 *  ` <pid> <start>` of the owning agent, '' when none is found. */
export function ownerTag(): string {
  const o = agentOwner()
  return o === null ? '' : ` ${o.pid} ${o.start}`
}

// markerOwner/markerLive live in @broject/core — the marker-liveness
// read is shared with connectors (learn's previous-trace exclusion
// needs the same verdict) and can't import from the cli layer.
export { markerLive, markerOwner } from '@broject/core'

// --- marker-dir occupancy plane ---------------------------------------------------
//
// The pieces below judge "is a session/agent still alive behind this
// claim?" — shared by drive's occupancy pass, the loop litter sweep's
// dead-claim release, and watch/status check-ins. They live here
// because drive.ts and work.ts import each other transitively and
// proc-owner is the leaf both can reach.

/** The freshness horizon for `.work` markers — same as hooks.ts's
 *  LIVE_SESSION_MS: a marker younger than this names a live session. */
export const LIVE_MARKER_MS = 24 * 60 * 60 * 1000

/** `<git-common-dir>/bro/hooks` — the session marker dir shared across
 *  every linked worktree. Null when git can't name the common dir. */
export function hooksDirOf(root: string): string | null {
  const r = gitTry(['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'hooks')
}

/** A `.work`/`.task` marker's detail may be a bead id, a slug, a
 *  worktree path or basename. Match conservatively — an over-match
 *  costs a skipped pass; an under-match costs a raced owner. */
export function detailMatches(
  detail: string,
  ctx: { branch: string; slug: string; worktree?: string }
): boolean {
  if (detail === ctx.branch || detail === ctx.slug) {
    return true
  }
  if (ctx.worktree === undefined) {
    return false
  }
  const base = basename(ctx.worktree)
  return detail === base || base.endsWith(`--${detail}`) || detail.endsWith(`/${base}`)
}

/** A live session marker's detail line with the marker's activity
 *  stamp — mtimeMs is the file's own mtime, which the arm rewrites on
 *  every arm-worthy command, so it reads as "last proven activity" for
 *  the merge-path TTL (bro-ihnlv). Undefined only when the stat that
 *  just proved the marker live raced it away. */
export interface WorkEntry {
  detail: string
  mtimeMs?: number
  /** The session that wrote the marker — the marker's file name minus
   *  its aspect suffix. The detail lines do not name their writer, and
   *  a caller that must address a session needs to know whose marker
   *  this is. */
  session?: string
}

/** Every detail line of every live session marker WITH its stamp —
 *  liveWorkEntries is the mtime-carrying twin of liveWorkDetails. */
export function liveWorkEntries(
  dir: string,
  suffixes: readonly string[] = ['.work'],
  now: number = Date.now()
): WorkEntry[] {
  const entries: WorkEntry[] = []
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return entries
  }
  for (const f of files) {
    if (!suffixes.some((s) => f.endsWith(s))) {
      continue
    }
    entries.push(...markerEntries(dir, f, now))
  }
  return entries
}

/** One marker file's detail lines — empty when the marker is not live or
 *  unreadable. The session is the file's name minus its aspect suffix:
 *  the detail lines do not name their writer. */
function markerEntries(dir: string, file: string, now: number): WorkEntry[] {
  try {
    const path = join(dir, file)
    const mtimeMs = statSync(path).mtimeMs
    const lines = readFileSync(path, 'utf8').split('\n')
    if (!markerLive(lines[0], mtimeMs, LIVE_MARKER_MS, now)) {
      return []
    }
    const dot = file.lastIndexOf('.')
    const session = dot > 0 ? file.slice(0, dot) : undefined
    return lines
      .slice(1)
      .map((line) => line.trim())
      .filter((d) => d !== '')
      .map((detail) => ({ detail, mtimeMs, session }))
  } catch {
    // unreadable marker — skip
    return []
  }
}

/** Every detail line of every live session marker — a session claiming
 *  two beads keeps both, so occupancy reads them all (a first-line peek
 *  would miss the second). Liveness is owner-pid first (bro-b87b: a
 *  dead session's marker is residue even when fresh), mtime-window
 *  fallback for ownerless markers. `suffixes` widens the scan past
 *  `.work` — the litter sweep also reads `.task` (the `bd --claim`
 *  arm). */
export function liveWorkDetails(
  dir: string,
  suffixes: readonly string[] = ['.work'],
  now: number = Date.now()
): string[] {
  return liveWorkEntries(dir, suffixes, now).map((e) => e.detail)
}

/** An .exit file not yet harvested into the registry is death proof too
 *  — basename-only ids: '../' must never escape the agents home. */
function exitFileProves(home: string | null, e: AgentRegistryEntry): boolean {
  if (home === null || typeof e.agentId !== 'string' || basename(e.agentId) !== e.agentId) {
    return false
  }
  try {
    const v = readFileSync(join(home, `${e.agentId}.exit`), 'utf8').trim()
    return v !== '' && Number.isInteger(Number(v))
  } catch {
    // no exit file — not proof
    return false
  }
}

/** The unit leg of the death ladder: 'running' when members or
 *  badged escapees live, 'spawned' when the probe cannot answer —
 *  unverifiable is the conservative occupied read — undefined when
 *  the unit is verified dead and the recorded-cause ladder applies. */
function unitOccupiedState(
  e: { agentId?: unknown },
  pid: number | undefined,
  start: string | undefined
): 'running' | 'spawned' | undefined {
  const unit = procUnitState(
    pid,
    start,
    typeof e.agentId === 'string' ? e.agentId : undefined
  )
  if (unit === 'alive') {
    return 'running'
  }
  return unit === 'unknown' ? 'spawned' : undefined
}

/** Agent liveness derived from the registry entry alone — no backend
 *  list() probes. A live pid is running; a recorded or on-disk death is
 *  terminal; anything unproven counts as live ('spawned') — occupied is
 *  always the safe verdict, and a false-occupied only costs a skipped
 *  pass. */
export function registryEntryState(
  home: string | null,
  e: AgentRegistryEntry
): AgentState {
  const pid = typeof e.pid === 'number' ? e.pid : undefined
  // '' pidStart is unverified identity, not reuse proof — pidAlive('')
  // can never match a real starttime and would read a live agent dead
  const start = typeof e.pidStart === 'string' && e.pidStart !== '' ? e.pidStart : undefined
  if (pid !== undefined && pidAlive(pid, start)) {
    return 'running'
  }
  // the unit outlives the wrapper: session members and badged escapees
  // keep the claim occupied — only a verified-dead unit falls through
  // to the death ladder (bro-l8c4f.3)
  const occupied = unitOccupiedState(e, pid, start)
  if (occupied !== undefined) {
    return occupied
  }
  return recordedDeathState(home, e, pid)
}

/** The recorded-death ladder for a unit already verified gone —
 *  marker, recorded cause, exit file, then the unproven tail. */
function recordedDeathState(
  home: string | null,
  e: AgentRegistryEntry,
  pid: number | undefined
): AgentState {
  if (e.stopped === true) {
    return 'stopped'
  }
  if (e.exitStatus !== undefined) {
    // recorded cause decides — a budget-walled entry reads 'blocked'
    // here the same as in the connector ladder (bro-7xgk.2)
    return agentEntryBlocked(e) ? 'blocked' : 'exited'
  }
  if (exitFileProves(home, e)) {
    return 'exited'
  }
  // a dead pid is proven — 'lost' keeps the fixer respawn-able; a
  // pid-less entry (remote backend) is unproven → conservative live
  return pid !== undefined ? 'lost' : 'spawned'
}

/** Claim-liveness verdict on a registry entry — the litter sweep's
 *  reading: running/spawned/blocked all mean the claim has a live
 *  owner (a blocked agent's claim is real — its resetAt will lift and
 *  it continues the same work); only exited/stopped/lost release. */
export function registryEntryHoldsClaim(home: string | null, e: AgentRegistryEntry): boolean {
  const s = registryEntryState(home, e)
  return s === 'running' || s === 'spawned' || s === 'blocked'
}
