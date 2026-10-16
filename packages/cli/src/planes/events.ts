/** events plane — the local event broker's ring plus the notify
 *  mailbox and the durable lifecycle journal, read non-destructively
 *  (specs/bro-9rls.1.md + specs/telemetry/bro-ub91h.md). Rows are
 *  EventRow keyed `{gen}:{seq}` for bus records, drop filename for
 *  mailbox rows, `life:<n>` (line position) for lifecycle rows.
 *  `drainMailbox` is deliberately unused — it consumes drops and
 *  rewires cursors, so it cannot back a read. */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
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

/** The topics that ride the stream — the channel registry the
 *  AsyncAPI doc in stream.ts projects. Generated, not authored: a
 *  doc/event drift is impossible when both read this table. */
export const EVENTS_TOPICS = [
  { topic: 'notify', summary: 'mailbox drops — notify notes, watch pulses, worker results' },
  { topic: 'act', summary: 'review-loop verdicts — gate settles, thread resolutions' },
  { topic: 'convoy', summary: 'molecule/step lifecycle — claims, completions' },
  { topic: 'drive', summary: 'drive supervision — fixer spawns, orphan merges' },
  { topic: 'mesh', summary: 'cross-repo request lifecycle — claims, dones' },
  { topic: 'agent', summary: 'in-turn activity — turn/tool_call/subagent/usage at the acp pump' },
] as const

/** One human line for an 'agent'-topic envelope — the "agent last did
 *  X" cell in `bro watch` and the MCP activity read's `latest` map.
 *  Payload fields are read defensively: a peer publishing a newer
 *  shape degrades to its discriminator, never throws. */
export function agentEventLine(e: { kind: string; key?: string; payload?: unknown }): string {
  const p = (typeof e.payload === 'object' && e.payload !== null ? e.payload : {}) as Record<
    string,
    unknown
  >
  const s = (k: string): string | undefined => {
    const v = p[k]
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const n = (k: string): number | undefined => {
    const v = p[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const who = e.key ?? 'agent'
  switch (e.kind) {
    case 'turn': {
      if (s('phase') === 'start') {
        return `${who}: turn started`
      }
      const err = s('error')
      const tail =
        err !== undefined
          ? ` failed — ${err}`
          : ` stopped${s('stopReason') !== undefined ? ` (${s('stopReason')})` : ''}`
      return `${who}: turn${tail}`
    }
    case 'tool_call': {
      const what = s('title') ?? s('name') ?? s('toolCallId') ?? 'tool'
      const phase =
        s('phase') === 'open' ? 'started' : `finished${s('status') !== undefined ? ` (${s('status')})` : ''}`
      return `${who}: ${what} ${phase}${s('kind') !== undefined ? ` [${s('kind')}]` : ''}`
    }
    case 'subagent':
      return `${who}: subagent ${s('title') ?? s('sessionId') ?? '?'} ${s('phase') ?? ''}`.trimEnd()
    case 'usage': {
      const cost = p['cost']
      const costStr =
        typeof cost === 'object' && cost !== null && typeof (cost as { amount?: unknown }).amount === 'number'
          ? ` ${(cost as { currency?: string }).currency ?? ''}${(cost as { amount: number }).amount}`.trim()
          : ''
      return `${who}: context ${n('used') ?? '?'}/${n('size') ?? '?'}${costStr === '' ? '' : ` (${costStr})`}`
    }
    default:
      return `${who}: ${e.kind}`
  }
}

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
        // lstat — stat would follow a planted symlink and tail a
        // foreign file as if it were a drop
        const st = lstatSync(path)
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
  /** 'agent' topic activity — the fleet's in-turn heartbeat read
   *  (bro-0ppt0): MCP `bro_events_activity` is how an orchestrator sees
   *  what its workers are doing between status polls. Broker-side
   *  narrowing (`filter`) keeps the probe window for agent rows only.
   *  `agent` pins one subject key — the worker's id or the
   *  `acp:<sessionId>` fallback unbadged turns publish under. `latest`
   *  folds each subject's newest row into its one-line "last did X". */
  const activity = async (a?: Record<string, unknown>) => {
    const limit = Math.min(argNumber(a, 'limit') ?? 64, 512)
    const agent = argString(a, 'agent')
    const sock = socket()
    if (sock === null) {
      return { events: [] as EventRow[], latest: {}, reason: 'no broker socket' }
    }
    const res = await busProbe(sock, {
      limit,
      windowMs: 2_000,
      filter: {
        topics: ['agent'],
        ...(agent !== undefined ? { keys: [agent] } : {}),
      },
    })
    const latest: Record<string, string> = {}
    for (const e of res.events) {
      if (typeof e.key === 'string') {
        latest[e.key] = agentEventLine(e)
      }
    }
    return {
      events: res.events.map((e) => busRow(e as BusRecord)),
      latest,
      gapped: res.gapped,
      ...(res.reason === undefined ? {} : { reason: res.reason }),
    }
  }
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    tail,
    lifecycle,
    activity,
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
      activity: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'max rows (default 64, cap 512)' },
          agent: {
            type: 'string',
            description:
              "subject key filter — the worker's BRO_AGENT_ID or an 'acp:<sessionId>' fallback key",
          },
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
