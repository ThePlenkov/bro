/**
 * Tier-1 mode snapshots (specs/bro-izpyk.2.md) — the pre-rendered
 * rehydrate context a mode-active session reads instead of paying the
 * full connector sweep on every session-start/post-compaction/
 * pre-compact event.
 *
 *   snapshots/<projectId>/<mode>/<event>.txt
 *
 * under `$XDG_STATE_HOME/bro/` (`~/.local/state/bro` fallback). Content
 * is the `sessionStartProbe` line set `\n`-joined — the same lines the
 * live `rehydrateLines` leg emits, minus the session-scoped remainder
 * (parallel-work nudge, goal, heartbeat) which stays live because it is
 * per-session by definition. The render ctx carries `sessionId: ''` so
 * session-scoped probes self-disable, and `mode` set so `activeIn`
 * filters exactly as a live session of that mode would.
 *
 * Freshness is the `.stamp` mtime (MODE_SNAPSHOT_TTL_MS); consumers treat
 * a stale or missing snapshot as a miss and re-render detached.
 */

import {
  MODE_SNAPSHOT_EVENTS,
  sessionProject,
  sessionStartProbe,
  touchSnapshotStamp,
  writeModeSnapshot,
  type ConnectorCtx,
  type Mode,
  type ModeSnapshotEvent,
  type ProbeResult,
} from '@broject/core';

export interface RenderSnapshotsResult {
  project: string;
  mode: Mode;
  /** Probe lines rendered — also the per-event file content basis. */
  lines: number;
  events: ModeSnapshotEvent[];
  /** False when the project id could not resolve (no git, no realpath)
   *  or the sweep did not settle — an unsettled render writes nothing
   *  so a previous good snapshot keeps answering. */
  ok: boolean;
}

/** The sweep seam — tests inject a fake; production is the connector
 *  sessionStart probe set. */
export type SnapshotSweep = (ctx: ConnectorCtx) => Promise<ProbeResult>;

/** Run the sessionStart sweep once for (dir, mode) and write every
 *  snapshot event file + the freshness stamp. Best-effort per write —
 *  a failed event file just reads as a miss next time. */
export async function renderModeSnapshots(
  dir: string,
  mode: Mode,
  env: NodeJS.ProcessEnv = process.env,
  sweep: SnapshotSweep = sessionStartProbe
): Promise<RenderSnapshotsResult | null> {
  const project = sessionProject(dir);
  if (project === undefined) {
    return null;
  }
  const ctx: ConnectorCtx = { dir, sessionId: '', mode };
  // The renderer is nobody: it is spawned detached from whichever
  // session happened to miss, and an inherited BRO_AGENT_ID — or none,
  // which answers to 'orchestrator' — would let the notify drain
  // consume addressed drops into a snapshot every session of that
  // mode then reads (single-consumer drops are deleted on delivery).
  // Pin an identity that owns nothing for the sweep; broadcast drops
  // still render — they stay pending for real sessions regardless.
  const prevAgentId = process.env.BRO_AGENT_ID;
  process.env.BRO_AGENT_ID = `snapshot-render-${process.pid}`;
  let probe: ProbeResult;
  try {
    probe = await sweep(ctx);
  } catch {
    // a thrown sweep still stamps nothing — next consumer re-renders
    return { project, mode, lines: 0, events: [], ok: false };
  } finally {
    if (prevAgentId === undefined) {
      delete process.env.BRO_AGENT_ID;
    } else {
      process.env.BRO_AGENT_ID = prevAgentId;
    }
  }
  if (!probe.settled) {
    // a partial sweep (timed-out/thrown probes) must not stamp fresh —
    // that would serve incomplete lines for the whole TTL and suppress
    // the retry. Write nothing: any previous good snapshot keeps
    // answering, and the next miss re-renders on the throttle.
    return { project, mode, lines: probe.lines.length, events: [], ok: false };
  }
  const text = probe.lines.join('\n');
  const events: ModeSnapshotEvent[] = [];
  for (const event of MODE_SNAPSHOT_EVENTS) {
    if (writeModeSnapshot(env, project, mode, event, text)) {
      events.push(event);
    }
  }
  touchSnapshotStamp(env, project, mode);
  return { project, mode, lines: probe.lines.length, events, ok: events.length > 0 };
}

/** Modes worth snapshotting — `observe` never consumes one (its
 *  rehydrate leg is the filtered probe set itself), so rendering it
 *  would be pure waste. */
export const SNAPSHOT_MODES: readonly Mode[] = ['plan', 'code', 'review', 'orchestrate'];
