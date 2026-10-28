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
import { randomBytes } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Stats } from 'node:fs';
import { pidAlive } from './proc.ts';

/** Lock paths → the holds this process owns — makes acquireFileLock
 *  re-entrant (a locked section can call a helper that locks the same
 *  file without deadlocking on itself) and gives release/heartbeat/
 *  the exit hook the ownership proof they need. */
interface Hold {
  /** `h-<pid>` — the entry name inside the lock dir. */
  entry: string;
  /** `dirId()` of the dir we created — proves `lock` still names OUR
   *  instance: a dir at the same path with a different id is a
   *  foreign instance, never to be touched. */
  dirId: string;
  /** `pid:hex` — the entry's content, for heartbeat re-publish. */
  token: string;
}
const heldLocks = new Map<string, Hold>();

/** A holder that outlives this is robbed even while alive — caps the
 *  pid-recycled-onto-an-unrelated-process case. Inside the bound a LIVE
 *  holder is never robbed: a slow-but-alive section (a supervised
 *  backend's multi-minute spawn is the longest legit hold) fails its waiters
 *  instead of being raced. A dead holder's lock is stolen
 *  immediately — liveness is the staleness signal, not age. */
const LOCK_ABANDONED_MS = 15 * 60_000;
const LOCK_WAIT_MS = 20_000;
/** Sweep floor for crashed staged/debris siblings — a fresh one could
 *  belong to an in-flight actor; an old one can't. */
const LOCK_STALE_MS = 60_000;

/** Filesystems where link(2) is not implemented (some fuse/9p/drvfs
 *  mounts). Dir instances never need hardlinks at all; the legacy-file
 *  steal uses one to pin the inode it verifies, and degrades to
 *  verify-then-unlink where link(2) is missing. */
const NO_HARDLINK_CODES = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

/** An EMPTY lock dir this fresh is a publisher mid-flight (mkdir →
 *  entry write is one synchronous hop — seconds old and empty means a
 *  crashed acquirer). The same grace covers an empty legacy file — a
 *  wx writer mid-publish on a no-link filesystem. */
const EMPTY_LOCK_GRACE_MS = 5_000;

/** Entry name → owner pid. The name IS the ownership proof: a hold
 *  entry only ever exists where its own process wrote it, so judging
 *  staleness is a readdir + kill(0), never a file read. Anything else
 *  inside a lock dir can't represent a live hold — junk. */
const ENTRY_RE = /^h-(\d+)$/;

/** The retired debt-store dir-hold shape: `X.lock/pid`, a file whose
 *  CONTENT is the owner pid. A pre-change binary can still hold one —
 *  mixed-version contention must read it as a real hold, not junk,
 *  or a live old process's lock would be stolen under it. */
const entryOwnerPid = (lock: string, name: string): number | null => {
  const m = ENTRY_RE.exec(name);
  if (m !== null) {
    return Number(m[1]);
  }
  if (name === 'pid') {
    try {
      const owner = Number(readFileSync(join(lock, name), 'utf8').trim());
      return Number.isInteger(owner) && owner > 0 ? owner : null;
    } catch {
      return null;
    }
  }
  return null;
};

const syncSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Shape classification is ALWAYS lstat — never stat: a `X.lock`
 *  symlink to a directory must fail isDirectory, not resolve to its
 *  target — otherwise steal/reap would treat the target's contents as
 *  lock junk and recursively delete unrelated files. Neither lock
 *  shape is ever a link, so a linked lock path is foreign and is
 *  left strictly alone. */
const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** A dir-instance identity — `ino` alone is forgeable by the
 *  allocator: ext4-class filesystems hand a just-freed inode number
 *  straight back to the next mkdir at that path, so a foreign dir
 *  instance can carry the very ino a pin recorded. birthtime is
 *  kernel-stamped at inode creation — utimes(2) can't rewrite it and
 *  reuse can't inherit it — so the pair discriminates instances even
 *  when the number is recycled. A filesystem without btime reports a
 *  constant 0 and the pair degrades to ino-only, the pin's earlier
 *  strength. */
const dirId = (st: Stats): string => `${st.ino}:${st.birthtimeMs}`;

