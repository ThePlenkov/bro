/**
 * Local event bus — a broker process on a Unix socket carrying agent
 * events with topics, subscriber-side filters and monotonic `seq`
 * cursors.
 *
 * Why this exists: every consumer of agent state was a polling engine,
 * and three of them (bro watch's `lastNotified` diff, the notify
 * mailbox's per-session `.seen-*` cursors, the hook probe's directory
 * walk) each re-implemented subscription semantics on a shared
 * directory. One-to-many, many-to-many and per-subscriber filters
 * existed nowhere. A shared directory also cannot express a total
 * order — 83 separate cursor files have no global sequence, so
 * "which agent finished before which" is unrecoverable, which is
 * exactly the causality an orchestrator needs.
 *
 * Why not the devin MCP tools (`devin_session_events`,
 * `devin_session_gather`, `devin_session_interact`): they are tools,
 * callable only from inside an agent turn, and only by the agent that
 * owns the ACP session. A host-side process cannot reach them at all,
 * so a "bridge" over them is impossible by construction, not merely
 * expensive.
 *
 * Delivery model: push into the broker, pull at the one point bro owns
 * inside a live session — the `postTool` probe. No component is ever
 * required to hold a connection open except a host-side subscriber,
 * which is why `publish` is connect-write-exit.
 *
 * Wire format: newline-delimited JSON, one frame per line. The socket
 * lives in a short hashed path because `sun_path` is capped at 108
 * bytes (Linux) / 104 (macOS) and a deep worktree path truncates
 * silently into EADDRINUSE.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { gitCommonDir } from './git.ts'

/** Hard budget for every client operation. REVIEW.md rates any path
 *  that can hang or exit non-zero on a hook event as critical, so the
 *  client resolves "nothing to report" on expiry instead of throwing.
 *  Generous enough for a busy loopback round trip, short enough that a
 *  wedged broker cannot outlive the session that probed it. */
export const BUS_TIMEOUT_MS = 2_000

/** How many envelopes a broker keeps for reconnect replay. A consumer
 *  whose cursor fell out of the window gets a `gap` frame and re-derives
 *  from the registry — which stays the source of truth. Deliberately
 *  memory-only: a delivery path with its own compaction is the debris
 *  this design refuses to create. */
export const BUS_RING_LIMIT = 10_000

/** A slow subscriber is dropped rather than buffered without bound —
 *  `writableLength` past this and the event is skipped, with a `gap`
 *  frame before the next delivered one so the consumer knows to
 *  re-derive instead of silently missing events. */
const SLOW_CONSUMER_BYTES = 1024 * 1024

/** One event as published. `seq` and `ts` are the broker's to assign —
 *  a publisher cannot forge an order. */
export interface BusEventInput {
  topic: string
  kind: string
  key?: string
  source?: string
  payload?: unknown
}

/** One event as delivered. */
export interface BusEnvelope extends BusEventInput {
  seq: number
  ts: string
}

/** Subscriber-side selection. Matching happens once, in the broker:
 *  one publish, N subscribers, each receiving only its subset. */
export interface BusFilter {
  topics?: string[]
  kinds?: string[]
}

/** `'*'`, an exact topic, or a trailing-`*` prefix glob. */
export function busTopicMatches(pattern: string, topic: string): boolean {
  if (pattern === '*') {
    return true
  }
  if (pattern.endsWith('*')) {
    return topic.startsWith(pattern.slice(0, -1))
  }
  return pattern === topic
}

export function busMatches(filter: BusFilter, event: { topic: string; kind: string }): boolean {
  const topics = filter.topics
  if (topics !== undefined && topics.length > 0 && !topics.some((t) => busTopicMatches(t, event.topic))) {
    return false
  }
  const kinds = filter.kinds
  if (kinds !== undefined && kinds.length > 0 && !kinds.includes(event.kind)) {
    return false
  }
  return true
}

export function isBusEventInput(value: unknown): value is BusEventInput {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const v = value as Record<string, unknown>
  return typeof v['topic'] === 'string' && v['topic'] !== '' && typeof v['kind'] === 'string' && v['kind'] !== ''
}

