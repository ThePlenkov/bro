/** `rigNext` — the engine's one re-entry verb (specs bro-oy3k1.1
 *  §engine, bro-oy3k1.5). Recomputed from durable state on every call —
 *  beads claims, the agent registry, worktrees, the forge. Idempotent,
 *  stateless, never waits, never writes: any signal or timer re-enters
 *  the same probe and races resolve on the next call, not this one.
 *
 *  Lives in @broject/rig (bro-jamp7): the CLI's `bro rig next` is the
 *  thin adapter over this — argv/stdout/exit stay in commands/. */
import {
  bdActor,
  gitTry,
  mainWorktreeRoot,
  pidAlive,
  readAgentRegistry,
  reviewHost,
  taskStore,
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
import { readyBeads } from './ready.ts'

export interface RigNext {
  verdict: 'step' | 'gate' | 'wait' | 'done' | 'blocked'
  id?: string
  detail?: string
}

/** The WAKE: predicate is the last `WAKE:` line in the frame's notes —
 *  parkFrame's append contract. */
function wakePredicate(row: TaskRow): string | undefined {
  const wakes = (row.notes?.split('\n') ?? []).filter((l) => l.startsWith('WAKE: '))
  return wakes.at(-1)?.slice(6)
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

/** One registry entry by bead id — the Map read keeps the lookup off
 *  the dynamic-index sink while the on-disk shape stays a plain record. */
function registryEntry(dir: string, id: string): AgentRegistryEntry | undefined {
  return new Map(Object.entries(readAgentRegistry(dir))).get(id)
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

/** The gate probe: an open PR on the worktree's branch moves the next
 *  transition to the gate (threads/CI/human) — ahead of claim reads, a
 *  claimed item with a PR up is decided by the gate, not by work. A
 *  settled PR + still-open bead is the cleanup edge: finalization, not
 *  work. */
function gateVerdict(dir: string, id: string, wt: string | undefined): RigNext | undefined {
  if (wt === undefined) {
    return undefined
  }
  // a missing worktree or a detached/failed branch read means the PR
  // association is unknowable — skip the probe rather than guess a
  // branch name
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

/** The verdict legs ahead of the registry/forge reads: a closed row is
 *  done, a waiting-labelled row parks on its WAKE predicate. Undefined
 *  — the row walks on to the settled/work legs. */
function earlyVerdict(row: TaskRow, id: string): RigNext | undefined {
  if (row.status === 'closed') {
    return { verdict: 'done', id }
  }
  if (row.labels?.includes(WAITING_LABEL)) {
    return { verdict: 'wait', id, detail: wakePredicate(row) }
  }
  return undefined
}

/** The settled legs — anything that supersedes the work ladder: a live
 *  registry agent owns the step (wait), an open PR on the item's
 *  worktree branch moves the transition to the gate, a settled PR is
 *  the finalize step. `gate === false` skips the worktree/PR probe —
 *  callers that own the gate themselves (drive's fixer spawn,
 *  spec bro-oy3k1.6) ask for the cheap ladder only. */
function settledLegs(
  dir: string,
  id: string,
  entry: AgentRegistryEntry | undefined,
  gate: boolean | undefined
): RigNext | undefined {
  return (
    agentWait(entry, id) ??
    (gate === false ? undefined : gateVerdict(dir, id, itemWorktree(dir, id, entry)))
  )
}

/** The work legs — reached only when no settled leg fired: an
 *  in-progress row steps for its owner alone, an open row steps only
 *  when the bd-side ready read counts it actionable (dep-gated or
 *  deferred rows aren't work — the same filtered list the focus read),
 *  and a queue member reports its rank as the step's detail. */
function workVerdict(dir: string, id: string, row: TaskRow, store: TaskStore): RigNext {
  if (row.status === 'in_progress') {
    const actor = bdActor(dir)
    return row.assignee === actor
      ? { verdict: 'step', id, detail: 'own claim — resume' }
      : { verdict: 'blocked', id, detail: `claimed by ${row.assignee ?? '?'}` }
  }
  // open: dep-gated/deferred beads aren't actionable work — the same
  // bd-side filtered ready list the focus read
  if (!readyBeads(dir, { store }).some((r) => r.id === id)) {
    return { verdict: 'blocked', id, detail: 'dep-gated or deferred' }
  }
  const rank = queueItems(queueScope()).find((q) => q.id === id)?.rank
  return { verdict: 'step', id, detail: rank === undefined ? undefined : `queue rank ${rank}` }
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
  const id = item ?? rigFocus(dir, { store })
  if (id === undefined) {
    return { verdict: 'done' }
  }
  const row = store.get<TaskRow>(id)
  if (row === undefined) {
    return { verdict: 'blocked', id, detail: 'unknown id' }
  }
  const early = earlyVerdict(row, id)
  if (early !== undefined) {
    return early
  }
  const settled = settledLegs(dir, id, registryEntry(dir, id), opts?.gate)
  return settled ?? workVerdict(dir, id, row, store)
}
