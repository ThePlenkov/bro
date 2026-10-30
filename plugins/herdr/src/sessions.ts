/**
 * sessions — one `bro: session` pane per managed workspace (spec
 * bro-nwl5g). The pane runs `bro herdr session-view <worktree>` — a
 * readonly conversation view: an ACP `session/load` attach when the
 * worktree's provider resolves to a `type === 'acp'` command, the
 * agent's native log tail otherwise. Same convergence discipline as
 * statuses.ts: recorded pane → orphan label → split; an idle recorded
 * pane re-arms in place; a stale record pointing at a dead workspace
 * is dropped, never resurrected. bro state is never written — pane
 * mechanics only.
 */
import {
  boundPaneIds,
  BRO,
  BRO_LABELS,
  type HerdrPane,
  herdrOk,
  herdrTry,
  paneExists,
  paneIdle,
  paneList,
  type PluginState,
  SESSION_LABEL,
  shq,
} from './lib.ts';
import type { RenderCtx } from './renderers.ts';

const log = (s: string): void => console.log(`[reconcile] ${s}`);

/** The pane's own split share — a conversation column, not a strip:
 *  `--ratio` is the TARGET pane's retained share, so the new pane
 *  lands ~45% of the main pane's width. */
const SESSION_RATIO = '0.55';

function sessionCommand(worktreePath: string): string {
  return `${shq(BRO)} herdr session-view ${shq(worktreePath)}`;
}

/** Label the pane, run session-view into it, record the binding.
 *  False when `pane run` never landed — a later pass retries through
 *  the same path. */
function armSession(ctx: RenderCtx, paneId: string): boolean {
  herdrTry(['pane', 'rename', paneId, SESSION_LABEL]);
  if (!herdrOk(['pane', 'run', paneId, sessionCommand(ctx.path)])) return false;
  ctx.state.sessions[ctx.path] = { workspace: ctx.ws, worktree: ctx.path, pane_id: paneId };
  return true;
}

/** The new pane a `pane split` produced — a right-hand column beside
 *  the target, or undefined on failure. */
function splitPane(targetId: string, ctx: RenderCtx): string | undefined {
  return herdrTry<{ pane?: { pane_id?: string } }>([
    'pane',
    'split',
    targetId,
    '--direction',
    'right',
    '--ratio',
    SESSION_RATIO,
    '--cwd',
    ctx.path,
    '--no-focus',
  ])?.pane?.pane_id;
}

/** Arm `paneId` and report the outcome — '(adopted)' when the pane
 *  already carried our label. */
function armAndReport(ctx: RenderCtx, paneId: string, adopted: boolean): void {
  if (!armSession(ctx, paneId)) {
    log(`session pane ${paneId} → ${ctx.ws}: pane run failed`);
    return;
  }
  log(`session pane ${paneId} → ${ctx.ws}${adopted ? ' (adopted)' : ''}`);
}

/** No live pane to take — split beside the first pane, then arm. */
function armViaSplit(ctx: RenderCtx, panes: HerdrPane[]): void {
  const target = panes[0];
  const newPane = target === undefined ? undefined : splitPane(target.pane_id, ctx);
  if (newPane === undefined) {
    log(`session pane for ${ctx.ws}: no pane to arm or split`);
    return;
  }
  armAndReport(ctx, newPane, false);
}

/** The pane the session role may take: an unbound orphan carrying our
 *  label first, then any idle pane not bound to another bro role and
 *  not wearing any bro-role label. */
function pickPane(panes: HerdrPane[], bound: Set<string>): { id?: string; adopted: boolean } {
  const orphan = panes.find(p => p.label === SESSION_LABEL && !bound.has(p.pane_id));
  if (orphan !== undefined) return { id: orphan.pane_id, adopted: true };
  const free = panes.find(
    p =>
      !bound.has(p.pane_id) &&
      (p.label === undefined || !BRO_LABELS.has(p.label)) &&
      paneIdle(p.pane_id)
  );
  return { ...(free !== undefined ? { id: free.pane_id } : {}), adopted: false };
}

/** One workspace's session-pane convergence: record → re-arm/adopt →
 *  orphan-label → idle pane → split, so exactly one `bro: session`
 *  lives per managed workspace alongside `bro: status`. */
export function ensureSession(ctx: RenderCtx): void {
  const rec = ctx.state.sessions[ctx.path];
  // a recorded pane that still exists but idles means session-view
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

/** Workspaces that lost their arm get their session record dropped —
 *  the workspace itself is the caller's (or the reaper's) problem,
 *  the record is ours: a rec pointing at a closed workspace can never
 *  resurrect a pane there. */
export function dropOrphanSessions(state: PluginState, liveWsIds: Set<string>): void {
  for (const [path, rec] of Object.entries(state.sessions)) {
    if (!liveWsIds.has(rec.workspace)) {
      delete state.sessions[path];
    }
  }
}
