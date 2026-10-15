/**
 * Frame-scoped queues (bro-oy3k1.2). A queue item is a bead; membership
 * and rank are labels on it — `queue:<frame>` + `qrank:<int>` — so the
 * queue rides the same store, survives sync, and needs no second file.
 * Ranks step by 10 so a reorder relabels one bead instead of
 * renumbering the queue. No parent-child edge: an open child would
 * block the frame's `drill up`.
 */
import { taskStore } from '@broject/core'
import { currentFrame, drillDown } from './frames.ts'
import type { DrillRow } from './types.ts'

const QUEUE_LABEL_PREFIX = 'queue:'
const RANK_LABEL_PREFIX = 'qrank:'
const RANK_STEP = 10
/** Frame #0 — the session's own queue when no drill frame is open. */
export const ROOT_QUEUE = 'root'

export interface QueueItem {
  id: string
  title: string
  rank: number
}

const queueLabel = (frame: string): string => `${QUEUE_LABEL_PREFIX}${frame}`
const rankLabel = (rank: number): string => `${RANK_LABEL_PREFIX}${rank}`

function rankOf(row: DrillRow): number {
  for (const l of row.labels ?? []) {
    if (l.startsWith(RANK_LABEL_PREFIX)) {
      const n = Number(l.slice(RANK_LABEL_PREFIX.length))
      if (Number.isInteger(n)) return n
    }
  }
  // unranked member sorts last, stably by id
  return Number.MAX_SAFE_INTEGER
}

const isOpen = (r: DrillRow): boolean => r.status !== 'closed' && r.status !== 'done'

/** The queue a writer lands on: explicit --under, else the current
 *  drill leaf, else the session queue (frame #0). */
export function queueScope(under?: string): string {
  return under ?? currentFrame()?.id ?? ROOT_QUEUE
}

/** The frame's open queue items in rank order (id breaks ties). */
export function queueItems(frame: string): QueueItem[] {
  return taskStore()
    .list<DrillRow>({ labels: [queueLabel(frame)] })
    .filter(isOpen)
    .map((r) => ({ id: r.id, title: r.title, rank: rankOf(r) }))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
}

/** Intake: append a task bead at the tail of `under`'s queue
 *  (default: current scope). Returns the created row + assigned rank. */
export function queueAdd(
  title: string,
  opts: { under?: string; description?: string; priority?: number } = {},
): { row: DrillRow; frame: string; rank: number } {
  const trimmed = title.trim()
  if (!trimmed) {
    throw new Error('queue add requires a subject')
  }
  const frame = queueScope(opts.under)
  const items = queueItems(frame)
  const rank = (items.at(-1)?.rank ?? 0) + RANK_STEP
  const row = taskStore().create<DrillRow>({
    title: trimmed,
    type: 'task',
    labels: [queueLabel(frame), rankLabel(rank)],
    description: opts.description,
    priority: opts.priority,
  })
  return { row, frame, rank }
}

/** Reprioritize: --to N sets an explicit rank; bare bump floats the
 *  item to the top (rank = min − STEP). The item must sit on the
 *  named frame's queue — a miss is an error, not a no-op. */
export function queueBump(id: string, opts: { under?: string; to?: number } = {}): number {
  const frame = queueScope(opts.under)
  const row = taskStore().get<DrillRow>(id)
  if (!row || !isOpen(row) || !(row.labels ?? []).includes(queueLabel(frame))) {
    throw new Error(`${id} is not on ${frame}'s queue`)
  }
  const rank = opts.to ?? Math.min(...queueItems(frame).map((i) => i.rank)) - RANK_STEP
  const old = row.labels!.find((l) => l.startsWith(RANK_LABEL_PREFIX))
  if (old !== undefined) {
    taskStore().update(id, { 'remove-label': old })
  }
  taskStore().update(id, { 'add-label': rankLabel(rank) })
  return rank
}

/** Dequeue without working it — strips the queue labels; the bead
 *  stays open (a queue drop is not a close). */
export function queueDrop(id: string, opts: { under?: string } = {}): void {
  const frame = queueScope(opts.under)
  const row = taskStore().get<DrillRow>(id)
  if (!row || !(row.labels ?? []).includes(queueLabel(frame))) {
    throw new Error(`${id} is not on ${frame}'s queue`)
  }
  for (const l of row.labels ?? []) {
    if (l.startsWith(QUEUE_LABEL_PREFIX) || l.startsWith(RANK_LABEL_PREFIX)) {
      taskStore().update(id, { 'remove-label': l })
    }
  }
}

/** Promote: the queue item becomes a frame — drillDown pushes under
 *  the item's queue owner (its own label, not the caller's scope);
 *  `queue:root` items push as roots. The item then closes with the
 *  frame id as its reason. */
export function queueDrill(id: string): { frame: DrillRow; closed: string } {
  const row = taskStore().get<DrillRow>(id)
  const owner = row?.labels?.find((l) => l.startsWith(QUEUE_LABEL_PREFIX))?.slice(QUEUE_LABEL_PREFIX.length)
  if (!row || !isOpen(row) || owner === undefined) {
    throw new Error(`${id} is not a queued item`)
  }
  const frame =
    owner === ROOT_QUEUE ? drillDown(row.title, { root: true }) : drillDown(row.title, { under: owner })
  taskStore().close(id, `promoted → ${frame.id}`)
  return { frame, closed: id }
}
