/**
 * statuses — one `bro: status` pane per managed workspace (spec
 * bro-idsat). The pane runs `bro herdr status-view <worktree>` — the
 * fleet LED's primary self-reporter; while it occupies the pane
 * foreground its `bro:fleet` authority holds. Same convergence
 * discipline as renderers.ts: recorded pane → orphan label → split;
 * an idle recorded pane re-arms in place; a stale record pointing at
 * a dead workspace is dropped, never resurrected. bro state is never
 * written — pane mechanics only.
 */
import {
  boundPaneIds,
  BRO,
  type HerdrPane,
  herdrOk,
  herdrTry,
  paneExists,
  paneIdle,
  paneList,
  type PluginState,
  RENDER_LABEL,
  shq,
  STATUS_LABEL,
} from './lib.ts';
import type { RenderCtx } from './renderers.ts';

const log = (s: string): void => console.log(`[reconcile] ${s}`);

/** The pane's own split share — a status strip, not a half screen:
 *  `--ratio` is the TARGET pane's retained share, so the new pane
 *  lands ~15%. */
const STATUS_RATIO = '0.85';

function statusCommand(worktreePath: string): string {
  return `${shq(BRO)} herdr status-view ${shq(worktreePath)}`;
}

/** Label the pane, run status-view into it, record the binding.
 *  False when `pane run` never landed — a later pass retries through
 *  the same path. */
function armStatus(ctx: RenderCtx, paneId: string): boolean {
  herdrTry(['pane', 'rename', paneId, STATUS_LABEL]);
  if (!herdrOk(['pane', 'run', paneId, statusCommand(ctx.path)])) return false;
  ctx.state.statuses[ctx.path] = { workspace: ctx.ws, worktree: ctx.path, pane_id: paneId };
  return true;
}

/** The new pane a `pane split` produced — a thin strip under the
 *  target, or undefined on failure. */
function splitPane(targetId: string, ctx: RenderCtx): string | undefined {
  return herdrTry<{ pane?: { pane_id?: string } }>([
    'pane',
    'split',
    targetId,
    '--direction',
    'down',
    '--ratio',
    STATUS_RATIO,
    '--cwd',
    ctx.path,
    '--no-focus',
  ])?.pane?.pane_id;
}

/** Arm `paneId` and report the outcome — '(adopted)' when the pane
 *  already carried our label. */
function armAndReport(ctx: RenderCtx, paneId: string, adopted: boolean): void {
  if (!armStatus(ctx, paneId)) {
    log(`status pane ${paneId} → ${ctx.ws}: pane run failed`);
    return;
  }
  log(`status pane ${paneId} → ${ctx.ws}${adopted ? ' (adopted)' : ''}`);
}

/** No live pane to take — split below the first pane, then arm. */
function armViaSplit(ctx: RenderCtx, panes: HerdrPane[]): void {
  const target = panes[0];
  const newPane = target === undefined ? undefined : splitPane(target.pane_id, ctx);
  if (newPane === undefined) {
    log(`status pane for ${ctx.ws}: no pane to arm or split`);
    return;
  }
  armAndReport(ctx, newPane, false);
}

/** The pane the status role may take: an unbound orphan carrying our
 *  label first, then any idle pane not bound to another bro role and
 *  not wearing the renderer's label. */
function pickPane(panes: HerdrPane[], bound: Set<string>): { id?: string; adopted: boolean } {
  const orphan = panes.find(p => p.label === STATUS_LABEL && !bound.has(p.pane_id));
  if (orphan !== undefined) return { id: orphan.pane_id, adopted: true };
  const free = panes.find(
    p => !bound.has(p.pane_id) && p.label !== RENDER_LABEL && paneIdle(p.pane_id)
  );
  return { ...(free !== undefined ? { id: free.pane_id } : {}), adopted: false };
}

/** One workspace's status-pane convergence: record → re-arm/adopt →
 *  orphan-label → idle pane → split, so exactly one `bro: status`
 *  lives per managed workspace. The status pane is not a mirror
 *  substitute — it stays armed while mirrors render the workspace. */
export function ensureStatus(ctx: RenderCtx): void {
  const rec = ctx.state.statuses[ctx.path];
  // a recorded pane that still exists but idles means status-view
  // died — the pane is a live shell; re-arm it rather than counting
  // it done
  if (rec !== undefined && paneExists(rec.pane_id)) {
    if (!paneIdle(rec.pane_id)) return;
    armAndReport(ctx, rec.pane_id, true);
    return;
  }

  const panes = paneList(ctx.ws);
  const pick = pickPane(panes, boundPaneIds(ctx.state));
  if (pick.id === undefined) {
    armViaSplit(ctx, panes);
    return;
  }
  armAndReport(ctx, pick.id, pick.adopted);
}

/** Workspaces that lost their arm get their status record dropped —
 *  the workspace itself is the caller's (or the reaper's) problem,
 *  the record is ours: a rec pointing at a closed workspace can never
 *  resurrect a pane there. */
export function dropOrphanStatuses(state: PluginState, liveWsIds: Set<string>): void {
  for (const [path, rec] of Object.entries(state.statuses)) {
    if (!liveWsIds.has(rec.workspace)) {
      delete state.statuses[path];
    }
  }
}
