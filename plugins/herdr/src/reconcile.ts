/**
 * converge — the whole sync-plane contract, trigger-free:
 *
 *   planes in → armed worktrees get workspaces (bead-title labels,
 *   drift-corrected only where this plugin named it) → running native
 *   agents get read-only mirror panes tailing their logs → exited
 *   agents get their mirror renamed as an exit marker.
 *
 * An EventSource decides WHEN converge runs; this file only ever sees
 * the snapshot it produced. bro state is never written — the only
 * mutations are herdr CLI calls and the plugin's own state file.
 */
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Planes } from './planes.ts';
import { readPlanes } from './planes.ts';
import {
  ctxJson,
  herdrTry,
  loadState,
  notify,
  paneExists,
  paneGone,
  paneIdle,
  paneList,
  pidAlive,
  repoDir,
  saveState,
  stateScope,
  shq,
  type HerdrWorkspace,
  type PluginState,
  type StatusAgent,
  type StatusWorktree,
} from './lib.ts';

const log = (s: string): void => console.log(`[reconcile] ${s}`);

/** Marker detail → worktree path. Details are either `../`-relative to
 *  the main checkout (`bro work enter <path>`) or slugs/names. */
function resolveDetail(detail: string, main: string, trees: StatusWorktree[]): string | undefined {
  if (detail.includes('/') || detail === '.') {
    const abs = isAbsolute(detail) ? detail : resolve(main, detail);
    const w = trees.find(t => t.path === abs);
    return w?.path ?? (existsSync(abs) ? abs : undefined);
  }
  const w =
    trees.find(t => t.name === `bro--${detail}`) ??
    trees.find(t => t.name === detail) ??
    trees.find(t => t.claim === detail);
  return w?.path;
}

interface ArmedTree {
  path: string;
  /** bead/step slug when one resolved — drives the label. */
  slug?: string;
  why: string;
}

/** The set of trees that deserve a workspace: claimed via `bro work
 *  enter`, named by a live session `.work` marker, or hosting a live
 *  agent. Read from bro's planes, never written. */
function armedSet(p: Planes): Map<string, ArmedTree> {
  const armed = new Map<string, ArmedTree>();
  const trees = p.status.worktrees;

  const arm = (path: string, slug: string | undefined, why: string): void => {
    const cur = armed.get(path);
    // a bead-claim arm wins over a marker arm — better label source
    if (cur === undefined || (cur.slug === undefined && slug !== undefined)) {
      armed.set(path, { path, slug, why });
    }
  };

  for (const w of trees) {
    if (w.claim !== undefined && w.claim !== '') arm(w.path, w.claim, 'claim');
  }
  for (const d of p.armedDetails) {
    const path = resolveDetail(d, p.main, trees);
    if (path !== undefined) arm(path, undefined, `session ${d}`);
  }
  for (const a of p.status.fleet.agents) {
    if (a.state !== 'running' || a.worktree === undefined) continue;
    const reg = p.registry[a.id];
    const w = reg?.worktree !== undefined ? trees.find(t => t.path === reg.worktree) : undefined;
    const byName = w ?? trees.find(t => t.name === a.worktree);
    if (byName !== undefined) arm(byName.path, a.id, `agent ${a.id}`);
  }
  for (const r of p.status.loop.runs) {
    if (r.state !== 'running' || r.worktree === undefined) continue;
    if (existsSync(r.worktree)) arm(r.worktree, r.beadId, `loop ${r.beadId}`);
  }
  return armed;
}

function desiredLabel(tree: ArmedTree, titles: Map<string, string>): string {
  if (tree.slug !== undefined) {
    const t = titles.get(tree.slug);
    if (t !== undefined && t !== '') return t;
    return tree.slug;
  }
  return basename(tree.path);
}

/** Ensure the armed worktree has a workspace; record plugin-opened ones
 *  so label drift stays ours to fix. Returns the workspace id. */
