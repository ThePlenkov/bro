/** `bro debt watch`'s argv layer — the --interval bound and the collect
 *  flag passthrough. Split out of debt.ts — the module was past the
 *  CodeScene file-size bar. */
import { readOption } from './debt-args.ts';

/** setTimeout overflows above 2^31-1 ms (~24.8 days) and fires
 *  immediately — bound the interval below that. */
const MAX_INTERVAL_MS = 2_147_483_647;

function parseIntervalSec(value: string | null): number {
  const n = Number(value);
  const bad = value === null || !Number.isSafeInteger(n) || n <= 0;
  if (bad || n * 1000 > MAX_INTERVAL_MS) {
    console.error(`error: --interval must be a positive integer (seconds), got "${value}"`);
    process.exit(2);
  }
  return n;
}

export interface WatchArgs {
  intervalSec: number;
  collectArgv: string[];
}

/** One argv slot — --interval's value or a collect flag passthrough. */
function watchArg(argv: string[], i: number, out: WatchArgs): number {
  if (argv[i] !== '--interval') {
    out.collectArgv.push(argv[i]!);
    return 0;
  }
  out.intervalSec = parseIntervalSec(readOption(argv, i));
  return 1;
}

export function parseWatchArgs(argv: string[]): WatchArgs {
  const out: WatchArgs = { intervalSec: 300, collectArgv: [] };
  for (let i = 0; i < argv.length; i += 1) {
    i += watchArg(argv, i, out);
  }
  return out;
}
