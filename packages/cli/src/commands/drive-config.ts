/** `drive` config section — a separate module so plugins.ts can register
 *  the schema without importing the command's dependency tree (same
 *  pattern as check-config.ts). */
import type { ConfigSection } from '@broject/core'

export interface DriveConfig {
  /** Seconds between passes in --every mode and the documented cadence
   *  for --once re-invocation. */
  intervalSec: number
  /** 'auto' merges orphaned green PRs; 'never' reports them. */
  merge: 'auto' | 'never'
  /** Merge-path occupancy TTL (bro-ihnlv): a green PR waits on a live
   *  owner only while that owner shows proven activity — log mtime,
   *  heartbeat, marker stamp — inside this window. Silence past it
   *  counts the PR orphaned: drive adopts it and merges. */
  occupancyTtlSec: number
}

/** The cadence bounds `drive --every` enforces — the config section
 *  applies the same floor so a saved cadence can never be rejected as
 *  its own default (a sub-floor cadence is a busy loop, not a poll). */
export const MIN_INTERVAL_SEC = 0.1
export const MAX_INTERVAL_SEC = 0x7fffffff / 1000

/** The occupancy-TTL floor — a sub-minute activity bound reads per-pass
 *  noise as silence and merges under owners between heartbeats. */
export const MIN_OCCUPANCY_TTL_SEC = 60

/** bro.config.json `drive` section. */
export const driveSection: ConfigSection<DriveConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (obj.merge !== undefined && obj.merge !== 'auto' && obj.merge !== 'never') {
    console.error(
      `bro.config: drive.merge must be "auto" or "never" — got ${JSON.stringify(obj.merge)}`
    )
  }
  if (
    obj.occupancyTtlSec !== undefined &&
    (typeof obj.occupancyTtlSec !== 'number' ||
      !Number.isFinite(obj.occupancyTtlSec) ||
      obj.occupancyTtlSec < MIN_OCCUPANCY_TTL_SEC)
  ) {
    console.error(
      `bro.config: drive.occupancyTtlSec must be a number ≥${MIN_OCCUPANCY_TTL_SEC} — got ${JSON.stringify(obj.occupancyTtlSec)}`
    )
  }
  return {
    intervalSec:
      typeof obj.intervalSec === 'number' &&
      Number.isFinite(obj.intervalSec) &&
      obj.intervalSec >= MIN_INTERVAL_SEC &&
      obj.intervalSec <= MAX_INTERVAL_SEC
        ? obj.intervalSec
        : 300,
    merge: obj.merge === 'never' ? 'never' : 'auto',
    occupancyTtlSec:
      typeof obj.occupancyTtlSec === 'number' &&
      Number.isFinite(obj.occupancyTtlSec) &&
      obj.occupancyTtlSec >= MIN_OCCUPANCY_TTL_SEC
        ? obj.occupancyTtlSec
        : 7200,
  }
}