/** Bounded replay window. `since` is the caller's last seen seq. */
export class BusRing {
  private readonly limit: number
  private readonly buf: BusEnvelope[] = []

  constructor(limit: number = BUS_RING_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`bus ring limit must be a positive integer, got ${String(limit)}`)
    }
    this.limit = limit
  }

  get size(): number {
    return this.buf.length
  }

  push(event: BusEnvelope): void {
    this.buf.push(event)
    if (this.buf.length > this.limit) {
      this.buf.splice(0, this.buf.length - this.limit)
    }
  }

  /** Events after `since`, or null when they are unobtainable — the
   *  cursor predates the window (evicted) or claims a seq this broker
   *  run never issued (it restarted, so seq counts from 1 again).
   *  Both mean the same thing to a consumer: re-derive from state. */
  since(since: number): BusEnvelope[] | null {
    const first = this.buf[0]
    if (first === undefined) {
      // nothing published yet: a cursor past our seq is still a gap,
      // an empty window is not
      return since > 0 ? null : []
    }
    if (since < first.seq - 1) {
      return null
    }
    return this.buf.filter((e) => e.seq > since)
  }
}

/** Runtime dir for the socket — `XDG_RUNTIME_DIR` when set (already
 *  user-private), else tmpdir. Hashing the common dir keeps the path
 *  short enough for `sun_path` no matter how deep the worktree, and
 *  stable per repo across processes. */
function busSocketBase(): string {
  const runtime = process.env.XDG_RUNTIME_DIR
  return runtime !== undefined && runtime !== '' ? runtime : tmpdir()
}

/** The broker socket for a repo, or null outside a repository. */
export function busSocketPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  if (common === null) {
    return null
  }
  const hash = createHash('sha256').update(common).digest('hex').slice(0, 16)
  return join(busSocketBase(), 'bro-bus', `${hash}.sock`)
}

/** Discovery file — same shape as `serve.json`: how a client learns the
 *  socket path and pid without re-deriving the hash. */
export function busStatePath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'bus.json')
}

interface Subscriber {
  filter: BusFilter
  sock: Socket
  dropped: boolean
}

