/** Advisory inter-process file locks (O_EXCL create — existence IS the
 *  lock). Serializes read-modify-write windows across bro processes:
 *  without one, two actors both read the pre-write state and the loser
 *  clobbers or double-allocates. Re-entrant per path inside a process so
 *  a locked section can reach for the same lock again. */
import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pidAlive } from './proc.ts'

/** Lock paths → ownership tokens this process holds — makes
 *  acquireFileLock re-entrant (a locked section can call a helper that
 *  locks the same file without deadlocking on itself) and gives the
 *  exit hook the ownership proof it needs. */
const heldLocks = new Map<string, string>()

/** A holder that outlives this is robbed even while alive — caps the
 *  pid-recycled-onto-an-unrelated-process case. Inside the bound a LIVE
 *  holder is never robbed: a slow-but-alive section (gascity's
 *  multi-minute spawn is the longest legit hold) fails its waiters
 *  instead of being raced. A dead holder's lock is stolen
 *  immediately — liveness is the staleness signal, not age. */
const LOCK_ABANDONED_MS = 15 * 60_000
const LOCK_WAIT_MS = 20_000
/** Sweep floor for crashed staged-token leftovers — a fresh sibling
 *  could belong to an in-flight acquirer; an old one can't. */
const LOCK_STALE_MS = 60_000

const syncSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Holder liveness via the shared probe (proc.ts) — kill(0)/EPERM plus
 *  the zombie state byte, so an unreaped dead holder can't hold a lock
 *  forever. Unparseable/absent pids count as dead: a token without a
 *  pid can't prove its holder lives. */

/** Is the lock instance AT `path` a stealable hold? A dead owner is
 *  stolen at once; a live one only past the abandoned bound. */
const lockStealable = (path: string): boolean => {
  let token: string
  let age: number
  try {
    token = readFileSync(path, 'utf8')
    age = Date.now() - statSync(path).mtimeMs
  } catch {
    return false // vanished or unreadable — can't prove dead, don't steal
  }
  return !pidAlive(Number(token.split(':')[0])) || age > LOCK_ABANDONED_MS
}

/** Capture-then-check removal: rename(2) grabs whatever instance sits
 *  at `lock` atomically, `verify` re-checks THAT instance — a fresh
 *  replacement swapped in mid-race is put back instead of unlinked.
 *  (A plain read-then-rm can delete a lock that was stolen-and-
 *  recreated between the check and the remove.) */
const removeCaptured = (lock: string, verify: (captured: string) => boolean): void => {
  const dest = `${lock}.cap-${process.pid}-${randomBytes(4).toString('hex')}`
  const drop = (): void => {
    try {
      rmSync(dest, { force: true })
    } catch {
      // best-effort — a cleanup I/O error must not mask the caller's
      // exception or abort the exit hook mid-release
    }
  }
  try {
    renameSync(lock, dest)
  } catch {
    return // already gone or renamed by a contender — the retry decides
  }
  let ok = false
  try {
    ok = verify(dest)
  } catch {
    // a verify that can't answer puts the instance back — fail-safe
  }
  if (ok) {
    drop()
    return
  }
  try {
    renameSync(dest, lock)
  } catch {
    drop() // a new lock already sits there — drop the captured
  }
}

/** Steal a held lock once its instance proves stale. The pre-check on
 *  `lock` keeps a live hold from ever being moved; the re-check inside
 *  removeCaptured re-proves the captured instance itself. */
const stealLock = (lock: string): void => {
  if (!lockStealable(lock)) {
    return
  }
  removeCaptured(lock, lockStealable)
}

/** Sweep crashed staged-token leftovers (`<lock>.<pid>.<rand>.tmp`). A
 *  hard kill between stage and link leaves one behind; stage→link is
 *  synchronous so a sibling older than the sweep floor is by definition
 *  a leftover — a fresh one could belong to an in-flight acquirer. */
const sweepStaged = (lock: string): void => {
  try {
    const dir = dirname(lock)
    const prefix = `${basename(lock)}.`
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.tmp')) {
        continue
      }
      const p = join(dir, f)
      try {
        if (Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS) {
          rmSync(p, { force: true })
        }
      } catch {
        // raced removal — fine
      }
    }
  } catch {
    // unreadable dir — the acquire attempts decide
  }
}

/** One acquisition attempt — true when the lock is ours. The token file
 *  is staged and link(2)'d into place atomically: an O_EXCL create would
 *  publish an EMPTY lock whose pid-less token reads as a dead owner — a
 *  concurrent acquirer could steal it before the first write landed.
 *  On EEXIST a provably stale hold is stolen so the next retry wins. */
const tryAcquireLockFile = (lock: string, token: string): boolean => {
  const staged = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(staged, token)
  try {
    linkSync(staged, lock)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err
    }
  } finally {
    rmSync(staged, { force: true })
  }
  try {
    stealLock(lock)
  } catch {
    // raced removal or a stat flake — the retry decides
  }
  return false
}

/** Drop `lock` only while it still carries `token` — the same
 *  capture-then-check as steal: a section whose hold was stolen and
 *  re-acquired by a contender must not unlink the new holder's lock. */
const releaseLock = (lock: string, token: string): void => {
  removeCaptured(lock, (captured) => {
    try {
      return readFileSync(captured, 'utf8') === token
    } catch {
      return false // unreadable instance — not provably ours, put it back
    }
  })
}

/** Release every lock this process still holds — called by the exit
 *  hook because process.exit() bypasses callers' finally blocks, and a
 *  stranded lock blocks every contender until a dead-owner steal. */
const releaseAll = (): void => {
  for (const [lock, token] of heldLocks) {
    releaseLock(lock, token)
  }
}

let exitHookArmed = false
const armExitHook = (): void => {
  if (exitHookArmed) {
    return
  }
  exitHookArmed = true
  process.on('exit', releaseAll)
}

/** A live holder outlasted the wait bound — distinct from acquisition
 *  failures (EACCES, EIO) so callers can name contention without
 *  mislabeling filesystem errors as a competing hold. */
export class LockTimeout extends Error {
  override name = 'LockTimeout'
}

export interface FileLockOptions {
  /** Give up waiting after this — the holder is alive but slow.
   *  Default 20s. */
  waitMs?: number
  /** Names the lock in the timeout error — 'agents.json lock' style. */
  label?: string
}

/** Advisory inter-process lock on `lock` (O_EXCL create — existence IS
 *  the lock). Returns the release; throws when a live holder outlasts
 *  waitMs. Re-entrant per path — a second acquire while held is a no-op
 *  release. Held locks are also dropped by an 'exit' hook, so a
 *  process.exit() inside the section can't strand the file. */
export function acquireFileLock(lock: string, opts: FileLockOptions = {}): () => void {
  const { waitMs = LOCK_WAIT_MS, label = 'file lock' } = opts
  // a NaN/negative deadline compares false forever — the wait would
  // never time out. Reject it instead of hanging.
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError(`${label}: waitMs must be a finite non-negative number — got ${waitMs}`)
  }
  mkdirSync(dirname(lock), { recursive: true })
  if (heldLocks.has(lock)) {
    return () => {} // re-entrant — the outer section owns it
  }
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`
  const deadline = Date.now() + waitMs
  sweepStaged(lock)
  while (!tryAcquireLockFile(lock, token)) {
    if (Date.now() >= deadline) {
      throw new LockTimeout(`${label} held over ${waitMs / 1000}s`)
    }
    syncSleep(25)
  }
  heldLocks.set(lock, token)
  armExitHook()
  return () => {
    heldLocks.delete(lock)
    releaseLock(lock, token)
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
