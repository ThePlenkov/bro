/**
 * `bro drive` — the post-PR review driver: the write-side counterpart of
 * `bro watch`'s gates plane. Spec: specs/sessions/bro-f4ot/bro-tui8.md.
 *
 *   bro drive [--once]        one supervision pass over open PRs (default)
 *   bro drive --every N       a pass every N seconds — cadence owned by
 *                             the deployment, same contract as bro watch
 *   bro drive --no-merge      supervise only — never merge
 *   bro drive --connector <name>  spawn fixers on one backend
 *   bro drive --json          one JSON line per PR verdict
 *   bro drive install [--every N] [--print]   arm the merge path —
 *        writes <git-common>/bro/drive.json and brings the supervisor
 *        up now; session checkpoints rearm it when it dies (bro-y5zon)
 *   bro drive uninstall       disarm the marker + stop the supervisor
 *
 * NOTE — a `--once` pass with an armed wall freezes native workers on
 *   the walled provider and then EXITS: nothing else reconciles
 *   lane-pause.json in that setup, so the groups stay SIGSTOPped until
 *   the next pass. Recovery after the wall's reset: run `bro drive`
 *   once (or arm `bro drive install` so a supervisor owns the thaw).
 *   Deleting the pause file by hand does NOT resume the groups — it
 *   only forgets who is frozen; the reconcile pass is what SIGCONTs
 *   what the wall no longer covers.
 *
 * Each pass enumerates open PRs on fleet branches (every worktree's
 * branch + local work/,loop/,stack/ branches — a `bro work leave`
 * orphans the PR, not the branch), probes the act exit gate, and:
 *
 *   threads>0, occupied    → skip — a live session owns the worktree
 *   threads>0, orphaned    → spawn/respawn the PR's fixer agent on its
 *                            fixer bead (facade dedup + respawn semantics)
 *   CONFLICTING, orphaned  → the same fixer spawn with a rebase work
 *                            order — an orphaned conflicted PR stalls
 *                            forever without one (bro-glkes)
 *   ci-fail/SAST, orphaned → the same fixer spawn with a class work
 *                            order (run log / annotations) — a settled
 *                            blocker is a remediation start, not a
 *                            terminal 'blocked' (bro-atb2g)
 *   green, occupied        → report; the owner's merge step lands it
 *   green, stale-occupied  → the owner's occupancy shows no proven
 *                            activity inside drive.occupancyTtlSec
 *                            (2h) — adopted as an orphan and merged
 *                            (bro-ihnlv); occupancy may hold a green
 *                            PR back, never forever
 *   green, orphaned        → bro act merge (unless --no-merge /
 *                            drive.merge:'never'), then retire the
 *                            worktree and close the fixer bead
 *   PR settled             → close a dangling fixer bead
 *
 * Occupancy is the guard bro-pywx hardens: never spawn into a worktree
 * a live session works in. Planes: the agents facade, a live foreign
 * watch marker on the PR (a `bro loop` heartbeat, `act wait`, convoy —
 * bro-0aa87's mutual exclusion: the gate already has a supervisor),
 * the worktree's own claim marker, fresh .work markers, and a /proc cwd
 * scan that follows a process's ancestry to an agent-shaped root —
 * occupied is always the safe verdict (a skipped pass, never
 * double-work). Every proof carries an activity stamp (log mtime,
 * heartbeat, marker stamp, worktree churn); the merge path is the only
 * one that ages them — a stale occupant is adopted, not obeyed.
 *
 * One drive per repo: `bro/drive.lock` in the git common dir is held
 * heartbeated for the process lifetime — a second `bro drive` (a
 * respawn wrapper's duplicate) stands by behind the incumbent and
 * takes over when it exits, never runs concurrently (spec bro-2duu9).
 *
 * The lifecycle FSM itself lives in `@broject/rig` as `drivePolicy`
 * (bro-u6fp5.2): this file is the command adapter — argv parsing,
 * config, the deps wiring (`driveDeps`), output routing, and the
 * process/signal/lock shell around `drivePolicy.run`.
 */
import { spawn } from 'node:child_process';
import { type FSWatcher, watch } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import {
  awaitFileLock,
  busSocketPath,
  busSubscribe,
  checkBeads,
  type ClaimFacade,
  type ClaimRow,
  ensureAuth,
  facade,
  facadeName,
  gitCommonDir,
  gitTry,
  holdRoleLease,
  localLeaseStore,
  projectId,
  reviewHost,
  sessionProject,
  type BusSubscription,
  type IgnoreCheckRule,
  type ReviewFacade,
  type ReviewThread,
  type TaskStore,
  hasHelpFlag,
  printUsage,
  type ExitCode,
} from '@broject/core';
import { ACT_STATE_TTL_MS, prStateCache, type PrActState, type PrStateCache } from '@broject/act';
import { annotateThreads, judgeConfig, judgeFacade } from '@broject/judge';
import {
  drivePolicy,
  freshDrivePass,
  hooksDirOf,
  type DriveDeps,
  type DrivePass,
} from '@broject/rig';
import {
  loadAgentEnv,
  resolveAgentConnector,
  settleAcpSessions,
  type AgentConnectorEnv,
} from '../agent-connectors.ts';
import { reconcileLanePause } from '../lane.ts';
import { flag } from './args.ts';
import { defaultBranch, runActCommand } from './act.ts';
import { emitDevinUsage } from '@broject/devin';
import {
  foreignPushEvent,
  readHeadMemory,
  sessionArmedPrs,
  writeHeadMemory,
} from './foreign-push.ts';
import { spawnStepAgent } from './agents.ts';
import { collectAgents } from './fleet.ts';
import { pluginLedgerDirs, projectFleet } from './herdr-projector.ts';
import {
  driveSection,
  MAX_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  type DriveConfig,
} from './drive-config.ts';
import { loadBroConfig } from '../plugins.ts';
import {
  deleteMergedLocalBranch,
  mainWorktree,
  parseWorktreePorcelain,
  reapLoopLitter,
  removeMergedWorktree,
  type LitterReap,
} from './work.ts';
import { type LoopConfig } from '@broject/loop';
import { installDrive, uninstallDrive } from './daemon.ts';
import { pipelineWakePass } from './pipeline.ts';
import { SELF_ENTRY } from './self-entry.ts';
import { isOrchestratorSession } from './watch-pulse.ts';
export { LIVE_MARKER_MS, worktreeClaim, worktreeClaimInfo, worktreeIdleMs } from './work.ts';
function usage(exitCode: ExitCode = 2): never {
  printUsage(
    'Usage: bro drive [--once] [--every [SEC]] [--no-merge] [--connector <name>] [--json]\n' +
      '       bro drive install [--every N] [--print]\n' +
      '       bro drive uninstall',
    exitCode
  );
}

