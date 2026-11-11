/** Shared reader for the `<git-common>/bro/*.json` want-markers —
 *  `pulse.json`, `rig-pulse.json`, `drive.json` all carry
 *  `{everySec, armedAt}` at their core. One read keeps the malformed
 *  verdict identical everywhere: absent file, torn JSON, or a cadence
 *  outside the shared bounds all read as none — a sub-floor marker
 *  would churn a rearm whose spawned child fails closed on flag
 *  validation every checkpoint. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir } from '@broject/core';
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts';

/** The validated core plus the marker's remaining payload — extra
 *  fields (e.g. rig's `repo`) pass through for the caller to check. */
export type WantMarker = { everySec: number; armedAt: string } & Record<string, unknown>;

/** The want-record — null when absent, malformed, or torn. A
 *  half-shape is the same answer as none: the checkpoint stays quiet
 *  rather than rearming from it. */
export function readWantMarker(file: string | null): WantMarker | null {
  if (file === null || !existsSync(file)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const { everySec, armedAt } = raw;
    return typeof everySec === 'number' &&
      Number.isFinite(everySec) &&
      everySec >= MIN_INTERVAL_SEC &&
      everySec <= MAX_INTERVAL_SEC &&
      typeof armedAt === 'string'
      ? { ...raw, everySec, armedAt }
      : null;
  } catch {
    return null;
  }
}

// --- the drive/loop want-markers ---------------------------------------------
//
// These live here, not in daemon.ts, so the pulse connectors can read
// them WITHOUT importing the supervisor machinery: an absent marker is
// a definitionally-quiet rearm decision, and gating the `import
// './daemon.ts')` on it keeps the command registry out of every hook
// event on an unarmed repo (specs/bro-36sx7.7.md). daemon.ts re-exports
// the same names — its consumers are unchanged.

export interface DriveMarker {
  /** pass cadence the rearmed supervisor runs `--every` at */
  everySec: number;
  armedAt: string;
}

export interface LoopMarker {
  /** pass cadence the rearmed supervisor runs `--every` at */
  everySec: number;
  armedAt: string;
}

/** `<git-common>/bro/drive.json` — the merge-path want-marker,
 *  `pulse.json`'s analogue: durable intent that survives sessions and
 *  reboots; the connector's checkpoints rearm a dead supervisor from
 *  it. `daemon.json` stays the transient spawn record; `drive.lock`
 *  the liveness hold. */
export function driveMarkerPath(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'drive.json');
}

/** The want-record — null when absent, malformed, or the repo has no
 *  common dir; readWantMarker owns the torn/cadence verdict. */
export function readDriveMarker(dir: string): DriveMarker | null {
  return readWantMarker(driveMarkerPath(dir));
}

/** `<git-common>/bro/loop.json` — `drive.json`'s loop-kind analogue. */
export function loopMarkerPath(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'loop.json');
}

/** The loop want-record — null when absent, malformed, or the repo has
 *  no common dir; readWantMarker owns the torn/cadence verdict. */
export function readLoopMarker(dir: string): LoopMarker | null {
  return readWantMarker(loopMarkerPath(dir));
}
