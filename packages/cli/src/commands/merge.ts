/**
 * `bro merge <PR>` — the full merge cycle as one verb (spec:
 * specs/bro-merge.md). Composes the act verbs: ready → the act exit-gate
 * poll → automerge (pinned direct merge when the host has none) →
 * settle poll → retrospect record → bead close. Re-entrant: every
 * finished phase is a no-op on re-run, so `bro merge` after fixing a
 * blocker resumes where it left off.
 */

import {
  type GateWaitResult,
  type PrActState,
  prStateCache,
  resolveLedger,
  waitForGate,
} from '@broject/act';
import {
  emitLifecycle,
  ensureAuth,
  type ExitCode,
  facadeName,
  ghTry,
  hasHelpFlag,
  mergeQueueHost,
  printUsage,
  type ReviewFacade,
  reviewHost,
} from '@broject/core';
import { recordRetro } from '@broject/retro';
import { loadBroConfig } from '../plugins.ts';
import {
  closeLandedBead,
  gateStateFetcher,
  landPr,
  mergeMethod,
  type ResolvedTarget,
  reportActOutcome,
  resolvePr,
  waitOpts,
  warnHumanOwned,
} from './act.ts';
import { flag } from './args.ts';
import { reconcileOutcomes } from './outcome-report.ts';

function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `Usage: bro merge <PR> [flags]

The full merge cycle as one verb — ready → gate → automerge → retro.

Phases (each idempotent — a finished phase is a no-op on re-run):
  ready      draft PR → mark-ready on the host
  gate       the act exit-gate poll (threads/CI/SAST/conflict/BEHIND)
  automerge  green → enable the host's auto-merge (pinned merge fallback)
  settle     poll until MERGED / CLOSED / timeout
  retro      MERGED → record the cycle's findings as a retro bead
  bead       --bead discharges the claimed bead on MERGED

Flags:
  --squash|--merge|--rebase   merge strategy (default: squash)
  --bead <id>[,<id>…]         beads the merge discharges
  --no-retro                  skip the post-merge retro record
  --interval <s>              poll cadence (default 60)
  --timeout <m>               poll budget per wait phase (default 45)
  --admin                     allow the fallback merge to bypass review rules
  --json                      final verdict as one JSON line`,
    exitCode
  );
}

/** The cycle's carry-through — what a phase hands the next one. */
interface MergeCtx {
  rev: ReviewFacade;
  /** Resolved reviews-connector name — host mutations that only gh can
   *  do (ready, --auto) guard on it instead of mutating the wrong host. */
  host: string;
  queue: ReturnType<typeof mergeQueueHost>;
  t: ResolvedTarget;
  argv: string[];
  json: boolean;
  method: NonNullable<ReturnType<typeof mergeMethod>>;
  fetcher: ReturnType<typeof gateStateFetcher>;
  opts: NonNullable<Parameters<typeof waitForGate>[1]>;
  started: number;
  cache: ReturnType<typeof prStateCache>;
  /** Thread ids the cycle opened on — the retro's evidence. */
  threadsAtStart: string[];
  /** Why the host still owns the landing on a settle timeout. */
  armedNote?: string;
  /** landPr emits its own merged event — the run's emit must not double it. */
  mergedEventEmitted?: boolean;
}

/** Status chatter: stderr under --json so stdout stays one verdict line. */
function note(ctx: MergeCtx, msg: string): void {
  if (ctx.json) console.error(msg);
  else console.log(msg);
}

/** mark-ready is a host mutation the facade doesn't expose — `gh pr
 *  ready` is the GitHub path; other hosts fail loud instead of gh
 *  resolving the same owner/repo on the wrong host. */
function markReady(ctx: MergeCtx): void {
  const { t } = ctx;
  if (ctx.host !== 'github') {
    throw new Error(`mark-ready unsupported on reviews connector "${ctx.host}"`);
  }
  const r = ghTry(['pr', 'ready', String(t.pr), '-R', t.repo]);
  if (r.code !== 0) {
    throw new Error(`mark-ready failed on ${t.repo}#${t.pr}: ${r.err || r.out}`);
  }
}

/** Enable the host's auto-merge for the chosen strategy. Returns false
 *  when the host refuses (auto-merge disabled, unsupported host) — the
 *  caller falls back to the pinned direct merge. */
function enableAutoMerge(ctx: MergeCtx): boolean {
  const { t, method } = ctx;
  if (ctx.host !== 'github') return false;
  const r = ghTry(['pr', 'merge', String(t.pr), `--${method}`, '--auto', '-R', t.repo]);
  if (r.code === 0) return true;
  const err = r.err || r.out;
  // auto-merge actually landing the PR reads as success for the cycle —
  // "already merged" / terminal-state refusals still fall through to the
  // pinned merge, which resolves the already-landed case itself.
  console.error(`merge: auto-merge refused (${err}) — falling back to a pinned merge`);
  return false;
}

