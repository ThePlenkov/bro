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
 * All state is read, never mutated. Sources: bd (in-progress + ready),
 * the agent registry (<git-common>/bro/agents.json — shared across
 * linked worktrees), the drill stack, git porcelain. Bead-less or
 * registry-less checkouts still answer — the absent sections are empty
 * arrays/null, never errors.
 */
import { basename } from 'node:path'
import { evaluateExitGate, fetchPrActState } from '@broject/act'
import {
  bdTry,
  gitTry,
  pidAlive,
  readAgentRegistry,
  reviewHost,
} from '@broject/core'
import type { AgentRegistryEntry } from '@broject/core'
import { currentFrame } from '@broject/drill'
import { loadBroConfig } from '../plugins.ts'

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
  drill: { frame: { id: string; title: string; depth: number } | null }
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
    return pidAlive(pid, typeof e.pidStart === 'string' ? e.pidStart : undefined)
      ? 'running'
      : 'exited'
  }
  return 'unknown'
}

/** Ready beads are a backlog queue — the widget needs the top few plus
 *  the count, never all 60+ rows with descriptions and dependencies. */
const READY_CAP = 10

function readBeads(dir: string): BroStatus['beads'] {
  const empty = { inProgress: [], ready: [], readyTotal: 0 }
  const run = bdTry(['list', '--status', 'in_progress', '--json'], 15_000, dir)
  const ready = bdTry(['ready', '--json'], 15_000, dir)
  if (run.code !== 0 && ready.code !== 0) {
    return empty
  }
  // bd rows carry description/deps/metadata a widget never renders —
  // pick the board fields so one call stays a few KB, not a megabyte.
  const rows = (out: string): BeadRow[] => {
    try {
      const v = JSON.parse(out) as unknown
      if (!Array.isArray(v)) {
        return []
      }
      return v.map((r): BeadRow => {
        const src = r as Record<string, unknown>
        const row: BeadRow = { id: String(src.id ?? ''), title: String(src.title ?? '') }
        if (typeof src.priority === 'number') {
          row.priority = src.priority
        }
        if (typeof src.issue_type === 'string') {
          row.issue_type = src.issue_type
        }
        if (typeof src.assignee === 'string') {
          row.assignee = src.assignee
        }
        return row
      })
    } catch {
      return []
    }
  }
  const readyRows = ready.code === 0 ? rows(ready.out) : []
  return {
    inProgress: run.code === 0 ? rows(run.out) : [],
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

/** The act gate for the current branch's PR — null when no open PR
 *  resolves or gh can't answer; the board must not die on a network
 *  tick. */
async function readAct(dir: string): Promise<BroStatus['act']> {
  try {
    const rev = reviewHost(undefined, loadBroConfig(dir).connectors)
    const repo = rev.resolveRepo([])
    const pr = rev.currentPr()
    if (!pr || pr.state !== 'OPEN') {
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
    drill: {
      frame: frame === undefined ? null : { id: frame.id, title: frame.title, depth: frame.depth },
    },
  }
}

function render(s: BroStatus): string[] {
  const lines: string[] = []
  lines.push(`board: ${basename(s.dir)} · ${s.branch}${s.dirty > 0 ? ` · dirty ${s.dirty}` : ''}`)
  if (s.drill.frame) {
    lines.push(`drill: ${s.drill.frame.id} — ${s.drill.frame.title} (depth ${s.drill.frame.depth})`)
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
    const extra = [a.step, a.cause].filter((x): x is string => x !== undefined).join(' · ')
    lines.push(`  ${a.state === 'running' ? '▶' : '·'} ${a.id}  ${a.backend}  ${a.state}${extra === '' ? '' : `  ${extra}`}`)
  }
  if (s.act !== undefined) {
    lines.push(
      s.act === null
        ? 'act: no open PR for this branch'
        : `act: [#${s.act.pr}](${s.act.url}) ${s.act.gate}${s.act.blockers.length > 0 ? ` — ${s.act.blockers.join('; ')}` : ''}`
    )
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
