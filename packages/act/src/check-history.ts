/**
 * Check-history ledger — the consecutive-failure memory behind
 * conditional `act.ignoreChecks` (bro-8xv6). Each `fetchPrActState`
 * appends one `{ts, repo, pr, sha, name, bucket}` line per ignored
 * check to `<git-common-dir>/bro/act-checks.jsonl`; the common dir
 * shares the ledger across linked worktrees, and a same
 * name+sha+bucket repeat is not re-appended so `act wait` polling
 * doesn't grow it.
 *
 * `consecutiveFailures(name)` counts the trailing run of 'fail'
 * buckets over DISTINCT head shas — pushes that failed, not polls that
 * observed one. Reviewer health is repo-global, so the streak crosses
 * PR boundaries (file order is temporal).
 *
 * Fail-open throughout: no git dir, unreadable or unwritable file —
 * the history reads as empty (streak 0) and records as a no-op, so a
 * failing conditional check trends to "unproven", never to a crash.
 */
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gitTry, withFileLock } from '@broject/core'

export interface CheckObservation {
  ts: number
  repo: string
  pr: number
  sha: string
  name: string
  bucket: string
}

export interface CheckHistory {
  /** Append an observation — consecutive repeats of the same
   *  name+sha+bucket collapse, so a long `act wait` poll costs one
   *  line per head, not one per tick. */
  record(obs: Omit<CheckObservation, 'ts'>): void
  /** Trailing run of consecutive 'fail' buckets over distinct shas for
   *  this check name (case-insensitive) — 0 on empty/absent history. */
  consecutiveFailures(name: string): number
}

/** Keep the ledger bounded — one transition per push per check grows
 *  slowly, but a wedged tool could still spam it. Compaction keeps the
 *  tail, which is all a trailing-streak read needs anyway. */
const MAX_LEDGER_BYTES = 256 * 1024
const KEEP_LEDGER_BYTES = 128 * 1024

function parseEntries(file: string): CheckObservation[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: CheckObservation[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      const e = JSON.parse(line) as Partial<CheckObservation>
      if (
        typeof e.name === 'string' &&
        typeof e.sha === 'string' &&
        typeof e.bucket === 'string' &&
        typeof e.ts === 'number' &&
        Number.isFinite(e.ts)
      ) {
        out.push(e as CheckObservation)
      }
    } catch {
      // a torn line (crash mid-append) is skipped, not fatal
    }
  }
  return out
}

/** Truncate to the newest whole lines once the file outgrows the cap —
 *  tmp+rename so a reader never sees a half-written ledger. */
function compactIfNeeded(file: string): void {
  try {
    if (statSync(file).size <= MAX_LEDGER_BYTES) {
      return
    }
    const raw = readFileSync(file, 'utf8')
    const tail = raw.slice(raw.length - KEEP_LEDGER_BYTES)
    const cut = tail.indexOf('\n')
    writeFileSync(`${file}.tmp`, cut >= 0 ? tail.slice(cut + 1) : tail)
    renameSync(`${file}.tmp`, file)
  } catch {
    // compaction is housekeeping — a failure never blocks the record
  }
}

export function fileCheckHistory(file: string): CheckHistory {
  const read = (): CheckObservation[] => parseEntries(file)
  return {
    record(obs) {
      try {
        // dedup-check + compact + append is one read-modify-write —
        // concurrent `act`/`watch` processes on the shared ledger must
        // serialize it or the loser drops observations
        withFileLock(
          `${file}.lock`,
          () => {
            const entries = read()
            const last = [...entries].reverse().find((e) => e.name === obs.name)
            if (last !== undefined && last.sha === obs.sha && last.bucket === obs.bucket) {
              return
            }
            compactIfNeeded(file)
            appendFileSync(file, `${JSON.stringify({ ...obs, ts: Date.now() })}\n`)
          },
          { waitMs: 2000, label: 'act-checks ledger' }
        )
      } catch {
        // an unwritable ledger is an empty ledger — recording never throws
      }
    },
    consecutiveFailures(name) {
      const lower = name.toLowerCase()
      const entries = read().filter((e) => e.name.toLowerCase() === lower)
      let streak = 0
      const seen = new Set<string>()
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i]!
        // a re-observed sha is one check run, not a new failure —
        // collapse repeats so streak counts heads, not polls. Entries
        // for a sha can be non-adjacent when PRs interleave, so every
        // counted sha is tracked, not just the previous one
        if (seen.has(e.sha)) {
          continue
        }
        if (e.bucket !== 'fail') {
          break
        }
        streak += 1
        seen.add(e.sha)
      }
      return streak
    },
  }
}

/** The repo ledger — `<git-common-dir>/bro/act-checks.jsonl`; null
 *  outside a repo (callers treat absent history as streak 0). */
export function checkHistoryPath(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  let common = r.code === 0 ? r.out.trim() : ''
  if (common === '') {
    // git <2.31 has no --path-format — resolve the possibly-relative
    // common dir against `dir` instead of failing outright
    const rel = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
    common = rel.code === 0 && rel.out.trim() !== '' ? resolve(dir, rel.out.trim()) : ''
  }
  return common === '' ? null : join(common, 'bro', 'act-checks.jsonl')
}

export function checkHistory(dir: string): CheckHistory | null {
  const file = checkHistoryPath(dir)
  return file === null ? null : fileCheckHistory(file)
}
