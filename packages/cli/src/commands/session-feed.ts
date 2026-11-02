/**
 * session-feed — the `bro: session` pane's report envelope (spec
 * bro-l8wqu → bro-q2edc): the `bro:fleet`/`bro-session` herdr calls
 * that pin a pane's semantic state. The archive half (`.events.jsonl`
 * row shapes, the byte-windowed tail read, the row→LED verdict) moved
 * to @broject/acp-session — re-exported below so existing call sites
 * keep resolving until they migrate.
 */
import { spawnSync } from 'node:child_process';
import { nextSeq, type PaneLed } from './fleet-state.ts';
import { PANE_SOURCE, plain } from './herdr-status-view.ts';

export {
  type ArchiveRow,
  eventsVerdict,
  parseArchiveRows,
  readTailSlice,
  rowVerdict,
  sizeOf,
  TAIL_BYTES,
  tailArchive,
  tailWindow,
} from '@broject/acp-session';

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
