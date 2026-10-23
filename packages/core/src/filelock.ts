/** Advisory inter-process file locks — the lock is a DIRECTORY:
 *  `X.lock/` is claimed by mkdir(2) (atomic on every filesystem), and
 *  the hold is a pid-named entry inside (`X.lock/h-<pid>`). It
 *  serializes read-modify-write windows across bro processes: without
 *  one, two actors both read the pre-write state and the loser
 *  clobbers or double-allocates. Re-entrant per path inside a process
 *  so a locked section can reach for the same lock again.
 *
 *  Why a directory: the file shape it replaces could not express
 *  "remove only the instance I verified" — POSIX has no conditional
 *  unlink — so removal went through rename-capture + verify + restore,
 *  and restore's `renameSync(dest, lock)` silently replaces whatever
 *  now sits at `lock`: a successor's live lock could be moved aside,
 *  its path captured by a third party, then overwritten on the way
 *  back (bro-l8c4f.2). Two directory facts close the whole class:
 *
 *    - rmdir refuses a non-empty directory — once an entry is
 *      published, `lock` can never go absent or rebind while occupied;
 *      the instance is pinned for the hold's whole life.
 *    - entry names are unique to their owner — `h-<pid>` exists only
 *      where its own process wrote it, so release/steal unlink by
 *      name can never hit a successor's entry: no capture, no
 *      compare-and-delete, no restore. */
import { randomBytes } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Stats } from 'node:fs'
import { pidAlive } from './proc.ts'

/** Lock paths → the holds this process owns — makes acquireFileLock
 *  re-entrant (a locked section can call a helper that locks the same
 *  file without deadlocking on itself) and gives release/heartbeat/
 *  the exit hook the ownership proof they need. */
interface Hold {
  /** `h-<pid>` — the entry name inside the lock dir. */
  entry: string
  /** Inode of the dir we created — proves `lock` still names OUR
   *  instance: a dir at the same path with a different ino is a
   *  foreign instance, never to be touched. */
  dirIno: number
  /** `pid:hex` — the entry's content, for heartbeat re-publish. */
  token: string
}
const heldLocks = new Map<string, Hold>()

/** A holder that outlives this is robbed even while alive — caps the
 *  pid-recycled-onto-an-unrelated-process case. Inside the bound a LIVE
 *  holder is never robbed: a slow-but-alive section (a supervised
 *  backend's multi-minute spawn is the longest legit hold) fails its waiters
 *  instead of being raced. A dead holder's lock is stolen
 *  immediately — liveness is the staleness signal, not age. */
const LOCK_ABANDONED_MS = 15 * 60_000
const LOCK_WAIT_MS = 20_000
/** Sweep floor for crashed staged/debris siblings — a fresh one could
 *  belong to an in-flight actor; an old one can't. */
const LOCK_STALE_MS = 60_000

/** Filesystems where link(2) is not implemented (some fuse/9p/drvfs
 *  mounts). Dir instances never need hardlinks at all; the legacy-file
 *  steal uses one to pin the inode it verifies, and degrades to
 *  verify-then-unlink where link(2) is missing. */
const NO_HARDLINK_CODES = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])

/** An EMPTY lock dir this fresh is a publisher mid-flight (mkdir →
 *  entry write is one synchronous hop — seconds old and empty means a
 *  crashed acquirer). The same grace covers an empty legacy file — a
 *  wx writer mid-publish on a no-link filesystem. */
const EMPTY_LOCK_GRACE_MS = 5_000

/** Entry name → owner pid. The name IS the ownership proof: a hold
 *  entry only ever exists where its own process wrote it, so judging
 *  staleness is a readdir + kill(0), never a file read. Anything else
 *  inside a lock dir can't represent a live hold — junk. */
const ENTRY_RE = /^h-(\d+)$/

const syncSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const statOrNull = (p: string): Stats | null => {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

// --- dir instances ---------------------------------------------------------

interface Entries {
  /** `h-<pid>` entries whose pid is alive. */
  live: string[]
  /** `h-<pid>` entries whose pid is gone. */
  dead: string[]
  /** Anything not matching h-<pid> — can't represent a live hold. */
  junk: string[]
}

const lockEntries = (lock: string): Entries | null => {
  const out: Entries = { live: [], dead: [], junk: [] }
  let names: string[]
  try {
    names = readdirSync(lock)
  } catch {
    return null // vanished or unreadable — can't judge, don't steal
  }
  for (const e of names) {
    const m = ENTRY_RE.exec(e)
    if (m === null) {
      out.junk.push(e)
    } else {
      ;(pidAlive(Number(m[1])) ? out.live : out.dead).push(e)
    }
  }
  return out
}

/** Is the dir instance AT `lock` stealable? A fresh empty dir is a
 *  publisher mid-flight — never touched; aged past the grace it's a
 *  crashed acquirer. Dead-entry and junk-only dirs go at once; a dir
 *  holding live entries only past the abandoned bound. */
const dirStealable = (lock: string, st: { mtimeMs: number }): boolean => {
  const e = lockEntries(lock)
  if (e === null) {
    return false
  }
  if (e.live.length === 0 && e.dead.length === 0 && e.junk.length === 0) {
    return Date.now() - st.mtimeMs > EMPTY_LOCK_GRACE_MS
  }
  if (e.live.length === 0) {
    return true
  }
  return Date.now() - st.mtimeMs > LOCK_ABANDONED_MS
}

/** Drop a stealable dir instance. The EMPTY case removes with a bare
 *  rmdir — one atomic syscall, no window a mid-flight publisher could
 *  slip a two-holder outcome through: anything inside fails outright.
 *  The non-empty case unlinks entries by name then tries rmdir —
 *  conditional on empty, so an entry published mid-steal fails the
 *  rmdir instead of being moved or clobbered (a live `h-<pid>` inside
 *  a dir already judged stealable is only ever a stray or an abandoned
 *  hold re-asserting; whoever's syscall lands last decides, never
 *  two owners). True when this call removed something. */
const stealDir = (lock: string): boolean => {
  const st = statOrNull(lock)
  if (st === null || !st.isDirectory() || !dirStealable(lock, st)) {
    return false
  }
  let names: string[]
  try {
    names = readdirSync(lock)
  } catch {
    return false
  }
  if (names.length === 0) {
    try {
      rmdirSync(lock)
      return true
    } catch {
      return false // ENOTEMPTY — a publish won the race; the dir stays
    }
  }
  let dropped = false
  for (const e of names) {
    try {
      rmSync(join(lock, e), { force: true, recursive: true })
      dropped = true
    } catch {
      // raced removal — fine
    }
  }
  try {
    rmdirSync(lock)
    dropped = true
  } catch {
    // ENOTEMPTY — an entry landed (a live owner's heartbeat re-publish
    // or a stray); the instance it names now stands, which is correct
  }
  return dropped
}

// --- legacy file instances ---------------------------------------------------

/** `X.lock` as a regular file — the pre-dir primitive's shape and
 *  hand-rolled `pid:token` holds (a pre-change binary can still mint
 *  one; both shapes occupy the same path, so exclusion spans them).
 *  A live token blocks; a dead or past-bound one is stolen. */
const legacyFileStealable = (path: string): boolean => {
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

/** Steal a provably dead legacy FILE: pin the instance by hardlink
 *  (link(2) fails where unsupported — there a plain re-verify+unlink
 *  is the documented degradation for a shape no current code mints),
 *  re-verify THE PINNED instance, then rename-capture `lock`. The
 *  capture is the same atomic grab as always, but the restore is
 *  link(2) — it refuses EEXIST instead of replacing, so a successor
 *  is never overwritten; only a displaced successor whose own path
 *  filled during its capture can still be dropped, and that residual
 *  exists only against instances a previous version created. */
const stealLegacyFile = (lock: string): boolean => {
  if (!legacyFileStealable(lock)) {
    return false
  }
  const probe = `${lock}.pin-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    linkSync(lock, probe)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (NO_HARDLINK_CODES.has(code ?? '') && legacyFileStealable(lock)) {
      try {
        unlinkSync(lock)
        return true
      } catch {
        return false
      }
    }
    return false // gone, or a stat flake — the retry decides
  }
  if (!legacyFileStealable(probe)) {
    rmSync(probe, { force: true })
    return false // the pinned instance is live — `lock` never touched
  }
  let probeIno: number
  try {
    probeIno = statSync(probe).ino
  } catch {
    rmSync(probe, { force: true })
    return false
  }
  const tomb = `${lock}.tomb-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    renameSync(lock, tomb)
  } catch {
    rmSync(probe, { force: true })
    return false // already gone — the retry decides
  }
  const same = statOrNull(tomb)?.ino === probeIno
  if (same) {
    rmSync(tomb, { force: true })
    rmSync(probe, { force: true })
    return true
  }
  // captured a successor — put it back without clobbering whatever
  // now owns the path; on EEXIST the captured one is displaced residue
  try {
    linkSync(tomb, lock)
  } catch {
    // path re-occupied — drop the captured instance below
  }
  rmSync(tomb, { force: true })
  rmSync(probe, { force: true })
  return false
}

/** `lock` is occupied — steal whichever instance shape proves stale;
 *  a live one is left strictly alone (the acquire loop just retries
 *  until waitMs). */
const contend = (lock: string): void => {
  const st = statOrNull(lock)
  if (st === null) {
    return
  }
  if (st.isDirectory()) {
    stealDir(lock)
  } else if (st.isFile()) {
    stealLegacyFile(lock)
  }
  // anything else (fifo/socket/symlink) can't be classified — don't touch
}

/** One acquisition attempt — the dir inode when the lock is ours,
 *  null when a contender holds it. mkdir(2) is the atomic claim; the
 *  entry publish plus the inode re-check close the swap window: a
 *  publish that landed inside a foreign instance (our fresh dir was
 *  swept and the path rebought mid-write) unlinks its stray and
 *  retries — a foreign dir is never left carrying our name. */
const tryAcquireLockDir = (lock: string, entry: string, token: string): number | null => {
  try {
    mkdirSync(lock)
  } catch (err) {
    // EEXIST is contention — contend and let the loop retry. Anything
    // else (EACCES, EROFS, ENOTDIR through a file component) is a real
    // error, not a competing hold — surface it, don't burn the wait.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      contend(lock)
      return null
    }
    throw err
  }
  let dirIno: number
  try {
    dirIno = statSync(lock).ino
  } catch {
    return null // gone between mkdir and stat — the retry rebuilds
  }
  try {
    writeFileSync(join(lock, entry), token)
  } catch {
    return null // our dir vanished mid-publish — the retry rebuilds
  }
  try {
    if (statSync(lock).ino !== dirIno) {
      rmSync(join(lock, entry), { force: true }) // our stray in a foreign dir
      return null
    }
  } catch {
    return null // vanished between publish and verify
  }
  return dirIno
}

