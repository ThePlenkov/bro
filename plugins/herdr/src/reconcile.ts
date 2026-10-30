/**
 * converge — the whole sync-plane contract, trigger-free:
 *
 *   planes in → armed worktrees get workspaces (plain bead-title
 *   labels) → running native agents get read-only mirror panes tailing
 *   their logs (mirrors.ts) → exited agents get their mirror renamed
 *   as an exit marker → every managed workspace gets its `bro: status`
 *   pane (statuses.ts, spec bro-idsat).
 *
 * Fleet status (`[state·#PR]` prefixes, `status` tokens, fleet-state
 * files) is the bro daemon's fleet projector, not this file (spec
 * bro-u19mq): the plugin opens workspaces and records `managed`, the
 * daemon owns every later rename and metadata write, and the status
 * pane self-reports the LED. Splitting it this way leaves ONE writer —
 * a crashed session can no longer strand a stale `[working]` label.
 *
 * An EventSource decides WHEN converge runs; this file only ever sees
 * the snapshot it produced. bro state is never written — the only
 * mutations are herdr CLI calls and the plugin's own state file.
 */
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  ctxJson,
  type HerdrWorkspace,
  herdrTry,
  loadState,
  notify,
  type PluginState,
  repoDir,
  type StatusWorktree,
  saveState,
  stateScope,
  withStateLock,
  worktreeGone,
  type WorkspaceRec,
} from './lib.ts';
import { convergeMirrors, markExitedMirrors } from './mirrors.ts';
import type { Planes } from './planes.ts';
import { readPlanes } from './planes.ts';
import { dropOrphanRenderers, ensureRenderer } from './renderers.ts';
import { agentTreePath } from './status.ts';
import { dropOrphanStatuses, ensureStatus } from './statuses.ts';

const log = (s: string): void => console.log(`[reconcile] ${s}`);

/** Marker detail → worktree path. Details are either `../`-relative to
 *  the main checkout (`bro work enter <path>`) or slugs/names. */
function resolveDetail(detail: string, main: string, trees: StatusWorktree[]): string | undefined {
  if (detail.includes('/') || detail === '.') {
    const abs = isAbsolute(detail) ? detail : resolve(main, detail);
    const w = trees.find(t => t.path === abs);
    return w?.path ?? (existsSync(abs) ? abs : undefined);
  }
  const w = trees.find(t => t.name === detail) ?? trees.find(t => t.claim === detail);
  return w?.path;
}

interface ArmedTree {
  path: string;
  /** bead/step slug when one resolved — drives the label. */
  slug?: string;
  why: string;
}

/** Arm candidates, one generator per source — the merge below decides
 *  precedence, so each source stays a flat filter. */
function* claimArms(trees: StatusWorktree[]): Iterable<ArmedTree> {
  for (const w of trees) {
    if (w.claim !== undefined && w.claim !== '') {
      yield { path: w.path, slug: w.claim, why: 'claim' };
    }
  }
}

function* markerArms(p: Planes): Iterable<ArmedTree> {
  for (const d of p.armedDetails) {
    const path = resolveDetail(d, p.main, p.status.worktrees);
    if (path !== undefined) yield { path, why: `session ${d}` };
  }
}

function* agentArms(p: Planes): Iterable<ArmedTree> {
  for (const a of p.status.fleet.agents) {
    if (a.state !== 'running' || a.worktree === undefined) continue;
    const path = agentTreePath(a, p);
    if (path !== undefined) yield { path, slug: a.id, why: `agent ${a.id}` };
  }
}

/** A running loop run parked on a worktree that still exists. */
function liveRun(r: {
  state: string;
  worktree?: string;
}): r is { state: string; worktree: string } {
  return r.state === 'running' && r.worktree !== undefined && existsSync(r.worktree);
}

function* loopArms(p: Planes): Iterable<ArmedTree> {
  for (const r of p.status.loop.runs) {
    if (liveRun(r)) yield { path: r.worktree, slug: r.beadId, why: `loop ${r.beadId}` };
  }
}

/** Arm precedence — a slug-carrying arm (claim/agent/loop) wins over a
 *  marker arm; the slug drives the better label. */
function keepArm(cur: ArmedTree | undefined, next: ArmedTree): boolean {
  if (cur === undefined) return false;
  return cur.slug !== undefined || next.slug === undefined;
}

/** The set of trees that deserve a workspace: claimed via `bro work
 *  enter`, named by a live session `.work` marker, or hosting a live
 *  agent. Read from bro's planes, never written. */
function armedSet(p: Planes): Map<string, ArmedTree> {
  const armed = new Map<string, ArmedTree>();
  const candidates = [
    ...claimArms(p.status.worktrees),
    ...markerArms(p),
    ...agentArms(p),
    ...loopArms(p),
  ];
  for (const t of candidates) {
    if (!keepArm(armed.get(t.path), t)) armed.set(t.path, t);
  }
  return armed;
}

