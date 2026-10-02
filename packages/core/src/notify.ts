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
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Connector } from './connectors.ts'
import { gitTry } from './git.ts'

/** The repo mailbox — `<git-common>/bro/notify`; null outside a repo. */
export function mailboxDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
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

/** Read+delete every pending drop — the filename sort is chronological
 *  (epoch-ms prefixes). Consumed on read: the first session whose
 *  postTool fires gets the event. An unreadable drop is left in place —
 *  a transient fs error shouldn't lose it. */
export function drainMailbox(dir: string): string[] {
  const out: string[] = []
  for (const mb of drainDirs(dir)) {
    let files: string[]
    try {
      files = readdirSync(mb)
        .filter((f) => f.endsWith('.txt') && !f.startsWith('.'))
        .sort()
    } catch {
      continue // no mailbox yet — nothing to drain
    }
    for (const f of files) {
      const path = join(mb, f)
      try {
        const text = readFileSync(path, 'utf8').trim()
        rmSync(path, { force: true })
        if (text !== '') {
          out.push(text)
        }
      } catch {
        // unreadable drop — skip; the next drain retries
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