/** The instance identity of the dir AT `p`, or null when `p` doesn't
 *  name a directory — the value every "is this still the instance I
 *  verified" check compares against. */
const lockDirId = (p: string): string | null => {
  const st = lstatOrNull(p);
  return st !== null && st.isDirectory() ? dirId(st) : null;
};

/** fs errors that mean "the instance moved under us" — contention
 *  races to retry. Everything else (EACCES, ENOSPC, EROFS…) is a real
 *  filesystem fault: surface it instead of burning the wait bound and
 *  mislabeling it as a competing hold — `awaitFileLock` would retry a
 *  broken filesystem forever. */
const RACED_LOCK_CODES = new Set(['ENOENT', 'ENOTDIR']);

const raced = (err: unknown): boolean =>
  RACED_LOCK_CODES.has((err as NodeJS.ErrnoException).code ?? '');

// --- dir instances ---------------------------------------------------------

interface Entries {
  /** `h-<pid>` entries whose pid is alive. */
  live: string[];
  /** `h-<pid>` entries whose pid is gone. */
  dead: string[];
  /** Anything not matching h-<pid> — can't represent a live hold. */
  junk: string[];
}

const lockEntries = (lock: string): Entries | null => {
  const out: Entries = { live: [], dead: [], junk: [] };
  let names: string[];
  try {
    names = readdirSync(lock);
  } catch {
    return null; // vanished or unreadable — can't judge, don't steal
  }
  for (const e of names) {
    const owner = entryOwnerPid(lock, e);
    if (owner === null) {
      out.junk.push(e);
    } else {
      (pidAlive(owner) ? out.live : out.dead).push(e);
    }
  }
  return out;
};

/** Is the dir instance AT `lock` stealable? A fresh empty dir is a
 *  publisher mid-flight — never touched; aged past the grace it's a
 *  crashed acquirer. Dead-entry and junk-only dirs go at once; a dir
 *  holding live entries only past the abandoned bound. */
const dirStealable = (lock: string, st: { mtimeMs: number }): boolean => {
  const e = lockEntries(lock);
  if (e === null) {
    return false;
  }
  if (e.live.length === 0 && e.dead.length === 0 && e.junk.length === 0) {
    return Date.now() - st.mtimeMs > EMPTY_LOCK_GRACE_MS;
  }
  if (e.live.length === 0) {
    return true;
  }
  return Date.now() - st.mtimeMs > LOCK_ABANDONED_MS;
};

/** name → inode pins for every entry inside `lock`: removal compares
 *  the live inode, so an entry unlinked-and-republished between scan
 *  and removal (new inode, same name) is refused — the residual
 *  stat→rm gap is the POSIX bound without unlinkat. null when the dir
 *  itself can't be read. */
const pinDirEntries = (lock: string): Array<{ name: string; ino: number }> | null => {
  try {
    const pinned: Array<{ name: string; ino: number }> = [];
    for (const name of readdirSync(lock)) {
      try {
        pinned.push({ name, ino: lstatSync(join(lock, name)).ino });
      } catch {
        // raced away mid-pin — skipped; the conditional rmdir still
        // arbitrates whatever lands in its place
      }
    }
    return pinned;
  } catch {
    return null;
  }
};

/** Drop pinned entries while `lock` still names the judged instance —
 *  each goes only while its live inode matches the pin, and the sweep
 *  stops the instant `ours` fails (a successor landed mid-steal). */
const dropPinnedEntries = (
  lock: string,
  pinned: Array<{ name: string; ino: number }>,
  ours: () => boolean
): void => {
  for (const { name, ino } of pinned) {
    if (!ours()) {
      return; // swapped mid-steal — stop touching the path entirely
    }
    try {
      if (lstatSync(join(lock, name)).ino === ino) {
        rmSync(join(lock, name), { force: true, recursive: true });
      }
    } catch {
      // raced removal — fine
    }
  }
};

