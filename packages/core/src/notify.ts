/**
 * Notify mailbox — the child→parent event plane (bro-d8zo). Writers
 * (`bro notify`, `bro watch --notify`, fixers, convoy sessions) drop one
 * atomic file per event; the notify connector's postTool probe drains
 * the mailbox and injects the drops into session context — real-time
 * events with no tokens spent waiting.
 *
 * Location: `<git-common-dir>/bro/notify/` inside a repo (shared across
 * linked worktrees — the common dir is the coordination plane), the XDG
 * state dir (`$XDG_STATE_HOME`, default `~/.local/state`) outside one.
 *
 * Delivery is broadcast, not first-consumer-wins: each session carries
 * a `.seen-<session>` cursor in the mailbox, so a drop reaches every
 * live session exactly once — the writer's own postTool echoing it back
 * cannot eat it before the parent sees it. Drops expire after
 * DROP_TTL_MS and cursors after SEEN_TTL_MS.
 */
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Connector } from './connectors.ts'
import {
  isEventInput,
  type EventEnvelope,
  type EventInput,
} from './events.ts'
import { gitTry } from './git.ts'

/** The repo mailbox — `<git-common>/bro/notify`; null outside a repo. */
export function mailboxDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  let common = r.code === 0 ? r.out.trim() : ''
  if (common === '') {
    // git <2.31 has no --path-format — resolve the possibly-relative
    // common dir against `dir` instead of failing detection outright
    const rel = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
    common = rel.code === 0 && rel.out.trim() !== '' ? resolve(dir, rel.out.trim()) : ''
  }
  return common === '' ? null : join(common, 'bro', 'notify')
}

/** The user-level mailbox — the "(or XDG state)" fallback for writers
 *  running outside any repo. An *empty* XDG_STATE_HOME is unset, not a
 *  path — `||` not `??`. */
export function userMailboxDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'bro', 'notify')
}

/** Where `bro notify` writes — the repo mailbox when there is one, the
 *  user-level mailbox otherwise. */
export function notifyDir(dir: string): string {
  return mailboxDir(dir) ?? userMailboxDir()
}

/** Every mailbox a session drains — the repo mailbox plus the
 *  user-level one (drops written outside a repo land there and still
 *  belong to whoever is live to see them). */
export function drainDirs(dir: string): string[] {
  return [...new Set([mailboxDir(dir), userMailboxDir()])].filter(
    (d): d is string => d !== null
  )
}

/** One atomic mailbox drop — tmp+rename so a draining reader never sees
 *  a half-written event. `prefix` namespaces the file (`watch-`, `note-`)
 *  so the filename says which writer produced it. Returns the dropped
 *  file's path. */
export function dropMailbox(dir: string, text: string, prefix: string): string {
  mkdirSync(dir, { recursive: true })
  const name = `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.txt`
  const tmp = join(dir, `.${name}.tmp`)
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, join(dir, name))
  } catch (err) {
    // a failed rename strands the tmp file — remove it so retries
    // don't accumulate debris in the mailbox
    rmSync(tmp, { force: true })
    throw err
  }
  return join(dir, name)
}

/** What a verbatim mailbox drop is: a `notify` note. The write side
 *  only stores plain text for exactly that event, and a foreign file
 *  in the notify dir is a notify drop by definition — decoding it as
 *  a 'mailbox' topic would lose the identity the publisher chose and
 *  hide the drop from every `topics: ['notify']` subscription. */
const MAILBOX_TOPIC = 'notify'
const MAILBOX_KIND = 'note'

/**
 * The mailbox text for an event. A plain note is written verbatim, because
 * drops are injected as-is and a heartbeat's formatting is part of the
 * event — that is `bro notify` today and its bytes must not move.
 * Anything with identity beyond topic/kind is JSON, or the
 * topic would be dropped on the floor and the event could never be
 * filtered on the way back out.
 */
export function mailboxText(event: EventInput): string {
  const plainNote =
    event.topic === 'notify' &&
    event.kind === 'note' &&
    event.key === undefined &&
    event.to === undefined &&
    event.cause === undefined &&
    event.ref === undefined &&
    event.source === undefined
  // A verbatim note whose text parses as an event would come back out of
  // the drain as that event — a different topic and a lost payload — so
  // JSON-shaped notes go through the envelope like everything else.
  if (plainNote && typeof event.payload === 'string' && parseEvent(event.payload) === undefined) {
    return event.payload
  }
  return JSON.stringify(event)
}

/** The one place a drop's text is asked "are you an event?" — shared by
 *  the write side (to keep raw notes distinguishable), the drain side
 *  (addressing checks the envelope), and coalescing (superseded drops
 *  are found by key). */
