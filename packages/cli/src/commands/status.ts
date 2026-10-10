/**
 * `bro status` — the compact live board for the current repo. One read
 * returns everything a thin client (pi extension widget, TUI, webui)
 * needs per refresh tick, where N shell calls per tick used to be the
 * only way:
 *
 *   bro status            compact board — beads, fleet, drill, git
 *   bro status --json     the same board, machine-readable
 *   bro status --deep     + act exit gate for the current branch's PR
 *                         (network — the fast path stays local-only)
 *
 * All state is read, never mutated. Sources: the tasks facade
 * (in-progress + ready — the serving backend, not a hardcoded bd),
 * the agent registry (<git-common>/bro/agents.json — shared across
 * linked worktrees), the drill stack, git porcelain. Bead-less or
 * registry-less checkouts still answer — the absent sections are empty
 * arrays/null, never errors.
 */
import { basename } from 'node:path'
import { evaluateExitGate, fetchPrActState } from '@broject/act'
import {
  facade,
  gitTry,
  pidAlive,
  readAgentRegistry,
  reviewHost,
} from '@broject/core'
import type { AgentRegistryEntry, TaskRow, TaskStore } from '@broject/core'
import { currentFrame } from '@broject/drill'
import { loopSection } from '@broject/loop'
import { loadBroConfig } from '../plugins.ts'
import { readStamp, stampAgo, stampSession } from './buildstamp.ts'
import { collectLoopRuns, type LoopRunView } from './loop-state.ts'
import {
  heartbeatAge,
  readHeartbeat,
  type HeartbeatSummary,
} from './watch-heartbeat.ts'

interface BeadRow {
  id: string
  title: string
  priority?: number
  issue_type?: string
  assignee?: string
}

interface StatusAgent {
  id: string
  backend: string
  step?: string
  state: string
  cause?: string
  pid?: number
  worktree?: string
  provider?: string
  model?: string
}

interface BroStatus {
  dir: string
  branch: string
  /** Dirty-path count from `git status --porcelain` — untracked incl. */
  dirty: number
  beads: {
    inProgress: BeadRow[]
    /** First READY_CAP ready beads — the board shows the top, not all. */
    ready: BeadRow[]
    /** Total ready count — usually larger than ready.length (capped). */
    readyTotal: number
  }
  fleet: { maxConcurrent: number; agents: StatusAgent[] }
  /** In-flight `bro loop` workers — records under <git-common>/bro/loop/.
   *  stallMin is the advisory silence threshold, never a kill budget
   *  (bro-9lpn3). */
  loop: { stallMin: number; runs: LoopRunView[] }
  drill: { frame: { id: string; title: string; depth: number } | null }
  /** The durable heartbeat file's summary (bro-dxoa5) — last tick's
   *  age + open-attention count. null = never had a heartbeat (or the
   *  file is unreadable) — an ordinary state, not an error. */
  watch: HeartbeatSummary | null
  /** Last stamped write to this worktree's shared outputs (bro-fatja)
   *  — null until a build/patch stamps one. `mine` is null when the
   *  current session can't resolve (a bare `bro status` has no env
   *  pin and the marker scan wasn't unambiguous). */
  build: {
    session: string
    via: string
    ts: number
    /** stamp.head ≠ HEAD — the recorded write predates the checkout. */
    behind: boolean
    mine: boolean | null
  } | null
  /** --deep only: the act gate for the current branch's open PR. */
  act?: {
    pr: number
    url: string
    gate: string
    openThreads: number
    ciPending: number
    ciFailing: number
    reviewersPending: number
    sastPending: number
    blockers: string[]
  } | null
}

/** Cheap liveness for the light board — the connectors own the rich
 *  probe; status just wants "alive / exited / stopped". */
function agentState(e: AgentRegistryEntry): string {
  if (e.stopped === true) {
    return 'stopped'
  }
  if (typeof e.exitStatus === 'number') {
    return 'exited'
  }
  const pid = typeof e.pid === 'number' ? e.pid : undefined
  if (pid !== undefined) {
    const pidStart = typeof e.pidStart === 'string' ? e.pidStart : undefined
    return pidAlive(pid, pidStart) ? 'running' : 'exited'
  }
  return 'unknown'
}

/** Ready beads are a backlog queue — the widget needs the top few plus
 *  the count, never all 60+ rows with descriptions and dependencies.
 *  Exported for the work plane's status read, which caps identically. */
export const READY_CAP = 10