// --- args ------------------------------------------------------------------------

export interface DriveArgs {
  everySec?: number;
  merge: boolean;
  json: boolean;
  connector?: string;
}

export function driveArgs(argv: string[], defaultEverySec = 300): DriveArgs {
  const base: DriveArgs = {
    json: argv.includes('--json'),
    merge: !argv.includes('--no-merge'),
    connector: flag(argv, '--connector'),
  };
  const every = argv.filter(a => a === '--every' || a.startsWith('--every='));
  if (every.length > 1) {
    console.error('error: --every may be given only once');
    process.exit(2);
  }
  if (every.length === 0) {
    return base;
  }
  const tok = every[0]!;
  let everyRaw: string | undefined;
  if (tok === '--every') {
    // a bare --every takes the configured cadence — flagValue's contract
    // (next token must not look like an option) still applies when a
    // value follows
    const next = argv[argv.indexOf(tok) + 1];
    everyRaw =
      next !== undefined && next.trim() !== '' && !next.startsWith('--') ? next : undefined;
  } else {
    everyRaw = tok.slice('--every='.length);
    if (everyRaw === '') {
      console.error('error: --every requires a value');
      process.exit(2);
    }
  }
  const everySec = everyRaw === undefined ? defaultEverySec : Number(everyRaw);
  // the same 0.1s floor fleet applies — a sub-floor cadence is a busy
  // loop hammering the review host, not a poll
  if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
    throw new Error(
      `--every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw ?? defaultEverySec}"`
    );
  }
  return { ...base, everySec };
}

// --- candidate set ----------------------------------------------------------------

/** Branch prefixes a PR can outlive its worktree on — `bro work leave`
 *  drops the tree, not the branch. */
export const FLEET_BRANCH_PREFIXES = ['work/', 'loop/', 'stack/'];

/** Every branch that can hold an orphaned PR: each worktree's branch
 *  plus local AND remote-tracking fleet-prefixed branches. `complete`
 *  is false when any git listing failed — a partial set is
 *  under-counted, not drained. */
export function candidateBranches(root: string): { branches: string[]; complete: boolean } {
  const wt = worktreeBranches(root);
  const fleet = fleetPrefixed(root);
  const branches = new Set([...(wt ?? []), ...fleet.branches]);
  return { branches: [...branches], complete: wt !== null && fleet.complete };
}

/** `git worktree list` branch names, or null on git failure — the
 *  caller's `complete` flag degrades while the set keeps what it has. */
function worktreeBranches(root: string): string[] | null {
  const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain']);
  return wt.code === 0
    ? parseWorktreePorcelain(wt.out).flatMap(w => (w.branch ? [w.branch] : []))
    : null;
}

/** Local + remote-tracking fleet-prefixed branches. Remote rows carry
 *  the `origin/` prefix, stripped so a remote-only head dedups against
 *  its local name (a merged-bead cleanup reaps the local branch while
 *  the remote head — and its still-open PR — survives; bro-njyn8). */
function fleetPrefixed(root: string): { branches: string[]; complete: boolean } {
  const branches: string[] = [];
  let complete = true;
  for (const prefix of FLEET_BRANCH_PREFIXES) {
    for (const remote of [false, true]) {
      const rows = fleetBranches(root, prefix, remote);
      if (rows === null) {
        complete = false;
      } else {
        branches.push(...rows);
      }
    }
  }
  return { branches, complete };
}

/** One `git branch --list` row set for a fleet prefix, or null on git
 *  failure — the caller's `complete` flag degrades while the set keeps
 *  what it has. */
