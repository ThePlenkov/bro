/** Advisory inter-process file locks (O_EXCL create — existence IS the
 *  lock). Serializes read-modify-write windows across bro processes:
 *  without one, two actors both read the pre-write state and the loser
 *  clobbers or double-allocates. Re-entrant per path inside a process so
 *  a locked section can reach for the same lock again. */
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Lock paths this process holds — makes withFileLock re-entrant: a
 *  locked critical section can call a helper that locks the same file
 *  without deadlocking on itself. */
const heldLocks = new Set<string>()

/** A crashed holder leaves the lock file behind — break it once it's
 *  older than any legit critical section (bd subprocess is the slowest
 *  at ≤15s). The wait bound must exceed that ceiling: a holder stuck on
 *  a slow-but-alive bd call (10–15s) must not fail its waiters. */
const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 20_000

const syncSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** One acquisition attempt — true when the lock is ours. On EEXIST a
 *  stale lock (crashed holder) is broken so the next retry can take it.
 *  The file carries the caller's token: existence is the lock, the token
 *  is the ownership proof release() checks before removing it. */
const tryAcquireLockFile = (lock: string, token: string, staleMs: number): boolean => {
  try {
    const fd = openSync(lock, 'wx')
    try {
      writeSync(fd, token)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err
    }
  }
  try {
    // ownership-checked stale break — read the holder token FIRST, then
    // prove stale AND unchanged. A contender that already replaced the
    // file shows a fresh mtime or a different token — either way the
    // delete is skipped instead of robbing its fresh lock.
    const holder = readFileSync(lock, 'utf8')
    if (Date.now() - statSync(lock).mtimeMs > staleMs && readFileSync(lock, 'utf8') === holder) {
      rmSync(lock, { force: true })
    }
  } catch {
    // raced removal or a stat flake — the retry decides
  }
  return false
}

export interface FileLockOptions {
  /** Break a lock older than this (crashed holder). Default 60s —
   *  must exceed the longest legit critical section. */
  staleMs?: number
  /** Give up waiting after this — the holder is alive but slow.
   *  Default 20s. */
  waitMs?: number
  /** Names the lock in the timeout error — 'agents.json lock' style. */
  label?: string
}

/** Advisory inter-process lock on `lock` (O_EXCL create — existence IS
 *  the lock). Returns the release; throws when a live holder outlasts
 *  waitMs. Re-entrant per path — a second acquire while held is a no-op
 *  release. */
export function acquireFileLock(lock: string, opts: FileLockOptions = {}): () => void {
  const { staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS, label = 'file lock' } = opts
  mkdirSync(dirname(lock), { recursive: true })
  if (heldLocks.has(lock)) {
    return () => {} // re-entrant — the outer section owns it
  }
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`
  const deadline = Date.now() + waitMs
  while (!tryAcquireLockFile(lock, token, staleMs)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} held over ${waitMs / 1000}s`)
    }
    syncSleep(25)
  }
  heldLocks.add(lock)
  return () => {
    heldLocks.delete(lock)
    try {
      // a section that overran the stale window may have been broken and
      // re-acquired by a contender — remove the file only while it still
      // carries OUR token, or release would drop the new holder's lock
      if (readFileSync(lock, 'utf8') === token) {
        rmSync(lock, { force: true })
      }
    } catch {
      // lock already gone — the desired end state
    }
  }
}

/** Run `fn` under the lock. Sync-only on purpose — an async fn would
 *  release-and-reattach semantics nobody needs here. */
export function withFileLock<T>(lock: string, fn: () => T, opts: FileLockOptions = {}): T {
  const release = acquireFileLock(lock, opts)
  try {
    return fn()
  } finally {
    release()
  }
}