function readBeads(dir: string): BroStatus['beads'] {
  const empty = { inProgress: [], ready: [], readyTotal: 0 }
  let store: TaskStore
  try {
    store = facade('tasks', { dir }, { prefer: loadBroConfig(dir).connectors })
  } catch {
    return empty // no serving backend — an empty board, not an error
  }
  // backend rows carry description/deps/metadata a widget never
  // renders — pick the board fields so one call stays a few KB
  const pick = (r: TaskRow): BeadRow => {
    const row: BeadRow = { id: r.id, title: r.title ?? '' }
    if (typeof r.priority === 'number') {
      row.priority = r.priority
    }
    if (typeof r.issue_type === 'string') {
      row.issue_type = r.issue_type
    }
    if (typeof r.assignee === 'string') {
      row.assignee = r.assignee
    }
    return row
  }
  // each leg degrades on its own — a dead backend or a failed read is
  // an empty section, never a broken board
  const read = (fn: () => TaskRow[]): BeadRow[] => {
    try {
      return fn().map(pick)
    } catch {
      return []
    }
  }
  const readyRows = read(() => store.ready())
  return {
    inProgress: read(() => store.list({ status: 'in_progress' })),
    ready: readyRows.slice(0, READY_CAP),
    readyTotal: readyRows.length,
  }
}

function readFleet(dir: string): BroStatus['fleet'] {
  const cfg = loadBroConfig(dir)
  const max = cfg.fleet?.maxConcurrent
  const agents = Object.entries(readAgentRegistry(dir)).map(([id, e]) => {
    const a: StatusAgent = {
      id,
      backend: e.backend,
      state: agentState(e),
    }
    if (typeof e.step === 'string') {
      a.step = e.step
    }
    if (typeof e.cause === 'string') {
      a.cause = e.cause
    }
    if (typeof e.pid === 'number') {
      a.pid = e.pid
    }
    if (typeof e.worktree === 'string') {
      a.worktree = basename(e.worktree)
    }
    if (typeof e.provider === 'string') {
      a.provider = e.provider
    }
    if (typeof e.model === 'string') {
      a.model = e.model
    }
    return a
  })
  return {
    maxConcurrent: typeof max === 'number' ? max : 0,
    agents,
  }
}

/** Loop-agent run records — same contract as the board's other sections:
 *  a failed or empty read is an empty array, never an error. */
function readLoop(dir: string): BroStatus['loop'] {
  try {
    const cfg = loadBroConfig(dir) as Record<string, unknown>
    return { stallMin: loopSection(cfg.loop).stallMin, runs: collectLoopRuns(dir) }
  } catch {
    return { stallMin: 0, runs: [] }
  }
}

/** The worktree's build stamp — attribution for shared mutable
 *  outputs. One file read, no network, fail-open like every board
 *  section. */
function readBuild(dir: string): BroStatus['build'] {
  const stamp = readStamp(dir)
  if (stamp === null) {
    return null
  }
  const head = gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const me = stampSession(dir, process.env)
  return {
    session: stamp.session,
    via: stamp.via,
    ts: stamp.ts,
    behind: stamp.head !== '' && head.code === 0 && stamp.head !== head.out.trim(),
    mine: me === undefined ? null : me === stamp.session,
  }
}

/** The act gate for the current branch's PR — null when no open PR
 *  resolves or gh can't answer; the board must not die on a network
 *  tick. */
async function readAct(dir: string): Promise<BroStatus['act']> {
  try {
    const rev = reviewHost(undefined, loadBroConfig(dir).connectors)
    const repo = rev.resolveRepo([])
    const pr = rev.currentPr()
    if (pr?.state !== 'OPEN') {
      return null
    }
    const act = loadBroConfig(dir).act
    const state = await fetchPrActState(rev, { repo, pr: pr.pr }, {
      ignoreChecks: act.ignoreChecks,
      maxRounds: act.maxRounds,
      docsPaths: act.docsPaths,
      docsMaxRounds: act.docsMaxRounds,
    })
    const gate = evaluateExitGate(state)
    return {
      pr: state.pr,
      url: state.url,
      gate: gate.ok ? 'GREEN' : 'BLOCKED',
      openThreads: state.openThreads,
      ciPending: state.ciPending,
      ciFailing: state.ciFailing,
      reviewersPending: state.reviewersPending,
      sastPending: state.sastPending,
      blockers: gate.blockers,
    }
  } catch {
    return null
  }
}

