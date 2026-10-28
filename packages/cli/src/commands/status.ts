/**
 * `bro status` — the compact live board for the current repo. One read
 * returns everything a thin client (pi extension widget, TUI, webui)
 * needs per refresh tick, where N shell calls per tick used to be the
 * only way:
 *
 *   bro status            compact board — beads, worktrees, fleet, drill, git
 *   bro status --json     the same board, machine-readable
 *   bro status --deep     + act exit gate for the current branch's PR
 *                         (network — the fast path stays local-only)
 *
 * All state is read, never mutated. Sources: the tasks facade
 * (in-progress + ready — the serving backend, not a hardcoded bd),
 * the agent registry (<git-common>/bro/agents.json — shared across
 * linked worktrees), `git worktree list` + the in-tree claim markers
 * `bro work enter` stamps, the drill stack, git porcelain. Bead-less or
 * registry-less checkouts still answer — the absent sections are empty
 * arrays/null, never errors.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { evaluateExitGate, fetchPrActState, prStateCache, resolveLedger } from '@broject/act';
import {
  facade,
  gitTry,
  gitUpstreamBehind,
  pidAlive,
  prOwnership,
  prOwnershipMark,
  prLink,
  issueLink,
  readAgentRegistry,
  reviewHost,
} from '@broject/core';
import type { AgentRegistryEntry, TaskRow, TaskStore } from '@broject/core';
import { currentFrame } from '@broject/drill';
import { loopSection } from '@broject/loop';
import { loadBroConfig } from '../plugins.ts';
import { readStamp, stampAgo, stampSession } from './buildstamp.ts';
import { collectLoopRuns, type LoopRunView } from './loop-state.ts';
import { heartbeatAge, readHeartbeat, type HeartbeatSummary } from './watch-heartbeat.ts';
import { parseWorktreePorcelain, stateOfWorktree, worktreeClaim } from './work.ts';

export interface BeadRow {
  id: string;
  title: string;
  priority?: number;
  issue_type?: string;
  assignee?: string;
  /** Clickable PR/issue reference when the bead is linked to one. */
  link?: string;
}

interface StatusAgent {
  id: string;
  /** The attempt's agentId — keys `<agents-home>/<agentId>.{log,stderr}`
   *  and the `agent-<agentId>.work` occupancy marker. Needed by thin
   *  clients that mirror or link agent artifacts without parsing the
   *  registry file themselves (bro-762eh). */
  agentId?: string;
  backend: string;
  step?: string;
  state: string;
  cause?: string;
  pid?: number;
  /** Absolute path of the agent's log file, when the backend records
   *  one — lets a read-plane client tail the worker without knowing
   *  the artifacts-dir convention. */
  log?: string;
  worktree?: string;
  provider?: string;
  model?: string;
}

/** One checkout on the board. `state` is `bro work list`'s vocabulary
 *  (clean|dirty(n)|gone|LOCKED|PRUNABLE — via stateOfWorktree, so the
 *  two planes never disagree); it is present only where the board
 *  probed — claimed trees, main, and cwd — because a per-tree
 *  `git status` is the one expensive read this section has. `claim`
 *  is the live in-tree marker detail `bro work enter` stamped —
 *  absent when the tree is unclaimed or its marker aged out. */
export interface StatusWorktree {
  name: string;
  path: string;
  branch?: string;
  state?: string;
  claim?: string;
  /** the primary checkout (porcelain's first entry) */
  main?: boolean;
  /** the board's own cwd — loop/drive workers run in linked trees, so
   *  cwd ≠ main in general */
  here?: boolean;
}