/** One numeric flag as a positive number — bad input is a usage error,
 *  not a silently weird wait. */
function positiveNum(raw: string | undefined, fallback: string, name: string): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`error: ${name} must be a positive number`);
    process.exit(2);
  }
  return n;
}

/** Poll cadence (seconds) and budget (minutes). */
function parseTiming(argv: string[]): { interval: number; timeout: number } {
  return {
    interval: positiveNum(flag(argv, '--interval'), '60', '--interval'),
    timeout: positiveNum(flag(argv, '--timeout'), '45', '--timeout'),
  };
}

/** Flags, auth, hosts — everything before the first poll. */
function setupCycle(argv: string[]): MergeCtx {
  const cfg = loadBroConfig();
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: cfg.connectors });
  const rev = reviewHost(undefined, cfg.connectors);
  const queue = mergeQueueHost(undefined, cfg.connectors);
  if (queue) {
    ensureAuth('mergeQueue', { dir: process.cwd() }, { prefer: cfg.connectors });
  }
  const t = resolvePr(rev, argv, 'strict');
  const method = mergeMethod(argv);
  if (!method) {
    process.exit(2);
  }
  const cache = prStateCache(process.cwd());
  const json = argv.includes('--json');
  // every status print (own + shared act helpers) is chatter — under
  // --json only the verdict line belongs on stdout
  if (json) console.log = console.error;
  return {
    rev,
    host: facadeName('reviews', { dir: process.cwd() }, { prefer: cfg.connectors }),
    queue,
    t,
    argv,
    json,
    method,
    fetcher: gateStateFetcher(rev, t, cfg.act, cache, resolveLedger(process.cwd())),
    opts: waitOpts(rev, t, argv, parseTiming(argv), cache, 'merge wait') ?? {},
    started: Date.now(),
    cache,
    threadsAtStart: [],
  };
}

/** A draft gates nothing — mark ready on the host and refresh the
 *  feed entry. Returns the snapshot the cycle opened on (the retro
 *  reads its thread ids). */
function readyPhase(ctx: MergeCtx, first: Awaited<ReturnType<MergeCtx['fetcher']>>): boolean {
  if (first.state.state !== 'OPEN' || !first.state.isDraft) return true;
  try {
    markReady(ctx);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return false;
  }
  // the ready flip obsoletes the feed entry — the gate must fetch the
  // post-ready state, not re-serve the draft snapshot it blocked on
  ctx.cache?.invalidate(ctx.t);
  note(ctx, `merge: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} marked ready`);
  emitLifecycle(process.cwd(), {
    kind: 'gate',
    pr: ctx.t.pr,
    to: 'ready',
    detail: { via: 'merge', sha: first.state.headSha },
  });
  return true;
}

/** Settle's failure exit — one shape for closed / timeout / armed-timeout. */
function settleFail(
  ctx: MergeCtx,
  res: GateWaitResult,
  verdict: string,
  state: PrActState
): undefined {
  emitVerdict(gateVerdict(ctx, res), verdict, state, ctx.argv);
  if (ctx.armedNote !== undefined) {
    console.error(
      `merge: ${ctx.armedNote} on ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} — poll timed out; ` +
        'the host still owns the merge'
    );
  }
  process.exitCode = 1;
  return undefined;
}

/** The settle poll after a merge was armed or enqueued — the gate
 *  waits for *green*, settle waits for *terminal*: a green-but-still-open
 *  PR is the host mid-merge, not a timeout. Returns the landed state or
 *  reports and exits. */
async function settlePhase(ctx: MergeCtx, res: GateWaitResult): Promise<PrActState | undefined> {
  const deadline = Date.now() + (ctx.opts.timeoutMs ?? 45 * 60_000);
  const interval = ctx.opts.intervalMs ?? 60_000;
  const follow = await ctx.fetcher();
  if (follow.state.state === 'MERGED') return follow.state;
  if (follow.state.state !== 'OPEN') return settleFail(ctx, res, 'closed', follow.state);
  if (Date.now() >= deadline) {
    return settleFail(ctx, res, ctx.armedNote ? 'armed-timeout' : 'timeout', follow.state);
  }
  await new Promise(r => setTimeout(r, interval));
  return settlePhase(ctx, res);
}

/** The gate's green snapshot may be stale — a moved head or a dropped
 *  verdict re-enters the gate rather than merging unchecked commits. */
async function gateDrifted(ctx: MergeCtx, res: GateWaitResult): Promise<boolean> {
  ctx.cache?.invalidate(ctx.t);
  const fresh = await ctx.fetcher();
  return fresh.state.headSha !== res.state.headSha || !fresh.gate.ok;
}

