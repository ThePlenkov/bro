/**
 * The daemon-owned fleet-status projector (spec bro-u19mq) — the ONE
 * writer of `[state·#PR]` workspace labels, the `status` metadata
 * token, and the native pane LED (`pane report-agent`, spec bro-awqde)
 * on herdr workspaces. The herdr session plugins keep only
 * spawn/attach lifecycle (`worktree open`, mirrors, renderers, the
 * reaper); they never write fleet labels — this tick does, so a dead
 * session can't leave a stale `[working]` on a crashed run.
 *
 * `projectFleet` is the tick (called from driveOnce). Everything below
 * `workerState` is pure — the input read is a function boundary so a
 * future NATS subscription can feed the same projection unchanged.
 *
 * Ownership: a workspace counts as bro-managed only when the plugin's
 * state file records `managed: true` for its path AND the recorded ws
 * id still equals the live `open_workspace_id` — a user's own
 * workspace is never renamed or tokened.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  type AgentRegistryEntry,
  type AgentState,
  gitCommonDir,
  gitTry,
  readAgentRegistry,
} from '@broject/core';
import { loopSection } from '@broject/loop';
import { loadBroConfig } from '../plugins.ts';
import { collectLoopRuns } from './loop-state.ts';
import { detailMatches, hooksDirOf, liveWorkEntries, registryEntryState } from './proc-owner.ts';
import { readBeads } from './status.ts';
import { parseWorktreePorcelain, worktreeClaim } from './work.ts';

/** Read per call — `HERDR_BIN_PATH` is a test/ops override, binding it
 *  at import would freeze it for the process. */
const HERDR = (): string => process.env.HERDR_BIN_PATH ?? 'herdr';
/** A wedged herdr socket must never stall the pass — local calls
 *  answer in milliseconds; anything past this is a hang. */
const HERDR_TIMEOUT_MS = 5_000;

export type WorkerState = 'working' | 'silent' | 'exited' | 'interrupted' | 'lost' | 'stopped';

/** The projection the boundary emits — a future herdr badge field
 *  consumes `{state, pr?, silentMin?}` for color/severity without
 *  recomputing the worker verdict. */
export interface TreeProjection {
  /** Absent — marker/claim-armed tree with no worker records. */
  state?: WorkerState;
  /** Bucketted silence (5m steps under an hour, hourly above) — only
   *  when state==='silent'. */
  silentMin?: number;
  pr?: number;
  /** Compact gate summary ('merged'|'4t/3f/6sast/conflicts'|'ok'|…) —
   *  absent when the act cache has no fresh entry for the PR. */
  gate?: string;
  /** A live claim/session-marker arm — drives the `no PR` layer when
   *  the tree has no worker and nothing resolves. */
  armed?: boolean;
}

// --- pure classification -------------------------------------------------------

/** One worker record — a loop run or a registry agent — reduced to the
 *  fields classification reads. */
export interface WorkerCand {
  /** Live runs outrank live agents — the run's silence bucket beats a
   *  co-resident agent's (the plugin's live-run precedence). */
  run: boolean;
  live: boolean;
  /** Live workers only — ms since last output; null = unknown →
   *  counts as fresh. */
  silentMs: number | null;
  /** Dead workers only — the classified terminal state. */
  terminal?: WorkerState;
  /** Recency key — the newest terminal record wins among dead ones. */
  at: number;
}

/** Silence bucketing shared with the label token — a label only moves
 *  when its bucket does, so rename churn is per-5m under an hour,
 *  hourly above, never per tick. Same formula as the plugin's. */
export function silentBucketMin(silentMs: number | null | undefined): number | null {
  if (typeof silentMs !== 'number') return null;
  if (!Number.isFinite(silentMs)) return null;
  const min = silentMs / 60_000;
  if (min >= 60) return Math.floor(min / 60) * 60;
  return Math.max(0, Math.floor(min / 5) * 5);
}

const freshest = (c: WorkerCand[]): WorkerCand | undefined =>
  c.reduce<WorkerCand | undefined>(
    (a, b) =>
      a === undefined ||
      (b.silentMs ?? Number.POSITIVE_INFINITY) < (a.silentMs ?? Number.POSITIVE_INFINITY)
        ? b
        : a,
    undefined
  );

/** The winner among live candidates — a live run anywhere outranks a
 *  co-resident live agent (the run's silence bucket is the truer one). */
