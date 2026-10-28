/**
 * mirror-pane mechanics — the read-only tail itself: the shell command
 * it runs, the pane it lives in, and the convergence decision for one
 * mirror (arm, adopt, close a dead tail, or leave the busy pane alone).
 */
import { basename } from 'node:path';
import {
  type HerdrPane,
  herdrTry,
  type MirrorRec,
  type PluginState,
  paneExists,
  paneIdle,
  paneList,
  pidAlive,
  type StatusAgent,
  shq,
} from './lib.ts';

const log = (s: string): void => console.log(`[reconcile] ${s}`);

/** An agent joined with the log it must tail. */
export interface MirrorSource extends StatusAgent {
  log: string;
  pidStart?: string;
}

/** Where the mirror lives and whose records update — bundles the args
 *  every mirror helper needs. */
export interface MirrorCtx {
  ws: string;
  worktreePath: string;
  state: PluginState;
}

/** The liveness probe inside the tail wrapper — pid reuse is real: a
 *  recycled pid would keep the tail (and the busy pane) alive forever,
 *  so when the registry recorded the process start token, /proc's
 *  starttime must match it too. */
function aliveProbe(pid: number, pidStart?: string): string {
  if (pidStart === undefined || pidStart === '') return `kill -0 ${pid} 2>/dev/null`;
  return (
    `kill -0 ${pid} 2>/dev/null && { [ ! -e /proc/${pid}/stat ] || ` +
    `[ "$(awk '{print $22}' /proc/${pid}/stat 2>/dev/null)" = ${shq(pidStart)} ]; }`
  );
}

/** Only a real positive pid can drive the watch loop — a missing or
 *  malformed one degrades to a plain tail. */
function livePid(pid?: number): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

/** Read-only shell text for a mirror pane: tail the agent log; when the
 *  recorded worker pid dies, kill the tail and mark the pane in place.
 *  The marker lands inside the pane — no bro write anywhere. Every
 *  interpolated value is shq'd — `pane run` executes this as shell. */
function mirrorCommand(a: MirrorSource): string {
  const marker = `echo ${shq(`── bro agent ${a.id} exited — tail closed ──`)}`;
  if (livePid(a.pid)) {
    return (
      `tail -n +1 -F ${shq(a.log)} & T=$!; ` +
      `while ${aliveProbe(a.pid, a.pidStart)}; do sleep 5; done; ` +
      `kill $T 2>/dev/null; ${marker}`
    );
  }
  return `tail -n +1 -F ${shq(a.log)}`;
}

/** One MirrorRec constructor — `keep` preserves an OLD attempt's
 *  identity (a busy pane still tailing the previous attempt must not
 *  be marked converged to the new one). */
function mirrorRecOf(a: MirrorSource, ctx: MirrorCtx, paneId: string, keep?: MirrorRec): MirrorRec {
  const id = keep ?? a;
  return {
    step: a.id,
    agentId: id.agentId,
    pid: id.pid,
    pidStart: id.pidStart,
    log: id.log,
    worktree: ctx.worktreePath,
    workspace: ctx.ws,
    pane_id: paneId,
    marked: false,
  };
}

/** Label the pane, run the tail wrapper into it, record the attempt.
 *  False when `pane run` never landed — the pane stays labeled but
 *  unarmed, and a later pass retries through the orphan path. */
function armMirrorPane(a: MirrorSource, paneId: string, ctx: MirrorCtx): boolean {
  herdrTry(['pane', 'rename', paneId, `bro: ${a.id}`]);
  const ran = herdrTry(['pane', 'run', paneId, mirrorCommand(a)]);
  if (ran === undefined) return false;
  ctx.state.mirrors[a.id] = mirrorRecOf(a, ctx, paneId);
  return true;
}

/** A busy pane under a moved attempt whose RECORDED worker is provably
 *  dead is a dead man's tail. */
function deadTail(moved: boolean, rec: MirrorRec | undefined): boolean {
  return moved && rec?.pid !== undefined && !pidAlive(rec.pid, rec.pidStart);
}

/** Record the pane as this attempt's mirror without touching its shell
 *  — a busy pane under a moved attempt keeps its OLD identity: writing
 *  the new agentId/pid now would mark the stale pane converged and it
 *  would show the dead attempt's log forever. */
