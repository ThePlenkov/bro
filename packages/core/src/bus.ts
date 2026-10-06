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
 * Why not the host's own vendor session tools (`*_session_events`,
 * `*_session_gather`, `*_session_interact`): they are tools,
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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  eventMatches,
  isEventInput,
  type EventEnvelope,
  type EventFilter,
  type EventInput,
} from './events.ts'
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

/** How much a cursorless probe catches up: the newest slice of the ring,
 *  not all of it. A hook runs on every event, so an unbounded catch-up
 *  would turn a 10k ring into 10k lines per hook. */
export const BUS_PROBE_LIMIT = 64

/** How long a probe listens before it reports what it has. The bead's
 *  constraint is a hard sub-second budget: a hook must never wait on a
 *  wedged broker, so this is a ceiling and not a suggestion. */
export const BUS_PROBE_WINDOW_MS = 250

/** Retention, on the age and byte axes. The count bound alone still
 *  lets a slow trickle of events sit in memory indefinitely, and one
 *  fat payload can carry a whole ring's worth of bytes. */
export const BUS_RING_TTL_MS = 60 * 60_000

export const BUS_RING_MAX_BYTES = 32 * 1024 * 1024

/** Bytes an envelope occupies in the ring — measured, not estimated,
 *  so the byte bound cannot drift from what is actually retained. */
function busEventBytes(event: EventEnvelope): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8')
}

/** A slow subscriber is dropped rather than buffered without bound —
 *  `writableLength` past this and the event is skipped, with a `gap`
 *  frame before the next delivered one so the consumer knows to
 *  re-derive instead of silently missing events. */
const SLOW_CONSUMER_BYTES = 1024 * 1024

/**
 * The local bus — a CONNECTOR for the `events` facade, not the capability
 * itself. The event contract (topic, kind, key, cause, ref, payload) and
 * the matching rules live in events.ts; what stays here is the transport:
 * a Unix socket, NDJSON framing, the retention window, and the fail-open
 * client. `BusEnvelope` and friends stay exported under their bus names
 * so this PR's public API is unchanged.
 */
export type {
  EventEnvelope as BusEnvelope,
  EventFilter as BusFilter,
  EventInput as BusEventInput,
} from './events.ts'
export {
  eventMatches as busMatches,
  eventTopicMatches as busTopicMatches,
  isEventInput as isBusEventInput,
} from './events.ts'

/** A record the broker itself vouches for: inside the broker `gen` and
 *  `seq` always exist — the facade leaves `seq` optional only because
 *  other transports have no total order to offer. `gen` is the per-run
 *  token: a restart re-issues `seq` from 1, so a durable cursor is
 *  `{gen, seq}`, never seq alone — a foreign gen reads as a gap, not
 *  as a silent resume into the wrong seq space. */
export interface BusRecord extends EventEnvelope {
  gen: string
  seq: number
}

/** A cursor that survives broker restarts — taken from the last
 *  `BusRecord` seen. A bare `seq` stays legal as a run-local cursor
 *  (`--since` on the CLI), but only `{gen, seq}` cannot collide with
 *  the seq space a restarted broker hands out. */
export interface BusCursor {
  gen: string
  seq: number
}

/** A durable cursor is {gen, seq}: the gen pins it to one broker run, so
 *  a restart reads as a gap instead of colliding with a seq space that
 *  counts from 1 again. A bare number stays legal as a run-local cursor
 *  (--since on the CLI); absent or unparseable means "from now". */
function parseSince(raw: unknown, gen: string): number | 'now' | 'foreign' {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.floor(raw)
  }
  if (typeof raw === 'object' && raw !== null) {
    const cursor = raw as Partial<BusCursor>
    if (typeof cursor.gen === 'string' && typeof cursor.seq === 'number' && Number.isFinite(cursor.seq)) {
      return cursor.gen === gen ? Math.floor(cursor.seq) : 'foreign'
    }
  }
  return 'now'
}

/** `limit` bounds a catch-up replay inside the broker — a cursorless
 *  probe would otherwise serialize the whole retained ring through the
 *  socket before its own slice runs. */