/** Sweep crashed staged/debris siblings — `<lock>.<pid>.<rand>.tmp`
 *  from the file primitive, `.cap-`/`.pin-`/`.tomb-` capture names,
 *  and the debt store's old `.stale-`/`.release-` captures. A hard
 *  kill mid-step leaves one behind; the floor keeps a fresh sibling
 *  (possibly in-flight) safe. */
const sweepStaged = (lock: string): void => {
  try {
    const dir = dirname(lock)
    const prefix = `${basename(lock)}.`
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix)) {
        continue
      }
      const debris =
        f.endsWith('.tmp') ||
        f.includes('.cap-') ||
        f.includes('.pin-') ||
        f.includes('.tomb-') ||
        f.includes('.stale-') ||
        f.includes('.release-')
      if (!debris) {
        continue
      }
      const p = join(dir, f)
      try {
        if (Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS) {
          rmSync(p, { force: true, recursive: true })
        }
      } catch {
        // raced removal — fine
      }
    }
  } catch {
    // unreadable dir — the acquire attempts decide
  }
}

/** Drop our hold. The entry name is ours alone — unlinking it can
 *  never hit a successor's entry, so release needs no capture and no
 *  token compare. The dir then goes down only when we actually
 *  removed a name from inside `lock`, or `lock` still names OUR dir
 *  and it's empty — a stolen-then-reacquired lock is a foreign
 *  instance and is left strictly alone. */
const releaseLock = (lock: string, hold: Hold): void => {
  let removed = false
  try {
    unlinkSync(join(lock, hold.entry))
    removed = true
  } catch {
    // ENOENT — our name isn't inside whatever `lock` names now
    // (stolen, or a foreign instance); ENOTDIR — `lock` is a file.
  }
  if (!removed) {
    const st = statOrNull(lock)
    try {
      if (st === null || !st.isDirectory() || st.ino !== hold.dirIno || readdirSync(lock).length > 0) {
        return // foreign instance, or our dir still holds strays — not ours to drop
      }
    } catch {
      return // unreadable mid-check — leave it
    }
  }
  try {
    rmdirSync(lock)
  } catch {
    // ENOTEMPTY — another entry stands (a live stray or our own
    // re-published entry); the instance it belongs to decides
  }
}

/** Release every lock this process still holds — called by the exit
 *  hook because process.exit() bypasses callers' finally blocks, and a
 *  stranded lock blocks every contender until a dead-owner steal. */