interface BroStatus {
  dir: string;
  branch: string;
  /** Dirty-path count from `git status --porcelain` — untracked incl. */
  dirty: number;
  /** Every checkout in `git worktree list` — the claimed-live-work
   *  plane `bro work list` owns, surfaced on the board so an occupied
   *  sibling doesn't read only as a bead row (bro-0vj14). */
  worktrees: StatusWorktree[];
  beads: {
    inProgress: BeadRow[];
    /** First READY_CAP ready beads — the board shows the top, not all. */
    ready: BeadRow[];
    /** Total ready count — usually larger than ready.length (capped). */
    readyTotal: number;
  };
  fleet: { maxConcurrent: number; agents: StatusAgent[] };
  /** In-flight `bro loop` workers — records under <git-common>/bro/loop/.
   *  stallMin is the advisory silence threshold, never a kill budget
   *  (bro-9lpn3). */
  loop: { stallMin: number; runs: LoopRunView[] };
  drill: { frame: { id: string; title: string; depth: number } | null };
  /** The durable heartbeat file's summary (bro-dxoa5) — last tick's
   *  age + open-attention count. null = never had a heartbeat (or the
   *  file is unreadable) — an ordinary state, not an error. */
  watch: HeartbeatSummary | null;
  /** Last stamped write to this worktree's shared outputs (bro-fatja)
   *  — null until a build/patch stamps one. `mine` is null when the
   *  current session can't resolve (a bare `bro status` has no env
   *  pin and the marker scan wasn't unambiguous). */
  build: {
    session: string;
    via: string;
    ts: number;
    /** stamp.head ≠ HEAD — the recorded write predates the checkout. */
    behind: boolean;
    mine: boolean | null;
  } | null;
  /** Positive upstream drift — the checkout trails its tracking ref.
   *  Local read, never a fetch: the staleness of the remote-tracking
   *  ref IS the signal (bro-6k3f4). null when current or untracked. */
  sync: { behind: number; upstream: string } | null;
  /** --deep only: the act gate for the current branch's open PR. */
  act?: {
    pr: number;
    url: string;
    gate: string;
    openThreads: number;
    /** Threads resolved before and commented on again — the act loop's
     *  reopened-thread cycle-guard. */
    reopenedThreads: number;
    ciPending: number;
    ciFailing: number;
    reviewersPending: number;
    sastPending: number;
    blockers: string[];
    /** who lands the PR (spec bro-c650l) — absent when the label read
     *  itself failed; 'human' means no bro marker */
    ownership?: 'managed' | 'review' | 'human';
  } | null;
}

/** Cheap liveness for the light board — the connectors own the rich
 *  probe; status just wants "alive / exited / stopped". */
function agentState(e: AgentRegistryEntry): string {
  if (e.stopped === true) {
    return 'stopped';
  }
  if (typeof e.exitStatus === 'number') {
    return 'exited';
  }
  const pid = typeof e.pid === 'number' ? e.pid : undefined;
  if (pid !== undefined) {
    const pidStart = typeof e.pidStart === 'string' ? e.pidStart : undefined;
    return pidAlive(pid, pidStart) ? 'running' : 'exited';
  }
  return 'unknown';
}

/** Ready beads are a backlog queue — the widget needs the top few plus
 *  the count, never all 60+ rows with descriptions and dependencies.
 *  Exported for the work plane's status read, which caps identically. */
export const READY_CAP = 10;

/** The queue board's bead sections — claimed (in-progress) work plus
 *  the ready depth. Exported so the serve facade's queue plane reads
 *  the same shape `bro status` renders. */
export interface StatusBeads {
  inProgress: BeadRow[];
  /** First READY_CAP ready beads — the board shows the top, not all. */
  ready: BeadRow[];
  /** Total ready count — usually larger than ready.length (capped). */
  readyTotal: number;
}

