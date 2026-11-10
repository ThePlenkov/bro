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
  SpawnError,
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

/** The hooks dir the probe scans — the override wins (tests script a
 *  hooks dir outside any checkout); hooksDirOf's null (not a repo)
 *  still means "no markers here". */
function markersDir(ctx: ExternalProbeCtx): string | null {
  const override = ctx.agents['session-markers']?.['hooksDir'];
  return typeof override === 'string' && override.trim() !== '' ? override : hooksDirOf(ctx.dir);
}

/** The /proc root owner checks read — `agents.session-markers.procDir`
 *  overrides for tests (a scripted /proc tree). */
function markersProcDir(ctx: ExternalProbeCtx): string {
  const override = ctx.agents['session-markers']?.['procDir'];
  return typeof override === 'string' && override.trim() !== '' ? override : '/proc';
}

/** Every name in the hooks dir — a missing dir is "no markers here";
 *  any OTHER listing failure is an unverifiable scan and fails closed
 *  like the devin lock scan (a dir that cannot be read may hold a live
 *  foreign arm). */
function markerNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new SpawnError(
      `cannot verify session markers — ${dir}: ${(err as Error).message}`,
      'unavailable'
    );
  }
}

/** One marker's verdict — session + stamp when it proves a live
 *  foreign session armed work here, undefined otherwise: not an arm
 *  file, unreadable (raced away mid-read), ownerless, bro-owned, or
 *  owned by a dead pid. */
function externalArm(
  dir: string,
  name: string,
  procDir: string
): { session: string; pid: number; mtimeMs: number } | undefined {
  if (!ARM_SUFFIXES.some(s => name.endsWith(s))) {
    return undefined;
  }
  const path = join(dir, name);
  try {
    const firstLine = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
    const owner = markerOwner(firstLine);
    // ownerless: no verifiable agent owner — a shell's arm, not a session
    if (owner === null || !ownerIsExternal(owner.pid, owner.start, procDir)) {
      return undefined;
    }
    const dot = name.lastIndexOf('.');
    return {
      session: dot > 0 ? name.slice(0, dot) : name,
      pid: owner.pid,
      mtimeMs: statSync(path).mtimeMs,
    };
  } catch {
    return undefined;
  }
}

export function markersExternalActivity(ctx: ExternalProbeCtx): ExternalActivity {
  const dir = markersDir(ctx);
  if (dir === null) {
    return { active: false };
  }
  const procDir = markersProcDir(ctx);
  let freshest: number | undefined;
  for (const name of markerNames(dir)) {
    const arm = externalArm(dir, name, procDir);
    if (arm === undefined) {
      continue;
    }
    if (freshest === undefined || arm.mtimeMs > freshest) {
      freshest = arm.mtimeMs;
    }
    if (ctx.now - arm.mtimeMs < ctx.holdMs) {
      return {
        active: true,
        detail:
          `session '${arm.session}' armed work here (owner pid ${arm.pid}, ` +
          `stamp ${Math.round(Math.max(0, ctx.now - arm.mtimeMs) / 1000)}s ago)`,
        activityAtMs: arm.mtimeMs,
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
