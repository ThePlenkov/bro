/**
 * `bro act <sub>` — the open-PR review loop as mechanics, not prompts.
 *
 *   status [PR] [--json]   PR state + exit gate (open threads, CI, SAST)
 *   merge [PR]             merge only when the exit gate is green
 *   threads [PR]           unresolved review threads, TSV
 *   resolve --thread ID [--comment TEXT] [--unresolve]
 *   reply   --thread ID --comment TEXT | --file TSV
 *   dismiss [PR] [--dry-run] [--message T]
 *                          dismiss STALE veto reviews — a standing
 *                          CHANGES_REQUESTED whose referenced threads
 *                          are all resolved+outdated (bro-n1foa)
 */
import { type ChildProcess, spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type ActPlan,
  type ActThreadVerdict,
  checkHistory,
  type ExitGate,
  evaluateExitGate,
  fetchPrActState,
  type GateWaitResult,
  listWatches,
  type PrActState,
  prStateCache,
  type RearmPlan,
  rearmWatches,
  resolveLedger,
  waitForGate,
  watchVerdict,
} from '@broject/act';
import {
  acquireFileLock,
  emitLifecycle,
  ensureAuth,
  facade,
  gitCommonDir,
  hasHelpFlag,
  type PrTarget,
  type ReviewFacade,
  type ReviewThread,
  reviewHost,
  type VetoReview,
} from '@broject/core';
import { githubPrWake } from '@broject/github';
import { annotateThreads, judgeConfig, judgeFacade, recordDisposition } from '@broject/judge';
import { loadBroConfig } from '../plugins.ts';
import { commentArg, type ResolvedTarget, resolvePr, threadArg, usage } from './act-args.ts';
import {
  claimStore,
  closeBeadIfLanded,
  closeLandedBead,
  cmdMerge,
  dropActState,
  harvestClosedPr,
  reportActOutcome,
} from './act-land.ts';
import {
  landedLine,
  landedPhrase,
  printStatus,
  settledLabel,
  vetoBodyNote,
  waitVerdict,
} from './act-report.ts';
import { flag } from './args.ts';
import { reconcileOutcomes } from './outcome-report.ts';
import { SELF_ENTRY } from './self-entry.ts';

export type { ResolvedTarget, ResolveMode } from './act-args.ts';
export { mergeMethod, resolvePr } from './act-args.ts';
export {
  cleanupAfterMerge,
  closeLandedBead,
  defaultBranch,
  landPr,
  reportActOutcome,
  warnHumanOwned,
} from './act-land.ts';

async function cmdStatus(argv: string[]): Promise<void> {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const json = argv.includes('--json');
  const t = resolvePr(rev, argv);
  const act = loadBroConfig().act;
  const state = await fetchPrActState(rev, t, {
    ignoreChecks: act.ignoreChecks,
    selfCheck: act.selfCheck,
    checkHistory: checkHistory(process.cwd()),
    maxRounds: act.maxRounds,
    docsPaths: act.docsPaths,
    docsMaxRounds: act.docsMaxRounds,
    requireApproval: act.requireApproval,
    approvers: act.approvers,
    stateCache: prStateCache(process.cwd()),
    resolveLedger: resolveLedger(process.cwd()),
  });
  const gate = evaluateExitGate(state, { requireApproval: act.requireApproval });

  if (!gate.ok) {
    process.exitCode = 1;
  }
  if (json) {
    console.log(JSON.stringify({ pr: state, exit_gate: gate }, null, 2));
    return;
  }
  printStatus(state, gate);
}

/**
 * `bro act wait` — the gate-watcher as a primitive: poll until nothing is
 * pending (gate green, threads/failures to act on, or timeout), print the
 * verdict. `--merge` lands the PR when the gate settles OK — the whole
 * "watcher + merge on green" loop in one backgroundable command.
 */
async function cmdWait(argv: string[]): Promise<void> {
  // a strategy conflict dooms the post-wait merge — refuse up front so
  // the error reads on this stderr, not in a detached child's log after
  // the whole wait already ran
  if (argv.includes('--squash') && argv.includes('--rebase')) {
    console.error('error: conflicting merge strategies: --squash --rebase');
    process.exit(2);
  }
  if (argv.includes('--detach')) {
    return cmdWaitDetach(argv);
  }
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const t = resolvePr(rev, argv, argv.includes('--merge') ? 'strict' : 'read');
  // a watcher's startup drains the outcome outbox — intents a crashed
  // merge/report pass left undelivered retry here (spec bro-0ykhg.4);
  // housekeeping, never a gate on the wait itself
  try {
    await reconcileOutcomes(process.cwd());
  } catch {
    /* reconciliation is best-effort — the next pass retries */
  }
  const act = loadBroConfig().act;
  const interval = Number(flag(argv, '--interval') ?? '60');
  const timeout = Number(flag(argv, '--timeout') ?? '45');
  if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(timeout) || timeout <= 0) {
    console.error('error: --interval/--timeout must be positive numbers (seconds/minutes)');
    process.exit(2);
  }
  // the wait's polls ride the shared feed — loop/watch/drive passes
  // share the same entries; the settle→merge dispatch re-gates
  // uncached inside cmdMerge, so a cached green never lands a PR
  const cache = prStateCache(process.cwd());
  const ledger = resolveLedger(process.cwd());
  const res = await waitForGate(
    gateStateFetcher(rev, t, act, cache, ledger),
    waitOpts(rev, t, argv, { interval, timeout }, cache)
  );
  // the settled wait is one gate verdict — timeout, blocked, externally
  // settled, or green. Poll snapshots inside waitForGate are noise;
  // only the decision journals here.
  emitLifecycle(process.cwd(), {
    kind: 'gate',
    bead: flag(argv, '--bead'),
    pr: t.pr,
    to: waitVerdict(res),
    detail: {
      via: 'act',
      sha: res.state.headSha,
      open_threads: res.gate.open_threads,
      fix_rounds: res.gate.fix_rounds,
      ...(res.gate.blockers.length > 0 ? { blockers: res.gate.blockers } : {}),
    },
  });
  if (argv.includes('--json')) {
    const verdict = landedPhrase(res.state);
    console.log(
      JSON.stringify(
        {
          pr: res.state,
          exit_gate: res.gate,
          timed_out: res.timedOut,
          ...(verdict === undefined ? {} : { verdict }),
        },
        null,
        2
      )
    );
  } else {
    printStatus(res.state, res.gate);
    if (res.timedOut) {
      console.log(`wait: timed out after ${timeout}m — still pending`);
    }
  }
  await settleWait(argv, rev, t, res, timeout);
}