function liveWinner(cands: WorkerCand[]): WorkerCand | undefined {
  const live = cands.filter(c => c.live);
  return freshest(live.filter(c => c.run)) ?? freshest(live);
}

/** The winning live worker's verdict — silent past the stall window,
 *  working inside it. `stall <= 0` disables stall semantics. */
function liveVerdict(v: {
  w: WorkerCand;
  stall: number;
}): Pick<TreeProjection, 'state' | 'silentMin'> {
  const b = silentBucketMin(v.w.silentMs);
  const pastStall = v.stall > 0 && Math.floor((v.w.silentMs ?? 0) / 60_000) >= v.stall;
  if (b !== null && pastStall) return { state: 'silent', silentMin: b };
  return { state: 'working' };
}

/** A dead candidate worth replacing the current newest with — live
 *  candidates were already handled, undated records carry no verdict. */
const newerDead = (d: WorkerCand, cur: WorkerCand | undefined): boolean =>
  !d.live && d.terminal !== undefined && (cur === undefined || d.at > cur.at);

/** The worker verdict for one worktree — a live run anywhere wins over
 *  every dead record (the respawn edge), and a live agent outranks a
 *  dead run. Among terminal records the newest wins. */
export function workerState(
  cands: WorkerCand[],
  stallMin: number
): Pick<TreeProjection, 'state' | 'silentMin'> {
  const w = liveWinner(cands);
  if (w !== undefined) return liveVerdict({ w, stall: stallMin });
  let newest: WorkerCand | undefined;
  for (const d of cands) {
    if (newerDead(d, newest)) newest = d;
  }
  return newest === undefined ? {} : { state: newest.terminal };
}

/** The act-state record's summary fields — a file-cache read, never
 *  the gate itself. */
export interface GateState {
  pr: number;
  headRef?: string;
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  openThreads?: number;
  ciPending?: number;
  ciFailing?: number;
  reviewersPending?: number;
  sastPending?: number;
}

/** The non-zero finding counts, compacted — `4t`, `3f`, `6sast`,
 *  `conflicts` — in thread/ci/sast/mergeability order. */
function gateFindings(s: GateState): string[] {
  const parts: string[] = [];
  if ((s.openThreads ?? 0) > 0) parts.push(`${s.openThreads}t`);
  if ((s.ciFailing ?? 0) > 0) parts.push(`${s.ciFailing}f`);
  if ((s.sastPending ?? 0) > 0) parts.push(`${s.sastPending}sast`);
  if ((s.mergeable ?? '').toUpperCase() === 'CONFLICTING') parts.push('conflicts');
  return parts;
}

/** Compact last-observed gate summary — `1f`, `4t/3f/6sast/conflicts`,
 *  `pending`, `ok` — "is it moving", not "may it merge". */
export function gateFrag(s: GateState): string {
  const st = (s.state ?? '').toUpperCase();
  if (st === 'MERGED' || st === 'CLOSED') return st.toLowerCase();
  if (s.isDraft === true) return 'draft';
  const parts = gateFindings(s);
  if (parts.length > 0) return parts.join('/');
  if ((s.ciPending ?? 0) > 0 || (s.reviewersPending ?? 0) > 0) return 'pending';
  return 'ok';
}

// --- pure rendering ------------------------------------------------------------

/** `working` | `silent45m` | `silent16h` | `exited` | … */
export function workerToken(p: TreeProjection): string | undefined {
  if (p.state === undefined) return undefined;
  if (p.state === 'silent' && p.silentMin !== undefined) {
    return p.silentMin >= 60 ? `silent${Math.floor(p.silentMin / 60)}h` : `silent${p.silentMin}m`;
  }
  return p.state;
}

/** `#759 1f` | `#765 4t/3f` | `no PR` — absent when the tree carries
 *  neither a worker nor an arm. */
export function prToken(p: TreeProjection): string | undefined {
  if (p.pr !== undefined) {
    const gate = p.gate !== undefined && p.gate !== '' ? ` ${p.gate}` : '';
    return `#${p.pr}${gate}`;
  }
  return p.state !== undefined || p.armed === true ? 'no PR' : undefined;
}

/** The label's bracket contents — `working·#759 1f`, `lost`,
 *  `no PR` — or '' when the tree carries no projection. */
export function statusString(p: TreeProjection): string {
  return [workerToken(p), prToken(p)].filter(t => t !== undefined).join('·');
}

