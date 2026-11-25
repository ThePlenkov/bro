/**
 * `bro act merge` — the exit-gated merge verb and the landing pipeline
 * behind it: the queue-aware landPr, the loop-claimed bead discharge a
 * landed head owes, the closed-PR debt harvest, and the post-merge
 * local retire. Extracted from act.ts verbatim; the split helpers
 * (mergeSettledState, refuseBlockedMerge, postMergeFinalize,
 * stillClosed, requeueUncovered, releaseMergedCheckout) name the
 * conditional chunks the verbs used to carry inline.
 */
import { basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import {
  acquireMergeSlot,
  checkHistory,
  type ExitGate,
  evaluateExitGate,
  fetchPrActState,
  type PrActState,
  prStateCache,
  releaseMergeSlot,
  resolveLedger,
} from '@broject/act';
import {
  emitLifecycle,
  ensureAuth,
  facade,
  getTasks,
  gitBranchLog,
  gitCommonDir,
  gitTry,
  type MergeQueueFacade,
  mergeQueueHost,
  type PrTarget,
  prOwnership,
  type ReviewFacade,
  reviewHost,
  type TaskRow,
  type taskStore,
} from '@broject/core';
import { coveredBeadIds } from '@broject/loop';
import { loadBroConfig } from '../plugins.ts';
import { mergeMethod, type ResolvedTarget, resolvePr } from './act-args.ts';
import { landedLine, settledLabel } from './act-report.ts';
import { flag } from './args.ts';
import { type CollectArgs, collectReviewThreads, refreshDebtLedger } from './debt.ts';
import { reconcileOutcomes, reportRoutedOutcome } from './outcome-report.ts';
import {
  deleteMergedLocalBranch,
  gitDirOf,
  isLinkedGitDir,
  parseWorktreePorcelain,
  removeMergedWorktree,
  type WorktreeInfo,
} from './work.ts';

/** A mutation just landed — the shared feed's next read must fetch,
 *  not serve the pre-mutation snapshot for up to a TTL (bro-0tcrl).
 *  `t` narrows the drop to one PR; thread mutations arrive by thread
 *  id with no PR attached, so they drop the whole feed. Best-effort —
 *  a repo without a feed has nothing to drop. */
export function dropActState(t?: PrTarget): void {
  try {
    const cache = prStateCache(process.cwd());
    if (t === undefined) {
      cache?.invalidateAll();
    } else {
      cache?.invalidate(t);
    }
  } catch {
    // invalidation is freshness polish — the TTL bounds a missed drop
  }
}

/** mergePr + the landed-head handoff — a merge queue accepts a PR
 *  without landing it, so only a MERGED state returns the head.
 *  An external queue (connectors.mergeQueue) owns the merge when
 *  configured — its connector's `enqueue` replaces mergePr outright:
 *  'enqueued' parks the PR (undefined → deferred cleanup), 'merged'
 *  hands the head to cleanup same as a direct merge. */
export function landPr(
  rev: ReviewFacade,
  t: PrTarget,
  opts: { method: 'squash' | 'merge' | 'rebase'; admin: boolean },
  head: { ref: string; sha: string },
  queue?: MergeQueueFacade | null
): { ref: string; sha: string } | undefined {
  try {
    if (queue) {
      // the checkout holding the head — a checkout-bound queue (gt merge)
      // operates on that stack, not the repo root the command runs in.
      // `bro drive` merges from the main worktree while the PR's branch
      // lives in its own; cwd is the fallback (act wait --merge's shape).
      const checkout =
        parseWorktreePorcelain(gitTry(['worktree', 'list', '--porcelain']).out).find(
          w => w.branch === head.ref
        )?.path ?? process.cwd();
      const r = queue.enqueue(t, {
        dir: checkout,
        headRef: head.ref,
        expectedHeadSha: head.sha,
      });
      if (r === 'merged') {
        console.log(`act: merged ${rev.prLink(t.repo, t.pr)}`);
        emitLifecycle(process.cwd(), {
          kind: 'merge',
          pr: t.pr,
          to: 'merged',
          detail: { via: 'act', sha: head.sha, queue: true },
        });
        dropActState(t);
        return head;
      }
      console.log(
        `act: ${rev.prLink(t.repo, t.pr)} enqueued — an external merge queue owns it; ` +
          'local cleanup deferred'
      );
      emitLifecycle(process.cwd(), {
        kind: 'merge',
        pr: t.pr,
        to: 'enqueued',
        detail: { via: 'act', sha: head.sha },
      });
      dropActState(t);
      return undefined;
    }
    // expectedHeadSha pins the merge to the sha the gate evaluated —
    // a head that moved since fetch fails closed instead of landing
    // a commit the gate never saw
    const after = rev.mergePr(t, {
      method: opts.method,
      expectedHeadSha: head.sha,
      deleteBranch: true,
      admin: opts.admin,
    });
    if (after === 'MERGED') {
      console.log(`act: merged ${rev.prLink(t.repo, t.pr)}`);
      emitLifecycle(process.cwd(), {
        kind: 'merge',
        pr: t.pr,
        to: 'merged',
        detail: { via: 'act', sha: head.sha, method: opts.method },
      });
      dropActState(t);
      return head;
    }
    console.log(
      `act: ${rev.prLink(t.repo, t.pr)} accepted but state=${after} — a merge queue still owns it; ` +
        'local cleanup deferred'
    );
    emitLifecycle(process.cwd(), {
      kind: 'merge',
      pr: t.pr,
      to: 'enqueued',
      detail: { via: 'act', sha: head.sha, method: opts.method, state: after },
    });
    dropActState(t);
    return undefined;
  } catch (err) {
    console.error(`error: merge failed — ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return undefined;
  }
}

/** Ownership marking (spec bro-c650l): neither label means the PR is
 *  human-owned — landing it is the operator's override, so it warns
 *  rather than blocks. A failed labels read skips the warning:
 *  unknown is not absence, and a best-effort stamp that never landed
 *  must not make bro's own PR cry wolf on every merge. */
export function warnHumanOwned(rev: ReviewFacade, t: PrTarget): void {
  try {
    if (prOwnership(rev.labels(t)) === 'human') {
      console.error(
        `warning: ${rev.prLink(t.repo, t.pr)} carries no bro-managed/bro-review label — ` +
          'human-owned; landing anyway'
      );
    }
  } catch {
    /* advisory only */
  }
}

/** The merge decision's moving parts — argv (strategy/bead/cleanup
 *  flags), the review host, and the strict-resolved target. One struct
 *  so the settle/finalize helpers don't re-list the same three. */
interface MergeCtx {
  argv: string[];
  rev: ReviewFacade;
  t: ResolvedTarget;
}

/**
 * `bro act merge` — the exit gate as the merge precondition, not a prompt.
 * Merging through bro cannot bypass a BLOCKED gate; `gh pr merge` by hand
 * can. This is the guardrail for "merged without running the gate".
 */
export async function cmdMerge(argv: string[]): Promise<string | undefined> {
  const cfg = loadBroConfig();
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: cfg.connectors });
  const rev = reviewHost(undefined, cfg.connectors);
  // A configured external queue replaces mergePr — its auth probe runs
  // up front so a missing `gt`/`gh` fails fast, not mid-enqueue.
  const queue = mergeQueueHost(undefined, cfg.connectors);
  if (queue) {
    ensureAuth('mergeQueue', { dir: process.cwd() }, { prefer: cfg.connectors });
  }
  const t = resolvePr(rev, argv, 'strict');
  // direct merges drain the outcome outbox too — a merge intent a
  // crashed wait left behind retries here (spec bro-0ykhg.4);
  // housekeeping, never a gate on the merge itself
  try {
    await reconcileOutcomes(process.cwd());
  } catch {
    /* reconciliation is best-effort — the next pass retries */
  }

  const method = mergeMethod(argv);
  if (!method) {
    process.exitCode = 2;
    return;
  }

  // Gate evaluation + merge is ONE critical section: acquiring the slot
  // first closes the drift window between a green gate and the merge
  // (new threads/state can't sneak in while a wedged bd would otherwise
  // burn its timeout). `unavailable` (no bd, no .beads) proceeds —
  // coordination is a bonus, never a gate of its own.
  const slot = acquireMergeSlot();
  if (slot.kind === 'held') {
    console.error(
      `merge slot held by ${slot.holder} — another session is merging; ` +
        'wait for `bd merge-slot check` to report available, or `bd merge-slot release` a crashed holder'
    );
    process.exitCode = 1;
    return;
  }
  const ctx: MergeCtx = { argv, rev, t };
  let mergedHead: { ref: string; sha: string } | undefined;
  // the outcome report's measures — captured inside the merge slot,
  // delivered after it releases (the router ack never extends the
  // critical section; spec bro-0ykhg.4)
  let outcomeState: PrActState | undefined;
  try {
    const act = loadBroConfig().act;
    // deliberately OFF the shared feed: this fetch IS the merge
    // decision — a ≤ttl-old "green" must never land a PR (bro-0tcrl)
    const state = await fetchPrActState(rev, t, {
      ignoreChecks: act.ignoreChecks,
      selfCheck: act.selfCheck,
      checkHistory: checkHistory(process.cwd()),
      maxRounds: act.maxRounds,
      docsPaths: act.docsPaths,
      docsMaxRounds: act.docsMaxRounds,
      requireApproval: act.requireApproval,
      approvers: act.approvers,
      resolveLedger: resolveLedger(process.cwd()),
    });

    // a closed/merged PR can pass the gate (threads resolved, checks
    // settled) — merging it isn't a gate question, it's a lifecycle error
    if (state.state !== 'OPEN') {
      // awaited inside the slot — the harvest + outcome report must
      // finish before finally releases it, or a second act merge on
      // the same closed PR double-scans mid-harvest (pre-extraction
      // ordering; coderabbit on #1181)
      return await mergeSettledState(ctx, state);
    }

    const gate = evaluateExitGate(state, { requireApproval: act.requireApproval });
    if (!gate.ok) {
      refuseBlockedMerge(rev, t, gate);
      return;
    }

    warnHumanOwned(rev, t);

    mergedHead = landPr(
      rev,
      t,
      { method, admin: argv.includes('--admin') },
      {
        ref: state.headRef,
        sha: state.headSha,
      },
      queue
    );
    outcomeState = state;
  } finally {
    if (slot.kind === 'acquired') {
      releaseMergeSlot();
    }
  }
  // local cleanup runs AFTER the merge slot is released — it is pure git
  // plumbing and must not extend the critical section. The bead close
  // shares the ordering: a landed merge discharges the loop's claim
  // before the worktree goes away.
  if (mergedHead) {
    await postMergeFinalize(ctx, mergedHead, outcomeState);
  }
  return undefined;
}

/** The non-OPEN lifecycle branch — already landed still discharges the
 *  claim (the race where the PR merged between the wait's last green
 *  poll and this fetch), and a landed PR is a verdict, not a lifecycle
 *  error (spec: specs/bro-0i1lm.md). Returns the settled label for the
 *  MERGED case, undefined once the error is reported otherwise. */
async function mergeSettledState(ctx: MergeCtx, state: PrActState): Promise<string | undefined> {
  closeBeadIfLanded(ctx.argv, ctx.rev, ctx.t, state.state);
  await harvestClosedPr(ctx.rev, ctx.t, state.state, ctx.argv);
  if (state.state === 'MERGED') {
    // the merge goal is satisfied — a landed PR is a verdict, not a
    // lifecycle error (spec: specs/bro-0i1lm.md). The outcome
    // report rides the same already-merged reconciliation (spec
    // bro-0ykhg.4): whoever lands the PR, the router hears it once.
    console.log(landedLine(ctx.rev, ctx.t, state));
    await reportActOutcome(ctx.argv, ctx.t, state, 'merged');
    return settledLabel(state);
  }
  console.error(
    `error: ${ctx.rev.prLink(ctx.t.repo, ctx.t.pr)} is ${state.state} — only OPEN PRs can be merged`
  );
  process.exitCode = 1;
  return undefined;
}

/** The BLOCKED-gate refusal — every blocker named on stderr, exit 1. */
function refuseBlockedMerge(rev: ReviewFacade, t: PrTarget, gate: ExitGate): void {
  console.error(`exit_gate=BLOCKED — refusing to merge ${rev.prLink(t.repo, t.pr)}`);
  for (const b of gate.blockers) {
    console.error(`  blocker: ${b}`);
  }
  process.exitCode = 1;
}

/** The landed tail — the routed task's verdict flows back to the router
 *  (the intent is durable in the outbox before this delivery attempt,
 *  so a crash here retries on the next reconcile, never re-merges;
 *  spec bro-0ykhg.4), then --cleanup retires the worktree or the plain
 *  branch delete runs. */
async function postMergeFinalize(
  ctx: MergeCtx,
  mergedHead: { ref: string; sha: string },
  outcomeState: PrActState | undefined
): Promise<void> {
  const bead = flag(ctx.argv, '--bead');
  if (bead !== undefined) {
    closeLandedBead(ctx.rev, ctx.t, bead);
  }
  await reportActOutcome(ctx.argv, ctx.t, outcomeState, 'merged');
  if (ctx.argv.includes('--cleanup')) {
    cleanupAfterMerge(mergedHead.ref, mergedHead.sha);
  } else {
    deleteMergedLocalBranch(mergedHead.ref, mergedHead.sha);
  }
}

/** The finalizeMerge half a dead loop's rearmed wait inherits — the
 *  watch marker's `bead` names the claim the landed PR discharges
 *  (bro-q6ppv). Best-effort: a missing row, an already-closed verdict,
 *  or an unreachable store reports and the merge result stands. stderr
 *  keeps it out of a --json stdout stream. */
export function closeLandedBead(rev: ReviewFacade, t: PrTarget, bead: string): void {
  const link = rev.prLink(t.repo, t.pr);
  const ids = bead
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');
  // a batch claim's marker carries the whole clump comma-joined
  // (bro-nspj7) — coverage is evidence: only members a commit on the
  // merged head names get closed; the unfinished tail re-queues instead
  // of landing a silent false-close. Unknown coverage reads as empty,
  // which is the fail-safe direction (re-queue, never false-close).
  const covered = ids.length > 1 ? coveredBeadIds(clumpBranchLog(rev, t), ids) : new Set(ids);
  // one bulk read for the whole clump — a `bd show` per member stacks
  // the ~0.65s spawn floor on every merge. A failed batch leaves rows
  // undefined and each member's own probe reports the dead store.
  let rows: Map<string, TaskRow> | undefined;
  try {
    rows = new Map(getTasks(claimStore(process.cwd()), ids).map(r => [r.id, r]));
  } catch {
    /* per-member probes below carry the failure report */
  }
  for (const id of ids) {
    dischargeLandedId(id, covered, link, t.pr, rows);
  }
}

/** Re-read a bulk-prefetched row that claims `closed` — the snapshot is
 *  the verdict a mid-clump reopen falsifies, and skipping on it drops
 *  the close the landing still owes (bro-cmr5h). A missing re-read
 *  keeps the snapshot's verdict. */
function stillClosed(tasks: ReturnType<typeof claimStore>, id: string, row: TaskRow): boolean {
  return (tasks.get(id) ?? row).status === 'closed';
}

/** One marker id's merge discharge — close when a covering commit
 *  landed, re-queue when it didn't. Best-effort per id: one bead's
 *  store failure must not skip the rest of the clump. `rows` is the
 *  caller's bulk prefetch — undefined falls back to this id's own
 *  read so a dead store still surfaces per member. */
function dischargeLandedId(
  id: string,
  covered: Set<string>,
  link: string,
  pr: number,
  rows?: Map<string, TaskRow>
): void {
  try {
    const tasks = claimStore(process.cwd());
    const row = rows === undefined ? tasks.get(id) : rows.get(id);
    if (row === undefined) {
      console.error(`act: bead ${id} not in the task store — nothing closed for ${link}`);
      return;
    }
    // the bulk row is a pre-loop snapshot — `closed` needs a live
    // re-read (bro-cmr5h); non-closed members keep the prefetch's
    // one-spawn cost.
    if (row.status === 'closed' && stillClosed(tasks, id, row)) {
      return;
    }
    if (!covered.has(id)) {
      requeueUncovered(tasks, id, link, pr);
      return;
    }
    tasks.close(id, `landed via ${link}`);
    emitLifecycle(process.cwd(), {
      kind: 'close',
      bead: id,
      pr,
      to: 'closed',
      detail: { via: 'act' },
    });
    console.error(`act: ${id} closed — ${link} merged`);
  } catch (err) {
    console.error(
      `act: closing ${id} failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** The re-queue half of dischargeLandedId — note the miss, reopen the
 *  claim, journal the release. Best-effort per step: the reopen is the
 *  load-bearing half, the note and the lifecycle event ride along. */
function requeueUncovered(
  tasks: ReturnType<typeof claimStore>,
  id: string,
  link: string,
  pr: number
): void {
  try {
    tasks.update(id, {
      notes: `act: ${link} merged without a commit naming ${id} — re-queued`,
    });
  } catch {
    /* the reopen below is the load-bearing half */
  }
  let released = false;
  try {
    tasks.reopen(id);
    released = true;
  } catch {
    /* best-effort unclaim */
  }
  if (released) {
    emitLifecycle(process.cwd(), {
      kind: 'release',
      bead: id,
      from: 'in_progress',
      to: 'open',
      detail: { via: 'act', pr, reason: 'uncovered' },
    });
  }
  console.error(`act: ${id} re-queued — no covering commit in ${link}`);
}

/** The merged branch's commit messages — `<base>..<headSha>` so the log
 *  is exactly what landed, not whatever local tip happens to be. Runs
 *  in cwd: linked worktrees share the object db, so the clump member's
 *  worktree (the resurrected wait's cwd) or the main checkout both
 *  resolve the pushed head. '' when nothing resolves — coverage then
 *  reads as "none", re-queueing every member rather than closing on a
 *  guess. */
function clumpBranchLog(rev: ReviewFacade, t: PrTarget): string {
  let meta: { baseRef: string; headSha: string };
  try {
    meta = rev.prMeta(t);
  } catch {
    return '';
  }
  return gitBranchLog(meta.headSha, meta.baseRef);
}

/** Report the routed task's terminal verdict back to the router (spec
 *  bro-0ykhg.4): the decision id resolves through the bead's
 *  `router:decision` pin or the journal's run-link reconciliation, the
 *  intent lands in the durable outbox before delivery, and the router's
 *  acknowledgement is what "reported" means — a store that cannot take
 *  it leaves the intent for the next reconcile. Best-effort: the act
 *  verdict never waits on the router. `rounds` counts act rounds —
 *  fixRounds+1, so a clean first-round merge reports 1 (the
 *  merged_first_round predicate's success shape). */
export async function reportActOutcome(
  argv: string[],
  t: PrTarget,
  state: PrActState | undefined,
  result: 'merged' | 'failed' | 'abandoned' | 'parked'
): Promise<void> {
  const bead = flag(argv, '--bead')?.split(',')[0]?.trim();
  try {
    await reportRoutedOutcome({
      dir: process.cwd(),
      ...(bead === undefined || bead === '' ? {} : { beadId: bead }),
      pr: t.pr,
      result,
      ...(state === undefined
        ? {}
        : {
            rounds: state.fixRounds + 1,
            threads: state.threads.length,
          }),
    });
  } catch {
    /* the outbox is durable — a failed pass retries on reconcile */
  }
}

/** The claim discharge owed even when the merge didn't happen here —
 *  an external merge (or the race past the last green poll) leaves
 *  `--bead` to release exactly as an own-merge would. */
export function closeBeadIfLanded(
  argv: string[],
  rev: ReviewFacade,
  t: PrTarget,
  state: string
): void {
  const bead = flag(argv, '--bead');
  if (state === 'MERGED' && bead !== undefined) {
    closeLandedBead(rev, t, bead);
  }
}

/** Best-effort debt harvest for a closed-unmerged PR — the threads on a
 *  closed branch are still review debt. A harvest failure reports to
 *  stderr but must never change the command's exit code: callers set
 *  their verdict unconditionally right after. */
export async function harvestClosedPr(
  rev: ReviewFacade,
  t: PrTarget,
  state: string,
  argv: string[] = []
): Promise<void> {
  if (state !== 'CLOSED') {
    return;
  }
  // a closed-unmerged PR is the routed task's 'failed' terminal —
  // reported through the same durable outbox (spec bro-0ykhg.4)
  await reportActOutcome(argv, t, undefined, 'failed');
  try {
    await collectReviewThreads(rev, {
      repo: t.repo,
      filters: {
        prIds: [t.pr],
        mergedSince: null,
        mergedUntil: null,
        lastN: null,
        prAuthor: null,
        labels: [],
      },
      threadAuthor: null,
      runId: 'local',
      dryRun: false,
      listOnly: false,
      reharvest: false,
      noLabel: false,
      sources: null,
      includeClosed: true,
    } as CollectArgs);
    // same tail cmdCollect runs — without it the harvested rows stay
    // ledger-only: no summary refresh, no beads projection
    refreshDebtLedger();
  } catch (err) {
    console.error(
      `act: debt harvest failed for closed PR — ${err instanceof Error ? err.message : err}`
    );
  }
}

/** The store a loop claim actually lives in — the tasks facade honors
 *  `connectors.tasks` where bare `taskStore()` always resolves beads, and
 *  the anchor is the main checkout (the git common dir's parent): a
 *  settle running in the bead's own worktree — or any scoped/subdir cwd —
 *  must not fork the close onto a store the claim was never written to. */
export function claimStore(dir: string): ReturnType<typeof taskStore> {
  const common = gitCommonDir(dir);
  const root = common !== null && basename(common) === '.git' ? dirname(common) : dir;
  return facade('tasks', { dir: root }, { prefer: loadBroConfig(root).connectors });
}

/** The branch a merged PR's checkout should fall back to: origin/HEAD's
 *  target, else the first existing of main/master. Exported for `bro
 *  drive`'s post-merge retirement — same fallback, different caller. */
export function defaultBranch(): string {
  // refresh first — a stale origin/HEAD would switch back to a renamed or
  // deleted default branch (failure only: kept, never data loss)
  gitTry(['remote', 'set-head', 'origin', '--auto']);
  const head = gitTry(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0) {
    return head.out.trim().replace(/^[^/]+\//, '');
  }
  for (const b of ['main', 'master']) {
    if (gitTry(['rev-parse', '--verify', `refs/heads/${b}`]).code === 0) {
      return b;
    }
  }
  return 'main';
}

/** A checkout ON the merged branch holds it hostage — release it before
 *  the branch delete can run: a linked worktree gets removed outright
 *  (a checkout cannot delete its own branch); the main checkout switches
 *  back to the default branch. False = the release failed and the
 *  branch must be kept — the failing step already reported. Called only
 *  when `here.branch === headRef`. */
function releaseMergedCheckout(
  root: string,
  here: WorktreeInfo,
  main: WorktreeInfo | undefined,
  gitDir: string | null,
  headRef: string
): boolean {
  if (gitDir && isLinkedGitDir(gitDir) && main) {
    // linked worktree on the merged branch — remove it, then the caller
    // retires the branch it sat on
    return removeMergedWorktree(root, here, main);
  }
  if (main !== undefined && here.path === main.path) {
    // the main checkout itself sits on the merged branch — switch back to
    // the default branch before the delete below can run
    const def = defaultBranch();
    const res = gitTry(['-C', main.path, 'switch', def]);
    if (res.code !== 0) {
      console.error(`cleanup: could not switch to ${def} (${res.err}) — branch ${headRef} kept`);
      return false;
    }
    console.log(`cleanup: switched to ${def}`);
  }
  return true;
}

/**
 * `--cleanup`: after an authoritative merge, retire the whole local surface
 * the PR lived on — worktree or checkout first (a checkout cannot delete
 * its own branch), then the branch itself under deleteMergedLocalBranch's
 * tip guard. Owned by the command, not a `;`-sequenced watcher shell: it
 * only ever runs after a merge that actually landed. Best-effort — every
 * step reports and a dirty tree is kept, never force-removed.
 */
export function cleanupAfterMerge(headRef: string, headSha: string): void {
  const cwd = process.cwd();
  // cwd may be a subdirectory — resolve the containing worktree root
  // before matching against `worktree list` paths
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim() || cwd;
  const all = parseWorktreePorcelain(gitTry(['worktree', 'list', '--porcelain']).out);
  const main = all[0];
  const here = all.find(w => w.path === root);
  const gitDir = gitDirOf(cwd);

  if (here?.branch === headRef && !releaseMergedCheckout(root, here, main, gitDir, headRef)) {
    return;
  }
  // the watcher need not run inside the PR's worktree — a detached wait
  // re-armed from the main checkout must still retire the linked tree
  // the merged branch sits on, or worktree AND branch survive the
  // cleanup (bro-23epf)
  if (here?.branch !== headRef && main !== undefined) {
    const holder = all.find(
      w =>
        w.branch === headRef &&
        w.path !== main.path &&
        w.prunable === undefined &&
        existsSync(w.path)
    );
    if (holder !== undefined && !removeMergedWorktree(holder.path, holder, main)) {
      return;
    }
  }
  // merged branch checked out elsewhere, or not checked out at all —
  // deleteMergedLocalBranch reports the first and handles the second
  deleteMergedLocalBranch(headRef, headSha);
}