export function parseEvent(text: string): EventInput | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) {
    return undefined
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isEventInput(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Drops are text — a drain recovers only what the writer encoded. A
 *  verbatim drop is reported as the notify note it was published as; a
 *  JSON drop is parsed back into the exact event. */
export function mailboxEvent(text: string, locator: string | undefined): EventEnvelope {
  const parsed = parseEvent(text)
  if (parsed !== undefined) {
    return {
      ...parsed,
      ts: new Date().toISOString(),
      ...(locator !== undefined ? { locator } : {}),
    }
  }
  return {
    topic: MAILBOX_TOPIC,
    kind: MAILBOX_KIND,
    payload: text,
    ts: new Date().toISOString(),
    ...(locator !== undefined ? { locator } : {}),
  }
}

/** A drop older than this is residue, not an event — a session that
 *  was idle past the TTL never sees it. */
export const DROP_TTL_MS = 60 * 60 * 1000

/** Session cursors outlive drops — pruned on the marker TTL scale. */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Drops one session has already been shown — a newline list of drop
 *  names in `.seen-<sid>` inside the mailbox dir. The cursor is
 *  rewritten to only the names that still exist, so it self-limits. */
function seenPath(mb: string, sessionId: string): string {
  const sid = sessionId.replace(/[^\w.-]/g, '_') || 'unknown'
  return join(mb, `.seen-${sid}`)
}

/** Epoch-ms embedded in a drop name (`<prefix>-<ms>-<rand>.txt`) — the
 *  chronological key a filename sort can't see: `note-*` sorts before
 *  `watch-*` regardless of drop time. */
const dropTime = (name: string): number =>
  Number(/-(\d+)-/.exec(name)?.[1] ?? 0)

/** The session's `.seen` cursor — absent or unreadable means first
 *  drain, everything is new. */
function readSeen(cursor: string): Set<string> {
  try {
    return new Set(readFileSync(cursor, 'utf8').split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

/** Persist the cursor pruned to names still on disk — a failed write
 *  just re-delivers next drain (fail-open). */
function writeSeen(cursor: string, seen: Set<string>, files: string[]): void {
  try {
    writeFileSync(cursor, [...seen].filter((f) => files.includes(f)).join('\n'))
  } catch {
    // best-effort
  }
}

/** Dead sessions leave cursors behind — prune them like hook markers. */
function pruneStaleCursors(mb: string, files: string[], now: number): void {
  for (const f of files.filter((f) => f.startsWith('.seen-'))) {
    try {
      if (now - statSync(join(mb, f)).mtimeMs > SEEN_TTL_MS) {
        rmSync(join(mb, f), { force: true })
      }
    } catch {
      // best-effort
    }
  }
}

/** Who is draining. A consumer's addresses: its session id (always
 *  known on the hook path), its `BRO_AGENT_ID` (spawned workers carry
 *  it — interactive sessions don't), and the reserved role
 *  `orchestrator`, which a session with no agentId answers to — that
 *  is the session a spawned child reports to. */
export interface MailboxIdentity {
  sessionId?: string
  agentId?: string
}

/** The env-derived half of the identity — spawned workers pin
 *  BRO_AGENT_ID at spawn; a session without it drains as an
 *  orchestrator. */
export function mailboxIdentity(sessionId?: string): MailboxIdentity {
  const agentId = process.env.BRO_AGENT_ID
  return { sessionId, agentId: agentId === undefined || agentId === '' ? undefined : agentId }
}

/** `to` names exactly one recipient: an agentId, a sessionId, or the
 *  `orchestrator` role. Anything else is broadcast. */
function addressedTo(to: string, identity: MailboxIdentity): boolean {
  if (identity.agentId !== undefined && to === identity.agentId) {
    return true
  }
  if (identity.sessionId !== undefined && to === identity.sessionId) {
    return true
  }
  return to === 'orchestrator' && identity.agentId === undefined
}

/** Coalescing (bro-22jd): pending drops carrying the same
 *  {key, source, topic, to} are superseded — the writer that repeats a
 *  key has fresher news. The identity is EXACT equality: a same-key
 *  drop on another topic, to another recipient (or broadcast where the
 *  pending drop was addressed), or from a different source is an
 *  independent note — a keyed publish must never delete a drop it does
 *  not replace. */
export function coalesceDrops(
  dir: string,
  key: string,
  identity: { source?: string; topic: string; to?: string }
): void {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return
  }
  for (const f of files.filter((f) => f.endsWith('.txt') && !f.startsWith('.'))) {
    const path = join(dir, f)
    try {
      const ev = parseEvent(readFileSync(path, 'utf8'))
      if (
        ev !== undefined &&
        ev.key === key &&
        ev.source === identity.source &&
        ev.topic === identity.topic &&
        ev.to === identity.to
      ) {
        rmSync(path, { force: true })
      }
    } catch {
      // unreadable drop — leave it; TTL is the sweeper of last resort
    }
  }
}

/** The context line for a drained drop — typed envelopes render their
 *  addressing (`[ask fixer-7 → orchestrator] …`), plain notes stay
 *  verbatim (a heartbeat's formatting is part of the event). `kind` is
 *  a label, never a grant — a `block` or `ask` carries no authority. */
export function renderDrop(text: string): string {
  const ev = parseEvent(text)
  if (ev === undefined || typeof ev.payload !== 'string') {
    return text
  }
  const kind = ev.kind === MAILBOX_KIND ? '' : `${ev.kind} `
  const route =
    ev.source === undefined && ev.to === undefined
      ? ''
      : `${ev.source ?? 'unknown'}${ev.to === undefined ? '' : ` → ${ev.to}`}`
  const re = ev.cause === undefined ? '' : ` ↳${ev.cause}`
  const head = kind + route
  return head === '' ? ev.payload : `[${head}] ${ev.payload}${re}`
}

/** Drain options — `keep` selects which drops count as seen; `for` is
 *  the consumer's identity for `to`-addressed drops. */
export interface DrainOpts {
  keep?: (text: string) => boolean
  for?: MailboxIdentity
}

/** One drop: reap when expired, deliver into `out` when unseen,
 *  addressed-to-us, and wanted. `keep` is the drain-side filter — a
 *  drop it rejects is left unseen, so a filtered consumer cannot eat
 *  drops a later, different consumer was due (they expire on TTL like
 *  any other residue). An addressed drop expires *on read* by its
 *  recipient — single-consumer, not broadcast. Broadcast drops stay
 *  for other sessions until the TTL takes them, so a crash mid-drain
 *  loses nothing — the unwritten cursor redelivers. */
function drainDrop(
  mb: string,
  f: string,
  seen: Set<string>,
  out: string[],
  now: number,
  opts?: DrainOpts
): void {
  const path = join(mb, f)
  try {
    if (now - statSync(path).mtimeMs > DROP_TTL_MS) {
      rmSync(path, { force: true }) // expired — reap, never deliver
      return
    }
    if (seen.has(f)) {
      return
    }
    const text = readFileSync(path, 'utf8')
    if (text.trim() === '') {
      seen.add(f) // an empty drop is noise, not an event — consume it
      return
    }
    const ev = parseEvent(text)
    const addressed = typeof ev?.to === 'string' && ev.to !== ''
    if (addressed && !addressedTo(ev!.to!, opts?.for ?? {})) {
      return // not ours — stays pending for the addressed consumer
    }
    if (opts?.keep !== undefined && !opts.keep(text)) {
      return
    }
    seen.add(f)
    out.push(text)
    if (addressed) {
      // expire-after-read: an addressed drop is single-consumer, the
      // delivered copy is the only copy
      rmSync(path, { force: true })
    }
  } catch {
    // unreadable drop — skip; the next drain retries
  }
}

/** Drain one mailbox dir for a session, oldest-first by embedded drop
 *  time. Drops are injected verbatim — a heartbeat's formatting is
 *  part of the event. */
function drainDir(mb: string, sessionId: string, now: number, opts?: DrainOpts): string[] {
  let files: string[]
  try {
    files = readdirSync(mb)
  } catch {
    return [] // no mailbox yet — nothing to drain
  }
  const cursor = seenPath(mb, sessionId)
  const seen = readSeen(cursor)
  const out: string[] = []
  for (const f of files
    .filter((f) => f.endsWith('.txt') && !f.startsWith('.'))
    .sort((a, b) => dropTime(a) - dropTime(b) || a.localeCompare(b))) {
    drainDrop(mb, f, seen, out, now, opts)
  }
  writeSeen(cursor, seen, files)
  pruneStaleCursors(mb, files, now)
  return out
}

/** Every pending drop this session hasn't seen, oldest-first by the
 *  embedded drop time. `opts.keep` selects which drops count as seen —
 *  a rejected drop stays pending for this session's later drains.
 *  `opts.for` is the consumer's identity: drops `to` another address
 *  stay pending, drops `to` this consumer delete on delivery. */
export function drainMailbox(
  dir: string,
  sessionId: string,
  opts?: DrainOpts
): string[] {
  const now = Date.now()
  return drainDirs(dir).flatMap((mb) => drainDir(mb, sessionId, now, opts))
}

/** The notify connector — the read side of the mailbox. Its postTool
 *  probe delivers unseen drops into session context, so a child event
 *  reaches the session mid-turn instead of waiting for a session-end
 *  summary. Probes are fail-open like every connector. */
export const notifyConnector: Connector = {
  name: 'notify',
  hooks: () => ({
    postTool(ctx) {
      try {
        const msgs = drainMailbox(ctx.dir, ctx.sessionId ?? '', {
          for: mailboxIdentity(ctx.sessionId),
        }).map(renderDrop)
        return msgs.length > 0
          ? [`bro notify — ${msgs.length} mailbox message(s):`, ...msgs]
          : []
      } catch {
        return []
      }
    },
  }),
}
