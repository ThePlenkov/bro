/**
 * Resolve ledger — the memory behind the act loop's reopened-thread
 * cycle-guard.
 *
 * A reopened thread is one that was resolved and then commented on
 * again. The act policy treats that as a hard stop: the earlier
 * resolution was wrong, and a blind re-resolve hides that, so the user
 * confirms instead.
 *
 * Observing the transition needs two facts: the thread is resolved NOW
 * and it was NOT resolved at some earlier point. The second fact is
 * only knowable if the resolve was recorded when it happened — the
 * host does not expose a resolve timestamp on a review thread (GitHub's
 * GraphQL has no `resolvedAt` on `ReviewThread`), and the act state
 * cache is not the place to look: its TTL is 30 seconds, so its entry
 * is deleted between polls and the "previous observation" is gone
 * before the next one arrives.
 *
 * So the resolve is recorded at the moment bro performs it. The
 * ledger is a JSONL file under the git common dir — the same place the
 * check-history ledger lives, and the same shared-dir semantics (a
 * linked worktree sees the same file, so a resolve recorded in one
 * checkout is visible in another).
 *
 * Fail-open throughout: no git dir, an unreadable file, or a torn line
 * reads as "no resolve recorded" — never a crash, never a false
 * block.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitCommonDir, withFileLock } from '@broject/core'
import { compactLedger, parseLedger } from './ledger.ts'

export interface ResolveEvent {
  /** Epoch ms — when the resolve happened. */
  ts: number
  /** owner/repo — the PR's repo. */
  repo: string
  /** PR number. */
  pr: number
  /** The thread id (host-native). */
  thread: string
}

export interface ResolveLedger {
  /** Record a resolve. Idempotent per (repo, pr, thread) inside one
   *  window — a repeated resolve of the same thread does not append a
   *  second line. */
  record(ev: Omit<ResolveEvent, 'ts'>): void
  /** Was this thread resolved before? True when any record for it
   *  exists. */
  wasResolved(repo: string, pr: number, thread: string): boolean
}

/** The ledger file — `<git-common>/bro/act-resolves.jsonl`. */
export function resolveLogPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  if (common === null) {
    return null
  }
  return join(common, 'bro', 'act-resolves.jsonl')
}

function parseEvents(file: string): ResolveEvent[] {
  return parseLedger(file, isResolveEvent)
}

/** A well-formed ledger row — every field present and of the right
 *  type. A malformed row is skipped, not fatal. */
function isResolveEvent(e: unknown): e is ResolveEvent {
  if (typeof e !== 'object' || e === null) {
    return false
  }
  const o = e as Partial<ResolveEvent>
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) {
    return false
  }
  if (typeof o.repo !== 'string' || typeof o.thread !== 'string') {
    return false
  }
  return typeof o.pr === 'number'
}

export function fileResolveLog(file: string): ResolveLedger {
  return {
    record(ev) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        const existing = parseEvents(file)
        const already = existing.some(
          (e) => e.repo === ev.repo && e.pr === ev.pr && e.thread === ev.thread
        )
        if (already) {
          return
        }
        const line = JSON.stringify({ ts: Date.now(), ...ev })
        withFileLock(
          `${file}.lock`,
          () => {
            appendFileSync(file, `${line}\n`, 'utf8')
          },
          { label: 'act-resolve-ledger' }
        )
        compactLedger(file)
      } catch {
        // recording is best-effort — a failed write means the reopen
        // is not detected, never a crash
      }
    },
    wasResolved(repo, pr, thread) {
      return parseEvents(file).some(
        (e) => e.repo === repo && e.pr === pr && e.thread === thread
      )
    },
  }
}

/** The ledger for a directory — null when there is no git dir (the
 *  caller then has no ledger and detects nothing). */
export function resolveLedger(dir: string): ResolveLedger | null {
  const file = resolveLogPath(dir)
  if (file === null) {
    return null
  }
  return fileResolveLog(file)
}