/** The fetch+gate closure every poll loop builds on — one place owning
 *  which act knobs feed fetchPrActState and how the exit gate
 *  evaluates, so a composing verb never re-types the closure. */
export function gateStateFetcher(
  rev: ReviewFacade,
  t: ResolvedTarget,
  act: ReturnType<typeof loadBroConfig>['act'],
  cache: ReturnType<typeof prStateCache>,
  ledger: ReturnType<typeof resolveLedger>
): () => Promise<{ state: PrActState; gate: ExitGate }> {
  return async () => {
    const state = await fetchPrActState(rev, t, {
      ignoreChecks: act.ignoreChecks,
      selfCheck: act.selfCheck,
      checkHistory: checkHistory(process.cwd()),
      maxRounds: act.maxRounds,
      docsPaths: act.docsPaths,
      docsMaxRounds: act.docsMaxRounds,
      requireApproval: act.requireApproval,
      approvers: act.approvers,
      stateCache: cache,
      resolveLedger: ledger,
    });
    return { state, gate: evaluateExitGate(state, { requireApproval: act.requireApproval }) };
  };
}

/** The poll loop's knobs — cadence, wake subscription, the session
 *  marker, and the callbacks. `updateBranch` is the "Update branch"
 *  button as a wait step: BEHIND + mergeable is a state to fix, not
 *  to sit on — conflicts still settle for a human. */
export function waitOpts(
  rev: ReviewFacade,
  t: ResolvedTarget,
  argv: string[],
  timing: { interval: number; timeout: number },
  cache: ReturnType<typeof prStateCache>,
  label = 'act wait'
): Parameters<typeof waitForGate>[1] {
  // an auto-resolved target never gets the push: the row is a recency
  // guess, and update-branch writes to the PR (strix CWE-862) — the
  // callback is simply not supplied, not re-flagged off --merge
  const updateBranch =
    t.source === 'auto'
      ? undefined
      : (s: PrActState) => {
          const ok = rev.updateBranch(t, s.headSha);
          console.error(
            `${label} ${rev.prLink(t.repo, t.pr)}: update-branch ${ok ? 'pushed a new head' : 'refused'}`
          );
          // the pushed head obsoletes this PR's feed entry — the next
          // poll must fetch it, not re-serve the pre-update state
          if (ok) cache?.invalidate(t);
          emitLifecycle(process.cwd(), {
            kind: 'gate',
            pr: t.pr,
            to: ok ? 'updated' : 'blocked',
            detail: { via: 'act', action: 'update', sha: s.headSha },
          });
          return ok;
        };
  return {
    intervalMs: timing.interval * 1000,
    timeoutMs: timing.timeout * 60_000,
    // a github:* bus subscription pokes the poll loop early (spec
    // bro-huy5o.7) — broker down arms nothing and the timer rules
    wake: () => githubPrWake(process.cwd(), t.pr),
    // a session-bound watcher that dies with the turn leaves a marker —
    // the session-start hook flags the stale promise (bro-97lk)
    watch: {
      dir: process.cwd(),
      pr: t.pr,
      link: rev.prLink(t.repo, t.pr),
      merge: argv.includes('--merge'),
      cleanup: argv.includes('--cleanup'),
      workdir: process.cwd(),
      bead: flag(argv, '--bead'),
      timeoutMin: timing.timeout,
    },
    onPoll: (s, g) =>
      console.error(
        `${label} ${rev.prLink(t.repo, s.pr)}: threads=${g.open_threads} ci=${g.ci_pending}+${g.ci_failing}f reviewers=${g.reviewers_pending} sast=${g.sast_pending}`
      ),
    onError: (err, n) =>
      console.error(
        `${label} ${rev.prLink(t.repo, t.pr)}: fetch failed (${n}) — ${err instanceof Error ? err.message : String(err)}`
      ),
    ...(updateBranch ? { updateBranch } : {}),
  };
}

/** The settled tail — verdict events, the loop-claimed bead's discharge
 *  on external settle, and the green path's optional merge. An external
 *  merge settles the wait before mergeIfAsked ever runs — watchEnd
 *  already swept the marker, so nothing is left for `act rearm`'s
 *  settle-path reconcile to see. */
async function settleWait(
  argv: string[],
  rev: ReviewFacade,
  t: PrTarget,
  res: GateWaitResult,
  timeout: number
): Promise<void> {
  const json = argv.includes('--json');
  if (!res.timedOut && res.state.state === 'MERGED') {
    // the merge landed — the verdict is MERGED, whatever the gate says:
    // a PR that another actor landed while the checks were still red is
    // a landing, not a block (spec: specs/bro-0i1lm.md). The gate's
    // state cannot demote a landed PR to a blocked one.
    if (!json) {
      // a landed PR is a verdict, not a lifecycle failure — the caller
      // gets the landing and its actor (spec: specs/bro-0i1lm.md)
      console.log(landedLine(rev, t, res.state));
    }
    await recordSettledVerdict(rev, t, res.state.url, settledLabel(res.state));
    // the bead's twin rule: MERGED closes, CLOSED-unmerged keeps
    closeBeadIfLanded(argv, rev, t, res.state.state);
    await harvestClosedPr(rev, t, res.state.state, argv);
    // externally-landed merges report too — the already-merged
    // reconciliation the spec wants (bro-0ykhg.4); own merges already
    // reported inside cmdMerge and dedupe on the same event id
    if (res.state.state === 'MERGED') {
      await reportActOutcome(argv, t, res.state, 'merged');
    }
    process.exitCode = 0;
    return;
  }
  if (res.timedOut || !res.gate.ok || res.state.state !== 'OPEN') {
    if (!res.timedOut && !res.gate.ok) {
      await recordBlockedVerdict(rev, t, res, timeout);
    } else if (!res.timedOut && res.state.state !== 'OPEN') {
      // externally settled (closed between polls) — the "wait
      // finished" moment a sink is for (spec: specs/bro-huy5o.8.md)
      await recordSettledVerdict(rev, t, res.state.url, settledLabel(res.state));
    }
    // the bead's twin rule: MERGED closes, CLOSED-unmerged keeps
    closeBeadIfLanded(argv, rev, t, res.state.state);
    if (!res.timedOut) {
      await harvestClosedPr(rev, t, res.state.state, argv);
    }
    process.exitCode = res.timedOut || !res.gate.ok ? 1 : 0;
    return;
  }
  const landed = await mergeIfAsked(argv, t.pr);
  // mergeIfAsked reports merge failures on exitCode — a clean return
  // means the wait ended at a green gate (and --merge landed or queued)
  if (process.exitCode === undefined || process.exitCode === 0) {
    await recordSettledVerdict(rev, t, res.state.url, landed ?? 'GREEN');
  }
}

