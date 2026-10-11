/** Advisory inter-process file locks (atomic create — existence IS the
 *  lock). Serializes read-modify-write windows across bro processes:
 *  without one, two actors both read the pre-write state and the loser
 *  clobbers or double-allocates. Re-entrant per path inside a process so
 *  a locked section can reach for the same lock again. */
import { randomBytes } from 'node:crypto'
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pidAlive } from './proc.ts'

/** Lock paths → ownership tokens this process holds — makes
 *  acquireFileLock re-entrant (a locked section can call a helper that
 *  locks the same file without deadlocking on itself) and gives the
 *  exit hook the ownership proof it needs. */
const heldLocks = new Map<string, string>()

/** A holder that outlives this is robbed even while alive — caps the
 *  pid-recycled-onto-an-unrelated-process case. Inside the bound a LIVE
 *  holder is never robbed: a slow-but-alive section (a supervised
 *  backend's multi-minute spawn is the longest legit hold) fails its waiters
 *  instead of being raced. A dead holder's lock is stolen
 *  immediately — liveness is the staleness signal, not age. */
const LOCK_ABANDONED_MS = 15 * 60_000
const LOCK_WAIT_MS = 20_000
/** Sweep floor for crashed staged-token leftovers — a fresh sibling
 *  could belong to an in-flight acquirer; an old one can't. */
const LOCK_STALE_MS = 60_000

/** Filesystems where link(2) is not implemented (some fuse/9p/drvfs
 *  mounts) — the acquire falls back to a single O_CREAT|O_EXCL write,
 *  the same atomic-create contract (tryAcquireLockFileWx). */
const NO_HARDLINK_CODES = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])

/** A lock that reads EMPTY is a wx writer mid-publish (the fallback's
 *  create-then-write window). Fresh = in-flight — never stealable; an
 *  empty file older than the grace is a crashed writer's leftover. */
const EMPTY_LOCK_GRACE_MS = 5_000

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
  if (token.trim() === '' && age < EMPTY_LOCK_GRACE_MS) {
    return false // in-flight wx writer — retry, never break it
  }
  return !pidAlive(Number(token.split(':')[0])) || age > LOCK_ABANDONED_MS
}

/** Capture-then-check removal: rename(2) grabs whatever instance sits
 *  at `lock` atomically, `verify` re-checks THAT instance — a fresh
 *  replacement swapped in mid-race is put back instead of unlinked.
 *  (A plain read-then-rm can delete a lock that was stolen-and-
 *  recreated between the check and the remove.) True when the
 *  captured instance passed verification and was dropped. */
const removeCaptured = (lock: string, verify: (captured: string) => boolean): boolean => {
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
    return false // already gone or renamed by a contender — the retry decides
  }
  let ok = false
  try {
    ok = verify(dest)
  } catch {
    // a verify that can't answer puts the instance back — fail-safe
  }
  if (ok) {
    drop()
    return true
  }
  try {
    renameSync(dest, lock)
  } catch {
    drop() // a new lock already sits there — drop the captured
  }
  return false
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
 *  Filesystems without link(2) take the wx fallback, which covers that
 *  window with the fresh-empty grace instead. On EEXIST a provably stale
 *  hold is stolen so the next retry wins. */
const tryAcquireLockFile = (lock: string, token: string): boolean => {
  const staged = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(staged, token)
  try {
    linkSync(staged, lock)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      try {
        stealLock(lock)
      } catch {
        // raced removal or a stat flake — the retry decides
      }
      return false
    }
    if (!NO_HARDLINK_CODES.has(code ?? '')) {
      throw err
    }
    // no link(2) on this fs — fall through to the wx path
  } finally {
    rmSync(staged, { force: true })
  }
  return tryAcquireLockFileWx(lock, token)
}

/** The wx acquisition attempt — for filesystems where link(2) is not
 *  implemented (some fuse/9p/drvfs mounts). O_CREAT|O_EXCL gives the
 *  same atomic-create contract, but the file publishes EMPTY: a
 *  contender sees an in-flight writer (fresh-empty grace in
 *  lockStealable) rather than a dead owner to break. The post-write
 *  re-read closes the remaining window — a thief that stole the empty
 *  file and took the path leaves its own token there (or the capture
 *  is mid-flight), so the hold only counts while the lock still names
 *  ours. */
const tryAcquireLockFileWx = (lock: string, token: string): boolean => {
  let fd: number
  try {
    fd = openSync(lock, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        stealLock(lock)
      } catch {
        // raced removal or a stat flake — the retry decides
      }
      return false
    }
    throw err
  }
  try {
    writeFileSync(fd, token)
  } finally {
    try {
      closeSync(fd)
    } catch {
      // a close failure can't unwrite the token — the re-read decides
    }
  }
  try {
    return readFileSync(lock, 'utf8') === token
  } catch {
    return false // vanished mid-window — a contender owns the path now
  }
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

/** Advisory inter-process lock on `lock` (atomic create — existence IS
 *  the lock). Returns the release; throws when a live holder outlasts
 *  waitMs. Re-entrant per path — a second acquire while held is a no-op
 *  release. Held locks are also dropped by an 'exit' hook, so a
 *  process.exit() inside the section can't strand the file. */