/** Drop a stealable dir instance — the instance judged stale is PINNED
 *  by its dir id for the whole operation: every removal is gated on
 *  `lock` still naming that instance, so a successor that lands
 *  mid-steal (a different instance at the same path) is never touched,
 *  and each entry is dropped only while its inode still matches the
 *  scan — a heartbeat re-publish is a new inode under the same name
 *  and gets a pass instead of being stripped under its live owner.
 *
 *  The EMPTY and non-empty cases end in the same conditional rmdir —
 *  one atomic syscall a mid-flight publisher can lose to but never
 *  slip a two-holder outcome through: ENOTEMPTY means an entry landed
 *  mid-steal (a re-published hold or a stray) and the instance it
 *  names stands — whoever's syscall lands last decides, never two
 *  owners. True only when the judged instance is gone — "something
 *  was unlinked" is not a reap. */
const stealDir = (lock: string): boolean => {
  const st = lstatOrNull(lock);
  if (st === null || !st.isDirectory() || !dirStealable(lock, st)) {
    return false;
  }
  const id = dirId(st);
  const ours = (): boolean => lockDirId(lock) === id;
  const pinned = pinDirEntries(lock);
  if (pinned === null || !ours()) {
    return false; // swapped between judge and act — a foreign instance stands
  }
  dropPinnedEntries(lock, pinned, ours);
  try {
    if (ours()) {
      rmdirSync(lock);
      return true;
    }
  } catch {
    // ENOTEMPTY — the entry that landed keeps its instance
  }
  return false;
};

// --- legacy file instances ---------------------------------------------------

/** `X.lock` as a regular file — the pre-dir primitive's shape and
 *  hand-rolled `pid:token` holds (a pre-change binary can still mint
 *  one; both shapes occupy the same path, so exclusion spans them).
 *  A live token blocks; a dead or past-bound one is stolen. Returns
 *  the stale file's inode — the identity every removal compares
 *  against — or null when `path` isn't a provably stale legacy hold. */
const legacyStaleIno = (path: string): number | null => {
  let token: string;
  let st: Stats;
  try {
    token = readFileSync(path, 'utf8');
    st = lstatSync(path);
  } catch {
    return null; // vanished or unreadable — can't prove dead, don't steal
  }
  if (!st.isFile()) {
    return null;
  }
  const age = Date.now() - st.mtimeMs;
  if (token.trim() === '' && age < EMPTY_LOCK_GRACE_MS) {
    return null; // in-flight wx writer — retry, never break it
  }
  return !pidAlive(Number(token.split(':')[0])) || age > LOCK_ABANDONED_MS ? st.ino : null;
};

const legacyFileStealable = (path: string): boolean => legacyStaleIno(path) !== null;

/** Steal a stale legacy file where link(2) is unsupported — the same
 *  compare-then-unlink without the pin: re-verify the stale instance
 *  still sits at `lock` (inode + file shape), then unlink — the
 *  residual stat→unlink gap can hit a file successor; a dir
 *  successor still can't (unlinkSync refuses dirs outright). */