/** A settled blocked verdict is a finding, not just an exit code — a
 *  detached or turn-dead watcher leaves nobody reading it, so it lands
 *  where rehydrate looks: a verdict marker session-start flags plus a
 *  keyed mailbox drop live sessions drain mid-turn (bro-q4iq0). */
async function recordBlockedVerdict(
  rev: ReviewFacade,
  t: PrTarget,
  res: GateWaitResult,
  timeoutMin: number
): Promise<void> {
  const link = rev.prLink(t.repo, t.pr);
  watchVerdict(process.cwd(), { pr: t.pr, link, timeoutMin }, res.gate.blockers);
  try {
    await facade('events', { dir: process.cwd() }, { prefer: loadBroConfig().connectors }).publish({
      topic: 'act',
      kind: 'block',
      key: `act-wait-${t.pr}`,
      source: 'act-wait',
      ref: res.state.url,
      payload:
        `act wait on ${link} settled BLOCKED — ${res.gate.blockers.join('; ')} — ` +
        `\`bro act threads ${t.pr}\` lists them`,
    });
  } catch {
    // fail-open — the verdict record must never turn the exit-code
    // contract into a failure
  }
}

// --- detached wait -------------------------------------------------------------

/** Cap the per-PR wait log — append-only state in a .git dir still
 *  shouldn't grow without bound; keep the tail where fresh entries are. */
const WAIT_LOG_CAP = 512 * 1024;

/** `<git-common>/bro/act-wait-<pr>.log` — the detached waiter's
 *  stdout/stderr. The watch marker under bro/watches/ records the pid
 *  and the promise; this keeps the words. */
function waitLogPath(dir: string, pr: number): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', `act-wait-${pr}.log`);
}

/** Append fd for the wait log, or undefined — the spawn then falls back
 *  to `stdio: 'ignore'`, never to a broken fd. */
function waitLogFd(dir: string, pr: number): number | undefined {
  const p = waitLogPath(dir, pr);
  if (p === null) {
    return undefined;
  }
  try {
    mkdirSync(dirname(p), { recursive: true });
    if (statSync(p).size > WAIT_LOG_CAP) {
      writeFileSync(p, readFileSync(p, 'utf8').slice(-WAIT_LOG_CAP / 2));
    }
  } catch {
    // no log yet or unreadable — the append below creates/keeps it
  }
  try {
    return openSync(p, 'a');
  } catch {
    return undefined;
  }
}

interface DetachedWait {
  pid: number;
  /** 'armed' — the child's own live watch marker was seen: the wait is
   *  running detached. 'settled' — the child already exited 0: an
   *  already-set gate finishes the wait inside the spawn (a merge armed
   *  with --merge already ran). 'pending' — alive at the deadline
   *  without a marker yet (late arming — a slow auth probe); the pid is
   *  real, the marker may still land. */
  state: 'armed' | 'settled' | 'pending';
}

/** The green twin of recordBlockedVerdict — "act wait finished" is a
 *  human moment even when nothing went wrong: a settled watcher is the
 *  one that stopped needing eyes (spec: specs/bro-huy5o.8.md). Same
 *  event key as the block verdict — a wait that settled after earlier
 *  BLOCKED news supersedes it. */
async function recordSettledVerdict(
  rev: ReviewFacade,
  t: PrTarget,
  url: string,
  outcome: string
): Promise<void> {
  const link = rev.prLink(t.repo, t.pr);
  try {
    await facade('events', { dir: process.cwd() }, { prefer: loadBroConfig().connectors }).publish({
      topic: 'act',
      kind: 'result',
      key: `act-wait-${t.pr}`,
      source: 'act-wait',
      ref: url,
      payload: `act wait on ${link} settled ${outcome}`,
    });
  } catch {
    // fail-open — same rule as the blocked verdict
  }
}

/** Spawn `act wait <args>` detached + unref'd — the nohup-equivalent a
 *  session-bound exec shell can't give (bro-b16er): own process group,
 *  stdio on the per-PR log under <git-common>/bro/. `SELF_ENTRY` is
 *  the running cli entry, so the child re-runs this same binary.
 *
 *  The marker is the arm contract — 'armed' resolves only once the
 *  child's own live marker shows in listWatches, so a spawn that exits
 *  early never reports "watching". An exit during arming is read off
 *  the 'exit' event (signal-killed children leave exitCode null): a
 *  clean 0 means the gate was already settled — the wait did its whole
 *  job inline; anything else is a failed spawn and resolves undefined. */