function ensureWorkspace(
  tree: ArmedTree,
  label: string,
  p: Planes,
  openByPath: Map<string, string>,
  wsById: Map<string, HerdrWorkspace>,
  state: PluginState
): string | undefined {
  const { path } = tree;
  const openId = openByPath.get(path);
  const rec = state.workspaces[path];

  if (openId === undefined) {
    const res = herdrTry<{
      workspace_id?: string;
      workspace?: { workspace_id?: string };
      root_pane?: { workspace_id?: string };
    }>(['worktree', 'open', '--cwd', p.main, '--path', path, '--label', label, '--no-focus']);
    // open answers differently by path — fresh opens can carry a
    // top-level id, already-open responses nest it under
    // workspace/root_pane; read all three shapes
    const ws = res?.workspace_id ?? res?.workspace?.workspace_id ?? res?.root_pane?.workspace_id;
    if (ws !== undefined) {
      state.workspaces[path] = { ws, label, managed: true };
      log(`open ${basename(path)} → ${ws} "${label}" (${tree.why})`);
      return ws;
    }
    log(`open ${basename(path)} FAILED — skipped (${tree.why})`);
    return undefined;
  }

  // workspace exists — only plugin-opened rows get drift-corrected;
  // workspaces a user opened (and named) themselves keep their label.
  // rec.ws must equal the live id too: when our workspace was closed
  // and the user opened their own for the same path, the label is
  // theirs, whatever a stale record claims.
  const live = wsById.get(openId);
  if (rec?.managed === true && rec.ws === openId && live !== undefined && live.label !== label) {
    herdrTry(['workspace', 'rename', openId, label]);
    state.workspaces[path] = { ws: openId, label, managed: true };
    log(`rename ${openId} → "${label}"`);
  } else if (rec !== undefined && live === undefined) {
    delete state.workspaces[path];
  } else if (rec === undefined) {
    state.workspaces[path] = { ws: openId, label: live?.label ?? '', managed: false };
  }
  return openId;
}

/** Read-only shell text for a mirror pane: tail the agent log; when the
 *  recorded worker pid dies, kill the tail and mark the pane in place.
 *  The marker lands inside the pane — no bro write anywhere. */
function mirrorCommand(step: string, logPath: string, pid?: number, pidStart?: string): string {
  const marker = `echo '── bro agent ${step} exited — tail closed ──'`;
  if (typeof pid === 'number') {
    // pid reuse is real: a recycled pid would keep the tail (and the
    // busy pane) alive forever — when the registry recorded the
    // process start token, /proc's starttime must match it too
    const alive =
      pidStart !== undefined && pidStart !== ''
        ? `kill -0 ${pid} 2>/dev/null && { [ ! -e /proc/${pid}/stat ] || ` +
          `[ "$(awk '{print $22}' /proc/${pid}/stat 2>/dev/null)" = ${shq(pidStart)} ]; }`
        : `kill -0 ${pid} 2>/dev/null`;
    return (
      `tail -n +1 -F ${shq(logPath)} & T=$!; ` +
      `while ${alive}; do sleep 5; done; ` +
      `kill $T 2>/dev/null; ${marker}`
    );
  }
  return `tail -n +1 -F ${shq(logPath)}`;
}

interface MirrorSource extends StatusAgent {
  log: string;
  pidStart?: string;
}

