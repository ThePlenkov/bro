/** The daemon projector's pure half — worktree records → the
 *  TreeProjection the labels, tokens, LED, and fleet-state file all
 *  derive from. Zero exec/fs writes: inputs arrive already classified
 *  (boundary probes pre-compute liveness); the only fs touch is the
 *  agent log's mtime read inside agentSilentMs.
 *
 *  Extracted from packages/cli/src/commands/herdr-projector.ts —
 *  see the file header there for the ownership contract. */
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { PaneLed } from '@broject/acp-session';
import type { AgentRegistryEntry, AgentState, ProviderEntry } from '@broject/core';
import { STATUS_IDENTITY } from '../client/index.ts';

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
const PANE_LED: { [K in WorkerState]: (p: TreeProjection) => PaneLed } = {
  working: () => ({ state: 'working' }),
  silent: silentLed,
  interrupted: p => ({ state: 'blocked', message: p.state }),
  lost: p => ({ state: 'blocked', message: p.state }),
  exited: () => ({ state: 'idle', message: 'exited' }),
  stopped: () => ({ state: 'idle', message: 'stopped' }),
};

function silentLed(p: TreeProjection): PaneLed {
  const m = workerToken(p);
  // a silent verdict always carries its bucket — an unbucketed
  // 'silent' message reads like a bug, so fall back to bare working
  return m === undefined || m === 'silent'
    ? { state: 'working' }
    : { state: 'working', message: m };
}

export function paneLed(p: TreeProjection): PaneLed {
  if (p.state === undefined) {
    return p.armed === true ? { state: 'unknown' } : { state: 'idle' };
  }
  const led = Object.getOwnPropertyDescriptor(PANE_LED, p.state)?.value;
  return led !== undefined ? led(p) : { state: 'idle' };
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
      row.agent === STATUS_IDENTITY.agent ||
      row.agent === STATUS_IDENTITY.source)
  );
}

export interface ActEntry {
  fetchedAt: number;
  state: GateState;
}

/** Ms since a live agent's last visible output — the log's mtime is
 *  the strongest signal (it moves with every byte), `spawnedAt` the
 *  floor for a log that never materialized. */
export function agentSilentMs(e: AgentRegistryEntry, ctx: { now: number }): number | null {
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

export const TERMINAL: Partial<Record<AgentState, WorkerState>> = {
  blocked: 'interrupted',
  exited: 'exited',
  lost: 'lost',
  stopped: 'stopped',
};

export const parseTs = (s: unknown): number => {
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
  const slug = treeSlug(i);
  const projection: TreeProjection = {
    ...workerState(workerCands(i), i.stallMin),
    ...prFor(i.branch, slug, i.beads, i.act, i.now),
    armed: i.claim !== undefined || i.markerArmed,
    ...definedFields({ agent: driverAgent(i.agents) }),
    ...sessionFields(sessionOwner(i.agents)),
  };
  const title = treeTitle(i, slug);
  return { projection, title, ...(slug !== undefined ? { slug } : {}) };
}

/** The tree's resolved slug — claim first, then a run's beadId, then
 *  the freshest agent's registry key. */
function treeSlug(i: TreeInput): string | undefined {
  return (
    i.claim ??
    i.runs.find(r => r.beadId !== undefined)?.beadId ??
    (i.agents.find(a => a.live) ?? i.agents[0])?.key
  );
}

/** The freshest agent names the pipeline driver — a live one wins, a
 *  dead one still identifies who ran the tree. */
function driverAgent(agents: AgentRow[]): string | undefined {
  const named = agents.filter(a => a.agent !== undefined);
  return (named.find(a => a.live) ?? named[0])?.agent;
}

/** The bead title behind the slug, else the worktree's basename. */
function treeTitle(i: TreeInput, slug: string | undefined): string {
  const bead = slug === undefined ? undefined : i.beads.find(b => b.id === slug);
  return bead?.title || basename(i.path);
}

/** Drop the undefined entries of a partial — the spread-table below
 *  keeps `projectTree` flat instead of one ternary per field. */
export function definedFields<T extends object>(
  fields: {
    [K in keyof T]: T[K] | undefined;
  }
): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

/** The session owner's ride-along fields — present only when the row
 *  carries them (acp collapses to `true`, never `false`). */
function sessionFields(
  s: AgentRow | undefined
): Pick<TreeProjection, 'acpSessionId' | 'provider' | 'model' | 'log' | 'acp' | 'events'> {
  if (s === undefined) return {};
  return definedFields({
    acpSessionId: s.acpSessionId,
    provider: s.provider,
    model: s.model,
    log: s.log,
    acp: s.acp === true ? true : undefined,
    events: s.events,
  });
}

/** A carrier is a row holding an acpSessionId or a log. */
const carriesSession = (a: AgentRow): boolean =>
  a.acpSessionId !== undefined || a.log !== undefined;

/** Live wins over dead; inside a liveness class the newest carrier
 *  wins — the freshest worker on the tree is the session worth
 *  watching, even when an older acp session exists. */
const outranks = (a: AgentRow, best: AgentRow): boolean =>
  (a.live && !best.live) || (a.live === best.live && a.at > best.at);

/** The session owner — the agent whose session the `bro: session` pane
 *  attaches (or whose log it tails). */
function sessionOwner(agents: AgentRow[]): AgentRow | undefined {
  const carriers = agents.filter(carriesSession);
  return carriers.reduce<AgentRow | undefined>(
    (best, a) => (best === undefined || outranks(a, best) ? a : best),
    undefined
  );
}

/** The agent name behind a provider command — the first meaningful
 *  token of the LAST pipeline segment (`cat f | claude -p` → claude;
 *  `npx opencode acp` → opencode). Shell wrappers and `{placeholder}`
 *  tokens are skipped. */
const CMD_WRAPPERS = new Set(['npx', 'bunx', 'uvx', 'env', 'cat', 'echo', 'sh', 'bash']);

/** Shell noise tokens — empties, `{placeholder}`s, `VAR=val` prefixes. */
const NOISE_TOKEN: ((t: string) => boolean)[] = [
  t => t === '',
  t => t.startsWith('{'),
  t => /^[A-Z_]+=/.test(t),
];

/** The program name a token resolves to, or undefined for noise and
 *  shell wrappers (`npx`, `cat`, …). */
const meaningfulToken = (tok: string): string | undefined => {
  if (NOISE_TOKEN.some(skip => skip(tok))) return undefined;
  const name = basename(tok);
  return CMD_WRAPPERS.has(name) ? undefined : name;
};
export function agentOfCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  const last = (command.split('|').pop() ?? '').trim();
  for (const tok of last.split(/\s+/)) {
    const name = meaningfulToken(tok);
    if (name !== undefined) return name;
  }
  return undefined;
}

/** `providers.<name>.command` where the entry variant carries one —
 *  api-typed entries have no spawned binary to name. */
export function providerCommand(entry: ProviderEntry | undefined): string | undefined {
  return entry !== undefined && 'command' in entry ? entry.command : undefined;
}
