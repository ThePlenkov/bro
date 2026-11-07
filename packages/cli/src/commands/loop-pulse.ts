/**
 * The loop connector — the installed loop path's rearm checkpoint
 * Mirrors drive: `bro loop install` arms `<git-common>/bro/loop.json`; every lifecycle event then re-checks
 * the want against the supervisor's liveness and spawns `bro daemon run --loop`.
 */
import type { Connector, ConnectorCtx } from '@broject/core';

async function supervisorCheckpoint(dir: string, where: string): Promise<string[]> {
  try {
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