export function readBeads(dir: string): StatusBeads {
  const empty = { inProgress: [], ready: [], readyTotal: 0 };
  let store: TaskStore;
  try {
    store = facade('tasks', { dir }, { prefer: loadBroConfig(dir).connectors });
  } catch {
    return empty; // no serving backend — an empty board, not an error
  }
  // backend rows carry description/deps/metadata a widget never
  // renders — pick the board fields so one call stays a few KB
  // Resolve the repo slug once per readBeads call — cheap-ish and the
  // links are advisory. Fail-open: no slug → no link, never an error.
  let repo: string | null = null;
  let repoResolved = false;
  const repoSlug = (): string | null => {
    if (repoResolved) {
      return repo;
    }
    repoResolved = true;
    try {
      const remote = gitTry(['-C', dir, 'config', '--get', 'remote.origin.url']);
      if (remote.code !== 0) {
        return null;
      }
      const url = remote.out.trim();
      // Only derive a slug for GitHub remotes — a host like
      // notgithub.com must not be mistaken for github.com.
      const hostMatch = url.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)?([^\/:]+)[\/:]/);
      const host = hostMatch !== null && hostMatch[1] !== undefined ? hostMatch[1] : '';
      if (host !== 'github.com') {
        return null;
      }
      const m = url.match(/github\.com[:/]([^\s]+?)(?:\.git)?$/);
      if (m === null || m[1] === undefined) {
        return null;
      }
      repo = m[1];
      return repo;
    } catch {
      // no remote — no link; never spawn gh on the fast path
      return null;
    }
  };
  const beadLink = (r: TaskRow, slug: string): string | undefined => {
    const prMatch = /^drive:pr:(\d+)$/.exec(r.external_ref ?? '');
    if (prMatch !== null) {
      return prLink(slug, Number(prMatch[1]));
    }
    if (r.metadata === null || r.metadata === undefined) {
      return undefined;
    }
    const meta = r.metadata as Record<string, unknown>;
    const pr = meta.pr ?? meta.pull_request ?? meta.github_pr;
    if (typeof pr === 'number') {
      return prLink(slug, pr);
    }
    const issue = meta.issue ?? meta.github_issue;
    if (typeof issue === 'number') {
      return issueLink(slug, issue);
    }
    return undefined;
  };
  const pick = (r: TaskRow): BeadRow => {
    const row: BeadRow = { id: r.id, title: r.title ?? '' };
    if (typeof r.priority === 'number') {
      row.priority = r.priority;
    }
    if (typeof r.issue_type === 'string') {
      row.issue_type = r.issue_type;
    }
    if (typeof r.assignee === 'string') {
      row.assignee = r.assignee;
    }
    // Surface a clickable PR/issue reference when the bead carries one —
    // drive fixer beads use external_ref `drive:pr:<N>`; metadata may
    // also name a pr/issue. Links are precomputed here so self-contained
    // adapters (pi/omp) can render them without importing @broject/core.
    const slug = repoSlug();
    if (slug !== null) {
      const link = beadLink(r, slug);
      if (link !== undefined) {
        row.link = link;
      }
    }
    return row;
  };
  // each leg degrades on its own — a dead backend or a failed read is
  // an empty section, never a broken board
  const read = (fn: () => TaskRow[]): BeadRow[] => {
    try {
      return fn().map(pick);
    } catch {
      return [];
    }
  };
  const readyRows = read(() => store.ready());
  return {
    inProgress: read(() => store.list({ status: 'in_progress' })),
    ready: readyRows.slice(0, READY_CAP),
    readyTotal: readyRows.length,
  };
}

/** Cap on per-tree `git status` probes — a rig parking dozens of
 *  siblings must not pay N subprocesses per board tick. Claimed
 *  trees, main, and cwd probe first (the live-work rows); beyond the
 *  cap the rest list name/branch/claim only. */
const STATE_PROBE_CAP = 16;

/** Every checkout `git worktree list` names — one porcelain read plus
 *  a marker file read per tree for the claim. The per-tree dirty
 *  count (a `status --porcelain` each — what `bro work list` pays) is
 *  probed only where the board needs it: claimed live work, the main
 *  checkout, and cwd — cwd reuses the header's own dirty count, free.
 *  A failed list is an empty array, never an error. */
