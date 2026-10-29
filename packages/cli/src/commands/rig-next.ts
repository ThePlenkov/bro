/** `bro rig next` — the engine's one re-entry verb (specs
 *  bro-oy3k1.1 §engine, bro-oy3k1.5). Recomputed from durable state
 *  on every call — beads claims, the agent registry, worktrees, the
 *  forge. Idempotent, stateless, never waits, never writes: any
 *  signal or timer re-enters the same probe and races resolve on the
 *  next call, not this one. */
import { existsSync } from 'node:fs'
import {
  bdActor,
  gitTry,
  pidAlive,
  readAgentRegistry,
  reviewHost,
  taskStore,
  loadConfig,
  type AgentRegistryEntry,
  type TaskRow,
  type TaskStore,
} from '@broject/core'
import {
  currentFrame,
  queueItems,
  queueScope,
  WAITING_LABEL,
} from '@broject/drill'
import { worktreePathFor, mainWorktree } from './work.ts'
import { readyBeads, type ReadyBead } from './next.ts'

export interface RigNext {
  verdict: 'step' | 'gate' | 'wait' | 'done' | 'blocked'
  id?: string
  detail?: string
}

/** The WAKE: predicate is the last `WAKE:` line in the frame's notes —
 *  parkFrame's append contract. */
function wakePredicate(row: TaskRow): string | undefined {
  const lines = row.notes?.split('\n') ?? []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i]!
    if (l.startsWith('WAKE: ')) {
      return l.slice(6)
    }
  }
  return undefined
}

/** No-arg focus: the current frame's queue top (intake order), else
 *  the drill leaf, else the first ready row — epic rows are containers
 *  and gt:slot coordination primitives are never work items (the
 *  same bd-side exclusion next/loop ride). */
export function rigFocus(dir: string, opts?: { store?: TaskStore }): string | undefined {
  const top = queueItems(queueScope())[0]
  if (top !== undefined) {
    return top.id
  }
  const leaf = currentFrame()
  if (leaf) {
    return leaf.id
  }
  const ready = (opts?.store ? opts.store.ready<ReadyBead>({ excludeLabels: ['gt:slot'] }) : readyBeads(dir))
  return ready.find((r) => r.issue_type !== 'epic')?.id
}

/** A live registry agent owns the step — a signal re-enters. Checked
 *  ahead of the PR plane: a fixer mid-flight keeps the item at wait
 *  even while its PR is open or settled. */
function agentWait(entry: AgentRegistryEntry | undefined, id: string): RigNext | undefined {
  if (entry === undefined) {
    return undefined
  }
  const pid = typeof entry.pid === 'number' ? entry.pid : undefined
  // liveness first: a 'stopped' marker on a pid that is still alive
  // means SIGTERM hasn't landed — the agent IS still running
  if (
    pid !== undefined &&
    pidAlive(pid, typeof entry.pidStart === 'string' ? entry.pidStart : undefined)
  ) {
    return { verdict: 'wait', id, detail: `agent ${entry.agentId} in flight` }
  }
  // a recorded death trumps every liveness handle
  if (entry.stopped === true || entry.exitStatus !== undefined) {
    return undefined
  }
  // no pid handle — a remote/detached backend (devin, copilot): absent
  // a recorded death the durable picture reads in-flight, and reporting
  // step here would invite duplicate work. Reaping stays status/
  // respawn's job — this probe never calls the remote API
  if (pid === undefined) {
    return { verdict: 'wait', id, detail: `agent ${entry.agentId} in flight (remote)` }
  }
  return undefined
}

/** The item's worktree: the registry pin first, else the conventional
 *  `<main>--<id>` sibling path. Undefined when the repo/worktree plane
 *  can't answer. */
function itemWorktree(id: string, entry: AgentRegistryEntry | undefined): string | undefined {
  if (typeof entry?.worktree === 'string') {
    return entry.worktree
  }
  try {
    return worktreePathFor(mainWorktree().path, id)
  } catch {
    // not a git repo — no worktree plane to probe
    return undefined
  }
}

/** The gate probe: an open PR on the worktree's branch moves the next
 *  transition to the gate (threads/CI/human) — ahead of claim reads, a
 *  claimed item with a PR up is decided by the gate, not by work. A
 *  settled PR + still-open bead is the cleanup edge: finalization, not
 *  work. */
