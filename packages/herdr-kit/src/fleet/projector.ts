/** The fleet projector's herdr-facing half — the ownership ledger,
 *  the managed∩open target set, and every write surface (workspace
 *  labels, report-metadata tokens, fleet-state files, the backstop
 *  report-agent push). The bro-plane reads (act cache, loop runs,
 *  beads, proc probes, config) are injected by the caller — this
 *  module only ever talks to herdr and the fleet-state dir. */
import { createHash, randomInt } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { PaneLed } from '@broject/acp-session';
import { callJson, callOk, nextSeq, STATUS_IDENTITY } from '../client/index.ts';
import {
  definedFields,
  type HerdrPaneRow,
  labelFor,
  paneLed,
  projectTree,
  statusPaneLive,
  statusString,
  type TreeInput,
  type TreeProjection,
} from './classify.ts';
import {
  type FleetPaneState,
  fleetStatusPath,
  pruneFleetStatus,
  readFleetState,
  writeFleetState,
} from './state.ts';

export interface HerdrWorktree {
  path: string;
  branch?: string;
  open_workspace_id?: string;
}

export interface HerdrWorkspace {
  workspace_id: string;
  label?: string;
  tokens?: Record<string, string>;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** What the projector reads out of the plugin's state file — the
 *  ownership records AND the status-pane bindings, one parse. */
interface PluginLedger {
  /** worktree path → the plugin's workspace binding + ownership flag. */
  workspaces: Map<string, { ws?: string; managed?: boolean }>;
  /** workspace id → `bro: status` pane candidates, newest first —
   *  the backstop push tries each until a live pane answers, so a
   *  newer stale binding's dead `pane_id` falls back to an older live
   *  one instead of clobbering (spec bro-idsat). */
  statusPanes: Map<string, string[]>;
}

/** The plugin's ownership ledger — `managed: true` marks workspaces a
 *  plugin opened (the only ones we may relabel), and `statuses` maps
 *  each managed worktree to its status pane. Read-only here; the
 *  plugin still owns writes. Reads EVERY plausible ledger — the scope
 *  hashes the git common dir as the plugin resolved it (raw and
 *  realpath: a symlinked checkout must not partition the fleet), in
 *  `$HERDR_PLUGIN_STATE_DIR` and the default dir (a plugin host and a
 *  daemon configured differently must still agree on ownership). */
/** One parsed `state-<scope>.json` — the fields the ledger reads. */
interface PluginLedgerFile {
  workspaces?: Record<string, { ws?: string; managed?: boolean }>;
  statuses?: Record<string, { pane_id?: string; workspace?: string }>;
}

/** One record candidate, scored for the pick: `live` means its bound
 *  workspace id exists in herdr right now — a stale file's dead
 *  binding can never outrank a live one, mtime only breaks ties. */
interface Scored<T> {
  rec: T;
  mtime: number;
  live: boolean;
  /** collection order — on equal liveness+mtime the later-scanned
   *  candidate wins, matching the old same-dir scoped-wins rule. */
  order: number;
}

/** The winning record for one key: any live-ws candidate beats every
 *  dead one; among candidates of one liveness class the newest file
 *  wins (collection order preserves the old same-dir scoped-wins
 *  behaviour on an mtime tie). */
function pickLive<T>(cands: Scored<T>[]): T | undefined {
  let best: Scored<T> | undefined;
  for (const c of cands) {
    if (
      best === undefined ||
      (c.live && !best.live) ||
      (c.live === best.live && c.mtime >= best.mtime)
    ) {
      best = c;
    }
  }
  return best?.rec;
}

export function pluginLedgerDirs(): string[] {
  const home = process.env.HOME ?? '/tmp';
  return [
    ...new Set(
      [
        process.env.HERDR_PLUGIN_STATE_DIR,
        join(home, '.config', 'bro-herdr-plugin'),
        // herdr's own plugin-state root — host-spawned plugin panes get
        // HERDR_PLUGIN_STATE_DIR pointing here, the daemon does not
        join(
          process.env.XDG_STATE_HOME ?? join(home, '.local', 'state'),
          'herdr',
          'plugins',
          'bro.fleet'
        ),
      ].filter((d): d is string => d !== undefined)
    ),
  ];
}

type WsRec = { ws?: string; managed?: boolean };
type StRec = { pane_id?: string; workspace?: string };

/** Every dir×scope×file candidate path — raw and realpath scopes
 *  both hash in (a symlinked checkout must not partition the
 *  fleet). */
function ledgerPaths(ctx: { root: string; common: string | null }): string[] {
  const base = ctx.common ?? ctx.root;
  const real = realpathOrNull(base);
  const scopes = new Set(
    [base, ...(real === null || real === base ? [] : [real])].map(p =>
      createHash('sha1').update(p).digest('hex').slice(0, 12)
    )
  );
  const paths: string[] = [];
  for (const dir of pluginLedgerDirs()) {
    for (const scope of scopes) {
      paths.push(join(dir, 'state.json'), join(dir, `state-${scope}.json`));
    }
  }
  return paths;
}

/** Remove a workspace binding after its worktree has disappeared. The
 * projector reads every possible ledger generation, so retire the row from
 * every copy too; otherwise a legacy or host-side copy would resurrect the
 * zombie on the next pass. */
function dropLedgerRow(
  ctx: { root: string; common: string | null },
  path: string,
  wsId: string
): void {
  for (const p of ledgerPaths(ctx)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as PluginLedgerFile;
      if (parsed.workspaces === undefined) continue;
      const entry = Object.entries(parsed.workspaces).find(([key]) => key === path);
      const rec = entry?.[1];
      if (rec?.managed !== true || rec.ws !== wsId) continue;
      parsed.workspaces = Object.fromEntries(
        Object.entries(parsed.workspaces).filter(([key]) => key !== path)
      );
      writeFileSync(p, JSON.stringify(parsed));
    } catch {
      // A concurrent plugin write or a missing legacy copy is harmless: the
      // next projector pass can close the workspace again and retry cleanup.
    }
  }
}

