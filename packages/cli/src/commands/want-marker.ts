/** Shared reader for the `<git-common>/bro/*.json` want-markers —
 *  `pulse.json`, `rig-pulse.json`, `drive.json` all carry
 *  `{everySec, armedAt}` at their core. One read keeps the malformed
 *  verdict identical everywhere: absent file, torn JSON, or a cadence
 *  outside the shared bounds all read as none — a sub-floor marker
 *  would churn a rearm whose spawned child fails closed on flag
 *  validation every checkpoint. */
import { existsSync, readFileSync } from 'node:fs'
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts'

/** The validated core plus the marker's remaining payload — extra
 *  fields (e.g. rig's `repo`) pass through for the caller to check. */
export type WantMarker = { everySec: number; armedAt: string } & Record<string, unknown>

/** The want-record — null when absent, malformed, or torn. A
 *  half-shape is the same answer as none: the checkpoint stays quiet
 *  rather than rearming from it. */
export function readWantMarker(file: string | null): WantMarker | null {
  if (file === null || !existsSync(file)) {
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const { everySec, armedAt } = raw
    return typeof everySec === 'number' &&
      Number.isFinite(everySec) &&
      everySec >= MIN_INTERVAL_SEC &&
      everySec <= MAX_INTERVAL_SEC &&
      typeof armedAt === 'string'
      ? { ...raw, everySec, armedAt }
      : null
  } catch {
    return null
  }
}
