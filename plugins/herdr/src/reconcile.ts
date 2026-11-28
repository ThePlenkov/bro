/**
 * converge — the whole sync-plane contract, trigger-free:
 *
 *   planes in → armed worktrees get workspaces (plain bead-title
 *   labels) → running native agents get read-only mirror panes tailing
 *   their logs (mirrors.ts — the acp lane excepted: the session pane
 *   is its one pane, spec bro-l8wqu) → exited agents get their mirror
 *   renamed as an exit marker → every managed workspace gets its
 *   `bro: status` pane (statuses.ts, spec bro-idsat).
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

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { handleOwner } from '../../../packages/core/src/proc.ts';
import { type Lane, laneOf } from './lanes.ts';
import {
  type AgentEntry,
  agentsJson,
  armedWorkDetails,
  ctxJson,
  gitCommonDir,
  type HerdrPane,
  type HerdrWorkspace,
  type HerdrWorktree,
  herdrTry,
  loadState,
  notify,
  PLUGIN_ROOT,
  type PluginState,
  paneIdle,
  paneList,
  pidAlive,
  repoDir,
  run,
  runAsync,
  STATE_DIR,
  type StatusAgent,
  type StatusWorktree,
  saveState,
  stateScope,
  syncPidPath,
  type WorkspaceRec,
  withStateLock,
  withStateLockAsync,
  worktreeGone,
} from './lib.ts';
import { convergeLiveViews, type LiveAgent, liveAgents } from './live-views.ts';
import { convergeMirrors, markExitedMirrors } from './mirrors.ts';
import type { Planes } from './planes.ts';
import { readPlanes } from './planes.ts';
import { dropOrphanRenderers, ensureRenderer, retireEvents } from './renderers.ts';
import { dropOrphanSessions, ensureSession } from './sessions.ts';
import { agentTreePath } from './status.ts';
import { dropOrphanStatuses, ensureStatus, retireStatus } from './statuses.ts';

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
 * `<lane-icon> <worktree-name>`: 🤖 on the acp lane (a headless robot
 * owns the session pane), ⚙️ on every other managed lane (spec
 * bro-l8wqu, operator decision) — so a fresh workspace never flashes
 * a bead title or raw slug the next pass would overwrite anyway. */
function desiredLabel(tree: ArmedTree, lane: Lane | undefined): string {
  return `${lane === 'acp' ? '🤖' : '⚙️'} ${basename(tree.path)}`;
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
  reconcileWsRecord(ctx, path, openId);
  return openId;
}

/** The recorded record vs the live binding — one of four outcomes:
 *  adopt a reopened id, drop a vanished workspace's record, observe
 *  a user-opened one, or resync the projector's relabel. */
function reconcileWsRecord(ctx: WsCtx, path: string, openId: string): void {
  const rec = ctx.state.workspaces[path];
  const live = ctx.wsById.get(openId);
  if (rec === undefined) {
    // a workspace the user opened — observe, never touch its label
    ctx.state.workspaces[path] = { ws: openId, label: live?.label ?? '', managed: false };
    return;
  }
  if (live === undefined) {
    delete ctx.state.workspaces[path];
    return;
  }
  if (rec.ws !== openId) {
    // the workspace was closed externally and reopened under a NEW id —
    // openByPath already follows the live binding, so the record must
    // adopt it: a stale rec.ws fails every rec.ws===live-wsId guard
    // downstream and the workspace silently loses panes + projection
    // until the binding disappears entirely (bro-0knei)
    ctx.state.workspaces[path] = { ...rec, ws: openId, label: live.label ?? '' };
    return;
  }
  if (projectorRelabeled(rec, live)) {
    // the projector relabels managed workspaces — keep the record's
    // view of the live label honest so a restart doesn't misread it
    ctx.state.workspaces[path] = { ...rec, label: live.label ?? '' };
  }
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
  ctx: WsCtx,
  viewable: Set<string>
): Map<string, string> {
  const wsForPath = new Map<string, string>();
  for (const t of armed.values()) {
    // the viewable gate (user ruling 10.11): a workspace exists only
    // where the session pane has something to show — an armed tree
    // with nothing recorded is an empty window, never opened
    if (!viewable.has(t.path)) continue;
    const ws = ensureWorkspace(t, desiredLabel(t, laneOf(p.lanes, t.path)), ctx);
    if (ws !== undefined) wsForPath.set(t.path, ws);
  }
  return wsForPath;
}

/** Exactly one renderer per managed workspace — after mirrors so a
 *  live mirror retires the fallback tail in the same pass. The
 *  recorded ws id must match the live one — a stale `managed` record
 *  left by a user reopen must not put our pane on their workspace. */
