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

/** One drop: reap when expired, deliver into `out` when unseen. Drops
 *  stay on disk for other sessions until the TTL takes them, so a
 *  crash mid-drain loses nothing — the unwritten cursor redelivers. */
function drainDrop(
  mb: string,
  f: string,
  seen: Set<string>,
  out: string[],
  now: number
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
    seen.add(f)
    if (text.trim() !== '') {
      out.push(text)
    }
  } catch {
    // unreadable drop — skip; the next drain retries
  }
}

/** Drain one mailbox dir for a session, oldest-first by embedded drop
 *  time. Drops are injected verbatim — a heartbeat's formatting is
 *  part of the event. */
function drainDir(mb: string, sessionId: string, now: number): string[] {
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
    drainDrop(mb, f, seen, out, now)
  }
  writeSeen(cursor, seen, files)
  pruneStaleCursors(mb, files, now)
  return out
}

/** Every pending drop this session hasn't seen, oldest-first by the
 *  embedded drop time. Seen drops stay for other sessions until they
 *  expire; a drop is deleted once it is older than DROP_TTL_MS,
 *  delivered or not. */
export function drainMailbox(dir: string, sessionId: string): string[] {
  const now = Date.now()
  return drainDirs(dir).flatMap((mb) => drainDir(mb, sessionId, now))
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
        const msgs = drainMailbox(ctx.dir, ctx.sessionId ?? '')
        return msgs.length > 0
          ? [`bro notify — ${msgs.length} mailbox message(s):`, ...msgs]
          : []
      } catch {
        return []
      }
    },
  }),
}
