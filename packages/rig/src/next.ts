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
  const frame = queueScope(undefined, scope.dir, { store: scope.store })
  const top = queueItems(frame, scope.dir, { store: scope.store })[0]
  if (top !== undefined) {
    return top.id
  }
  const leaf = currentFrame(scope.dir, { store: scope.store })
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

/** An in_progress claim: own claim resumes, a foreign one blocks.
 *  Own means the assignee is this actor (shared claims comma-join
 *  assignees on some backends) or the step id itself WITH a registry
 *  pin — a spawn's claimAs worker identity binds the molStep, and an
 *  unregistered claimAs string proves nothing. The SERVING store's
 *  claim identity decides ownership — a pinned non-beads store's
 *  assignee lives in a different identity space than `bd`'s actor
 *  chain, and only a store without an actor probe falls back to it. */
function claimVerdict(
  ctx: VerdictCtx,
  row: TaskRow,
  entry: AgentRegistryEntry | undefined
): RigNext {
  const actor = ctx.store.actor?.() ?? bdActor(ctx.dir)
  const own =
    row.assignee !== undefined &&
    ((row.assignee === ctx.id && entry !== undefined) ||
      (actor !== '' &&
        row.assignee
          .split(',')
          .map((a) => a.trim())
          .includes(actor)))
  return own
    ? { verdict: 'step', id: ctx.id, detail: 'own claim — resume' }
    : { verdict: 'blocked', id: ctx.id, detail: `claimed by ${row.assignee ?? '?'}` }
}

/** The status gate under in_progress — undefined when the row is
 *  actionable. 'deferred' with a due wake reads open — only ready()
 *  undefers snoozes and a known id never calls it, so a past-due
 *  snooze parked here forever otherwise. But the wake must be PROVEN:
 *  a missing or unparseable defer_until leaves the snooze intact.
 *  Any other non-open status parks it — an undefined status proves
 *  nothing either. */
function statusVerdict(row: TaskRow, ctx: VerdictCtx, deferAt: number): RigNext | undefined {
  if (row.status === 'open') {
    return undefined
  }
  if (row.status === 'deferred') {
    return Number.isFinite(deferAt)
      ? undefined
      : { verdict: 'blocked', id: ctx.id, detail: 'status deferred — wake unproven' }
  }
  return { verdict: 'blocked', id: ctx.id, detail: `status ${row.status ?? 'unproven'}` }
}

/** The work legs — reached only when no settled leg fired: an
 *  in-progress row steps for its owner alone, and an open row is
 *  judged directly — a non-open status parks it, open 'blocked' deps
 *  gate it, a live defer_until or a coordination label parks it, and
 *  a queue member reports its rank as the step's detail. Page
 *  membership in `ready` is NOT the test: the backend's default limit
 *  truncates a deep queue and honest beads past the cut read as gated
 *  — drive's fixers died on exactly that (spec bro-reufd). */
function workVerdict(
  ctx: VerdictCtx,
  row: TaskRow,
  entry: AgentRegistryEntry | undefined
): RigNext {
  if (row.status === 'in_progress') {
    return claimVerdict(ctx, row, entry)
  }
  const deferUntil = (row as { defer_until?: unknown }).defer_until
  const deferAt = typeof deferUntil === 'string' ? Date.parse(deferUntil) : NaN
  if (deferAt > Date.now()) {
    return { verdict: 'blocked', id: ctx.id, detail: `deferred until ${deferUntil}` }
  }
  const parked = statusVerdict(row, ctx, deferAt)
  if (parked !== undefined) {
    return parked
  }
  let blockers: TaskRow[]
  try {
    // 'down' follows id → its deps ('up' would answer dependents);
    // with rel 'blocked' the down side IS the blocking set
    blockers = ctx.store
      .neighbors<TaskRow>(ctx.id, { direction: 'down', rel: 'blocked' })
      .filter((r) => r.status !== 'closed' && r.status !== 'done')
  } catch {
    // fail closed — an unreadable dep read must not read as actionable
    return { verdict: 'blocked', id: ctx.id, detail: 'deps unreadable' }
  }
  if (blockers.length > 0) {
    return {
      verdict: 'blocked',
      id: ctx.id,
      detail: `dep-gated by ${blockers.map((r) => r.id ?? '?').join(', ')}`,
    }
  }
  if (row.labels?.includes('gt:slot')) {
    return { verdict: 'blocked', id: ctx.id, detail: 'coordination slot' }
  }
  let rank: number | undefined
  try {
    rank = queueItems(queueScope(undefined, ctx.dir, { store: ctx.store }), ctx.dir, { store: ctx.store }).find((q) => q.id === ctx.id)?.rank
  } catch {
    // display-only — a queue read failure must not turn an
    // actionable bead unreadable
  }
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
  const entry = registryEntry(ctx)
  const settled = settledLegs(ctx, entry)
  return settled ?? workVerdict(ctx, row, entry)
}
