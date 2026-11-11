/**
 * tmp-dir sweep — the shared reaper behind `bro cleanup` and
 * `bro work prune` (spec bro-d9znu). `/tmp` is a small tmpfs on this
 * fleet; stale `tmp-*`/`npm-*`/`npx-*`/`node-*`/`bro-published-*`
 * directories accumulate from killed processes (nx daemons' `nx@latest`
 * probe installs, aborted publish-surface probes) until the filesystem
 * is full.
 *
 * Safety contract: only directories owned by the current uid are
 * candidates. `tmp-<pid>-*` names (the `tmp` npm package's `dirSync`
 * shape — nx's daemon embeds its own pid) are governed by owner
 * liveness: alive owner keeps, dead owner is reaped after
 * `DEAD_OWNER_GRACE_MS` (10min). Everything else keeps the original
 * `bro cleanup` contract — older than `STALE_MS` (1h) and untouched by
 * any live `/proc` fd/cwd/root/exe.
 *
 * The /proc scan is positive-evidence only: on ptrace_scope≥1 hosts we
 * can inspect just our own descendants' fd tables, so 'unverifiable'
 * (unreadable fd table — every foreign-uid process, plus same-uid
 * session daemons) cannot be allowed to block or the sweep is a no-op.
 * It blocks deletion only for group/other-accessible dirs, where a
 * process we cannot inspect could legitimately sit inside; uid-private
 * 0700 dirs have no such holder. Owner liveness on `tmp-<pid>-*` names
 * is the stronger signal the scan cannot provide — it is what keeps a
 * live nx daemon's `nx@latest` install safe (spec bro-d9znu).
 */
import { readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pidAlive } from '@broject/core';

const STALE_MS = 60 * 60 * 1000; // 1 hour
/** Dead-owner dirs get a shorter leash than the general TTL: the
 *  creator is gone, so only a grace period against path-passing races
 *  (a child handed the dir by path, not yet holding an fd) remains. */
const DEAD_OWNER_GRACE_MS = 10 * 60 * 1000;

/** Bro-owned and package-manager temp prefixes. `bro-published-*` is
 *  the publish-surface probe fixture (scripts/published-surface.ts);
 *  the rest are the shapes npx/npm/node and the `tmp` package leave. */
const TARGET_PATTERNS = [/^tmp-/, /^npm-/, /^npx-/, /^node-/, /^bro-published-/];

/** `tmp-<pid>-<rand>` — the `tmp` package's default dirSync name. The
 *  pid is the creating process's; anything else under `tmp-` (mkdtemp's
 *  `tmp-XXXXXX`) carries no owner and stays TTL-only. */
const TMP_PID_RE = /^tmp-(\d+)-/;

export interface TmpSweepInput {
  isDir: boolean;
  /** st.uid === current uid — foreign-owned entries are never ours to take */
  ownedByUs: boolean;
  /** dir age in ms */
  ageMs: number;
  /** pid parsed from a `tmp-<pid>-*` name; null when the name carries none */
  ownerPid: number | null;
  /** pidAlive(ownerPid) — consulted only when ownerPid is set; a live or
   *  unverifiable pid reads true and keeps the TTL path */
  ownerAlive: boolean;
  /** lazy /proc scan — invoked only past the age gate, never for young dirs */
  inUse: () => boolean;
}

export type TmpSweepVerdict = 'delete' | 'keep' | 'skip';

/** The per-entry decision, pure so the rule is unit-testable without
 *  touching /tmp or /proc.
 *
 *  `tmp-<pid>-*` names carry their creator's pid, and owner liveness is
 *  the use signal the /proc scan cannot provide: on ptrace_scope≥1
 *  hosts we can only inspect our own descendants' fd tables, so a live
 *  owner's temp dir (an nx daemon's `nx@latest` install) reads
 *  unverifiable and would be deleted out from under it. Alive owner →
 *  keep, dead owner → delete once past the grace. Pid-less patterns
 *  (`bro-published-*`, `npm-*`, `npx-*`, `node-*`, mkdtemp `tmp-*`)
 *  have no owner signal: the 1h TTL plus a positive-evidence in-use
 *  check carries them. */