export function collectStatus(dir: string): BroStatus {
  const branch =
    gitTry(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || 'HEAD'
  const dirtyOut = gitTry(['-C', dir, 'status', '--porcelain']).out
  const dirty = dirtyOut === '' ? 0 : dirtyOut.split('\n').filter((l) => l !== '').length
  // currentFrame() → bdJson → spawnSync('bd') throws ENOENT where bd
  // isn't installed — the board's contract is empty sections, never
  // errors, so a missing/failed drill read is a null frame
  let frame: ReturnType<typeof currentFrame>
  try {
    frame = currentFrame()
  } catch {
    frame = undefined
  }
  return {
    dir,
    branch,
    dirty,
    beads: readBeads(dir),
    fleet: readFleet(dir),
    loop: readLoop(dir),
    drill: {
      frame: frame === undefined ? null : { id: frame.id, title: frame.title, depth: frame.depth },
    },
    watch: readHeartbeat(dir),
    build: readBuild(dir),
  }
}

function agentLine(a: StatusAgent): string {
  const extra = [a.step, a.cause].filter((x): x is string => x !== undefined).join(' · ')
  const glyph = a.state === 'running' ? '▶' : '·'
  const suffix = extra === '' ? '' : `  ${extra}`
  return `  ${glyph} ${a.id}  ${a.backend}  ${a.state}${suffix}`
}

/** One loop run record — silence past loop.stallMin is flagged as an
 *  inspect hint for the orchestrator, never a verdict bro acts on. */
function loopLine(r: LoopRunView, stallMin: number): string {
  if (r.state === 'dead') {
    return `  · loop ${r.beadId}  pid ${r.pid ?? '?'} gone — crashed run's record`
  }
  const silentMin = r.silentMs === null ? null : Math.max(0, Math.floor(r.silentMs / 60_000))
  const stale =
    silentMin !== null && stallMin > 0 && silentMin >= stallMin ? ' — silent, inspect?' : ''
  return `  ▶ loop ${r.beadId}  pid ${r.pid ?? '?'}  silent ${silentMin ?? '?'}m${stale}`
}

function actLine(act: NonNullable<BroStatus['act']> | null): string {
  if (act === null) {
    return 'act: no open PR for this branch'
  }
  const blockers = act.blockers.length > 0 ? ` — ${act.blockers.join('; ')}` : ''
  return `act: [#${act.pr}](${act.url}) ${act.gate}${blockers}`
}

function render(s: BroStatus): string[] {
  const lines: string[] = []
  lines.push(`board: ${basename(s.dir)} · ${s.branch}${s.dirty > 0 ? ` · dirty ${s.dirty}` : ''}`)
  if (s.watch !== null) {
    const tail = s.watch.attention === 0 ? 'quiet' : `${s.watch.attention} attention`
    lines.push(`watch: heartbeat ${heartbeatAge(s.watch.ageMs)} ago — ${tail}`)
  }
  if (s.drill.frame) {
    lines.push(`drill: ${s.drill.frame.id} — ${s.drill.frame.title} (depth ${s.drill.frame.depth})`)
  }
  if (s.build !== null) {
    const flags = [
      s.build.behind ? 'behind HEAD' : '',
      s.build.mine === false ? 'another session wrote it' : '',
    ].filter((f) => f !== '')
    lines.push(
      `build: ${s.build.via} by ${s.build.session} ${stampAgo(s.build.ts, Date.now())}` +
        (flags.length > 0 ? ` — ${flags.join(', ')}` : '')
    )
  }
  const beads = s.beads.inProgress
  if (beads.length > 0) {
    lines.push(`beads: ${beads.length} in progress`)
    for (const b of beads) {
      lines.push(`  ◐ ${b.id}  ${b.title}`)
    }
  }
  lines.push(`ready: ${s.beads.readyTotal} bead(s)`)
  const cap = s.fleet.maxConcurrent > 0 ? `/${s.fleet.maxConcurrent}` : ''
  const live = s.fleet.agents.filter((a) => a.state === 'running')
  lines.push(`fleet: ${live.length}${cap} running`)
  for (const a of s.fleet.agents) {
    lines.push(agentLine(a))
  }
  for (const r of s.loop.runs) {
    lines.push(loopLine(r, s.loop.stallMin))
  }
  if (s.act !== undefined) {
    lines.push(actLine(s.act))
  }
  return lines
}

export async function runStatusCommand(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const deep = argv.includes('--deep')
  const dir = process.cwd()
  const s = collectStatus(dir)
  if (deep) {
    s.act = await readAct(dir)
  }
  if (json) {
    console.log(JSON.stringify(s, null, 2))
    return
  }
  for (const line of render(s)) {
    console.log(line)
  }
}
