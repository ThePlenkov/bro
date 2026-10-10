/** events plane — the local event broker's ring plus the notify
 *  mailbox and the durable lifecycle journal, read non-destructively
 *  (specs/bro-9rls.1.md + specs/telemetry/bro-ub91h.md). Rows are
 *  EventRow keyed `{gen}:{seq}` for bus records, drop filename for
 *  mailbox rows, `life:<n>` (line position) for lifecycle rows.
 *  `drainMailbox` is deliberately unused — it consumes drops and
 *  rewires cursors, so it cannot back a read. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  addressedTo,
  busProbe,
  busSocketPath,
  busStatus,
  drainDirs,
  lifecyclePath,
  mailboxEvent,
  mailboxIdentity,
  readLifecycle,
  verbsNotWired,
  type BusRecord,
  type EventRow,
  type LifecycleRow,
  type PlaneCtx,
  type PlaneDescriptor,
} from '@broject/core'
import { argNumber, argString, bounded, dispatchRead } from './helpers.ts'

const VERBS = ['publish']

/** Mailbox drops, listed not drained — `.seen-*` cursors and `.*.tmp`
 *  staging files are plumbing, not events. `to:`-addressed drops are
 *  gated by the drain's own addressing rule — a drop for another
 *  session or agent is not this reader's event. */
function mailboxRows(dir: string, limit: number): EventRow[] {
  const rows: EventRow[] = []
  const me = mailboxIdentity()
  for (const d of drainDirs(dir)) {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.txt') || name.startsWith('.')) {
        continue
      }
      const path = join(d, name)
      let text: string
      let ts: string
      try {
        const st = statSync(path)
        if (!st.isFile()) {
          continue
        }
        ts = st.mtime.toISOString()
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const ev = mailboxEvent(text, path)
      if (typeof ev.to === 'string' && ev.to !== '' && !addressedTo(ev.to, me)) {
        continue
      }
      rows.push({ ...ev, ts, id: name, origin: 'mailbox' })
    }
  }
  return rows
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-limit)
}

const busRow = (r: EventRow | BusRecord): EventRow => {
  const gen = 'gen' in r ? r.gen : undefined
  const seq = 'seq' in r ? r.seq : undefined
  return {
    ...r,
    id: gen !== undefined && seq !== undefined ? `${gen}:${seq}` : `bus:${r.ts}`,
    origin: 'bus',
  }
}

/** Durable transition rows off `<git-common>/bro/events.jsonl` — the
 *  journal every writer (loop/act/drive/agents/work) appends through
 *  `emitLifecycle`. `life:<seq>` ids are line positions in the current
 *  file; compaction shifts them the same way a truncated bus tail
 *  reports `gapped`. */
function lifecycleRows(
  dir: string,
  opts: { limit?: number; kind?: string; bead?: string; pr?: number; since?: string }
): LifecycleRow[] {
  return readLifecycle(dir, opts).map((r) => ({
    ...r,
    id: `life:${r.seq}`,
    origin: 'lifecycle',
  }))
}

export function eventsPlane(ctx: PlaneCtx): PlaneDescriptor {
  const dir = ctx.dir
  const socket = () => busSocketPath(dir)
  const tail = async (a?: Record<string, unknown>) => {
    const limit = Math.min(argNumber(a, 'limit') ?? 64, 512)
    const since = argNumber(a, 'since')
    const sock = socket()
    let gapped = false
    let reason: string | undefined
    const rows: EventRow[] = []
    if (sock !== null) {
      const res = await busProbe(sock, { since, limit, windowMs: 2_000 })
      gapped = res.gapped
      reason = res.reason
      for (const e of res.events) {
        rows.push(busRow(e as BusRecord))
      }
    } else {
      reason = 'no broker socket'
    }
    const drops = mailboxRows(dir, limit + 1)
    // the durable journal joins the transient view — its rows sort
    // beside bus/mailbox by ts; `since` stays a bus-ring cursor and
    // does NOT filter lifecycle rows
    const life = lifecycleRows(dir, { limit: limit + 1 })
    const merged = [...rows, ...drops, ...life].sort((a, b) => a.ts.localeCompare(b.ts))
    // limit-truncation IS a gap — the mailbox facade's probe flags it
    // the same way; a client must never read a partial replay as complete
    const truncated = merged.length > limit
    return {
      events: truncated ? merged.slice(-limit) : merged,
      gapped: gapped || truncated,
      ...(reason === undefined ? {} : { reason }),
    }
  }
  /** The durable bead→land timeline alone — the read a metrics view
   *  (cycle-time, fix-rounds, WIP curve) is built on. `since` is an
   *  ISO timestamp here (unlike tail's bus-seq cursor). */
  const lifecycle = (a?: Record<string, unknown>) => {
    const limit = Math.min(argNumber(a, 'limit') ?? 256, 2_000)
    const since = argString(a, 'since')
    const rows = lifecycleRows(dir, {
      limit: limit + 1,
      kind: argString(a, 'kind'),
      bead: argString(a, 'bead'),
      pr: argNumber(a, 'pr'),
      ...(since !== undefined ? { since } : {}),
    })
    const truncated = rows.length > limit
    return {
      events: truncated ? rows.slice(-limit) : rows,
      gapped: truncated,
      ...(truncated ? { reason: 'limit-truncated — page with since' } : {}),
    }
  }
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    tail,
    lifecycle,
  }
  return {
    name: 'events',
    reads: Object.keys(reads),
    verbs: VERBS,
    readArgs: {
      list: { type: 'object', properties: { limit: { type: 'integer' } } },
      tail: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'max rows (default 64, cap 512)' },
          since: { type: 'integer', description: 'ring cursor — events with seq > since' },
        },
      },
      lifecycle: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'max rows (default 256, cap 2000)' },
          since: { type: 'string', description: 'ISO timestamp — rows with ts > since' },
          kind: { type: 'string', description: 'transition kind filter' },
          bead: { type: 'string', description: 'bead id filter' },
          pr: { type: 'integer', description: 'PR number filter' },
        },
      },
    },
    /** `canStream` = the broker accepts subscribers right now. `read`
     *  = a bus socket path, a mailbox, or the durable journal exists —
     *  drops and lifecycle rows land even with the broker down. */
    capabilities: async () => {
      const sock = socket()
      let stream = false
      if (sock !== null) {
        stream = await bounded(
          busStatus(sock).then((s) => s.running === true).catch(() => false),
          3_000,
          false
        )
      }
      const mail = drainDirs(dir).some((d) => existsSync(d))
      const life = lifecyclePath(dir) !== null && existsSync(lifecyclePath(dir)!)
      return { read: sock !== null || mail || life, stream, publish: false }
    },
    list: async (f) => {
      const limit = Math.min(typeof f?.limit === 'number' ? f.limit : 64, 512)
      const { events } = await tail({ limit })
      return events
    },
    get: async (ref) => {
      const { events } = await tail({ limit: 512 })
      return events.find((e) => e.id === ref)
    },
    read: (name, args) => dispatchRead('events', reads, name, args),
    exec: verbsNotWired('events', VERBS),
  }
}