export interface BusBrokerOptions {
  ringLimit?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

export interface BusBroker {
  readonly socketPath: string
  /** Broker pid — a client that suspects a stale socket needs to know
   *  whether anything is actually behind it. */
  readonly pid: number
  /** Highest seq assigned so far — the cursor a fresh subscriber starts from. */
  readonly seq: number
  readonly subscriberCount: number
  close(): Promise<void>
}

/** True when something is listening on the socket. Distinguishes a live
 *  broker from a stale inode a SIGKILLed one left behind — without it,
 *  bind fails EADDRINUSE forever and the bus can never restart. */
function probeSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = connect(socketPath)
    let settled = false
    const finish = (up: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(up)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

function sendFrame(sock: Socket, frame: unknown): void {
  sock.write(`${JSON.stringify(frame)}\n`)
}

/** Start a broker on an explicit socket path. Path-taking rather than
 *  dir-taking so tests need no git repository; `startBusBroker` is the
 *  dir-shaped wrapper that also publishes discovery state. */
export async function startBusBrokerAt(
  socketPath: string,
  opts: BusBrokerOptions = {}
): Promise<BusBroker> {
  const ring = new BusRing(opts.ringLimit)
  const now = opts.now ?? Date.now
  const subs = new Set<Subscriber>()
  // net.Server has no closeAllConnections (that is http.Server), so the
  // open peers are tracked explicitly — close() must not wait on a
  // subscriber that is itself waiting for events.
  const sockets = new Set<Socket>()
  let seq = 0
  let open = true

  const deliver = (sub: Subscriber, frame: unknown): void => {
    // A subscriber that cannot keep up gets dropped events, not a
    // stalled broker: gap first so its next event is honest about the
    // hole, then resume.
    if (sub.sock.writableLength > SLOW_CONSUMER_BYTES) {
      sub.dropped = true
      return
    }
    if (sub.dropped) {
      sub.dropped = false
      sendFrame(sub.sock, { op: 'gap', seq })
    }
    sendFrame(sub.sock, frame)
  }

  const onPub = (sock: Socket, input: unknown): void => {
    if (!isBusEventInput(input)) {
      sendFrame(sock, { op: 'err', message: 'pub needs event {topic, kind}' })
      return
    }
    seq += 1
    const envelope: BusEnvelope = {
      ...input,
      seq,
      ts: new Date(now()).toISOString(),
    }
    ring.push(envelope)
    const out = { op: 'event', event: envelope }
    for (const s of subs) {
      if (busMatches(s.filter, envelope)) {
        deliver(s, out)
      }
    }
    sendFrame(sock, { op: 'ack', seq })
  }

  const onSub = (sock: Socket, frame: Record<string, unknown>, sub: Subscriber | undefined): Subscriber => {
    const raw = frame['filter']
    const filter: BusFilter = typeof raw === 'object' && raw !== null ? (raw as BusFilter) : {}
    const sinceRaw = frame['since']
    // An absent cursor starts at the current head: replay nothing.
    const since = typeof sinceRaw === 'number' && Number.isFinite(sinceRaw) ? Math.floor(sinceRaw) : seq
    const entry: Subscriber = sub ?? { filter, sock, dropped: false }
    entry.filter = filter
    subs.add(entry)
    const replay = ring.since(since)
    if (replay === null) {
      sendFrame(sock, { op: 'gap', seq })
      return entry
    }
    // The gap check is against the raw ring — a hole in the stream is a
    // hole whatever this subscriber cares about — but the events it is
    // handed still go through its filter, or replay would hand it topics
    // it never asked for.
    for (const e of replay) {
      if (busMatches(entry.filter, e)) {
        sendFrame(sock, { op: 'event', event: e })
      }
    }
    return entry
  }

  const handleFrame = (sock: Socket, line: string, sub: Subscriber | undefined): Subscriber | undefined => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      sendFrame(sock, { op: 'err', message: 'malformed frame' })
      sock.end()
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) {
      sendFrame(sock, { op: 'err', message: 'frame must be an object' })
      return undefined
    }
    const frame = parsed as Record<string, unknown>
    switch (frame['op']) {
      case 'pub': {
        onPub(sock, frame['event'])
        return undefined
      }
      case 'sub': {
        return onSub(sock, frame, sub)
      }
      case 'stats': {
        sendFrame(sock, { op: 'stats', seq, subscribers: subs.size, ring: ring.size })
        return undefined
      }
      default: {
        sendFrame(sock, { op: 'err', message: `unknown op ${JSON.stringify(frame['op'])}` })
        return undefined
      }
    }
  }

  const server: Server = createServer((sock) => {
    let buf = ''
    let sub: Subscriber | undefined
    sockets.add(sock)
    // A peer that dies mid-write must not take the broker with it
    sock.on('error', () => {})
    sock.on('close', () => {
      sockets.delete(sock)
      if (sub !== undefined) {
        subs.delete(sub)
      }
    })
    sock.on('data', (chunk: Buffer | string) => {
      if (!open) {
        return
      }
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim() !== '') {
          const next = handleFrame(sock, line, sub)
          if (next !== undefined) {
            sub = next
          }
        }
        nl = buf.indexOf('\n')
      }
    })
  })

  if (await probeSocket(socketPath, 200)) {
    throw new Error(`bus already running on ${socketPath}`)
  }
  // The socket lives in a shared dir, so it must be owner-only or another
  // local user could plant the name and receive every event. mkdir is
  // required — binding into a missing dir fails — so it is not
  // best-effort; the mode is, and `recursive` leaves an existing dir's
  // mode alone, hence the explicit chmod.
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  try {
    chmodSync(dirname(socketPath), 0o700)
  } catch {
    // best effort — a mode failure must not stop the broker
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  try {
    chmodSync(socketPath, 0o600)
  } catch {
    // best effort — a chmod failure must not stop the broker
  }

  return {
    socketPath,
    pid: process.pid,
    get seq(): number {
      return seq
    },
    get subscriberCount(): number {
      return subs.size
    },
    close: async () => {
      open = false
      subs.clear()
      for (const sock of sockets) {
        sock.destroy()
      }
      sockets.clear()
      await new Promise<void>((resolve) => {
        const force = setTimeout(resolve, BUS_TIMEOUT_MS)
        force.unref?.()
        server.close(() => {
          clearTimeout(force)
          resolve()
        })
      })
    },
  }
}

