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

/** One capturing herdr call — the projector's probe half: same short
 *  fuse, stdout captured for the `.result` envelope. */
export function callOut(args: string[]): { code: number; out: string } {
  try {
    const r = spawnSync(herdrBin(), args, {
      encoding: 'utf8',
      timeout: HERDR_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return { code: r.status ?? -1, out: r.stdout ?? '' };
  } catch {
    return { code: -1, out: '' };
  }
}

/** `herdr <args>` → `.result`, undefined on any failure — reachability
 *  is the caller's verdict, a bad envelope is just a miss. */
export function callJson<T>(args: string[]): T | undefined {
  const r = callOut(args);
  if (r.code !== 0 || r.out === '') return undefined;
  try {
    return (JSON.parse(r.out) as { result: T }).result;
  } catch {
    return undefined;
  }
}

/** `herdr <args>` succeeded — the write-side verdict. */
export function callOk(args: string[]): boolean {
  return callOut(args).code === 0;
}
