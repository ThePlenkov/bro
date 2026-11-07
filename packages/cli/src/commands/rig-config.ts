/** `rig` config section — a separate module so plugins.ts can register
 *  the schema without importing the command's dependency tree (same
 *  pattern as watch-config.ts). */
import { js, type ConfigSection } from '@broject/core';
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts';

export interface RigConfig {
  /** Absolute path of the checkout this rig keeps fresh — the `--repo`
   *  default. Unset = the main worktree of the repo containing cwd (a
   *  scratch `loop/*` worktree never becomes the target). */
  repo?: string;
  /** Seconds between `rig watch` ticks and the cadence `rig install`
   *  writes when `--every` isn't passed. Default 10min — the cadence
   *  the ad-hoc supervisor ran. */
  intervalSec: number;
  /** The `--for` bound a checkpoint-rearmed `rig watch` window gets —
   *  floors at the marker cadence (same rule as watch.pulseSec).
   *  Default 900 (15min). */
  pulseSec: number;
}

/** bro.config.* `rig` section — operator-layer (machine paths and
 *  cadence are this rig's business, not shared project policy). */
export const rigSection: ConfigSection<RigConfig> = raw => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    repo: typeof obj.repo === 'string' && obj.repo.trim() !== '' ? obj.repo.trim() : undefined,
    intervalSec:
      typeof obj.intervalSec === 'number' &&
      Number.isFinite(obj.intervalSec) &&
      obj.intervalSec >= MIN_INTERVAL_SEC &&
      obj.intervalSec <= MAX_INTERVAL_SEC
        ? obj.intervalSec
        : 600,
    pulseSec:
      typeof obj.pulseSec === 'number' &&
      Number.isFinite(obj.pulseSec) &&
      obj.pulseSec >= MIN_INTERVAL_SEC &&
      obj.pulseSec <= MAX_INTERVAL_SEC
        ? obj.pulseSec
        : 900,
  };
};

const boundedSec = { type: 'number', minimum: MIN_INTERVAL_SEC, maximum: MAX_INTERVAL_SEC };

rigSection.jsonSchema = js.obj({
  repo: js.str,
  intervalSec: boundedSec,
  pulseSec: boundedSec,
});