export function tmpSweepVerdict(f: TmpSweepInput): TmpSweepVerdict {
  if (!f.isDir || !f.ownedByUs) {
    return 'skip';
  }
  if (f.ownerPid !== null) {
    if (f.ownerAlive) {
      return 'keep';
    }
    if (f.ageMs < DEAD_OWNER_GRACE_MS) {
      return 'skip';
    }
    return f.inUse() ? 'keep' : 'delete';
  }
  if (f.ageMs < STALE_MS) {
    return 'skip';
  }
  return f.inUse() ? 'keep' : 'delete';
}

function isVanished(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isPermission(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function linkMatches(linkPath: string, candidate: string): 'use' | 'none' | 'unverifiable' {
  try {
    const resolved = canonicalPath(readlinkSync(linkPath));
    if (resolved === candidate || resolved.startsWith(`${candidate}/`)) {
      return 'use';
    }
    return 'none';
  } catch (err) {
    if (isVanished(err)) return 'none';
    if (isPermission(err)) return 'unverifiable';
    return 'none';
  }
}

function processUsesPath(pidDir: string, candidate: string): 'use' | 'none' | 'unverifiable' {
  let fds: string[];
  try {
    fds = readdirSync(join(pidDir, 'fd'));
  } catch (err) {
    if (isVanished(err)) return 'none';
    return 'unverifiable';
  }
  for (const fd of fds) {
    const result = linkMatches(join(pidDir, 'fd', fd), candidate);
    if (result !== 'none') return result;
  }
  for (const name of ['cwd', 'root', 'exe']) {
    const result = linkMatches(join(pidDir, name), candidate);
    if (result !== 'none') return result;
  }
  return 'none';
}

/** Owner uid of a /proc/<pid> dir, or null when it cannot be read —
 *  the dir's own metadata is world-readable even when the process's
 *  fd table is not. */
function procOwnerUid(pidDir: string): number | null {
  try {
    return statSync(pidDir).uid;
  } catch {
    return null;
  }
}

/** True when any live process holds the path open (fd, cwd, root, or
 *  exe). Non-Linux hosts and unreadable /proc answer "in use" — the
 *  sweep errs toward keeping.
 *
 *  Foreign-uid processes are skipped for uid-private candidates: the
 *  package-manager/tmp-package dirs this sweep targets are mode 0700,
 *  so a foreign process cannot legitimately sit inside one — and its
 *  fd table is unreadable anyway, which used to read as 'unverifiable'
 *  and kept EVERY candidate forever (root daemons alone made the sweep
 *  a no-op, spec bro-d9znu). A group/other-accessible dir could host a
 *  foreign process, so those stay conservative: unverifiable keeps. */
export function isPathInUse(path: string, procDir: string = '/proc'): boolean {
  if (process.platform !== 'linux') {
    return true;
  }
  const candidate = canonicalPath(path);
  let foreignAccessible = true;
  try {
    foreignAccessible = (statSync(path).mode & 0o077) !== 0;
  } catch {
    // mode unreadable — stay conservative
  }
  let ourUid: number | undefined;
  try {
    ourUid = userInfo().uid;
  } catch {
    // uid unknowable — scan every pid, old conservative behavior
  }
  let pids: string[];
  try {
    pids = readdirSync(procDir).filter((p: string) => /^\d+$/.test(p));
  } catch {
    return true;
  }
  for (const pid of pids) {
    const pidDir = join(procDir, pid);
    if (ourUid !== undefined) {
      const owner = procOwnerUid(pidDir);
      if (owner !== null && owner !== ourUid) {
        if (!foreignAccessible) {
          continue;
        }
        return true;
      }
    }
    const result = processUsesPath(pidDir, candidate);
    if (result === 'use') {
      return true;
    }
    // 'unverifiable' only blocks on a group/other-accessible dir: a
    // process we cannot inspect (non-descendant under ptrace_scope, or
    // foreign uid) could legitimately sit inside a shared dir, but a
    // 0700 tmp dir has no such holder — counting it kept EVERY
    // candidate forever (spec bro-d9znu)
    if (result === 'unverifiable' && foreignAccessible) {
      return true;
    }
  }
  return false;
}

export interface TmpSweepOptions {
  /** suppress per-dir `keep` lines — the noise floor when a supervisor
   *  relays this output (drive's `work prune --loop` child). Deleted and
   *  summary lines still print. */
  quietKeeps?: boolean;
}

/** Delete stale temp directories in `os.tmpdir()`. `dryRun` reports
 *  without removing. Per-entry failures warn and continue; a tmpdir
 *  that cannot be listed at all sets exitCode — same contract the
 *  original `bro cleanup` sweep had. */
export function cleanupTmpDirs(dryRun: boolean, opts: TmpSweepOptions = {}): void {
  const tmp = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(tmp);
  } catch (err) {
    console.error(`cleanup: failed to read ${tmp} (${err instanceof Error ? err.message : err})`);
    process.exitCode = 1;
    return;
  }

  const targets = entries.filter(e => TARGET_PATTERNS.some(re => re.test(e)));
  if (targets.length === 0) {
    return;
  }

  let currentUid: number | undefined;
  try {
    currentUid = userInfo().uid;
  } catch {
    // cannot determine current uid; keep all candidates
  }

  const inUseMessage =
    process.platform !== 'linux' ? 'usage unverifiable on this platform' : 'in use';

  let deleted = 0;
  const now = Date.now();
  for (const name of targets) {
    const fullPath = join(tmp, name);
    try {
      const st = statSync(fullPath);
      const pidMatch = TMP_PID_RE.exec(name);
      const ownerPid = pidMatch === null ? null : Number(pidMatch[1]);
      const ownerAlive = ownerPid === null ? true : pidAlive(ownerPid);
      const verdict = tmpSweepVerdict({
        isDir: st.isDirectory(),
        ownedByUs: currentUid !== undefined && st.uid === currentUid,
        ageMs: now - (st.mtimeMs || st.mtime.getTime()),
        ownerPid,
        ownerAlive,
        inUse: () => isPathInUse(fullPath),
      });
      if (verdict === 'skip') {
        continue;
      }
      if (verdict === 'keep') {
        if (opts.quietKeeps !== true) {
          // owner-alive keeps never consulted /proc — say why, not 'in use'
          const reason = ownerPid !== null && ownerAlive ? 'owner pid alive' : inUseMessage;
          console.log(`  keep ${fullPath} (${reason})`);
        }
        continue;
      }
      if (dryRun) {
        console.log(`  would delete ${fullPath}`);
        deleted++;
        continue;
      }
      // re-verify before rm — narrows the check-then-delete race to the syscall
      if (isPathInUse(fullPath)) {
        if (opts.quietKeeps !== true) {
          console.log(`  keep ${fullPath} (${inUseMessage})`);
        }
        continue;
      }
      try {
        rmSync(fullPath, { recursive: true, force: true });
        console.log(`  deleted ${fullPath}`);
        deleted++;
      } catch (err) {
        if (isPathInUse(fullPath)) {
          if (opts.quietKeeps !== true) {
            console.log(`  keep ${fullPath} (${inUseMessage})`);
          }
          continue;
        }
        console.error(`  error deleting ${fullPath}: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    } catch {
      // skip if can't stat
    }
  }
  if (deleted > 0) {
    console.log(`cleanup: ${dryRun ? 'would delete' : 'deleted'} ${deleted} tmp item(s)`);
  }
}