function desiredLabel(tree: ArmedTree, titles: Map<string, string>): string {
  if (tree.slug !== undefined) {
    const t = titles.get(tree.slug);
    if (t !== undefined && t !== '') return t;
  }
  return basename(tree.path);
}

interface WsCtx {
  openByPath: Map<string, string>;
  wsById: Map<string, HerdrWorkspace>;
  state: PluginState;
  main: string;
}

/** `worktree open` answers differently by path — fresh opens can carry
 *  a top-level id, already-open responses nest it under
 *  workspace/root_pane; read all three shapes. */
function openWorkspace(tree: ArmedTree, label: string, ctx: WsCtx): string | undefined {
  const res = herdrTry<{
    workspace_id?: string;
    workspace?: { workspace_id?: string };
    root_pane?: { workspace_id?: string };
  }>(['worktree', 'open', '--cwd', ctx.main, '--path', tree.path, '--label', label, '--no-focus']);
  const ws = res?.workspace_id ?? res?.workspace?.workspace_id ?? res?.root_pane?.workspace_id;
  if (ws === undefined) {
    log(`open ${basename(tree.path)} FAILED — skipped (${tree.why})`);
    return undefined;
  }
  ctx.state.workspaces[tree.path] = {
    ...ctx.state.workspaces[tree.path],
    ws,
    label,
    managed: true,
  };
  log(`open ${basename(tree.path)} → ${ws} "${label}" (${tree.why})`);
  return ws;
}

/** The daemon projector moved this workspace's label — a managed
 *  record whose live label no longer matches what it recorded. */
function projectorRelabeled(
  rec: WorkspaceRec | undefined,
  live: HerdrWorkspace | undefined
): boolean {
  if (rec?.managed !== true) return false;
  if (live === undefined) return false;
  return live.label !== rec.label;
}

/** Ensure the armed worktree has a workspace; record plugin-opened ones
 *  so the daemon projector knows it owns their labels. Returns the
 *  workspace id. The plugin never renames an existing workspace — the
 *  `[state·#PR]` drift belongs to the projector (spec bro-u19mq), and
 *  a user's own label is never touched. */
function ensureWorkspace(tree: ArmedTree, label: string, ctx: WsCtx): string | undefined {
  const { path } = tree;
  const openId = ctx.openByPath.get(path);
  if (openId === undefined) return openWorkspace(tree, label, ctx);

  const rec = ctx.state.workspaces[path];
  const live = ctx.wsById.get(openId);
  if (rec !== undefined && live === undefined) {
    delete ctx.state.workspaces[path];
  } else if (rec === undefined) {
    // a workspace the user opened — observe, never touch its label
    ctx.state.workspaces[path] = { ws: openId, label: live?.label ?? '', managed: false };
  } else if (projectorRelabeled(rec, live)) {
    // the projector relabels managed workspaces — keep the record's
    // view of the live label honest so a restart doesn't misread it
    ctx.state.workspaces[path] = { ...rec, label: live?.label ?? '' };
  }
  return openId;
}

export interface ConvergeResult {
  armed: number;
  mirrors: number;
  renderers: number;
  statuses: number;
  reaped: number;
}

/** Workspaces for every armed tree; path → live workspace id. Opens
 *  carry the plain bead title — status prefixes are projected by the
 *  daemon, not written here. */
function convergeWorkspaces(
  p: Planes,
  armed: Map<string, ArmedTree>,
  ctx: WsCtx
): Map<string, string> {
  const titles = new Map(p.status.beads.inProgress.map(b => [b.id, b.title] as const));
  const wsForPath = new Map<string, string>();
  for (const t of armed.values()) {
    const ws = ensureWorkspace(t, desiredLabel(t, titles), ctx);
    if (ws !== undefined) wsForPath.set(t.path, ws);
  }
  return wsForPath;
}

/** Exactly one renderer per managed workspace — after mirrors so a
 *  live mirror retires the fallback tail in the same pass. The
 *  recorded ws id must match the live one — a stale `managed` record
 *  left by a user reopen must not put our pane on their workspace. */
function convergeRenderers(wsForPath: Map<string, string>, ctx: WsCtx): void {
  for (const [path, ws] of wsForPath) {
    const rec = ctx.state.workspaces[path];
    if (rec?.managed === true && rec.ws === ws) {
      ensureRenderer({ path, ws, state: ctx.state });
    }
  }
  // wsById predates this pass's opens — a just-created workspace is
  // live even though the snapshot never saw it
  dropOrphanRenderers(ctx.state, new Set([...ctx.wsById.keys(), ...wsForPath.values()]));
}