const stealLegacyFileUnpinned = (lock: string): boolean => {
  const ino = legacyStaleIno(lock);
  const cur = ino === null ? null : lstatOrNull(lock);
  if (cur === null || !cur.isFile() || cur.ino !== ino) {
    return false; // successor or foreign shape — not ours to drop
  }
  try {
    unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
};

/** Steal a provably dead legacy FILE — compare-then-unlink, never
 *  capture: link(2) pins the verified stale inode under a private
 *  probe name (while pinned it cannot be recycled, so an inode match
 *  at `lock` IS the same instance), the pinned copy is re-verified,
 *  and `lock` is dropped by unlinkSync — which refuses a directory
 *  outright, so a successor dir instance that landed mid-steal can
 *  never be moved or unlinked the way rename-capture could
 *  (bro-l8c4f.2's original wound). Where link(2) is unsupported the
 *  same compare-then-unlink runs without the pin — the documented
 *  degradation: a file successor inside the stat→unlink gap can still
 *  be hit, a dir successor still cannot. */
const stealLegacyFile = (lock: string): boolean => {
  if (legacyStaleIno(lock) === null) {
    return false;
  }
  const probe = `${lock}.pin-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    linkSync(lock, probe);
  } catch (err) {
    return NO_HARDLINK_CODES.has((err as NodeJS.ErrnoException).code ?? '')
      ? stealLegacyFileUnpinned(lock) // degraded: no pin — see the helper
      : false; // gone, or a stat flake — the retry decides
  }
  if (!legacyFileStealable(probe)) {
    rmSync(probe, { force: true });
    return false; // the pinned instance reads live — `lock` never touched
  }
  let probeIno: number;
  try {
    probeIno = lstatSync(probe).ino;
  } catch {
    rmSync(probe, { force: true });
    return false;
  }
  let dropped = false;
  const cur = lstatOrNull(lock);
  if (cur !== null && cur.isFile() && cur.ino === probeIno) {
    try {
      unlinkSync(lock);
      dropped = true;
    } catch {
      // gone or rebound — the retry decides
    }
  }
  rmSync(probe, { force: true });
  return dropped;
};

/** `lock` is occupied — steal whichever instance shape proves stale;
 *  a live one is left strictly alone (the acquire loop just retries
 *  until waitMs). A symlink/fifo/socket can't be a lock instance —
 *  lstat refuses to classify it and the path is left untouched. */
const contend = (lock: string): void => {
  const st = lstatOrNull(lock);
  if (st === null) {
    return;
  }
  if (st.isDirectory()) {
    stealDir(lock);
  } else if (st.isFile()) {
    stealLegacyFile(lock);
  }
};

/** Pull our entry name back out of whatever `lock` names, then drop
 *  the dir when it is still OUR instance and empty. The name is
 *  process-unique — it can only exist where we published it, so the
 *  unlink is always ours to take even when the dir itself is foreign. */
const dropOwnInstance = (lock: string, entry: string, id: string): void => {
  try {
    rmSync(join(lock, entry), { force: true });
  } catch {
    // already gone — or the path doesn't take entries at all
  }
  try {
    if (lockDirId(lock) === id) {
      rmdirSync(lock);
    }
  } catch {
    // foreign instance or still occupied — the sweeps own leftovers
  }
};

/** One acquisition attempt — our instance's dir id when the lock is
 *  ours, null when a contender holds it. mkdir(2) is the atomic
 *  claim; the entry publish plus the instance re-check close the
 *  swap window: a publish that landed inside a foreign instance (our
 *  fresh dir was swept and the path rebought mid-write — on an
 *  inode-recycling filesystem the successor can even carry our old
 *  ino, which is why the id pairs it with birthtime) unlinks its
 *  stray and retries — a foreign dir is never left carrying our name.
 *  Contention races (ENOENT/ENOTDIR) return null; real fs faults
 *  (EACCES, ENOSPC, EROFS…) throw — a LockTimeout would mislabel a
 *  broken filesystem as a competing hold. */
const tryAcquireLockDir = (lock: string, entry: string, token: string): string | null => {
  try {
    mkdirSync(lock);
  } catch (err) {
    // EEXIST is contention — contend and let the loop retry. Anything
    // else (EACCES, EROFS, ENOTDIR through a file component) is a real
    // error, not a competing hold — surface it, don't burn the wait.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      contend(lock);
      return null;
    }
    throw err;
  }
  let id: string;
  try {
    id = dirId(lstatSync(lock));
  } catch (err) {
    if (raced(err)) {
      return null; // gone between mkdir and stat — the retry rebuilds
    }
    throw err;
  }
  try {
    writeFileSync(join(lock, entry), token);
  } catch (err) {
    if (!raced(err)) {
      // a real fault — a partial entry may still stand under our name
      dropOwnInstance(lock, entry, id);
      throw err;
    }
    return null; // our dir vanished mid-publish — the retry rebuilds
  }
  try {
    if (dirId(lstatSync(lock)) !== id) {
      rmSync(join(lock, entry), { force: true }); // our stray in a foreign dir
      return null;
    }
  } catch (err) {
    if (!raced(err)) {
      dropOwnInstance(lock, entry, id);
      throw err;
    }
    return null; // vanished between publish and verify
  }
  return id;
};

/** Sweep crashed staged/debris siblings — `<lock>.<pid>.<rand>.tmp`
 *  from the file primitive, `.cap-`/`.pin-`/`.tomb-` capture names,
 *  and the debt store's old `.stale-`/`.release-` captures. A hard
 *  kill mid-step leaves one behind; the floor keeps a fresh sibling
 *  (possibly in-flight) safe. */
const sweepStaged = (lock: string): void => {
  try {
    const dir = dirname(lock);
    const prefix = `${basename(lock)}.`;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix)) {
        continue;
      }
      const debris =
        f.endsWith('.tmp') ||
        f.includes('.cap-') ||
        f.includes('.pin-') ||
        f.includes('.tomb-') ||
        f.includes('.stale-') ||
        f.includes('.release-');
      if (!debris) {
        continue;
      }
      const p = join(dir, f);
      try {
        if (Date.now() - lstatSync(p).mtimeMs > LOCK_STALE_MS) {
          rmSync(p, { force: true, recursive: true });
        }
      } catch {
        // raced removal — fine
      }
    }
  } catch {
    // unreadable dir — the acquire attempts decide
  }
};

/** Drop our hold. The instance check comes FIRST: `h-<pid>` is
 *  per-process, so a successor instance can legitimately carry the
 *  same entry name — unlink before verify would strip a foreign
 *  hold. Only when `lock` still names OUR dir do we unlink our entry
 *  and rmdir — a stolen-then-reacquired lock is a foreign instance
 *  and is left strictly alone, byte for byte. */
const releaseLock = (lock: string, hold: Hold): void => {
  // the instance check is re-run immediately before each destructive
  // step: between any two syscalls the path can swap to a successor's
  // fresh (empty) instance, and rmdir must only ever drop OUR dir
  const ours = (): boolean => {
    const st = lstatOrNull(lock);
    return st !== null && st.isDirectory() && dirId(st) === hold.dirId;
  };
  if (!ours()) {
    return; // vanished, rebound, or a foreign instance — not ours
  }
  let removed = false;
  try {
    unlinkSync(join(lock, hold.entry));
    removed = true;
  } catch {
    // ENOENT — our entry was already stolen or never republished
  }
  if (removed) {
    try {
      if (ours()) {
        rmdirSync(lock);
      }
    } catch {
      // ENOTEMPTY — a republished or stray entry stands; its instance decides
    }
    return;
  }
  // our instance, but our entry is already gone — drop the dir only
  // when nothing stands inside; a republished entry keeps it pinned
  try {
    if (ours() && readdirSync(lock).length === 0 && ours()) {
      rmdirSync(lock);
    }
  } catch {
    // raced publish or removal — the surviving instance decides
  }
};

/** Release every lock this process still holds — called by the exit
 *  hook because process.exit() bypasses callers' finally blocks, and a
 *  stranded lock blocks every contender until a dead-owner steal. */
const releaseAll = (): void => {
  for (const [lock, hold] of heldLocks) {
    releaseLock(lock, hold);
  }
};

let exitHookArmed = false;
const armExitHook = (): void => {
  if (exitHookArmed) {
    return;
  }
  exitHookArmed = true;
  process.on('exit', releaseAll);
};

/** A live holder outlasted the wait bound — distinct from acquisition
 *  failures (EACCES, EIO) so callers can name contention without
 *  mislabeling filesystem errors as a competing hold. */
export class LockTimeout extends Error {
  override name = 'LockTimeout';
}

export interface FileLockOptions {
  /** Give up waiting after this — the holder is alive but slow.
   *  Default 20s. */
  waitMs?: number;
  /** Names the lock in the timeout error — 'agents.json lock' style. */
  label?: string;
}

/** Advisory inter-process lock on `lock` — a directory claimed by
 *  mkdir(2) and proven by the `h-<pid>` entry inside. Returns the
 *  release; throws when a live holder outlasts waitMs. Re-entrant per
 *  path — a second acquire while held is a no-op release. Held locks
 *  are also dropped by an 'exit' hook, so a process.exit() inside the
 *  section can't strand the hold. */
export function acquireFileLock(lock: string, opts: FileLockOptions = {}): () => void {
  const { waitMs = LOCK_WAIT_MS, label = 'file lock' } = opts;
  // a NaN/Infinity deadline compares false forever — the wait would
  // never time out; a negative one is nonsense degrading to an immediate
  // timeout. Reject both instead of misbehaving.
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError(`${label}: waitMs must be a finite non-negative number — got ${waitMs}`);
  }
  mkdirSync(dirname(lock), { recursive: true });
  if (heldLocks.has(lock)) {
    return () => {}; // re-entrant — the outer section owns it
  }
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
  const entry = `h-${process.pid}`;
  const deadline = Date.now() + waitMs;
  sweepStaged(lock);
  let id: string | null = null;
  while ((id = tryAcquireLockDir(lock, entry, token)) === null) {
    if (Date.now() >= deadline) {
      throw new LockTimeout(`${label} held over ${waitMs / 1000}s`);
    }
    syncSleep(25);
  }
  const hold: Hold = { entry, dirId: id, token };
  heldLocks.set(lock, hold);
  armExitHook();
  return () => {
    // a stale closure is a no-op: once this hold left the registry a
    // newer hold may own the path, and `h-<pid>` is per-process —
    // releasing through the old handle would strip the successor's
    // entry under a matching name
    if (heldLocks.get(lock) !== hold) {
      return;
    }
    heldLocks.delete(lock);
    releaseLock(lock, hold);
  };
}

/** Run `fn` under the lock. Sync-only on purpose — an async fn would
 *  release-and-reattach semantics nobody needs here. */
export function withFileLock<T>(lock: string, fn: () => T, opts: FileLockOptions = {}): T {
  const release = acquireFileLock(lock, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

/** Refresh cadence for a long hold — far under the abandoned bound so
 *  a live hold's mtime never reads as stale to contenders or the
 *  janitor's `*.lock` sweep; cheap enough to run for a whole process
 *  lifetime. */
const LOCK_HEARTBEAT_MS = Math.floor(LOCK_ABANDONED_MS / 5);

/** The holder pid inside a lock DIR — first hold entry in sorted
 *  order, or null when it's empty or raced away. */
const dirHolderPid = (lock: string): number | null => {
  try {
    for (const e of readdirSync(lock).sort()) {
      const owner = entryOwnerPid(lock, e);
      if (owner !== null) {
        return owner;
      }
    }
  } catch {
    // raced removal — report none
  }
  return null;
};

/** The holder pid in a legacy FILE's `pid:token` content, or null. */
const fileHolderPid = (lock: string): number | null => {
  try {
    const pid = Number(readFileSync(lock, 'utf8').split(':')[0]?.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/** The holder pid in a lock — a dir's `h-<pid>` entry name or a
 *  legacy file's `pid:token` content. Null when `lock` is absent or
 *  carries no parseable pid. */
export function lockHolderPid(lock: string): number | null {
  const st = lstatOrNull(lock);
  if (st !== null && st.isDirectory()) {
    return dirHolderPid(lock);
  }
  if (st !== null && st.isFile()) {
    return fileHolderPid(lock);
  }
  return null;
}

export interface HeldLockOptions extends FileLockOptions {
  /** Heartbeat period — tests inject a small value; the default sits
   *  far under the abandoned bound. */
  heartbeatMs?: number;
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
  const { heartbeatMs = LOCK_HEARTBEAT_MS, ...lockOpts } = opts;
  const release = acquireFileLock(lock, lockOpts);
  // acquireFileLock guarantees our hold is registered — re-entrant
  // holds share the outer hold's entry and dir, which is the same claim
  const hold = heldLocks.get(lock)!;
  const beat = (): void => {
    const cur = lstatOrNull(lock);
    if (cur !== null && cur.isDirectory() && dirId(cur) === hold.dirId) {
      // our instance still stands — re-assert the entry (an abandoned-
      // bound steal may have unlinked it) and freshen the dir mtime
      try {
        writeFileSync(join(lock, hold.entry), hold.token);
        // the check above and this write straddle a syscall pair — a
        // stealer that rmdir'd our dir mid-beat leaves `lock` naming a
        // successor instance, and our entry inside it is OUR stray:
        // pull it back so the successor is never blocked by a name it
        // doesn't own
        if (lockDirId(lock) !== hold.dirId) {
          rmSync(join(lock, hold.entry), { force: true });
          return;
        }
      } catch {
        // an I/O flake — the next beat retries
      }
      try {
        const now = new Date();
        utimesSync(lock, now, now);
      } catch {
        // a stat/write flake — the next beat retries
      }
      return;
    }
    if (cur !== null) {
      // a foreign instance holds the path — steal it only when it
      // proves stale (dead, junk-only, or past the abandoned bound);
      // a live foreign hold is left alone. The id check above is what
      // "foreign" means here — on an inode-recycling filesystem a
      // successor dir can carry our old ino, so only the ino+btime
      // pair keeps a foreign hold safe from our own refresh
      contend(lock);
      return;
    }
    // path empty — take the hold back: same mkdir+publish+verify as a
    // fresh acquire; a contender who lands first wins quietly
    let id: string;
    try {
      mkdirSync(lock);
      id = dirId(lstatSync(lock));
      writeFileSync(join(lock, hold.entry), hold.token);
      if (dirId(lstatSync(lock)) !== id) {
        rmSync(join(lock, hold.entry), { force: true }); // stranded in a foreign dir
        return;
      }
    } catch {
      return; // raced or I/O — the next beat retries
    }
    hold.dirId = id;
  };
  const timer = setInterval(beat, heartbeatMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    release();
  };
}

/** Standby report cadence — one `onStandby` per live-holder wait. */
const STANDBY_WAIT_MS = 60_000;

/** One acquire attempt's sync budget while standing by —
 *  acquireFileLock's contention wait is `Atomics.wait` on the calling
 *  thread, so a long slice would freeze the event loop (signal
 *  handlers, timers) for a standing-by supervisor. Slice short and
 *  retry: signal latency stays under a quarter second. */
const ACQUIRE_SLICE_MS = 250;

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
  const { onStandby, ...lockOpts } = opts;
  // waitMs is the standby-report cadence, not the acquire slice —
  // each attempt is bounded by ACQUIRE_SLICE_MS so a standby never
  // stalls the event loop for the whole report window
  const reportMs = lockOpts.waitMs ?? STANDBY_WAIT_MS;
  const incumbent = lockHolderPid(lock);
  if (incumbent !== null && pidAlive(incumbent)) {
    onStandby?.(incumbent);
  }
  let lastReport = Date.now();
  for (;;) {
    try {
      return holdFileLock(lock, { ...lockOpts, waitMs: ACQUIRE_SLICE_MS });
    } catch (err) {
      if (!(err instanceof LockTimeout)) {
        throw err;
      }
      if (Date.now() - lastReport >= reportMs) {
        lastReport = Date.now();
        onStandby?.(lockHolderPid(lock));
      }
      // the slice already burned inside acquireFileLock — a macrotask
      // here only keeps signal/'exit' handlers live between attempts
      await new Promise(r => setTimeout(r, 0));
    }
  }
}

/** Would a contender steal the instance at `lock`? Dead owner, junk
 *  only, aged-empty, or a live hold past the abandoned bound — the
 *  system's own staleness test over both instance shapes, exported so
 *  reapers judge a lock by the rule its contenders already apply
 *  (bro-f6zp). */
export function staleLock(lock: string): boolean {
  const st = lstatOrNull(lock);
  if (st === null) {
    return false;
  }
  if (st.isDirectory()) {
    return dirStealable(lock, st);
  }
  if (st.isFile()) {
    return legacyFileStealable(lock);
  }
  return false;
}

/** Remove `lock` when its instance proves stealable — the same
 *  judgement a contender's steal applies, over both instance shapes:
 *  a stale dir is unlinked entry-by-pinned-entry and goes down only
 *  via the conditional rmdir; a stale legacy file is pinned by
 *  hardlink, re-verified, and dropped by unlink (which can never take
 *  a directory). An instance with a live hold inside the abandoned
 *  bound is never moved, renamed, or unlinked — a live hold PAST the
 *  bound may be stolen, by design. True only when the judged stale
 *  instance is actually gone. */
export function reapStaleLock(lock: string): boolean {
  const st = lstatOrNull(lock);
  if (st === null) {
    return false;
  }
  if (st.isDirectory()) {
    return stealDir(lock);
  }
  if (st.isFile()) {
    return stealLegacyFile(lock);
  }
  return false;
}