/** The scored candidates a ledger gathers per key. */
interface LedgerCands {
  ws: Map<string, Scored<WsRec>[]>;
  st: Map<string, Scored<StRec>[]>;
}

/** Read one candidate file and bank its records — openSync+fstatSync+
 *  readFileSync(fd) couples each candidate's content to the mtime of
 *  that same file generation: a stat-then-read race can never pair
 *  fresh bytes with a stale rank. Missing/unreadable files simply
 *  contribute nothing. */
function scanLedgerFile(
  p: string,
  liveWs: { has(id: string): boolean },
  add: <T>(map: Map<string, Scored<T>[]>, key: string, c: Omit<Scored<T>, 'order'>) => void,
  out: LedgerCands
): void {
  let fd: number | undefined;
  try {
    fd = openSync(p, 'r');
    const mtime = fstatSync(fd).mtimeMs;
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as PluginLedgerFile;
    for (const [path, rec] of Object.entries(parsed.workspaces ?? {})) {
      add(out.ws, path, { rec, mtime, live: rec.ws !== undefined && liveWs.has(rec.ws) });
    }
    for (const r of Object.values(parsed.statuses ?? {})) {
      // an incomplete status row (no pane_id) is never a candidate —
      // a newer half-written sibling must not hide an older valid
      // binding
      if (r.workspace !== undefined && r.pane_id !== undefined) {
        add(out.st, r.workspace, { rec: r, mtime, live: liveWs.has(r.workspace) });
      }
    }
  } catch {
    // missing file or unreadable JSON at this candidate — the others
    // still apply
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // a close failure leaves nothing actionable behind
      }
    }
  }
}

/** Gather every candidate record per key, then pick one: a
 *  herdr-hosted plugin pane and a daemon-side run write different
 *  state dirs, and after a herdr restart the stale file's dead ws
 *  bindings must not clobber the live writer's fresh ones — a
 *  record wins only when its bound workspace id is alive, so even a
 *  NEWER file re-saved with a dead ws loses. */
