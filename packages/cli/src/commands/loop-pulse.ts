/**
 * The loop connector — the installed loop path's rearm checkpoint
 * Mirrors drive: `bro loop install` arms `<git-common>/bro/loop.json`; every lifecycle event then re-checks
 * the want against the supervisor's liveness and spawns `bro daemon run --loop`.
 */
import type { Connector, ConnectorCtx } from '@broject/core';
import { readLoopMarker } from './want-marker.ts';

async function supervisorCheckpoint(dir: string, where: string): Promise<string[]> {
  try {
    // quiescence gate — same contract as drive-pulse.ts: no want-marker
    // ⇒ `loopRearm` is definitionally quiet, so daemon.ts (and the
    // registry behind it) stays out of unarmed hook events
    // (specs/bro-36sx7.7.md).
    if (readLoopMarker(dir) === null) {
      return [];
    }
    const { loopRearm, supervisorUp } = await import('./daemon.ts');
    const r = loopRearm(dir);
    if (r.kind !== 'rearm') {
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
      return supervisorCheckpoint(ctx.dir, 'session start');
    },
    postTool(ctx: ConnectorCtx) {
      return supervisorCheckpoint(ctx.dir, 'tool call');
    },
  }),
};