/** Dir-shaped wrapper: resolves the socket path and publishes discovery
 *  state so clients do not re-derive the hash. */
export async function startBusBroker(dir: string, opts: BusBrokerOptions = {}): Promise<BusBroker> {
  const socketPath = busSocketPath(dir)
  if (socketPath === null) {
    throw new Error('bro bus: not inside a git repository')
  }
  const broker = await startBusBrokerAt(socketPath, opts)
  const statePath = busStatePath(dir)
  if (statePath !== null) {
    mkdirSync(join(statePath, '..'), { recursive: true })
    writeFileSync(
      statePath,
      `${JSON.stringify(
        { socketPath, pid: process.pid, startedAt: new Date().toISOString() },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
  }
  return broker
}

/** Nothing is listening on that socket. A stale socket file gives ENOENT,
 *  a live-but-stopped broker gives ECONNREFUSED — the same fact to a
 *  caller, so callers get one stable reason instead of an errno that
 *  leaks into notes. EACCES is deliberately excluded: a permission
 *  problem is a real fault worth showing verbatim. */
const BROKER_DOWN_CODES = new Set(['ENOENT', 'ECONNREFUSED'])

function brokerDownReason(err: unknown): string {
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && BROKER_DOWN_CODES.has(code)) {
    return 'broker down'
  }
  return err instanceof Error ? err.message : String(err)
}

export interface BusPublishResult {
  published: boolean
  seq?: number
  /** Why it did not publish — `broker down` is routine, not a failure. */
  reason?: string
}

/** Publish one event. Fail-open by contract: a broker that is down, or
 *  a connect that outlives the budget, resolves `published: false`
 *  rather than throwing — callers on the hook path cannot let a
 *  transport problem become a session problem. */
export function busPublish(
  socketPath: string,
  event: BusEventInput,
  opts: { timeoutMs?: number } = {}
): Promise<BusPublishResult> {
  const timeoutMs = opts.timeoutMs ?? BUS_TIMEOUT_MS
  return new Promise<BusPublishResult>((resolve) => {
    let settled = false
    let buf = ''
    const finish = (res: BusPublishResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(res)
    }
    const sock = connect(socketPath)
    const timer = setTimeout(() => finish({ published: false, reason: 'timeout' }), timeoutMs)
    timer.unref?.()
    sock.on('error', (err: NodeJS.ErrnoException) => {
      finish({ published: false, reason: brokerDownReason(err) })
    })
    sock.on('connect', () => {
      sendFrame(sock, { op: 'pub', event })
    })
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) {
        return
      }
      try {
        const frame = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
        if (frame['op'] === 'ack' && typeof frame['seq'] === 'number') {
          finish({ published: true, seq: frame['seq'] })
        } else if (frame['op'] === 'err') {
          finish({ published: false, reason: String(frame['message']) })
        }
      } catch {
        finish({ published: false, reason: 'malformed ack' })
      }
    })
  })
}

export interface BusSubscriptionHandlers {
  onEvent: (event: BusEnvelope) => void
  /** Cursor fell out of the replay window (or the broker restarted) —
   *  re-derive from state before trusting the next event. */
  onGap?: (seq: number) => void
}

export interface BusSubscription {
  close(): void
}

/** Subscribe. Unlike publish this throws on an unreachable broker: it is
 *  an explicit user action, and the fail-open boundary belongs at the
 *  call site (`busProbe`), not inside the transport. */
export function busSubscribe(
  socketPath: string,
  filter: BusFilter,
  handlers: BusSubscriptionHandlers,
  opts: { since?: number; timeoutMs?: number } = {}
): Promise<BusSubscription> {
  const timeoutMs = opts.timeoutMs ?? BUS_TIMEOUT_MS
  return new Promise<BusSubscription>((resolve, reject) => {
    let settled = false
    let buf = ''
    const sock = connect(socketPath)
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        sock.destroy()
        reject(new Error('bro bus: subscribe timed out'))
      }
    }, timeoutMs)
    timer.unref?.()
    sock.once('error', (err: Error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    })
    sock.once('connect', () => {
      // No cursor means "from now", not "from the beginning of the
      // ring" — a plain subscriber wants the stream, and defaulting to 0
      // would dump the whole backlog at it.
      sendFrame(sock, {
        op: 'sub',
        filter,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      })
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ close: () => sock.destroy() })
    })
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim() !== '') {
          let frame: Record<string, unknown>
          try {
            frame = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (frame['op'] === 'event') {
            handlers.onEvent(frame['event'] as BusEnvelope)
          } else if (frame['op'] === 'gap' && handlers.onGap !== undefined) {
            handlers.onGap(typeof frame['seq'] === 'number' ? frame['seq'] : 0)
          }
        }
        nl = buf.indexOf('\n')
      }
    })
  })
}

export interface BusStatus {
  running: boolean
  seq?: number
  subscribers?: number
  ring?: number
  socketPath: string
  reason?: string
}

/** Liveness + counters. Resolves `running: false` instead of throwing —
 *  `bro bus status` must be safe to call from a hook or a doctor walk. */
export function busStatus(socketPath: string, opts: { timeoutMs?: number } = {}): Promise<BusStatus> {
  const timeoutMs = opts.timeoutMs ?? BUS_TIMEOUT_MS
  return new Promise<BusStatus>((resolve) => {
    let settled = false
    let buf = ''
    const finish = (status: BusStatus): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(status)
    }
    const sock = connect(socketPath)
    const timer = setTimeout(() => finish({ running: false, socketPath, reason: 'timeout' }), timeoutMs)
    timer.unref?.()
    sock.on('error', (err: NodeJS.ErrnoException) => {
      finish({ running: false, socketPath, reason: brokerDownReason(err) })
    })
    sock.on('connect', () => {
      sendFrame(sock, { op: 'stats' })
    })
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) {
        return
      }
      try {
        const frame = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
        if (frame['op'] === 'stats') {
          finish({
            running: true,
            socketPath,
            ...(typeof frame['seq'] === 'number' ? { seq: frame['seq'] } : {}),
            ...(typeof frame['subscribers'] === 'number' ? { subscribers: frame['subscribers'] } : {}),
            ...(typeof frame['ring'] === 'number' ? { ring: frame['ring'] } : {}),
          })
        }
      } catch {
        finish({ running: false, socketPath, reason: 'malformed stats' })
      }
    })
  })
}

export interface BusProbeResult {
  events: BusEnvelope[]
  /** True when the cursor could not be honoured — the caller must
   *  re-derive state rather than trust the events it did get. */
  gapped: boolean
  /** Why nothing came back. `broker down` is routine on a repo where
   *  nobody started one, so it is not an error. */
  reason?: string
}

/** The hook-path primitive: collect whatever the bus has for this
 *  cursor, within a hard window, failing open at every step. A wedged
 *  broker, a stale socket or a slow peer all resolve to an empty result
 *  rather than a thrown error — the caller is a hook, and a hook that
 *  throws is a critical finding per REVIEW.md. */
export async function busProbe(
  socketPath: string,
  opts: { since?: number; windowMs?: number } = {}
): Promise<BusProbeResult> {
  const windowMs = opts.windowMs ?? 250
  const events: BusEnvelope[] = []
  let gapped = false
  let sub: BusSubscription | undefined
  try {
    sub = await busSubscribe(
      socketPath,
      {},
      {
        onEvent: (e) => events.push(e),
        onGap: () => {
          gapped = true
        },
      },
      { since: opts.since ?? 0, timeoutMs: Math.max(1, windowMs) }
    )
  } catch (err) {
    return { events, gapped, reason: brokerDownReason(err) }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, windowMs)
    timer.unref?.()
  })
  sub.close()
  return { events, gapped }
}
