/** The `bro:fleet` pane report envelope — report-agent / release-agent /
 *  report-metadata argv builders plus the fire-and-forget bundle, all
 *  parameterized by pane identity. Converged from the cli's
 *  session-feed + status-view twins, which carried the same machinery
 *  with the identities baked differently. */
import type { PaneLed } from '@broject/acp-session';
import { call } from './exec.ts';
import { plain } from './text.ts';

export type { PaneLed } from '@broject/acp-session';

/** A pane's report identity — `--source` + `--agent` on every call. */
export interface PaneIdentity {
  source: string;
  agent: string;
}

/** The report source every bro pane binds — `bro:`-prefix keeps herdr's
 *  own `herdr:`-reserved namespace untouched. */
export const PANE_SOURCE = 'bro:fleet';

/** The status pane's identity — `bro-status`, unrecognized by the
 *  fleet authority on purpose (self-report only). */
export const STATUS_IDENTITY: PaneIdentity = { source: PANE_SOURCE, agent: 'bro-status' };

/** The session pane's identity — `bro-session`, a distinct name from
 *  `bro-status` so a recycled pane id fails the status backstop's
 *  foreign check. */
export const SESSION_IDENTITY: PaneIdentity = { source: PANE_SOURCE, agent: 'bro-session' };

/** The seq the envelope rides — unix-micros, monotonic per process so
 *  a stale report never lands over a fresh one. One counter for every
 *  reporter: all modules share this counter's state. */
let seqLast = 0;
export function nextSeq(now = Date.now()): number {
  seqLast = Math.max(now * 1e3, seqLast + 1);
  return seqLast;
}

/** The shared verb envelope — `pane <verb> <pane> --source S --agent A --seq N`. */
export function paneArgs(verb: string, pane: string, seq: number, id: PaneIdentity): string[] {
  return ['pane', verb, pane, '--source', id.source, '--agent', id.agent, '--seq', String(seq)];
}

/** The report-agent argv for one semantic state. */
export function reportArgs(pane: string, led: PaneLed, seq: number, id: PaneIdentity): string[] {
  const args = [...paneArgs('report-agent', pane, seq, id), '--state', led.state];
  if (led.message !== undefined && led.message !== '') {
    args.push('--message', led.message);
  }
  return args;
}

/** The release argv for pane exit — clears name, state, and any
 *  resume binding so the shell-return probe isn't left to clean up. */
export function releaseArgs(pane: string, seq: number, id: PaneIdentity): string[] {
  return paneArgs('release-agent', pane, seq, id);
}

/** The display-text argvs — the two-call contract every pane shares:
 *  call 1 clears state-labels (herdr rejects set-and-clear in one
 *  call, and the clear wipes display-agent too), call 2 lands
 *  display-agent + an optional `state=label` pair. */
export function metaArgs(
  pane: string,
  seq: number,
  id: PaneIdentity,
  display: string,
  label?: string
): string[][] {
  const calls = [[...paneArgs('report-metadata', pane, seq, id), '--clear-state-labels']];
  const set = [
    ...paneArgs('report-metadata', pane, seq + 1, id),
    '--display-agent',
    plain(display),
  ];
  if (label !== undefined && label !== '') set.push('--state-label', label);
  calls.push(set);
  return calls;
}

/** Fire the full report bundle — report-agent plus the two metadata
 *  calls. `display` names the pane, `mode` becomes the label's
 *  `${led.state}=text`. Returns the seq the calls carried. */
export function report(
  pane: string,
  display: string,
  led: PaneLed,
  mode: string,
  id: PaneIdentity
): number {
  const seq = nextSeq();
  call(reportArgs(pane, led, seq, id));
  for (const a of metaArgs(pane, seq, id, display, `${led.state}=${plain(mode)}`)) call(a);
  return seq;
}

/** Release on pane exit — one call, advisory like every report. */
export function release(pane: string, id: PaneIdentity): void {
  call(releaseArgs(pane, nextSeq(), id));
}
