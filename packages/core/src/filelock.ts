/** Advisory inter-process file locks (O_EXCL create — existence IS the
 *  lock). Serializes read-modify-write windows across bro processes:
 *  without one, two actors both read the pre-write state and the loser
 *  clobbers or double-allocates. Re-entrant per path inside a process so
 *  a locked section can reach for the same lock again. */
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Lock paths → ownership tokens this process holds — makes
 *  acquireFileLock re-entrant (a locked section can call a helper that
 *  locks the same file without deadlocking on itself) and gives the
 *  exit hook the ownership proof it needs. */
const heldLocks = new Map<string, string>()

/** A holder that outlives this is robbed even while alive — caps the
 *  pid-recycled-onto-an-unrelated-process case. Inside the bound a LIVE
 *  holder is never robbed: a slow-but-alive section fails its waiters
 *  (timeout), it is never raced. A dead holder's lock is stolen
 *  immediately — liveness is the staleness signal, not age. */
const LOCK_ABANDONED_MS = 10 * 60_000
const LOCK_WAIT_MS = 20_000

const syncSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** kill(pid, 0) as liveness probe — EPERM means alive under another
 *  user. Unparseable/absent pids count as dead: a token without a pid
 *  can't prove its holder lives. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Is `token` (the lock file's current content) a stealable hold? A
 *  dead owner is stolen at once; a live one only past the abandoned
 *  bound. Re-reading the file before rm keeps a fresh replacement safe. */
const lockStealable = (lock: string, token: string): boolean => {
  let age: number
  try {
    age = Date.now() - statSync(lock).mtimeMs
  } catch {
    return false // vanished — the next create attempt wins
  }
  return !pidAlive(Number(token.split(':')[0])) || age > LOCK_ABANDONED_MS
}

/** One acquisition attempt — true when the lock is ours. On EEXIST a
 *  stealable lock is removed so the next retry takes it; a live
 *  holder's is left alone. The file carries the caller's token:
 *  existence is the lock, the token is the ownership proof release()
 *  and steal both check before removing it. */
const tryAcquireLockFile = (lock: string, token: string): boolean => {
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
    // ownership-checked steal — read the holder token FIRST, then prove
    // stealable AND unchanged. A contender that already replaced the
    // file shows a different token — the delete is skipped instead of
    // robbing its fresh lock.
    const holder = readFileSync(lock, 'utf8')
    if (lockStealable(lock, holder) && readFileSync(lock, 'utf8') === holder) {
      rmSync(lock, { force: true })
    }
  } catch {
    // raced removal or a stat flake — the retry decides
  }
  return false
}

/** Release every lock this process still holds — called by the exit
 *  hook because process.exit() bypasses callers' finally blocks, and a
 *  stranded lock blocks every contender until a dead-owner steal. */
const releaseAll = (): void => {
  for (const [lock, token] of heldLocks) {
    try {
      if (readFileSync(lock, 'utf8') === token) {
        rmSync(lock, { force: true })
      }
    } catch {
      // lock already gone — the desired end state
    }
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
  mkdirSync(dirname(lock), { recursive: true })
  if (heldLocks.has(lock)) {
    return () => {} // re-entrant — the outer section owns it
  }
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`
  const deadline = Date.now() + waitMs
  while (!tryAcquireLockFile(lock, token)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} held over ${waitMs / 1000}s`)
    }
    syncSleep(25)
  }
  heldLocks.set(lock, token)
  armExitHook()
  return () => {
    heldLocks.delete(lock)
    try {
      // a section whose pid somehow survived an abandoned-window steal
      // must not drop the new holder's lock — token check first
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