export function acquireFileLock(lock: string, opts: FileLockOptions = {}): () => void {
  const { waitMs = LOCK_WAIT_MS, label = 'file lock' } = opts
  // a NaN/Infinity deadline compares false forever — the wait would
  // never time out; a negative one is nonsense degrading to an immediate
  // timeout. Reject both instead of misbehaving.
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

/** Refresh cadence for a long hold — far under the abandoned bound so
 *  a live hold's mtime never reads as stale to contenders or the
 *  janitor's `*.lock` sweep; cheap enough to run for a whole process
 *  lifetime. */
const LOCK_HEARTBEAT_MS = Math.floor(LOCK_ABANDONED_MS / 5)

/** The holder pid in a lock's `<pid>:<token>` content — for 'already
 *  supervised by pid N' messages. A pid-only token (serve's lock
 *  shape) parses the same way. Null when the file is absent or carries
 *  no parseable pid. */
export function lockHolderPid(lock: string): number | null {
  try {
    const pid = Number(readFileSync(lock, 'utf8').split(':')[0]?.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export interface HeldLockOptions extends FileLockOptions {
  /** Heartbeat period — tests inject a small value; the default sits
   *  far under the abandoned bound. */
  heartbeatMs?: number
}

/** Acquire `lock` and keep it heartbeated for the hold's whole
 *  lifetime — a supervisor's singleton hold (spec bro-2duu9). A plain
 *  acquireFileLock held past the abandoned bound is robbed even while
 *  its holder lives (mtime age is the steal signal), so the beat
 *  rewrites the mtime on an unref'd interval: a live hold never reads
 *  stale, and a `--once` process is never kept running by its own
 *  guard. If the lock file vanished mid-hold the beat re-links our own
 *  token — a contender who already linked wins (EEXIST), an empty
 *  path takes the hold back. */
export function holdFileLock(lock: string, opts: HeldLockOptions = {}): () => void {
  const { heartbeatMs = LOCK_HEARTBEAT_MS, ...lockOpts } = opts
  const release = acquireFileLock(lock, lockOpts)
  // acquireFileLock guarantees our token is registered — re-entrant
  // holds re-link the outer hold's token, which is the same file
  const token = heldLocks.get(lock)!
  const beat = (): void => {
    let current: string | undefined
    try {
      current = readFileSync(lock, 'utf8')
    } catch {
      current = undefined
    }
    if (current === token) {
      try {
        const now = new Date()
        utimesSync(lock, now, now)
      } catch {
        // a stat/write flake — the next beat retries
      }
      return
    }
    // a foreign token holds the path: refreshing its mtime would mask
    // a dead thief's abandonment, so the reclaim only runs when the
    // occupant is gone or stealable (dead or past the bound) — a live
    // foreign hold is left alone
    if (current !== undefined && !lockStealable(lock)) {
      return
    }
    try {
      tryAcquireLockFile(lock, token)
    } catch {
      // staged-write/IO failure — the next beat retries
    }
  }
  const timer = setInterval(beat, heartbeatMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    release()
  }
}

/** Standby report cadence — one `onStandby` per live-holder wait. */
const STANDBY_WAIT_MS = 60_000

/** One acquire attempt's sync budget while standing by —
 *  acquireFileLock's contention wait is `Atomics.wait` on the calling
 *  thread, so a long slice would freeze the event loop (signal
 *  handlers, timers) for a standing-by supervisor. Slice short and
 *  retry: signal latency stays under a quarter second. */
const ACQUIRE_SLICE_MS = 250

/** Acquire-and-hold `lock`, waiting through a live hold instead of
 *  timing out — a duplicate supervisor's standby (spec bro-2duu9): it
 *  serializes behind the incumbent and takes over when the hold is
 *  released or its dead owner is stolen, so a respawn wrapper never
 *  needs its own pacing to stay single-instance. `onStandby` fires on
 *  entry (when a live holder already sits there) and once per wait
 *  cycle with the holder's pid, so a blocked second instance stays
 *  observable instead of hanging silent. */
export async function awaitFileLock(
  lock: string,
  opts: HeldLockOptions & { onStandby?: (holderPid: number | null) => void } = {}
): Promise<() => void> {
  const { onStandby, ...lockOpts } = opts
  // waitMs is the standby-report cadence, not the acquire slice —
  // each attempt is bounded by ACQUIRE_SLICE_MS so a standby never
  // stalls the event loop for the whole report window
  const reportMs = lockOpts.waitMs ?? STANDBY_WAIT_MS
  const incumbent = lockHolderPid(lock)
  if (incumbent !== null && pidAlive(incumbent)) {
    onStandby?.(incumbent)
  }
  let lastReport = Date.now()
  for (;;) {
    try {
      return holdFileLock(lock, { ...lockOpts, waitMs: ACQUIRE_SLICE_MS })
    } catch (err) {
      if (!(err instanceof LockTimeout)) {
        throw err
      }
      if (Date.now() - lastReport >= reportMs) {
        lastReport = Date.now()
        onStandby?.(lockHolderPid(lock))
      }
      // the slice already burned inside acquireFileLock — a macrotask
      // here only keeps signal/'exit' handlers live between attempts
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}

/** Would a contender steal the instance at `lock`? Dead owner, or a
 *  live hold past the abandoned bound — the system's own staleness
 *  test, exported so reapers judge a lock by the rule its contenders
 *  already apply (bro-f6zp). */
export function staleLock(lock: string): boolean {
  return lockStealable(lock)
}

/** Remove `lock` when its instance proves stealable — the same
 *  capture-then-check as a contender's steal: the file is renamed
 *  aside, the CAPTURED instance re-verified, and a live replacement
 *  swapped in mid-race is put back rather than unlinked. True only
 *  when this call dropped a provably stale instance. */
export function reapStaleLock(lock: string): boolean {
  if (!lockStealable(lock)) {
    return false
  }
  return removeCaptured(lock, lockStealable)
}
