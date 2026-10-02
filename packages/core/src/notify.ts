/**
 * Notify mailbox — the child→parent event plane (bro-d8zo). Writers
 * (`bro notify`, `bro watch --notify`, fixers, convoy sessions) drop one
 * atomic file per event; the notify connector's postTool probe drains
 * the mailbox and injects the lines into session context — real-time
 * events with no tokens spent waiting.
 *
 * Location: `<git-common-dir>/bro/notify/` inside a repo (shared across
 * linked worktrees — the common dir is the coordination plane),
 * `$XDG_STATE_HOME/bro/notify/` outside one.
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
 *  running outside any repo. */
export function userMailboxDir(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(base, 'bro', 'notify')
}

/** Where `bro notify` writes — the repo mailbox when there is one, the
 *  user-level mailbox otherwise. */
export function notifyDir(dir: string): string {
  return mailboxDir(dir) ?? userMailboxDir()
}

/** Every mailbox a session drains — the repo mailbox plus the
 *  user-level one (drops written outside a repo land there and still
 *  belong to whoever drains first). */
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

/** Epoch-ms embedded in a drop name (`<prefix>-<ms>-<rand>.txt`) — the
 *  chronological key a filename sort can't see: `note-*` sorts before
 *  `watch-*` regardless of drop time. */
const dropTime = (name: string): number =>
  Number(name.match(/-(\d+)-/)?.[1] ?? 0)

/** Claims older than this were abandoned by a crashed drainer — the drop
 *  was never delivered, so it goes back to the mailbox. */
const CLAIM_STALE_MS = 60_000

/** Hand drops abandoned mid-claim back to the mailbox — a `.claim` file
 *  older than CLAIM_STALE_MS means its drainer died between the atomic
 *  rename and the delete, and at-least-once demands the redelivery.
 *  Returns the restored drop names so the caller drains them now. */
function releaseStaleClaims(mb: string, names: string[]): string[] {
  const restored: string[] = []
  for (const f of names) {
    if (!f.startsWith('.') || !f.endsWith('.claim')) continue
    const claim = join(mb, f)
    try {
      if (Date.now() - statSync(claim).mtimeMs < CLAIM_STALE_MS) continue
      const orig = f.slice(1).replace(/\.[^.]+\.claim$/, '')
      renameSync(claim, join(mb, orig))
      restored.push(orig)
    } catch {
      // gone or unstat-able — a live drainer owns it
    }
  }
  return restored
}

/** Read+delete every pending drop, oldest first by embedded drop time.
 *  Each drop is claimed with an atomic rename before it's read — a
 *  concurrent drainer that loses the rename sees ENOENT and skips, so a
 *  drop can't be delivered twice. Consumed on read: the first session
 *  whose postTool fires gets the event. An unreadable drop is handed
 *  back under its original name — a transient fs error shouldn't lose
 *  it. */
export function drainMailbox(dir: string): string[] {
  const out: string[] = []
  for (const mb of drainDirs(dir)) {
    let files: string[]
    try {
      const names = readdirSync(mb)
      files = names
        .filter((f) => f.endsWith('.txt') && !f.startsWith('.'))
        .concat(releaseStaleClaims(mb, names))
        .sort((a, b) => dropTime(a) - dropTime(b) || (a < b ? -1 : a > b ? 1 : 0))
    } catch {
      continue // no mailbox yet — nothing to drain
    }
    for (const f of files) {
      const orig = join(mb, f)
      const claim = join(
        mb,
        `.${f}.${process.pid}-${randomBytes(4).toString('hex')}.claim`
      )
      try {
        renameSync(orig, claim)
      } catch {
        continue // claimed by a concurrent drainer — it owns the drop
      }
      try {
        const text = readFileSync(claim, 'utf8').trim()
        if (text !== '') {
          out.push(text)
        }
        // delete LAST — a crash between read and rm strands the claim;
        // releaseStaleClaims hands it back for redelivery (at-least-once)
        rmSync(claim, { force: true })
      } catch {
        // unreadable drop — hand it back so the next drain retries; a
        // failed restore strands the claim, released later as stale
        try {
          renameSync(claim, orig)
        } catch {
          // stranded claim — releaseStaleClaims recovers it
        }
      }
    }
  }
  return out
}

/** The notify connector — the read side of the mailbox. Its postTool
 *  probe drains pending drops into session context, so a child event
 *  reaches the parent mid-turn instead of waiting for a session-end
 *  summary. Probes are fail-open like every connector. */
export const notifyConnector: Connector = {
  name: 'notify',
  hooks: () => ({
    postTool(ctx) {
      try {
        const msgs = drainMailbox(ctx.dir)
        return msgs.length > 0
          ? [`bro notify — ${msgs.length} mailbox message(s):`, ...msgs]
          : []
      } catch {
        return []
      }
    },
  }),
}
