/**
 * The daemon-owned fleet-status projector (spec bro-u19mq) — the ONE
 * writer of `[state·#PR]` workspace labels and the `status` metadata
 * token on herdr workspaces. The herdr session plugins keep only
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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
const HERDR_TIMEOUT_MS = 15_000;

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
  if (silentMs === null || silentMs === undefined || !Number.isFinite(silentMs)) return null;
  const min = silentMs / 60_000;
  return min >= 60 ? Math.floor(min / 60) * 60 : Math.max(0, Math.floor(min / 5) * 5);
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

/** The worker verdict for one worktree — a live run anywhere wins over
 *  every dead record (the respawn edge), and a live agent outranks a
 *  dead run. Among terminal records the newest wins. */
export function workerState(
  cands: WorkerCand[],
  stallMin: number
): Pick<TreeProjection, 'state' | 'silentMin'> {
  const live = cands.filter(c => c.live);
  const w = freshest(live.filter(c => c.run)) ?? freshest(live);
  if (w !== undefined) {
    const b = silentBucketMin(w.silentMs);
    if (b !== null && stallMin > 0 && Math.floor((w.silentMs ?? 0) / 60_000) >= stallMin) {
      return { state: 'silent', silentMin: b };
    }
    return { state: 'working' };
  }
  const dead = cands.filter(c => !c.live && c.terminal !== undefined);
  if (dead.length === 0) return {};
  return { state: dead.reduce((a, b) => (b.at > a.at ? b : a)).terminal };
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

/** Compact last-observed gate summary — `1f`, `4t/3f/6sast/conflicts`,
 *  `pending`, `ok` — "is it moving", not "may it merge". */
export function gateFrag(s: GateState): string {
  const st = (s.state ?? '').toUpperCase();
  if (st === 'MERGED' || st === 'CLOSED') return st.toLowerCase();
  if (s.isDraft === true) return 'draft';
  const parts: string[] = [];
  const threads = s.openThreads ?? 0;
  const failing = s.ciFailing ?? 0;
  const sast = s.sastPending ?? 0;
  if (threads > 0) parts.push(`${threads}t`);
  if (failing > 0) parts.push(`${failing}f`);
  if (sast > 0) parts.push(`${sast}sast`);
  if ((s.mergeable ?? '').toUpperCase() === 'CONFLICTING') parts.push('conflicts');
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
    return `#${p.pr}${p.gate !== undefined && p.gate !== '' ? ` ${p.gate}` : ''}`;
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

function herdrRun(args: string[], cwd?: string): { code: number; out: string } {
  const r = spawnSync(HERDR(), args, {
    cwd,
    encoding: 'utf8',
    timeout: HERDR_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  return { code: r.status ?? -1, out: r.stdout ?? '' };
}

/** `herdr <args>` → `.result`, undefined on any failure — reachability
 *  is the caller's verdict, a bad envelope is just a miss. */
function herdr<T>(args: string[], cwd?: string): T | undefined {
  const r = herdrRun(args, cwd);
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

export interface ActEntry {
  fetchedAt: number;
  state: GateState;
}

/** `<git-common>/bro/act-state/*.json` — the last gate each real
 *  poller observed. A label reads the freshest observation; it never
 *  pays a gh call itself. */
function actStates(common: string | null): ActEntry[] {
  if (common === null) return [];
  const dir = join(common, 'bro', 'act-state');
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
  return out;
}

/** The plugin's ownership ledger — `managed: true` marks workspaces a
 *  plugin opened (the only ones we may relabel). Read-only here; the
 *  plugin still owns writes. Same file contract as plugins/herdr:
 *  `$HERDR_PLUGIN_STATE_DIR` or `~/.config/bro-herdr-plugin/
 *  state-<sha1(git-common-dir).slice(0,12)>.json`. */
function managedSet(
  mainRoot: string,
  common: string | null
): Map<string, { ws?: string; managed?: boolean }> {
  const scope = createHash('sha1')
    .update(common ?? mainRoot)
    .digest('hex')
    .slice(0, 12);
  const dir =
    process.env.HERDR_PLUGIN_STATE_DIR ??
    join(process.env.HOME ?? '/tmp', '.config', 'bro-herdr-plugin');
  try {
    const v = JSON.parse(readFileSync(join(dir, `state-${scope}.json`), 'utf8')) as {
      workspaces?: Record<string, { ws?: string; managed?: boolean }>;
    };
    return new Map(Object.entries(v.workspaces ?? {}));
  } catch {
    return new Map();
  }
}

/** Branch per worktree from `git worktree list --porcelain` — the
 *  headRef join when herdr's list row doesn't carry it. */
function gitBranches(root: string): Map<string, string> {
  const r = gitTry(['-C', root, 'worktree', 'list', '--porcelain']);
  if (r.code !== 0) return new Map();
  return new Map(parseWorktreePorcelain(r.out).map(t => [t.path, t.branch ?? ''] as const));
}

/** The stall window for silence bucketing — `loop.stallMin`, 0 when
 *  the config can't be read (no stall semantics, every live run is
 *  'working'). */
function stallMin(root: string): number {
  try {
    return loopSection(loadBroConfig(root).loop).stallMin;
  } catch {
    return 0;
  }
}

/** Ms since a live agent's last visible output — the log's mtime is
 *  the strongest signal (it moves with every byte), `spawnedAt` the
 *  floor for a log that never materialized. */
function agentSilentMs(e: AgentRegistryEntry, now: number): number | null {
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
  return refs.length === 0 ? null : Math.max(0, now - Math.max(...refs));
}

const TERMINAL: Partial<Record<AgentState, WorkerState>> = {
  blocked: 'interrupted',
  exited: 'exited',
  lost: 'lost',
  stopped: 'stopped',
};

const parseTs = (s: unknown): number =>
  typeof s === 'string' ? (Number.isFinite(Date.parse(s)) ? Date.parse(s) : 0) : 0;

/** Entries past this age are treated as absent — a dead poller's last
 *  write must not paint a stale verdict on the label forever. */
const ACT_LABEL_STALE_MS = 30 * 60_000;

const prFromLink = (link: string | undefined): number | undefined => {
  const m = link !== undefined ? /\/pull\/(\d+)/.exec(link) : null;
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
};

/** PR + gate for a worktree: the bead's link first, else the act-state
 *  entry whose `headRef` is the tree's branch (fresh within the label
 *  window). */
export function prFor(
  branch: string | undefined,
  slug: string | undefined,
  beads: { id: string; link?: string }[],
  act: ActEntry[],
  now: number
): { pr?: number; gate?: string } {
  const link = slug !== undefined ? prFromLink(beads.find(b => b.id === slug)?.link) : undefined;
  const fresh = (e: ActEntry): boolean => now - e.fetchedAt <= ACT_LABEL_STALE_MS;
  const entry =
    (branch !== undefined && branch !== ''
      ? act.find(e => e.state.headRef === branch && fresh(e))
      : undefined) ?? act.find(e => e.state.pr === link && fresh(e));
  const pr = link ?? entry?.state.pr;
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

/** The projection + display title for one worktree — the object a
 *  future herdr badge consumes directly. */
export function projectTree(i: TreeInput): { projection: TreeProjection; title: string } {
  const slug = i.claim ?? i.runs.find(r => r.beadId !== undefined)?.beadId ?? i.agents[0]?.key;
  const cands: WorkerCand[] = [
    ...i.runs.map(r => ({
      run: true,
      live: r.state === 'running',
      silentMs: r.silentMs,
      ...(r.state === 'dead' ? { terminal: 'lost' as WorkerState } : {}),
      at: r.at,
    })),
    ...i.agents.map(a => ({
      run: false,
      live: a.live,
      silentMs: a.live ? a.silentMs : null,
      ...(a.live ? {} : { terminal: a.terminal }),
      at: a.at,
    })),
  ];
  const worker = workerState(cands, i.stallMin);
  const armed = i.claim !== undefined || i.markerArmed;
  const projection: TreeProjection = {
    ...worker,
    ...prFor(i.branch, slug, i.beads, i.act, i.now),
    armed,
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
}

/** One projection pass over every plugin-managed open workspace of the
 *  repo. All bro inputs are local reads; each herdr write is a diff
 *  (live label/tokens already hold the last written values — no state
 *  file needed for dedup). Fail-open: any failure degrades to a
 *  skipped pass, never a thrown tick. */
export function projectFleet(mainRoot: string, now = Date.now()): ProjectResult {
  const none: ProjectResult = { reachable: false, workspaces: 0, writes: 0 };
  const trees = herdr<{ worktrees?: HerdrWorktree[] }>(
    ['worktree', 'list', '--cwd', mainRoot],
    mainRoot
  );
  if (trees?.worktrees === undefined) return none;

  const common = gitCommonDir(mainRoot);
  const managed = managedSet(mainRoot, common);
  const wsAll = herdr<{ workspaces?: HerdrWorkspace[] }>(['workspace', 'list'])?.workspaces ?? [];
  const wsById = new Map(wsAll.map(w => [w.workspace_id, w]));

  // the managed∩open set — every later plane read is only worth it
  // when at least one workspace is ours to label
  const targets = trees.worktrees.filter(t => {
    const open = t.open_workspace_id;
    if (open === undefined) return false;
    const rec = managed.get(t.path);
    return rec?.managed === true && rec.ws === open && wsById.has(open);
  });
  if (targets.length === 0) return { reachable: true, workspaces: 0, writes: 0 };

  const agentsHome = common === null ? null : join(common, 'bro', 'agents');
  const registry = readAgentRegistry(mainRoot);
  const branches = gitBranches(mainRoot);
  const runs = collectLoopRuns(mainRoot, now);
  const act = actStates(common);
  const beads = readBeads(mainRoot).inProgress;
  const hooks = hooksDirOf(mainRoot);
  const details = hooks === null ? [] : liveWorkEntries(hooks, ['.work'], now);
  const stall = stallMin(mainRoot);

  let writes = 0;
  for (const t of targets) {
    const openId = t.open_workspace_id as string;
    const branch = t.branch ?? branches.get(t.path) ?? undefined;
    const claim = worktreeClaim(t.path, now);
    const input: TreeInput = {
      path: t.path,
      ...(branch !== undefined ? { branch } : {}),
      ...(claim !== undefined ? { claim } : {}),
      markerArmed: details.some(e =>
        detailMatches(e.detail, { branch: branch ?? '', slug: claim ?? '', worktree: t.path })
      ),
      runs: runs
        .filter(r => r.worktree === t.path)
        .map(r => ({
          state: r.state,
          ...(r.beadId !== '' ? { beadId: r.beadId } : {}),
          silentMs: r.silentMs,
          at: parseTs(r.startedAt),
        })),
      agents: Object.entries(registry)
        .filter(([, e]) => e.worktree === t.path)
        .map(([key, e]) => {
          const st = registryEntryState(agentsHome, e);
          const live = st === 'running' || st === 'spawned';
          return {
            key,
            live,
            ...(live ? {} : { terminal: TERMINAL[st] }),
            silentMs: live ? agentSilentMs(e, now) : null,
            at: parseTs(e.spawnedAt),
          };
        }),
      beads,
      act,
      now,
      stallMin: stall,
    };
    const { projection, title } = projectTree(input);
    writes += writeDiffs(openId, wsById.get(openId), projection, title, now);
  }
  return { reachable: true, workspaces: targets.length, writes };
}

/** Push one workspace's diffs — the live label and tokens are the
 *  dedup record. A failing write skips this workspace only. */
function writeDiffs(
  wsId: string,
  live: HerdrWorkspace | undefined,
  proj: TreeProjection,
  title: string,
  now: number
): number {
  if (live === undefined) return 0;
  let n = 0;
  const label = labelFor(proj, title);
  if ((live.label ?? '') !== label && herdrOk(['workspace', 'rename', wsId, label])) n += 1;

  const status = statusString(proj);
  const tokens = live.tokens ?? {};
  const args = [
    'workspace',
    'report-metadata',
    wsId,
    '--source',
    'bro.fleet',
    '--seq',
    String(now),
  ];
  let meta = false;
  if (status !== '' && tokens.status !== status) {
    args.push('--token', `status=${status}`);
    meta = true;
  } else if (status === '' && tokens.status !== undefined) {
    args.push('--clear-token', 'status');
    meta = true;
  }
  // retire the plugin-era keys — the daemon's `status` token replaces them
  for (const k of ['bro.worker', 'bro.pr', 'bro.gate']) {
    if (tokens[k] !== undefined) {
      args.push('--clear-token', k);
      meta = true;
    }
  }
  if (meta && herdrOk(args)) n += 1;
  return n;
}
