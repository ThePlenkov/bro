/** The session-markers external-activity plane — a live foreign
 *  session that armed work in THIS repo (spec bro-eqi2d).
 *
 *  `<git-common>/bro/hooks/<session>.{work,task}` markers are how an
 *  interactive session proves it is working here (the occupancy plane
 *  reads the same files). A marker counts for the spawn guard when:
 *
 *  - its owner pid is ALIVE and its environ lacks the bro badges —
 *    BRO_AGENT_ID pins spawned workers (the `agent-<id>.work` a
 *    connector writes for its own registry agent), BRO_HOOKS=0 pins
 *    pooled acp children;
 *  - its mtime sits inside `holdMs` — the arm stamp is the session's
 *    last proven activity; a live owner with a stale marker is parked,
 *    not working.
 *
 *  Two populations never count: ownerless markers (a human shell's
 *  `bro work enter`, an old-format stamp — no agent owner is verifiable,
 *  and an unverifiable agent is NOT an external agent: the devin/
 *  opencode planes carry the fail-closed cases) and markers whose owner
 *  is dead (`markerLive`'s own verdict — residue, not a session). */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  markerOwner,
  ownedEnviron,
  pidAlive,
  registerExternalPlane,
  type ExternalActivity,
  type ExternalActivityPlane,
  type ExternalProbeCtx,
} from '@broject/core';
import { hooksDirOf } from '../commands/proc-owner.ts';

/** The marker suffixes a session arm writes — `.work` (session armed
 *  work) and `.task` (a claim arm). Both mean an agent is working this
 *  repo; the occupancy plane reads the same pair. */
const ARM_SUFFIXES = ['.work', '.task'] as const;

/** Is the marker's owning process bro-owned? Its /proc environ carries
 *  the badge — the same predicate the session planes apply. An
 *  unreadable environ cannot prove ownership → external. */
function ownerIsExternal(pid: number, start: string, procDir: string): boolean {
  if (!pidAlive(pid, start)) {
    return false;
  }
  try {
    return !ownedEnviron(readFileSync(join(procDir, String(pid), 'environ'), 'utf8'));
  } catch {
    return true;
  }
}

export function markersExternalActivity(ctx: ExternalProbeCtx): ExternalActivity {
  const bag = ctx.agents['session-markers'] ?? {};
  const procOverride = bag['procDir'];
  const procDir =
    typeof procOverride === 'string' && procOverride.trim() !== '' ? procOverride : '/proc';
  const hooksOverride = bag['hooksDir'];
  // the override wins — tests script a hooks dir outside any checkout;
  // hooksDirOf's null (not a repo) still means "no markers here"
  const dir =
    typeof hooksOverride === 'string' && hooksOverride.trim() !== ''
      ? hooksOverride
      : hooksDirOf(ctx.dir);
  if (dir === null) {
    return { active: false };
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { active: false };
  }
  let freshest: number | undefined;
  for (const name of names) {
    if (!ARM_SUFFIXES.some(s => name.endsWith(s))) {
      continue;
    }
    const path = join(dir, name);
    let firstLine: string;
    let mtimeMs: number;
    try {
      firstLine = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const owner = markerOwner(firstLine);
    if (owner === null) {
      continue; // no verifiable agent owner — a shell's arm, not a session
    }
    if (!ownerIsExternal(owner.pid, owner.start, procDir)) {
      continue;
    }
    if (freshest === undefined || mtimeMs > freshest) {
      freshest = mtimeMs;
    }
    if (ctx.now - mtimeMs < ctx.holdMs) {
      const dot = name.lastIndexOf('.');
      const session = dot > 0 ? name.slice(0, dot) : name;
      return {
        active: true,
        detail:
          `session '${session}' armed work here (owner pid ${owner.pid}, ` +
          `stamp ${Math.round(Math.max(0, ctx.now - mtimeMs) / 1000)}s ago)`,
        activityAtMs: mtimeMs,
      };
    }
  }
  return { active: false, activityAtMs: freshest };
}

export const markersExternalPlane: ExternalActivityPlane = {
  kind: 'session-markers',
  externalActivity: markersExternalActivity,
};

registerExternalPlane(markersExternalPlane);