/** The armed path — gh --auto hands landing to the host; settle watches. */
function armedSettle(ctx: MergeCtx, res: GateWaitResult): Promise<PrActState | undefined> {
  note(ctx, `merge: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} — auto-merge armed (${ctx.method})`);
  emitLifecycle(process.cwd(), {
    kind: 'gate',
    pr: ctx.t.pr,
    to: 'automerge',
    detail: { via: 'merge', sha: res.state.headSha, method: ctx.method },
  });
  ctx.armedNote = 'auto-merge armed';
  return settlePhase(ctx, res);
}

/** The pinned path — landPr merges directly or enqueues on the
 *  configured external queue (which owns the landing from there). */
function pinnedLand(ctx: MergeCtx, res: GateWaitResult): Promise<PrActState | undefined> {
  const head = landPr(
    ctx.rev,
    ctx.t,
    { method: ctx.method, admin: ctx.argv.includes('--admin') },
    { ref: res.state.headRef, sha: res.state.headSha },
    ctx.queue
  );
  if (head !== undefined) {
    ctx.mergedEventEmitted = true; // landPr emitted 'merged' itself
    return Promise.resolve(res.state);
  }
  if (process.exitCode === 1) {
    emitVerdict(gateVerdict(ctx, res), 'merge-failed', res.state, ctx.argv);
    return Promise.resolve(undefined);
  }
  // enqueued on an external merge queue — settle is still a poll
  ctx.armedNote ??= 'merge queued';
  return settlePhase(ctx, res);
}

/** Gate green: arm the host's auto-merge, or fall back to the pinned
 *  merge / external queue. Returns the landed state or exits. */
async function landPhase(ctx: MergeCtx, res: GateWaitResult): Promise<PrActState | undefined> {
  warnHumanOwned(ctx.rev, ctx.t);
  if (await gateDrifted(ctx, res)) {
    note(ctx, 'merge: gate state moved since green — re-entering the gate');
    const again = await gatePhase(ctx);
    return again === undefined ? undefined : landPhase(ctx, again);
  }
  // a configured merge queue owns landing — gh --auto would bypass it
  if (!ctx.queue && enableAutoMerge(ctx)) return armedSettle(ctx, res);
  return pinnedLand(ctx, res);
}

/** The act exit-gate poll, verbatim. A green gate (or a terminal
 *  state) passes through; a settled blocker reports and ends the run
 *  — re-entry resumes, finished phases no-op. */
async function gatePhase(ctx: MergeCtx): Promise<GateWaitResult | undefined> {
  const res = await waitForGate(ctx.fetcher, ctx.opts);
  const verdict = gateVerdict(ctx, res);
  if (!res.gate.ok && res.state.state === 'OPEN') {
    for (const b of res.gate.blockers) {
      console.error(`  blocker: ${b}`);
    }
    console.error(
      `merge: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} blocked — fix and re-run; ` +
        'finished phases no-op on re-entry'
    );
    emitVerdict(verdict, 'blocked', res.state, ctx.argv);
    process.exitCode = 1;
    return undefined;
  }
  if (res.state.state === 'CLOSED') {
    console.error(`error: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} is CLOSED — nothing to merge`);
    emitVerdict(verdict, 'closed', res.state, ctx.argv);
    process.exitCode = 1;
    return undefined;
  }
  return res;
}

/** The cycle's first read — a transient host error aborts the run before
 *  any phase; one retry keeps a hiccup from killing a re-entry. */
async function firstFetch(ctx: MergeCtx): Promise<Awaited<ReturnType<MergeCtx['fetcher']>>> {
  try {
    return await ctx.fetcher();
  } catch {
    await new Promise(r => setTimeout(r, 5000));
    return ctx.fetcher();
  }
}

export async function runMergeCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv)) usage();
  const ctx = setupCycle(argv);
  try {
    await reconcileOutcomes(process.cwd());
  } catch {
    /* housekeeping, never a gate */
  }

  const first = await firstFetch(ctx);
  ctx.threadsAtStart = first.state.threads.map(th => th.id);
  if (await alreadyLanded(ctx, first)) return;
  if (!readyPhase(ctx, first)) return;

  const res = await gatePhase(ctx);
  if (res === undefined) return;
  const landed = res.state.state === 'MERGED' ? res.state : await landPhase(ctx, res);
  if (landed === undefined) return;
  await finishCycle(ctx, res, landed);
}

/** Re-entry on a landed PR: phases all no-op — report the record, never
 *  re-record it (retro/bead writes don't replay). */