/** `[silent16h·#765 4t/3f] <title>` — or the bare title when nothing
 *  projects onto this tree. */
export function labelFor(p: TreeProjection, title: string): string {
  const s = statusString(p);
  return s === '' ? title : `[${s}] ${title}`;
}

// --- the native LED (spec bro-awqde) -------------------------------------------

/** Herdr's reportable pane states — `done` is not a reportable state,
 *  `idle` renders the native `✓` on unviewed panes. */
export type LedState = 'working' | 'blocked' | 'idle' | 'unknown';

export type LedReport = { kind: 'report'; state: LedState; message?: string } | { kind: 'release' };

/** The projection → `pane report-agent` verdict — the SAME
 *  classification the label carries, one mapping (bro-awqde):
 *  working/silent → working (silent carries its bucket as the
 *  message), interrupted/lost → blocked with the cause word, exited →
 *  idle (native done), stopped/vacated → release (the row disappears),
 *  armed-but-no-worker → unknown (the LED is present but dim, the
 *  `no PR`-layer analogue). */
export function ledReport(p: TreeProjection): LedReport {
  switch (p.state) {
    case 'working':
      return { kind: 'report', state: 'working' };
    case 'silent': {
      const m = workerToken(p);
      // a silent verdict always carries its bucket — an unbucketed
      // 'silent' message reads like a bug, so fall back to bare working
      return m === undefined || m === 'silent'
        ? { kind: 'report', state: 'working' }
        : { kind: 'report', state: 'working', message: m };
    }
    case 'interrupted':
    case 'lost':
      return { kind: 'report', state: 'blocked', message: p.state };
    case 'exited':
      return { kind: 'report', state: 'idle', message: 'exited' };
    case 'stopped':
      return { kind: 'release' };
    case undefined:
      return p.armed === true ? { kind: 'report', state: 'unknown' } : { kind: 'release' };
  }
}

/** The `--agent` label we report as — self-reported (unrecognized) by
 *  design; a `herdr:`-prefixed source would degrade, `bro-fleet` is
 *  ours. */
const LED_SOURCE = 'bro-fleet';
const LED_AGENT = 'fleet';

/** One `pane list` row — only the fields selection reads. */
export interface HerdrPaneRow {
  pane_id: string;
  /** herdr's DETECTED agent — absent means no known agent is bound. */
  agent?: string;
}

/** Ledger candidates that are live and reportable — in order. A pane
 *  bound to a DIFFERENT detected agent rejects our report anyway; a
 *  pane carrying our own label is a re-report, allowed. */
export function ledPane(rows: HerdrPaneRow[], candidates: string[]): string[] {
  const ok = new Set(
    rows
      .filter(r => r.agent === undefined || r.agent === '' || r.agent === LED_AGENT)
      .map(r => r.pane_id)
  );
  return candidates.filter(c => ok.has(c));
}

// --- plane reads (the function boundary — a NATS feed swaps these) --------------

interface HerdrWorktree {
  path: string;
  branch?: string;
  open_workspace_id?: string;
}

interface HerdrWorkspace {
  workspace_id: string;
  label?: string;
  tokens?: Record<string, string>;
}