function fleetBranches(root: string, prefix: string, remote: boolean): string[] | null {
  const args = remote
    ? ['-C', root, 'branch', '-r', '--list', `origin/${prefix}*`, '--format=%(refname:short)']
    : ['-C', root, 'branch', '--list', `${prefix}*`, '--format=%(refname:short)'];
  const res = gitTry(args);
  if (res.code !== 0) {
    return null;
  }
  return res.out
    .split('\n')
    .filter(s => s !== '')
    .map(s => (remote ? s.replace(/^origin\//, '') : s));
}
// --- occupancy --------------------------------------------------------------------

// The marker/registry occupancy plane and the whole occupancy verdict
// ladder moved to @broject/rig with the fleet-lifecycle extraction
// (bro-jamp7) — work.ts's litter sweep needs the same verdicts and
// can't reach drive.ts (drive imports work). Re-exported here so
// existing importers keep working. The pass code itself now lives in
// `drivePolicy` (@broject/rig, bro-u6fp5.2) — this file keeps the
// argv/config/output/process adapter surface.
export {
  agentProcessesIn,
  branchSlug,
  detailMatches,
  ensureFixerWorktree,
  fixerAttemptSpent,
  fixerBeadFor,
  fixerRef,
  FIXER_LABEL,
  freshOccupancy,
  greenOccupancy,
  liveWorkDetails,
  liveWorkEntries,
  occupied,
  occupancyProofs,
  processesRootedIn,
  recordFixerAttempt,
  registryAgents,
  registryEntryState,
  supervisedBy,
  supervisorFresh,
} from '@broject/rig';
export type { OccProof, OccupancyCtx, ProcHit, WorkEntry } from '@broject/rig';

// The occupancy verdict ladder (OccupancyCtx, occupancyProofs,
// occupied, greenOccupancy, supervisorFresh) lives in @broject/rig —
// re-exported here for compat; the drive pass that consumed it is the
// drivePolicy in the same package now.
async function driveShadowNotes(
  dir: string,
  pr: number,
  headSha: string,
  open: ReviewThread[],
  budget: { remaining: number }
): Promise<Map<string, string> | undefined> {
  const cfg = judgeConfig(dir).judge;
  if (cfg.mode !== 'shadow') {
    return undefined;
  }
  try {
    const res = await annotateThreads(open, {
      dir,
      pr,
      headSha,
      judge: judgeFacade(dir),
      // a spent budget still renders journaled verdicts — re-reads
      // are free; only fresh decide() calls are bounded
      budget: Math.max(0, budget.remaining),
    });
    budget.remaining -= res.decided;
    return res.annotations;
  } catch {
    return undefined;
  }
}
// --- the adapter context ---------------------------------------------------------

/** The command's context — the policy's `DriveCtx` fields plus the
 *  adapter-owned instances the dep impls read (env, loop config, the
 *  live facades). `deps` attaches after the literal builds — its
 *  closures read ctx lazily, by call time the object is complete
 *  (same convention as loopDeps). */
interface Ctx {
  deps: DriveDeps;
  mainRoot: string;
  rev: ReviewFacade;
  /** The reviews connector's name — fixer work orders name host-CLI
   *  commands, so the prompt must match the backend actually serving
   *  this repo (gh on github, glab api on gitlab). */
  host: string;
  repo: string;
  /** The shared gate-state feed — every pass reads it so drive's polls
   *  share fetches with loop/watch/act-wait (bro-0tcrl). The post-merge
   *  re-probe stays uncached: a landed verdict must be this fetch's
   *  own. */
  stateCache: PrStateCache | null;
  act: {
    ignoreChecks: IgnoreCheckRule[];
    maxRounds: number;
    docsPaths: string[];
    docsMaxRounds: number;
    requireApproval: boolean;
    approvers: string[];
  };
  merge: boolean;
  json: boolean;
  connector?: string;
  /** Merge-path occupancy TTL in ms (drive.occupancyTtlSec) — the
   *  silence bound that turns a green-occupied PR into an adopted
   *  orphan (bro-ihnlv). */
  occTtlMs: number;
  /** --every interval in seconds — defined only in loop mode, which is
   *  also what turns on watch heartbeats; a --once pass is a report,
   *  not supervision. */
  everySec?: number;
  /** The loop-litter sweep state (bro-7dgu3) — the pass reaps
   *  provably-done worktrees on the `drive.litterSweepSec` cadence so
   *  merges landing without a cleanup caller (GitHub auto-merge, UI
   *  merges) stop stranding trees. `lastAt` throttles across passes;
   *  0 means the first pass sweeps — a --once invocation always does. */
  litter: { sweepSec: number; lastAt: number };
  /** The parked resume-cache bounds — the sweep's pool knobs ride the
   *  loop section, same as the closeout and `work prune --loop` read. */
  loop: LoopConfig;
  env: AgentConnectorEnv;
  store: TaskStore;
  /** The claims facade + this repo's project id — `deps.claims`'s
   *  backing pair (bro-izpyk.10); undefined facade = the ledger is
   *  absent and occupancy reads marker-only. */
  claims?: ClaimFacade;
  project?: string;
  /** The pass's gathered world — rebuilt by the policy's `pass` each
   *  sweep; `freshDrivePass()` seeds the pre-pass empty shape. */
  work: DrivePass;
}
async function publishDriveAlert(
  dir: string,
  pr: number,
  link: string,
  cause: string,
  detail?: string
): Promise<void> {
  try {
    await facade('events', { dir }, { prefer: loadBroConfig(dir).connectors }).publish({
      topic: 'drive',
      kind: 'alert',
      key: `drive-${cause}-${pr}`,
      source: 'drive',
      ref: link,
      payload:
        `drive ${link} ${cause}` + (detail === undefined || detail === '' ? '' : ` — ${detail}`),
    });
  } catch {
    // fail-open
  }
}

/** The foreign-push signal — a PR a live session armed moved under it
 *  (spec bro-cqjd0). The bus REPORTS the move; it does not coordinate:
 *  nothing is blocked, no branch is protected, the session decides. */
async function signalForeignPush(
  ctx: Ctx,
  pr: number,
  link: string,
  head: string | undefined
): Promise<void> {
  if (head === undefined || head === '') {
    return;
  }
  const before = await readHeadMemory(ctx.mainRoot, ctx.repo, pr);
  await writeHeadMemory(ctx.mainRoot, ctx.repo, pr, head);
  if (before === undefined || before === head) {
    // the first sight of a PR is not a change, and a held head is not one
    return;
  }
  const hooks = hooksDirOf(ctx.mainRoot);
  if (hooks === null) {
    return;
  }
  for (const session of sessionArmedPrs(hooks, pr)) {
    try {
      await facade(
        'events',
        { dir: ctx.mainRoot },
        { prefer: loadBroConfig(ctx.mainRoot).connectors }
      ).publish(foreignPushEvent({ pr, link, from: before, to: head, session })); // NOSONAR — an advisory event, never a gate
    } catch {
      // fail-open — a delivery problem never becomes a pass failure
    }
  }
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const say = (ctx: Ctx, msg: string): void => {
  if (ctx.json) {
    console.error(msg);
  } else {
    console.log(msg);
  }
};

/** `bro act merge` reports via process.exitCode — normalize it into a
 *  verdict without leaking the code into the driver's own exit. */
async function mergeGreen(ctx: Ctx, pr: number): Promise<boolean> {
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    await runActCommand(['merge', String(pr)]);
    return process.exitCode === 0;
  } catch (err) {
    console.error(`drive: merge threw — ${errText(err)}`);
    return false;
  } finally {
    process.exitCode = saved;
  }
}

/** Post-merge local retirement — same guards as `act merge --cleanup`:
 *  the worktree only goes when verifiably clean, the branch only when
 *  its tip is the merged head. Never throws into the pass. */
function retireLanding(ctx: Ctx, state: PrActState, worktree: string | undefined): void {
  try {
    const all = parseWorktreePorcelain(gitTry(['worktree', 'list', '--porcelain']).out);
    const main = all[0];
    if (worktree !== undefined && main) {
      const here = all.find(w => w.path === worktree);
      if (here && here.path !== main.path) {
        removeMergedWorktree(worktree, here, main);
      } else if (here && here.branch === state.headRef) {
        // the merged branch is checked out in the MAIN worktree — the
        // delete below can never land while it is, so switch the main
        // checkout to the default branch first (same move as
        // cleanupAfterMerge; a dirty main keeps the branch, never data)
        const def = defaultBranch();
        const res = gitTry(['-C', main.path, 'switch', def]);
        if (res.code !== 0) {
          say(ctx, `drive: could not switch ${main.path} to ${def} (${res.err})`);
        }
      }
    }
    deleteMergedLocalBranch(state.headRef, state.headSha);
  } catch (err) {
    say(ctx, `drive: post-merge cleanup failed — ${errText(err)}`);
  }
}
async function emitLaneUsage(ctx: Ctx): Promise<void> {
  try {
    const bag = loadAgentEnv(ctx.mainRoot).agents['devin'] ?? {};
    // the drive's own env IS the effective worker env: the connector
    // builds the child's environment from it (plus the pins)
    await emitDevinUsage(ctx.mainRoot, bag, process.env);
  } catch {
    // telemetry must not stall the pass
  }
}

/** The wall pause (spec bro-y3jvd) — the pass's periodic reconcile:
 *  freeze live workers on a walled provider, thaw lanes whose wall
 *  lifted. A miss must not stall the pass — the next tick re-asserts. */
function lanePauseTick(ctx: Ctx): void {
  try {
    const r = reconcileLanePause(ctx.mainRoot, loadAgentEnv(ctx.mainRoot));
    if (r.paused > 0 || r.thawed > 0) {
      say(ctx, `lane: ${r.paused} worker(s) paused, ${r.thawed} thawed`);
    }
  } catch {
    // next pass re-asserts
  }
}

/** The pass's litter sweep (spec bro-7dgu3) — isolated in a child
 *  process: reapLoopLitter's rooted scans and per-candidate lookups are
 *  synchronous, so in-pass they'd stall the supervisor's event loop and
 *  could let the drive role lease lapse on a repo with many candidates.
 *  `bro work prune --loop` IS the same sweep — the child carries the
 *  full nx-kill wait budget while this process stays responsive. The
 *  awaited close still lands before the pass's enumeration, so a reaped
 *  branch never reaches openFleetPrs — only the event loop is freed,
 *  not the ordering. */
async function litterSweep(ctx: Ctx): Promise<void> {
  const entry = SELF_ENTRY;
  if (entry === null) {
    // imported by a test harness — no CLI argv to respawn; run in-pass.
    // The child path's claims leg comes via `work prune --loop`; the
    // in-pass tick prefetches the same union leg from the ctx's own
    // facade — marker-only only when the ledger is absent (bro-izpyk.10)
    const claims =
      ctx.claims === undefined
        ? undefined
        : await ctx.claims
            .list(ctx.project === undefined ? {} : { project: ctx.project })
            .catch(() => []);
    sayLitterSweep(ctx, litterSweepTick(ctx, claims));
    return;
  }
  await new Promise<void>(resolvePromise => {
    const child = spawn(process.execPath, [entry, 'work', 'prune', '--loop'], {
      cwd: ctx.mainRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    const done = (warn?: string): void => {
      for (const line of out.split('\n')) {
        const t = line.trim();
        // kept lines are the sweep's noise floor — same policy as
        // sayLitterSweep: relay actions, warnings, and the tally only
        if (t !== '' && !t.startsWith('kept ')) {
          say(ctx, `drive litter: ${t}`);
        }
      }
      if (warn !== undefined) {
        say(ctx, `warning: litter sweep — ${warn}`);
      }
      resolvePromise();
    };
    child.on('error', err => done(errText(err)));
    child.on('close', code => done(code === 0 ? undefined : `exit ${code ?? '?'}`));
  });
}

/** The in-pass sweep primitive — the same reapLoopLitter the loop
 *  closeout and `bro work prune --loop` run: merges landing without a
 *  cleanup caller (GitHub auto-merge, UI merges) strand their worktrees
 *  otherwise, and dead fixers' orphaned nx daemons keep the trees
 *  "occupied" on every /proc plane until the sweep kills them. Only
 *  reached when SELF_ENTRY is unset (test harness) — the supervisor
 *  path sweeps in a child so the scans never touch the event loop. */
function litterSweepTick(ctx: Ctx, sessionClaims?: ClaimRow[]): LitterReap {
  // the sweep's git helpers narrate via console.log — under --json
  // route them to stderr like the loop audit does, or the verdict
  // stream corrupts
  const log = console.log;
  if (ctx.json) {
    console.log = console.error;
  }
  try {
    return reapLoopLitter({
      root: ctx.mainRoot,
      tasks: ctx.store,
      rev: { repo: ctx.repo, facade: ctx.rev },
      // the daemon has no current stack — sweep every stack's members,
      // `work prune --loop`'s own scope
      stackPrefix: 'stack/',
      parkedKeep: ctx.loop.parkedKeep,
      parkedTtlDays: ctx.loop.parkedTtlDays,
      // --every is the supervisor's async loop — the nx-kill wait must
      // never block it (a still-dying daemon pins its tree one extra
      // sweep, which is exactly what the cadence exists for). --once is
      // a foreground pass — the default bound reaps in-pass.
      nxKillWaitMs: ctx.everySec === undefined ? undefined : 0,
      sessionClaims,
    });
  } finally {
    console.log = log;
  }
}

/** The sweep's pass-side reporting — action lines and errors; kept
 *  verdicts are the sweep's noise floor at pass cadence. */
function sayLitterSweep(ctx: Ctx, rep: LitterReap): void {
  for (const k of rep.killed) {
    say(ctx, `drive litter: killed ${k}`);
  }
  for (const r of rep.released) {
    say(ctx, `drive litter: released claim ${r}`);
  }
  for (const g of rep.repaired) {
    say(ctx, `drive litter: re-registered ${g}`);
  }
  for (const r of rep.reaped) {
    say(ctx, `drive litter: reaped ${r}`);
  }
  for (const b of rep.branches) {
    say(ctx, `drive litter: deleted branch ${b}`);
  }
  for (const e of rep.errors) {
    say(ctx, `warning: litter sweep — ${e}`);
  }
  say(ctx, `drive litter: ${rep.reaped.length} reaped, ${rep.kept.length} kept`);
}
/** The fleet-status projector (spec bro-u19mq) — the ONE writer of
 *  herdr workspace state labels; session plugins keep spawn/attach
 *  only. Runs at pass end so labels ride the freshest act-state cache.
 *  Reachability changes are the only lines worth logging — a pass
 *  with no writes is the steady state, not an event. */
let herdrWasReachable: boolean | undefined;
let projectionFailedQuiet = false;
function herdrProjectorTick(ctx: Ctx): void {
  // the event trigger re-arms lazily here — a broker that came up since
  // the last pass restores event mode without a daemon restart
  void armProjectorEvents(ctx);
  // and the write points without an envelope get their fs.watch fast
  // path the same way — armed once, loop mode only
  armProjectorWatches(ctx);
  try {
    const r = projectFleet(ctx.mainRoot);
    if (r.reachable !== herdrWasReachable) {
      herdrWasReachable = r.reachable;
      if (!r.reachable) {
        say(ctx, 'herdr: unreachable — fleet labels paused');
      } else if (r.writes > 0 || r.workspaces > 0) {
        say(ctx, `herdr: projecting ${r.workspaces} managed workspace(s)`);
      }
    }
    if (r.degraded !== undefined) {
      say(ctx, `herdr: ${r.degraded} read failed — pass degraded`);
    }
    if (r.writes > 0) {
      say(ctx, `herdr: ${r.writes} label write(s)`);
    }
    projectionFailedQuiet = false;
  } catch (err) {
    // a failed projection retries next pass — never a pass failure;
    // log once per failure streak so stale LEDs are diagnosable
    if (!projectionFailedQuiet) {
      projectionFailedQuiet = true;
      say(
        ctx,
        `herdr: projection failed — ${err instanceof Error ? err.message : String(err)} (retrying each pass)`
      );
    }
  }
}

// --- event-triggered re-projection (spec bro-xmd9l) ------------------------------

/** The cooldown between event-kicked projections — an exit-harvest
 *  burst lands ONE pass, not one per envelope; leading-edge when the
 *  projector has been quiet at least this long, else scheduled at the
 *  cooldown end. 1.5s is snappy against the 300s tick and cheap
 *  against a churning fleet. */
const PROJECTOR_KICK_MS = 1_500;

/** A coalescing scheduler for re-projection kicks: the returned
 *  function absorbs kicks while one is pending (the scheduled pass
 *  re-derives all state anyway, so it sees the merged event set).
 *  Leading-edge when idle ≥`kickMs`, cooldown-trailing under load —
 *  exported so tests drive it with an injected `fire`. */
export function projectorKicker(fire: () => void, kickMs = PROJECTOR_KICK_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readyAt = 0;
  return () => {
    if (timer !== undefined) {
      return;
    }
    timer = setTimeout(
      () => {
        timer = undefined;
        readyAt = Date.now() + kickMs;
        fire();
      },
      Math.max(0, readyAt - Date.now())
    );
    timer.unref?.();
  };
}

let projectorKickFn: (() => void) | undefined;
/** Latest daemon ctx — rebound on every kick source call so a standby
 *  takeover never fires the projector through the first invocation's
 *  closure. */
let projectorCtx: Ctx | undefined;
function kickProjector(ctx: Ctx): void {
  projectorCtx = ctx;
  projectorKickFn ??= projectorKicker(() => {
    if (projectorCtx !== undefined) herdrProjectorTick(projectorCtx);
  });
  projectorKickFn();
}

/** The in-process bus subscription (no new process — spec bro-xmd9l):
 *  every `worker`/`worktree` envelope the lifecycle mirror already
 *  publishes (spawn, exit, silence, add/remove) kicks a re-projection,
 *  and a `gap` (missed events — broker restart, replay overflow) is
 *  the same kick since the pass re-derives anyway. `onClose` drops the
 *  handle; the next tick's lazy re-arm restores event mode when the
 *  broker returns. Only armed in loop mode — a `--once` pass is a
 *  report, not supervision. */
let projectorSub: BusSubscription | undefined;
let projectorSubQuiet = false;
let projectorArming = false;
async function armProjectorEvents(ctx: Ctx): Promise<void> {
  if (projectorSub !== undefined || projectorArming || ctx.everySec === undefined) {
    return;
  }
  const socket = busSocketPath(ctx.mainRoot);
  if (socket === null) {
    return;
  }
  // the await below can overlap a second caller (kick + tick landing in
  // the same window) — without the flag both open a socket and one
  // subscription leaks with its handle overwritten
  projectorArming = true;
  try {
    projectorSub = await busSubscribe(
      socket,
      { topics: ['worker', 'worktree'] },
      {
        onEvent: () => kickProjector(ctx),
        onGap: () => kickProjector(ctx),
        onClose: () => {
          projectorSub = undefined;
        },
      }
    );
    if (projectorSubQuiet) {
      say(ctx, 'herdr: event feed back — LEDs ride worker transitions');
      projectorSubQuiet = false;
    }
    // transitions during the disconnect window have no envelope —
    // one kick re-derives whatever the feed missed (coalesced, cheap)
    kickProjector(ctx);
  } catch {
    projectorSub = undefined;
    if (!projectorSubQuiet) {
      say(ctx, 'herdr: no event feed — projector rides the tick only');
      projectorSubQuiet = true;
    }
  } finally {
    projectorArming = false;
  }
}

// --- write-point watches (spec bro-9me97) -------------------------------------

/** Filename-filtered dir watches kicking the projector on the write
 *  points the bus does not cover: a `.exit` lands the instant a worker
 *  dies but `agent-exit` only journals at the next harvest;
 *  `agents.json` mutates outside lifecycle emits; plugin ledgers have
 *  no bus path at all. Everything funnels into the same coalescing
 *  kicker, and a missed/overflowed inotify event still has the tick
 *  behind it — the watch is a fast path, never the only path.
 *  Exported so tests drive it with injected dirs + kick. */
export function projectorWatcher(
  dirs: { dir: string; hit: (name: string) => boolean }[],
  kick: () => void
): FSWatcher[] {
  const out: FSWatcher[] = [];
  for (const { dir, hit } of dirs) {
    try {
      const w = watch(dir, (_e, name) => {
        if (typeof name === 'string' && hit(name)) {
          kick();
        }
      });
      // an inotify limit or a dir removed mid-watch degrades to the
      // tick — never a crash inside the supervisor loop
      w.on('error', () => {});
      w.unref?.();
      out.push(w);
    } catch {
      // an absent dir (a ledger root the plugin never created) is a
      // no-watch, not a failure
    }
  }
  return out;
}

interface ProjectorWatchSlot {
  dir: string;
  hit: (name: string) => boolean;
  w?: FSWatcher;
}

let projectorWatchSpec: ProjectorWatchSlot[] | undefined;
function armProjectorWatches(ctx: Ctx): void {
  if (ctx.everySec === undefined) {
    return;
  }
  projectorCtx = ctx;
  if (projectorWatchSpec === undefined) {
    const common = gitCommonDir(ctx.mainRoot) ?? ctx.mainRoot;
    projectorWatchSpec = [
      // registry mutations the lifecycle mirror does not emit for
      { dir: join(common, 'bro'), hit: name => name === 'agents.json' },
      // death before the harvest — the wrapper's .exit write point
      { dir: join(common, 'bro', 'agents'), hit: name => name.endsWith('.exit') },
      // plugin workspace/status bindings — no bus coverage at all
      ...pluginLedgerDirs().map(dir => ({ dir, hit: (name: string) => name.startsWith('state') })),
    ];
  }
  // re-attach every slot that is not watched yet — `bro/agents` only
  // exists after the first native spawn, ledger roots after the first
  // plugin run; a one-shot arm would leave those points tick-bound
  // forever (same lazy re-arm shape as armProjectorEvents)
  for (const d of projectorWatchSpec) {
    if (d.w !== undefined) {
      continue;
    }
    const [w] = projectorWatcher([d], () => {
      if (projectorCtx !== undefined) kickProjector(projectorCtx);
    });
    if (w !== undefined) {
      const drop = (): void => {
        d.w = undefined;
      };
      w.on('error', drop);
      w.on('close', drop);
      d.w = w;
    }
  }
}
/** `<git-common>/bro/drive.lock` — the one-supervisor-per-repo hold
 *  (spec bro-2duu9). Null when git can't name a common dir: the guard
 *  degrades away rather than blocking a run on a missing state dir. */
export function driveLockPath(root: string): string | null {
  const common = gitCommonDir(root);
  return common === null ? null : join(common, 'bro', 'drive.lock');
}

/** `install|uninstall` — arm/disarm the merge path (bro-y5zon): install
 *  writes the want-marker the session checkpoints rearm a dead
 *  supervisor from and brings the daemon up; uninstall disarms then
 *  downs. The mechanics live in daemon.ts — the supervisor's lifecycle
 *  module. */
function runDriveSched(argv: string[], dir: string, drive: DriveConfig): void {
  if (argv[0] === 'uninstall') {
    const r = uninstallDrive(dir);
    console.log(r.detail);
    if (r.state === 'error') {
      process.exit(1);
    }
    return;
  }
  // install spawns a supervisor — same arming guard as --every and
  // `daemon up`: spawned workers never own the cadence
  if (!isOrchestratorSession()) {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never arm the supervisor; ' +
        'the orchestrator session owns it'
    );
    process.exit(2);
  }
  const everyRaw = flag(argv, '--every');
  const everySec = everyRaw === undefined ? drive.intervalSec : Number(everyRaw);
  // the shared floor still matters: the armed cadence lands verbatim in
  // the marker and every rearmed spawn — a 0.05s drive is a busy loop
  if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
    console.error(
      `error: --every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw ?? everySec}"`
    );
    process.exit(2);
  }
  const r = installDrive(dir, { everySec, print: argv.includes('--print') });
  console.log(r.detail);
  if (r.state === 'error') {
    process.exit(1);
  }
}

export async function runDriveCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv)) {
    usage(0);
  }
  const main = mainWorktree();
  const broCfg = loadBroConfig(main.path);
  const drive =
    ((broCfg as Record<string, unknown>).drive as DriveConfig | undefined) ??
    driveSection(undefined);
  if (argv[0] === 'install' || argv[0] === 'uninstall') {
    // uninstall and `install --print` never touch the store — uninstall
    // is the cleanup path a broken beads setup still needs, --print a
    // pure preview. The real install spawns the supervisor, which needs
    // the store itself, so only that path keeps the gate.
    if (argv[0] === 'install' && !argv.includes('--print')) {
      checkBeads();
    }
    runDriveSched(argv, main.path, drive);
    return;
  }
  checkBeads();
  let args: DriveArgs;
  try {
    args = driveArgs(argv, drive.intervalSec);
  } catch (err) {
    console.error(`error: ${errText(err)}`);
    process.exit(2);
  }
  // GUARD (bro-killn): spawned workers pin BRO_AGENT_ID — they must
  // never arm a supervisor cadence; the orchestrator session owns it
  // and runs single passes on its pulse window end.
  if (args.everySec !== undefined && !isOrchestratorSession()) {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never arm supervisors; ' +
        'the orchestrator session owns the cadence'
    );
    process.exit(2);
  }
  // One drive per repo: a respawn wrapper's duplicate stands by behind
  // the incumbent's hold and supervises once it exits — two drives on
  // the same PRs raced fixer spawns and merge probes overnight
  // (retro bro-l63ji). Taken before auth/facade planes so a standby
  // stays a cheap local wait.
  const env = loadAgentEnv(main.path);
  const store = localLeaseStore(projectId(main.path));
  const abort = new AbortController();
  let roleLease: { release: () => void } | undefined;
  let releaseSupervisor = () => {};
  const releaseAll = (): void => {
    releaseSupervisor();
    roleLease?.release();
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    abort.abort();
    releaseAll();
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    process.kill(process.pid, signal);
  };
  const onInt = (): void => onSignal('SIGINT');
  const onTerm = (): void => onSignal('SIGTERM');
  const onExit = (): void => releaseAll();
  try {
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    process.on('exit', onExit);
    roleLease = await holdRoleLease(
      store,
      'drive',
      { host: hostname(), pid: process.pid, rig: basename(main.path) },
      (env.fleet?.leases?.roleTtlSeconds ?? 60) * 1000,
      { signal: abort.signal, onLost: () => releaseSupervisor() }
    );
    const driveLock = driveLockPath(main.path);
    if (driveLock !== null) {
      releaseSupervisor = await awaitFileLock(driveLock, {
        label: 'drive supervisor lock',
        onStandby: pid =>
          console.error(
            `bro drive: already supervised${pid === null ? '' : ` by pid ${pid}`} — standing by`
          ),
      });
    }
    await runDrive(main.path, broCfg, drive, args);
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('exit', onExit);
    releaseAll();
  }
}

