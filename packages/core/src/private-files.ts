/** Owner-only file/dir writes for bro-managed artifacts (spec
 *  bro-l8c4f.4). Prompt files, agent logs, env files, task bodies can
 *  carry secrets — umask-default modes left every one of them
 *  world-readable on a umask-022 host. The contract: create with
 *  PRIVATE_FILE_MODE, and repair a pre-existing permissive mode BEFORE
 *  the write/append lands (fchmod on the open fd), so new content never
 *  sits in a 0644 file.
 *
 *  Windows: fchmod maps onto the read-only attribute — these calls are
 *  effectively no-ops there. The owner-only equivalent is the NTFS ACL
 *  on the user profile / checkout, which is already the default; no
 *  code path branches on platform. A repair failure warns and the write
 *  proceeds — a filesystem without POSIX modes (FAT, some fuse mounts)
 *  must not break spawns. */
import { closeSync, fchmodSync, mkdirSync, openSync, writeFileSync } from 'node:fs'

export const PRIVATE_FILE_MODE = 0o600
export const PRIVATE_DIR_MODE = 0o700

/** Repair-before-write — open(2) create-mode covers a NEW file only;
 *  this pins the mode on an inherited permissive file before any byte
 *  lands. Best-effort: warn, never fail (non-POSIX filesystems). */
function pinPrivateFile(fd: number, path: string): void {
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE)
  } catch (err) {
    console.error(
      `warning: could not pin owner-only mode on ${path} — ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Truncate-write `path` owner-only: 0600 for a new file, and a
 *  pre-existing file's mode is repaired before data lands. */
export function writePrivateFileSync(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, 'w', PRIVATE_FILE_MODE)
  try {
    pinPrivateFile(fd, path)
    writeFileSync(fd, data)
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
    writeFileSync(fd, data)
  } finally {
    closeSync(fd)
  }
}

/** Open `path` for append owner-only and hand back the fd — for callers
 *  that keep the descriptor (spawn stdio redirection). The mode is
 *  pinned before the caller's first write. */
export function openPrivateAppendSync(path: string): number {
  const fd = openSync(path, 'a', PRIVATE_FILE_MODE)
  pinPrivateFile(fd, path)
  return fd
}

/** `mkdir -p` pinned owner-only on creation. `recursive` leaves an
 *  EXISTING dir's mode alone on purpose — file modes carry the
 *  guarantee, and a dir another local user must also write into (a
 *  shared rig's store) stays usable. */
export function mkdirPrivateSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE })
}