function parseReplayLimit(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined
}
/** Bounded replay window. `since` is the caller's last seen seq.
 *
 *  Retention is part of the contract, not a follow-up: a window that is
 *  load-bearing for replay is also an unbounded liability, so it is
 *  bounded on three axes — count (`limit`), age (`ttlMs`) and bytes
 *  (`maxBytes`). All three make an event disappear, and every
 *  disappearance is a `gap`, never a silent hole. */
export class BusRing {
  private readonly limit: number
  private readonly ttlMs: number
  private readonly maxBytes: number
  private readonly buf: BusRecord[] = []
  private bytes = 0
  /** Highest seq ever dropped by a bound. An empty ring cannot tell
   *  "nothing was published" from "everything aged out", and answering
   *  the second with an empty list is the silent hole this contract
   *  forbids — so the drop watermark is what makes a cursor honest. */
  private evictedThrough = 0
  /** Highest seq this run ever issued. Distinct from `evictedThrough`:
   *  this one survives eviction, so a cursor past it can be recognised as
   *  "this broker run never issued it" rather than answered from an
   *  emptied ring. */
  private lastSeq = 0

  constructor(opts: { limit?: number; ttlMs?: number; maxBytes?: number } = {}) {
    const limit = opts.limit ?? BUS_RING_LIMIT
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`bus ring limit must be a positive integer, got ${String(limit)}`)
    }
    this.limit = limit
    this.ttlMs = opts.ttlMs ?? BUS_RING_TTL_MS
    this.maxBytes = opts.maxBytes ?? BUS_RING_MAX_BYTES
  }

  get size(): number {
    return this.buf.length
  }

  push(event: BusRecord, now: number): void {
    this.buf.push(event)
    this.bytes += busEventBytes(event)
    this.lastSeq = Math.max(this.lastSeq, event.seq)
    this.evict(now)
  }

  /** Drop whatever the bounds no longer admit. Always from the head:
   *  seq and `ts` both advance with the stream, so the head is always
   *  the oldest event and the loop terminates on all three axes. */
  private evict(now: number): void {
    while (this.buf.length > 0) {
      const oldest = this.buf[0]
      if (oldest === undefined) {
        return
      }
      const overCount = this.buf.length > this.limit
      const overBytes = this.bytes > this.maxBytes
      const expired = now - Date.parse(oldest.ts) > this.ttlMs
      if (!overCount && !overBytes && !expired) {
        return
      }
      this.buf.shift()
      this.bytes -= busEventBytes(oldest)
      this.evictedThrough = Math.max(this.evictedThrough, oldest.seq)
    }
  }

  /** Events after `since`, or null when they are unobtainable — the
   *  cursor predates the window (evicted or expired) or claims a seq this
   *  broker run never issued (it restarted, so seq counts from 1 again).
   *  Both mean the same thing to a consumer: re-derive from state. */
  since(since: number, now: number = Date.now()): BusRecord[] | null {
    this.evict(now)
    // The cursor wants events after `since`, so the first one it needs is
    // `since + 1`. If a bound has already dropped past that, the range is
    // gone and no answer can be honest.
    if (since < this.evictedThrough) {
      return null
    }
    // A cursor past anything this run ever issued cannot be served. Two
    // ways to get here, one answer: the broker restarted and counts from
    // 1 again, so an old cursor 2 against a ring holding seq 1 is a
    // collision, not "nothing new"; or the cursor is simply bogus. An
    // empty list would read as "you are caught up" and hide both.
    if (since > this.lastSeq) {
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
  filter: EventFilter
  sock: Socket
  dropped: boolean
}

export interface BusBrokerOptions {
  /** Retention bounds for the replay window — see `BusRing`. */
  ring?: { limit?: number; ttlMs?: number; maxBytes?: number }
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

export interface BusBroker {
  readonly socketPath: string
  /** Broker pid — a client that suspects a stale socket needs to know
   *  whether anything is actually behind it. */
  readonly pid: number
  /** This run's generation token — what makes a `{gen, seq}` cursor
   *  honest across restarts. */
  readonly gen: string
  /** Highest seq assigned so far — the cursor a fresh subscriber starts from. */
  readonly seq: number
  readonly subscriberCount: number
  close(): Promise<void>
}

/** What a connect attempt learned about the path. `live` — something
 *  answers; `stale` — a refused inode a SIGKILLed broker left behind,
 *  safe to unlink; `absent` — nothing there; `unknown` — a timeout or
 *  an error that proves nothing, which must never justify an unlink. */
type SocketProbe = 'live' | 'stale' | 'absent' | 'unknown'

/** Distinguishes a live broker from a stale inode a SIGKILLed one left
 *  behind — without it, bind fails EADDRINUSE forever and the bus can
 *  never restart. The errno is the verdict: ECONNREFUSED means the file
 *  exists and nothing listens; anything less certain stays put. */
function probeSocket(socketPath: string, timeoutMs: number): Promise<SocketProbe> {
  return new Promise<SocketProbe>((resolve) => {
    const sock = connect(socketPath)
    let settled = false
    const finish = (result: SocketProbe): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => finish('unknown'), timeoutMs)
    timer.unref?.()
    sock.once('connect', () => finish('live'))
    sock.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        finish('absent')
      } else if (err.code === 'ECONNREFUSED') {
        finish('stale')
      } else {
        finish('unknown')
      }
    })
  })
}

