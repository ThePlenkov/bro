/**
 * session-feed — the `bro: session` pane's shared feed contract (spec
 * bro-l8wqu → bro-q2edc): the `.events.jsonl` archive row shapes, the
 * byte-windowed tail read, the row→LED verdict, and the `bro:fleet`/
 * `bro-session` report envelope. Both pane frontends consume it —
 * `bro herdr session-view` (the line-mode fallback) and the OpenTUI
 * pane (`plugins/herdr/tui`, which imports this file directly) — so
 * the wire semantics live here once, not twice.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { SessionUpdateLike } from '@broject/providers';
import { nextSeq, type PaneLed } from './fleet-state.ts';
import { PANE_SOURCE, plain } from './herdr-status-view.ts';

export const SESSION_PANE_AGENT = 'bro-session';

/** Milliseconds — every herdr call is fire-and-forget behind a short
 *  fuse; a wedged socket must not freeze the view. */
const HERDR_TIMEOUT_MS = 5_000;

const herdrBin = (): string => process.env.HERDR_BIN_PATH ?? 'herdr';

function call(args: string[]): void {
  try {
    spawnSync(herdrBin(), args, { timeout: HERDR_TIMEOUT_MS, stdio: 'ignore' });
  } catch {
    // every report is advisory — a dead socket retires to the watch loop
  }
}

/** The shared report/release/metadata envelope — `bro:fleet` source,
 *  `bro-session` agent (a distinct identity from `bro-status`: a
 *  recycled pane id must fail the status backstop's foreign check). */
function paneArgs(verb: string, pane: string, seq: number): string[] {
  return [
    'pane',
    verb,
    pane,
    '--source',
    PANE_SOURCE,
    '--agent',
    SESSION_PANE_AGENT,
    '--seq',
    String(seq),
  ];
}

/** The report-agent argv for one semantic state. */
export function sessionReportArgs(pane: string, led: PaneLed, seq: number): string[] {
  const args = [...paneArgs('report-agent', pane, seq), '--state', led.state];
  if (led.message !== undefined && led.message !== '') {
    args.push('--message', led.message);
  }
  return args;
}

/** The release argv for pane exit — clears name, state, and any
 *  resume binding so the shell-return probe isn't left to clean up. */
export function sessionReleaseArgs(pane: string, seq: number): string[] {
  return paneArgs('release-agent', pane, seq);
}

/** The display-text argvs — same two-call contract status-view
 *  carries: call 1 clears, call 2 lands display-agent + state-label
 *  (herdr rejects set-and-clear in one call). */
export function sessionMetaArgs(
  pane: string,
  agent: string,
  led: PaneLed,
  mode: string,
  seq: number
): string[][] {
  const calls = [[...paneArgs('report-metadata', pane, seq), '--clear-state-labels']];
  const set = [
    ...paneArgs('report-metadata', pane, seq + 1),
    '--display-agent',
    plain(agent),
    '--state-label',
    `${led.state}=${plain(mode)}`,
  ];
  calls.push(set);
  return calls;
}

/** Fire the report bundle for one LED move — report-agent plus the
 *  two metadata calls. `agent` is the display name (driver, provider,
 *  or slug); `mode` is the label detail. Returns the seq the calls
 *  carried (a test can seq-account without env). */
export function reportSession(pane: string, agent: string, led: PaneLed, mode: string): number {
  const seq = nextSeq();
  call(sessionReportArgs(pane, led, seq));
  for (const a of sessionMetaArgs(pane, agent, led, mode, seq)) call(a);
  return seq;
}

/** Release on pane exit — one call, advisory like every report. */
export function releaseSession(pane: string): void {
  call(sessionReleaseArgs(pane, nextSeq()));
}

/** The display-agent precedence — driver binary first, then the
 *  provider name, then the slug, `session` last. */
export function sessionAgentOf(
  t: { agent?: string; session?: { provider?: string }; slug?: string } | undefined
): string {
  return t?.agent ?? t?.session?.provider ?? t?.slug ?? 'session';
}

// --- the archive feed ----------------------------------------------------

/** The open-tail cap — a dead session's archive or log can run to
 *  megabytes; the pane scrolls back through the last chunk, not the
 *  corpus. */
export const TAIL_BYTES = 64 * 1024;

/** statSync().size or 0 — the tail math's floor. */
export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** One archive row — the shapes `agentTurnPlane` and the worker's
 *  permission seam write (spec bro-l8wqu). Unknown kinds parse
 *  through harmlessly — forward-compatible tail. */
export interface ArchiveRow {
  kind?: string;
  /** The journal stamp — every row `agentTurnPlane` writes carries
   *  it; the pane's time gutter and judge-turn detection ride on
   *  these two fields. */
  ts?: string;
  by?: string;
  phase?: string;
  update?: SessionUpdateLike;
  stopReason?: string;
  error?: string;
  title?: string;
  verdict?: string;
  /** `kind: 'prompt'` — journaled by `AgentTurnPlane.start` (the turn's
   *  flattened request text); older archives without one may carry an
   *  injected sibling `.prompt.md` row instead — same shape, `text`. */
  text?: string;
}

/** A chunk of an append-only file — from byte `from` to EOF. */
export function readTailSlice(
  path: string,
  from: number
): { text: string; size: number } | undefined {
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const start = Math.min(Math.max(0, from), size);
    const len = size - start;
    if (len === 0) return { text: '', size };
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8'), size };
  } finally {
    closeSync(fd);
  }
}

/** Every complete JSONL row in a slice — blank lines skip, a torn
 *  tail row (still being written) drops and the next complete read
 *  picks it up. */
export function parseArchiveRows(text: string): ArchiveRow[] {
  const rows: ArchiveRow[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line) as ArchiveRow);
    } catch {
      // partial line — dropped until the row completes on disk
    }
  }
  return rows;
}

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
 *  (a blocked worker beats a stale 'working' archive state), the last
 *  row's verdict rides on top, and a fresh archive inherits the
 *  worker's posture (spec bro-l8wqu LED contract). */
export function eventsVerdict(
  workerLed: PaneLed,
  row: { led: PaneLed; mode: string } | undefined
): { led: PaneLed; mode: string } {
  if (workerLed.state === 'blocked') {
    return { led: { state: 'blocked' }, mode: row?.mode ?? 'worker blocked' };
  }
  if (row !== undefined) return { led: row.led, mode: row.mode };
  return {
    led: { state: workerLed.state === 'working' ? 'working' : 'idle' },
    mode: 'session events',
  };
}
