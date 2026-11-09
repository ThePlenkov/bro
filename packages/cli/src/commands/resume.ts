/**
 * `bro fleet resume` — the post-restart recovery pass (spec:
 * specs/bro-5houx.md). A restart kills processes and keeps promises:
 * claims, worktrees, the agent registry, daemon.json, watch markers,
 * and loop.lock survive — watchers, the daemon, the loop, and exec
 * shells do not. Recovery used to be a manual runbook (lesson
 * learn-post-reboot-bro-recovery); resume is that runbook as one pass:
 *
 *   sweep → watch → daemon → loop → agents → worktrees
 *
 * What it restores it restores because durable state recorded the
 * intent (a dead watch marker, an armed daemon.json); what has no
 * recorded intent it only reports — `bro flow loop` claims the
 * backlog and is a run-level decision, never auto-spawned. An armed
 * loop.json is recorded intent too: its `daemon run --loop` supervisor
 * revives on the same contract as the drive daemon's.
 * Orchestrator-only like `fleet daemon up`: a worker never arms
 * supervisors.
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  gitCommonDir,
  gitTry,
  janitorDidWork,
  janitorLine,
  lockHolderPid,
  pidAlive,
  hasHelpFlag,
  printUsage,
  readAgentRegistry,
  runJanitor,
} from '@broject/core';
import { deadWatchPlan } from '@broject/act';
import { rearmPass } from './act.ts';
import { loadAgentEnv } from '../agent-connectors.ts';
import { collectAgentBackends } from './agents.ts';
import {
  daemonProbe,
  driveRearm,
  loopProbe,
  loopRearm,
  supervisorUp,
  type DriveRearm,
  type SupervisorUp,
} from './daemon.ts';
import { collectLoopRuns, reapLoopRuns, type LoopRunView } from './loop-state.ts';
import { isOrchestratorSession } from './watch-pulse.ts';
import { mainWorktree, parseWorktreePorcelain } from './work.ts';

interface WatchReport {
  rearmed: Array<{ pr: number; pid: number }>;
  settled: Array<{ pr: number; bead?: string }>;
  kept: Array<{ pr: number; reason: string }>;
  link: (pr: number) => string;
}

interface LoopReport {
  /** loop.lock holder — null pid means no holder (or no lock file) */
  holder: { pid: number | null; alive: boolean };
  deadRuns: LoopRunView[];
}

interface AgentsReport {
  dead: Array<{ id: string; state: string }>;
  degraded: string[];
}

/** One supervisor kind's resume verdict — a repo can install drive and
 *  loop side by side, and each marker's rearm decides on its own
 *  liveness plane (drive.lock / loop.lock), never the sibling's. */
interface DaemonLegResult {
  sup: 'drive' | 'loop';
  kind: 'live' | 'unarmed' | 'respawned' | 'would-respawn';
  pid?: number;
  everySec?: number;
}

interface ResumeReport {
  dryRun: boolean;
  sweep: { line: string; didWork: boolean } | null;
  watch: WatchReport;
  /** The drive leg under its pre-loop field name — `--json` readers'
   *  `daemon.kind`/`daemon.pid`/`daemon.everySec` keep working. */
  daemon: DaemonLegResult;
  /** Every supervisor leg — drive and loop on their own planes. */
  daemons: DaemonLegResult[];
  loop: LoopReport;
  agents: AgentsReport;
  worktrees: Array<{ path: string; branch?: string; dirty: number }>;
}

/** `bro/loop.lock` holder liveness — the `bro flow loop` supervisor
 *  holds this lock for the run's duration; a dead holder is the loop
 *  that died mid-run. Null pid: no holder (file absent or unlocked). */
function loopHolder(main: string): { pid: number | null; alive: boolean } {
  const common = gitCommonDir(main);
  if (common === null) {
    return { pid: null, alive: false };
  }
  const lock = join(common, 'bro', 'loop.lock');
  if (!existsSync(lock)) {
    return { pid: null, alive: false };
  }
  const pid = lockHolderPid(lock);
  return { pid, alive: pid !== null && pidAlive(pid) };
}

