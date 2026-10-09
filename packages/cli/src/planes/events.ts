/** events plane — the local event broker's ring plus the notify
 *  mailbox, read non-destructively (specs/bro-9rls.1.md). Rows are
 *  EventRow keyed `{gen}:{seq}` for bus records, drop filename for
 *  mailbox rows. `drainMailbox` is deliberately unused — it consumes
 *  drops and rewires cursors, so it cannot back a read. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  busProbe,
  busSocketPath,
  busStatus,
  drainDirs,
  mailboxEvent,
  verbsNotWired,
  type BusRecord,
  type EventRow,
  type PlaneCtx,
  type PlaneDescriptor,
} from '@broject/core'
import { argNumber, bounded, dispatchRead } from './helpers.ts'

const VERBS = ['publish']

/** Mailbox drops, listed not drained — `.seen-*` cursors and `.*.tmp`
 *  staging files are plumbing, not events. */
function mailboxRows(dir: string, limit: number): EventRow[] {
  const rows: EventRow[] = []
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
    const drops = mailboxRows(dir, limit)
    const merged = [...rows, ...drops]
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .slice(-limit)
    return { events: merged, gapped, ...(reason === undefined ? {} : { reason }) }
  }
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    tail,
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
    },
    /** `canStream` = the broker accepts subscribers right now. `read`
     *  = there is a bus socket path or a mailbox to read — drops land
     *  even with the broker down (dual-write rule). */
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
      return { read: sock !== null || mail, stream, publish: false }
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