function readWorktrees(dir: string, dirty: number): StatusWorktree[] {
  const res = gitTry(['-C', dir, 'worktree', 'list', '--porcelain']);
  if (res.code !== 0) {
    return [];
  }
  // git canonicalizes the paths it registers — compare realpaths so a
  // symlinked tmpdir/cwd still matches its own row
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const here = real(dir);
  let probes = 0;
  return parseWorktreePorcelain(res.out).map((w, i) => {
    const row: StatusWorktree = { name: basename(w.path), path: w.path };
    if (i === 0) {
      row.main = true;
    }
    if (w.branch !== undefined) {
      row.branch = w.branch;
    }
    const claim = worktreeClaim(w.path);
    if (claim !== undefined) {
      row.claim = claim;
    }
    if (real(w.path) === here) {
      row.here = true;
    }
    // LOCKED/PRUNABLE/gone come free with the porcelain metadata;
    // clean|dirty(n) costs a subprocess — spend it on live work only
    if (w.locked !== undefined) {
      row.state = 'LOCKED';
    } else if (w.prunable) {
      row.state = 'PRUNABLE';
    } else if (!existsSync(w.path)) {
      row.state = 'gone';
    } else if (row.here === true) {
      row.state = dirty === 0 ? 'clean' : `dirty(${dirty})`;
    } else if ((claim !== undefined || row.main === true) && probes < STATE_PROBE_CAP) {
      probes++;
      row.state = stateOfWorktree(w);
    }
    return row;
  });
}

function readFleet(dir: string): BroStatus['fleet'] {
  const cfg = loadBroConfig(dir);
  const max = cfg.fleet?.maxConcurrent;
  const agents = Object.entries(readAgentRegistry(dir)).map(([id, e]) => {
    const a: StatusAgent = {
      id,
      backend: e.backend,
      state: agentState(e),
    };
    if (typeof e.agentId === 'string') {
      a.agentId = e.agentId;
    }
    if (typeof e.log === 'string') {
      a.log = e.log;
    }
    if (typeof e.step === 'string') {
      a.step = e.step;
    }
    if (typeof e.cause === 'string') {
      a.cause = e.cause;
    }
    if (typeof e.pid === 'number') {
      a.pid = e.pid;
    }
    if (typeof e.worktree === 'string') {
      a.worktree = basename(e.worktree);
    }
    if (typeof e.provider === 'string') {
      a.provider = e.provider;
    }
    if (typeof e.model === 'string') {
      a.model = e.model;
    }
    return a;
  });
  return {
    maxConcurrent: typeof max === 'number' ? max : 0,
    agents,
  };
}

/** Loop-agent run records — same contract as the board's other sections:
 *  a failed or empty read is an empty array, never an error. */
function readLoop(dir: string): BroStatus['loop'] {
  try {
    const cfg = loadBroConfig(dir) as Record<string, unknown>;
    return { stallMin: loopSection(cfg.loop).stallMin, runs: collectLoopRuns(dir) };
  } catch {
    return { stallMin: 0, runs: [] };
  }
}

/** The worktree's build stamp — attribution for shared mutable
 *  outputs. One file read, no network, fail-open like every board
 *  section. */
function readBuild(dir: string): BroStatus['build'] {
  const stamp = readStamp(dir);
  if (stamp === null) {
    return null;
  }
  const head = gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const me = stampSession(dir, process.env);
  return {
    session: stamp.session,
    via: stamp.via,
    ts: stamp.ts,
    behind: stamp.head !== '' && head.code === 0 && stamp.head !== head.out.trim(),
    mine: me === undefined ? null : me === stamp.session,
  };
}

/** The act gate for the current branch's PR — null when no open PR
 *  resolves or gh can't answer; the board must not die on a network
 *  tick. */
