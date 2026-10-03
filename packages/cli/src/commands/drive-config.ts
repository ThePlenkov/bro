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
}

/** The cadence bounds `drive --every` enforces — the config section
 *  applies the same floor so a saved cadence can never be rejected as
 *  its own default (a sub-floor cadence is a busy loop, not a poll). */
export const MIN_INTERVAL_SEC = 0.1
export const MAX_INTERVAL_SEC = 0x7fffffff / 1000

/** bro.config.json `drive` section. */
export const driveSection: ConfigSection<DriveConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (obj.merge !== undefined && obj.merge !== 'auto' && obj.merge !== 'never') {
    console.error(
      `bro.config: drive.merge must be "auto" or "never" — got ${JSON.stringify(obj.merge)}`
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
  }
}
