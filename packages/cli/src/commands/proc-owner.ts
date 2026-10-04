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
import { pidAlive, procStat } from '@broject/core'

export interface ProcHit {
  pid: number
  cmd: string
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