function gatherLedger(
  ctx: { root: string; common: string | null },
  liveWs: { has(id: string): boolean }
): LedgerCands {
  const out: LedgerCands = { ws: new Map(), st: new Map() };
  let seq = 0;
  const add = <T>(
    map: Map<string, Scored<T>[]>,
    key: string,
    c: Omit<Scored<T>, 'order'>
  ): void => {
    const arr = map.get(key) ?? [];
    arr.push({ ...c, order: seq++ });
    map.set(key, arr);
  };
  for (const p of ledgerPaths(ctx)) scanLedgerFile(p, liveWs, add, out);
  return out;
}

/** ws → every status-pane candidate, live-first then newest — the
 *  push walks the list until a pane row actually answers. */
function orderStatusPanes(cands: Map<string, Scored<StRec>[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [ws, c] of cands) {
    const ordered = [...c]
      .sort((a, b) => Number(b.live) - Number(a.live) || b.mtime - a.mtime || b.order - a.order)
      .map(x => x.rec.pane_id)
      .filter((p): p is string => p !== undefined);
    if (ordered.length > 0) out.set(ws, ordered);
  }
  return out;
}

function pluginLedger(
  ctx: { root: string; common: string | null },
  liveWs: { has(id: string): boolean }
): PluginLedger {
  const cands = gatherLedger(ctx, liveWs);
  const workspaces = new Map<string, WsRec>();
  for (const [path, c] of cands.ws) {
    const w = pickLive(c);
    if (w !== undefined) workspaces.set(path, w);
  }
  return { workspaces, statusPanes: orderStatusPanes(cands.st) };
}

export interface ProjectResult {
  /** herdr answered `worktree list` — false means binary or socket
   *  unreachable and the tick was a no-op. */
  reachable: boolean;
  /** managed workspaces seen this pass. */
  workspaces: number;
  /** rename/report-metadata calls that succeeded. */
  writes: number;
  /** fleet-state files written this pass — content-dedup'd, so a
   *  steady-state pass writes 0. */
  files: number;
  /** backstop `pane report-agent` calls that succeeded — every pass
   *  re-pushes to live status panes (they're not dedup'd: the pane
   *  process is primary but a dead window needs the daemon's push). */
  leds: number;
  /** A plane read that failed while herdr itself answered — named so
   *  the tick can say it instead of looking like a clean skip. */
  degraded?: string;
}

interface WsTarget {
  tree: HerdrWorktree;
  wsId: string;
  live: HerdrWorkspace;
  /** status-pane candidates newest-first — the push walks them until
   *  a pane row answers live (a dead recorded pane falls back). */
  statusPanes?: string[];
}

/** The managed∩open set — workspaces the plugin opened AND still owns;
 *  a user's own workspace is never a target. */
function managedTargets(
  trees: HerdrWorktree[],
  ledger: PluginLedger,
  wsById: Map<string, HerdrWorkspace>
): WsTarget[] {
  const out: WsTarget[] = [];
  for (const tree of trees) {
    const wsId = tree.open_workspace_id;
    if (wsId === undefined) continue;
    const live = wsById.get(wsId);
    if (live === undefined) continue;
    const rec = ledger.workspaces.get(tree.path);
    if (rec?.managed !== true || rec.ws !== wsId) continue;
    const statusPanes = ledger.statusPanes.get(wsId);
    out.push({ tree, wsId, live, ...(statusPanes !== undefined ? { statusPanes } : {}) });
  }
  return out;
}

/** One projection pass over every plugin-managed open workspace. The
 *  herdr probes (worktree/workspace/pane lists) run here through the
 *  client seam; the TreeInput each target projects from is the
 *  caller's build — bro-plane reads stay outside the kit. `common` is
 *  the REAL git common dir (the plugin ledger's scope hash mirrors the
 *  plugin's own resolution); `state` is bro's runtime-state root —
 *  the fleet-status files live there, same base the status/session
 *  panes resolve (stateCommonDir), so a BRO_STATE_DIR pin moves both
 *  ends together. */
/** The write pass's wall-clock budget — one herdr write call times out
 *  at 5s, so this admits a handful of stalled workspaces per pass while
 *  keeping the drive tick's worst case finite. */
export const WRITE_PASS_BUDGET_MS = 25_000;

