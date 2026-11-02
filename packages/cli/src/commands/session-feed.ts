/**
 * session-feed — the `bro: session` pane's report envelope (spec
 * bro-l8wqu → bro-q2edc). The machinery (exec seam, envelope argvs,
 * seq, plain) converged into @broject/herdr-kit's client module;
 * this file keeps the session identity's thin wrappers so existing
 * call sites keep resolving. The archive half lives in
 * @broject/acp-session — also re-exported below.
 */
import {
  metaArgs,
  type PaneLed,
  release,
  releaseArgs,
  report,
  reportArgs,
  SESSION_IDENTITY,
} from '@broject/herdr-kit';

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

export { PANE_SOURCE, plain } from '@broject/herdr-kit';

export const SESSION_PANE_AGENT = SESSION_IDENTITY.agent;

/** The report-agent argv for one semantic state. */
export function sessionReportArgs(pane: string, led: PaneLed, seq: number): string[] {
  return reportArgs(pane, led, seq, SESSION_IDENTITY);
}

/** The release argv for pane exit — clears name, state, and any
 *  resume binding so the shell-return probe isn't left to clean up. */
export function sessionReleaseArgs(pane: string, seq: number): string[] {
  return releaseArgs(pane, seq, SESSION_IDENTITY);
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
  return metaArgs(pane, seq, SESSION_IDENTITY, agent, `${led.state}=${mode}`);
}

/** Fire the report bundle for one LED move — report-agent plus the
 *  two metadata calls. `agent` is the display name (driver, provider,
 *  or slug); `mode` is the label detail. Returns the seq the calls
 *  carried (a test can seq-account without env). */
export function reportSession(pane: string, agent: string, led: PaneLed, mode: string): number {
  return report(pane, agent, led, mode, SESSION_IDENTITY);
}

/** Release on pane exit — one call, advisory like every report. */
export function releaseSession(pane: string): void {
  release(pane, SESSION_IDENTITY);
}

/** The display-agent precedence — driver binary first, then the
 *  provider name, then the slug, `session` last. */
export function sessionAgentOf(
  t: { agent?: string; session?: { provider?: string }; slug?: string } | undefined
): string {
  return t?.agent ?? t?.session?.provider ?? t?.slug ?? 'session';
}
