/**
 * Worktree claim plane — the durable artifacts that say "a session owns
 * this tree": the per-worktree `bro/work` marker under the tree's own
 * gitdir, the `bro/claim.lock` mutex, and the idle/activity reads every
 * occupancy verdict needs. Moved from the CLI's `commands/work.ts` in
 * the fleet-lifecycle extraction (bro-jamp7): the READS are engine —
 * planes and ACP consume them without spawning the CLI; the WRITES
 * (`claimWorktree`'s stamp) stay in the command layer.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { markerLive, markerOwner } from '@broject/core';
import { LIVE_MARKER_MS } from './proc-owner.ts';

/** A linked worktree's git dir is exactly `<main>/.git/worktrees/<name>` —
 *  the primary checkout's git dir never is. Anchoring on `.git/worktrees/`
 *  keeps a primary checkout living under a `…/worktrees/…` directory from
 *  being misclassified as linked. */
export function isLinkedGitDir(gitDir: string): boolean {
  const norm = gitDir.split(sep).join('/');
  return /(?:^|\/)\.git\/worktrees\/[^/]+$/.test(norm);
}

/** A worktree's real git dir — a linked worktree's `.git` is a FILE
 *  naming `<common>/worktrees/<name>`; the main checkout's `.git` is the
 *  dir itself. Null when neither is readable. Reading the pointer file
 *  beats a `git rev-parse` subprocess on the driver's per-PR hot path —
 *  note @broject/core's `worktreeGitDir` is the rev-parse variant for
 *  callers that can afford the spawn. */
export function worktreeGitDir(path: string): string | null {
  const dotgit = join(path, '.git');
  try {
    if (statSync(dotgit).isDirectory()) {
      return dotgit;
    }
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'));
    if (m === null) {
      return null;
    }
    const d = m[1]!.trim();
    return isAbsolute(d) ? d : resolve(path, d);
  } catch {
    return null;
  }
}

/** The claim/retire mutex for one worktree — `<gitdir>/bro/claim.lock`.
 *  `claimWorktree` stamps under it and `bro drive` runs its
 *  occupancy-probe→`worktree remove` / probe→spawn sections under it,
 *  so a dir can't gain an owner while a driver is removing it. Null
 *  when the tree's gitdir can't be resolved. */
export function claimLockPath(path: string): string | null {
  const gd = worktreeGitDir(path);
  return gd === null ? null : join(gd, 'bro', 'claim.lock');
}

/** The worktree's own claim marker with its stamp — detail + mtime is
 *  what the merge-path occupancy TTL reads (bro-ihnlv): the marker's
 *  mtime is the last proven claim activity. */
export interface WorktreeClaimInfo {
  detail: string;
  mtimeMs: number;
  /** The claiming agent's pid + start parsed from the marker's first
   *  line — null on anonymous markers. Lets callers tell "a sibling
   *  worktree claimed by MY agent tree" (own work, suppress from
   *  parallel-work nudges) from a foreign agent's claim (bro-7022c). */
  owner: { pid: number; start: string } | null;
}

/** The worktree's own claim marker — `<gitdir>/bro/work`, stamped by
 *  `bro work enter` (bro-pywx). Unlike .work marker details it needs no
 *  name matching: presence inside THIS tree is the claim. Returns the
 *  marker detail ('' when fresh but anonymous), undefined when absent
 *  or stale. */
export function worktreeClaimInfo(
  worktree: string,
  now: number = Date.now()
): WorktreeClaimInfo | undefined {
  try {
    const gd = worktreeGitDir(worktree);
    if (gd === null) {
      return undefined;
    }
    const marker = join(gd, 'bro', 'work');
    const mtimeMs = statSync(marker).mtimeMs;
    const lines = readFileSync(marker, 'utf8').split('\n');
    if (!markerLive(lines[0], mtimeMs, LIVE_MARKER_MS, now)) {
      return undefined;
    }
    return { detail: lines[1]?.trim() ?? '', mtimeMs, owner: markerOwner(lines[0]) };
  } catch {
    return undefined;
  }
}

export function worktreeClaim(worktree: string, now: number = Date.now()): string | undefined {
  return worktreeClaimInfo(worktree, now)?.detail;
}

/** Milliseconds since the worktree's last visible activity — the dir
 *  entry itself (checkout/bootstrap churn) or its gitdir's
 *  index/HEAD-reflog (commits, checkouts). A dead tree's clock froze
 *  with it; unreadable stat fields just don't move the max. */
export function worktreeIdleMs(path: string, now: number = Date.now()): number {
  let t = 0;
  try {
    t = statSync(path).mtimeMs;
  } catch {
    // gone mid-sweep — the verdict pass reports it separately
  }
  const gd = worktreeGitDir(path);
  if (gd !== null) {
    for (const f of ['index', 'logs/HEAD', 'HEAD', '.']) {
      try {
        t = Math.max(t, statSync(join(gd, f)).mtimeMs);
      } catch {
        // partial admin — skip
      }
    }
  }
  return t === 0 ? Number.POSITIVE_INFINITY : now - t;
}
