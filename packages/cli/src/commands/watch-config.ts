/** `watch` config section — a separate module so plugins.ts can register
 *  the schema without importing the command's dependency tree (same
 *  pattern as drive-config.ts). */
import type { ConfigSection } from '@broject/core'
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts'

export interface WatchConfig {
  /** Seconds between pulse ticks — the cadence recorded into
   *  `bro/pulse.json` by `bro watch install` and suggested for
   *  `bro watch --every` when `--every` isn't passed. */
  intervalSec: number
  /** Seconds a session-pulse window runs before ending — the `--for`
   *  bound the rearm nudge suggests (bro-killn). The window's exit is
   *  the event the session waits on: digest, `bro drive` once, re-arm. */
  pulseSec: number
}

const bounded = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= MIN_INTERVAL_SEC && v <= MAX_INTERVAL_SEC

/** bro.config.json `watch` section. */
export const watchSection: ConfigSection<WatchConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    intervalSec: bounded(obj.intervalSec) ? obj.intervalSec : 60,
    pulseSec: bounded(obj.pulseSec) ? obj.pulseSec : 900,
  }
}