/** Sibling worktrees carrying uncommitted work — a restart strands
 *  agent edits in linked trees (the runbook's loop/* audit). The main
 *  checkout's own dirt is the operator's business, never "stranded". */
function dirtyWorktrees(main: string): ResumeReport['worktrees'] {
  const r = gitTry(['-C', main, 'worktree', 'list', '--porcelain']);
  if (r.code !== 0) {
    return [];
  }
  const out: ResumeReport['worktrees'] = [];
  for (const wt of parseWorktreePorcelain(r.out)) {
    if (wt.path === main || wt.bare || wt.prunable !== undefined || !existsSync(wt.path)) {
      continue;
    }
    const s = gitTry(['-C', wt.path, 'status', '--porcelain']);
    if (s.code !== 0) {
      continue;
    }
    const dirty = s.out.split('\n').filter(l => l.trim() !== '').length;
    if (dirty > 0) {
      out.push({ path: wt.path, branch: wt.branch, dirty });
    }
  }
  return out;
}

async function resumePass(main: string, dry: boolean): Promise<ResumeReport> {
  // read the loop supervisor's hold BEFORE the sweep — a dead holder's
  // stale lock is the janitor's to reap, but "supervisor dead" is a
  // better report than "reaped 1 file(s)"
  const holder = loopHolder(main);

  // 1 — sweep: dead session residue. runJanitor's own dryRun reports
  // the same counts without unlinking, so the plan is real either way
  const jan = runJanitor(main, { dryRun: dry });
  const sweep = jan === null ? null : { line: janitorLine(jan), didWork: janitorDidWork(jan) };

  // 2 — watch: every dead marker's PR respawns a detached wait. No
  // dead markers → skip the host resolution entirely (the common case
  // stays offline-cheap)
  const watch: WatchReport =
    deadWatchPlan(main).length === 0
      ? { rearmed: [], settled: [], kept: [], link: pr => `#${pr}` }
      : await rearmPass(main, dry);

  // 3 — daemon: the session-checkpoint decision, extracted
  const daemons = daemonLeg(main, dry);

  // 4 — loop: dead supervisor + dead run records are a report, not a
  // respawn — claiming the backlog is the operator's call
  const deadRuns = collectLoopRuns(main).filter(r => r.state === 'dead');
  if (!dry && deadRuns.length > 0) {
    reapLoopRuns(main);
  }

  // 5 — agents + 6 — worktrees
  const agents = await agentsLeg(main);
  const worktrees = dirtyWorktrees(main);

  return {
    dryRun: dry,
    sweep,
    watch,
    // `daemon` keeps the pre-loop shape: the drive leg, first by
    // construction in daemonLeg
    daemon: daemons[0]!,
    daemons,
    loop: { holder, deadRuns },
    agents,
    worktrees,
  };
}

/** The daemon legs — the same decision a session checkpoint runs, once
 *  per supervisor kind: `drive.json`/`loop.json` are the durable
 *  want-markers (armed by `drive|loop install`; `daemon*.json` only the
 *  transient spawn records), a dead supervisor with a marker respawns
 *  via `supervisorUp` under `daemon.up.lock` with the marker re-checked
 *  inside. Each kind decides on its own liveness plane — a live drive
 *  must not mask a dead loop when a repo installs both. */
interface DaemonKind {
  sup: 'drive' | 'loop';
  probe: (dir: string) => { live: boolean; pid?: number };
  rearm: (dir: string, env?: NodeJS.ProcessEnv) => DriveRearm;
  up: (everySec: number) => SupervisorUp;
}