// --- the deps wiring -------------------------------------------------------------

/** The policy's IO surface (spec bro-u6fp5.2) — every reach the drive
 *  FSM has into this command's machinery, bound once at ctx build.
 *  Object deps share the ctx's own instances; function deps wrap the
 *  command's spawn/merge/retire/sweep/projector helpers so
 *  `packages/rig` never imports back here. Closures read `ctx` lazily —
 *  by call time the literal is complete (same convention as loopDeps). */
function driveDeps(ctx: Ctx): DriveDeps {
  return {
    rev: ctx.rev,
    store: ctx.store,
    stateCache: ctx.stateCache,
    say: msg => say(ctx, msg),
    error: msg => console.error(msg),
    emitJson: row => console.log(JSON.stringify(row)),
    now: () => Date.now(),
    sleepMs: ms => new Promise(r => setTimeout(r, ms)),
    mergePr: pr => mergeGreen(ctx, pr),
    retireLanding: (state, worktree) => retireLanding(ctx, state, worktree),
    settleSessions: opts => {
      settleAcpSessions(ctx.mainRoot, ctx.env, opts);
    },
    shadowNotes: (pr, headSha, open, budget) =>
      driveShadowNotes(ctx.mainRoot, pr, headSha, open, budget),
    isAcpProvider: name => {
      if (name === undefined) return false;
      return ctx.env.providers?.[name]?.type === 'acp';
    },
    connectorAcceptsWorkers: connector => {
      try {
        const conn = resolveAgentConnector({ dir: ctx.mainRoot }, { connector }, ctx.env);
        return conn.capabilities().workers !== false;
      } catch {
        // an unresolvable connector cannot prove it runs provider
        // workers — the conservative refusal is a fresh spawn without
        // the donor, never a donor pinned onto a refused spawn (#732)
        return false;
      }
    },
    spawnAgent: req => spawnStepAgent(ctx.mainRoot, ctx.env, req),
    candidateBranches: () => candidateBranches(ctx.mainRoot),
    worktrees: () => {
      const wt = gitTry(['-C', ctx.mainRoot, 'worktree', 'list', '--porcelain']);
      return wt.code === 0 ? parseWorktreePorcelain(wt.out) : null;
    },
    collectAgents: () => collectAgents(ctx.mainRoot),
    // the occupancy rung's claims leg (bro-izpyk.10) — one list per
    // pass; a failed read degrades to marker-only, never a failed pass
    ...(ctx.claims === undefined
      ? {}
      : {
          claims: () =>
            ctx
              .claims!.list(ctx.project === undefined ? {} : { project: ctx.project })
              .catch(() => []),
        }),
    judgeBudget: () => ({
      remaining: judgeConfig(ctx.mainRoot).judge.maxDecisionsPerRun,
    }),
    laneUsage: () => emitLaneUsage(ctx),
    lanePause: () => lanePauseTick(ctx),
    litterSweep: () => litterSweep(ctx),
    publishAlert: (pr, link, cause, detail) =>
      publishDriveAlert(ctx.mainRoot, pr, link, cause, detail),
    signalForeignPush: (pr, link, head) => signalForeignPush(ctx, pr, link, head),
    projectorTick: () => herdrProjectorTick(ctx),
    armProjectorFeed: () => armProjectorEvents(ctx),
    pipelineWake: () => pipelineWakePass(ctx.mainRoot),
  };
}