function ensureMirror(a: MirrorSource, ws: string, worktreePath: string, state: PluginState): void {
  const step = a.id;
  const rec = state.mirrors[step];
  const panes = paneList(ws);

  // a pane we can call this worker's mirror: the recorded one, or an
  // orphan still carrying the label we gave it (a rec lost to a flaky
  // probe must never cost a duplicate pane)
  let paneId = rec !== undefined && paneExists(rec.pane_id) ? rec.pane_id : undefined;
  const orphan = panes.find(
    p => p.label === `bro: ${step}` || p.label?.startsWith(`✖ bro: ${step}`)
  );
  paneId ??= orphan?.pane_id;

  if (paneId !== undefined) {
    // re-arm only when the pane changed hands or the attempt moved on —
    // a quiet glimpse of the same attempt's own tail-watcher must not
    // queue another command into its busy shell
    const moved = rec?.pane_id !== paneId || rec?.agentId !== a.agentId || rec?.pid !== a.pid;
    if (moved && paneIdle(paneId)) {
      herdrTry(['pane', 'rename', paneId, `bro: ${step}`]);
      const ran = herdrTry(['pane', 'run', paneId, mirrorCommand(step, a.log, a.pid, a.pidStart)]);
      if (ran === undefined) {
        // labeled but unarmed — a later pass retries via the orphan path
        log(`re-arm mirror ${paneId}: pane run failed`);
        return;
      }
      state.mirrors[step] = {
        step,
        agentId: a.agentId,
        pid: a.pid,
        pidStart: a.pidStart,
        log: a.log,
        worktree: worktreePath,
        workspace: ws,
        pane_id: paneId,
        marked: false,
      };
      log(`re-arm mirror ${paneId} → ${a.agentId ?? step}`);
    } else {
      // busy pane under a moved attempt keeps its OLD identity — writing
      // the new agentId/pid now would mark the stale pane converged and
      // it would show the dead attempt's log forever. If the recorded
      // worker is provably dead, the busy pane is a dead man's tail —
      // close it and let a later pass split a fresh one.
      if (moved && rec?.pid !== undefined && !pidAlive(rec.pid)) {
        herdrTry(['pane', 'close', paneId]);
        delete state.mirrors[step];
        log(`closed stale mirror ${paneId} — worker pid ${rec.pid} is dead`);
        return;
      }
      if (orphan?.label?.startsWith('✖')) {
        herdrTry(['pane', 'rename', paneId, `bro: ${step}`]);
      }
      state.mirrors[step] = {
        step,
        agentId: moved ? rec?.agentId : a.agentId,
        pid: moved ? rec?.pid : a.pid,
        pidStart: moved ? rec?.pidStart : a.pidStart,
        log: moved ? (rec?.log ?? a.log) : a.log,
        worktree: worktreePath,
        workspace: ws,
        pane_id: paneId,
        marked: false,
      };
      if (rec?.pane_id !== paneId) log(`adopted mirror ${paneId} for ${step}`);
    }
    return;
  }

  const target = panes.find(p => paneIdle(p.pane_id)) ?? panes[0];
  if (target === undefined) {
    log(`mirror ${step}: workspace ${ws} has no pane — skipped`);
    return;
  }
  const split = herdrTry<{ pane?: { pane_id?: string } }>([
    'pane',
    'split',
    target.pane_id,
    '--direction',
    'down',
    '--cwd',
    worktreePath,
    '--no-focus',
  ]);
  const newPane = split?.pane?.pane_id;
  if (newPane === undefined) {
    log(`mirror ${step}: split failed in ${ws}`);
    return;
  }
  herdrTry(['pane', 'rename', newPane, `bro: ${step}`]);
  const ran = herdrTry(['pane', 'run', newPane, mirrorCommand(step, a.log, a.pid, a.pidStart)]);
  if (ran === undefined) {
    // labeled but unarmed — a later pass retries via the orphan path
    log(`mirror ${step} → ${newPane}: pane run failed`);
    return;
  }
  state.mirrors[step] = {
    step,
    agentId: a.agentId,
    pid: a.pid,
    pidStart: a.pidStart,
    log: a.log,
    worktree: worktreePath,
    workspace: ws,
    pane_id: newPane,
    marked: false,
  };
  log(`mirror ${step} → ${newPane} (tail ${basename(a.log)})`);
}

function markExitedMirrors(p: Planes, state: PluginState): void {
  const live = new Map(p.status.fleet.agents.map(a => [a.id, a]));
  for (const [step, rec] of Object.entries(state.mirrors)) {
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

export interface ConvergeResult {
  armed: number;
  mirrors: number;
}

/** One converge pass over a planes snapshot — the function every
 *  EventSource feeds and the only one that would notice if the feed
 *  shape changed (it won't — that's the seam's point). */
export function converge(p: Planes): ConvergeResult {
  const wsById = new Map(p.workspaces.map(w => [w.workspace_id, w]));
  const openByPath = new Map(
    p.worktrees.worktrees
      .filter(w => w.open_workspace_id !== undefined)
      .map(w => [w.path, w.open_workspace_id!])
  );
  const titles = new Map(p.status.beads.inProgress.map(b => [b.id, b.title] as const));
  const scope = stateScope(p.main);
  const state = loadState(scope);

  const armed = armedSet(p);
  const wsForPath = new Map<string, string>();
  for (const t of armed.values()) {
    const ws = ensureWorkspace(t, desiredLabel(t, titles), p, openByPath, wsById, state);
    if (ws !== undefined) wsForPath.set(t.path, ws);
  }

  // mirrors for live native agents — the registry plane carries the
  // attempt's log/abs-worktree (status's `log` field joins when present)
  for (const a of p.status.fleet.agents) {
    if (a.backend !== 'native' || a.state !== 'running') continue;
    const reg = p.registry[a.id];
    const logPath = a.log ?? reg?.log;
    const wtPath =
      reg?.worktree !== undefined && existsSync(reg.worktree)
        ? reg.worktree
        : p.status.worktrees.find(t => t.name === a.worktree)?.path;
    if (logPath === undefined || wtPath === undefined) continue;
    const ws = wsForPath.get(wtPath) ?? openByPath.get(wtPath);
    if (ws === undefined) continue;
    ensureMirror(
      {
        ...a,
        agentId: a.agentId ?? reg?.agentId,
        pid: a.pid ?? reg?.pid,
        pidStart: typeof reg?.pidStart === 'string' ? reg.pidStart : undefined,
        log: logPath,
      },
      ws,
      wtPath,
      state
    );
  }

  markExitedMirrors(p, state);
  saveState(scope, state);
  return { armed: armed.size, mirrors: Object.keys(state.mirrors).length };
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
