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
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  decideSession,
  decideSessionRetire,
  dropOrphanRecords,
  type SessionRec,
  sessionViewCommand,
} from '../../../packages/herdr-kit/src/index.ts';
import {
  BRO,
  BRO_LABELS,
  boundPaneIds,
  type HerdrPane,
  herdrOk,
  herdrTry,
  PLUGIN_ROOT,
  type PluginState,
  paneExists,
  paneIdle,
  paneList,
  SESSION_LABEL,
  shq,
} from './lib.ts';
import type { RenderCtx } from './renderers.ts';

const log = (s: string): void => console.log(`[reconcile] ${s}`);

/** The pane's own split share — a conversation column, not a strip:
 *  `--ratio` is the TARGET pane's retained share, so the new pane
 *  lands ~45% of the main pane's width. */
const SESSION_RATIO = '0.55';

/** The OpenTUI entrypoint under the plugin root (spec bro-q2edc). */
const TUI_MAIN = join(PLUGIN_ROOT, 'tui', 'main.ts');

/** The TUI's runtime — `BUN_BIN_PATH` is the live override (a path
 *  wins, the empty string forces the fallback — tests and operators
 *  pin the mode without touching PATH); unset means probe `bun
 *  --version` once and cache. Without bun the session pane degrades
 *  to the line-mode session-view, never breaks. */
let probedBun: string | null | undefined;
export function bun(): string | undefined {
  const env = process.env.BUN_BIN_PATH;
  if (env !== undefined) return env === '' ? undefined : env;
  if (probedBun === undefined) {
    const ok = spawnSync('bun', ['--version'], { stdio: 'ignore' }); // NOSONAR — PATH lookup is the contract
    probedBun = ok.error === undefined && ok.status === 0 ? 'bun' : null;
  }
  return probedBun ?? undefined;
}

/** The pane command — the OpenTUI app when its entrypoint + runtime
 *  resolve, the line-mode session-view otherwise. A resolved agent
 *  binds the archive directly (`--events`/`--agent`): the worktree→
 *  projector→journal path breaks on lanes the doc never marks acp. */
export function sessionCommand(
  worktreePath: string,
  agent?: { id: string; events: string }
): string {
  const b = existsSync(TUI_MAIN) ? bun() : undefined;
  return sessionViewCommand(
    worktreePath,
    { ...(b !== undefined ? { bun: b, tui: TUI_MAIN } : {}), bro: BRO },
    shq,
    agent
  );
}

/** Label the pane, run session-view into it, record the binding.
 *  False when `pane run` never landed — a later pass retries through
 *  the same path. */
