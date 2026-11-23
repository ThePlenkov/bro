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
import type { ExitCode } from '@broject/core';
import {
  emitLifecycle,
  ensureAuth,
  ghTry,
  hasHelpFlag,
  mergeQueueHost,
  type PrTarget,
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
  queue: ReturnType<typeof mergeQueueHost>;
  t: ResolvedTarget;
  argv: string[];
  method: NonNullable<ReturnType<typeof mergeMethod>>;
  fetcher: ReturnType<typeof gateStateFetcher>;
  opts: Parameters<typeof waitForGate>[1];
  started: number;
}

/** mark-ready is a host mutation the facade doesn't expose — `gh pr
 *  ready` is the GitHub path; other hosts fail loud with their own
 *  error instead of silently merging a draft. */
function markReady(t: PrTarget): void {
  const r = ghTry(['pr', 'ready', String(t.pr), '-R', t.repo]);
  if (r.code !== 0) {
    throw new Error(`mark-ready failed on ${t.repo}#${t.pr}: ${r.err || r.out}`);
  }
}

/** Enable the host's auto-merge for the chosen strategy. Returns false
 *  when the host refuses (auto-merge disabled, unsupported host) — the
 *  caller falls back to the pinned direct merge. */
function enableAutoMerge(t: PrTarget, method: string): boolean {
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
  return {
    rev,
    queue,
    t,
    argv,
    method,
    fetcher: gateStateFetcher(rev, t, cfg.act, cache, resolveLedger(process.cwd())),
    opts: waitOpts(rev, t, argv, parseTiming(argv), cache, 'merge wait'),
    started: Date.now(),
  };
}

/** A draft gates nothing — mark ready on the host and refresh the
 *  feed entry. Returns the snapshot the cycle opened on (the retro
 *  reads its thread ids). */
async function readyPhase(ctx: MergeCtx, first: Awaited<ReturnType<MergeCtx['fetcher']>>) {
  if (first.state.state !== 'OPEN' || !first.state.isDraft) return;
  markReady(ctx.t);
  console.log(`merge: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} marked ready`);
  emitLifecycle(process.cwd(), {
    kind: 'gate',
    pr: ctx.t.pr,
    to: 'ready',
    detail: { via: 'merge', sha: first.state.headSha },
  });
}

/** The settle poll after a merge was armed or enqueued — one shape for
 *  both paths. Returns the landed state or reports and exits. */
async function settlePhase(
  ctx: MergeCtx,
  res: GateWaitResult,
  armedNote?: string
): Promise<PrActState | undefined> {
  const follow = await waitForGate(ctx.fetcher, ctx.opts);
  if (follow.state.state === 'MERGED') return follow.state;
  emitVerdict(
    gateVerdict(ctx.rev, ctx.t, res),
    follow.state.state === 'CLOSED' ? 'closed' : 'timeout',
    follow,
    ctx.argv
  );
  if (armedNote !== undefined) {
    console.error(
      `merge: ${armedNote} on ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} — poll timed out; ` +
        'the host still owns the merge'
    );
  }
  process.exitCode = 1;
  return undefined;
}

/** Gate green: arm the host's auto-merge, or fall back to the pinned
 *  merge / external queue. Returns the landed state or exits. */
async function landPhase(ctx: MergeCtx, res: GateWaitResult): Promise<PrActState | undefined> {
  warnHumanOwned(ctx.rev, ctx.t);
  if (enableAutoMerge(ctx.t, ctx.method)) {
    console.log(
      `merge: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} — auto-merge armed (${ctx.method})`
    );
    emitLifecycle(process.cwd(), {
      kind: 'gate',
      pr: ctx.t.pr,
      to: 'automerge',
      detail: { via: 'merge', sha: res.state.headSha, method: ctx.method },
    });
    return settlePhase(ctx, res, 'auto-merge armed');
  }
  const head = landPr(
    ctx.rev,
    ctx.t,
    { method: ctx.method, admin: ctx.argv.includes('--admin') },
    { ref: res.state.headRef, sha: res.state.headSha },
    ctx.queue
  );
  if (head !== undefined) return res.state;
  if (process.exitCode === 1) {
    emitVerdict(gateVerdict(ctx.rev, ctx.t, res), 'merge-failed', res, ctx.argv);
    return undefined;
  }
  // enqueued on an external merge queue — settle is still a poll
  return settlePhase(ctx, res);
}

