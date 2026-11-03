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
  ctx.state.sessions[ctx.path] = {
    workspace: ctx.ws,
    worktree: ctx.path,
    pane_id: paneId,
    agent_id: ctx.agent?.id,
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
 *  already carried our label. */
function armAndReport(ctx: RenderCtx, paneId: string, adopted: boolean): void {
  if (!armSession(ctx, paneId)) {
    log(`session pane ${paneId} → ${ctx.ws}: pane run failed`);
    return;
  }
  log(`session pane ${paneId} → ${ctx.ws}${adopted ? ' (adopted)' : ''}`);
}

/** How long a failed rebind waits before the next attempt — long
 *  enough that a persistent `pane run` failure is not a pane churn. */
const REBIND_BACKOFF_MS = 60_000;

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

/** Is a live session pane bound after the pass — the caller's retire
 *  gate: fallback surfaces fold only where the human pane actually
 *  exists, not merely where it was eligible to arm. */
function paneLive(ctx: RenderCtx): boolean {
  const r = ctx.state.sessions[ctx.path];
  return r !== undefined && paneExists(r.pane_id);
}

/** One workspace's session-pane convergence — the decision lives in
 *  herdr-kit's views module (record → re-arm/adopt → orphan-label →
 *  idle pane → split); this is the exec half: probe, decide, run.
 *  Returns whether a live session pane is bound after the pass. */
export function ensureSession(ctx: RenderCtx): boolean {
  const rec = ctx.state.sessions[ctx.path];
  // a stale pane the last rebind could not close — retry before any
  // new decision so it does not linger showing the old archive
  if (rec?.closePending !== undefined) {
    if (!paneExists(rec.closePending) || herdrOk(['pane', 'close', rec.closePending])) {
      const { closePending: _closePending, ...rest } = rec;
      ctx.state.sessions[ctx.path] = rest;
    }
  }
  const panes = paneList(ctx.ws);
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
  if (act.kind === 'none') return paneLive(ctx);
  if (act.kind === 'rebind') {
    // the binding moved (new agent, or a dead record now resolves) —
    // the running pane is pinned to the old archive. Arm the
    // replacement FIRST: closing the workspace's last pane before its
    // successor exists auto-reaps the whole workspace mid-pass
    // (dogfood reap — the same constraint the arm-order follows)
    if (rec?.retryAt !== undefined && rec.retryAt > Date.now()) {
      return paneLive(ctx); // a failed arm is still backing off — keep the stale pane
    }
    const next = splitPane(act.paneId, ctx);
    if (next !== undefined && armSession(ctx, next)) {
      if (!herdrOk(['pane', 'close', act.paneId])) {
        // the stale pane survived — remember it so a later pass retries
        const r = ctx.state.sessions[ctx.path];
        if (r !== undefined) {
          ctx.state.sessions[ctx.path] = { ...r, closePending: act.paneId };
        }
      }
      log(
        `session pane ${act.paneId} → ${next} ${ctx.ws}: rebound to ${ctx.agent?.id ?? 'worktree'}`
      );
    } else {
      // no successor landed — keep the stale pane over an empty
      // workspace; the retry is backed off so a persistent arm
      // failure does not split+close a fresh pane every pass
      if (next !== undefined) herdrTry(['pane', 'close', next]);
      if (rec !== undefined) {
        ctx.state.sessions[ctx.path] = { ...rec, retryAt: Date.now() + REBIND_BACKOFF_MS };
      }
      log(`session pane ${act.paneId} → ${ctx.ws}: rebind deferred (split/arm failed)`);
    }
    return paneLive(ctx);
  }
  if (act.kind === 'split') {
    armViaSplit(ctx, panes);
    return paneLive(ctx);
  }
  armAndReport(ctx, act.paneId, act.adopted);
  return paneLive(ctx);
}

/** Lanes with nothing to show carry no session pane (spec
 *  bro-l8wqu): no acp session, no live agent journal — a worker-less
 *  arm renders `waiting for projector` forever. Close the recorded
 *  or orphan-labeled `bro: session` pane and drop the record. */
export function retireSession(ctx: RenderCtx): void {
  const rec = ctx.state.sessions[ctx.path];
  const { closeId } = decideSessionRetire({
    rec,
    panes: paneList(ctx.ws),
    sessionLabel: SESSION_LABEL,
    exists: paneExists,
  });
  if (closeId !== undefined) {
    herdrTry(['pane', 'close', closeId]);
    log(`retire session pane ${closeId} — no resolvable session (${ctx.ws})`);
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
