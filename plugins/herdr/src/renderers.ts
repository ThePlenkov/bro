/**
 * renderers — one renderer pane per managed workspace (spec bro-8dbyb).
 * A live-agent mirror (mirrors.ts) is the renderer while one runs; the
 * fallback is an event tail: a pane running a resilient `bro bus
 * subscribe` loop so the workspace never sits on an empty root
 * terminal. bro state is never written — pane mechanics only.
 */
import {
  boundPaneIds,
  BRO,
  type HerdrPane,
  herdrOk,
  herdrTry,
  type PluginState,
  paneExists,
  paneIdle,
  paneList,
  RENDER_LABEL,
  type RendererRec,
  shq,
  STATUS_LABEL,
} from './lib.ts';

const log = (s: string): void => console.log(`[reconcile] ${s}`);

/** The tail's shell text — a subscribe retry loop, never a bare `die`:
 *  broker-down is routine, so each exit prints its banner and waits.
 *  `pane run` executes this as shell; every interpolation is shq'd. */
function tailCommand(worktreePath: string): string {
  const sub = `${shq(BRO)} bus subscribe --topic worker --topic worktree --topic notify --topic gate`;
  return (
    `cd ${shq(worktreePath)} && while :; do ${sub}; ` +
    `echo ${shq('── bus tail ended — retry in 5s ──')}; sleep 5; done`
  );
}

/** The (path, ws, state) triple every renderer step needs — one
 *  argument, never three strings threaded apart. */
export interface RenderCtx {
  path: string;
  ws: string;
  state: PluginState;
}

/** Label the pane, run the tail, record it. False when `pane run`
 *  never landed — a later pass retries through the same path. */
function armRenderer(ctx: RenderCtx, paneId: string): boolean {
  herdrTry(['pane', 'rename', paneId, RENDER_LABEL]);
  if (!herdrOk(['pane', 'run', paneId, tailCommand(ctx.path)])) return false;
  ctx.state.renderers[ctx.path] = { workspace: ctx.ws, worktree: ctx.path, pane_id: paneId };
  return true;
}

/** The new pane a `pane split` produced, or undefined on failure. */
function splitPane(targetId: string, ctx: RenderCtx): string | undefined {
  return herdrTry<{ pane?: { pane_id?: string } }>([
    'pane',
    'split',
    targetId,
    '--direction',
    'down',
    '--cwd',
    ctx.path,
    '--no-focus',
  ])?.pane?.pane_id;
}

/** A live mirror already renders this workspace — the tail is
 *  redundant while it does. A `marked` rec is an exit marker: its pane
 *  stays open on purpose but nothing is rendering, so it does NOT
 *  count — the fallback tail takes over. */
function wsHasLiveMirror(ws: string, state: PluginState): boolean {
  return Object.values(state.mirrors).some(
    m => m.workspace === ws && m.marked !== true && paneExists(m.pane_id)
  );
}

/** Close the redundant tail under a live mirror — recorded pane or
 *  orphan-labeled one, either way it goes. */
function retireTail(rec: RendererRec | undefined, ctx: RenderCtx): void {
  const stale =
    rec !== undefined && paneExists(rec.pane_id)
      ? rec.pane_id
      : paneList(ctx.ws).find(x => x.label === RENDER_LABEL)?.pane_id;
  if (stale !== undefined) {
    herdrTry(['pane', 'close', stale]);
    log(`retire events pane ${stale} — a live mirror renders ${ctx.ws}`);
  }
  delete ctx.state.renderers[ctx.path];
}

/** Arm `paneId` and report the outcome — '(adopted)' when the pane
 *  already carried our label. */
function armAndReport(ctx: RenderCtx, paneId: string, adopted: boolean): void {
  if (!armRenderer(ctx, paneId)) {
    log(`events pane ${paneId} → ${ctx.ws}: pane run failed`);
    return;
  }
  log(`events pane ${paneId} → ${ctx.ws}${adopted ? ' (adopted)' : ''}`);
}

/** No live pane to take — split below the first pane, then arm. */
function armViaSplit(ctx: RenderCtx, panes: HerdrPane[]): void {
  const target = panes[0];
  const newPane = target === undefined ? undefined : splitPane(target.pane_id, ctx);
  if (newPane === undefined) {
    log(`renderer for ${ctx.ws}: no pane to arm or split`);
    return;
  }
  armAndReport(ctx, newPane, false);
}

/** One workspace's renderer convergence: retire the tail when a mirror
 *  renders the workspace; otherwise record/adopt/arm/split so exactly
 *  one `bro: events` pane lives. Managed workspaces only — a user's
 *  own workspace is never given a pane it did not ask for. */
export function ensureRenderer(ctx: RenderCtx): void {
  const rec = ctx.state.renderers[ctx.path];
  if (wsHasLiveMirror(ctx.ws, ctx.state)) {
    retireTail(rec, ctx);
    return;
  }
  // a recorded pane that still exists but idles means the tail died —
  // the pane is a live shell; re-arm it rather than counting it done
  if (rec !== undefined && paneExists(rec.pane_id)) {
    if (!paneIdle(rec.pane_id)) return;
    armAndReport(ctx, rec.pane_id, true);
    return;
  }

  const panes = paneList(ctx.ws);
  const bound = boundPaneIds(ctx.state);
  const orphan = panes.find(p => p.label === RENDER_LABEL && !bound.has(p.pane_id));
  const paneId =
    orphan?.pane_id ??
    panes.find(p => !bound.has(p.pane_id) && p.label !== STATUS_LABEL && paneIdle(p.pane_id))
      ?.pane_id;
  if (paneId === undefined) {
    armViaSplit(ctx, panes);
    return;
  }
  armAndReport(ctx, paneId, orphan !== undefined);
}

/** Workspaces that lost their arm get their tail record dropped — the
 *  workspace itself is the caller's (or the reaper's) problem, the
 *  record is ours: a rec pointing at a closed workspace can never
 *  resurrect a pane there. */
export function dropOrphanRenderers(state: PluginState, liveWsIds: Set<string>): void {
  for (const [path, rec] of Object.entries(state.renderers)) {
    if (!liveWsIds.has(rec.workspace)) {
      delete state.renderers[path];
    }
  }
}
