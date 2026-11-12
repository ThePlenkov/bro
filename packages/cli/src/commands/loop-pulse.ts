/**
 * The loop connector — the installed loop path's rearm checkpoint
 * Mirrors drive: `bro loop install` arms `<git-common>/bro/loop.json`; every lifecycle event then re-checks
 * the want against the supervisor's liveness and spawns `bro daemon run --loop`.
 */
import { GIT_SYNC_PROBE_TIMEOUT_MS, type Connector, type ConnectorCtx } from '@broject/core';
import { readLoopMarker } from './want-marker.ts';
import { isOrchestratorSession } from './watch-pulse.ts';
import { orchestratorRoleAllows, roleSessionOf } from './orchestrator-role.ts';

async function supervisorCheckpoint(
  dir: string,
  where: string,
  sessionId?: string
): Promise<string[]> {
  try {
    // orchestrator gate first — same ordering argument as drive-pulse:
    // workers return before any git probe, exactly as loopRearm's own
    // check did when the decision lived inside daemon.ts
    if (!isOrchestratorSession()) {
      return [];
    }
    // quiescence gate — same contract as drive-pulse.ts: no want-marker
    // ⇒ `loopRearm` is definitionally quiet, so daemon.ts (and the
    // registry behind it) stays out of unarmed hook events
    // (specs/bro-36sx7.7.md). The probe bound lives here, on the hook
    // path only — operator paths keep the unbounded default
    // (want-marker.ts).
    if (readLoopMarker(dir, GIT_SYNC_PROBE_TIMEOUT_MS) === null) {
      return [];
    }
    const { loopRearm, supervisorUp } = await import('./daemon.ts');
    const r = loopRearm(dir);
    if (r.kind !== 'rearm') {
      return [];
    }
    // role gate (bro-izpyk.3) — same contract as drive-pulse
    if (!(await orchestratorRoleAllows(dir, roleSessionOf(sessionId)))) {
      return [];
    }
    const up = supervisorUp(dir, r.everySec, process.env, { requireMarker: true, loop: true });
    return up.kind === 'spawned'
      ? [
          `loop supervisor rearmed on ${where} — spawned ` +
            `\`bro daemon run --loop --every ${r.everySec}\` (pid ${up.pid})`,
        ]
      : [];
  } catch {
    return [];
  }
}

export const loopConnector: Connector = {
  name: 'loop',
  hooks: () => ({
    sessionStart(ctx: ConnectorCtx) {
      return supervisorCheckpoint(ctx.dir, 'session start', ctx.sessionId);
    },
    postTool(ctx: ConnectorCtx) {
      return supervisorCheckpoint(ctx.dir, 'tool call', ctx.sessionId);
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