async function spawnDetachedWait(opts: {
  dir: string;
  pr: number;
  args: string[];
  cwd: string;
}): Promise<DetachedWait | undefined> {
  const entry = SELF_ENTRY;
  if (entry === null) {
    return undefined;
  }
  const fd = waitLogFd(opts.dir, opts.pr);
  const child = spawnWaitChild(opts, entry, fd);
  if (child === undefined) {
    return undefined;
  }
  // an unhandled 'error' event (ENOENT on cwd, EACCES on the entry)
  // would crash the caller mid-loop — swallow it; state stays the verdict
  child.on('error', () => {});
  let exited: number | null | undefined; // undefined = still running; null = signaled
  child.once('exit', code => {
    exited = code;
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) {
    return undefined;
  }
  return awaitWaitMarker(opts.dir, pid, () => exited);
}

function spawnWaitChild(
  opts: { args: string[]; cwd: string },
  entry: string,
  fd: number | undefined
): ChildProcess | undefined {
  try {
    if (fd !== undefined) {
      appendFileSync(fd, `\n--- bro ${opts.args.join(' ')} — ${new Date().toISOString()}\n`);
    }
    return spawn(process.execPath, [entry, ...opts.args], {
      cwd: opts.cwd,
      detached: true,
      stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd],
    });
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

// the deadline ends the loop, not the read — the last sleep can cross
// it, so take one final read: a child that armed or died inside that
// sleep must not be misreported 'pending'
async function awaitWaitMarker(
  dir: string,
  pid: number,
  exited: () => number | null | undefined
): Promise<DetachedWait | undefined> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const live = listWatches(dir).find(l => l.alive && l.watch.pid === pid);
    if (live !== undefined) {
      return { pid, state: 'armed' };
    }
    const code = exited();
    if (code !== undefined) {
      return code === 0 ? { pid, state: 'settled' } : undefined;
    }
    if (Date.now() >= deadline) {
      return { pid, state: 'pending' };
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

/** `bro act wait --detach` — arm the wait as a detached child and
 *  return: the poll, the --merge/--cleanup finalize, and the watch
 *  marker all outlive the arming session (bro-b16er). Target and flag
 *  validation stay in the parent so a typo'd PR or bad flag fails where
 *  stderr is read; the child re-runs the same wait argv minus --detach. */
async function cmdWaitDetach(argv: string[]): Promise<void> {
  const interval = Number(flag(argv, '--interval') ?? '60');
  const timeout = Number(flag(argv, '--timeout') ?? '45');
  if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(timeout) || timeout <= 0) {
    console.error('error: --interval/--timeout must be positive numbers (seconds/minutes)');
    process.exit(2);
  }
  // a detached child hitting this post-settle reports into a log nobody
  // reads — refuse in the parent where the error is seen
  if (argv.includes('--cleanup') && !argv.includes('--merge')) {
    console.error('error: --cleanup requires --merge — nothing to clean without it');
    process.exit(2);
  }
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const t = resolvePr(rev, argv, 'strict');
  const args = detachWaitArgs(argv, t.pr, interval, timeout);
  const r = await spawnDetachedWait({ dir: process.cwd(), pr: t.pr, args, cwd: process.cwd() });
  const link = rev.prLink(t.repo, t.pr);
  const log = waitLogPath(process.cwd(), t.pr);
  const logTag = (sep: string): string => (log === null ? '' : `${sep}log: ${log}`);
  if (r === undefined) {
    console.error(
      `error: detached act wait on ${link} never armed — the child exited ` +
        `before its marker landed${logTag('; ')}`
    );
    process.exitCode = 1;
    return;
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ pr: t.pr, pid: r.pid, state: r.state, log }, null, 2));
    return;
  }
  if (r.state === 'settled') {
    // the gate was already settled — the wait ran to its verdict inside
    // the spawn (a --merge already landed), no watcher is needed at all
    console.log(
      `act wait ${link} — gate already settled; the wait ran to completion ` +
        `in the child (exit 0)${logTag(' — ')}`
    );
    return;
  }
  console.log(
    `act wait ${link} detached — pid ${r.pid} polling every ${interval}s, timeout ${timeout}m`
  );
  console.log(`  inspect: \`bro act status --pr ${t.pr}\`${logTag(' · ')}`);
  if (r.state === 'pending') {
    console.error('warning: marker not confirmed within 10s — the child may still be arming');
  }
}

// the wait's whole flag surface replays — merge mode + strategy the
// child's mergeIfAsked dispatches on, the bead its marker re-records
function detachWaitArgs(argv: string[], pr: number, interval: number, timeout: number): string[] {
  const args = [
    'act',
    'wait',
    String(pr),
    '--interval',
    String(interval),
    '--timeout',
    String(timeout),
  ];
  for (const f of ['--merge', '--cleanup', '--squash', '--rebase', '--admin']) {
    if (argv.includes(f)) {
      args.push(f);
    }
  }
  const bead = flag(argv, '--bead');
  if (bead !== undefined) {
    args.push('--bead', bead);
  }
  return args;
}

/** Detached `act wait` resurrection — the same spawnDetachedWait shape
 *  `--detach` arms directly (bro-tafj, bro-b16er).
 *
 *  The returned pid is CONFIRMED — this resolves only once the child's
 *  own live marker shows up in listWatches, so a spawn that exits early
 *  (auth gate, config error) resolves undefined and the dead markers
 *  stay on disk as the still-unkept promise. A child alive but unmarked
 *  at the deadline also resolves undefined: keeping the dead markers
 *  flags the promise again rather than trusting a pid that may yet die
 *  pre-arm. A child that settled 0 during arming did the wait's whole
 *  job — its pid discharges the dead markers too. */
export async function respawnWatcher(dir: string, plan: RearmPlan): Promise<number | undefined> {
  // --cleanup retires the worktree containing the watcher's cwd — it is
  // replayed only when the recorded workdir still exists. Replaying it
  // from the rearm cwd (or a marker old enough to lack workdir) could
  // tear down the wrong checkout.
  const workdirOk = plan.workdir !== undefined && existsSync(plan.workdir);
  const args = ['act', 'wait', String(plan.pr), '--timeout', String(plan.timeoutMin)];
  if (plan.merge) {
    args.push('--merge');
    // --cleanup only has meaning behind --merge — a wait armed with
    // cleanup alone exits on the post-wait dispatch, so a merge:false
    // marker's cleanup bit (user error at arm time) isn't replayed
    if (plan.cleanup && workdirOk) {
      args.push('--cleanup');
    }
  }
  // the loop-claimed bead rides along in either mode — the respawned
  // wait's own marker re-records it, so a second rearm keeps the
  // identity; on merge it is the bead the dead loop never closed
  if (plan.bead !== undefined) {
    args.push('--bead', plan.bead);
  }
  const cwd = workdirOk ? plan.workdir! : dir;
  const r = await spawnDetachedWait({ dir, pr: plan.pr, args, cwd });
  return r !== undefined && r.state !== 'pending' ? r.pid : undefined;
}