export function runFleetPass<P extends { beads: { id: string }[] }>(
  ctx: {
    root: string;
    common: string | null;
    state: string | null;
    now: number;
    /** write-pass wall-clock budget — defaults to WRITE_PASS_BUDGET_MS;
     *  injectable so a test doesn't pay real stall time. */
    writeBudgetMs?: number;
  },
  deps: {
    /** lazily assembled — an unreachable herdr or an empty target set
     *  must never pay the bro-plane reads. */
    planes: () => P;
    input: (t: HerdrWorktree, planes: P) => TreeInput;
  }
): ProjectResult {
  const none: ProjectResult = { reachable: false, workspaces: 0, writes: 0, files: 0, leds: 0 };
  const trees = callJson<{ worktrees?: HerdrWorktree[] }>(['worktree', 'list', '--cwd', ctx.root]);
  if (trees?.worktrees === undefined) return none;

  const wsList = callJson<{ workspaces?: HerdrWorkspace[] }>(['workspace', 'list']);
  if (wsList?.workspaces === undefined) {
    return {
      reachable: true,
      workspaces: 0,
      writes: 0,
      files: 0,
      leds: 0,
      degraded: 'workspace list',
    };
  }
  const wsById = new Map(wsList.workspaces.map(w => [w.workspace_id, w]));
  const targets = managedTargets(trees.worktrees, pluginLedger(ctx, wsById), wsById);
  // state files live under the state root the pane resolves identically
  // (stateCommonDir(worktree) ?? worktree) — prune has the same base
  const statusBase = ctx.state ?? ctx.root;
  const keep = keepPaths(statusBase, trees.worktrees);
  if (targets.length === 0) {
    pruneFleetStatus(statusBase, keep);
    return { reachable: true, workspaces: 0, writes: 0, files: 0, leds: 0 };
  }

  const r = writePass({ ctx, deps, targets, planes: deps.planes(), keep, statusBase });
  pruneFleetStatus(statusBase, keep);
  return {
    reachable: true,
    workspaces: targets.length,
    writes: r.writes,
    files: r.files,
    leds: r.leds,
    ...(r.truncated > 0
      ? { degraded: `write budget — ${r.truncated} workspace(s) deferred to the next pass` }
      : {}),
  };
}

/** The fleet-status paths a live open workspace could still be
 *  rendering — prune keeps these: a tree herdr lists with an open
 *  workspace keeps its file even when the ledger read was blind —
 *  wiping on a transient miss would blank every status pane until
 *  the next good pass. */
function keepPaths(statusBase: string, trees: HerdrWorktree[]): Set<string> {
  return new Set(
    trees
      .filter(t => t.open_workspace_id !== undefined && existsSync(t.path))
      .map(t => fleetStatusPath(statusBase, t.path))
  );
}

/** The bounded write loop over the target set. Bounded because every
 *  write is a herdr call with its own timeout, and N stalled
 *  workspaces otherwise multiply into a pass that outlasts the drive
 *  tick it serves (bro-1fv9e) — whatever the budget doesn't reach is
 *  not lost, the next tick retries it. */
interface WritePassJob<P extends { beads: { id: string }[] }> {
  ctx: { root: string; common: string | null; now: number; writeBudgetMs?: number };
  deps: { input: (t: HerdrWorktree, planes: P) => TreeInput };
  targets: WsTarget[];
  planes: P;
  keep: Set<string>;
  statusBase: string;
}

