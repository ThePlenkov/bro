/** `rigNext` — the engine's one re-entry verb (specs bro-oy3k1.1
 *  §engine, bro-oy3k1.5). Recomputed from durable state on every call —
 *  beads claims, the agent registry, worktrees, the forge. Idempotent,
 *  stateless, never waits, never writes: any signal or timer re-enters
 *  the same probe and races resolve on the next call, not this one.
 *
 *  Lives in @broject/rig (bro-jamp7): the CLI's `bro rig next` is the
 *  thin adapter over this — argv/stdout/exit stay in commands/. */
import {
  facadeName,
  gitTry,
  mainWorktreeRoot,
  pidAlive,
  readAgentRegistry,
  reviewHost,
  loadConfig,
  worktreePathFor,
  type AgentRegistryEntry,
  type ReviewFacade,
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

/** The planes one verdict reads — every queue, frame, and ready probe
 *  inside a call answers from the same checkout and the same tasks
 *  store. `store` is resolved once per re-entry (a caller's pinned
 *  store, else the dir's configured connector) — reads that each
 *  resolved their own store could disagree on what is actionable. */
interface NextScope {
  dir: string
  store: TaskStore
}

/** The scope plus the row under verdict — the ladder legs below take
 *  this one context rather than threading dir/id/store separately. */
interface VerdictCtx extends NextScope {
  id: string
  /** `gate === false` skips the worktree/PR probe — callers that own
   *  the gate themselves (drive's fixer spawn, spec bro-oy3k1.6) ask
   *  for the cheap ladder only. */
  gate?: boolean
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
 *  same bd-side exclusion next/loop ride). Queue and frame reads ride
 *  the same store as the ready fallback — `dir` alone would answer the
 *  ambient session's queue, not the probed checkout's. */
export function rigFocus(dir: string, opts?: { store?: TaskStore }): string | undefined {
  const scope: NextScope = { dir, store: opts?.store ?? storeFor(dir) }
  const top = queueItems(queueScope(scope), scope)[0]
  if (top !== undefined) {
    return top.id
  }
  const leaf = currentFrame(scope)
  if (leaf) {
    return leaf.id
  }
  return readyBeads(dir, { store: scope.store }).find((r) => r.issue_type !== 'epic')?.id
}

/** A live pid is liveness proof even over a 'stopped' marker — SIGTERM
 *  hasn't landed until the process is gone. */
function pidInFlight(entry: AgentRegistryEntry): boolean {
  return (
    typeof entry.pid === 'number' &&
    pidAlive(entry.pid, typeof entry.pidStart === 'string' ? entry.pidStart : undefined)
  )
}

/** A live registry agent owns the step — a signal re-enters. Checked
 *  ahead of the PR plane: a fixer mid-flight keeps the item at wait
 *  even while its PR is open or settled. */
function agentWait(entry: AgentRegistryEntry | undefined, ctx: VerdictCtx): RigNext | undefined {
  if (entry === undefined) {
    return undefined
  }
  if (pidInFlight(entry)) {
    return { verdict: 'wait', id: ctx.id, detail: `agent ${entry.agentId} in flight` }
  }
  // a recorded death trumps every liveness handle
  if (entry.stopped === true || entry.exitStatus !== undefined) {
    return undefined
  }
  // no pid handle — a remote/detached backend (devin, copilot): absent
  // a recorded death the durable picture reads in-flight, and reporting
  // step here would invite duplicate work. Reaping stays status/
  // respawn's job — this probe never calls the remote API
  if (typeof entry.pid !== 'number') {
    return { verdict: 'wait', id: ctx.id, detail: `agent ${entry.agentId} in flight (remote)` }
  }
  return undefined
}

/** One registry entry by bead id — the Map read keeps the lookup off
 *  the dynamic-index sink while the on-disk shape stays a plain record. */
function registryEntry(ctx: VerdictCtx): AgentRegistryEntry | undefined {
  return new Map(Object.entries(readAgentRegistry(ctx.dir))).get(ctx.id)
}

/** The item's worktree: the registry pin first, else the conventional
 *  `<main>--<id>` sibling path. Undefined when the repo/worktree plane
 *  can't answer. */
function itemWorktree(ctx: VerdictCtx, entry: AgentRegistryEntry | undefined): string | undefined {
  if (typeof entry?.worktree === 'string') {
    return entry.worktree
  }
  const main = mainWorktreeRoot(ctx.dir)
  return main === null ? undefined : worktreePathFor(main, ctx.id)
}

/** The reviews facade the dir's connector plane can produce — `null`
 *  when nothing resolves to one: an unnamed resolution failure means
 *  no gate exists at all, and the item belongs on the status/ready
 *  ladder, not parked on a gate that isn't configured. A *named* pin
 *  that fails throws out to the caller's 'wait' — a configured gate
 *  may hide an open PR, so its failure is never a skipped probe. */
function reviewFacade(ctx: VerdictCtx): ReviewFacade | null {
  const prefer = loadConfig(ctx.dir).connectors
  if (prefer.reviews !== undefined) {
    return reviewHost(ctx.dir, prefer)
  }
  try {
    facadeName('reviews', { dir: ctx.dir }, { prefer })
  } catch {
    return null
  }
  // resolution says a provider exists — its factory can still throw,
  // and that throw is 'unreachable', not 'absent'
  return reviewHost(ctx.dir, prefer)
}

/** The branch the item's worktree is on — '' when the worktree is
 *  missing or the branch read fails (detached, dead checkout): the PR
 *  association is unknowable, so the probe skips rather than guesses
 *  a branch name. */
function branchOf(wt: string): string {
  return gitTry(['-C', wt, 'branch', '--show-current']).out.trim()
}

/** The forge read itself — an open PR moves the next transition to
 *  the gate, a settled one is the cleanup edge. */
function prsVerdict(rev: ReviewFacade, ctx: VerdictCtx, branch: string): RigNext | undefined {
  const open = rev.prsForBranch(branch)
  if (open.length > 0) {
    return { verdict: 'gate', id: ctx.id, detail: `pr=#${open[0]}` }
  }
  if (rev.prsForBranch(branch, 'all').length > 0) {
    return { verdict: 'step', id: ctx.id, detail: 'pr settled — close/ledger' }
  }
  return undefined
}

/** The gate probe: an open PR on the worktree's branch moves the next
 *  transition to the gate (threads/CI/human) — ahead of claim reads, a
 *  claimed item with a PR up is decided by the gate, not by work. A
 *  settled PR + still-open bead is the cleanup edge: finalization, not
 *  work. */
function gateVerdict(ctx: VerdictCtx, wt: string | undefined): RigNext | undefined {
  if (wt === undefined) {
    return undefined
  }
  const branch = branchOf(wt)
  if (branch === '') {
    return undefined
  }
  try {
    const rev = reviewFacade(ctx)
    if (rev === null) {
      return undefined
    }
    return prsVerdict(rev, ctx, branch)
  } catch {
    // a configured host that doesn't answer leaves the gate unknowable —
    // 'step' could double-work a PR that's already up; wait is the
    // honest verdict and the next re-entry reads a reachable host
    return { verdict: 'wait', id: ctx.id, detail: 'review host unreachable' }
  }
}

/** The verdict legs ahead of the registry/forge reads: a closed row is
 *  done, a waiting-labelled row parks on its WAKE predicate. Undefined
 *  — the row walks on to the settled/work legs. */
function earlyVerdict(row: TaskRow, ctx: VerdictCtx): RigNext | undefined {
  if (row.status === 'closed') {
    return { verdict: 'done', id: ctx.id }
  }
  if (row.labels?.includes(WAITING_LABEL)) {
    return { verdict: 'wait', id: ctx.id, detail: wakePredicate(row) }
  }
  return undefined
}

/** The settled legs — anything that supersedes the work ladder: a live
 *  registry agent owns the step (wait), an open PR on the item's
 *  worktree branch moves the transition to the gate, a settled PR is
 *  the finalize step. */
function settledLegs(
  ctx: VerdictCtx,
  entry: AgentRegistryEntry | undefined
): RigNext | undefined {
  return (
    agentWait(entry, ctx) ??
    (ctx.gate === false ? undefined : gateVerdict(ctx, itemWorktree(ctx, entry)))
  )
}

/** The work legs — reached only when no settled leg fired: an
 *  in-progress row steps for its owner alone, an open row steps only
 *  when the bd-side ready read counts it actionable (dep-gated or
 *  deferred rows aren't work — the same filtered list the focus read),
 *  and a queue member reports its rank as the step's detail. */
function workVerdict(ctx: VerdictCtx, row: TaskRow): RigNext {
  if (row.status === 'in_progress') {
    // the SERVING store's claim identity decides ownership — a pinned
    // non-beads store's assignee lives in a different identity space
    // than `bd`'s actor chain, so '' (unverifiable) can never match
    const actor = ctx.store.actor?.() ?? ''
    return actor !== '' && row.assignee === actor
      ? { verdict: 'step', id: ctx.id, detail: 'own claim — resume' }
      : { verdict: 'blocked', id: ctx.id, detail: `claimed by ${row.assignee ?? '?'}` }
  }
  // open: dep-gated/deferred beads aren't actionable work — the same
  // bd-side filtered ready list the focus read
  if (!readyBeads(ctx.dir, { store: ctx.store }).some((r) => r.id === ctx.id)) {
    return { verdict: 'blocked', id: ctx.id, detail: 'dep-gated or deferred' }
  }
  const rank = queueItems(queueScope(ctx), ctx).find((q) => q.id === ctx.id)?.rank
  return { verdict: 'step', id: ctx.id, detail: rank === undefined ? undefined : `queue rank ${rank}` }
}

/** The verdict for one item — the ladder from spec .5: done → wait →
 *  gate → live-worker wait → foreign-claim blocked → dep-gated
 *  blocked → step. `opts.gate === false` skips the worktree/PR probe —
 *  callers that own the gate themselves (drive's fixer spawn,
 *  spec bro-oy3k1.6) ask for the cheap ladder only. `opts.store` pins
 *  the tasks backend — a facade-resolved store (loop/drive contexts)
 *  must answer the same verdicts a beads one does; without it the
 *  dir's configured connector resolves instead. */
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
  const ctx: VerdictCtx = { dir, id, store, gate: opts?.gate }
  const early = earlyVerdict(row, ctx)
  if (early !== undefined) {
    return early
  }
  const settled = settledLegs(ctx, registryEntry(ctx))
  return settled ?? workVerdict(ctx, row)
}
