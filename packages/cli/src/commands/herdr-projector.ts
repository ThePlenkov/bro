/**
 * The daemon-owned fleet-status projector (spec bro-u19mq) — the ONE
 * writer of `[state·#PR]` workspace labels, the `status` metadata
 * token, and the per-worktree fleet-state file the `bro: status` pane
 * renders and self-reports (spec bro-idsat). The herdr session plugins
 * keep only spawn/attach lifecycle (`worktree open`, mirrors,
 * renderers, status panes, the reaper); they never write fleet labels —
 * this tick does, so a dead
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
  type ProviderEntry,
  gitTry,
  readAgentRegistry,
} from '@broject/core';
import { loopSection } from '@broject/loop';
import { loadBroConfig } from '../plugins.ts';
import {
  type FleetPaneState,
  fleetStatusPath,
  nextSeq,
  type PaneLed,
  pruneFleetStatus,
  readFleetState,
  writeFleetState,
} from './fleet-state.ts';
import { PANE_AGENT, PANE_SOURCE } from './herdr-status-view.ts';
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
  /** The act entry's PR html_url — the OSC8 target for `#N` text
   *  (absent when only a bead link resolved, which carries no URL). */
  prUrl?: string;
  /** Compact gate summary ('merged'|'4t/3f/6sast/conflicts'|'ok'|…) —
   *  absent when the act cache has no fresh entry for the PR. */
  gate?: string;
  /** A live claim/session-marker arm — drives the `no PR` layer when
   *  the tree has no worker and nothing resolves. */
  armed?: boolean;
  /** The freshest registry agent's program name — the real driver
   *  behind the pane (opencode, devin, claude, …). */
  agent?: string;
  /** The session pane's attach identity — the session-owning agent's
   *  recorded acpSessionId (spec bro-nwl5g). */
  acpSessionId?: string;
  /** The session-owning agent's provider name — the pane resolves its
   *  `providers.<name>` entry for the acp command. */
  provider?: string;
  /** The session-owning agent's recorded model — display text. */
  model?: string;
  /** The session-owning agent's native log — the session pane's
   *  fallback stream. */
  log?: string;
  /** The workspace's lane kind (spec bro-l8wqu) — true when the
   *  session-owning agent's provider resolves `type === 'acp'`: the
   *  workspace's one human pane is the session view (🤖 label);
   *  absent/false is the interactive-fallback set (⚙️ label). */
  acp?: boolean;
  /** The session-owning agent's `.events.jsonl` archive — the pane's
   *  live cross-process stream (spec bro-l8wqu). */
  events?: string;
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
  /** The PR's html_url — the OSC8 link target for `#N`. */
  url?: string;
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

/** The managed workspace's label — `<lane-icon> <worktree-name>`.
 *  🤖 stays on the acp lane (a headless robot owns the session pane);
 *  ⚙️ marks every other managed lane — interactive claim/marker/loop
 *  arms and non-acp workers alike (spec bro-l8wqu, operator decision).
 *  The LED carries the state, the name is the identity — the detail
 *  stays on the `status` token and in the status pane. */
export function labelFor(worktreePath: string, proj: TreeProjection): string {
  return `${proj.acp === true ? '🤖' : '⚙️'} ${basename(worktreePath)}`;
}

// --- the native LED (spec bro-awqde → bro-idsat) ---------------------------------

/** The projection → status-pane semantic state — the SAME
 *  classification the label carries, one mapping (bro-idsat):
 *  working/silent → working (silent carries its bucket as the
 *  message), interrupted/lost → blocked with the cause word,
 *  exited → idle (native done), stopped → idle (the status pane is a
 *  dashboard — release belongs to its own exit, not the worker's),
 *  armed-but-no-worker → unknown (the LED present but dim, the
 *  `no PR`-layer analogue), vacated → idle. */
export function paneLed(p: TreeProjection): PaneLed {
  switch (p.state) {
    case 'working':
      return { state: 'working' };
    case 'silent': {
      const m = workerToken(p);
      // a silent verdict always carries its bucket — an unbucketed
      // 'silent' message reads like a bug, so fall back to bare working
      return m === undefined || m === 'silent'
        ? { state: 'working' }
        : { state: 'working', message: m };
    }
    case 'interrupted':
    case 'lost':
      return { state: 'blocked', message: p.state };
    case 'exited':
      return { state: 'idle', message: 'exited' };
    case 'stopped':
      return { state: 'idle', message: 'stopped' };
    case undefined:
      return p.armed === true ? { state: 'unknown' } : { state: 'idle' };
  }
}