async function readAct(dir: string): Promise<BroStatus['act']> {
  try {
    const rev = reviewHost(undefined, loadBroConfig(dir).connectors);
    const repo = rev.resolveRepo([]);
    const pr = rev.currentPr();
    if (pr?.state !== 'OPEN') {
      return null;
    }
    const act = loadBroConfig(dir).act;
    const state = await fetchPrActState(
      rev,
      { repo, pr: pr.pr },
      {
        ignoreChecks: act.ignoreChecks,
        maxRounds: act.maxRounds,
        docsPaths: act.docsPaths,
        docsMaxRounds: act.docsMaxRounds,
        requireApproval: act.requireApproval,
        approvers: act.approvers,
        stateCache: prStateCache(dir),
        resolveLedger: resolveLedger(dir),
      }
    );
    const gate = evaluateExitGate(state, { requireApproval: act.requireApproval });
    // ownership marker — advisory read, a failure degrades the marker,
    // never the section
    let ownership: 'managed' | 'review' | 'human' | undefined;
    try {
      ownership = prOwnership(rev.labels({ repo, pr: pr.pr }));
    } catch {
      /* unprobed — the row renders without it */
    }
    return {
      pr: state.pr,
      url: state.url,
      gate: gate.ok ? 'GREEN' : 'BLOCKED',
      openThreads: state.openThreads,
      reopenedThreads: state.reopenedThreads?.length ?? 0,
      ciPending: state.ciPending,
      ciFailing: state.ciFailing,
      reviewersPending: state.reviewersPending,
      sastPending: state.sastPending,
      blockers: gate.blockers,
      ownership,
    };
  } catch {
    return null;
  }
}