/** Fail closed unless `dir` is ours and unreachable by anyone else. The
 *  socket is the only thing between a local user and every event in the
 *  repository, so this is a precondition on the broker, not a nicety —
 *  and it is checked after the chmod, because that is the only thing that
 *  can have fixed it. */
function assertPrivateDir(dir: string): void {
  const uid = process.getuid?.()
  if (uid !== undefined && statSync(dir).uid !== uid) {
    throw new Error(`bro bus: ${dir} is not owned by this user`)
  }
  try {
    chmodSync(dir, 0o700)
  } catch {
    // reported by the mode check below
  }
  if ((statSync(dir).mode & 0o077) !== 0) {
    throw new Error(`bro bus: ${dir} is accessible to other users`)
  }
}

function sendFrame(sock: Socket, frame: unknown): void {
  let line: string
  try {
    line = JSON.stringify(frame)
  } catch {
    // A BigInt, a cycle, or anything else JSON cannot represent. These
    // are called from socket callbacks, where a throw is not a rejected
    // promise but an uncaught exception — the report says that takes the
    // broker down with it. An unrepresentable frame becomes an error
    // frame on the wire instead, which is the same fact, safely.
    line = JSON.stringify({ op: 'err', message: 'frame is not JSON-serializable' })
  }
  sock.write(`${line}\n`)
}

/** Start a broker on an explicit socket path. Path-taking rather than
 *  dir-taking so tests need no git repository; `startBusBroker` is the
 *  dir-shaped wrapper that also publishes discovery state. */