/** The act exit-gate poll, verbatim. A green gate (or a terminal
 *  state) passes through; a settled blocker reports and ends the run
 *  — re-entry resumes, finished phases no-op. */
async function gatePhase(ctx: MergeCtx): Promise<GateWaitResult | undefined> {
  const res = await waitForGate(ctx.fetcher, ctx.opts);
  const verdict = gateVerdict(ctx.rev, ctx.t, res);
  if (!res.gate.ok && res.state.state === 'OPEN') {
    for (const b of res.gate.blockers) {
      console.error(`  blocker: ${b}`);
    }
    console.error(
      `merge: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} blocked — fix and re-run; ` +
        'finished phases no-op on re-entry'
    );
    emitVerdict(verdict, 'blocked', res, ctx.argv);
    process.exitCode = 1;
    return undefined;
  }
  if (res.state.state === 'CLOSED') {
    console.error(`error: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} is CLOSED — nothing to merge`);
    emitVerdict(verdict, 'closed', res, ctx.argv);
    process.exitCode = 1;
    return undefined;
  }
  return res;
}

export async function runMergeCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv)) usage();
  const ctx = setupCycle(argv);
  try {
    await reconcileOutcomes(process.cwd());
  } catch {
    /* housekeeping, never a gate */
  }

  const first = await ctx.fetcher();
  const threadsAtStart = first.state.threads.map(th => th.id);
  await readyPhase(ctx, first);

  const res = await gatePhase(ctx);
  if (res === undefined) return;
  const landed = res.state.state === 'MERGED' ? res.state : await landPhase(ctx, res);
  if (landed === undefined) return;

  console.log(`merge: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} MERGED`);
  emitLifecycle(process.cwd(), {
    kind: 'merge',
    pr: ctx.t.pr,
    to: 'merged',
    detail: { via: 'merge', sha: res.state.headSha },
  });
  emitVerdict(gateVerdict(ctx.rev, ctx.t, res), 'merged', res, argv);

  const bead = flag(argv, '--bead');
  if (bead !== undefined) {
    closeLandedBead(ctx.rev, ctx.t, bead);
  }
  await reportActOutcome(argv, ctx.t, landed, 'merged');

  // —— phase: retro ——
  if (!argv.includes('--no-retro')) {
    recordCycleRetro(ctx.rev, ctx.t, res.state, threadsAtStart, ctx.started);
  }
}

function gateVerdict(rev: ReviewFacade, t: PrTarget, res: GateWaitResult): Record<string, unknown> {
  return {
    pr: rev.prLink(t.repo, t.pr),
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
  res: GateWaitResult,
  argv: string[]
): void {
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...base, verdict, state: res.state.state }));
  } else {
    console.log(`merge: verdict=${verdict}`);
  }
}

/** The cycle's evidence as a retro record — resolved threads, blockers
 *  the run saw, fix rounds, wall time — plus one backlog action that
 *  turns the raw findings into prevention work. A failed retro write
 *  warns; it never un-merges (spec: infra failures don't block). */
function recordCycleRetro(
  rev: ReviewFacade,
  t: PrTarget,
  state: PrActState,
  threadsAtStart: string[],
  started: number
): void {
  const link = rev.prLink(t.repo, t.pr);
  const minutes = Math.round((Date.now() - started) / 60_000);
  try {
    const res = recordRetro({
      what: `merge cycle for ${link}: ${threadsAtStart.length} thread(s) at start, ${state.fixRounds} fix round(s), ${minutes}m wall`,
      why: 'full MR cycle retro — `bro merge` records what the gate and reviewers surfaced so prevention lands where the finding lives',
      scope: 'project',
      evidence: [
        `pr: ${link}`,
        `head: ${state.headSha}`,
        `threads at start: ${threadsAtStart.length ? threadsAtStart.join(', ') : 'none'}`,
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
    console.log(`merge: retro recorded as ${res.retroId}`);
  } catch (err) {
    console.error(
      `merge: retro record failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