/** `<git-common>/bro/act-rearm.lock` — serializes the plan→respawn
 *  critical section across `act rearm` and `fleet resume` callers:
 *  two concurrent passes both seeing a dead marker would otherwise
 *  each spawn a wait on the same PR. rearmWatches re-plans inside the
 *  hold, so the second pass sees the first's swept files and does
 *  nothing. A wedged lock degrades to no lock — an advisory pass must
 *  not brick on residue. */
function rearmLock(dir: string): () => void {
  const common = gitCommonDir(dir);
  if (common === null) {
    return () => {};
  }
  try {
    return acquireFileLock(join(common, 'bro', 'act-rearm.lock'), {
      label: 'act rearm lock',
    });
  } catch {
    return () => {};
  }
}

/** The rearm pass without its rendering — shared by `act rearm` and
 *  `fleet resume`: resolve the review host, probe each dead marker's
 *  PR, respawn a detached wait on every still-open one, sweep +
 *  reconcile the settled (a MERGED verdict discharges a loop-claimed
 *  bead exactly like finalizeMerge — bro-q6ppv). `dry` plans only:
 *  nothing spawns, no marker moves, open PRs report pid 0. */
export async function rearmPass(
  dir: string,
  dry: boolean
): Promise<{
  rearmed: Array<{ pr: number; pid: number }>;
  settled: Array<{ pr: number; bead?: string }>;
  kept: Array<{ pr: number; reason: string }>;
  link: (pr: number) => string;
}> {
  // dir-scoped config — a linked worktree may carry a different
  // committed bro.config than the checkout the watches live under
  const rev = reviewHost(undefined, loadBroConfig(dir).connectors);
  const repo = await (rev.resolveRepoAsync === undefined
    ? Promise.resolve(rev.resolveRepo([]))
    : rev.resolveRepoAsync([]));
  // prMeta answers both probes — the OPEN gate and the settle-path
  // reconcile below — cache it so the second read costs nothing
  const metas = new Map<number, { state: string }>();
  const isOpen = async (pr: number): Promise<boolean> => {
    const meta =
      rev.prMetaAsync === undefined
        ? rev.prMeta({ repo, pr })
        : await rev.prMetaAsync({ repo, pr });
    metas.set(pr, meta);
    return meta.state === 'OPEN';
  };
  const release = rearmLock(dir);
  let res: Awaited<ReturnType<typeof rearmWatches>>;
  try {
    res = await rearmWatches({
      dir,
      isOpen,
      respawn: dry ? undefined : plan => respawnWatcher(dir, plan),
    });
  } finally {
    release();
  }
  if (!dry) {
    for (const s of res.settled) {
      if (s.bead !== undefined && metas.get(s.pr)?.state === 'MERGED') {
        closeLandedBead(rev, { repo, pr: s.pr }, s.bead);
      }
    }
  }
  return { ...res, link: pr => rev.prLink(repo, pr) };
}

/** `bro act rearm` — dead watch markers mean their watcher died with
 *  the promise unkept (bro-tafj). Per still-open PR a detached wait
 *  goes back up with the recorded mode; settled PRs' markers sweep.
 *  --dry-run prints the plan without spawning or touching markers. */
async function cmdRearm(argv: string[]): Promise<void> {
  const dry = argv.includes('--dry-run');
  const { link, ...res } = await rearmPass(process.cwd(), dry);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ dryRun: dry, ...res }, null, 2));
  } else {
    reportRearm(res, dry, link);
  }
}

/** Human lines for a rearm result — kept out of cmdRearm so the
 *  command reads as resolve → run → report. */
function reportRearm(
  res: {
    rearmed: Array<{ pr: number; pid: number }>;
    settled: Array<{ pr: number; bead?: string }>;
    kept: Array<{ pr: number; reason: string }>;
  },
  dry: boolean,
  link: (pr: number) => string
): void {
  for (const r of res.rearmed) {
    console.log(
      `rearm: ${link(r.pr)} — ${dry ? 'would respawn a watcher' : `watcher up (pid ${r.pid})`}`
    );
  }
  for (const s of res.settled) {
    console.log(`rearm: ${link(s.pr)} settled — marker swept`);
  }
  for (const k of res.kept) {
    console.error(`rearm: ${link(k.pr)} kept — ${k.reason}`);
  }
  if (res.rearmed.length === 0 && res.settled.length === 0 && res.kept.length === 0) {
    console.log('rearm: no dead watches');
  }
}

/** Post-wait merge dispatch: `--merge` lands the PR (with `--cleanup`
 *  and `--bead` forwarded); `--cleanup` alone is an error — nothing was
 *  merged. Returns the settled label when the PR was already merged by
 *  somebody else — the wait journals the landing, not a green gate. */
async function mergeIfAsked(argv: string[], pr: number): Promise<string | undefined> {
  if (argv.includes('--merge')) {
    const mergeArgs = argv.filter(a =>
      ['--squash', '--rebase', '--admin', '--cleanup'].includes(a)
    );
    const bead = flag(argv, '--bead');
    if (bead !== undefined) {
      mergeArgs.push('--bead', bead);
    }
    return cmdMerge([String(pr), ...mergeArgs]);
  } else if (argv.includes('--cleanup')) {
    console.error('error: --cleanup requires --merge — nothing was merged, nothing to clean');
    process.exitCode = 2;
  }
  return undefined;
}

