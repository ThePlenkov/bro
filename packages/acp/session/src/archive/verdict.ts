/** The row→LED verdicts — the archive's own posture contract, shared
 *  by every frontend that paints an LED off the journal. */
import type { PaneLed } from './led.ts';
import type { ArchiveRow } from './rows.ts';

/** The archive's own LED for one row — last row wins: a turn start or
 *  update is working, a clean stop is idle, an error/denied-ask is
 *  blocked. `undefined` means the row carries no verdict (unknown
 *  kinds, malformed). */
export function rowVerdict(row: ArchiveRow): { led: PaneLed; mode: string } | undefined {
  switch (row.kind) {
    case 'update':
      return row.update !== undefined
        ? { led: { state: 'working' }, mode: 'streaming' }
        : undefined;
    case 'turn':
      if (row.phase === 'start') return { led: { state: 'working' }, mode: 'turn' };
      if (row.phase === 'stop') {
        return row.error !== undefined && row.error !== ''
          ? { led: { state: 'blocked' }, mode: 'turn error' }
          : { led: { state: 'idle' }, mode: 'turn complete' };
      }
      return undefined;
    case 'permission':
      return {
        led: { state: 'blocked' },
        mode: `permission — ${row.verdict ?? 'denied'}`,
      };
    default:
      return undefined;
  }
}

/** The events leg's whole verdict — the worker verdict is the floor
 *  (a blocked or proven-idle worker beats a stale 'working' archive
 *  state: a crash or silence mid-turn must not pass for live work),
 *  the last row's verdict rides on top, and a fresh archive inherits
 *  the worker's posture (spec bro-l8wqu LED contract). */
export function eventsVerdict(
  workerLed: PaneLed,
  row: { led: PaneLed; mode: string } | undefined
): { led: PaneLed; mode: string } {
  if (workerLed.state === 'blocked') {
    // a blocked row keeps its own reason (permission — denied); a
    // working/idle row's mode must not dress the worker's stop
    return {
      led: { state: 'blocked' },
      mode: row?.led.state === 'blocked' ? row.mode : (workerLed.message ?? 'worker exited'),
    };
  }
  if (workerLed.state === 'idle' && row?.led.state === 'working') {
    // proven quiet worker + a mid-turn archive — the turn never
    // closed but the worker is silent or gone; 'idle' is the truth
    return { led: { state: 'idle' }, mode: workerLed.message ?? 'worker quiet' };
  }
  if (row !== undefined) return { led: row.led, mode: row.mode };
  return {
    led: { state: workerLed.state === 'working' ? 'working' : 'idle' },
    mode: 'session events',
  };
}