/** One `pane list` row — the backstop reads pane_id + bound agent. */
export interface HerdrPaneRow {
  pane_id: string;
  /** herdr's DETECTED or reported agent — absent means unbound. */
  agent?: string;
}

/** The recorded status pane is pushable while it exists and is either
 *  unbound or bound to ourselves — a row carrying a FOREIGN agent
 *  means the pane id was recycled under somebody else and the push
 *  must not land there. */
export function statusPaneLive(rows: HerdrPaneRow[], paneId: string): boolean {
  const row = rows.find(r => r.pane_id === paneId);
  return (
    row !== undefined &&
    (row.agent === undefined ||
      row.agent === '' ||
      row.agent === PANE_AGENT ||
      row.agent === PANE_SOURCE)
  );
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

/** `pane list --workspace <ws>` — the status pane's existence +
 *  bound-agent check for the backstop push. Undefined on any failure —
 *  a skipped push, not a tick verdict. */
function paneRows(wsId: string): HerdrPaneRow[] | undefined {
  return herdr<{ panes?: HerdrPaneRow[] }>(['pane', 'list', '--workspace', wsId])?.panes;
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
 *  ownership records AND the status-pane bindings, one parse. */
interface PluginLedger {
  /** worktree path → the plugin's workspace binding + ownership flag. */
  workspaces: Map<string, { ws?: string; managed?: boolean }>;
  /** workspace id → the `bro: status` pane the plugin spawned there —
   *  the backstop push's only destination (spec bro-idsat). */
  statusPanes: Map<string, string>;
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

/** Merge one parsed state file into the ledger — last write wins per
 *  workspace key and per status-pane binding. */
function mergeLedger(out: PluginLedger, v: PluginLedgerFile): void {
  for (const [k, r] of Object.entries(v.workspaces ?? {})) out.workspaces.set(k, r);
  for (const r of Object.values(v.statuses ?? {})) {
    if (r.workspace !== undefined && r.pane_id !== undefined) {
      out.statusPanes.set(r.workspace, r.pane_id);
    }
  }
}

function pluginLedger(ctx: Pick<PassCtx, 'root' | 'common'>): PluginLedger {
  const base = ctx.common ?? ctx.root;
  const real = realpathOrNull(base);
  const scopes = new Set(
    [base, ...(real === null || real === base ? [] : [real])].map(p =>
      createHash('sha1').update(p).digest('hex').slice(0, 12)
    )
  );
  const home = process.env.HOME ?? '/tmp';
  const dirs = new Set(
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
  );
  const out: PluginLedger = { workspaces: new Map(), statusPanes: new Map() };
  for (const dir of dirs) {
    for (const scope of scopes) {
      // unscoped `state.json` is the legacy name — read first so a
      // same-dir scoped file always wins on a shared worktree key
      for (const file of ['state.json', `state-${scope}.json`]) {
        try {
          mergeLedger(out, JSON.parse(readFileSync(join(dir, file), 'utf8')));
        } catch {
          // no ledger at this candidate — the others still apply
        }
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
): { pr?: number; prUrl?: string; gate?: string } {
  const link = slug !== undefined ? prFromLink(beads.find(b => b.id === slug)?.link) : undefined;
  const fresh = (e: ActEntry): boolean => now - e.fetchedAt <= ACT_LABEL_STALE_MS;
  const byRef =
    branch !== undefined && branch !== ''
      ? act.find(e => e.state.headRef === branch && fresh(e))
      : undefined;
  const entry = byRef ?? act.find(e => e.state.pr === link && fresh(e));
  const pr = entry?.state.pr ?? link;
  if (pr === undefined) return {};
  return {
    pr,
    ...(entry?.state.url !== undefined ? { prUrl: entry.state.url } : {}),
    ...(entry !== undefined ? { gate: gateFrag(entry.state) } : {}),
  };
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
  /** The agent binary driving the pipeline (opencode, devin, …) —
   *  resolved from `providers.<name>.command`, the pane's agent name. */
  agent?: string;
  /** The session-view fields — raw registry ride-alongs the
   *  `bro: session` pane resolves against provider config. */
  provider?: string;
  model?: string;
  acpSessionId?: string;
  log?: string;
  /** True when the entry's provider resolves `type === 'acp'` —
   *  the lane verdict (spec bro-l8wqu). */
  acp?: boolean;
  /** The worker's `.events.jsonl` archive path — present only on an
   *  acp row carrying an agentId (the turn plane's archive file). */
  events?: string;
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

/** The projection + display title + resolved slug for one worktree —
 *  the object the status pane consumes via the fleet-state file. */
export function projectTree(i: TreeInput): {
  projection: TreeProjection;
  title: string;
  slug?: string;
} {
  const slug =
    i.claim ??
    i.runs.find(r => r.beadId !== undefined)?.beadId ??
    (i.agents.find(a => a.live) ?? i.agents[0])?.key;
  const worker = workerState(workerCands(i), i.stallMin);
  // the freshest agent names the pipeline driver — a live one wins,
  // a dead one still identifies who ran the tree
  const agent = (
    i.agents.find(a => a.live && a.agent !== undefined) ?? i.agents.find(a => a.agent !== undefined)
  )?.agent;
  // the session owner — the agent whose session the `bro: session` pane
  // attaches (or whose log it tails). A carrier is a row holding an
  // acpSessionId or a log; live wins over dead, the newest carrier
  // wins inside a liveness class — the freshest worker on the tree is
  // the session worth watching, even when an older acp session exists
  const session = i.agents.reduce<AgentRow | undefined>((best, a) => {
    if (a.acpSessionId === undefined && a.log === undefined) return best;
    if (best === undefined || (a.live && !best.live)) return a;
    return a.live === best.live && a.at > best.at ? a : best;
  }, undefined);
  const projection: TreeProjection = {
    ...worker,
    ...prFor(i.branch, slug, i.beads, i.act, i.now),
    armed: i.claim !== undefined || i.markerArmed,
    ...(agent !== undefined ? { agent } : {}),
    ...(session?.acpSessionId !== undefined ? { acpSessionId: session.acpSessionId } : {}),
    ...(session?.provider !== undefined ? { provider: session.provider } : {}),
    ...(session?.model !== undefined ? { model: session.model } : {}),
    ...(session?.log !== undefined ? { log: session.log } : {}),
    ...(session?.acp === true ? { acp: true } : {}),
    ...(session?.events !== undefined ? { events: session.events } : {}),
  };
  const title =
    (slug !== undefined ? i.beads.find(b => b.id === slug)?.title : undefined) || basename(i.path);
  return { projection, title, ...(slug !== undefined ? { slug } : {}) };
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
  /** `providers` section — resolves a registry entry's `provider` to
   *  the agent binary name its command spawns. */
  providers: Record<string, ProviderEntry>;
}

/** The agent name behind a provider command — the first meaningful
 *  token of the LAST pipeline segment (`cat f | claude -p` → claude;
 *  `npx opencode acp` → opencode). Shell wrappers and `{placeholder}`
 *  tokens are skipped. */
const CMD_WRAPPERS = new Set(['npx', 'bunx', 'uvx', 'env', 'cat', 'echo', 'sh', 'bash']);
export function agentOfCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  const last = (command.split('|').pop() ?? '').trim();
  for (const tok of last.split(/\s+/)) {
    if (tok === '' || tok.startsWith('{') || /^[A-Z_]+=/.test(tok)) continue;
    const name = basename(tok);
    if (CMD_WRAPPERS.has(name)) continue;
    return name;
  }
  return undefined;
}

/** `providers.<name>.command` where the entry variant carries one —
 *  api-typed entries have no spawned binary to name. */
function providerCommand(entry: ProviderEntry | undefined): string | undefined {
  return entry !== undefined && 'command' in entry ? entry.command : undefined;
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
    providers: loadBroConfig(ctx.root).providers ?? {},
  };
}

/** One managed∩open pair — the worktree, the workspace id herdr has
 *  open for it, the live workspace record (the dedup source), and the
 *  status pane the ledger binds to it (the backstop's destination). */
interface WsTarget {
  tree: HerdrWorktree;
  wsId: string;
  live: HerdrWorkspace;
  statusPane?: string;
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
    const statusPane = ledger.statusPanes.get(wsId);
    out.push({ tree, wsId, live, ...(statusPane !== undefined ? { statusPane } : {}) });
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
      const acp = e.provider !== undefined && p.providers[e.provider]?.type === 'acp';
      return {
        key,
        live,
        ...(live ? {} : { terminal: TERMINAL[st] }),
        silentMs: live ? agentSilentMs(e, ctx) : null,
        ...(e.provider !== undefined
          ? {
              agent: agentOfCommand(providerCommand(p.providers[e.provider])) ?? e.provider,
              provider: e.provider,
            }
          : {}),
        ...(typeof e.model === 'string' ? { model: e.model } : {}),
        ...(typeof e.acpSessionId === 'string' ? { acpSessionId: e.acpSessionId } : {}),
        ...(typeof e.log === 'string' ? { log: e.log } : {}),
        ...(acp ? { acp: true } : {}),
        ...(acp && p.agentsHome !== null && typeof e.agentId === 'string' && e.agentId !== ''
          ? { events: join(p.agentsHome, `${e.agentId}.events.jsonl`) }
          : {}),
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
  const none: ProjectResult = { reachable: false, workspaces: 0, writes: 0, files: 0, leds: 0 };
  const trees = herdr<{ worktrees?: HerdrWorktree[] }>(['worktree', 'list', '--cwd', mainRoot]);
  if (trees?.worktrees === undefined) return none;

  const common = gitCommonDir(mainRoot);
  const wsList = herdr<{ workspaces?: HerdrWorkspace[] }>(['workspace', 'list']);
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
  const ctx: PassCtx = { root: mainRoot, common, now };
  const targets = managedTargets(trees.worktrees, pluginLedger(ctx), wsById);
  // state files live under the common dir the pane resolves identically
  // (gitCommonDir(worktree) ?? worktree) — prune has the same base
  const statusBase = common ?? mainRoot;
  // prune keeps every file a live workspace could still be rendering:
  // a tree herdr lists with an open workspace keeps its file even when
  // the ledger read was blind — wiping on a transient miss would blank
  // every status pane until the next good pass
  const keep = new Set(
    trees.worktrees
      .filter(t => t.open_workspace_id !== undefined)
      .map(t => fleetStatusPath(statusBase, t.path))
  );
  if (targets.length === 0) {
    pruneFleetStatus(statusBase, keep);
    return { reachable: true, workspaces: 0, writes: 0, files: 0, leds: 0 };
  }

  const planes = readPlanes(ctx);
  let writes = 0;
  let files = 0;
  let leds = 0;
  for (const t of targets) {
    const { projection, title, slug } = projectTree(treeInput(t.tree, planes, ctx));
    // an empty bead plane means the backend read failed or is empty —
    // a live titled label beats a path-basename downgrade in that gap
    const safe = planes.beads.length === 0 ? (liveTitle(t.live.label) ?? title) : title;
    writes += writeDiffs({ ws: t, proj: projection, title: safe, now: ctx.now });
    const r = paneWrites({
      ws: t,
      proj: projection,
      title: safe,
      slug,
      base: statusBase,
      now: ctx.now,
    });
    files += r.files;
    leds += r.leds;
    if (r.path !== undefined) keep.add(r.path);
  }
  pruneFleetStatus(statusBase, keep);
  return { reachable: true, workspaces: targets.length, writes, files, leds };
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
  const label = labelFor(j.ws.tree.path, j.proj);
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
    PANE_SOURCE,
    '--agent',
    PANE_AGENT,
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
  const title =
    j.title === basename(j.ws.tree.path) && prev?.title !== undefined && prev.title !== ''
      ? prev.title
      : j.title;
  return {
    v: 1,
    worktree: j.ws.tree.path,
    workspace: j.ws.wsId,
    title,
    ...(j.slug !== undefined ? { slug: j.slug } : {}),
    status: statusString(j.proj),
    ...(j.proj.prUrl !== undefined ? { prUrl: j.proj.prUrl } : {}),
    ...(j.proj.agent !== undefined ? { agent: j.proj.agent } : {}),
    ...(j.proj.acpSessionId !== undefined ? { acpSessionId: j.proj.acpSessionId } : {}),
    ...(j.proj.provider !== undefined ? { provider: j.proj.provider } : {}),
    ...(j.proj.model !== undefined ? { model: j.proj.model } : {}),
    ...(j.proj.log !== undefined ? { log: j.proj.log } : {}),
    ...(j.proj.acp === true ? { lane: 'acp' as const } : {}),
    ...(j.proj.events !== undefined ? { events: j.proj.events } : {}),
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
  if (j.ws.statusPane !== undefined) {
    const rows = paneRows(j.ws.wsId);
    if (rows !== undefined && statusPaneLive(rows, j.ws.statusPane)) {
      leds = herdrOk(backstopArgs(j.ws.statusPane, led, nextSeq(j.now))) ? 1 : 0;
    }
  }
  return { files, leds, path };
}
