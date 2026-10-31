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
import { spawnSync } from 'node:child_process';
import {
  agentsJson,
  armedWorkDetails,
  ctxJson,
  type HerdrWorkspace,
  herdrTry,
  loadState,
  notify,
  type PluginState,
  repoDir,
  run,
  type StatusWorktree,
  saveState,
  stateScope,
  withStateLock,
  worktreeGone,
  type WorkspaceRec,
  paneList,
  pidAlive,
} from './lib.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { convergeMirrors, markExitedMirrors } from './mirrors.ts';
import type { Planes } from './planes.ts';
import { readPlanes } from './planes.ts';
import { dropOrphanRenderers, ensureRenderer } from './renderers.ts';
import { dropOrphanSessions, ensureSession } from './sessions.ts';
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

/** The open-time label matches the daemon projector's contract —
 * `🤖 <worktree-name>` — so a fresh workspace never flashes a bead
 * title or raw slug the next pass would overwrite anyway. */
function desiredLabel(tree: ArmedTree): string {
  return `🤖 ${basename(tree.path)}`;
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
  sessions: number;
  reaped: number;
}

/** Workspaces for every armed tree; path → live workspace id. Opens
 *  carry the robot-marked worktree name — the same label the daemon
 *  projector maintains. */
function convergeWorkspaces(
  p: Planes,
  armed: Map<string, ArmedTree>,
  ctx: WsCtx
): Map<string, string> {
  const wsForPath = new Map<string, string>();
  for (const t of armed.values()) {
    const ws = ensureWorkspace(t, desiredLabel(t), ctx);
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

/** Exactly one session pane per managed workspace — alongside `bro:
 *  status` so the readonly conversation view rides the same managed
 *  set (spec bro-nwl5g). Same managed-record guard as the renderer. */
function convergeSessions(wsForPath: Map<string, string>, ctx: WsCtx): void {
  for (const [path, ws] of wsForPath) {
    const rec = ctx.state.workspaces[path];
    if (rec?.managed === true && rec.ws === ws) {
      ensureSession({ path, ws, state: ctx.state });
    }
  }
  dropOrphanSessions(ctx.state, new Set([...ctx.wsById.keys(), ...wsForPath.values()]));
}

/** The reaper — a worktree herdr still opens a workspace for, gone off
 *  disk. One sighting stamps `goneSince`; a second pass at least the
 *  grace window later closes the workspace. Only filesystem proof and
 *  time decide — a vanished checkout is never "transient" twice. */
const GONE_GRACE_MS = 60_000;

function resolveAgentWorktreePath(a: { worktree?: string }, p: Planes): string | undefined {
  // Try agentTreePath first (handles registry + name resolution)
  const fromAgentTreePath = agentTreePath(a as any, p);
  if (fromAgentTreePath) return fromAgentTreePath;
  // Fallback: if worktree is absolute path
  if (a.worktree && isAbsolute(a.worktree)) {
    const w = p.status.worktrees.find(t => t.path === a.worktree);
    if (w) return w.path;
    return a.worktree;
  }
  // Fallback: resolve by name
  if (a.worktree) {
    const w = p.status.worktrees.find(t => t.name === a.worktree);
    if (w) return w.path;
  }
  return undefined;
}

function hasLiveRunOrBoundAgent(p: Planes, treePath: string): boolean {
  // check agents from status
  for (const a of p.status.fleet.agents) {
    if (a.state === 'running') {
      const ap = resolveAgentWorktreePath(a, p) ?? (a.worktree && isAbsolute(a.worktree) ? a.worktree : undefined);
      if (ap === treePath) return true;
      if (ap && (ap.startsWith(treePath + '/') || treePath.startsWith(ap + '/'))) return true;
    }
  }
  // check loop runs
  for (const r of p.status.loop.runs) {
    if (r.state === 'running' && r.worktree) {
      if (r.worktree === treePath || r.worktree.startsWith(treePath + '/')) return true;
    }
  }
  // check agents.json for live entries pointing to this worktree
  const reg = agentsJson(p.repo);
  for (const entry of Object.values(reg)) {
    if (entry.worktree) {
      const ew = entry.worktree;
      const matches =
        ew === treePath ||
        ew.startsWith(treePath + '/') ||
        treePath.startsWith(ew + '/');
      if (matches) {
        if (entry.pid === undefined || entry.pid === null) {
          continue;
        }
        const pidStart = (entry as any).pidStart as string | undefined;
        if (!pidAlive(entry.pid, pidStart)) {
          continue;
        }
        // must correspond to a still-running agent in fleet status
        const eid = (entry as any).agentId ?? (entry as any).id ?? (entry as any).molStep;
        let running = false;
        let found = false;
        for (const a of p.status.fleet.agents || []) {
          const aid = (a as any).agentId ?? a.id;
          if (eid && aid && eid === aid) {
            found = true;
            if (a.state === 'running') {
              running = true;
              break;
            }
            break;
          }
        }
        if (!found) {
          continue;
        }
        if (!running) {
          continue;
        }
        return true;
      }
    }
  }
  // check workspace panes for live foreign agents (exclude bro-status)
  for (const ws of p.workspaces) {
    const wpath = ws.worktree?.checkout_path;
    const isRelated =
      wpath === treePath ||
      (wpath && (wpath.startsWith(treePath + '/') || treePath.startsWith(wpath + '/'))) ||
      p.worktrees.worktrees.some(
        w =>
          w.open_workspace_id === ws.workspace_id &&
          (w.path === treePath || w.path.startsWith(treePath + '/') || treePath.startsWith(w.path + '/'))
      );
    if (!isRelated) continue;
    try {
      const panes = paneList(ws.workspace_id);
      for (const pane of panes) {
        if (pane.agent && pane.agent !== '' && pane.agent !== 'bro-status') {
          return true;
        }
      }
    } catch {
      // best effort
    }
  }
  return false;
}

function quickRun(cmd: string, args: string[], cwd?: string, timeoutMs = 2000): { code: number; out: string; err: string } {
  try {
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return {
      code: r.status ?? -1,
      out: r.stdout ?? '',
      err: r.stderr ?? (r.error !== undefined ? String(r.error) : ''),
    };
  } catch {
    return { code: -1, out: '', err: '' };
  }
}

function isBranchPushedToRemote(wt: string): boolean {
  // branch remote existence - must be origin
  const r = run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (r.code === 0 && r.out.trim()) {
    const up = r.out.trim();
    if (up.startsWith('origin/')) return true;
    // upstream exists but not origin - not considered remote-preserved per requirement
    // fall through to other checks
  }
  // try to see if branch exists on origin
  const br = run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = br.out.trim();
  if (branch && branch !== 'HEAD') {
    const lr2 = run('git', ['-C', wt, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    if (lr2.code === 0) return true;
    const lr3 = run('git', ['-C', wt, 'branch', '-r', '--list', `origin/${branch}`]);
    if (lr3.code === 0 && lr3.out.trim()) return true;
    // also check if local branch tracks origin
    const tr = run('git', ['-C', wt, 'config', `branch.${branch}.remote`]);
    if (tr.code === 0 && tr.out.trim() === 'origin') return true;
    const mr = run('git', ['-C', wt, 'config', `branch.${branch}.merge`]);
    if (tr.code === 0 && mr.code === 0 && mr.out.trim().includes(`refs/heads/${branch}`)) {
      return true;
    }
    // avoid unbounded network probe in reconcile; do a quick local-only check if possible with short timeout
    const lr = quickRun('git', ['-C', wt, 'ls-remote', '--exit-code', '--heads', 'origin', branch], undefined, 2000);
    if (lr.code === 0) return true;
  } else if (branch === 'HEAD') {
    // detached HEAD - check if current commit exists on origin
    const head = run('git', ['-C', wt, 'rev-parse', 'HEAD']);
    if (head.code === 0) {
      const sha = head.out.trim();
      // check if this commit is on any origin ref
      const lr = quickRun('git', ['-C', wt, 'branch', '-r', '--contains', sha], undefined, 2000);
      if (lr.code === 0 && lr.out.includes('origin/')) return true;
    }
  }
  // If commits are merged into a verified remote base, treat as preserved
  // even if original branch ref deleted/pruned
  const bases = ['origin/main', 'origin/master', 'origin/HEAD'];
  let anyBaseOk = false;
  for (const base of bases) {
    const rbase = run('git', ['-C', wt, 'rev-parse', '--verify', base]);
    if (rbase.code === 0) {
      anyBaseOk = true;
      const rlog = run('git', ['-C', wt, 'log', `${base}..HEAD`, '--oneline']);
      if (rlog.code === 0 && rlog.out.trim() === '') {
        return true;
      }
    }
  }
  // if no bases exist, try to see if current branch has upstream on origin or commit is reachable from origin
  if (!anyBaseOk) {
    const br2 = run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (br2.code === 0 && br2.out.trim().startsWith('origin/')) {
      return true;
    }
    const brn = run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const b = brn.out.trim();
    if (b && b !== 'HEAD') {
      if (run('git', ['-C', wt, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${b}`]).code === 0) return true;
      if (run('git', ['-C', wt, 'config', `branch.${b}.remote`]).code === 0 && run('git', ['-C', wt, 'config', `branch.${b}.remote`]).out.trim() === 'origin') return true;
    } else {
      const head = run('git', ['-C', wt, 'rev-parse', 'HEAD']);
      if (head.code === 0) {
        const lr = quickRun('git', ['-C', wt, 'branch', '-r', '--contains', head.out.trim()], undefined, 2000);
        if (lr.code === 0 && lr.out.includes('origin/')) return true;
      }
    }
    return false;
  }
  return false;
}

function isTreeClean(wt: string): boolean {
  const r = run('git', ['-C', wt, 'status', '--porcelain']);
  return r.code === 0 && r.out.trim() === '';
}

function hasUnpushedCommits(wt: string): boolean {
  const br = run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = br.out.trim();
  // Check if all commits are pushed to the branch's remote ref
  if (branch && branch !== 'HEAD') {
    // try upstream
    const up = run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (up.code === 0 && up.out.trim()) {
      const upRef = up.out.trim();
      // only trust origin upstream
      if (upRef.startsWith('origin/')) {
        const ur = run('git', ['-C', wt, 'log', `${upRef}..HEAD`, '--oneline']);
        if (ur.code === 0) {
          if (ur.out.trim() === '') return false;
          // has commits ahead of upstream remote ref - treat as unpushed
          return true;
        } else {
          // can't compare against upstream, be conservative
          return true;
        }
      }
      // upstream not origin - be conservative about preservation
    }
    // no upstream configured or not origin - check if branch exists on origin
    const lr = run('git', ['-C', wt, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    if (lr.code === 0) {
      const ur2 = run('git', ['-C', wt, 'log', `origin/${branch}..HEAD`, '--oneline']);
      if (ur2.code === 0) {
        if (ur2.out.trim() === '') return false;
        return true;
      } else {
        return true;
      }
    }
    // branch pushed to origin but not tracked locally? also try ls-remote quickly
    const lrr = quickRun('git', ['-C', wt, 'ls-remote', '--exit-code', '--heads', 'origin', branch], undefined, 2000);
    if (lrr.code === 0) {
      const ur3 = run('git', ['-C', wt, 'log', `origin/${branch}..HEAD`, '--oneline']);
      if (ur3.code === 0) {
        if (ur3.out.trim() === '') return false;
        return true;
      }
    }
    // If pushed to origin branch exists, don't fall through to base-branch check
    // which would incorrectly think unmerged commits mean "unpreserved"
    const chkOriginBranch =
      run('git', ['-C', wt, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).code === 0 ||
      quickRun('git', ['-C', wt, 'ls-remote', '--exit-code', '--heads', 'origin', branch], undefined, 1500).code === 0;
    if (chkOriginBranch) {
      // All commits pushed to origin branch - preserved even if not merged to main
      return false;
    }
  } else if (branch === 'HEAD') {
    // detached HEAD - if commit is on origin, treat as preserved
    const head = run('git', ['-C', wt, 'rev-parse', 'HEAD']);
    if (head.code === 0) {
      const lr = quickRun('git', ['-C', wt, 'branch', '-r', '--contains', head.out.trim()], undefined, 2000);
      if (lr.code === 0 && lr.out.includes('origin/')) {
        return false;
      }
    }
  }
  // Fall back to base branch comparison - if commits are in base (merged), that's fine
  const bases = ['origin/main', 'origin/master', 'origin/HEAD'];
  let anyOk = false;
  for (const base of bases) {
    const rbase = run('git', ['-C', wt, 'rev-parse', '--verify', base]);
    if (rbase.code !== 0) continue;
    anyOk = true;
    const r = run('git', ['-C', wt, 'log', `${base}..HEAD`, '--oneline']);
    if (r.code === 0) {
      if (r.out.trim() !== '') {
        // commits ahead of base but maybe pushed to origin branch - check again
        const br2 = run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']);
        const b2 = br2.out.trim();
        if (b2 && b2 !== 'HEAD') {
          const pushed =
            run('git', ['-C', wt, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${b2}`]).code === 0 ||
            quickRun('git', ['-C', wt, 'ls-remote', '--exit-code', '--heads', 'origin', b2], undefined, 1500).code === 0;
          if (pushed) return false;
        }
        return true;
      }
      // no commits ahead of base means all work is in base (merged) - good
    } else {
      // can't compare - be conservative
      return true;
    }
  }
  if (!anyOk) {
    // can't verify base refs - unknown state, be conservative
    return true;
  }
  return false;
}

function isArmedOrClaimed(p: Planes, treePath: string): boolean {
  const wt = p.status.worktrees.find(t => t.path === treePath);
  if (wt?.claim) return true;
  const armed = (p as any).armedDetails as string[] | undefined;
  if (armed) {
    for (const d of armed) {
      const path = resolveDetail(d, p.main, p.status.worktrees);
      if (path === treePath) return true;
    }
  }
  // also check live session markers directly
  try {
    const details = armedWorkDetails(p.repo);
    for (const d of details) {
      const path = resolveDetail(d, p.main, p.status.worktrees);
      if (path === treePath) return true;
    }
  } catch {
    try {
      const details = (p as any).armedDetails as string[] | undefined;
      if (details) {
        for (const d of details) {
          const path = resolveDetail(d, p.main, p.status.worktrees);
          if (path === treePath) return true;
        }
      }
    } catch {}
  }
  for (const a of (p.status.fleet.agents || [])) {
    if (a.state === 'running' && a.worktree) {
      const ap = resolveAgentWorktreePath(a, p) ?? (a.worktree && isAbsolute(a.worktree) ? a.worktree : undefined);
      if (ap === treePath) return true;
    }
  }
  for (const r of (p.status.loop.runs || [])) {
    if (r.state === 'running' && r.worktree) {
      const rw = r.worktree;
      if (rw === treePath || (typeof rw === 'string' && (rw.startsWith(treePath + '/') || treePath.startsWith(rw + '/')))) return true;
    }
  }
  return false;
}

function reapPreservedDead(p: Planes, ctx: WsCtx): number {
  let reaped = 0;
  for (const w of p.worktrees.worktrees) {
    const ws = w.open_workspace_id;
    if (ws === undefined || w.path === p.main) continue;
    if (worktreeGone(w.path)) continue;
    if (ctx.wsById.get(ws) === undefined) continue;
    // only close managed workspaces with matching workspace id
    const rec = ctx.state.workspaces[w.path];
    if (rec?.managed !== true) {
      continue;
    }
    if (rec.ws !== ws) {
      continue;
    }
    if (isArmedOrClaimed(p, w.path)) {
      log(`keep ${basename(w.path)} — armed/claimed`);
      continue;
    }
    // double check fresh state before deciding
    const pPre = readPlanes(repoDir(ctxJson()));
    if (isArmedOrClaimed(pPre, w.path)) {
      log(`keep ${basename(w.path)} — armed/claimed`);
      continue;
    }
    if (hasLiveRunOrBoundAgent(pPre, w.path)) {
      log(`keep ${basename(w.path)} — live run/bound agent`);
      continue;
    }
    if (hasLiveRunOrBoundAgent(p, w.path)) {
      log(`keep ${basename(w.path)} — live run/bound agent`);
      continue;
    }
    if (!isTreeClean(w.path)) {
      log(`keep ${basename(w.path)} — dirty tree`);
      continue;
    }
    if (hasUnpushedCommits(w.path)) {
      log(`keep ${basename(w.path)} — unpushed commits`);
      continue;
    }
    // must verify work is pushed to origin / remote-preserved
    if (!isBranchPushedToRemote(w.path)) {
      // double-check: if branch has upstream origin or exists on origin, don't block
      const br2 = run('git', ['-C', w.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      if (br2.code === 0 && br2.out.trim().startsWith('origin/')) {
        // fall through
      } else {
        const brn = run('git', ['-C', w.path, 'rev-parse', '--abbrev-ref', 'HEAD']);
        const b = brn.out.trim();
        if (b && b !== 'HEAD') {
          const chk = run('git', ['-C', w.path, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${b}`]);
          const chk2 = run('git', ['-C', w.path, 'branch', '-r', '--list', `origin/${b}`]);
          const tr = run('git', ['-C', w.path, 'config', `branch.${b}.remote`]);
          if (chk.code !== 0 && chk2.code !== 0 && !(tr.code === 0 && tr.out.trim() === 'origin')) {
            log(`keep ${basename(w.path)} — branch not remote-preserved`);
            continue;
          }
        } else {
          log(`keep ${basename(w.path)} — branch not remote-preserved`);
          continue;
        }
      }
    }
    // recheck occupancy immediately before closing to avoid race
    const pFresh1 = readPlanes(repoDir(ctxJson()));
    if (
      isArmedOrClaimed(pFresh1, w.path) ||
      hasLiveRunOrBoundAgent(pFresh1, w.path) ||
      isArmedOrClaimed(p, w.path) ||
      hasLiveRunOrBoundAgent(p, w.path)
    ) {
      log(`keep ${basename(w.path)} — occupied at close time`);
      continue;
    }
    // one more recheck immediately before close
    const pFresh2 = readPlanes(repoDir(ctxJson()));
    if (
      isArmedOrClaimed(pFresh2, w.path) ||
      hasLiveRunOrBoundAgent(pFresh2, w.path) ||
      isArmedOrClaimed(pFresh1, w.path) ||
      hasLiveRunOrBoundAgent(pFresh1, w.path) ||
      isArmedOrClaimed(p, w.path) ||
      hasLiveRunOrBoundAgent(p, w.path)
    ) {
      log(`keep ${basename(w.path)} — occupied at close time`);
      continue;
    }
    // all work remote-preserved
    if (herdrTry(['workspace', 'close', ws]) !== undefined) {
      delete ctx.state.workspaces[w.path];
      delete ctx.state.renderers[w.path];
      delete ctx.state.statuses[w.path];
      delete ctx.state.gone[w.path];
      reaped += 1;
      log(`reaped preserved-dead ${ws} — ${basename(w.path)}`);
    } else {
      log(`reap preserved-dead ${ws} failed — retry next pass`);
    }
  }
  return reaped;
}

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
      delete ctx.state.sessions[w.path];
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
      delete ctx.state.sessions[w.path];
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
  convergeSessions(wsForPath, ctx);
  const reapedGone = reapDead(p, ctx);
  const reapedPreserved = reapPreservedDead(p, ctx);
  const reaped = reapedGone + reapedPreserved;
  saveState(scope, ctx.state);
  return {
    armed: armed.size,
    mirrors: Object.keys(ctx.state.mirrors).length,
    renderers: Object.keys(ctx.state.renderers).length,
    statuses: Object.keys(ctx.state.statuses).length,
    sessions: Object.keys(ctx.state.sessions).length,
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