function daemonLegKind(main: string, dry: boolean, k: DaemonKind): DaemonLegResult {
  const probe = k.probe(main);
  if (probe.live) {
    return { sup: k.sup, kind: 'live', pid: probe.pid! };
  }
  const rearm = k.rearm(main);
  if (rearm.kind === 'quiet') {
    return { sup: k.sup, kind: 'unarmed' };
  }
  if (dry) {
    return { sup: k.sup, kind: 'would-respawn', everySec: rearm.everySec };
  }
  const up = k.up(rearm.everySec);
  if (up.kind === 'spawned') {
    return { sup: k.sup, kind: 'respawned', pid: up.pid, everySec: rearm.everySec };
  }
  if (up.kind === 'already') {
    return { sup: k.sup, kind: 'live', pid: up.pid };
  }
  // disarmed mid-pass (a racing uninstall revoked the intent) or a
  // worker-env leak past the guard — a report, not a failure
  return { sup: k.sup, kind: 'unarmed' };
}

function daemonLeg(main: string, dry: boolean): ResumeReport['daemons'] {
  return [
    daemonLegKind(main, dry, {
      sup: 'drive',
      probe: daemonProbe,
      rearm: driveRearm,
      up: everySec => supervisorUp(main, everySec, process.env, { requireMarker: true }),
    }),
    daemonLegKind(main, dry, {
      sup: 'loop',
      probe: loopProbe,
      rearm: loopRearm,
      up: everySec =>
        supervisorUp(main, everySec, process.env, { requireMarker: true, loop: true }),
    }),
  ];
}

/** The agents leg — dead pids read as lost/exited; degraded backends
 *  are reports too, never counted. A degraded backend with NO registry
 *  entries names state that probably never existed — suppressing it
 *  keeps the report honest instead of ambient-noise. */
async function agentsLeg(main: string): Promise<AgentsReport> {
  const { backends } = await collectAgentBackends(main, loadAgentEnv(main));
  const regBackends = new Set(Object.values(readAgentRegistry(main)).map(e => e.backend));
  const agents: AgentsReport = { dead: [], degraded: [] };
  for (const b of backends) {
    if (b.degraded !== undefined && regBackends.has(b.conn.name)) {
      agents.degraded.push(`${b.conn.name}: ${b.degraded}`);
    }
    for (const a of b.agents) {
      if (a.state === 'lost' || a.state === 'exited') {
        agents.dead.push({ id: a.molStep || a.id, state: a.state });
      }
    }
  }
  return agents;
}

function watchLines(w: WatchReport, dry: boolean): string[] {
  const lines: string[] = [];
  for (const r of w.rearmed) {
    lines.push(
      `resume: watch ${w.link(r.pr)} — ` +
        (dry ? 'would respawn a watcher' : `watcher up (pid ${r.pid})`)
    );
  }
  for (const s of w.settled) {
    lines.push(`resume: watch ${w.link(s.pr)} — settled — marker swept`);
  }
  for (const k of w.kept) {
    lines.push(`resume: watch ${w.link(k.pr)} — kept — ${k.reason}`);
  }
  return lines;
}

function daemonLine(d: DaemonLegResult): string | null {
  const sup = d.sup === 'loop' ? 'loop ' : '';
  switch (d.kind) {
    case 'live':
      return `resume: daemon — ${sup}already supervising (pid ${d.pid})`;
    case 'unarmed':
      return null;
    case 'would-respawn':
      return `resume: daemon — ${sup}would revive (every ${d.everySec}s)`;
    case 'respawned':
      return `resume: daemon — ${sup}revived (pid ${d.pid}, every ${d.everySec}s)`;
  }
}