/** Exactly one status pane per managed workspace — after mirrors and
 *  renderers so the pane-order decision sees the settled set. Same
 *  managed-record guard as the renderer: a stale `managed` record
 *  must not put our pane on a user's workspace. */
function convergeStatuses(wsForPath: Map<string, string>, ctx: WsCtx): void {
  for (const [path, ws] of wsForPath) {
    const rec = ctx.state.workspaces[path];
    if (rec?.managed === true && rec.ws === ws) {
      ensureStatus({ path, ws, state: ctx.state });
    }
  }
  dropOrphanStatuses(ctx.state, new Set([...ctx.wsById.keys(), ...wsForPath.values()]));
}

/** The reaper — a worktree herdr still opens a workspace for, gone off
 *  disk. One sighting stamps `goneSince`; a second pass at least the
 *  grace window later closes the workspace. Only filesystem proof and
 *  time decide — a vanished checkout is never "transient" twice. */
const GONE_GRACE_MS = 60_000;

function reapDead(p: Planes, ctx: WsCtx): number {
  const now = Date.now();
  let reaped = 0;
  for (const w of p.worktrees.worktrees) {
    const ws = w.open_workspace_id;
    if (ws === undefined || w.path === p.main) continue;
    if (!worktreeGone(w.path)) {
      delete ctx.state.gone[w.path];
      continue;
    }
    if (ctx.wsById.get(ws) === undefined) {
      // the workspace plane no longer carries this id — somebody closed
      // it already; whatever we recorded is residue.
      delete ctx.state.gone[w.path];
      delete ctx.state.workspaces[w.path];
      delete ctx.state.renderers[w.path];
      delete ctx.state.statuses[w.path];
      continue;
    }
    let since = ctx.state.gone[w.path];
    if (since === undefined) {
      since = now;
      ctx.state.gone[w.path] = now;
    }
    if (now - since < GONE_GRACE_MS) continue;
    if (herdrTry(['workspace', 'close', ws]) !== undefined) {
      delete ctx.state.workspaces[w.path];
      delete ctx.state.renderers[w.path];
      delete ctx.state.statuses[w.path];
      delete ctx.state.gone[w.path];
      reaped += 1;
      log(`reaped ${ws} — worktree gone: ${basename(w.path)}`);
    } else {
      log(`reap ${ws} failed — retry next pass`);
    }
  }
  return reaped;
}

/** One converge pass over a planes snapshot — the function every
 *  EventSource feeds and the only one that would notice if the feed
 *  shape changed (it won't — that's the seam's point). The whole
 *  load→mutate→save runs under the scope's state lock so two sessions
 *  can't lost-update each other's workspace records. */
export function converge(p: Planes): ConvergeResult {
  const scope = stateScope(p.main);
  return withStateLock(scope, () => convergeLocked(p, scope));
}

function convergeLocked(p: Planes, scope: string): ConvergeResult {
  const ctx: WsCtx = {
    openByPath: new Map(
      p.worktrees.worktrees
        .filter(w => w.open_workspace_id !== undefined)
        .map(w => [w.path, w.open_workspace_id!])
    ),
    wsById: new Map(p.workspaces.map(w => [w.workspace_id, w])),
    state: loadState(scope),
    main: p.main,
  };

  const armed = armedSet(p);
  const wsForPath = convergeWorkspaces(p, armed, ctx);
  convergeMirrors(p, wsForPath, ctx.openByPath, ctx.state);
  markExitedMirrors(p, ctx.state);
  convergeRenderers(wsForPath, ctx);
  convergeStatuses(wsForPath, ctx);
  const reaped = reapDead(p, ctx);
  saveState(scope, ctx.state);
  return {
    armed: armed.size,
    mirrors: Object.keys(ctx.state.mirrors).length,
    renderers: Object.keys(ctx.state.renderers).length,
    statuses: Object.keys(ctx.state.statuses).length,
    reaped,
  };
}

/** One-shot entry — the `sync` action and the startup hook both land
 *  here: read the planes once, converge once, done. The daemon loop in
 *  sync.ts is the same converge behind an EventSource. */
export function reconcile(): ConvergeResult {
  return converge(readPlanes(repoDir(ctxJson())));
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const r = reconcile();
    log(
      `done — ${r.armed} armed worktrees, ${r.mirrors} mirror panes, ${r.renderers} renderers, ${r.statuses} statuses, ${r.reaped} reaped`
    );
    if (r.armed > 0) {
      notify('bro sync', `${r.armed} armed worktrees · ${r.mirrors} mirrors · ${r.reaped} reaped`);
    }
  } catch (err) {
    console.error(`[reconcile] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