export function collectStatus(dir: string): BroStatus {
  const branch = gitTry(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || 'HEAD';
  const dirtyOut = gitTry(['-C', dir, 'status', '--porcelain']).out;
  const dirty = dirtyOut === '' ? 0 : dirtyOut.split('\n').filter(l => l !== '').length;
  // currentFrame() → bdJson → spawnSync('bd') throws ENOENT where bd
  // isn't installed — the board's contract is empty sections, never
  // errors, so a missing/failed drill read is a null frame
  let frame: ReturnType<typeof currentFrame>;
  try {
    frame = currentFrame();
  } catch {
    frame = undefined;
  }
  return {
    dir,
    branch,
    dirty,
    worktrees: readWorktrees(dir, dirty),
    beads: readBeads(dir),
    fleet: readFleet(dir),
    loop: readLoop(dir),
    drill: {
      frame: frame === undefined ? null : { id: frame.id, title: frame.title, depth: frame.depth },
    },
    watch: readHeartbeat(dir),
    build: readBuild(dir),
    sync: gitUpstreamBehind(dir),
  };
}

/** The claim fragment — `claim:<slug>`, the same vocabulary
 *  `bro work list` renders, so consumers parse one format. */
function claimBit(claim: string): string {
  return claim === '' ? 'claimed' : `claim:${claim}`;
}

function worktreeLine(w: StatusWorktree): string {
  const glyph = w.claim !== undefined ? '◐' : '·';
  const bits = [
    w.branch ?? 'detached',
    w.state ?? '',
    w.claim === undefined ? '' : claimBit(w.claim),
    w.here === true ? '← here' : '',
  ].filter(b => b !== '');
  return `  ${glyph} ${w.name}  ${bits.join('  ')}`;
}

/** The linked-worktree block — the main checkout is already the
 *  `board:` header (JSON carries every row). Rows print only for
 *  live work: claimed trees plus the board's own checkout; parked
 *  litter reads as the count, `bro work list` is the drill-down. */
function worktreeSection(s: BroStatus): string[] {
  const linked = s.worktrees.filter(w => w.main !== true);
  if (linked.length === 0) {
    return [];
  }
  const claimed = linked.filter(w => w.claim !== undefined).length;
  const head = `worktrees: ${linked.length} linked`;
  const lines = [claimed > 0 ? `${head}, ${claimed} claimed` : head];
  for (const w of linked) {
    if (w.claim !== undefined || w.here === true) {
      lines.push(worktreeLine(w));
    }
  }
  return lines;
}

function agentLine(a: StatusAgent): string {
  const extra = [a.step, a.cause].filter((x): x is string => x !== undefined).join(' · ');
  const glyph = a.state === 'running' ? '▶' : '·';
  const suffix = extra === '' ? '' : `  ${extra}`;
  return `  ${glyph} ${a.id}  ${a.backend}  ${a.state}${suffix}`;
}

/** One loop run record — silence past loop.stallMin is flagged as an
 *  inspect hint for the orchestrator, never a verdict bro acts on. */
function loopLine(r: LoopRunView, stallMin: number): string {
  if (r.state === 'dead') {
    return `  · loop ${r.beadId}  pid ${r.pid ?? '?'} gone — crashed run's record`;
  }
  const silentMin = r.silentMs === null ? null : Math.max(0, Math.floor(r.silentMs / 60_000));
  const stale =
    silentMin !== null && stallMin > 0 && silentMin >= stallMin ? ' — silent, inspect?' : '';
  return `  ▶ loop ${r.beadId}  pid ${r.pid ?? '?'}  silent ${silentMin ?? '?'}m${stale}`;
}

function actLine(act: NonNullable<BroStatus['act']> | null): string {
  if (act === null) {
    return 'act: no open PR for this branch';
  }
  const blockers = act.blockers.length > 0 ? ` — ${act.blockers.join('; ')}` : '';
  const suffix = act.ownership === undefined ? '' : ` · ${prOwnershipMark(act.ownership)}`;
  return `act: [#${act.pr}](${act.url}) ${act.gate}${blockers}${suffix}`;
}

function buildLine(build: NonNullable<BroStatus['build']>): string {
  const flags = [
    build.behind ? 'behind HEAD' : '',
    build.mine === false ? 'another session wrote it' : '',
  ].filter(f => f !== '');
  return (
    `build: ${build.via} by ${build.session} ${stampAgo(build.ts, Date.now())}` +
    (flags.length > 0 ? ` — ${flags.join(', ')}` : '')
  );
}

function render(s: BroStatus): string[] {
  const lines: string[] = [];
  const dirtyBit = s.dirty > 0 ? ` · dirty ${s.dirty}` : '';
  lines.push(`board: ${basename(s.dir)} · ${s.branch}${dirtyBit}`);
  if (s.sync !== null) {
    lines.push(
      `sync: ${s.branch} ${s.sync.behind} behind ${s.sync.upstream} — stale; fetch before trusting state`
    );
  }
  if (s.watch !== null) {
    const tail = s.watch.attention === 0 ? 'quiet' : `${s.watch.attention} attention`;
    lines.push(`watch: heartbeat ${heartbeatAge(s.watch.ageMs)} ago — ${tail}`);
  }
  if (s.drill.frame) {
    lines.push(
      `drill: ${s.drill.frame.id} — ${s.drill.frame.title} (depth ${s.drill.frame.depth})`
    );
  }
  if (s.build !== null) {
    lines.push(buildLine(s.build));
  }
  const beads = s.beads.inProgress;
  if (beads.length > 0) {
    lines.push(`beads: ${beads.length} in progress`);
    for (const b of beads) {
      lines.push(`  ◐ ${b.id}  ${b.title}`);
    }
  }
  lines.push(`ready: ${s.beads.readyTotal} bead(s)`);
  lines.push(...worktreeSection(s));
  const cap = s.fleet.maxConcurrent > 0 ? `/${s.fleet.maxConcurrent}` : '';
  const live = s.fleet.agents.filter(a => a.state === 'running');
  lines.push(`fleet: ${live.length}${cap} running`);
  lines.push(...s.fleet.agents.map(agentLine));
  for (const r of s.loop.runs) {
    lines.push(loopLine(r, s.loop.stallMin));
  }
  if (s.act !== undefined) {
    lines.push(actLine(s.act));
  }
  return lines;
}

export async function runStatusCommand(argv: string[]): Promise<void> {
  const json = argv.includes('--json');
  const deep = argv.includes('--deep');
  const dir = process.cwd();
  const s = collectStatus(dir);
  if (deep) {
    s.act = await readAct(dir);
  }
  if (json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  for (const line of render(s)) {
    console.log(line);
  }
}