function adoptMirrorPane(
  a: MirrorSource,
  target: { paneId: string; orphanLabel?: string },
  moved: boolean,
  ctx: MirrorCtx
): void {
  const rec = ctx.state.mirrors[a.id];
  if (target.orphanLabel?.startsWith('✖') === true) {
    herdrTry(['pane', 'rename', target.paneId, `bro: ${a.id}`]);
  }
  ctx.state.mirrors[a.id] = mirrorRecOf(a, ctx, target.paneId, moved ? rec : undefined);
  if (rec?.pane_id !== target.paneId) log(`adopted mirror ${target.paneId} for ${a.id}`);
}

/** An existing mirror pane under a moved-or-same attempt: re-arm when
 *  the pane is idle, close a provably dead worker's stale tail, else
 *  adopt/record without touching the busy shell. */
function convergeMirrorPane(
  a: MirrorSource,
  target: { paneId: string; orphanLabel?: string },
  moved: boolean,
  ctx: MirrorCtx
): void {
  const rec = ctx.state.mirrors[a.id];
  if (moved && paneIdle(target.paneId)) {
    log(
      armMirrorPane(a, target.paneId, ctx)
        ? `re-arm mirror ${target.paneId} → ${a.agentId ?? a.id}`
        : `re-arm mirror ${target.paneId}: pane run failed`
    );
    return;
  }
  if (deadTail(moved, rec)) {
    herdrTry(['pane', 'close', target.paneId]);
    delete ctx.state.mirrors[a.id];
    log(`closed stale mirror ${target.paneId} — worker pid ${rec?.pid} is dead`);
    return;
  }
  adoptMirrorPane(a, target, moved, ctx);
}

/** The new pane a `pane split` produced, or undefined on failure. */
function splitPane(targetId: string, cwd: string): string | undefined {
  return herdrTry<{ pane?: { pane_id?: string } }>([
    'pane',
    'split',
    targetId,
    '--direction',
    'down',
    '--cwd',
    cwd,
    '--no-focus',
  ])?.pane?.pane_id;
}

/** No usable pane → split one below an idle target and arm it. */
function splitMirrorPane(a: MirrorSource, panes: HerdrPane[], ctx: MirrorCtx): void {
  const target = panes.find(p => paneIdle(p.pane_id)) ?? panes[0];
  const newPane = target === undefined ? undefined : splitPane(target.pane_id, ctx.worktreePath);
  if (newPane === undefined) {
    log(`mirror ${a.id}: no pane split in ${ctx.ws}`);
    return;
  }
  log(
    armMirrorPane(a, newPane, ctx)
      ? `mirror ${a.id} → ${newPane} (tail ${basename(a.log)})`
      : `mirror ${a.id} → ${newPane}: pane run failed`
  );
}

/** An unrecorded pane still carrying our label — adoptable. */
function orphanPane(step: string, panes: HerdrPane[]): HerdrPane | undefined {
  return panes.find(p => p.label === `bro: ${step}` || p.label?.startsWith(`✖ bro: ${step}`));
}

/** The recorded pane, when it still exists. */
function recordedPane(rec: MirrorRec | undefined): string | undefined {
  return rec !== undefined && paneExists(rec.pane_id) ? rec.pane_id : undefined;
}

/** The pane that can serve as this worker's mirror: the recorded one,
 *  or an orphan still carrying the label we gave it (a rec lost to a
 *  flaky probe must never cost a duplicate pane). */
function mirrorPaneFor(
  step: string,
  rec: MirrorRec | undefined,
  panes: HerdrPane[]
): { paneId: string; orphanLabel?: string } | undefined {
  const orphan = orphanPane(step, panes);
  const paneId = recordedPane(rec) ?? orphan?.pane_id;
  return paneId === undefined ? undefined : { paneId, orphanLabel: orphan?.label };
}

/** A pane whose attempt moved on: different pane, agent, or pid than
 *  the record holds. */
function attemptMoved(rec: MirrorRec | undefined, paneId: string, a: MirrorSource): boolean {
  return rec?.pane_id !== paneId || rec?.agentId !== a.agentId || rec?.pid !== a.pid;
}

/** One mirror's convergence for a pass: find-or-split the pane, then
 *  re-arm/adopt/leave as the attempt's move and the pane's busyness
 *  dictate. */
export function ensureMirror(a: MirrorSource, ctx: MirrorCtx): void {
  const rec = ctx.state.mirrors[a.id];
  const panes = paneList(ctx.ws);
  const target = mirrorPaneFor(a.id, rec, panes);
  if (target === undefined) {
    splitMirrorPane(a, panes, ctx);
    return;
  }
  // re-arm only when the pane changed hands or the attempt moved on —
  // a quiet glimpse of the same attempt's own tail-watcher must not
  // queue another command into its busy shell
  convergeMirrorPane(a, target, attemptMoved(rec, target.paneId, a), ctx);
}
