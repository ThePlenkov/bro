/**
 * `bro merge <PR>` — the full merge cycle as one verb (spec:
 * specs/bro-merge.md). Composes the act verbs: ready → the act exit-gate
 * poll → automerge (pinned direct merge when the host has none) →
 * settle poll → retrospect record → bead close. Re-entrant: every
 * finished phase is a no-op on re-run, so `bro merge` after fixing a
 * blocker resumes where it left off.
 */

import {
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
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
import { githubPrWake } from '@broject/github';
import { recordRetro } from '@broject/retro';
import { loadBroConfig } from '../plugins.ts';
import {
  closeLandedBead,
  landPr,
  mergeMethod,
  reportActOutcome,
  resolvePr,
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

export async function runMergeCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv)) usage();
  if (argv.includes('--squash') && argv.includes('--rebase')) {
    console.error('error: conflicting merge strategies: --squash --rebase');
    process.exit(2);
  }
  const cfg = loadBroConfig();
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: cfg.connectors });
  const rev = reviewHost(undefined, cfg.connectors);
  const queue = mergeQueueHost(undefined, cfg.connectors);
  if (queue) {
    ensureAuth('mergeQueue', { dir: process.cwd() }, { prefer: cfg.connectors });
  }
  const t = resolvePr(rev, argv, 'strict');
  try {
    await reconcileOutcomes(process.cwd());
  } catch {
    /* housekeeping, never a gate */
  }

  const act = cfg.act;
  const interval = Number(flag(argv, '--interval') ?? '60');
  const timeout = Number(flag(argv, '--timeout') ?? '45');
  if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(timeout) || timeout <= 0) {
    console.error('error: --interval/--timeout must be positive numbers (seconds/minutes)');
    process.exit(2);
  }
  const method = mergeMethod(argv);
  if (!method) {
    process.exit(2);
  }

  const cache = prStateCache(process.cwd());
  const ledger = resolveLedger(process.cwd());
  const fetcher = async () => {
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
  const opts = {
    intervalMs: interval * 1000,
    timeoutMs: timeout * 60_000,
    wake: () => githubPrWake(process.cwd(), t.pr),
    onPoll: (s: PrActState, g: ReturnType<typeof evaluateExitGate>) =>
      console.error(
        `merge wait ${rev.prLink(t.repo, s.pr)}: threads=${g.open_threads} ci=${g.ci_pending}+${g.ci_failing}f reviewers=${g.reviewers_pending} sast=${g.sast_pending}`
      ),
    onError: (err: unknown, n: number) =>
      console.error(
        `merge wait ${rev.prLink(t.repo, t.pr)}: fetch failed (${n}) — ${err instanceof Error ? err.message : String(err)}`
      ),
  };

  // —— phase: ready ——
  const started = Date.now();
  const first = await fetcher();
  const threadsAtStart = first.state.threads.map(th => th.id);
  if (first.state.state === 'OPEN' && first.state.isDraft) {
    markReady(t);
    cache?.invalidate(t);
    console.log(`merge: ${rev.prLink(t.repo, t.pr)} marked ready`);
    emitLifecycle(process.cwd(), {
      kind: 'gate',
      pr: t.pr,
      to: 'ready',
      detail: { via: 'merge', sha: first.state.headSha },
    });
  }

  // —— phase: gate ——
  const res = await waitForGate(fetcher, opts);
  const verdict = gateVerdict(rev, t, res);
  if (!res.gate.ok && res.state.state === 'OPEN') {
    for (const b of res.gate.blockers) {
      console.error(`  blocker: ${b}`);
    }
    console.error(
      `merge: ${rev.prLink(t.repo, t.pr)} blocked — fix and re-run; finished phases no-op on re-entry`
    );
    emitVerdict(verdict, 'blocked', res, argv);
    process.exitCode = 1;
    return;
  }
  if (res.state.state === 'CLOSED') {
    console.error(`error: ${rev.prLink(t.repo, t.pr)} is CLOSED — nothing to merge`);
    emitVerdict(verdict, 'closed', res, argv);
    process.exitCode = 1;
    return;
  }

  let landed = res.state.state === 'MERGED' ? res.state : undefined;

  // —— phase: automerge / pinned merge ——
  if (landed === undefined) {
    warnHumanOwned(rev, t);
    if (!enableAutoMerge(t, method)) {
      const head = landPr(
        rev,
        t,
        { method, admin: argv.includes('--admin') },
        { ref: res.state.headRef, sha: res.state.headSha },
        queue
      );
      landed = head === undefined ? undefined : res.state;
      if (landed === undefined && process.exitCode === 1) {
        emitVerdict(verdict, 'merge-failed', res, argv);
        return;
      }
      if (landed === undefined) {
        // enqueued on an external merge queue — settle is still a poll
        const follow = await waitForGate(fetcher, opts);
        landed = follow.state.state === 'MERGED' ? follow.state : undefined;
        if (landed === undefined) {
          emitVerdict(
            verdict,
            follow.state.state === 'CLOSED' ? 'closed' : 'timeout',
            follow,
            argv
          );
          process.exitCode = 1;
          return;
        }
      }
    } else {
      console.log(`merge: ${rev.prLink(t.repo, t.pr)} — auto-merge armed (${method})`);
      emitLifecycle(process.cwd(), {
        kind: 'gate',
        pr: t.pr,
        to: 'automerge',
        detail: { via: 'merge', sha: res.state.headSha, method },
      });
      // —— phase: settle ——
      const follow = await waitForGate(fetcher, opts);
      landed = follow.state.state === 'MERGED' ? follow.state : undefined;
      if (landed === undefined) {
        emitVerdict(verdict, follow.state.state === 'CLOSED' ? 'closed' : 'timeout', follow, argv);
        console.error(
          `merge: auto-merge armed on ${rev.prLink(t.repo, t.pr)} — poll timed out; ` +
            'the host still owns the merge'
        );
        process.exitCode = 1;
        return;
      }
    }
  }

  console.log(`merge: ${rev.prLink(t.repo, t.pr)} MERGED`);
  emitLifecycle(process.cwd(), {
    kind: 'merge',
    pr: t.pr,
    to: 'merged',
    detail: { via: 'merge', sha: res.state.headSha },
  });
  emitVerdict(verdict, 'merged', res, argv);

  const bead = flag(argv, '--bead');
  if (bead !== undefined) {
    closeLandedBead(rev, t, bead);
  }
  await reportActOutcome(argv, t, landed, 'merged');

  // —— phase: retro ——
  if (!argv.includes('--no-retro')) {
    recordCycleRetro(rev, t, res.state, threadsAtStart, started);
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
