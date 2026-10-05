/** `watch` config section — a separate module so plugins.ts can register
 *  the schema without importing the command's dependency tree (same
 *  pattern as drive-config.ts). */
import type { ConfigSection } from '@broject/core'
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts'

export interface WatchConfig {
  /** Seconds between scheduled `bro watch --once --notify` ticks — the
   *  cadence `bro watch install` writes into the timer when `--every`
   *  isn't passed. */
  intervalSec: number
}

/** bro.config.json `watch` section. */
export const watchSection: ConfigSection<WatchConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    intervalSec:
      typeof obj.intervalSec === 'number' &&
      Number.isFinite(obj.intervalSec) &&
      obj.intervalSec >= MIN_INTERVAL_SEC &&
      obj.intervalSec <= MAX_INTERVAL_SEC
        ? obj.intervalSec
        : 60,
  }
}
