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
  type TaskRow,
} from '@broject/core'
import {
  currentFrame,
  queueItems,
  queueScope,
  WAITING_LABEL,
} from '@broject/drill'
import { worktreePathFor, mainWorktree } from './work.ts'

export interface RigNext {
  verdict: 'step' | 'gate' | 'wait' | 'done' | 'blocked'
  id?: string
  detail?: string
}

/** The WAKE: predicate is the last `WAKE:` line in the frame's notes —
 *  parkFrame's append contract. */
function wakePredicate(row: TaskRow): string | undefined {
  return row.notes
    ?.split('\n')
    .filter((l) => l.startsWith('WAKE: '))
    .at(-1)
    ?.slice(6)
}

/** No-arg focus: the current frame's queue top (intake order), else
 *  the drill leaf, else the store's first dep-gated ready row —
 *  epic rows are containers, never work items. */
export function rigFocus(store = taskStore()): string | undefined {
  const top = queueItems(queueScope())[0]
  if (top !== undefined) {
    return top.id
  }
  const leaf = currentFrame()
  if (leaf) {
    return leaf.id
  }
  return store.ready<TaskRow>().find((r) => r.issue_type !== 'epic')?.id
}

/** The verdict for one item — the ladder from spec .5: done → wait →
 *  gate → live-worker wait → foreign-claim blocked → dep-gated
 *  blocked → step. */
export function rigNext(dir: string, item?: string): RigNext {
  const store = taskStore()
  const id = item ?? rigFocus(store)
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
  // a live registry agent owns the step — a signal re-enters. Checked
  // ahead of the PR plane: a fixer mid-flight keeps the item at wait
  // even while its PR is open or settled
  if (
    entry !== undefined &&
    entry.stopped !== true &&
    typeof entry.pid === 'number' &&
    pidAlive(entry.pid, typeof entry.pidStart === 'string' ? entry.pidStart : undefined)
  ) {
    return { verdict: 'wait', id, detail: `agent ${entry.agentId} in flight` }
  }
  // gate — an open PR on the item's worktree branch moves the next
  // transition to the gate (threads/CI/human), ahead of claim reads:
  // a claimed item with a PR up is decided by the gate, not by work
  let wt = entry?.worktree
  if (wt === undefined) {
    try {
      wt = worktreePathFor(mainWorktree().path, id)
    } catch {
      // not a git repo — no worktree plane to probe
      wt = undefined
    }
  }
  if (typeof wt === 'string' && existsSync(wt)) {
    // a detached/failed branch read means the PR association is
    // unknowable — skip the probe rather than guess a branch name
    const branch = gitTry(['-C', wt, 'branch', '--show-current']).out.trim()
    if (branch !== '') {
      try {
        const rev = reviewHost(
          dir,
          (loadConfig(dir) as { connectors?: Record<string, string> }).connectors
        )
        const open = rev.prsForBranch(branch)
        if (open.length > 0) {
          return { verdict: 'gate', id, detail: `pr=#${open[0]}` }
        }
        // a merged PR + still-open bead is the cleanup edge — the next
        // step is finalization, not work
        if (rev.prsForBranch(branch, 'all').length > 0) {
          return { verdict: 'step', id, detail: 'pr settled — close/ledger' }
        }
      } catch {
        // the host is unreachable — fall through to the claim ladder;
        // the next re-entry sees the gate again
      }
    }
  }
  if (row.status === 'in_progress') {
    const actor = bdActor(dir)
    if (row.assignee === actor) {
      return { verdict: 'step', id, detail: 'own claim — resume' }
    }
    return { verdict: 'blocked', id, detail: `claimed by ${row.assignee ?? '?'}` }
  }
  // open: dep-gated/deferred beads aren't actionable work
  if (!store.ready<TaskRow>().some((r) => r.id === id)) {
    return { verdict: 'blocked', id, detail: 'dep-gated or deferred' }
  }
  const rank = queueItems(queueScope()).find((q) => q.id === id)?.rank
  return { verdict: 'step', id, detail: rank === undefined ? undefined : `queue rank ${rank}` }
}
