/**
 * The drive connector — the installed merge path's rearm checkpoint
 * (bro-y5zon, spec specs/bro-y5zon.md). `bro drive install` arms
 * `<git-common>/bro/drive.json`; every lifecycle event then re-checks
 * the want against the supervisor's liveness:
 *
 *   armed marker + dead supervisor + orchestrator → spawn `bro daemon run`
 *
 * sessionStart is the cold-start event (the rehydrate paths share it);
 * postTool is the warm path. Orchestrator sessions only — `driveRearm`
 * is quiet under `BRO_AGENT_ID`, so spawned workers never resurrect
 * supervisors (same guard family as `bro drive --every`'s refusal).
 *
 * Lives in its own leaf module for the same reason `watchConnector`
 * lives in watch-pulse.ts: plugins.ts registers connectors at module
 * eval time, so a connector can never sit inside the plugins↔commands
 * import cycle — its const would TDZ. This module's only static value
 * import is the probe bound constant; the probe lazy-imports the
 * supervisor machinery — hook events only ever run after the graph
 * settles.
 */
import { GIT_SYNC_PROBE_TIMEOUT_MS, type Connector, type ConnectorCtx } from '@broject/core';
import { readDriveMarker } from './want-marker.ts';
import { isOrchestratorSession } from './watch-pulse.ts';

/** One checkpoint for every lifecycle event: decide, bring up, report.
 *  `supervisorUp` re-decides under `daemon.up.lock`, so a racing
 *  `daemon up` or a second session's checkpoint collapses to 'already'
 *  — the spawn-side dedup is the lock, not the decision. `requireMarker`
 *  re-reads the want inside the same lock: the marker this decision saw
 *  could be uninstalled while the spawn queued — 'disarmed' instead of
 *  a supervisor nobody asked for. A failure anywhere stays silent: a
 *  probe must never break the hook event it rode in on. */
async function supervisorCheckpoint(dir: string, where: string): Promise<string[]> {
  try {
    // orchestrator gate first — workers never rearm, and env-checking
    // before the marker read keeps their checkpoint at zero git cost
    // (driveRearm re-checks it; this only preserves the order it had
    // when the whole decision lived inside daemon.ts)
    if (!isOrchestratorSession()) {
      return [];
    }
    // quiescence gate — an absent want-marker makes the rearm decision
    // definitionally quiet (`driveRearm` returns 'quiet' for marker
    // null), so the supervisor machinery — daemon.ts, and through it the
    // command registry — never loads on an unarmed repo's hook events
    // (specs/bro-36sx7.7.md). Armed repos pay the import once, as before.
    // The probe is bounded HERE only: this read is the hook path's git
    // budget; the marker reads downstream (driveRearm, supervisorUp's
    // requireMarker) hit the warm gitCommonDir cache this probe fills,
    // while operator paths keep the unbounded default (want-marker.ts).
    if (readDriveMarker(dir, GIT_SYNC_PROBE_TIMEOUT_MS) === null) {
      return [];
    }
    const { driveRearm, supervisorUp } = await import('./daemon.ts');
    const r = driveRearm(dir);
    if (r.kind !== 'rearm') {
      return [];
    }
    const up = supervisorUp(dir, r.everySec, process.env, { requireMarker: true });
    return up.kind === 'spawned'
      ? [
          `drive supervisor rearmed on ${where} — spawned ` +
            `\`bro daemon run --every ${r.everySec}\` (pid ${up.pid})`,
        ]
      : [];
  } catch {
    return [];
  }
}

export const driveConnector: Connector = {
  name: 'drive',
  hooks: () => ({
    sessionStart(ctx: ConnectorCtx) {
      return supervisorCheckpoint(ctx.dir, 'session start');
    },
    postTool(ctx: ConnectorCtx) {
      return supervisorCheckpoint(ctx.dir, 'tool call');
    },
  }),
  // mode gating (specs/bro-izpyk.2.md): supervisor rearm is a code+
  // plane duty — orchestrate dispatches, code executes; passive modes
  // never checkpoint.
  activeIn: {
    sessionStart: ['code', 'orchestrate'],
    postTool: ['code', 'orchestrate'],
  },
};
