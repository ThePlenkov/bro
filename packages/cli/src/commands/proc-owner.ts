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

/** Agent-shaped executable name — the fallback for sessions that never
 *  armed a marker. Checked against argv[0] (and argv[1] when argv[0] is
 *  a launcher like npx/node): matching inside arbitrary arguments would
 *  let `grep claude` occupy a worktree. An optional script extension
 *  covers `node devin.js`-style invocations. */
const AGENT_NAME_RE = /^(devin|claude|codex|gemini|aider|opencode|amp|omp)(\.\w+)?$/
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
