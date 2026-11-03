/** The exec seam — the ONLY place `spawnSync`/`spawn('herdr', …)`
 *  lives. Every module above this (fleet/lines/views, the cli
 *  wrappers, the plugin) builds argvs and calls `call`/`callOut`;
 *  nothing else spawns. */
import { spawn, spawnSync } from 'node:child_process';

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

/** Async twin of `callOut` — same short fuse through a real child,
 *  for callers whose own event loop must not block (a connector probe
 *  inside a timeout race: a spawnSync there is unpreemptable). */
export function callOutAsync(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    let out = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, out });
    };
    try {
      const p = spawn(herdrBin(), args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      });
      const timer = setTimeout(() => {
        p.kill('SIGKILL');
        finish(-1);
      }, HERDR_TIMEOUT_MS);
      p.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      p.on('error', () => {
        clearTimeout(timer);
        finish(-1);
      });
      p.on('close', code => {
        clearTimeout(timer);
        finish(code ?? -1);
      });
    } catch {
      finish(-1);
    }
  });
}

/** Async twin of `call` — fire-and-forget without blocking the loop. */
export async function callAsync(args: string[]): Promise<void> {
  await callOutAsync(args);
}

/** Async twin of `callJson` — `.result` or undefined on any failure. */
export async function callJsonAsync<T>(args: string[]): Promise<T | undefined> {
  const r = await callOutAsync(args);
  if (r.code !== 0 || r.out === '') return undefined;
  try {
    return (JSON.parse(r.out) as { result: T }).result;
  } catch {
    return undefined;
  }
}