function writePass<P extends { beads: { id: string }[] }>(
  j: WritePassJob<P>
): { writes: number; files: number; leds: number; truncated: number } {
  let writes = 0;
  let files = 0;
  let leds = 0;
  const passStart = Date.now();
  let truncated = 0;
  // rotate the starting target per pass: a prefix that repeatedly eats
  // the whole budget must not starve the suffix forever — a random
  // offset makes every workspace the head of some pass (cubic on #1240)
  // crypto, not Math.random — the scanner's weak-randomness finding is
  // noise for a rotation offset, but the strong primitive costs nothing
  const offset = j.targets.length > 1 ? randomInt(j.targets.length) : 0;
  const ordered = [...j.targets.slice(offset), ...j.targets.slice(0, offset)];
  let done = 0;
  for (const t of ordered) {
    if (Date.now() - passStart > (j.ctx.writeBudgetMs ?? WRITE_PASS_BUDGET_MS)) {
      truncated = ordered.length - done;
      break;
    }
    if (!existsSync(t.tree.path)) {
      if (callOk(['workspace', 'close', t.wsId])) {
        dropLedgerRow(j.ctx, t.tree.path, t.wsId);
        j.keep.delete(fleetStatusPath(j.statusBase, t.tree.path));
      }
      done++;
      continue;
    }
    const { projection, title, slug } = projectTree(j.deps.input(t.tree, j.planes));
    // an empty bead plane means the backend read failed or is empty —
    // a live titled label beats a path-basename downgrade in that gap
    const safe = j.planes.beads.length === 0 ? (liveTitle(t.live.label) ?? title) : title;
    writes += writeDiffs({ ws: t, proj: projection, title: safe, now: j.ctx.now });
    const r = paneWrites({
      ws: t,
      proj: projection,
      title: safe,
      slug,
      base: j.statusBase,
      now: j.ctx.now,
    });
    files += r.files;
    leds += r.leds;
    if (r.path !== undefined) j.keep.add(r.path);
    done++;
  }
  return { writes, files, leds, truncated };
}

/** Everything one workspace's write pass needs — the projection, the
 *  title it lands under, and the seq instant. */
interface WriteJob {
  ws: WsTarget;
  proj: TreeProjection;
  title: string;
  now: number;
}

/** Push one workspace's diffs — the live label and tokens are the
 *  dedup record. The metadata token mirrors the label's bracket
 *  contents, so a NEEDED rename that failed vetoes the metadata write:
 *  tokens claiming a status the label doesn't show are a split-brain
 *  workspace (bro-7tdbs). A failing write otherwise skips that surface
 *  only. */
function writeDiffs(j: WriteJob): number {
  const renamed = renameDiff(j);
  if (renamed < 0) {
    return 0;
  }
  return renamed + metaDiff(j);
}

/** 1 written, 0 nothing to write, -1 a needed write failed. */
function renameDiff(j: WriteJob): number {
  const label = labelFor(j.ws.tree.path, j.proj);
  const changed = (j.ws.live.label ?? '') !== label;
  if (!changed) {
    return 0;
  }
  return callOk(['workspace', 'rename', j.ws.wsId, label]) ? 1 : -1;
}

function metaDiff(j: WriteJob): number {
  const args = metaArgs({
    wsId: j.ws.wsId,
    status: statusString(j.proj),
    tokens: j.ws.live.tokens ?? {},
    now: j.now,
  });
  return args !== null && callOk(args) ? 1 : 0;
}

/** Everything a report-metadata diff needs — the target workspace's
 *  live tokens are the dedup record, `now` is the seq. */
interface MetaCall {
  wsId: string;
  status: string;
  tokens: Record<string, string>;
  now: number;
}

/** The report-metadata argv — or null when the live tokens already
 *  hold the projection AND the plugin-era keys are gone. The `status`
 *  token mirrors the label's bracket contents; `--clear-token` on
 *  vacate. */
function metaArgs(j: MetaCall): string[] | null {
  const args = [
    'workspace',
    'report-metadata',
    j.wsId,
    '--source',
    'bro.fleet',
    '--seq',
    String(j.now),
  ];
  let dirty = false;
  if (j.status !== '' && j.tokens.status !== j.status) {
    args.push('--token', `status=${j.status}`);
    dirty = true;
  } else if (j.status === '' && j.tokens.status !== undefined) {
    args.push('--clear-token', 'status');
    dirty = true;
  }
  // retire the plugin-era keys — the daemon's `status` token replaces them
  for (const k of ['bro.worker', 'bro.pr', 'bro.gate']) {
    if (j.tokens[k] !== undefined) {
      args.push('--clear-token', k);
      dirty = true;
    }
  }
  return dirty ? args : null;
}

// --- the status-pane write (spec bro-idsat) ---------------------------------------

