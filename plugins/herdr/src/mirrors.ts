/**
 * mirror convergence driver — join live native agents to the log +
 * worktree a mirror needs, then converge one pane per worker inside
 * the workspace its worktree owns. Pane mechanics live in
 * mirror-pane.ts; bro state is never written.
 */
import { existsSync } from 'node:fs';
import {
  type AgentEntry,
  herdrTry,
  type PluginState,
  paneGone,
  paneList,
  type StatusAgent,
} from './lib.ts';
import { laneOf } from './lanes.ts';
import { ensureMirror, type MirrorCtx, type MirrorSource } from './mirror-pane.ts';
import type { Planes } from './planes.ts';

const log = (s: string): void => console.log(`[reconcile] ${s}`);

/** The acp lane shows exactly one pane — the session view folds the
 *  worker's feed in like the status and events panes (spec bro-l8wqu).
 *  Close the recorded pane or an orphan still carrying our label; the
 *  record drops either way so a later non-acp flip re-arms fresh. */
export function retireMirror(step: string, ctx: MirrorCtx): void {
  const rec = ctx.state.mirrors[step];
  const stale =
    rec !== undefined && !paneGone(rec.pane_id)
      ? rec.pane_id
      : paneList(ctx.ws).find(
          x => x.label === `bro: ${step}` || x.label?.startsWith(`✖ bro: ${step}`)
        )?.pane_id;
  if (stale !== undefined) {
    herdrTry(['pane', 'close', stale]);
    log(`retire mirror ${stale} — session pane is the one human pane (${ctx.ws})`);
  }
  delete ctx.state.mirrors[step];
}

/** Mirrors whose worker left the fleet get the ✖ mark in place; a
 *  pane that vanished drops its record (the next pass re-mirrors if
 *  the worker still runs). On the acp lane the mirror retires
 *  outright — the session pane is the lane's one pane, exit marker
 *  or not (spec bro-l8wqu). */
export function markExitedMirrors(p: Planes, state: PluginState): void {
  const live = new Map(p.status.fleet.agents.map(a => [a.id, a]));
  for (const [step, rec] of Object.entries(state.mirrors)) {
    // an acp-lane worktree has exactly one pane — its mirror record
    // retires outright, never lingers as an exit marker
    if (laneOf(p.lanes, rec.worktree) === 'acp') {
      retireMirror(step, { ws: rec.workspace, worktreePath: rec.worktree, state });
      continue;
    }
    const a = live.get(step);
    if (a !== undefined && a.state === 'running') continue;

    if (paneGone(rec.pane_id)) {
      delete state.mirrors[step];
      continue;
    }
    if (rec.marked !== true) {
      const cause = a?.cause !== undefined ? ` (${a.cause})` : '';
      herdrTry(['pane', 'rename', rec.pane_id, `✖ bro: ${step}${cause}`]);
      state.mirrors[step] = { ...rec, marked: true };
      log(`mark ${rec.pane_id} — ${step} exited${cause}`);
    }
  }
}

interface MirrorJob extends MirrorSource {
  worktreePath: string;
}

/** The worktree a mirror must split into: the registry's absolute path
 *  when it still exists, else the status plane's name match. */
function mirrorWorktree(a: StatusAgent, p: Planes): string | undefined {
  const reg = p.registry[a.id];
  if (reg?.worktree !== undefined && existsSync(reg.worktree)) return reg.worktree;
  return p.status.worktrees.find(t => t.name === a.worktree)?.path;
}

/** Attempt identity — status's fields win when the running build
 *  provides them; the registry entry is the fallback plane. */
function attemptOf(
  a: StatusAgent,
  reg?: AgentEntry
): {
  agentId?: string;
  pid?: number;
  pidStart?: string;
} {
  return {
    agentId: a.agentId ?? reg?.agentId,
    pid: a.pid ?? reg?.pid,
    pidStart: typeof reg?.pidStart === 'string' ? reg.pidStart : undefined,
  };
}

/** A live native agent → its mirror job, or undefined when the join
 *  can't produce a tailable log + worktree pair. The registry plane
 *  carries the attempt's log/abs-worktree (status's `log`/`agentId`
 *  fields join when the running build provides them). */
function mirrorJobFor(a: StatusAgent, p: Planes): MirrorJob | undefined {
  if (a.backend !== 'native' || a.state !== 'running') return undefined;
  const reg = p.registry[a.id];
  const logPath = a.log ?? reg?.log;
  const worktreePath = mirrorWorktree(a, p);
  if (logPath === undefined || worktreePath === undefined) return undefined;
  return { ...a, ...attemptOf(a, reg), log: logPath, worktreePath };
}

/** A mirror pane tailing each live native agent's log, inside the
 *  workspace its worktree resolved to. */
export function convergeMirrors(
  p: Planes,
  wsForPath: Map<string, string>,
  openByPath: Map<string, string>,
  state: PluginState
): void {
  for (const a of p.status.fleet.agents) {
    const job = mirrorJobFor(a, p);
    if (job === undefined) continue;
    const ws = wsForPath.get(job.worktreePath) ?? openByPath.get(job.worktreePath);
    if (ws === undefined) continue;
    // the acp lane shows exactly one pane — the session view folds
    // the native-log tail in (spec bro-l8wqu)
    const ctx = { ws, worktreePath: job.worktreePath, state };
    if (laneOf(p.lanes, job.worktreePath) === 'acp') retireMirror(a.id, ctx);
    else ensureMirror(job, ctx);
  }
}