function convergeRenderers(
  wsForPath: Map<string, string>,
  ctx: WsCtx,
  sessionArmed: Set<string>
): void {
  for (const [path, ws] of wsForPath) {
    const rec = ctx.state.workspaces[path];
    if (rec?.managed === true && rec.ws === ws) {
      // an armed session pane shows exactly one pane — the view folds
      // the bus tail in (spec bro-l8wqu)
      const rctx = { path, ws, state: ctx.state };
      if (sessionArmed.has(path)) retireEvents(rctx);
      else ensureRenderer(rctx);
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
function convergeStatuses(
  wsForPath: Map<string, string>,
  ctx: WsCtx,
  sessionArmed: Set<string>
): void {
  for (const [path, ws] of wsForPath) {
    const rec = ctx.state.workspaces[path];
    if (rec?.managed === true && rec.ws === ws) {
      // an armed session pane folds the status strip into the view
      // (spec bro-l8wqu)
      const rctx = { path, ws, state: ctx.state };
      if (sessionArmed.has(path)) retireStatus(rctx);
      else ensureStatus(rctx);
    }
  }
  dropOrphanStatuses(ctx.state, new Set([...ctx.wsById.keys(), ...wsForPath.values()]));
}

/** The session pane arms BEFORE the retire phases on every viewable
 *  worktree (spec bro-l8wqu): it is the one human-readable pane — the
 *  acp lane's session attach OR any managed worktree with a session
 *  record on disk, live or archived — and a workspace whose last pane
 *  closes mid-pass is
 *  auto-reaped under the retiring surfaces, so the flip order must
 *  leave a live pane behind at every step or the whole workspace
 *  vanishes (dogfood finding). Same managed-record guard as the
 *  renderer. */
function convergeSessionPanes(
  wsForPath: Map<string, string>,
  ctx: WsCtx,
  bindByTree: Map<string, { id: string; events: string }>
): Set<string> {
  // pane-live paths — fallback surfaces fold only where the human
  // pane actually ended up live: eligibility alone must not retire
  // the mirror into an empty workspace (a failed arm, an unmanaged
  // record, a stale ws all leave eligibility without a pane)
  const live = new Set<string>();
  for (const [path, ws] of wsForPath) {
    const rec = ctx.state.workspaces[path];
    if (rec?.managed !== true || rec.ws !== ws) continue;
    // the binding is the worktree's LATEST journal record — dead
    // included: a crashed worker's archive is still the pane's feed
    // and its registry entry is what lets the worker floor read
    // 'blocked' instead of a blind idle
    const agent = bindByTree.get(path);
    if (ensureSession({ path, ws, state: ctx.state, ...(agent !== undefined ? { agent } : {}) })) {
      live.add(path);
    }
  }
  return live;
}

/** The archive binding per worktree — the LATEST registry record,
 *  dead included: a crashed agent's journal is still the pane's
 *  archive, and its record is what lets the pane's worker floor
 *  read 'blocked' instead of a blind worktree-bound idle. Live
 *  handle-file agents may have no registry record — they overlay. */
function archiveBinds(
  base: string,
  main: string,
  liveByTree: Map<string, { id: string; events: string }>
): Map<string, { id: string; events: string; at: string }> {
  const bindByTree = new Map<string, { id: string; events: string; at: string }>();
  for (const e of Object.values(agentsJson(base))) {
    const cand = archiveBindOf(e, main);
    if (cand === undefined) continue;
    const cur = bindByTree.get(cand.key);
    if (cur === undefined || cand.at >= cur.at) {
      bindByTree.set(cand.key, { id: cand.id, events: cand.events, at: cand.at });
    }
  }
  for (const [key, a] of liveByTree) {
    // a warming live agent whose journal has not landed yet must not
    // bury the tree's usable archive — overlay a dead bind only over
    // nothing (codeant: the missing file would disarm AND retire the
    // recorded session pane)
    if (!bindByTree.has(key) || existsSync(a.events)) {
      bindByTree.set(key, { ...a, at: '\uffff' });
    }
  }
  return bindByTree;
}

/** One registry entry → its archive binding candidate, or undefined
 *  when it carries no tailable journal. The status plane keys on
 *  absolute paths — a relative registry worktree resolves against
 *  main so every downstream compare shares the vocabulary. */
function archiveBindOf(
  e: AgentEntry,
  main: string
): { key: string; id: string; events: string; at: string } | undefined {
  if (e.worktree === undefined || typeof e.log !== 'string') return undefined;
  const events = e.log.replace(/\.log$/, '.events.jsonl');
  if (!existsSync(events)) return undefined;
  const key = isAbsolute(e.worktree) ? e.worktree : resolve(main, e.worktree);
  return {
    key,
    id: basename(e.log).replace(/\.log$/, ''),
    events,
    at: typeof e.spawnedAt === 'string' ? e.spawnedAt : '',
  };
}

/** The session view is THE human pane (user ruling 10.11) — every
 *  tree that passed the viewable gate gets it, live or archived or
 *  acp, and the technical surfaces (mirror tail, events renderer,
 *  status strip) are plugin plumbing that always folds under it. A
 *  managed workspace whose tree lost ALL session content is an empty
 *  window — close it whole rather than show a human 'no session
 *  recorded' forever; armed-but-recordless trees live on the fleet
 *  board, not in herdr. */
function retireUnviewable(viewable: Set<string>, ctx: WsCtx): void {
  for (const [path, rec] of Object.entries(ctx.state.workspaces)) {
    if (rec.managed !== true || viewable.has(path)) continue;
    if (ctx.wsById.has(rec.ws)) {
      herdrTry(['workspace', 'close', rec.ws]);
      log(`closed ${basename(path)} — nothing viewable (${rec.ws})`);
    }
    // every pane record on the dead workspace dies with it — mirrors
    // key on the step, not the path, so sweep by workspace id
    dropPaneRecords(ctx, path);
    for (const [step, m] of Object.entries(ctx.state.mirrors)) {
      if (m.workspace === rec.ws) delete ctx.state.mirrors[step];
    }
  }
}

/** The four pane-keyed records on one tree — workspaces, sessions,
 *  renderers, statuses. `gone` stays the caller's: the reapers own
 *  its lifecycle, the retire path never touches it. */
function dropPaneRecords(ctx: WsCtx, path: string): void {
  delete ctx.state.workspaces[path];
  delete ctx.state.sessions[path];
  delete ctx.state.renderers[path];
  delete ctx.state.statuses[path];
}

/** Every record keyed on the tree — the pane four plus the reaper's
 *  `gone` sighting. */
function forgetTree(ctx: WsCtx, path: string): void {
  dropPaneRecords(ctx, path);
  delete ctx.state.gone[path];
}

/** Orphan sweep — a session record outliving its workspace (a foreign
 *  close, an unviewable retire) drops with the pane it ran. */
function convergeSessions(wsForPath: Map<string, string>, ctx: WsCtx): void {
  dropOrphanSessions(ctx.state, new Set([...ctx.wsById.keys(), ...wsForPath.values()]));
}

/** The reaper — a worktree herdr still opens a workspace for, gone off
 *  disk. One sighting stamps `goneSince`; a second pass at least the
 *  grace window later closes the workspace. Only filesystem proof and
 *  time decide — a vanished checkout is never "transient" twice. */
const GONE_GRACE_MS = 60_000;

function resolveAgentWorktreePath(a: StatusAgent, p: Planes): string | undefined {
  // agentTreePath first (handles registry + name resolution)
  const direct = agentTreePath(a, p);
  if (direct !== undefined && direct !== '') return direct;
  if (a.worktree === undefined || a.worktree === '') return undefined;
  // an absolute worktree names itself when no status row claims it
  if (isAbsolute(a.worktree)) {
    return p.status.worktrees.find(t => t.path === a.worktree)?.path ?? a.worktree;
  }
  // a bare name resolves through the status plane's worktrees
  return p.status.worktrees.find(t => t.name === a.worktree)?.path;
}

/** Prefix-containment counts — a process parked in a subdirectory of
 *  the tree (or in a parent that owns it) still occupies it. */
function pathRelated(a: string, treePath: string): boolean {
  return a === treePath || a.startsWith(`${treePath}/`) || treePath.startsWith(`${a}/`);
}

/** A running fleet agent whose resolved worktree covers this tree —
 *  names resolve through `agentTreePath` so a registry-name sighting
 *  still matches the status plane's absolute paths. */
function fleetAgentLive(p: Planes, treePath: string): boolean {
  for (const a of p.status.fleet.agents) {
    if (a.state !== 'running') continue;
    const ap =
      resolveAgentWorktreePath(a, p) ??
      (a.worktree !== undefined && isAbsolute(a.worktree) ? a.worktree : undefined);
    if (ap !== undefined && pathRelated(ap, treePath)) return true;
  }
  return false;
}

function loopRunLive(p: Planes, treePath: string): boolean {
  for (const r of p.status.loop.runs) {
    if (r.state === 'running' && r.worktree !== undefined) {
      if (r.worktree === treePath || r.worktree.startsWith(`${treePath}/`)) return true;
    }
  }
  return false;
}

/** One registry entry is live only with a pid that is actually alive
 *  AND a fleet record still reporting `running` — a pid-less, dead, or
 *  exited entry must not pin a workspace forever. */
function registryEntryLive(p: Planes, entry: AgentEntry): boolean {
  if (entry.pid === undefined || entry.pid === null) return false;
  const pidStart = entry.pidStart as string | undefined;
  if (!pidAlive(entry.pid, pidStart)) return false;
  const eid = entry.agentId ?? entry.id ?? entry.molStep;
  if (eid === undefined) return false;
  const a = (p.status.fleet.agents ?? []).find(
    x => ((x as { agentId?: string }).agentId ?? x.id) === eid
  );
  return a?.state === 'running';
}

function registryLive(p: Planes, treePath: string): boolean {
  return Object.values(agentsJson(p.repo)).some(
    entry =>
      entry.worktree !== undefined &&
      pathRelated(entry.worktree, treePath) &&
      registryEntryLive(p, entry)
  );
}

function paneWorkspaceRelated(p: Planes, ws: HerdrWorkspace, treePath: string): boolean {
  const wpath = ws.worktree?.checkout_path;
  if (wpath !== undefined && pathRelated(wpath, treePath)) return true;
  return p.worktrees.worktrees.some(
    w => w.open_workspace_id === ws.workspace_id && pathRelated(w.path, treePath)
  );
}

/** Pane-level agents — any non-`bro-status` agent value on a related
 *  workspace's pane means live. A pane list that can't be read is an
 *  unknown, and unknown fails CLOSED: the workspace stays open. */
function paneAgentLive(p: Planes, treePath: string): boolean {
  for (const ws of p.workspaces) {
    if (!paneWorkspaceRelated(p, ws, treePath)) continue;
    try {
      if (paneList(ws.workspace_id).some(liveAgentPane)) return true;
    } catch {
      log(`pane list failed for ${ws.workspace_id} — keeping ${basename(treePath)} (fail closed)`);
      return true;
    }
  }
  return false;
}

/** Any non-`bro-status` agent value on a pane means live. */
function liveAgentPane(pane: HerdrPane): boolean {
  return pane.agent !== undefined && pane.agent !== '' && pane.agent !== 'bro-status';
}

function hasLiveRunOrBoundAgent(p: Planes, treePath: string): boolean {
  return (
    fleetAgentLive(p, treePath) ||
    loopRunLive(p, treePath) ||
    registryLive(p, treePath) ||
    paneAgentLive(p, treePath)
  );
}

function quickRun(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 2000
): { code: number; out: string; err: string } {
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

async function quickRunAsync(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 2000
): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out, err });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', chunk => {
      out += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', chunk => {
      err += chunk;
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(error) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/** The upstream ref verbatim — `undefined` when unset. Callers decide
 *  whether a non-origin upstream proves anything (it doesn't — issue
 *  #817's remote is `origin`). */
function upstreamRef(wt: string): string | undefined {
  const r = run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const up = r.code === 0 ? r.out.trim() : '';
  return up === '' ? undefined : up;
}

/** `undefined` for a detached HEAD — the branch-name callers then know
 *  commit reachability is the only vocabulary left. */
function currentBranch(wt: string): string | undefined {
  const b = run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  return b !== '' && b !== 'HEAD' ? b : undefined;
}

/** A same-named branch exists on origin — local remote-tracking ref,
 *  origin-tracked branch config, or a bounded ls-remote probe. */
function branchExistsOnOrigin(wt: string, branch: string): boolean {
  if (
    run('git', ['-C', wt, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
      .code === 0
  ) {
    return true;
  }
  const listed = run('git', ['-C', wt, 'branch', '-r', '--list', `origin/${branch}`]);
  if (listed.code === 0 && listed.out.trim() !== '') return true;
  const tr = run('git', ['-C', wt, 'config', `branch.${branch}.remote`]);
  if (tr.code === 0 && tr.out.trim() === 'origin') return true;
  return (
    quickRun(
      'git',
      ['-C', wt, 'ls-remote', '--exit-code', '--heads', 'origin', branch],
      undefined,
      2000
    ).code === 0
  );
}

/** Detached HEAD — preserved when the checked-out commit is reachable
 *  from an origin remote-tracking ref (there is no branch to compare,
 *  only the commit). */
function detachedHeadPreserved(wt: string): boolean {
  const head = run('git', ['-C', wt, 'rev-parse', 'HEAD']);
  if (head.code !== 0) return false;
  const lr = quickRun(
    'git',
    ['-C', wt, 'branch', '-r', '--contains', head.out.trim()],
    undefined,
    2000
  );
  return lr.code === 0 && lr.out.includes('origin/');
}

/** Commits merged into a verified remote base are preserved even when
 *  the original branch ref was deleted and pruned. */
function mergedIntoBase(wt: string): boolean {
  for (const base of ['origin/main', 'origin/master', 'origin/HEAD']) {
    if (run('git', ['-C', wt, 'rev-parse', '--verify', base]).code !== 0) continue;
    const rlog = run('git', ['-C', wt, 'log', `${base}..HEAD`, '--oneline']);
    if (rlog.code === 0 && rlog.out.trim() === '') return true;
  }
  return false;
}

function isBranchPushedToRemote(wt: string): boolean {
  // an origin upstream names preservation directly; a non-origin
  // upstream falls through — only origin counts (issue #817)
  if (upstreamRef(wt)?.startsWith('origin/') === true) return true;
  const branch = currentBranch(wt);
  if (branch === undefined) {
    return detachedHeadPreserved(wt) || mergedIntoBase(wt);
  }
  return branchExistsOnOrigin(wt, branch) || mergedIntoBase(wt);
}

function isTreeClean(wt: string): boolean {
  const r = run('git', ['-C', wt, 'status', '--porcelain']);
  return r.code === 0 && r.out.trim() === '';
}

/** `log <ref>..HEAD` verdict — 'unknown' when the compare itself fails
 *  so callers can fail closed instead of reading silence as clean. */
type Ahead = 'ahead' | 'clean' | 'unknown';
function aheadOf(wt: string, ref: string): Ahead {
  const r = run('git', ['-C', wt, 'log', `${ref}..HEAD`, '--oneline']);
  if (r.code !== 0) return 'unknown';
  return r.out.trim() === '' ? 'clean' : 'ahead';
}

/** Remote head SHA of the origin branch via a bounded ls-remote —
 *  `undefined` when the branch isn't on the remote or the probe died. */
function remoteBranchHead(wt: string, branch: string): string | undefined {
  const r = quickRun(
    'git',
    ['-C', wt, 'ls-remote', '--exit-code', '--heads', 'origin', branch],
    undefined,
    2000
  );
  const m = r.code === 0 ? /^([0-9a-f]{40})\t/m.exec(r.out) : null;
  return m?.[1];
}

/** HEAD ⊆ sha — the object must exist locally AND be HEAD's descendant.
 *  An object we don't have is unverifiable, and unverifiable fails
 *  closed (never "pushed" on faith). */
function headContainedIn(wt: string, sha: string): boolean {
  if (run('git', ['-C', wt, 'cat-file', '-e', sha]).code !== 0) return false;
  return run('git', ['-C', wt, 'merge-base', '--is-ancestor', 'HEAD', sha]).code === 0;
}

/** HEAD ⊆ the branch's origin counterpart — the local remote-tracking
 *  ref first; when it's missing the remote head sha must carry the
 *  proof. Branch EXISTENCE alone is not preservation (review thread:
 *  a same-named remote branch could be behind local commits). */
function pushedToOriginBranch(wt: string, branch: string): Ahead {
  if (
    run('git', ['-C', wt, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
      .code === 0
  ) {
    const a = aheadOf(wt, `origin/${branch}`);
    return a === 'clean' ? 'clean' : 'ahead';
  }
  const sha = remoteBranchHead(wt, branch);
  if (sha === undefined) return 'unknown';
  return headContainedIn(wt, sha) ? 'clean' : 'ahead';
}

function hasUnpushedCommits(wt: string): boolean {
  const branch = currentBranch(wt);
  if (branch === undefined) {
    // detached HEAD — preserved only when the commit rides an origin ref
    return !detachedHeadPreserved(wt);
  }
  const up = upstreamRef(wt);
  if (up?.startsWith('origin/') === true) {
    const a = aheadOf(wt, up);
    return a !== 'clean';
  }
  // no origin upstream — does an origin branch ref carry the commits?
  const ob = pushedToOriginBranch(wt, branch);
  if (ob !== 'unknown') return ob === 'ahead';
  // no origin branch either — merged-into-base is the last proof;
  // unverifiable bases mean unknown, and unknown fails closed.
  return unpushedAgainstBases(wt, branch);
}

/** Base-branch fallback — commits ahead of a verified base are
 *  unpreserved unless the branch's origin counterpart carries them;
 *  a base that can't be read is an unknown, and unknown fails closed. */
function unpushedAgainstBases(wt: string, branch: string): boolean {
  let anyOk = false;
  for (const base of ['origin/main', 'origin/master', 'origin/HEAD']) {
    if (run('git', ['-C', wt, 'rev-parse', '--verify', base]).code !== 0) continue;
    anyOk = true;
    const a = aheadOf(wt, base);
    if (a === 'unknown') return true;
    if (a === 'ahead') {
      // ahead of base but maybe pushed to the origin branch — ancestry,
      // not branch existence, decides
      return pushedToOriginBranch(wt, branch) !== 'clean';
    }
  }
  return !anyOk;
}

/** Marker details naming a live session — the plane's own list plus a
 *  fresh on-disk scan so a marker written mid-pass still counts. */
function armedDetailsFresh(p: Planes): string[] {
  try {
    return [...(p.armedDetails ?? []), ...armedWorkDetails(p.repo)];
  } catch {
    return [...(p.armedDetails ?? [])];
  }
}

/** A claimed or session-marked tree stays a desired workspace even
 *  when nothing runs in it right now — closing it would just make the
 *  next pass reopen and churn (codeant review thread). */
function isArmedOrClaimed(p: Planes, treePath: string): boolean {
  const wt = p.status.worktrees.find(t => t.path === treePath);
  if (wt?.claim !== undefined && wt.claim !== '') return true;
  for (const d of armedDetailsFresh(p)) {
    if (resolveDetail(d, p.main, p.status.worktrees) === treePath) return true;
  }
  return fleetAgentLive(p, treePath) || loopRunLive(p, treePath);
}

/** Structural gate — the cheap checks that skip without a git call or
 *  a log line. Only a managed workspace record whose recorded id
 *  matches the live workspace is reapable at all. */
function reapableWorkspace(p: Planes, ctx: WsCtx, w: HerdrWorktree): boolean {
  const ws = w.open_workspace_id;
  if (ws === undefined || w.path === p.main) return false;
  if (worktreeGone(w.path)) return false; // reapDead owns gone trees
  if (ctx.wsById.get(ws) === undefined) return false;
  const rec = ctx.state.workspaces[w.path];
  return rec?.managed === true && rec.ws === ws;
}

/** Occupancy can flip between the snapshot and the close — re-read the
 *  planes right before deciding so a just-armed claim or a just-started
 *  agent always wins over the reaper. */
function occupiedNow(path: string): boolean {
  const fresh = readPlanes(repoDir(ctxJson()));
  return (
    isArmedOrClaimed(fresh, path) ||
    armedSet(fresh).has(path) ||
    hasLiveRunOrBoundAgent(fresh, path)
  );
}

/** Close the workspace and drop every record keyed on the tree — the
 *  same ledger sweep reapDead does, sessions included. */
function closeAndForget(ctx: WsCtx, path: string, ws: string): boolean {
  if (herdrTry(['workspace', 'close', ws]) === undefined) return false;
  forgetTree(ctx, path);
  return true;
}

/** The preserved-dead reaper — a managed workspace whose tree is
 *  clean, whose work is verifiably on origin, and that nothing live
 *  occupies gets closed instead of lingering forever (issue #817). */
function reapPreservedDead(p: Planes, ctx: WsCtx): number {
  let reaped = 0;
  for (const w of p.worktrees.worktrees) {
    const ws = w.open_workspace_id;
    if (ws === undefined || !reapableWorkspace(p, ctx, w)) continue;
    const keep = keepReason(p, w);
    if (keep !== undefined) {
      log(`keep ${basename(w.path)} — ${keep}`);
      continue;
    }
    if (closeAndForget(ctx, w.path, ws)) {
      reaped += 1;
      log(`reaped preserved-dead ${ws} — ${basename(w.path)}`);
    } else {
      log(`reap preserved-dead ${ws} failed — retry next pass`);
    }
  }
  return reaped;
}

/** Why a reapable workspace survives this pass — occupancy first,
 *  then the git proofs, then one last occupancy re-read before the
 *  irreversible close so a use that started mid-check still wins. */
function keepReason(p: Planes, w: HerdrWorktree): string | undefined {
  if (occupied(p, w.path)) return 'occupied';
  if (!isTreeClean(w.path)) return 'dirty tree';
  if (hasUnpushedCommits(w.path) || !isBranchPushedToRemote(w.path)) {
    return 'work not remote-preserved';
  }
  return occupiedNow(w.path) ? 'occupied at close time' : undefined;
}

async function asyncUpstreamRef(wt: string): Promise<string | undefined> {
  const r = await runAsync('git', [
    '-C',
    wt,
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  const up = r.code === 0 ? r.out.trim() : '';
  return up === '' ? undefined : up;
}

async function asyncCurrentBranch(wt: string): Promise<string | undefined> {
  const b = (await runAsync('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  return b !== '' && b !== 'HEAD' ? b : undefined;
}

async function asyncBranchExistsOnOrigin(wt: string, branch: string): Promise<boolean> {
  for (const args of [
    ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    ['branch', '-r', '--list', `origin/${branch}`],
    ['config', `branch.${branch}.remote`],
  ]) {
    const local = await runAsync('git', ['-C', wt, ...args]);
    if (
      (args[0] === 'show-ref' && local.code === 0) ||
      (args[0] === 'branch' && local.code === 0 && local.out.trim() !== '') ||
      (args[0] === 'config' && local.code === 0 && local.out.trim() === 'origin')
    ) {
      return true;
    }
  }
  const r = await quickRunAsync(
    'git',
    ['-C', wt, 'ls-remote', '--exit-code', '--heads', 'origin', branch],
    undefined,
    2000
  );
  return r.code === 0;
}

async function asyncDetachedHeadPreserved(wt: string): Promise<boolean> {
  const head = await runAsync('git', ['-C', wt, 'rev-parse', 'HEAD']);
  if (head.code !== 0) return false;
  const lr = await quickRunAsync(
    'git',
    ['-C', wt, 'branch', '-r', '--contains', head.out.trim()],
    undefined,
    2000
  );
  return lr.code === 0 && lr.out.includes('origin/');
}

async function asyncIsBranchPushedToRemote(wt: string): Promise<boolean> {
  const up = await asyncUpstreamRef(wt);
  if (up?.startsWith('origin/') === true) return true;
  const branch = await asyncCurrentBranch(wt);
  if (branch === undefined) return asyncDetachedHeadPreserved(wt);
  return asyncBranchExistsOnOrigin(wt, branch);
}

async function asyncAheadOf(wt: string, ref: string): Promise<Ahead> {
  const r = await runAsync('git', ['-C', wt, 'log', `${ref}..HEAD`, '--oneline']);
  if (r.code !== 0) return 'unknown';
  return r.out.trim() === '' ? 'clean' : 'ahead';
}

async function asyncIsTreeClean(wt: string): Promise<boolean> {
  const r = await runAsync('git', ['-C', wt, 'status', '--porcelain']);
  return r.code === 0 && r.out.trim() === '';
}

async function asyncRemoteBranchHead(wt: string, branch: string): Promise<string | undefined> {
  const r = await quickRunAsync(
    'git',
    ['-C', wt, 'ls-remote', '--exit-code', '--heads', 'origin', branch],
    undefined,
    2000
  );
  const m = r.code === 0 ? /^([0-9a-f]{40})\t/m.exec(r.out) : null;
  return m?.[1];
}

async function asyncPushedToOriginBranch(wt: string, branch: string): Promise<Ahead> {
  const local = await runAsync('git', [
    '-C',
    wt,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);
  if (local.code === 0) return asyncAheadOf(wt, `origin/${branch}`);
  const sha = await asyncRemoteBranchHead(wt, branch);
  if (sha === undefined) return 'unknown';
  const exists = await runAsync('git', ['-C', wt, 'cat-file', '-e', sha]);
  if (exists.code !== 0) return 'ahead';
  const contained = await runAsync('git', ['-C', wt, 'merge-base', '--is-ancestor', 'HEAD', sha]);
  return contained.code === 0 ? 'clean' : 'ahead';
}

async function asyncHasUnpushedCommits(wt: string): Promise<boolean> {
  const branch = await asyncCurrentBranch(wt);
  if (branch === undefined) return !(await asyncDetachedHeadPreserved(wt));
  const up = await asyncUpstreamRef(wt);
  if (up?.startsWith('origin/') === true) return (await asyncAheadOf(wt, up)) !== 'clean';
  const ob = await asyncPushedToOriginBranch(wt, branch);
  if (ob !== 'unknown') return ob === 'ahead';
  for (const base of ['origin/main', 'origin/master', 'origin/HEAD']) {
    if ((await runAsync('git', ['-C', wt, 'rev-parse', '--verify', base])).code !== 0) continue;
    const a = await asyncAheadOf(wt, base);
    if (a === 'unknown') return true;
    if (a === 'ahead') return (await asyncPushedToOriginBranch(wt, branch)) !== 'clean';
  }
  return true;
}

async function reapPreservedDeadAsync(p: Planes, ctx: WsCtx): Promise<number> {
  let reaped = 0;
  for (const w of p.worktrees.worktrees) {
    const ws = w.open_workspace_id;
    if (ws === undefined || !reapableWorkspace(p, ctx, w)) continue;
    if (
      occupied(p, w.path) ||
      !(await asyncIsTreeClean(w.path)) ||
      (await asyncHasUnpushedCommits(w.path)) ||
      !(await asyncIsBranchPushedToRemote(w.path)) ||
      occupiedNow(w.path)
    )
      continue;
    if (closeAndForget(ctx, w.path, ws)) reaped += 1;
  }
  return reaped;
}

/** Anything still using the tree — armed, claimed, a live run or
 *  bound agent, or a fresh planes sighting. */
function occupied(p: Planes, path: string): boolean {
  return (
    isArmedOrClaimed(p, path) ||
    armedSet(p).has(path) ||
    hasLiveRunOrBoundAgent(p, path) ||
    occupiedNow(path)
  );
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
      forgetTree(ctx, w.path);
      continue;
    }
    if (reapGoneTree(ctx, w, ws, now)) reaped += 1;
  }
  return reaped;
}

/** One gone worktree — residue when the workspace id already
 *  vanished, a `goneSince` stamp on the first sighting, the close
 *  only once the grace window passed. */
function reapGoneTree(ctx: WsCtx, w: HerdrWorktree, ws: string, now: number): boolean {
  if (ctx.wsById.get(ws) === undefined) {
    // the workspace plane no longer carries this id — somebody closed
    // it already; whatever we recorded is residue.
    forgetTree(ctx, w.path);
    return false;
  }
  const since = ctx.state.gone[w.path];
  if (since === undefined) {
    ctx.state.gone[w.path] = now;
    return false;
  }
  if (now - since < GONE_GRACE_MS) return false;
  if (herdrTry(['workspace', 'close', ws]) === undefined) {
    log(`reap ${ws} failed — retry next pass`);
    return false;
  }
  forgetTree(ctx, w.path);
  log(`reaped ${ws} — worktree gone: ${basename(w.path)}`);
  return true;
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

/** Async daemon pass. Git preservation probes use non-blocking children so
 *  a slow remote cannot freeze the event loop between source events. */
export async function convergeAsync(p: Planes): Promise<ConvergeResult> {
  const scope = stateScope(p.main);
  return withStateLockAsync(scope, () => convergeLockedAsync(p, scope));
}

async function convergeLockedAsync(p: Planes, scope: string): Promise<ConvergeResult> {
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
  const base = gitCommonDir(p.main) ?? p.main;
  const live = liveAgents(base);
  const { bindByTree, viewable } = bindPlanes(p, base, live);
  const wsForPath = convergeWorkspaces(p, armed, ctx, viewable);
  const sessionLive = convergeSessionPanes(wsForPath, ctx, bindByTree);
  convergeMirrors({ p, wsForPath, openByPath: ctx.openByPath, state: ctx.state, sessionLive });
  markExitedMirrors(p, ctx.state, sessionLive);
  convergeRenderers(wsForPath, ctx, sessionLive);
  convergeStatuses(wsForPath, ctx, sessionLive);
  convergeSessions(wsForPath, ctx);
  convergeLiveViews(base, p.main, ctx.state, new Set(armed.keys()), live);
  retireUnviewable(viewable, ctx);
  const reaped = reapDead(p, ctx) + (await reapPreservedDeadAsync(p, ctx));
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
  const base = gitCommonDir(p.main) ?? p.main;
  const live = liveAgents(base);
  const { bindByTree, viewable } = bindPlanes(p, base, live);
  const wsForPath = convergeWorkspaces(p, armed, ctx, viewable);
  // the viewable lane's one pane arms before any retire — a workspace
  // emptying mid-flip is auto-reaped under the closing panes. The
  // retire set is pane-LIVE, not eligibility: an arm that never
  // landed leaves the fallback panes in place
  const sessionLive = convergeSessionPanes(wsForPath, ctx, bindByTree);
  convergeMirrors({ p, wsForPath, openByPath: ctx.openByPath, state: ctx.state, sessionLive });
  markExitedMirrors(p, ctx.state, sessionLive);
  convergeRenderers(wsForPath, ctx, sessionLive);
  convergeStatuses(wsForPath, ctx, sessionLive);
  convergeSessions(wsForPath, ctx);
  // live agents with no armed worktree get a plugin-owned view
  // workspace+pane; armed trees are covered by their own panes
  convergeLiveViews(base, p.main, ctx.state, new Set(armed.keys()), live);
  // the viewable gate's other half — a managed workspace that lost all
  // session content is an empty window; it closes whole (user ruling)
  retireUnviewable(viewable, ctx);
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

/** The bind planes one registry scan feeds — the archive binding
 *  per worktree AND the viewable gate (user ruling 10.11): a
 *  workspace opens only where the session pane has something to
 *  show — a session record (live or archived), a live agent journal,
 *  or the acp lane. An armed tree with nothing recorded is an empty
 *  window; it never opens, and a managed one that lost its content
 *  closes. */
function bindPlanes(
  p: Planes,
  base: string,
  live: LiveAgent[]
): { bindByTree: Map<string, { id: string; events: string }>; viewable: Set<string> } {
  // the status plane keys on absolute paths; a registry worktree may
  // be relative — normalize the sightings ONCE so liveByTree AND the
  // live-view coverage check compare the same vocabulary (field bug:
  // a relative registry path never matched an absolute armed key, so
  // the same agent got a session pane AND a second 🤖 view: workspace)
  const liveByTree = new Map<string, { id: string; events: string }>();
  for (const a of live) {
    if (a.worktree !== undefined && !isAbsolute(a.worktree)) {
      a.worktree = resolve(p.main, a.worktree);
    }
    if (a.worktree === undefined) continue;
    const cur = liveByTree.get(a.worktree);
    // several live agents can share one worktree — keep the one whose
    // journal exists: a warming-up agent that wins the slot leaves
    // eligibility blind and can retire a live session pane
    if (cur !== undefined && existsSync(cur.events) && !existsSync(a.events)) continue;
    liveByTree.set(a.worktree, { id: a.id, events: a.events });
  }
  const bindByTree = archiveBinds(base, p.main, liveByTree);
  const viewable = new Set<string>(bindByTree.keys());
  for (const [path, lane] of Object.entries(p.lanes)) {
    if (lane === 'acp') viewable.add(path);
  }
  return { bindByTree, viewable };
}

/** One-shot entry — the `sync` action and the startup hook both land
 *  here: read the planes once, converge once, done. The daemon loop in
 *  sync.ts is the same converge behind an EventSource. */
export async function reconcile(): Promise<ConvergeResult> {
  return convergeAsync(readPlanes(repoDir(ctxJson())));
}

/** The label the sync pane carries — `pane open` replaces nothing, so
 *  a dead loop's husk is swept before its successor opens or every
 *  recovery accumulates another bare-shell pane. */
const SYNC_LABEL = 'bro sync';

/** A fresh pid file with no live pid means another ensure already
 *  fired `pane open` and the spawn is still landing — check→open is
 *  never atomic, so the file doubles as the in-flight marker that
 *  keeps overlapping ensures (startup hook + manual action) from each
 *  opening a pane. */
const OPEN_GRACE_MS = 60_000;

/** The probe — a live pinned pid IS the loop (the start token pins
 *  identity against reuse; EPERM/zombie verdicts ride inside
 *  pidAlive), and a FRESH 'pending' is another ensure mid-open. A
 *  dead pid, a stale pending, or an absent file means the slot is
 *  free. */
function syncPidLiveOrPending(pidFile: string): boolean {
  try {
    const text = readFileSync(pidFile, 'utf8').trim();
    const owner = handleOwner(text);
    if (owner !== null) return pidAlive(owner.pid, owner.start);
    return text === 'pending' && Date.now() - statSync(pidFile).mtimeMs < OPEN_GRACE_MS;
  } catch {
    return false;
  }
}

/** The 'wx' pending-marker claim — true when the slot is ours to open.
 *  A non-EEXIST write failure degrades to an undeduplicated open (the
 *  loop must not be stranded on a marker it cannot write); EEXIST
 *  means a racer landed a marker — a live one owns the slot, a stale
 *  'pending' is a crashed opener's residue broken once and retaken
 *  (a racer winning that gap owns the open). */
function claimSyncSlot(pidFile: string, live: () => boolean): boolean {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(pidFile, 'pending\n', { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return true;
    if (live()) return false; // a live pid or a fresh pending owns the slot
    try {
      rmSync(pidFile, { force: true });
      writeFileSync(pidFile, 'pending\n', { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }
}

/** Every 'bro sync' pane rooted at THIS plugin whose loop is dead is a
 *  husk — close them or the successor piles up next to bare shells.
 *  cwd scoping keeps another repository's sync pane (same label,
 *  different checkout) out of the sweep. */
function sweepSyncHusks(): void {
  for (const p of herdrTry<{ panes?: HerdrPane[] }>(['pane', 'list'])?.panes ?? []) {
    if (syncHusk(p)) herdrTry(['pane', 'close', p.pane_id!]);
  }
}

/** One husk — our label, our checkout's cwd, an idle pane. cwd
 *  scoping keeps another repository's sync pane (same label,
 *  different checkout) out of the sweep. */
function syncHusk(p: HerdrPane): boolean {
  return (
    p.label === SYNC_LABEL &&
    p.pane_id !== undefined &&
    p.cwd === PLUGIN_ROOT &&
    paneIdle(p.pane_id)
  );
}

/** A failed open must not leave a fresh 'pending' suppressing the next
 *  ensure for the whole grace window — but the pane may have spawned
 *  anyway and already published its real pid; that marker is a live
 *  loop's, not ours to erase. */
function releasePending(pidFile: string): void {
  try {
    if (handleOwner(readFileSync(pidFile, 'utf8').trim()) === null) {
      rmSync(pidFile, { force: true });
    }
  } catch {
    // absent already — nothing to clean
  }
}

/** The loop launcher — a detachable spawn seam so tests never fork a
 *  real loop. Returns whether the child was started. */
export type SyncLauncher = (scope: string) => boolean;

/** `node src/sync.ts` detached + unref'd, stdio to the scoped log —
 *  the child's own pid-marker write is the liveness proof every other
 *  ensure probes. */
const spawnSyncLoop: SyncLauncher = scope => {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const out = openSync(join(STATE_DIR, `sync-${scope}.log`), 'a');
    const child = spawn(process.execPath, [join(PLUGIN_ROOT, 'src', 'sync.ts')], {
      cwd: PLUGIN_ROOT,
      env: process.env,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
};

/** The sync loop is the converge daemon — a DETACHED process, never a
 *  pane (user ruling 10.11: plumbing does not take a human's screen).
 *  sync.ts self-terminates once herdr stops answering, so the loop
 *  still dies with the server it serves; the pid file is the dedup —
 *  a live loop proves itself regardless of how its argv was launched,
 *  and a dead loop's stale pid fails the liveness check and gets
 *  replaced. The startup hook and the `sync` action both land here, so
 *  both restore it (bro-m8hew: a reboot must never leave panes with no
 *  loop to re-arm them). `plugin pane open` stays in the manifest as a
 *  manual debug surface only. */
export function ensureSyncLoop(launch: SyncLauncher = spawnSyncLoop): void {
  const scope = stateScope(repoDir(ctxJson()));
  const pidFile = syncPidPath(scope);
  const live = (): boolean => syncPidLiveOrPending(pidFile);
  if (live()) return;
  // the in-flight marker IS the reservation — an exclusive 'wx' create
  // loses to any marker that landed meanwhile (a live pinned pid or a
  // fresh pending). It must land BEFORE the slow sweep/open: the state
  // lock fails OPEN past its wait, so a racer probing inside the
  // sweep's shadow would open a second pane under it
  if (!claimSyncSlot(pidFile, live)) return;
  sweepSyncHusks();
  const ok = launch(scope);
  if (!ok) releasePending(pidFile);
  log(`sync loop ${ok ? 'spawned (detached)' : 'spawn failed'}`);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  try {
    ensureSyncLoop();
    const r = await reconcile();
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