/** Everything one workspace's pane-side write needs — the projection,
 *  its display title/slug, the fleet-status dir base, and the seq
 *  instant. */
interface PaneJob {
  ws: WsTarget;
  proj: TreeProjection;
  title: string;
  slug?: string;
  base: string;
  now: number;
}

/** The `pane report-agent` argv for a backstop push — same source,
 *  agent, and seq discipline the pane process uses, so a daemon push
 *  is indistinguishable from the pane's own (and fresher than it). */
function backstopArgs(paneId: string, led: PaneLed, seq: number): string[] {
  const args = [
    'pane',
    'report-agent',
    paneId,
    '--source',
    STATUS_IDENTITY.source,
    '--agent',
    STATUS_IDENTITY.agent,
    '--seq',
    String(seq),
    '--state',
    led.state,
  ];
  if (led.message !== undefined && led.message !== '') {
    args.push('--message', led.message);
  }
  return args;
}

/** The fleet-state doc one job writes — every optional field rides a
 *  spread so a half-populated projection never lands as a null column.
 *  The title keeps the file's previous value when the projection
 *  degraded to the basename (a bead-read outage must not flicker a
 *  real title away). */
function stateOf(j: PaneJob, path: string, led: PaneLed): FleetPaneState {
  const prev = readFleetState(path);
  const degraded = j.title === basename(j.ws.tree.path);
  const title = degraded && prev?.title !== undefined && prev.title !== '' ? prev.title : j.title;
  return {
    v: 1,
    worktree: j.ws.tree.path,
    workspace: j.ws.wsId,
    title,
    ...definedFields({ slug: j.slug }),
    status: statusString(j.proj),
    ...definedFields({
      prUrl: j.proj.prUrl,
      agent: j.proj.agent,
      acpSessionId: j.proj.acpSessionId,
      provider: j.proj.provider,
      model: j.proj.model,
      log: j.proj.log,
      lane: j.proj.acp === true ? ('acp' as const) : undefined,
      events: j.proj.events,
      session: j.proj.session,
    }),
    led,
    ts: j.now,
  };
}

/** One workspace's pane-side write: the fleet-state file the `bro:
 *  status` pane renders and self-reports (primary), plus a backstop
 *  `report-agent` push to the recorded status pane when it is still
 *  ours-to-write. The file is content-dedup'd (the pane's fs.watch
 *  must only fire on real moves); the push is not — a crashed
 *  status-view leaves an unbound pane whose every tick needs the
 *  daemon's heartbeat until the plugin re-arms it. */
function paneWrites(j: PaneJob): { files: number; leds: number; path?: string } {
  const path = fleetStatusPath(j.base, j.ws.tree.path);
  const led = paneLed(j.proj);
  const state = stateOf(j, path, led);
  let files = 0;
  try {
    files = writeFleetState(path, state) ? 1 : 0;
  } catch {
    // an unwritable state dir skips the file, never the pass
  }
  let leds = 0;
  if (j.ws.statusPanes !== undefined) {
    const rows = paneRows(j.ws.wsId);
    // walk the candidates newest-first — a dead recorded pane falls
    // back to an older live binding instead of killing the push
    const pane =
      rows === undefined ? undefined : j.ws.statusPanes.find(p => statusPaneLive(rows, p));
    if (pane !== undefined) {
      leds = callOk(backstopArgs(pane, led, nextSeq(j.now))) ? 1 : 0;
    }
  }
  return { files, leds, path };
}

/** `pane list --workspace <ws>` — the status pane's existence +
 *  bound-agent check for the backstop push. Undefined on any failure —
 *  a skipped push, not a tick verdict. */
function paneRows(wsId: string): HerdrPaneRow[] | undefined {
  return callJson<{ panes?: HerdrPaneRow[] }>(['pane', 'list', '--workspace', wsId])?.panes;
}

/** The title a live `[tokens] title` label already carries — the
 *  bead-outage fallback so a backend gap can't clobber a good title
 *  with a bare path basename. */
function liveTitle(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const m = /^\[[^\]]*\] (.+)$/.exec(label);
  return m?.[1];
}
