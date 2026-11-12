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
  /** False when the project id could not resolve (no git, no realpath). */
  ok: boolean;
}

/** Run the sessionStart sweep once for (dir, mode) and write every
 *  snapshot event file + the freshness stamp. Best-effort per write —
 *  a failed event file just reads as a miss next time. */
export async function renderModeSnapshots(
  dir: string,
  mode: Mode,
  env: NodeJS.ProcessEnv = process.env
): Promise<RenderSnapshotsResult | null> {
  const project = sessionProject(dir);
  if (project === undefined) {
    return null;
  }
  const ctx: ConnectorCtx = { dir, sessionId: '', mode };
  let probe: ProbeResult;
  try {
    probe = await sessionStartProbe(ctx);
  } catch {
    // a thrown sweep still stamps nothing — next consumer re-renders
    return { project, mode, lines: 0, events: [], ok: false };
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