const releaseAll = (): void => {
  for (const [lock, hold] of heldLocks) {
    releaseLock(lock, hold)
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

/** Advisory inter-process lock on `lock` — a directory claimed by
 *  mkdir(2) and proven by the `h-<pid>` entry inside. Returns the
 *  release; throws when a live holder outlasts waitMs. Re-entrant per
 *  path — a second acquire while held is a no-op release. Held locks
 *  are also dropped by an 'exit' hook, so a process.exit() inside the
 *  section can't strand the hold. */
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
  const entry = `h-${process.pid}`
  const deadline = Date.now() + waitMs
  sweepStaged(lock)
  let dirIno: number | null = null
  while ((dirIno = tryAcquireLockDir(lock, entry, token)) === null) {
    if (Date.now() >= deadline) {
      throw new LockTimeout(`${label} held over ${waitMs / 1000}s`)
    }
    syncSleep(25)
  }
  const hold: Hold = { entry, dirIno, token }
  heldLocks.set(lock, hold)
  armExitHook()
  return () => {
    heldLocks.delete(lock)
    releaseLock(lock, hold)
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

/** The holder pid in a lock — a dir's `h-<pid>` entry name or a
 *  legacy file's `pid:token` content. Null when `lock` is absent or
 *  carries no parseable pid. */
export function lockHolderPid(lock: string): number | null {
  const st = statOrNull(lock)
  if (st !== null && st.isDirectory()) {
    try {
      for (const e of readdirSync(lock).sort()) {
        const m = ENTRY_RE.exec(e)
        if (m !== null) {
          return Number(m[1])
        }
      }
    } catch {
      // raced removal — report none
    }
    return null
  }
  if (st !== null && st.isFile()) {
    try {
      const pid = Number(readFileSync(lock, 'utf8').split(':')[0]?.trim())
      return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }
  return null
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
 *  rewrites the dir's mtime on an unref'd interval: a live hold never
 *  reads stale, and a `--once` process is never kept running by its
 *  own guard. If our dir vanished mid-hold the beat re-claims an empty
 *  path — mkdir + publish + the same inode verify — while a foreign
 *  instance (live dir or file) is stolen only when it proves stale;
 *  a live foreign hold is left alone. */
export function holdFileLock(lock: string, opts: HeldLockOptions = {}): () => void {
  const { heartbeatMs = LOCK_HEARTBEAT_MS, ...lockOpts } = opts
  const release = acquireFileLock(lock, lockOpts)
  // acquireFileLock guarantees our hold is registered — re-entrant
  // holds share the outer hold's entry and dir, which is the same claim
  const hold = heldLocks.get(lock)!
  const beat = (): void => {
    const cur = statOrNull(lock)
    if (cur !== null && cur.isDirectory() && cur.ino === hold.dirIno) {
      // our instance still stands — re-assert the entry (an abandoned-
      // bound steal may have unlinked it) and freshen the dir mtime
      try {
        writeFileSync(join(lock, hold.entry), hold.token)
      } catch {
        // an I/O flake — the next beat retries
      }
      try {
        const now = new Date()
        utimesSync(lock, now, now)
      } catch {
        // a stat/write flake — the next beat retries
      }
      return
    }
    if (cur !== null) {
      // a foreign instance holds the path — steal it only when it
      // proves stale (dead, junk-only, or past the abandoned bound);
      // a live foreign hold is left alone
      contend(lock)
      return
    }
    // path empty — take the hold back: same mkdir+publish+verify as a
    // fresh acquire; a contender who lands first wins quietly
    let dirIno: number
    try {
      mkdirSync(lock)
      dirIno = statSync(lock).ino
      writeFileSync(join(lock, hold.entry), hold.token)
      if (statSync(lock).ino !== dirIno) {
        rmSync(join(lock, hold.entry), { force: true }) // stranded in a foreign dir
        return
      }
    } catch {
      return // raced or I/O — the next beat retries
    }
    hold.dirIno = dirIno
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

/** Would a contender steal the instance at `lock`? Dead owner, junk
 *  only, aged-empty, or a live hold past the abandoned bound — the
 *  system's own staleness test over both instance shapes, exported so
 *  reapers judge a lock by the rule its contenders already apply
 *  (bro-f6zp). */
export function staleLock(lock: string): boolean {
  const st = statOrNull(lock)
  if (st === null) {
    return false
  }
  if (st.isDirectory()) {
    return dirStealable(lock, st)
  }
  if (st.isFile()) {
    return legacyFileStealable(lock)
  }
  return false
}

/** Remove `lock` when its instance proves stealable — the same
 *  judgement a contender's steal applies, over both instance shapes:
 *  dead entries are unlinked by name and the dir goes down only if
 *  empty; a legacy file is pinned, re-verified, and dropped with a
 *  non-clobbering link(2) restore on a miss. A live instance — file
 *  or dir — is never moved, renamed, or unlinked. True only when this
 *  call dropped something stale. */
export function reapStaleLock(lock: string): boolean {
  const st = statOrNull(lock)
  if (st === null) {
    return false
  }
  if (st.isDirectory()) {
    return stealDir(lock)
  }
  if (st.isFile()) {
    return stealLegacyFile(lock)
  }
  return false
}
