/** Owner-only file/dir writes for bro-managed artifacts (spec
 *  bro-l8c4f.4). Prompt files, agent logs, env files, task bodies can
 *  carry secrets — umask-default modes left every one of them
 *  world-readable on a umask-022 host. The contract: create with
 *  PRIVATE_FILE_MODE, and repair a pre-existing permissive mode BEFORE
 *  the write/append lands (fchmod on the open fd), so new content never
 *  sits in a 0644 file.
 *
 *  Two hostile shapes in a dir another local user can write are refused
 *  outright rather than warned through: a symlinked artifact path
 *  (O_NOFOLLOW — the open fails ELOOP) and a foreign-owned regular file
 *  (fstat uid check — appending would feed an attacker's file).
 *
 *  Windows: fchmod maps onto the read-only attribute — these calls are
 *  effectively no-ops there. The owner-only equivalent is the NTFS ACL
 *  on the user profile / checkout, which is already the default; no
 *  code path branches on platform. A repair failure warns and the write
 *  proceeds — a filesystem without POSIX modes (FAT, some fuse mounts)
 *  must not break spawns. */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export const PRIVATE_FILE_MODE = 0o600
export const PRIVATE_DIR_MODE = 0o700

/** The instrumented seam — the pin-before-write ordering and the
 *  foreign-owner refusal are asserted by patching these slots, and a
 *  named import's binding snapshots at link time: a patched
 *  `fs.writeFileSync` never reaches a caller that imported it by name.
 *  Internal — not part of the package's API surface. */
export const privateFs = {
  fchmod: fchmodSync,
  fstat: fstatSync,
  write: writeFileSync,
}

/** O_NOFOLLOW where the platform has it — an artifact path swapped for
 *  a symlink must fail the open, never be followed to a target another
 *  local user reads. Absent on win32, where the profile ACL is the
 *  guard and the constant is undefined. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

function warn(path: string, err: unknown): void {
  console.error(
    `warning: could not pin owner-only mode on ${path} — ${err instanceof Error ? err.message : String(err)}`
  )
}

/** Repair-before-write — open(2) create-mode covers a NEW file only;
 *  this pins the mode on an inherited permissive file before any byte
 *  lands. Best-effort: warn, never fail (non-POSIX filesystems). */
function pinPrivateFile(fd: number, path: string): void {
  try {
    privateFs.fchmod(fd, PRIVATE_FILE_MODE)
  } catch (err) {
    warn(path, err)
  }
}

/** A file another user owns inside a bro artifact dir is planted —
 *  writing would feed their file (fchmod then fails EPERM and the
 *  warning path would append anyway). Refuse, don't warn through.
 *  POSIX-only: win32 has no uid in stat; the ACL owns the guarantee. */
function refuseForeignFile(fd: number, path: string): void {
  if (typeof process.getuid !== 'function') {
    return
  }
  const { uid } = privateFs.fstat(fd)
  if (uid !== process.getuid()) {
    throw Object.assign(
      new Error(`refusing foreign-owned artifact ${path} (uid ${uid})`),
      { code: 'EACCES' }
    )
  }
}

/** The shared open: no symlinks, no foreign files, mode pinned on the
 *  descriptor before the caller's first byte. A refusal closes the fd
 *  and throws — a planted artifact fails the spawn loudly. */
function openPrivateSync(path: string, flags: number): number {
  const fd = openSync(path, flags | NOFOLLOW, PRIVATE_FILE_MODE)
  try {
    refuseForeignFile(fd, path)
    pinPrivateFile(fd, path)
  } catch (err) {
    closeSync(fd)
    throw err
  }
  return fd
}

/** Truncate-write `path` owner-only: 0600 for a new file, and a
 *  pre-existing file's mode is repaired before data lands. */
export function writePrivateFileSync(path: string, data: string | Uint8Array): void {
  const fd = openPrivateSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
  )
  try {
    privateFs.write(fd, data)
  } finally {
    closeSync(fd)
  }
}

/** Append-write `path` owner-only — same create + repair contract as
 *  writePrivateFileSync, with the append offset. `''` pre-creates a
 *  pinned empty file for later appends (shell `>>`, `tee -a`, a
 *  detached fd) to inherit. */
export function appendPrivateFileSync(path: string, data: string | Uint8Array): void {
  const fd = openPrivateAppendSync(path)
  try {
    privateFs.write(fd, data)
  } finally {
    closeSync(fd)
  }
}

/** Open `path` for append owner-only and hand back the fd — for callers
 *  that keep the descriptor (spawn stdio redirection). The mode is
 *  pinned before the caller's first write. */
export function openPrivateAppendSync(path: string): number {
  return openPrivateSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
  )
}

/** `mkdir -p` pinned owner-only on creation. An existing dir keeps its
 *  mode on purpose — a shared-rig store stays usable. For a missing
 *  chain, mkdir each level and pin 0700 immediately: mkdir applies the
 *  umask to the requested mode, and a 0177 umask strips owner-x off
 *  0700 — recursive mkdir then EACCES's trying to descend through its
 *  own unsearchable intermediate. The pin has to ride between levels,
 *  not after the whole call. */
export function mkdirPrivateSync(path: string): void {
  if (existsSync(path)) {
    return
  }
  const missing: string[] = []
  for (let d = path; !existsSync(d); d = dirname(d)) {
    missing.push(d)
  }
  for (const d of missing.reverse()) {
    try {
      mkdirSync(d, PRIVATE_DIR_MODE)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        continue // creation race — the winner's mode stands
      }
      throw err
    }
    try {
      chmodSync(d, PRIVATE_DIR_MODE)
    } catch (err) {
      warn(d, err)
    }
  }
}
