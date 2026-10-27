/**
 * The durable heartbeat file — `<git-common>/bro/heartbeat.json`
 * (bro-dxoa5). Every `bro watch` tick overwrites it with the snapshot
 * it just collected: one repo-shared "last known state", sitting next
 * to `agents.json` in the common dir so worktrees share it.
 *
 * The mailbox is the event channel — drops expire after an hour. This
 * file is the state channel: it survives the night, so a rig's
 * liveness is a read (`bro status`, session-start context), never an
 * inference from whether a session happened to poll.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitCommonDir } from '@broject/core';
import { CLOCK_SKEW_MS } from './watch-clock.ts';

/** `<git-common>/bro/heartbeat.json`; null outside a repository — the
 *  same boundary the mailbox has: no shared state dir, no heartbeat. */
export function heartbeatFile(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'heartbeat.json');
}

/** One atomic write — tmp+rename (the mailbox's drop rule) so a reader
 *  mid-cat never sees half a snapshot. The payload is the whole
 *  WatchSnapshot; typed as unknown so this module carries no watch-plane
 *  imports into the hook hot path. Throws on real failure — the caller
 *  owns the best-effort warn, same as the mailbox drop. */
export function writeHeartbeat(dir: string, snap: unknown): boolean {
  const file = heartbeatFile(dir);
  if (file === null) {
    return false;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}

export interface HeartbeatSummary {
  ts: string;
  ageMs: number;
  /** `ts` sits this far ahead of the reader's clock — past
   *  CLOCK_SKEW_MS it's writer-clock skew, not freshness (bro-i7t3b:
   *  clamping a future stamp to age 0 reads "just now", exactly the
   *  masking the incident showed) */
  futureMs?: number;
  /** the writer's own tick flagged `clock.skewed` — a behind-skewed
   *  writer stamps old times that no reader-side check can catch, so
   *  the persisted verdict is the only signal. */
  writerSkewed?: boolean;
  /** size of the snapshot's attention list — the rig's open decisions */
  attention: number;
}

/** The last tick's summary. Absent file, torn JSON, a missing/odd `ts`,
 *  or a non-array `attention` all read as `null` — "never had a
 *  heartbeat" is an ordinary state for a repo, never an error, and a
 *  half-shaped snapshot must not pass for "quiet". */
export function readHeartbeat(dir: string, now = Date.now()): HeartbeatSummary | null {
  const file = heartbeatFile(dir);
  if (file === null || !existsSync(file)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      ts?: unknown;
      attention?: unknown;
      clock?: { skewed?: unknown };
    };
    const ms = typeof raw.ts === 'string' ? Date.parse(raw.ts) : Number.NaN;
    if (!Number.isFinite(ms) || !Array.isArray(raw.attention)) {
      return null;
    }
    const ahead = ms - now;
    return {
      ts: raw.ts as string,
      ageMs: Math.max(0, now - ms),
      ...(ahead > CLOCK_SKEW_MS ? { futureMs: ahead } : {}),
      ...(raw.clock?.skewed === true ? { writerSkewed: true } : {}),
      attention: raw.attention.length,
    };
  } catch {
    return null;
  }
}

/** Age in the smallest honest unit — `30s`, `4m`, `9h`, `2d`. */
export function heartbeatAge(ageMs: number): string {
  const s = Math.floor(ageMs / 1000);
  if (s < 90) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 90) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 36) {
    return `${h}h`;
  }
  return `${Math.floor(h / 24)}d`;
}

/** The shared one-liner — "last tick 4m ago — quiet" /
 *  "last tick 9h ago — 2 attention". Freshness and the open-decision
 *  count are the whole signal; no verdict lives here. A future-dated
 *  `ts` renders the skew verdict — a stamp the writer's clock forged
 *  must not pass for "just now". */
export function heartbeatLine(dir: string): string | null {
  const h = readHeartbeat(dir);
  if (h === null) {
    return null;
  }
  const tail = h.attention === 0 ? 'quiet' : `${h.attention} attention`;
  if (h.futureMs !== undefined) {
    return `last tick stamped ${heartbeatAge(h.futureMs)} in the future — writer clock skew — ${tail}`;
  }
  if (h.writerSkewed === true) {
    return `last tick ${heartbeatAge(h.ageMs)} ago — writer clock skew — ${tail}`;
  }
  return `last tick ${heartbeatAge(h.ageMs)} ago — ${tail}`;
}
