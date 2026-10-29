/** `rigNext` — the engine's one re-entry verb (specs bro-oy3k1.1
 *  §engine, bro-oy3k1.5). Recomputed from durable state on every call —
 *  beads claims, the agent registry, worktrees, the forge. Idempotent,
 *  stateless, never waits, never writes: any signal or timer re-enters
 *  the same probe and races resolve on the next call, not this one.
 *
 *  Lives in @broject/rig (bro-jamp7): the CLI's `bro rig next` is the
 *  thin adapter over this — argv/stdout/exit stay in commands/. */
import { existsSync } from 'node:fs'
import {
  connectors,
  gitTry,
  mainWorktreeRoot,
  pidAlive,
  readAgentRegistry,
  reviewHost,
  loadConfig,
  worktreePathFor,
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
import { readyBeads, storeFor } from './ready.ts'

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
 *  same bd-side exclusion next/loop ride). Queue and frame reads anchor
 *  at `dir`/`opts.store` — the ambient default would pick work for the
 *  wrong checkout. */
export function rigFocus(dir: string, opts?: { store?: TaskStore }): string | undefined {
  const top = queueItems(queueScope(undefined, dir, opts), dir, opts)[0]
  if (top !== undefined) {
    return top.id
  }
  const leaf = currentFrame(dir, opts)
  if (leaf) {
    return leaf.id
  }
  return readyBeads(dir, opts).find((r) => r.issue_type !== 'epic')?.id
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
  // no recorded death and no pid handle — a remote/detached backend
  // (devin, copilot): the durable picture reads in-flight, and reporting
  // step here would invite duplicate work. Reaping stays status/
  // respawn's job — this probe never calls the remote API
  if (entry.stopped !== true && entry.exitStatus === undefined && pid === undefined) {
    return { verdict: 'wait', id, detail: `agent ${entry.agentId} in flight (remote)` }
  }
  // a recorded death — or a dead pid's stale marker — trumps every
  // liveness handle; the item falls through to the forge/work legs
  return undefined
}

/** The item's worktree: the registry pin first, else the conventional
 *  `<main>--<id>` sibling path. Undefined when the repo/worktree plane
 *  can't answer. */
function itemWorktree(dir: string, id: string, entry: AgentRegistryEntry | undefined): string | undefined {
  if (typeof entry?.worktree === 'string') {
    return entry.worktree
  }
  const main = mainWorktreeRoot(dir)
  return main === null ? undefined : worktreePathFor(main, id)
}

/** Can a reviews connector resolve for this checkout — the probe-side
 *  twin of pickConnector's eligibility rule: a configured pin always
 *  counts (its failures are real outages), unnamed resolution needs at
 *  least one non-opt-in provider. When nothing can resolve there is no
 *  forge to gate on at all — parking the item on 'host unreachable'
 *  would be a lie about a plane that doesn't exist. */
function reviewsResolvable(prefer: Record<string, string>): boolean {
  if (prefer.reviews !== undefined) {
    return true
  }
  return connectors().some(
    (c) =>
      typeof c.reviews === 'function' &&
      c.optIn !== true &&
      !(c.optInFacades?.includes('reviews') ?? false)
  )
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
  const rawConnectors = (loadConfig(dir) as any).connectors
  const prefer: Record<string, string> = {}
  if (rawConnectors && typeof rawConnectors === 'object' && !Array.isArray(rawConnectors)) {
    for (const [k, v] of Object.entries(rawConnectors)) {
      if (typeof v === 'string' && v.trim() !== '') {
        prefer[k] = v.trim()
      }
    }
  }
  if (!reviewsResolvable(prefer)) {
    return undefined
  }
  try {
    const rev = reviewHost(dir, prefer)
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

/** The settled legs — anything that supersedes the work ladder: a live
 *  registry agent owns the step, an open PR moves the transition to the
 *  gate, a settled PR is the finalize step. `gate === false` skips the
 *  worktree/PR probe — callers that own the gate themselves (drive's
 *  fixer spawn, spec bro-oy3k1.6) ask for the cheap ladder only. */
function settledVerdict(dir: string, id: string, gate: boolean | undefined): RigNext | undefined {
  const entry = readAgentRegistry(dir)[id]
  return (
    agentWait(entry, id) ??
    (gate === false ? undefined : gateVerdict(dir, id, itemWorktree(dir, id, entry)))
  )
}

/** The work leg: own-claim resume, foreign-claim blocked, dep-gated
 *  blocked, else step (+ queue rank when the item sits on a queue). */
function workVerdict(dir: string, store: TaskStore, row: TaskRow, id: string): RigNext {
  if (row.status === 'in_progress') {
    // the store's own claim identity decides ownership — a backend
    // without an actor concept keeps the claim marker's word
    // (fail-open per TaskStore.actor): only an unclaimed row resumes
    const actor = store.actor?.()
    if (actor === undefined ? (row.assignee ?? '') === '' : row.assignee === actor) {
      return { verdict: 'step', id, detail: 'own claim — resume' }
    }
    return { verdict: 'blocked', id, detail: `claimed by ${row.assignee ?? '?'}` }
  }
  // open: dep-gated/deferred beads aren't actionable work — the same
  // bd-side filtered ready list the focus read
  if (!readyBeads(dir, { store }).some((r) => r.id === id)) {
    return { verdict: 'blocked', id, detail: 'dep-gated or deferred' }
  }
  const rank = queueItems(queueScope(undefined, dir, { store }), dir, { store }).find(
    (q) => q.id === id
  )?.rank
  return { verdict: 'step', id, detail: rank === undefined ? undefined : `queue rank ${rank}` }
}

/** The verdict for one item — the ladder from spec .5: done → wait →
 *  gate → live-worker wait → foreign-claim blocked → dep-gated
 *  blocked → step. `opts.gate === false` skips the worktree/PR probe.
 *  `opts.store` pins the tasks backend — a facade-resolved store
 *  (loop/drive contexts) must answer the same verdicts a beads one
 *  does; the unpinned default resolves the checkout's CONFIGURED tasks
 *  connector, not beads by fiat. */
export function rigNext(
  dir: string,
  item?: string,
  opts?: { gate?: boolean; store?: TaskStore }
): RigNext {
  const store = opts?.store ?? storeFor(dir)
  const id = item ?? rigFocus(dir, { store })
  if (id === undefined) {
    return { verdict: 'done' }
  }
  const row = store.get<TaskRow>(id)
  if (row === undefined) {
    return { verdict: 'blocked', id, detail: 'unknown id' }
  }
  // status legs first — a closed or parked row never reaches the
  // registry/forge probes
  if (row.status === 'closed') {
    return { verdict: 'done', id }
  }
  if (row.labels?.includes(WAITING_LABEL)) {
    return { verdict: 'wait', id, detail: wakePredicate(row) }
  }
  return settledVerdict(dir, id, opts?.gate) ?? workVerdict(dir, store, row, id)
}
