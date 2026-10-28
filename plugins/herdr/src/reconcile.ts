/**
 * converge — the whole sync-plane contract, trigger-free:
 *
 *   planes in → armed worktrees get workspaces (bead-title labels,
 *   drift-corrected only where this plugin named it) → running native
 *   agents get read-only mirror panes tailing their logs (mirrors.ts)
 *   → exited agents get their mirror renamed as an exit marker.
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
  type StatusAgent,
  type StatusWorktree,
  saveState,
  stateScope,
  type WorkspaceRec,
} from './lib.ts';
import { convergeMirrors, markExitedMirrors } from './mirrors.ts';
import type { Planes } from './planes.ts';
import { readPlanes } from './planes.ts';

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

function agentTreePath(a: StatusAgent, p: Planes): string | undefined {
  const reg = p.registry[a.id];
  const byAbs =
    reg?.worktree !== undefined ? p.status.worktrees.find(t => t.path === reg.worktree) : undefined;
  return (byAbs ?? p.status.worktrees.find(t => t.name === a.worktree))?.path;
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
  ctx.state.workspaces[tree.path] = { ws, label, managed: true };
  log(`open ${basename(tree.path)} → ${ws} "${label}" (${tree.why})`);
  return ws;
}

/** The plugin may correct a label only on a workspace IT opened —
 *  and only while the recorded id is still the live one. When our
 *  workspace was closed and the user opened their own for the same
 *  path, the label is theirs whatever a stale record claims. */
function labelDrifted(
  rec: WorkspaceRec | undefined,
  openId: string,
  live: HerdrWorkspace | undefined,
  label: string
): boolean {
  return rec?.managed === true && rec.ws === openId && live !== undefined && live.label !== label;
}

/** Ensure the armed worktree has a workspace; record plugin-opened ones
 *  so label drift stays ours to fix. Returns the workspace id. */
function ensureWorkspace(tree: ArmedTree, label: string, ctx: WsCtx): string | undefined {
  const { path } = tree;
  const openId = ctx.openByPath.get(path);
  if (openId === undefined) return openWorkspace(tree, label, ctx);

  const rec = ctx.state.workspaces[path];
  const live = ctx.wsById.get(openId);
  if (labelDrifted(rec, openId, live, label)) {
    herdrTry(['workspace', 'rename', openId, label]);
    ctx.state.workspaces[path] = { ws: openId, label, managed: true };
    log(`rename ${openId} → "${label}"`);
  } else if (rec !== undefined && live === undefined) {
    delete ctx.state.workspaces[path];
  } else if (rec === undefined) {
    // a workspace the user opened — observe, never touch its label
    ctx.state.workspaces[path] = { ws: openId, label: live?.label ?? '', managed: false };
  }
  return openId;
}

export interface ConvergeResult {
  armed: number;
  mirrors: number;
}

/** Workspaces for every armed tree; path → live workspace id. */
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

/** One converge pass over a planes snapshot — the function every
 *  EventSource feeds and the only one that would notice if the feed
 *  shape changed (it won't — that's the seam's point). */
export function converge(p: Planes): ConvergeResult {
  const scope = stateScope(p.main);
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
  saveState(scope, ctx.state);
  return { armed: armed.size, mirrors: Object.keys(ctx.state.mirrors).length };
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
    log(`done — ${r.armed} armed worktrees, ${r.mirrors} mirror panes`);
    if (r.armed > 0) notify('bro sync', `${r.armed} armed worktrees · ${r.mirrors} mirrors`);
  } catch (err) {
    console.error(`[reconcile] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