function herdrRun(args: string[]): { code: number; out: string } {
  const r = spawnSync(HERDR(), args, {
    encoding: 'utf8',
    timeout: HERDR_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  return { code: r.status ?? -1, out: r.stdout ?? '' };
}

/** `herdr <args>` → `.result`, undefined on any failure — reachability
 *  is the caller's verdict, a bad envelope is just a miss. */
function herdr<T>(args: string[]): T | undefined {
  const r = herdrRun(args);
  if (r.code !== 0 || r.out === '') return undefined;
  try {
    return (JSON.parse(r.out) as { result: T }).result;
  } catch {
    return undefined;
  }
}

function herdrOk(args: string[]): boolean {
  return herdrRun(args).code === 0;
}

/** `pane list --workspace <ws>` — the existence + detected-agent probe
 *  for LED candidates. Undefined on any failure — a skipped LED, not
 *  a tick verdict. */
function paneRows(wsId: string): HerdrPaneRow[] | undefined {
  return herdr<{ panes?: HerdrPaneRow[] }>(['pane', 'list', '--workspace', wsId])?.panes;
}

/** A live non-shell foreground process — the ONLY pane a self-reported
 *  authority survives on. Herdr's ~1s pane probe auto-clears a
 *  self-reported report the moment the foreground is the bare shell
 *  (`self_reported_agent_active`/`ReportedAgentShellReturned`), so a
 *  report onto an idle pane is a guaranteed miss — skip it instead. */
function paneBusy(paneId: string): boolean {
  const pi = herdr<{
    process_info?: { shell_pid?: number; foreground_processes?: { pid?: number }[] };
  }>(['pane', 'process-info', '--pane', paneId])?.process_info;
  if (pi === undefined) return false;
  const fg = pi.foreground_processes ?? [];
  return fg.some(proc => proc.pid !== pi.shell_pid);
}

export interface ActEntry {
  fetchedAt: number;
  state: GateState;
}

/** One projection pass's shared context — the repo root, its git
 *  common dir, and the observation instant, threaded through the
 *  internals so every helper reads the same snapshot coordinates. */
interface PassCtx {
  root: string;
  common: string | null;
  now: number;
}

/** `<git-common>/bro/act-state/*.json` — the last gate each real
 *  poller observed. A label reads the freshest observation; it never
 *  pays a gh call itself. */
function actStates(ctx: Pick<PassCtx, 'common'>): ActEntry[] {
  if (ctx.common === null) return [];
  const dir = join(ctx.common, 'bro', 'act-state');
  let names: string[];
  try {
    names = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ActEntry[] = [];
  for (const f of names) {
    try {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<ActEntry>;
      if (typeof v.fetchedAt === 'number' && typeof v.state?.pr === 'number') {
        out.push(v as ActEntry);
      }
    } catch {
      // a corrupt entry is a miss
    }
  }
  // freshest-first — a `find` anywhere downstream picks the latest
  // observation on a headRef/PR collision, not whichever file readdir
  // happened to return first
  return out.sort((a, b) => b.fetchedAt - a.fetchedAt);
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** What the projector reads out of the plugin's state file — the
 *  ownership records AND the LED's candidate panes, one parse. */
interface PluginLedger {
  /** worktree path → the plugin's workspace binding + ownership flag. */
  workspaces: Map<string, { ws?: string; managed?: boolean }>;
  /** workspace id → ordered LED candidate pane ids — live mirror panes
   *  first (the pane tailing the actual worker), the events renderer
   *  last. Marked mirrors are dead tails on idle shells — a report
   *  there self-clears, so they never make the list. */
  panes: Map<string, string[]>;
}

/** The plugin's ownership ledger — `managed: true` marks workspaces a
 *  plugin opened (the only ones we may relabel), and the mirror /
 *  renderer pane records are the LED's foreground-process candidates.
 *  Read-only here; the plugin still owns writes. Reads EVERY plausible
 *  ledger — the scope hashes the git common dir as the plugin resolved
 *  it (raw and realpath: a symlinked checkout must not partition the
 *  fleet), in `$HERDR_PLUGIN_STATE_DIR` and the default dir (a plugin
 *  host and a daemon configured differently must still agree on
 *  ownership). */
function pluginLedger(ctx: Pick<PassCtx, 'root' | 'common'>): PluginLedger {
  const base = ctx.common ?? ctx.root;
  const real = realpathOrNull(base);
  const scopes = new Set(
    [base, ...(real === null || real === base ? [] : [real])].map(p =>
      createHash('sha1').update(p).digest('hex').slice(0, 12)
    )
  );
  const dirs = new Set(
    [
      process.env.HERDR_PLUGIN_STATE_DIR,
      join(process.env.HOME ?? '/tmp', '.config', 'bro-herdr-plugin'),
    ].filter((d): d is string => d !== undefined)
  );
  const out: PluginLedger = { workspaces: new Map(), panes: new Map() };
  const panes = (ws: string | undefined, paneId: string | undefined): void => {
    if (ws === undefined || paneId === undefined) return;
    const l = out.panes.get(ws) ?? [];
    if (!l.includes(paneId)) l.push(paneId);
    out.panes.set(ws, l);
  };
  for (const dir of dirs) {
    for (const scope of scopes) {
      try {
        const v = JSON.parse(readFileSync(join(dir, `state-${scope}.json`), 'utf8')) as {
          workspaces?: Record<string, { ws?: string; managed?: boolean }>;
          mirrors?: Record<string, { pane_id?: string; workspace?: string; marked?: boolean }>;
          renderers?: Record<string, { pane_id?: string; workspace?: string }>;
        };
        for (const [k, r] of Object.entries(v.workspaces ?? {})) out.workspaces.set(k, r);
        for (const r of Object.values(v.mirrors ?? {})) {
          if (r.marked !== true) panes(r.workspace, r.pane_id);
        }
        for (const r of Object.values(v.renderers ?? {})) panes(r.workspace, r.pane_id);
      } catch {
        // no ledger at this candidate — the others still apply
      }
    }
  }
  return out;
}

/** Branch per worktree from `git worktree list --porcelain` — the
 *  headRef join when herdr's list row doesn't carry it. */
function gitBranches(ctx: Pick<PassCtx, 'root'>): Map<string, string> {
  const r = gitTry(['-C', ctx.root, 'worktree', 'list', '--porcelain']);
  if (r.code !== 0) return new Map();
  return new Map(parseWorktreePorcelain(r.out).map(t => [t.path, t.branch ?? ''] as const));
}

/** The stall window for silence bucketing — `loop.stallMin`, 0 when
 *  the config can't be read (no stall semantics, every live run is
 *  'working'). */
function stallMin(ctx: Pick<PassCtx, 'root'>): number {
  try {
    return loopSection(loadBroConfig(ctx.root).loop).stallMin;
  } catch {
    return 0;
  }
}

/** Ms since a live agent's last visible output — the log's mtime is
 *  the strongest signal (it moves with every byte), `spawnedAt` the
 *  floor for a log that never materialized. */
function agentSilentMs(e: AgentRegistryEntry, ctx: Pick<PassCtx, 'now'>): number | null {
  const refs: number[] = [];
  if (typeof e.log === 'string' && e.log !== '') {
    try {
      refs.push(statSync(e.log).mtimeMs);
    } catch {
      // no log yet — spawnedAt still bounds the silence
    }
  }
  const spawned = typeof e.spawnedAt === 'string' ? Date.parse(e.spawnedAt) : Number.NaN;
  if (Number.isFinite(spawned)) refs.push(spawned);
  return refs.length === 0 ? null : Math.max(0, ctx.now - Math.max(...refs));
}

const TERMINAL: Partial<Record<AgentState, WorkerState>> = {
  blocked: 'interrupted',
  exited: 'exited',
  lost: 'lost',
  stopped: 'stopped',
};

const parseTs = (s: unknown): number => {
  if (typeof s !== 'string') return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

/** Entries past this age are treated as absent — a dead poller's last
 *  write must not paint a stale verdict on the label forever. */
const ACT_LABEL_STALE_MS = 30 * 60_000;

const prFromLink = (link: string | undefined): number | undefined => {
  const m = link !== undefined ? /\/pull\/(\d+)/.exec(link) : null;
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
};

/** PR + gate for a worktree: the fresh act entry wins when its
 *  headRef is the tree's branch — the branch is what a PR actually
 *  tracks, so it outranks a bead link that can be stale. Entries are
 *  sorted freshest-first, so `find` picks the latest observation on a
 *  headRef collision. */
export function prFor(
  branch: string | undefined,
  slug: string | undefined,
  beads: { id: string; link?: string }[],
  act: ActEntry[],
  now: number
): { pr?: number; gate?: string } {
  const link = slug !== undefined ? prFromLink(beads.find(b => b.id === slug)?.link) : undefined;
  const fresh = (e: ActEntry): boolean => now - e.fetchedAt <= ACT_LABEL_STALE_MS;
  const byRef =
    branch !== undefined && branch !== ''
      ? act.find(e => e.state.headRef === branch && fresh(e))
      : undefined;
  const entry = byRef ?? act.find(e => e.state.pr === link && fresh(e));
  const pr = entry?.state.pr ?? link;
  if (pr === undefined) return {};
  return { pr, ...(entry !== undefined ? { gate: gateFrag(entry.state) } : {}) };
}

// --- the per-tree projection (pure — tests drive this directly) -------------------

/** A loop-run record classified to live/dead by collectLoopRuns. */
export interface RunRow {
  state: 'running' | 'dead';
  beadId?: string;
  silentMs: number | null;
  /** Recency key — the run's recorded startedAt. */
  at: number;
}

/** A registry agent pre-classified at the boundary — the liveness
 *  verdict (pid/handle probes) happens in the tick, not the model. */
export interface AgentRow {
  /** The registry key — the agent's molStep (bead-ish slug join). */
  key: string;
  live: boolean;
  terminal?: WorkerState;
  silentMs: number | null;
  /** Recency key — the entry's spawnedAt. */
  at: number;
}

/** Everything the projection for one worktree reads — assembled by the
 *  tick, injectable in tests. */
export interface TreeInput {
  path: string;
  branch?: string;
  claim?: string;
  /** A live session `.work` marker names this tree. */
  markerArmed: boolean;
  runs: RunRow[];
  agents: AgentRow[];
  beads: { id: string; title?: string; link?: string }[];
  act: ActEntry[];
  now: number;
  stallMin: number;
}

/** Runs + agents flattened into classifier candidates — the boundary's
 *  liveness verdicts become `live`/`terminal` here, never inside
 *  workerState. */
function workerCands(i: TreeInput): WorkerCand[] {
  const runs: WorkerCand[] = i.runs.map(r => ({
    run: true,
    live: r.state === 'running',
    silentMs: r.silentMs,
    ...(r.state === 'dead' ? { terminal: 'lost' as WorkerState } : {}),
    at: r.at,
  }));
  const agents: WorkerCand[] = i.agents.map(a => ({
    run: false,
    live: a.live,
    silentMs: a.live ? a.silentMs : null,
    ...(a.live ? {} : { terminal: a.terminal }),
    at: a.at,
  }));
  return [...runs, ...agents];
}

/** The projection + display title for one worktree — the object a
 *  future herdr badge consumes directly. */
export function projectTree(i: TreeInput): { projection: TreeProjection; title: string } {
  const slug =
    i.claim ??
    i.runs.find(r => r.beadId !== undefined)?.beadId ??
    (i.agents.find(a => a.live) ?? i.agents[0])?.key;
  const worker = workerState(workerCands(i), i.stallMin);
  const projection: TreeProjection = {
    ...worker,
    ...prFor(i.branch, slug, i.beads, i.act, i.now),
    armed: i.claim !== undefined || i.markerArmed,
  };
  const title =
    (slug !== undefined ? i.beads.find(b => b.id === slug)?.title : undefined) || basename(i.path);
  return { projection, title };
}

// --- the tick -------------------------------------------------------------------

export interface ProjectResult {
  /** herdr answered `worktree list` — false means binary or socket
   *  unreachable and the tick was a no-op. */
  reachable: boolean;
  /** managed workspaces seen this pass. */
  workspaces: number;
  /** rename/report-metadata calls that succeeded. */
  writes: number;
  /** report-agent/release-agent calls that succeeded — NOT dedup'd
   *  (re-report every tick is the protocol), so they stay out of
   *  `writes` to keep the label-churn log line honest. */
  leds: number;
  /** A plane read that failed while herdr itself answered — named so
   *  the tick can say it instead of looking like a clean skip. */
  degraded?: string;
}

/** The bro-plane bundle a pass reads once — assembled after the
 *  managed∩open set proves at least one workspace is ours to label. */
interface Planes {
  agentsHome: string | null;
  registry: ReturnType<typeof readAgentRegistry>;
  branches: Map<string, string>;
  runs: ReturnType<typeof collectLoopRuns>;
  act: ActEntry[];
  beads: ReturnType<typeof readBeads>['inProgress'];
  details: ReturnType<typeof liveWorkEntries>;
  stall: number;
}

/** A corrupt/unreadable agents.json degrades to an empty registry —
 *  one bad file must not skip projection for every managed workspace. */
function tryRegistry(ctx: Pick<PassCtx, 'root'>): ReturnType<typeof readAgentRegistry> {
  try {
    return readAgentRegistry(ctx.root);
  } catch {
    return {};
  }
}

function readPlanes(ctx: PassCtx): Planes {
  const hooks = hooksDirOf(ctx.root);
  return {
    agentsHome: ctx.common === null ? null : join(ctx.common, 'bro', 'agents'),
    registry: tryRegistry(ctx),
    branches: gitBranches(ctx),
    runs: collectLoopRuns(ctx.root, ctx.now),
    act: actStates(ctx),
    beads: readBeads(ctx.root).inProgress,
    details: hooks === null ? [] : liveWorkEntries(hooks, ['.work'], ctx.now),
    stall: stallMin(ctx),
  };
}

/** One managed∩open pair — the worktree, the workspace id herdr has
 *  open for it, the live workspace record (the dedup source), and the
 *  LED's candidate pane ids from the ledger. */
interface WsTarget {
  tree: HerdrWorktree;
  wsId: string;
  live: HerdrWorkspace;
  panes: string[];
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
    out.push({ tree, wsId, live, panes: ledger.panes.get(wsId) ?? [] });
  }
  return out;
}

/** Registry entries on one worktree, pre-classified — the pid/handle
 *  probes (registryEntryState) run here, at the boundary. */
function agentRows(t: HerdrWorktree, p: Planes, ctx: PassCtx): AgentRow[] {
  return Object.entries(p.registry)
    .filter(([, e]) => e.worktree === t.path)
    .map(([key, e]) => {
      const st = registryEntryState(p.agentsHome, e);
      const live = st === 'running' || st === 'spawned';
      return {
        key,
        live,
        ...(live ? {} : { terminal: TERMINAL[st] }),
        silentMs: live ? agentSilentMs(e, ctx) : null,
        at: parseTs(e.spawnedAt),
      };
    });
}

/** One worktree's projection input — herdr's branch when it carries
 *  one, the git porcelain join otherwise; the claim and marker arm
 *  read the same files the plugin's arm scan does. */
function treeInput(t: HerdrWorktree, p: Planes, ctx: PassCtx): TreeInput {
  const branch = t.branch ?? p.branches.get(t.path) ?? undefined;
  const claim = worktreeClaim(t.path, ctx.now);
  return {
    path: t.path,
    ...(branch !== undefined ? { branch } : {}),
    ...(claim !== undefined ? { claim } : {}),
    markerArmed: p.details.some(e =>
      detailMatches(e.detail, { branch: branch ?? '', slug: claim ?? '', worktree: t.path })
    ),
    runs: p.runs
      .filter(r => r.worktree === t.path)
      .map(r => ({
        state: r.state,
        ...(r.beadId !== '' ? { beadId: r.beadId } : {}),
        silentMs: r.silentMs,
        at: parseTs(r.startedAt),
      })),
    agents: agentRows(t, p, ctx),
    beads: p.beads,
    act: p.act,
    now: ctx.now,
    stallMin: p.stall,
  };
}

/** The title a live `[tokens] title` label already carries — the
 *  bead-outage fallback so a backend gap can't clobber a good title
 *  with a bare path basename. */
function liveTitle(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const m = /^\[[^\]]*\] (.+)$/.exec(label);
  return m?.[1];
}

/** One projection pass over every plugin-managed open workspace of the
 *  repo. All bro inputs are local reads; each herdr write is a diff
 *  (live label/tokens already hold the last written values — no state
 *  file needed for dedup). Fail-open: any failure degrades to a
 *  skipped pass, never a thrown tick — a plane read that fails while
 *  herdr answered lands on `degraded` so the tick can say it. */
export function projectFleet(mainRoot: string, now = Date.now()): ProjectResult {
  const none: ProjectResult = { reachable: false, workspaces: 0, writes: 0, leds: 0 };
  const trees = herdr<{ worktrees?: HerdrWorktree[] }>(['worktree', 'list', '--cwd', mainRoot]);
  if (trees?.worktrees === undefined) return none;

  const common = gitCommonDir(mainRoot);
  const wsList = herdr<{ workspaces?: HerdrWorkspace[] }>(['workspace', 'list']);
  if (wsList?.workspaces === undefined) {
    return { reachable: true, workspaces: 0, writes: 0, leds: 0, degraded: 'workspace list' };
  }
  const wsById = new Map(wsList.workspaces.map(w => [w.workspace_id, w]));
  const ctx: PassCtx = { root: mainRoot, common, now };
  const targets = managedTargets(trees.worktrees, pluginLedger(ctx), wsById);
  if (targets.length === 0) return { reachable: true, workspaces: 0, writes: 0, leds: 0 };

  const planes = readPlanes(ctx);
  let writes = 0;
  let leds = 0;
  for (const t of targets) {
    const { projection, title } = projectTree(treeInput(t.tree, planes, ctx));
    // an empty bead plane means the backend read failed or is empty —
    // a live titled label beats a path-basename downgrade in that gap
    const safe = planes.beads.length === 0 ? (liveTitle(t.live.label) ?? title) : title;
    writes += writeDiffs({ ws: t, proj: projection, title: safe, now: ctx.now });
    leds += ledDiff(t, projection, ctx.now);
  }
  return { reachable: true, workspaces: targets.length, writes, leds };
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
 *  dedup record. A failing write skips that surface only. */
function writeDiffs(j: WriteJob): number {
  return renameDiff(j) + metaDiff(j);
}

function renameDiff(j: WriteJob): number {
  const label = labelFor(j.proj, j.title);
  const changed = (j.ws.live.label ?? '') !== label;
  return changed && herdrOk(['workspace', 'rename', j.ws.wsId, label]) ? 1 : 0;
}

function metaDiff(j: WriteJob): number {
  const args = metaArgs({
    wsId: j.ws.wsId,
    status: statusString(j.proj),
    tokens: j.ws.live.tokens ?? {},
    now: j.now,
  });
  return args !== null && herdrOk(args) ? 1 : 0;
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

// --- the LED write ---------------------------------------------------------------

/** At most this many eligible panes get a process-info probe per tick —
 *  probe order is ledger order (live mirrors first), and a wedged pane
 *  costs one HERDR_TIMEOUT_MS, so the cap bounds what one workspace can
 *  add to the drive tick. */
const LED_PROBE_MAX = 3;

/** `--seq` is per-source monotonic (hook_report_is_newer drops a stale
 *  seq) — a wall clock that ticks backward or two passes inside one
 *  millisecond must never emit a seq herdr then ignores. */
let ledSeqLast = 0;
const ledSeq = (now: number): number => {
  ledSeqLast = Math.max(now, ledSeqLast + 1);
  return ledSeqLast;
};

/** The pane this source last asserted on, per workspace — daemon-process
 *  memory. A changed selection releases the stale row before the new
 *  report lands; panes herdr still shows bound to us get the same
 *  release regardless of where the assertion came from. */
const ledPanes = new Map<string, string>();

/** The report/release argv for one pane. `--seq` is per-source
 *  monotonic, so a stale drop can never overwrite a newer one
 *  (hook_report_is_newer). */
function ledArgs(paneId: string, rep: LedReport, seq: number): string[] {
  const args = [
    'pane',
    rep.kind === 'report' ? 'report-agent' : 'release-agent',
    paneId,
    '--source',
    LED_SOURCE,
    '--agent',
    LED_AGENT,
    '--seq',
    String(seq),
  ];
  if (rep.kind === 'report') {
    args.push('--state', rep.state);
    if (rep.message !== undefined) args.push('--message', rep.message);
  }
  return args;
}

/** The native-LED write for one workspace — the verdict the label
 *  already computed, asserted on the first ledger pane that is live,
 *  agent-free, and busy. This is a heartbeat, not a diff: the
 *  authority isn't persisted across herdr restarts and the
 *  self-reported probe can clear it, so it's re-asserted every tick —
 *  fire-and-forget, every failure a quiet skip. Panes that keep a
 *  stale `bro-fleet` assertion after the selection moved (a re-ordered
 *  candidate, a newly-marked mirror, a daemon restart mid-authority)
 *  are released in the same pass. */
function ledDiff(t: WsTarget, proj: TreeProjection, now: number): number {
  const stale = ledPanes.get(t.wsId);
  if (t.panes.length === 0 && stale === undefined) return 0;
  const rows = paneRows(t.wsId);
  if (rows === undefined) return 0;
  const pane = ledPane(rows, t.panes)
    .slice(0, LED_PROBE_MAX)
    .find(p => paneBusy(p));
  const rep = pane === undefined ? undefined : ledReport(proj);
  const seq = ledSeq(now);
  let n = 0;
  // release assertions that outlived their selection — the pane we
  // last reported is no longer the target, or herdr still shows a
  // pane bound to us that the ledger no longer proposes
  const releases = new Set(
    rows.filter(r => r.agent === LED_AGENT || r.agent === LED_SOURCE).map(r => r.pane_id)
  );
  if (stale !== undefined) releases.add(stale);
  if (pane !== undefined) releases.delete(pane); // its verdict lands via rep below
  for (const s of releases) {
    n += herdrOk(ledArgs(s, { kind: 'release' }, seq)) ? 1 : 0;
    if (s === stale) ledPanes.delete(t.wsId);
  }
  if (pane === undefined || rep === undefined) return n;
  n += herdrOk(ledArgs(pane, rep, seq)) ? 1 : 0;
  if (rep.kind === 'report') ledPanes.set(t.wsId, pane);
  else ledPanes.delete(t.wsId);
  return n;
}