export async function startBusBrokerAt(
  socketPath: string,
  opts: BusBrokerOptions = {}
): Promise<BusBroker> {
  const ring = new BusRing(opts.ring ?? {})
  const now = opts.now ?? Date.now
  const subs = new Set<Subscriber>()
  // net.Server has no closeAllConnections (that is http.Server), so the
  // open peers are tracked explicitly — close() must not wait on a
  // subscriber that is itself waiting for events.
  const sockets = new Set<Socket>()
  let seq = 0
  // Per-run token: a restart re-issues seq from 1, so a bare-number
  // cursor could collide with a dead run's seq space and resume
  // silently mid-stream. A {gen, seq} cursor cannot.
  const gen = randomBytes(8).toString('hex')
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
    if (!isEventInput(input)) {
      sendFrame(sock, { op: 'err', message: 'pub needs event {topic, kind}' })
      return
    }
    seq += 1
    // The broker assigns order, so inside here a seq always exists —
    // the facade leaves it optional only because other transports have
    // no total order to offer.
    const envelope: BusRecord = {
      ...input,
      gen,
      seq,
      ts: new Date(now()).toISOString(),
    }
    ring.push(envelope, now())
    const out = { op: 'event', event: envelope }
    for (const s of subs) {
      if (eventMatches(s.filter, envelope)) {
        deliver(s, out)
      }
    }
    sendFrame(sock, { op: 'ack', seq })
  }

  const onSub = (sock: Socket, frame: Record<string, unknown>, sub: Subscriber | undefined): Subscriber => {
    const raw = frame['filter']
    const filter: EventFilter = typeof raw === 'object' && raw !== null ? (raw as EventFilter) : {}
    const since = parseSince(frame['since'], gen)
    const entry: Subscriber = sub ?? { filter, sock, dropped: false }
    entry.filter = filter
    subs.add(entry)
    let replay: BusRecord[] | null
    if (since === 'foreign') {
      replay = null
    } else {
      replay = ring.since(since === 'now' ? seq : since, now())
    }
    if (replay === null) {
      sendFrame(sock, { op: 'gap', seq })
      return entry
    }
    // The gap check is against the raw ring — a hole in the stream is a
    // hole whatever this subscriber cares about — but the events it is
    // handed still go through its filter, or replay would hand it topics
    // it never asked for.
    const matched = replay.filter((e) => eventMatches(entry.filter, e))
    // The omitted prefix is a hole, so a truncated catch-up reports as a
    // gap like any other loss.
    const limit = parseReplayLimit(frame['limit'])
    const kept = limit === undefined ? matched : matched.slice(-limit)
    if (kept.length < matched.length) {
      sendFrame(sock, { op: 'gap', seq })
    }
    // Replay obeys the same bound as live delivery: a client that cannot
    // drain the window is marked dropped, so its next event carries the
    // gap. Without this a reconnect could queue a whole 32 MiB ring on
    // the broker's event loop for one slow reader.
    for (const e of kept) {
      if (sock.writableLength > SLOW_CONSUMER_BYTES) {
        entry.dropped = true
        break
      }
      sendFrame(sock, { op: 'event', event: e })
    }
    return entry
  }

  const handleFrame = (sock: Socket, line: string, sub: Subscriber | undefined): Subscriber | undefined => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      sendFrame(sock, { op: 'err', message: 'malformed frame' })
      // end() only schedules a close — the 'close' handler that drops
      // the subscriber can trail a peer that never FINs back, so the
      // entry leaves the set here, not whenever the socket gets there.
      if (sub !== undefined) {
        subs.delete(sub)
      }
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

  const probe = await probeSocket(socketPath, 200)
  if (probe === 'live') {
    throw new Error(`bus already running on ${socketPath}`)
  }
  // A SIGKILLed broker leaves its socket inode behind: ECONNREFUSED is
  // the proof nothing listens, so unlinking it is the restart path, not
  // a collision. An undiagnosed socket (timeout, EACCES) stays put —
  // deleting a file whose owner cannot be read is worse than refusing
  // to start.
  if (probe === 'stale') {
    rmSync(socketPath, { force: true })
  } else if (probe === 'unknown' && existsSync(socketPath)) {
    throw new Error(`bus socket ${socketPath} is present but did not answer a probe — refusing to unlink it`)
  }
  // The socket lives in a shared dir, so it must be owner-only or another
  // local user could plant the name and receive every event. mkdir is
  // required — binding into a missing dir fails — so it is not
  // best-effort; `recursive` leaves an existing dir's mode alone, and a
  // chmod on a dir owned by somebody else fails, which is precisely the
  // case that must not be swallowed: an ignored failure here is a socket
  // any local user can replace and read the stream through.
  const socketDir = dirname(socketPath)
  mkdirSync(socketDir, { recursive: true, mode: 0o700 })
  assertPrivateDir(socketDir)
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
    gen,
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
  if (statePath === null) {
    return broker
  }
  const record = `${JSON.stringify(
    { socketPath, pid: process.pid, startedAt: new Date().toISOString() },
    null,
    2
  )}\n`
  try {
    // mkdir lives inside the guard too — its failure must not leave a
    // broker listening without discovery, same rule as the write
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, record, { mode: 0o600 })
  } catch (err) {
    // Discovery state is how a client finds the socket without
    // re-deriving the hash, so a broker nobody can find is worse than no
    // broker: it would hold the name, answer nothing, and look alive in
    // `bus status`. Take it back down and report why.
    await broker.close()
    throw err
  }
  return {
    socketPath,
    pid: process.pid,
    get gen(): string {
      return broker.gen
    },
    get seq(): number {
      return broker.seq
    },
    get subscriberCount(): number {
      return broker.subscriberCount
    },
    close: async () => {
      await broker.close()
      // Discovery must not outlive the broker it advertises — but a
      // replacement may already have rewritten the file, so unlink
      // only the record this broker wrote.
      try {
        if (readFileSync(statePath, 'utf8') === record) {
          rmSync(statePath, { force: true })
        }
      } catch {
        // a wedged state file is the next broker's stale-socket
        // problem, not a close() failure
      }
    },
  }
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
  event: EventInput,
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
  onEvent: (event: EventEnvelope) => void
  /** Cursor fell out of the replay window (or the broker restarted) —
   *  re-derive from state before trusting the next event. */
  onGap?: (seq: number) => void
  /** The broker went away and the stream ended. Without this a
   *  subscriber waits on a signal for a socket that can never deliver
   *  again, so a shutdown reads as silence rather than as an ending. */
  onClose?: () => void
}