function loopLine(l: LoopReport, sup: DaemonLegResult | undefined, dry: boolean): string | null {
  // the daemon leg already reports a live or freshly revived loop
  // supervisor — the pre-revival holder snapshot must not contradict it
  // with a stale "supervisor dead" and a restart hint
  const covered = sup !== undefined && sup.kind !== 'unarmed';
  const dead = !covered && l.holder.pid !== null && !l.holder.alive;
  if (!dead && l.deadRuns.length === 0) {
    return null;
  }
  const bits: string[] = [];
  if (dead) {
    bits.push(`supervisor dead (was pid ${l.holder.pid})`);
  }
  if (l.deadRuns.length > 0) {
    bits.push(
      `${l.deadRuns.length} dead run record(s)` +
        (dry ? '' : ' reaped') +
        `: ${l.deadRuns.map(r => r.slug).join(', ')}`
    );
  }
  const hint = covered ? '' : ' — restart with `bro flow loop`';
  return `resume: loop — ${bits.join('; ')}${hint}`;
}

function agentsLine(a: AgentsReport): string | null {
  if (a.dead.length === 0 && a.degraded.length === 0) {
    return null;
  }
  const ids = a.dead.map(d => `${d.id}:${d.state}`).join(', ');
  const plural = a.dead.length === 1 ? 'y' : 'ies';
  const dead =
    a.dead.length === 0
      ? 'no dead registry entries'
      : `${a.dead.length} dead registry entr${plural} (${ids}) — \`bro fleet agents prune\` sweeps, \`bro fleet agents up <step>\` respawns`;
  const deg = a.degraded.length === 0 ? '' : `; degraded: ${a.degraded.join('; ')}`;
  return `resume: agents — ${dead}${deg}`;
}

function worktreeLine(ws: ResumeReport['worktrees']): string | null {
  if (ws.length === 0) {
    return null;
  }
  return (
    `resume: worktrees — ${ws.length} dirty tree(s): ` +
    ws.map(w => `${basename(w.path)} (${w.dirty} files)`).join(', ')
  );
}

function reportLines(rep: ResumeReport): string[] {
  const lines: string[] = [];
  // janitorLine already inflects the verb — "janitor: would reap …" in
  // dry-run — the sweep line passes through as-is
  if (rep.sweep?.didWork === true) {
    lines.push(`resume: sweep — ${rep.sweep.line}`);
  }
  lines.push(...watchLines(rep.watch, rep.dryRun));
  const rest = [
    ...rep.daemons.map(daemonLine),
    loopLine(
      rep.loop,
      rep.daemons.find(d => d.sup === 'loop'),
      rep.dryRun
    ),
    agentsLine(rep.agents),
    worktreeLine(rep.worktrees),
  ];
  for (const l of rest) {
    if (l !== null) {
      lines.push(l);
    }
  }
  if (lines.length === 0) {
    lines.push('resume: nothing to resume — every recorded process is alive');
  }
  return lines;
}

export async function runResumeCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(
      'Usage: bro fleet resume [--dry-run] [--json]\n' +
        '  Post-restart recovery: rearm dead watches, revive a recorded-but-dead\n' +
        '  daemon, and audit survivors — dead loop/lock/run records, dead agent\n' +
        '  registry entries, dirty worktrees. Never restarts `bro flow loop`.\n' +
        '  --dry-run  print the plan without spawning or sweeping\n' +
        '  --json     machine-readable report',
      0
    );
  }
  const extra = argv.filter(a => a !== '--dry-run' && a !== '--json');
  if (extra.length > 0) {
    console.error(`error: bro fleet resume takes no arguments — got "${extra[0]}"`);
    process.exit(2);
  }
  if (!isOrchestratorSession()) {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never resume supervisors; ' +
        'the orchestrator session owns the pass'
    );
    process.exit(2);
  }
  const dry = argv.includes('--dry-run');
  const rep = await resumePass(mainWorktree().path, dry);
  if (argv.includes('--json')) {
    const { watch, ...rest } = rep;
    const { link: _link, ...watchData } = watch;
    console.log(JSON.stringify({ ...rest, watch: watchData }, null, 2));
    return;
  }
  for (const line of reportLines(rep)) {
    console.log(line);
  }
}