function armSession(ctx: RenderCtx, paneId: string): boolean {
  herdrTry(['pane', 'rename', paneId, SESSION_LABEL]);
  if (!herdrOk(['pane', 'run', paneId, sessionCommand(ctx.path, ctx.agent)])) return false;
  // the record REPLACES on every arm — the close ledger must ride it
  // or a rebind/rearm silently orphans the stale panes it still owes
  const prev = ctx.state.sessions[ctx.path];
  ctx.state.sessions[ctx.path] = {
    workspace: ctx.ws,
    worktree: ctx.path,
    pane_id: paneId,
    agent_id: ctx.agent?.id,
    ...(prev !== undefined && (prev.closePending?.length ?? 0) > 0
      ? { closePending: prev.closePending }
      : {}),
  };
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
 *  already carried our label. False when `pane run` never landed —
 *  the caller must not treat the idle shell as a live session pane. */
function armAndReport(ctx: RenderCtx, paneId: string, adopted: boolean): boolean {
  if (!armSession(ctx, paneId)) {
    log(`session pane ${paneId} → ${ctx.ws}: pane run failed`);
    return false;
  }
  log(`session pane ${paneId} → ${ctx.ws}${adopted ? ' (adopted)' : ''}`);
  return true;
}

/** How long a failed rebind waits before the next attempt — long
 *  enough that a persistent `pane run` failure is not a pane churn. */
const REBIND_BACKOFF_MS = 60_000;

/** No live pane to take — split beside the first pane, then arm.
 *  False when no pane could be split or the arm never landed. */
function armViaSplit(ctx: RenderCtx, panes: HerdrPane[]): boolean {
  const target = panes[0];
  const newPane = target === undefined ? undefined : splitPane(target.pane_id, ctx);
  if (newPane === undefined) {
    log(`session pane for ${ctx.ws}: no pane to arm or split`);
    return false;
  }
  return armAndReport(ctx, newPane, false);
}

/** Is a live session pane bound after the pass — the caller's retire
 *  gate: fallback surfaces fold only where the human pane actually
 *  exists, not merely where it was eligible to arm. */
function paneLive(ctx: RenderCtx): boolean {
  const r = ctx.state.sessions[ctx.path];
  return r !== undefined && paneExists(r.pane_id);
}

/** Stale panes the last rebinds could not close — retried at the top
 *  of every pass so they do not linger showing the old archive. A
 *  pending id is only ours to close while it still carries the
 *  session label — a recycled pane id wearing a foreign label is a
 *  user's pane now; it drops off the ledger, never gets killed. */
function retryClose(ctx: RenderCtx, rec: SessionRec | undefined, panes: HerdrPane[]): void {
  const pending = rec?.closePending;
  if (pending === undefined || pending.length === 0) return;
  const ours = (id: string): boolean =>
    panes.some(p => p.pane_id === id && p.label === SESSION_LABEL);
  const left = pending.filter(id => ours(id) && !herdrOk(['pane', 'close', id]));
  const { closePending: _closePending, ...rest } = rec;
  ctx.state.sessions[ctx.path] = left.length === 0 ? rest : { ...rest, closePending: left };
}

/** The binding moved (new agent, or a dead record now resolves) — the
 *  running pane is pinned to the old archive. Arm the replacement
 *  FIRST: closing the workspace's last pane before its successor
 *  exists auto-reaps the whole workspace mid-pass (dogfood reap —
 *  the same constraint the arm-order follows). False while no new
 *  pane is bound — a backed-off or failed rebind reports the stale
 *  pane as it is: not a live session view (the caller's fallback
 *  surfaces still arm). */
function rebind(ctx: RenderCtx, rec: SessionRec | undefined, paneId: string): boolean {
  if (rec?.retryAt !== undefined && rec.retryAt > Date.now()) {
    // a failed arm is still backing off — keep the stale pane, but it
    // is bound to the old archive: not the pass's live session pane
    return false;
  }
  const next = splitPane(paneId, ctx);
  if (next !== undefined && armSession(ctx, next)) {
    if (!herdrOk(['pane', 'close', paneId])) {
      // the stale pane survived — remember it so a later pass retries;
      // each rebind can leave another, so the field is a list
      // (armSession already carried the prior ledger forward)
      const r = ctx.state.sessions[ctx.path];
      if (r !== undefined) {
        ctx.state.sessions[ctx.path] = {
          ...r,
          closePending: [...(r.closePending ?? []), paneId],
        };
      }
    }
    log(`session pane ${paneId} → ${next} ${ctx.ws}: rebound to ${ctx.agent?.id ?? 'worktree'}`);
    return paneLive(ctx);
  }
  // no successor landed — keep the stale pane over an empty
  // workspace; the retry is backed off so a persistent arm
  // failure does not split+close a fresh pane every pass
  if (next !== undefined) herdrTry(['pane', 'close', next]);
  if (rec !== undefined) {
    ctx.state.sessions[ctx.path] = { ...rec, retryAt: Date.now() + REBIND_BACKOFF_MS };
  }
  log(`session pane ${paneId} → ${ctx.ws}: rebind deferred (split/arm failed)`);
  return false;
}

/** One workspace's session-pane convergence — the decision lives in
 *  herdr-kit's views module (record → re-arm/adopt → orphan-label →
 *  idle pane → split); this is the exec half: probe, decide, run.
 *  Returns whether a live session pane is bound after the pass. */
export function ensureSession(ctx: RenderCtx): boolean {
  const panes = paneList(ctx.ws);
  retryClose(ctx, ctx.state.sessions[ctx.path], panes);
  // re-read after the ledger drain — retryClose rewrites the record
  const rec = ctx.state.sessions[ctx.path];
  const act = decideSession({
    rec,
    panes,
    bound: boundPaneIds(ctx.state),
    sessionLabel: SESSION_LABEL,
    broLabels: BRO_LABELS,
    exists: paneExists,
    idle: paneIdle,
    agent: ctx.agent,
  });
  switch (act.kind) {
    case 'none':
      return paneLive(ctx);
    case 'rebind':
      return rebind(ctx, rec, act.paneId);
    case 'split':
      return armViaSplit(ctx, panes);
    default:
      return armAndReport(ctx, act.paneId, act.adopted);
  }
}

/** Lanes with nothing to show carry no session pane (spec
 *  bro-l8wqu): no acp session, no agent journal on disk (live or
 *  archived — a finished worker's record is still its feed, never
 *  retired) — a record-less arm renders `waiting for projector`
 *  forever. Close the recorded or orphan-labeled `bro: session` pane
 *  and drop the record. */
export function retireSession(ctx: RenderCtx): void {
  const rec = ctx.state.sessions[ctx.path];
  const panes = paneList(ctx.ws);
  const { closeId } = decideSessionRetire({
    rec,
    panes,
    sessionLabel: SESSION_LABEL,
    exists: paneExists,
  });
  if (closeId !== undefined) {
    herdrTry(['pane', 'close', closeId]);
    log(`retire session pane ${closeId} — no resolvable session (${ctx.ws})`);
  }
  // the pending-close ledger dies with the record — drain it now or
  // stale archives linger forever past the retire (label-checked the
  // same as retryClose: a recycled id is never ours to kill)
  for (const id of rec?.closePending ?? []) {
    if (id !== closeId && panes.some(p => p.pane_id === id && p.label === SESSION_LABEL)) {
      herdrTry(['pane', 'close', id]);
    }
  }
  delete ctx.state.sessions[ctx.path];
}

/** Workspaces that lost their arm get their session record dropped —
 *  the workspace itself is the caller's (or the reaper's) problem,
 *  the record is ours: a rec pointing at a closed workspace can never
 *  resurrect a pane there. */
export function dropOrphanSessions(state: PluginState, liveWsIds: Set<string>): void {
  for (const path of dropOrphanRecords(state.sessions, liveWsIds)) {
    delete state.sessions[path];
  }
}
