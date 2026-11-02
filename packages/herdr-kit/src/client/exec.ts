/** The exec seam — the ONLY place `spawnSync('herdr', …)` lives. Every
 *  module above this (fleet/lines/views, the cli wrappers, the plugin)
 *  builds argvs and calls `call`/`callOut`; nothing else spawns. */
import { spawnSync } from 'node:child_process';

/** Milliseconds — every herdr call is fire-and-forget behind a short
 *  fuse; a wedged socket must not freeze the view. */
export const HERDR_TIMEOUT_MS = 5_000;

export const herdrBin = (): string => process.env.HERDR_BIN_PATH ?? 'herdr';

/** One fire-and-forget herdr call — advisory by construction: a dead
 *  socket or a wedged binary retires silently; the watch/poll loops
 *  are the real delivery. */
export function call(args: string[]): void {
  try {
    spawnSync(herdrBin(), args, { timeout: HERDR_TIMEOUT_MS, stdio: 'ignore' });
  } catch {
    // every report is advisory — a dead socket retires to the watch loop
  }
}