async function cmdThreads(argv: string[]): Promise<void> {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const t = resolvePr(rev, argv);
  // threads only needs the threads API — fetching checks/SAST here would
  // make a read-only listing fail on unrelated check-service flakes
  const threads = await rev.reviewThreads(t);
  // shadow-mode judge verdicts render beside each unresolved thread —
  // annotation only, never applied; every failure mode degrades to
  // "no annotation" (a judge that can stall `act threads` gets turned
  // off, per the spec's fail-open rule)
  // judging runs behind the listing, not beside it — TSV rows print
  // first; shadowNotes can open with a slow prMeta call, and starting
  // it before the row loop would still stall the listing. Annotations
  // land on stderr once the batch resolves.
  let open = 0;
  for (const thread of threads) {
    if (thread.resolved) {
      continue;
    }
    open += 1;
    const c = thread.comment;
    const author = c?.author ?? '-';
    const path = c?.path ?? '-';
    const line = c?.line ?? '-';
    const body = (c?.body ?? '').replace(/[\n\t]/g, ' ').slice(0, 120);
    console.log(`${thread.id}\t${author}\t${path}:${line}\t${body}`);
  }
  const notes = await shadowNotes(rev, t, threads).catch(() => undefined);
  for (const thread of threads) {
    const note = notes?.get(thread.id);
    if (note !== undefined) {
      // stderr — stdout is the documented TSV contract; a `judge:` line
      // there reads as a malformed thread record to TSV consumers
      console.error(`${thread.id} ${note}`);
    }
  }
  console.error(`act threads: ${open} unresolved`);
}

/** Shadow-mode judge annotation for the threads listing — the
 *  `judge: …` line under each unresolved row when `judge.mode:
 *  shadow`, undefined otherwise. The journal dedups on
 *  (threadId, commentSha, headSha), so repeat polls annotate for
 *  free and only a moved subject pays for a fresh decide(). */