async function alreadyLanded(
  ctx: MergeCtx,
  first: Awaited<ReturnType<MergeCtx['fetcher']>>
): Promise<boolean> {
  if (first.state.state !== 'MERGED') return false;
  note(ctx, `merge: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} already MERGED`);
  emitVerdict(
    gateVerdict(ctx, { ...first, polls: 0, timedOut: false }),
    'already-merged',
    first.state,
    ctx.argv
  );
  await discharge(ctx, first.state);
  return true;
}

/** --bead close + outcome record — one shape for the early and the
 *  full-cycle success paths. */
async function discharge(ctx: MergeCtx, state: PrActState): Promise<void> {
  const bead = flag(ctx.argv, '--bead');
  if (bead !== undefined) {
    closeLandedBead(ctx.rev, ctx.t, bead);
  }
  await reportActOutcome(ctx.argv, ctx.t, state, 'merged');
}

/** The success tail — merged event (unless landPr emitted its own),
 *  verdict on the LANDED state, bead close, outcome, cycle retro. */
async function finishCycle(ctx: MergeCtx, res: GateWaitResult, landed: PrActState): Promise<void> {
  note(ctx, `merge: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} MERGED`);
  if (!ctx.mergedEventEmitted) {
    emitLifecycle(process.cwd(), {
      kind: 'merge',
      pr: ctx.t.pr,
      to: 'merged',
      // the landed SHA, not the gate-green one — auto-merge and merge
      // queues land a head the gate never saw
      detail: { via: 'merge', sha: landed.headSha },
    });
  }
  emitVerdict(gateVerdict(ctx, res), 'merged', landed, ctx.argv);

  await discharge(ctx, landed);

  // —— phase: retro ——
  if (!ctx.argv.includes('--no-retro')) {
    recordCycleRetro(ctx, res, landed);
  }
}

function gateVerdict(ctx: MergeCtx, res: GateWaitResult): Record<string, unknown> {
  return {
    pr: ctx.rev.prLink(ctx.t.repo, ctx.t.pr),
    open_threads: res.gate.open_threads,
    fix_rounds: res.gate.fix_rounds,
    polls: res.polls,
    timed_out: res.timedOut,
    blockers: res.gate.blockers,
  };
}

function emitVerdict(
  base: Record<string, unknown>,
  verdict: string,
  state: PrActState,
  argv: string[]
): void {
  if (argv.includes('--json')) {
    // console.log is stderr under --json — the verdict is stdout's only line
    process.stdout.write(`${JSON.stringify({ ...base, verdict, state: state.state })}\n`);
  } else {
    console.log(`merge: verdict=${verdict}`);
  }
}

/** The cycle's evidence as a retro record — resolved threads, blockers
 *  the run saw, fix rounds, wall time — plus one backlog action that
 *  turns the raw findings into prevention work. A failed retro write
 *  warns; it never un-merges (spec: infra failures don't block). */
function recordCycleRetro(ctx: MergeCtx, res: GateWaitResult, landed: PrActState): void {
  const { state } = res;
  const { threadsAtStart, started } = ctx;
  const link = ctx.rev.prLink(ctx.t.repo, ctx.t.pr);
  const minutes = Math.round((Date.now() - started) / 60_000);
  try {
    const retro = recordRetro({
      what: `merge cycle for ${link}: ${threadsAtStart.length} thread(s) at start, ${state.fixRounds} fix round(s), ${minutes}m wall`,
      why: 'full MR cycle retro — `bro merge` records what the gate and reviewers surfaced so prevention lands where the finding lives',
      scope: 'project',
      // a cycle retro answers no wtf — without the explicit null
      // recordRetro closes whichever single wtf bead happens to be open
      wtf: null,
      evidence: [
        `pr: ${link}`,
        // the landed head, not the gate-green one — the queue may have
        // landed a commit the gate snapshot predates
        `head: ${landed.headSha}`,
        `threads at start: ${threadsAtStart.length ? threadsAtStart.join(', ') : 'none'}`,
        `threads at land: ${landed.threads.length ? landed.threads.map(t => t.id).join(', ') : 'none'}`,
        `blockers seen: ${res.gate.blockers.length ? res.gate.blockers.join('; ') : 'none'}`,
        `fix rounds: ${state.fixRounds}`,
        `wall time: ${minutes}m`,
      ],
      actions: [
        {
          title: `classify merge-cycle findings for ${link} into prevention actions`,
          sink: 'backlog',
          detail:
            `The bro merge cycle recorded ${threadsAtStart.length} thread(s) and ` +
            `${state.fixRounds} fix round(s). Review the retro's evidence and turn ` +
            'recurring finding classes into AGENTS.md / skill / spec preventions.',
        },
      ],
    });
    console.log(`merge: retro recorded as ${retro.retroId}`);
  } catch (err) {
    console.error(
      `merge: retro record failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
