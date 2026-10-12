/**
 * Shared gate-state feed — one file-cached PrActState per PR that
 * every poller (loop, watch, drive, act wait, hook probes) reads
 * instead of each paying fetchPrActState's 5-7 host calls per pass
 * (bro-0tcrl). Entries live in `<git-common-dir>/bro/act-state/
 * <repo>-<pr>.json` — the common dir, so linked worktrees and every
 * bro process share them, same as the act-checks ledger and the
 * watch markers.
 *
 * Observe-only by contract: a read is at most `ttlMs` old, so the
 * callers that take it are pollers; decision points (act merge's
 * pre-merge gate, stack merge, drive's post-merge re-probe) never
 * pass a cache — they fetch the state they are about to act on.
 * Mutations (resolve/reply/merge/update-branch, webhook events)
 * invalidate so the next poll sees the change, not the cap.
 *
 * Fail-open throughout: no git dir, unreadable dir, corrupt file —
 * every read is a miss and every write a no-op. The cache is host-call
 * reduction, never a gate of its own.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { acquireFileLock, gitCommonDir, type PrTarget } from '@broject/core'
import type { PrActState } from './types.ts'

/** Under every poll interval (act wait/watch ~60s, drive ~300s): a
 *  lone poller still fetches each pass — the TTL only merges
 *  *overlapping* pollers into one fetch per window. */
export const ACT_STATE_TTL_MS = 30_000
/** How long a contender waits on a peer's in-flight fetch before
 *  fetching itself — roughly one fetch's duration. */
export const ACT_STATE_LOCK_WAIT_MS = 15_000
/** Entries past this are reaped on write — a settled PR's last state
 *  would otherwise sit in the dir forever. */
const STALE_MS = 6 * 3600_000

export interface PrStateCache {
  /** A fresh cached state — null on miss, expiry, corruption, or a
   *  read failure. */
  read(target: PrTarget): PrActState | null
  /** Atomic publish (tmp write + rename); reaps stale siblings so a
   *  long-lived fleet dir stays bounded. */
  write(target: PrTarget, state: PrActState): void
  /** Drop one target's entry — under its fetch lock where possible so
   *  an in-flight fetch's late write can't resurrect pre-mutation
   *  state. */
  invalidate(target: PrTarget): void
  /** Drop every entry — thread mutations arrive by thread id with no
   *  PR attached, so their invalidation is the whole dir. */
  invalidateAll(): void
  /** The read→fetch→write critical section for `target` — contenders
   *  that can't take it inside `waitMs` get null and proceed uncached:
   *  the lock is fetch dedup, never a gate of its own. */
  acquire(target: PrTarget, waitMs?: number): (() => void) | null
}

interface CacheRecord {
  fetchedAt: number
  state: PrActState
}

function fileFor(root: string, t: PrTarget): string {
  const slug = t.repo.replace(/[^A-Za-z0-9._-]+/g, '-')
  return join(root, `${slug}-${t.pr}.json`)
}

function drop(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    // raced removal — nothing to drop
  }
}

/** Settled-PR garbage: entries whose mtime is past STALE_MS plus
 *  orphaned `*.tmp` writes the same age (a crash mid-publish). Runs
 *  inside a write — one readdir per publish keeps the dir bounded
 *  without a sweeper of its own. */
function sweep(root: string): void {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const f of names) {
    if (!f.endsWith('.json') && !f.endsWith('.tmp')) {
      continue
    }
    const p = join(root, f)
    try {
      if (Date.now() - statSync(p).mtimeMs > STALE_MS) {
        rmSync(p, { force: true })
      }
    } catch {
      // raced removal or a stat flake — the next write sweeps it
    }
  }
}

/** The repo-feed handle — `<git-common-dir>/bro/act-state`; null
 *  outside a repository (callers treat absent cache as "fetch every
 *  time", exactly like no cache passed). */
export function prStateCache(
  dir: string,
  opts?: { ttlMs?: number; lockWaitMs?: number }
): PrStateCache | null {
  const common = gitCommonDir(dir)
  if (common === null) {
    return null
  }
  const root = join(common, 'bro', 'act-state')
  const ttl = opts?.ttlMs ?? ACT_STATE_TTL_MS
  const lockWait = opts?.lockWaitMs ?? ACT_STATE_LOCK_WAIT_MS
  const acquire = (t: PrTarget, waitMs: number): (() => void) | null => {
    try {
      return acquireFileLock(`${fileFor(root, t)}.lock`, {
        waitMs,
        label: 'act-state fetch',
      })
    } catch {
      return null
    }
  }
  return {
    read(t) {
      const file = fileFor(root, t)
      try {
        const rec = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheRecord>
        if (
          typeof rec.fetchedAt !== 'number' ||
          !Number.isFinite(rec.fetchedAt) ||
          rec.state?.pr !== t.pr
        ) {
          return null
        }
        if (Date.now() - rec.fetchedAt > ttl) {
          drop(file)
          return null
        }
        return rec.state
      } catch {
        return null
      }
    },
    write(t, state) {
      try {
        mkdirSync(root, { recursive: true })
        const file = fileFor(root, t)
        writeFileSync(`${file}.tmp`, JSON.stringify({ fetchedAt: Date.now(), state }))
        renameSync(`${file}.tmp`, file)
        sweep(root)
      } catch {
        // an unwritable feed is an empty feed — publishing never throws
      }
    },
    invalidate(t) {
      const file = fileFor(root, t)
      // ordering vs an in-flight write is the lock's job — a timeout
      // still drops the OLD entry; a late-arriving stale write is
      // bounded by the ttl like any other
      const release = acquire(t, lockWait)
      try {
        drop(file)
      } finally {
        release?.()
      }
    },
    invalidateAll() {
      let names: string[]
      try {
        names = readdirSync(root)
      } catch {
        return
      }
      for (const f of names) {
        if (f.endsWith('.json')) {
          drop(join(root, f))
        }
      }
    },
    acquire(t, waitMs = lockWait) {
      return acquire(t, waitMs)
    },
  }
}