async function runDrive(
  mainPath: string,
  broCfg: ReturnType<typeof loadBroConfig>,
  drive: DriveConfig,
  args: DriveArgs
): Promise<void> {
  // same gate as `bro act` — without it an unauthenticated pass catches
  // every lookup's auth error per-branch and reports "no open PRs"
  ensureAuth('reviews', { dir: mainPath }, { prefer: broCfg.connectors });
  const rev = reviewHost(mainPath, broCfg.connectors);
  const ctx: Ctx = {
    mainRoot: mainPath,
    rev,
    // same pick reviewHost already memoized — the name only decides
    // which CLI syntax the fixer prompts write
    host: facadeName('reviews', { dir: mainPath }, { prefer: broCfg.connectors }),
    repo: rev.resolveRepo([]),
    // same freshness contract as the loop's: the feed dedup caps
    // staleness at one poll window — a supervised pass's own cadence,
    // never more than the production 30s
    stateCache: prStateCache(mainPath, {
      ttlMs: Math.min(ACT_STATE_TTL_MS, (args.everySec ?? drive.intervalSec) * 1000),
    }),
    act: broCfg.act,
    merge: args.merge && drive.merge === 'auto',
    json: args.json,
    connector: args.connector,
    occTtlMs: drive.occupancyTtlSec * 1000,
    everySec: args.everySec,
    litter: { sweepSec: drive.litterSweepSec, lastAt: 0 },
    // loadBroConfig runs every registered section schema — loop is
    // always normalized (parkedKeep/parkedTtlDays defaults included)
    loop: (broCfg as Record<string, unknown>).loop as LoopConfig,
    env: loadAgentEnv(mainPath),
    store: facade('tasks', { dir: mainPath }, { prefer: broCfg.connectors }),
    // claims is best-effort like the occupancy read it feeds — a repo
    // without the ledger connector just runs the marker-only ladder
    claims: ((): ClaimFacade | undefined => {
      try {
        return facade('claims', { dir: mainPath }, { prefer: broCfg.connectors });
      } catch {
        return undefined;
      }
    })(),
    project: sessionProject(mainPath),
    work: freshDrivePass(),
    // the policy's IO surface attaches next — its closures read the
    // finished ctx (say's json route, env, connector, the queue)
    deps: {} as DriveDeps,
  };
  ctx.deps = driveDeps(ctx);
  await drivePolicy.run(ctx);
}