function gateVerdict(dir: string, id: string, wt: string | undefined): RigNext | undefined {
  if (typeof wt !== 'string' || !existsSync(wt)) {
    return undefined
  }
  // a detached/failed branch read means the PR association is
  // unknowable — skip the probe rather than guess a branch name
  const branch = gitTry(['-C', wt, 'branch', '--show-current']).out.trim()
  if (branch === '') {
    return undefined
  }
  try {
    const rev = reviewHost(
      dir,
      (loadConfig(dir) as { connectors?: Record<string, string> }).connectors
    )
    const open = rev.prsForBranch(branch)
    if (open.length > 0) {
      return { verdict: 'gate', id, detail: `pr=#${open[0]}` }
    }
    if (rev.prsForBranch(branch, 'all').length > 0) {
      return { verdict: 'step', id, detail: 'pr settled — close/ledger' }
    }
  } catch {
    // a configured host that doesn't answer leaves the gate unknowable —
    // 'step' could double-work a PR that's already up; wait is the
    // honest verdict and the next re-entry reads a reachable host
    return { verdict: 'wait', id, detail: 'review host unreachable' }
  }
  return undefined
}

/** The verdict for one item — the ladder from spec .5: done → wait →
 *  gate → live-worker wait → foreign-claim blocked → dep-gated
 *  blocked → step. `opts.gate === false` skips the worktree/PR probe —
 *  callers that own the gate themselves (drive's fixer spawn,
 *  spec bro-oy3k1.6) ask for the cheap ladder only. `opts.store` pins
 *  the tasks backend — a facade-resolved store (loop/drive contexts)
 *  must answer the same verdicts a beads one does. */
export function rigNext(
  dir: string,
  item?: string,
  opts?: { gate?: boolean; store?: TaskStore }
): RigNext {
  const store = opts?.store ?? taskStore(dir)
  const id = item ?? rigFocus(dir, opts)
  if (id === undefined) {
    return { verdict: 'done' }
  }
  const row = store.get<TaskRow>(id)
  if (row === undefined) {
    return { verdict: 'blocked', id, detail: 'unknown id' }
  }
  if (row.status === 'closed') {
    return { verdict: 'done', id }
  }
  if (row.labels?.includes(WAITING_LABEL)) {
    return { verdict: 'wait', id, detail: wakePredicate(row) }
  }
  const entry = readAgentRegistry(dir)[id]
  const settled =
    agentWait(entry, id) ??
    (opts?.gate === false ? undefined : gateVerdict(dir, id, itemWorktree(id, entry)))
  if (settled !== undefined) {
    return settled
  }
  if (row.status === 'in_progress') {
    const actor = bdActor(dir)
    if (row.assignee === actor) {
      return { verdict: 'step', id, detail: 'own claim — resume' }
    }
    return { verdict: 'blocked', id, detail: `claimed by ${row.assignee ?? '?'}` }
  }
  // open: dep-gated/deferred beads aren't actionable work — the same
  // bd-side filtered ready list the focus read
  const ready = (opts?.store ? opts.store.ready<ReadyBead>({ excludeLabels: ['gt:slot'] }) : readyBeads(dir))
  if (!ready.some((r) => r.id === id)) {
    return { verdict: 'blocked', id, detail: 'dep-gated or deferred' }
  }
  const rank = queueItems(queueScope()).find((q) => q.id === id)?.rank
  return { verdict: 'step', id, detail: rank === undefined ? undefined : `queue rank ${rank}` }
}

/** One line of human output — `rig next: step bro-abc — own claim`. */
function render(n: RigNext): string {
  const id = n.id === undefined ? '' : ` ${n.id}`
  const detail = n.detail === undefined ? '' : ` — ${n.detail}`
  return `rig next: ${n.verdict}${id}${detail}`
}

/** The `rig next` sub — a pure read over durable state, no repo-sync
 *  resolution (rig-pulse's `--repo` contract doesn't apply). Exits 1
 *  only on `blocked`. */
export function runRigNext(cwd: string, item: string | undefined, json: boolean): never {
  const n = rigNext(cwd, item)
  console.log(json ? JSON.stringify(n) : render(n))
  return process.exit(n.verdict === 'blocked' ? 1 : 0)
}