async function shadowNotes(
  rev: ReviewFacade,
  t: PrTarget,
  threads: ReviewThread[]
): Promise<Map<string, string> | undefined> {
  const dir = process.cwd();
  const cfg = judgeConfig(dir).judge;
  if (cfg.mode !== 'shadow') {
    return undefined;
  }
  try {
    // headSha is the "inputs moved" half of the dedup key — a push
    // re-judges the thread; an unfetchable head just loosens the key
    let headSha: string | undefined;
    try {
      // async twin when the facade has one — a sync CLI call inside an
      // async fn still freezes the loop this listing shares
      const meta = rev.prMetaAsync !== undefined ? await rev.prMetaAsync(t) : rev.prMeta(t);
      headSha = meta.headSha;
    } catch {
      // no head — dedup keys on commentSha alone
    }
    const res = await annotateThreads(threads, {
      dir,
      pr: t.pr,
      headSha,
      judge: judgeFacade(dir),
      budget: cfg.maxDecisionsPerRun,
      // a listing must stay a listing — a slow-but-alive backend gets a
      // few decide rounds, then the rows print unjudged
      deadlineMs: 10_000,
    });
    if (res.decided > 0) {
      console.error(`act: judge decided ${res.decided} thread(s) — verdicts journaled`);
    }
    return res.annotations;
  } catch (err) {
    console.error(
      `act: judge annotation skipped — ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/** The observed outcome for a thread — journaled beside its shadow
 *  verdict so stats can score judge-vs-outcome agreement. The lifecycle
 *  journal records the verdict unconditionally (it is THE thread
 *  transition); the shadow journal runs only in shadow mode (off
 *  writes no judge artifacts). A failed journal write never fails the
 *  mutation that produced the outcome. */
function disposition(threadId: string, outcome: string, pr?: number): void {
  const dir = process.cwd();
  emitLifecycle(dir, {
    kind: 'verdict',
    ...(pr !== undefined ? { pr } : {}),
    to: outcome,
    detail: { via: 'act', thread: threadId },
  });
  if (judgeConfig(dir).judge.mode !== 'shadow') {
    return;
  }
  try {
    recordDisposition(dir, { pr, threadId }, outcome);
  } catch (err) {
    console.error(
      `act: disposition not journaled — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Record a resolve in the ledger — the source of "this thread was
 *  resolved before" for the reopened-thread cycle-guard. Best-effort: a
 *  missing git dir or an unwritable ledger means the reopen is not
 *  detected, never a crash. */
function recordResolve(rev: ReviewFacade, argv: string[], threadId: string): void {
  try {
    const ledger = resolveLedger(process.cwd());
    if (ledger === null) {
      return;
    }
    const target = resolvePr(rev, argv, 'record');
    if (target.source === 'auto') {
      // the auto row is a recency guess — recording a thread under the
      // wrong PR poisons the reopen guard just as much as losing the
      // row would, so the row is dropped with a note instead (codeant)
      console.error(
        `act: note — no branch PR for this thread; ledger record of ${threadId} skipped`
      );
      return;
    }
    ledger.record({ repo: target.repo, pr: target.pr, thread: threadId });
  } catch {
    // recording is best-effort — the resolve itself already landed
  }
}

function cmdResolve(argv: string[]): void {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const id = threadArg(argv);
  const comment = commentArg(argv);
  const unresolve = argv.includes('--unresolve');
  if (comment) {
    if (!unresolve) {
      // the verdict on a fix is the push — comments on resolved-as-fixed
      // threads are boilerplate noise on the PR (skills/act/SKILL.md)
      console.error('act: note — fixes resolve silently; --comment is for reject/defer reasons');
    }
    rev.replyThread(id, comment);
    console.error(`act: replied on ${id}`);
  }
  if (unresolve) {
    rev.resolveThread(id, true);
    console.error(`act: unresolved ${id}`);
    emitLifecycle(process.cwd(), {
      kind: 'verdict',
      to: 'unresolved',
      detail: { via: 'act', thread: id },
    });
  } else {
    rev.resolveThread(id);
    console.error(`act: resolved ${id}`);
    // Record the resolve — the reopened-thread cycle-guard needs to know
    // this thread was resolved before. The ledger, not the state cache:
    // the cache TTL is 30s, so its entry is gone between polls.
    recordResolve(rev, argv, id);
    // a silent resolve is the fix verdict; a comment is a reject/defer
    // reason (skills/act/SKILL.md) — the documented defer reply names
    // its bead ("deferred to <id>"), which is the one defer signal a
    // bare resolve can see
    disposition(
      id,
      comment ? (/deferred to \S+/i.test(comment) ? 'deferred' : 'rejected') : 'fixed'
    );
  }
  dropActState();
}

function cmdReply(argv: string[]): void {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const fileIdx = argv.indexOf('--file');
  if (fileIdx >= 0) {
    const file = argv[fileIdx + 1];
    if (!file) {
      console.error('error: --file requires a path');
      process.exit(2);
    }
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    let skipped = 0;
    const rows = lines
      .map(l => {
        const tab = l.indexOf('\t');
        if (tab === -1) {
          skipped += 1;
          return null;
        }
        return {
          id: l.slice(0, tab).trim(),
          body: l
            .slice(tab + 1)
            .replaceAll(String.raw`\n`, '\n')
            .replaceAll(String.raw`\t`, '\t'),
        };
      })
      .filter((r): r is { id: string; body: string } => r !== null);
    for (const row of rows) {
      rev.replyThread(row.id, row.body);
      console.error(`act: replied on ${row.id}`);
      disposition(row.id, /deferred to \S+/i.test(row.body) ? 'deferred' : 'replied');
    }
    console.error(`act reply: ${rows.length} repl(ies)`);
    if (skipped > 0) {
      console.error(`warning: ${skipped} line(s) had no <thread_id><TAB><body> shape — skipped`);
      process.exitCode = 1;
    }
    dropActState();
    return;
  }
  const id = threadArg(argv);
  const comment = commentArg(argv);
  if (!comment) {
    console.error('error: --comment required (or --file TSV)');
    usage();
  }
  rev.replyThread(id, comment!);
  console.error(`act: replied on ${id}`);
  // the documented defer flow replies "deferred to <bead>" then
  // resolves silently — journaled as deferred here (stats join
  // first-hit wins) so the silent resolve's 'fixed' can't mask it
  disposition(id, /deferred to \S+/i.test(comment!) ? 'deferred' : 'replied');
  dropActState();
}

/** The dismissal note the host records — `--message` overrides; the
 *  default names the rule that made the veto dismissible so the PR's
 *  review history reads honestly afterwards. */
const DEFAULT_DISMISS_MESSAGE = 'stale review — all referenced threads resolved (bro act dismiss)';

/**
 * `bro act dismiss` — clear STALE standing veto reviews
 * (reviewDecision=CHANGES_REQUESTED whose referenced threads are all
 * resolved+outdated — bro-n1foa). The stale filter is the safety: a
 * live veto is refused by construction, never by a flag the caller
 * must remember — re-review is the reviewer's call, dismissal is only
 * ever offered on settled evidence. Strict PR resolution: a mutation
 * never guesses which PR's reviews to clear.
 */
async function cmdDismiss(argv: string[]): Promise<void> {
  const cfg = loadBroConfig();
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: cfg.connectors });
  const rev = reviewHost(undefined, cfg.connectors);
  const t = resolvePr(rev, argv, 'strict');
  if (rev.vetoReviews === undefined || rev.dismissReview === undefined) {
    console.error(
      `error: ${rev.prLink(t.repo, t.pr)} — this review host cannot enumerate or dismiss reviews`
    );
    process.exitCode = 1;
    return;
  }
  // a mutation validates its target's lifecycle — dismissing reviews on
  // a merged/closed PR clears nothing that still gates and only looks
  // like it did something
  const meta = rev.prMetaAsync !== undefined ? await rev.prMetaAsync(t) : rev.prMeta(t);
  if (meta.state !== 'OPEN') {
    console.error(
      `error: ${rev.prLink(t.repo, t.pr)} is ${meta.state} — only OPEN PRs carry a live veto`
    );
    process.exitCode = 1;
    return;
  }
  // fresh probe, never the shared feed — the enumeration IS the
  // decision input, same rule as the merge gate (bro-0tcrl)
  const vetoes = await rev.vetoReviews(t);
  const stale = vetoes.filter(v => v.stale);
  // stale ⇒ ≥1 referenced thread — the count is always real here
  const describe = (v: VetoReview): string =>
    `${v.author}'s review ${v.id} — ${v.threads} thread(s) resolved+outdated`;
  if (argv.includes('--dry-run')) {
    if (stale.length === 0) {
      console.log(
        vetoes.length === 0
          ? 'act dismiss: no standing veto reviews'
          : `act dismiss: ${vetoes.length} veto(s) stand, none stale — nothing to dismiss`
      );
      return;
    }
    for (const v of stale) {
      console.log(`would dismiss ${describe(v)}${vetoBodyNote(v)}`);
    }
    return;
  }
  if (stale.length === 0) {
    console.log(
      vetoes.length === 0
        ? 'act dismiss: no standing veto reviews'
        : `act dismiss: ${vetoes.length} veto(s) stand but none are stale — wait for re-review`
    );
    return;
  }
  // re-read immediately before mutating: a thread reopened (or a fresh
  // objection posted) between the first probe and the dismissal loop
  // must not be cleared off a stale snapshot — the window can't fully
  // close without a host lock, but this narrows it to the mutation
  // call itself (coderabbit on PR #1020). The fresh veto objects are
  // the ones dismissed — author/threads may have moved too.
  const fresh = await rev.vetoReviews(t);
  const stillStale = new Map(fresh.filter(v => v.stale).map(v => [v.id, v]));
  const toDismiss = stale
    .map(v => stillStale.get(v.id))
    .filter((v): v is VetoReview => v !== undefined);
  for (const v of stale) {
    if (!stillStale.has(v.id)) {
      console.log(`act: ${describe(v)} no longer stale on re-read — skipped`);
    }
  }
  if (toDismiss.length === 0) {
    console.log('act dismiss: no veto still stale — nothing dismissed');
    return;
  }
  const message = flag(argv, '--message') ?? DEFAULT_DISMISS_MESSAGE;
  let failed = 0;
  for (const candidate of toDismiss) {
    // re-probe before EACH mutation, not only once before the loop: a
    // thread reopened by an earlier dismissal in this same batch must
    // not be cleared off the batch snapshot — the residual window
    // narrows to this entry's own probe→mutation gap (no host lock
    // closes it fully; codeant/coderabbit on PR #1020). The fresh
    // veto object is the one dismissed — author/threads may have moved.
    const probed = await rev.vetoReviews(t);
    const v = probed.find(c => c.id === candidate.id && c.stale);
    if (v === undefined) {
      console.log(`act: ${describe(candidate)} no longer stale on re-read — skipped`);
      continue;
    }
    // the body surfaces BEFORE the mutation — a body-level objection is
    // invisible to the thread rule, so the operator/agent deciding the
    // dismissal reads the whole review here
    console.log(`dismissing ${describe(v)}${vetoBodyNote(v)}`);
    try {
      rev.dismissReview?.(t, v.id, message);
      console.log(`act: dismissed ${describe(v)}`);
      emitLifecycle(process.cwd(), {
        kind: 'verdict',
        pr: t.pr,
        to: 'dismissed',
        detail: { via: 'act', review: v.id, author: v.author },
      });
    } catch (err) {
      failed += 1;
      console.error(
        `act: dismissing ${describe(v)} failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  // a dismissal moves reviewDecision — the shared feed's next read
  // must fetch, not serve the pre-dismissal veto for up to a TTL
  dropActState(t);
  if (failed > 0) {
    console.error(`act dismiss: ${failed} of ${toDismiss.length} dismissal(s) failed`);
    process.exitCode = 1;
  }
}

// a Map keeps the dispatch table off dynamic object indexing — a
// runtime-keyed `COMMANDS[cmd]` retrieval-then-call trips
// object-injection scanners
const COMMANDS = new Map<string, (argv: string[]) => void | Promise<void>>([
  ['status', cmdStatus],
  ['wait', cmdWait],
  ['merge', cmdMerge],
  ['rearm', cmdRearm],
  ['threads', cmdThreads],
  ['resolve', cmdResolve],
  ['reply', cmdReply],
  ['dismiss', cmdDismiss],
]);

/** Defer a thread into a debt bead — the skill's mechanics as code:
 *  `bd create -l debt --external-ref <thread>`, reply with the bead id,
 *  then resolve. Fails loudly when bd can't create — never resolves a
 *  defer that didn't land. */
function deferThread(
  rev: ReviewFacade,
  v: ActThreadVerdict,
  ownerRepo: string | null,
  pr?: number
): string {
  const desc =
    pr && ownerRepo
      ? `deferred from PR ${rev.prLink(ownerRepo, pr)} thread ${v.thread_id}`
      : pr
        ? `deferred from PR #${pr} thread ${v.thread_id}`
        : `deferred thread ${v.thread_id}`;
  if (!v.title) {
    throw new Error(`defer verdict for ${v.thread_id} has no title`);
  }
  const bead = claimStore(process.cwd()).create({
    title: v.title,
    labels: ['debt'],
    description: desc,
    externalRef: v.thread_id,
  }).id;
  const reply = `deferred to ${bead}${v.comment ? ` — ${v.comment}` : ''}`;
  rev.replyThread(v.thread_id, reply);
  rev.resolveThread(v.thread_id);
  disposition(v.thread_id, 'deferred', pr);
  return bead;
}

function replyVerdict(rev: ReviewFacade, v: ActThreadVerdict, pr?: number): void {
  if (!v.comment) {
    throw new Error(`reply verdict for ${v.thread_id} has no comment`);
  }
  rev.replyThread(v.thread_id, v.comment);
  console.error(`act: replied on ${v.thread_id}`);
  disposition(v.thread_id, 'replied', pr);
}

function resolveVerdict(rev: ReviewFacade, v: ActThreadVerdict, pr?: number): void {
  if (v.comment) {
    rev.replyThread(v.thread_id, v.comment);
  }
  rev.resolveThread(v.thread_id);
  console.error(`act: resolved ${v.thread_id}`);
  disposition(v.thread_id, v.comment ? 'rejected' : 'fixed', pr);
}

/** Apply an `act` plan (`bro run act.toml`) — batch thread verdicts.
 *  One bad verdict doesn't abort the rest; failures list at the end. */
export function applyActPlan(plan: ActPlan): void {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  // no upfront beads check — a defer without bd/.beads fails that one
  // verdict (thread stays unresolved, per the skill's fallback rule)
  // instead of blocking every other verdict in the plan
  const failed: string[] = [];
  // lazy: only a defer verdict pays the repo-resolution call — and
  // outside a clone it can't pay at all; null falls back to the bare-#
  // bead description rather than failing a valid defer plan.
  // undefined = not yet attempted.
  let ownerRepo: string | null | undefined;
  const repoForDefers = (): string | null => {
    if (ownerRepo !== undefined) {
      return ownerRepo;
    }
    // a failed resolve isn't cached — one transient outage must not
    // degrade every later defer in the same plan
    try {
      return (ownerRepo = rev.resolveRepo([]));
    } catch {
      return null;
    }
  };
  for (const v of plan.threads) {
    try {
      if (v.action === 'reply') {
        replyVerdict(rev, v, plan.pr);
      } else if (v.action === 'defer') {
        console.error(
          `act: deferred ${v.thread_id} → ${deferThread(rev, v, repoForDefers(), plan.pr)}`
        );
      } else {
        resolveVerdict(rev, v, plan.pr);
      }
    } catch (err) {
      failed.push(v.thread_id);
      console.error(
        `act: ${v.thread_id} failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (plan.threads.length > 0) {
    dropActState();
  }
  if (failed.length > 0) {
    console.error(`act plan: ${failed.length} verdict(s) failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

export async function runActCommand(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  // zero-arg magic: bare `bro act` is the gate on the current branch's PR
  if (!cmd) {
    await cmdStatus([]);
    return;
  }
  if (cmd === '--help' || cmd === '-h') {
    usage(0);
  }
  const handler = COMMANDS.get(cmd);
  if (!handler) {
    console.error(`unknown command: ${cmd}`);
    usage();
  }
  if (hasHelpFlag(rest)) {
    usage(0);
  }
  await handler(rest);
}