export interface BusSubscription {
  close(): void
}

/** Subscribe. Unlike publish this throws on an unreachable broker: it is
 *  an explicit user action, and the fail-open boundary belongs at the
 *  call site (`busProbe`), not inside the transport. `since` is a bare
 *  seq within the current run or a `{gen, seq}` cursor from the last
 *  envelope seen — the only shape that cannot collide across a broker
 *  restart. `limit` bounds the catch-up replay broker-side; a truncated
 *  replay arrives preceded by a `gap` frame. */
export function busSubscribe(
  socketPath: string,
  filter: EventFilter,
  handlers: BusSubscriptionHandlers,
  opts: { since?: number | BusCursor; limit?: number; timeoutMs?: number } = {}
): Promise<BusSubscription> {
  const timeoutMs = opts.timeoutMs ?? BUS_TIMEOUT_MS
  return new Promise<BusSubscription>((resolve, reject) => {
    let settled = false
    // onClose reports the stream ended BY THE BROKER — a rejected
    // connect never had a stream to end, and a local close() was the
    // caller's own choice; neither should read as "the broker went away"
    let established = false
    let closedByUs = false
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
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      })
      if (settled) {
        return
      }
      settled = true
      established = true
      clearTimeout(timer)
      resolve({
        close: () => {
          closedByUs = true
          sock.destroy()
        },
      })
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
            handlers.onEvent(frame['event'] as EventEnvelope)
          } else if (frame['op'] === 'gap' && handlers.onGap !== undefined) {
            handlers.onGap(typeof frame['seq'] === 'number' ? frame['seq'] : 0)
          }
        }
        nl = buf.indexOf('\n')
      }
    })
    // The broker closing its end is the end of the stream, not a lull in
    // it. Fired once, and only on a remote close — a rejected connect
    // reports the rejection, a local close() was the caller's choice.
    sock.on('close', () => {
      if (established && !closedByUs) {
        handlers.onClose?.()
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
  events: EventEnvelope[]
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
  opts: { since?: number; windowMs?: number; limit?: number } = {}
): Promise<BusProbeResult> {
  const windowMs = opts.windowMs ?? BUS_PROBE_WINDOW_MS
  // One budget, spent once. The connect and the listen window are two
  // waits, and giving each the full window would let a probe take twice
  // the budget it advertises — on the hook path that ceiling is the
  // contract, so the deadline is taken before the connect and what is
  // left is what the listen gets.
  const deadline = Date.now() + windowMs
  const events: EventEnvelope[] = []
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
      // Probe asks "what happened while I was away", so it defaults to
      // catching up from the start of the ring — the opposite of a plain
      // `busSubscribe`, which is a live stream. The broker-side `limit`
      // is what keeps that catch-up from serializing the whole ring
      // through the socket inside the probe window.
      {
        since: opts.since ?? 0,
        ...(opts.since === undefined ? { limit: opts.limit ?? BUS_PROBE_LIMIT } : {}),
        timeoutMs: Math.max(1, deadline - Date.now()),
      }
    )
  } catch (err) {
    return { events, gapped, reason: brokerDownReason(err) }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
    timer.unref?.()
  })
  sub.close()
  // With no cursor the probe catches up from the start of the ring, and
  // an unbounded ring would hand a hook run thousands of lines. Keep the
  // newest slice and say so: `gapped` already means "you are not seeing
  // everything, re-derive", which is exactly what truncation is.
  const limit = opts.limit ?? BUS_PROBE_LIMIT
  if (opts.since === undefined && events.length > limit) {
    return { events: events.slice(-limit), gapped: true }
  }
  return { events, gapped }
}
