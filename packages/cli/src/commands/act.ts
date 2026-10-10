/**
 * `bro act <sub>` — the open-PR review loop as mechanics, not prompts.
 *
 *   status [PR] [--json]   PR state + exit gate (open threads, CI, SAST)
 *   merge [PR]             merge only when the exit gate is green
 *   threads [PR]           unresolved review threads, TSV
 *   resolve --thread ID [--comment TEXT] [--unresolve]
 *   reply   --thread ID --comment TEXT | --file TSV
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  ensureAuth,
  facade,
  gitCommonDir,
  gitTry,
  mergeQueueHost,
  reviewHost,
  taskStore,
  type MergeQueueFacade,
  type PrTarget,
  type ReviewFacade,
  type ReviewThread,
} from '@broject/core'
import { loadBroConfig } from '../plugins.ts'
import { flag } from './args.ts'
import {
  deleteMergedLocalBranch,
  gitDirOf,
  isLinkedGitDir,
  parseWorktreePorcelain,
  removeMergedWorktree,
} from './work.ts'
import {
  acquireMergeSlot,
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  listWatches,
  rearmWatches,
  releaseMergeSlot,
  waitForGate,
  watchVerdict,
  type ActPlan,
  type ActThreadVerdict,
  type ExitGate,
  type GateWaitResult,
  type PrActState,
  type RearmPlan,
} from '@broject/act'
import {
  annotateThreads,
  judgeConfig,
  judgeFacade,
  recordDisposition,
} from '@broject/judge'
import { coveredBeadIds } from '@broject/loop'

function usage(): never {
  console.error(`Usage: bro act <command> [args…]

Commands:
  status [PR] [--json]              PR state + exit gate JSON
  wait [PR] [--interval S] [--timeout M] [--merge] [--cleanup] [--bead ID] [--json]
                                    Poll the gate until it settles; --merge lands on green,
                                    --cleanup retires the worktree + local branch after it;
                                    --bead closes the loop-claimed bead once the merge lands
  threads [PR]                      Unresolved review threads (TSV)
  merge [PR] [--squash|--merge|--rebase] [--admin] [--cleanup] [--bead ID]
                                    Merge only if the exit gate is green;
                                    --cleanup also retires the worktree + local branch,
                                    --bead closes the loop-claimed bead on land
  rearm [--dry-run] [--json]        Resurrect dead watch markers: for each PR whose
                                    watcher died (host reboot, turn teardown) a fresh
                                    detached act wait goes up with the recorded mode
  resolve --thread ID [--comment T] Resolve a thread — a fix resolves silently
                                    (the push is the verdict); --comment is for
                                    reject/defer reasons
  reply --thread ID --comment T     Reply without resolving
        --file TSV                  Batch reply: <thread_id>\t<body> per line
        --unresolve                 resolve → unresolve instead`)
  process.exit(1)
}

const VALUE_FLAGS = new Set(['--pr', '--thread', '--comment', '--file', '--interval', '--timeout', '--bead'])

/** PR number: --pr flag, first positional, or the current branch's PR. */
function resolvePr(rev: ReviewFacade, argv: string[]): PrTarget {
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) {
        i += 1
      }
      continue
    }
    positional.push(arg)
  }
  const prFlag = argv.indexOf('--pr')
  const prRaw =
    (prFlag >= 0 ? argv[prFlag + 1] : undefined) ?? positional[0] ?? null

  const repo = rev.resolveRepo([])

  if (prRaw === null) {
    // the connector resolves the PR for the CURRENT branch — a bare list
    // query would grab an arbitrary open PR instead. CLOSED/MERGED PRs
    // resolve too, so state must be checked explicitly.
    const pr = rev.currentPr()
    if (!pr || pr.state !== 'OPEN') {
      console.error('error: no open PR for current branch — pass a PR number')
      process.exit(2)
    }
    return { repo, pr: pr.pr }
  }
  const pr = Number(prRaw)
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error(`error: invalid PR number "${prRaw}"`)
    process.exit(2)
  }
  return { repo, pr }
}

async function cmdStatus(argv: string[]): Promise<void> {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  const json = argv.includes('--json')
  const t = resolvePr(rev, argv)
  const act = loadBroConfig().act
  const state = await fetchPrActState(rev, t, {
    ignoreChecks: act.ignoreChecks,
    checkHistory: checkHistory(process.cwd()),
    maxRounds: act.maxRounds,
    docsPaths: act.docsPaths,
    docsMaxRounds: act.docsMaxRounds,
  })
  const gate = evaluateExitGate(state)

  if (!gate.ok) {
    process.exitCode = 1
  }
  if (json) {
    console.log(JSON.stringify({ pr: state, exit_gate: gate }, null, 2))
    return
  }
  printStatus(state, gate)
}

function printStatus(state: PrActState, gate: ExitGate): void {
  // clickable by convention (AGENTS.md): user-facing PR refs are links —
  // state.url is the PR's own html_url, so this is also GHE-safe
  console.log(`pr=[#${state.pr}](${state.url}) ${state.headRef}`)
  console.log(`mergeable=${state.mergeable} merge_state=${state.mergeState} draft=${state.isDraft}`)
  console.log(
    `open_threads=${gate.open_threads} ci_pending=${gate.ci_pending} ` +
      `ci_failing=${gate.ci_failing} ` +
      `reviewers_pending=${gate.reviewers_pending} ` +
      `reviewers_failing=${gate.reviewers_failing} ` +
      `sast_pending=${gate.sast_pending} sast_unknown=${gate.sast_unknown} ` +
      `fix_rounds=${gate.fix_rounds} docs_only=${gate.docs_only}`
  )
  console.log(`exit_gate=${gate.ok ? 'OK' : 'BLOCKED'}`)
  const live = listWatches(process.cwd()).filter(
    (l) => l.alive && l.watch.pr === state.pr
  )
  console.log(
    `watch=${live.length > 0 ? `live pid=${live[0]!.watch.pid}` : `none — \`bro act wait ${state.pr}\` arms one`}`
  )
  for (const b of gate.blockers) {
    console.log(`  blocker: ${b}`)
  }
  for (const a of gate.alerts) {
    console.log(`  alert: ${a}`)
  }
}

/**
 * `bro act wait` — the gate-watcher as a primitive: poll until nothing is
 * pending (gate green, threads/failures to act on, or timeout), print the
 * verdict. `--merge` lands the PR when the gate settles OK — the whole
 * "watcher + merge on green" loop in one backgroundable command.
 */
async function cmdWait(argv: string[]): Promise<void> {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  const t = resolvePr(rev, argv)
  const act = loadBroConfig().act
  const interval = Number(flag(argv, '--interval') ?? '60')
  const timeout = Number(flag(argv, '--timeout') ?? '45')
  if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(timeout) || timeout <= 0) {
    console.error('error: --interval/--timeout must be positive numbers (seconds/minutes)')
    process.exit(2)
  }
  const res = await waitForGate(
    async () => {
      const state = await fetchPrActState(rev, t, {
        ignoreChecks: act.ignoreChecks,
        checkHistory: checkHistory(process.cwd()),
        maxRounds: act.maxRounds,
        docsPaths: act.docsPaths,
        docsMaxRounds: act.docsMaxRounds,
      })
      return { state, gate: evaluateExitGate(state) }
    },
    {
      intervalMs: interval * 1000,
      timeoutMs: timeout * 60_000,
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
        timeoutMin: timeout,
      },
      onPoll: (s, g) =>
        console.error(
          `act wait ${rev.prLink(t.repo, s.pr)}: threads=${g.open_threads} ci=${g.ci_pending}+${g.ci_failing}f reviewers=${g.reviewers_pending} sast=${g.sast_pending}`
        ),
      onError: (err, n) =>
        console.error(
          `act wait ${rev.prLink(t.repo, t.pr)}: fetch failed (${n}) — ${err instanceof Error ? err.message : String(err)}`
        ),
      // the "Update branch" button as a wait step: BEHIND + mergeable is
      // a state to fix, not to sit on — conflicts still settle for a human
      updateBranch: (s) => {
        const ok = rev.updateBranch(t, s.headSha)
        console.error(
          `act wait ${rev.prLink(t.repo, t.pr)}: update-branch ${ok ? 'pushed a new head' : 'refused'}`
        )
        return ok
      },
    }
  )
  if (argv.includes('--json')) {
    console.log(
      JSON.stringify({ pr: res.state, exit_gate: res.gate, timed_out: res.timedOut }, null, 2)
    )
  } else {
    printStatus(res.state, res.gate)
    if (res.timedOut) {
      console.log(`wait: timed out after ${timeout}m — still pending`)
    }
  }
  if (res.timedOut || !res.gate.ok || res.state.state !== 'OPEN') {
    if (!res.timedOut && !res.gate.ok) {
      await recordBlockedVerdict(rev, t, res, timeout)
    }
    // an external merge settles the wait before mergeIfAsked ever runs —
    // watchEnd already swept the marker, so nothing is left for `act
    // rearm`'s settle-path reconcile to see. Discharge the loop-claimed
    // bead here (its twin rule: MERGED closes, CLOSED-unmerged keeps)
    closeBeadIfLanded(argv, rev, t, res.state.state)
    process.exitCode = res.timedOut || !res.gate.ok ? 1 : 0
    return
  }
  await mergeIfAsked(argv, t.pr)
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
  const link = rev.prLink(t.repo, t.pr)
  watchVerdict(process.cwd(), { pr: t.pr, link, timeoutMin }, res.gate.blockers)
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
    })
  } catch {
    // fail-open — the verdict record must never turn the exit-code
    // contract into a failure
  }
}

/** Detached `act wait` resurrection — own process group, parent's
 *  stdio ignored, unref'd: the same nohup-equivalent the watcher needs
 *  to survive the session that re-armed it (bro-tafj). `argv[1]` is the
 *  running cli entry, so the child re-runs this same binary.
 *
 *  The returned pid is CONFIRMED — this resolves only once the child's
 *  own live marker shows up in listWatches, so a spawn that exits early
 *  (auth gate, config error) resolves undefined and the dead markers
 *  stay on disk as the still-unkept promise. */
export async function respawnWatcher(dir: string, plan: RearmPlan): Promise<number | undefined> {
  const entry = process.argv[1]
  if (entry === undefined) {
    return undefined
  }
  // --cleanup retires the worktree containing the watcher's cwd — it is
  // replayed only when the recorded workdir still exists. Replaying it
  // from the rearm cwd (or a marker old enough to lack workdir) could
  // tear down the wrong checkout.
  const workdirOk = plan.workdir !== undefined && existsSync(plan.workdir)
  const args = [entry, 'act', 'wait', String(plan.pr), '--timeout', String(plan.timeoutMin)]
  if (plan.merge) {
    args.push('--merge')
    // --cleanup only has meaning behind --merge — a wait armed with
    // cleanup alone exits on the post-wait dispatch, so a merge:false
    // marker's cleanup bit (user error at arm time) isn't replayed
    if (plan.cleanup && workdirOk) {
      args.push('--cleanup')
    }
  }
  // the loop-claimed bead rides along in either mode — the respawned
  // wait's own marker re-records it, so a second rearm keeps the
  // identity; on merge it is the bead the dead loop never closed
  if (plan.bead !== undefined) {
    args.push('--bead', plan.bead)
  }
  const cwd = workdirOk ? plan.workdir! : dir
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
  })
  // an unhandled 'error' event (ENOENT on cwd, EACCES on the entry)
  // would crash rearm mid-loop — swallow it; pid stays undefined and
  // the marker is kept
  child.on('error', () => {})
  child.unref()
  const pid = child.pid
  if (pid === undefined) {
    return undefined
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const live = listWatches(dir).find((l) => l.alive && l.watch.pid === pid)
    if (live !== undefined) {
      return pid
    }
    if (child.exitCode !== null) {
      return undefined // exited before ever publishing its marker
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return undefined
}

/** `bro act rearm` — dead watch markers mean their watcher died with
 *  the promise unkept (bro-tafj). Per still-open PR a detached wait
 *  goes back up with the recorded mode; settled PRs' markers sweep.
 *  --dry-run prints the plan without spawning or touching markers. */
async function cmdRearm(argv: string[]): Promise<void> {
  const dry = argv.includes('--dry-run')
  const dir = process.cwd()
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  const repo = await (rev.resolveRepoAsync === undefined
    ? Promise.resolve(rev.resolveRepo([]))
    : rev.resolveRepoAsync([]))
  // prMeta answers both probes — the OPEN gate and the settle-path
  // reconcile below — cache it so the second read costs nothing
  const metas = new Map<number, { state: string }>()
  const isOpen = async (pr: number): Promise<boolean> => {
    const meta =
      rev.prMetaAsync === undefined
        ? rev.prMeta({ repo, pr })
        : await rev.prMetaAsync({ repo, pr })
    metas.set(pr, meta)
    return meta.state === 'OPEN'
  }
  const res = await rearmWatches({
    dir,
    isOpen,
    respawn: dry ? undefined : (plan) => respawnWatcher(dir, plan),
  })
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ dryRun: dry, ...res }, null, 2))
  } else {
    reportRearm(res, dry, (pr) => rev.prLink(repo, pr))
  }
  // the reconcile half of a dead loop's watch (bro-q6ppv): a settled
  // marker carrying a bead means the PR resolved while nobody watched —
  // MERGED discharges the loop's claim exactly as finalizeMerge did;
  // CLOSED-unmerged keeps it (the work never landed)
  if (!dry) {
    for (const s of res.settled) {
      if (s.bead !== undefined && metas.get(s.pr)?.state === 'MERGED') {
        closeLandedBead(rev, { repo, pr: s.pr }, s.bead)
      }
    }
  }
}

/** Human lines for a rearm result — kept out of cmdRearm so the
 *  command reads as resolve → run → report. */
function reportRearm(
  res: {
    rearmed: Array<{ pr: number; pid: number }>
    settled: Array<{ pr: number; bead?: string }>
    kept: Array<{ pr: number; reason: string }>
  },
  dry: boolean,
  link: (pr: number) => string
): void {
  for (const r of res.rearmed) {
    console.log(
      `rearm: ${link(r.pr)} — ` + (dry ? 'would respawn a watcher' : `watcher up (pid ${r.pid})`)
    )
  }
  for (const s of res.settled) {
    console.log(`rearm: ${link(s.pr)} settled — marker swept`)
  }
  for (const k of res.kept) {
    console.error(`rearm: ${link(k.pr)} kept — ${k.reason}`)
  }
  if (res.rearmed.length === 0 && res.settled.length === 0 && res.kept.length === 0) {
    console.log('rearm: no dead watches')
  }
}

/** Post-wait merge dispatch: `--merge` lands the PR (with `--cleanup`
 *  and `--bead` forwarded); `--cleanup` alone is an error — nothing was
 *  merged. */
async function mergeIfAsked(argv: string[], pr: number): Promise<void> {
  if (argv.includes('--merge')) {
    const mergeArgs = argv.filter((a) => ['--squash', '--rebase', '--admin', '--cleanup'].includes(a))
    const bead = flag(argv, '--bead')
    if (bead !== undefined) {
      mergeArgs.push('--bead', bead)
    }
    await cmdMerge([String(pr), ...mergeArgs])
  } else if (argv.includes('--cleanup')) {
    console.error('error: --cleanup requires --merge — nothing was merged, nothing to clean')
    process.exitCode = 2
  }
}

/**
 * `bro act merge` — the exit gate as the merge precondition, not a prompt.
 * Merging through bro cannot bypass a BLOCKED gate; `gh pr merge` by hand
 * can. This is the guardrail for "merged without running the gate".
 */
/** Merge strategy validation — returns null (caller errors out) on
 *  conflicting flags. Runs before the slot so a doomed request never
 *  occupies the critical section. */
function mergeMethod(argv: string[]): 'squash' | 'merge' | 'rebase' | null {
  const strategies = ['--squash', '--merge', '--rebase'].filter((f) => argv.includes(f))
  if (strategies.length > 1) {
    console.error(`error: conflicting merge strategies: ${strategies.join(' ')}`)
    return null
  }
  return (strategies[0]?.slice(2) ?? 'squash') as 'squash' | 'merge' | 'rebase'
}

/** mergePr + the landed-head handoff — a merge queue accepts a PR
 *  without landing it, so only a MERGED state returns the head.
 *  An external queue (connectors.mergeQueue) owns the merge when
 *  configured — its connector's `enqueue` replaces mergePr outright:
 *  'enqueued' parks the PR (undefined → deferred cleanup), 'merged'
 *  hands the head to cleanup same as a direct merge. */
function landPr(
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
          (w) => w.branch === head.ref
        )?.path ?? process.cwd()
      const r = queue.enqueue(t, {
        dir: checkout,
        headRef: head.ref,
        expectedHeadSha: head.sha,
      })
      if (r === 'merged') {
        console.log(`act: merged ${rev.prLink(t.repo, t.pr)}`)
        return head
      }
      console.log(
        `act: ${rev.prLink(t.repo, t.pr)} enqueued — an external merge queue owns it; ` +
          'local cleanup deferred'
      )
      return undefined
    }
    // expectedHeadSha pins the merge to the sha the gate evaluated —
    // a head that moved since fetch fails closed instead of landing
    // a commit the gate never saw
    const after = rev.mergePr(t, {
      method: opts.method,
      expectedHeadSha: head.sha,
      deleteBranch: true,
      admin: opts.admin,
    })
    if (after === 'MERGED') {
      console.log(`act: merged ${rev.prLink(t.repo, t.pr)}`)
      return head
    }
    console.log(
      `act: ${rev.prLink(t.repo, t.pr)} accepted but state=${after} — a merge queue still owns it; ` +
        'local cleanup deferred'
    )
    return undefined
  } catch (err) {
    console.error(`error: merge failed — ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return undefined
  }
}

async function cmdMerge(argv: string[]): Promise<void> {
  const cfg = loadBroConfig()
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: cfg.connectors })
  const rev = reviewHost(undefined, cfg.connectors)
  // A configured external queue replaces mergePr — its auth probe runs
  // up front so a missing `gt`/`gh` fails fast, not mid-enqueue.
  const queue = mergeQueueHost(undefined, cfg.connectors)
  if (queue) {
    ensureAuth('mergeQueue', { dir: process.cwd() }, { prefer: cfg.connectors })
  }
  const t = resolvePr(rev, argv)

  const method = mergeMethod(argv)
  if (!method) {
    process.exitCode = 2
    return
  }

  // Gate evaluation + merge is ONE critical section: acquiring the slot
  // first closes the drift window between a green gate and the merge
  // (new threads/state can't sneak in while a wedged bd would otherwise
  // burn its timeout). `unavailable` (no bd, no .beads) proceeds —
  // coordination is a bonus, never a gate of its own.
  const slot = acquireMergeSlot()
  if (slot.kind === 'held') {
    console.error(
      `merge slot held by ${slot.holder} — another session is merging; ` +
        'wait for `bd merge-slot check` to report available, or `bd merge-slot release` a crashed holder'
    )
    process.exitCode = 1
    return
  }
  let mergedHead: { ref: string; sha: string } | undefined
  try {
    const act = loadBroConfig().act
    const state = await fetchPrActState(rev, t, {
      ignoreChecks: act.ignoreChecks,
      checkHistory: checkHistory(process.cwd()),
      maxRounds: act.maxRounds,
      docsPaths: act.docsPaths,
      docsMaxRounds: act.docsMaxRounds,
    })

    // a closed/merged PR can pass the gate (threads resolved, checks
    // settled) — merging it isn't a gate question, it's a lifecycle error
    if (state.state !== 'OPEN') {
      // already landed still discharges the claim — the race where the
      // PR merged between the wait's last green poll and this fetch
      closeBeadIfLanded(argv, rev, t, state.state)
      console.error(
        `error: ${rev.prLink(t.repo, t.pr)} is ${state.state} — only OPEN PRs can be merged`
      )
      process.exitCode = 1
      return
    }

    const gate = evaluateExitGate(state)
    if (!gate.ok) {
      console.error(`exit_gate=BLOCKED — refusing to merge ${rev.prLink(t.repo, t.pr)}`)
      for (const b of gate.blockers) {
        console.error(`  blocker: ${b}`)
      }
      process.exitCode = 1
      return
    }

    mergedHead = landPr(rev, t, { method, admin: argv.includes('--admin') }, {
      ref: state.headRef,
      sha: state.headSha,
    }, queue)
  } finally {
    if (slot.kind === 'acquired') {
      releaseMergeSlot()
    }
  }
  // local cleanup runs AFTER the merge slot is released — it is pure git
  // plumbing and must not extend the critical section. The bead close
  // shares the ordering: a landed merge discharges the loop's claim
  // before the worktree goes away.
  if (mergedHead) {
    const bead = flag(argv, '--bead')
    if (bead !== undefined) {
      closeLandedBead(rev, t, bead)
    }
    if (argv.includes('--cleanup')) {
      cleanupAfterMerge(mergedHead.ref, mergedHead.sha)
    } else {
      deleteMergedLocalBranch(mergedHead.ref, mergedHead.sha)
    }
  }
}

/** The finalizeMerge half a dead loop's rearmed wait inherits — the
 *  watch marker's `bead` names the claim the landed PR discharges
 *  (bro-q6ppv). Best-effort: a missing row, an already-closed verdict,
 *  or an unreachable store reports and the merge result stands. stderr
 *  keeps it out of a --json stdout stream. */
function closeLandedBead(rev: ReviewFacade, t: PrTarget, bead: string): void {
  const link = rev.prLink(t.repo, t.pr)
  const ids = bead
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  // a batch claim's marker carries the whole clump comma-joined
  // (bro-nspj7) — coverage is evidence: only members a commit on the
  // merged head names get closed; the unfinished tail re-queues instead
  // of landing a silent false-close. Unknown coverage reads as empty,
  // which is the fail-safe direction (re-queue, never false-close).
  const covered =
    ids.length > 1 ? coveredBeadIds(clumpBranchLog(rev, t), ids) : new Set(ids)
  for (const id of ids) {
    try {
      const tasks = claimStore(process.cwd())
      const row = tasks.get(id)
      if (row === undefined) {
        console.error(`act: bead ${id} not in the task store — nothing closed for ${link}`)
        continue
      }
      if (row.status === 'closed') {
        continue
      }
      if (!covered.has(id)) {
        try {
          tasks.update(id, {
            notes: `act: ${link} merged without a commit naming ${id} — re-queued`,
          })
        } catch { /* the reopen below is the load-bearing half */ }
        try {
          tasks.reopen(id)
        } catch { /* best-effort unclaim */ }
        console.error(`act: ${id} re-queued — no covering commit in ${link}`)
        continue
      }
      tasks.close(id, `landed via ${link}`)
      console.error(`act: ${id} closed — ${link} merged`)
    } catch (err) {
      console.error(`act: closing ${id} failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** The merged branch's commit messages — `<base>..<headSha>` so the log
 *  is exactly what landed, not whatever local tip happens to be. Runs
 *  in cwd: linked worktrees share the object db, so the clump member's
 *  worktree (the resurrected wait's cwd) or the main checkout both
 *  resolve the pushed head. '' when nothing resolves — coverage then
 *  reads as "none", re-queueing every member rather than closing on a
 *  guess. */
function clumpBranchLog(rev: ReviewFacade, t: PrTarget): string {
  let meta: { baseRef: string; headSha: string }
  try {
    meta = rev.prMeta(t)
  } catch {
    return ''
  }
  for (const head of meta.headSha === '' ? ['HEAD'] : [meta.headSha, 'HEAD']) {
    for (const ref of [`origin/${meta.baseRef}`, meta.baseRef]) {
      const mb = gitTry(['merge-base', head, ref])
      if (mb.code !== 0 || !mb.out.trim()) {
        continue
      }
      const log = gitTry(['log', '--format=%B', `${mb.out.trim()}..${head}`])
      if (log.code === 0) {
        return log.out
      }
    }
  }
  return ''
}

/** The claim discharge owed even when the merge didn't happen here —
 *  an external merge (or the race past the last green poll) leaves
 *  `--bead` to release exactly as an own-merge would. */
function closeBeadIfLanded(
  argv: string[],
  rev: ReviewFacade,
  t: PrTarget,
  state: string
): void {
  const bead = flag(argv, '--bead')
  if (state === 'MERGED' && bead !== undefined) {
    closeLandedBead(rev, t, bead)
  }
}

/** The store a loop claim actually lives in — the tasks facade honors
 *  `connectors.tasks` where bare `taskStore()` always resolves beads, and
 *  the anchor is the main checkout (the git common dir's parent): a
 *  settle running in the bead's own worktree — or any scoped/subdir cwd —
 *  must not fork the close onto a store the claim was never written to. */
function claimStore(dir: string): ReturnType<typeof taskStore> {
  const common = gitCommonDir(dir)
  const root = common !== null && basename(common) === '.git' ? dirname(common) : dir
  return facade('tasks', { dir: root }, { prefer: loadBroConfig(root).connectors })
}

/** The branch a merged PR's checkout should fall back to: origin/HEAD's
 *  target, else the first existing of main/master. Exported for `bro
 *  drive`'s post-merge retirement — same fallback, different caller. */
export function defaultBranch(): string {
  // refresh first — a stale origin/HEAD would switch back to a renamed or
  // deleted default branch (failure only: kept, never data loss)
  gitTry(['remote', 'set-head', 'origin', '--auto'])
  const head = gitTry(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.code === 0) {
    return head.out.trim().replace(/^[^/]+\//, '')
  }
  for (const b of ['main', 'master']) {
    if (gitTry(['rev-parse', '--verify', `refs/heads/${b}`]).code === 0) {
      return b
    }
  }
  return 'main'
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
  const cwd = process.cwd()
  // cwd may be a subdirectory — resolve the containing worktree root
  // before matching against `worktree list` paths
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim() || cwd
  const all = parseWorktreePorcelain(gitTry(['worktree', 'list', '--porcelain']).out)
  const main = all[0]
  const here = all.find((w) => w.path === root)
  const gitDir = gitDirOf(cwd)

  if (here?.branch === headRef && gitDir && isLinkedGitDir(gitDir) && main) {
    if (!removeMergedWorktree(root, here, main)) {
      return
    }
    // worktree removed — fall through to retire the branch it sat on
  } else if (here?.branch === headRef && here.path === main?.path) {
    // the main checkout itself sits on the merged branch — switch back to
    // the default branch before the delete below can run
    const def = defaultBranch()
    const res = gitTry(['-C', main.path, 'switch', def])
    if (res.code !== 0) {
      console.error(`cleanup: could not switch to ${def} (${res.err}) — branch ${headRef} kept`)
      return
    }
    console.log(`cleanup: switched to ${def}`)
  }
  // merged branch checked out elsewhere, or not checked out at all —
  // deleteMergedLocalBranch reports the first and handles the second
  deleteMergedLocalBranch(headRef, headSha)
}

async function cmdThreads(argv: string[]): Promise<void> {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  const t = resolvePr(rev, argv)
  // threads only needs the threads API — fetching checks/SAST here would
  // make a read-only listing fail on unrelated check-service flakes
  const threads = await rev.reviewThreads(t)
  // shadow-mode judge verdicts render beside each unresolved thread —
  // annotation only, never applied; every failure mode degrades to
  // "no annotation" (a judge that can stall `act threads` gets turned
  // off, per the spec's fail-open rule)
  // judging runs behind the listing, not beside it — TSV rows print
  // first; shadowNotes can open with a slow prMeta call, and starting
  // it before the row loop would still stall the listing. Annotations
  // land on stderr once the batch resolves.
  let open = 0
  for (const thread of threads) {
    if (thread.resolved) {
      continue
    }
    open += 1
    const c = thread.comment
    const author = c?.author ?? '-'
    const path = c?.path ?? '-'
    const line = c?.line ?? '-'
    const body = (c?.body ?? '').replace(/[\n\t]/g, ' ').slice(0, 120)
    console.log(`${thread.id}\t${author}\t${path}:${line}\t${body}`)
  }
  const notes = await shadowNotes(rev, t, threads).catch(() => undefined)
  for (const thread of threads) {
    const note = notes?.get(thread.id)
    if (note !== undefined) {
      // stderr — stdout is the documented TSV contract; a `judge:` line
      // there reads as a malformed thread record to TSV consumers
      console.error(`${thread.id} ${note}`)
    }
  }
  console.error(`act threads: ${open} unresolved`)
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
  const dir = process.cwd()
  const cfg = judgeConfig(dir).judge
  if (cfg.mode !== 'shadow') {
    return undefined
  }
  try {
    // headSha is the "inputs moved" half of the dedup key — a push
    // re-judges the thread; an unfetchable head just loosens the key
    let headSha: string | undefined
    try {
      // async twin when the facade has one — a sync CLI call inside an
      // async fn still freezes the loop this listing shares
      const meta =
        rev.prMetaAsync !== undefined
          ? await rev.prMetaAsync(t)
          : rev.prMeta(t)
      headSha = meta.headSha
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
    })
    if (res.decided > 0) {
      console.error(`act: judge decided ${res.decided} thread(s) — verdicts journaled`)
    }
    return res.annotations
  } catch (err) {
    console.error(
      `act: judge annotation skipped — ${err instanceof Error ? err.message : String(err)}`
    )
    return undefined
  }
}

/** The observed outcome for a thread — journaled beside its shadow
 *  verdict so stats can score judge-vs-outcome agreement. Runs only
 *  in shadow mode (off writes no judge artifacts); a failed journal
 *  write never fails the mutation that produced the outcome. */
function disposition(threadId: string, outcome: string, pr?: number): void {
  const dir = process.cwd()
  if (judgeConfig(dir).judge.mode !== 'shadow') {
    return
  }
  try {
    recordDisposition(dir, { pr, threadId }, outcome)
  } catch (err) {
    console.error(
      `act: disposition not journaled — ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

function threadArg(argv: string[]): string {
  const i = argv.indexOf('--thread')
  const id = i >= 0 ? argv[i + 1] : undefined
  if (!id) {
    console.error('error: --thread required')
    usage()
  }
  return id!
}

function commentArg(argv: string[]): string | null {
  const i = argv.indexOf('--comment')
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

function cmdResolve(argv: string[]): void {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  const id = threadArg(argv)
  const comment = commentArg(argv)
  const unresolve = argv.includes('--unresolve')
  if (comment) {
    if (!unresolve) {
      // the verdict on a fix is the push — comments on resolved-as-fixed
      // threads are boilerplate noise on the PR (skills/act/SKILL.md)
      console.error('act: note — fixes resolve silently; --comment is for reject/defer reasons')
    }
    rev.replyThread(id, comment)
    console.error(`act: replied on ${id}`)
  }
  if (unresolve) {
    rev.resolveThread(id, true)
    console.error(`act: unresolved ${id}`)
  } else {
    rev.resolveThread(id)
    console.error(`act: resolved ${id}`)
    // a silent resolve is the fix verdict; a comment is a reject/defer
    // reason (skills/act/SKILL.md) — the documented defer reply names
    // its bead ("deferred to <id>"), which is the one defer signal a
    // bare resolve can see
    disposition(id, comment ? (/deferred to \S+/i.test(comment) ? 'deferred' : 'rejected') : 'fixed')
  }
}

function cmdReply(argv: string[]): void {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  const fileIdx = argv.indexOf('--file')
  if (fileIdx >= 0) {
    const file = argv[fileIdx + 1]
    if (!file) {
      console.error('error: --file requires a path')
      process.exit(2)
    }
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    let skipped = 0
    const rows = lines
      .map((l) => {
        const tab = l.indexOf('\t')
        if (tab === -1) {
          skipped += 1
          return null
        }
        return {
          id: l.slice(0, tab).trim(),
          body: l.slice(tab + 1).replaceAll(String.raw`\n`, '\n').replaceAll(String.raw`\t`, '\t'),
        }
      })
      .filter((r): r is { id: string; body: string } => r !== null)
    for (const row of rows) {
      rev.replyThread(row.id, row.body)
      console.error(`act: replied on ${row.id}`)
      disposition(row.id, /deferred to \S+/i.test(row.body) ? 'deferred' : 'replied')
    }
    console.error(`act reply: ${rows.length} repl(ies)`)
    if (skipped > 0) {
      console.error(`warning: ${skipped} line(s) had no <thread_id><TAB><body> shape — skipped`)
      process.exitCode = 1
    }
    return
  }
  const id = threadArg(argv)
  const comment = commentArg(argv)
  if (!comment) {
    console.error('error: --comment required (or --file TSV)')
    usage()
  }
  rev.replyThread(id, comment!)
  console.error(`act: replied on ${id}`)
  // the documented defer flow replies "deferred to <bead>" then
  // resolves silently — journaled as deferred here (stats join
  // first-hit wins) so the silent resolve's 'fixed' can't mask it
  disposition(id, /deferred to \S+/i.test(comment!) ? 'deferred' : 'replied')
}

const COMMANDS: Record<string, (argv: string[]) => void | Promise<void>> = {
  status: cmdStatus,
  wait: cmdWait,
  merge: cmdMerge,
  rearm: cmdRearm,
  threads: cmdThreads,
  resolve: cmdResolve,
  reply: cmdReply,
}

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
        : `deferred thread ${v.thread_id}`
  if (!v.title) {
    throw new Error(`defer verdict for ${v.thread_id} has no title`)
  }
  const bead = taskStore().create({
    title: v.title,
    labels: ['debt'],
    description: desc,
    externalRef: v.thread_id,
  }).id
  const reply = `deferred to ${bead}` + (v.comment ? ` — ${v.comment}` : '')
  rev.replyThread(v.thread_id, reply)
  rev.resolveThread(v.thread_id)
  disposition(v.thread_id, 'deferred', pr)
  return bead
}

function replyVerdict(rev: ReviewFacade, v: ActThreadVerdict, pr?: number): void {
  if (!v.comment) {
    throw new Error(`reply verdict for ${v.thread_id} has no comment`)
  }
  rev.replyThread(v.thread_id, v.comment)
  console.error(`act: replied on ${v.thread_id}`)
  disposition(v.thread_id, 'replied', pr)
}

function resolveVerdict(rev: ReviewFacade, v: ActThreadVerdict, pr?: number): void {
  if (v.comment) {
    rev.replyThread(v.thread_id, v.comment)
  }
  rev.resolveThread(v.thread_id)
  console.error(`act: resolved ${v.thread_id}`)
  disposition(v.thread_id, v.comment ? 'rejected' : 'fixed', pr)
}

/** Apply an `act` plan (`bro run act.toml`) — batch thread verdicts.
 *  One bad verdict doesn't abort the rest; failures list at the end. */
export function applyActPlan(plan: ActPlan): void {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const rev = reviewHost(undefined, loadBroConfig().connectors)
  // no upfront beads check — a defer without bd/.beads fails that one
  // verdict (thread stays unresolved, per the skill's fallback rule)
  // instead of blocking every other verdict in the plan
  const failed: string[] = []
  // lazy: only a defer verdict pays the repo-resolution call — and
  // outside a clone it can't pay at all; null falls back to the bare-#
  // bead description rather than failing a valid defer plan.
  // undefined = not yet attempted.
  let ownerRepo: string | null | undefined
  const repoForDefers = (): string | null => {
    if (ownerRepo !== undefined) {
      return ownerRepo
    }
    // a failed resolve isn't cached — one transient outage must not
    // degrade every later defer in the same plan
    try {
      return (ownerRepo = rev.resolveRepo([]))
    } catch {
      return null
    }
  }
  for (const v of plan.threads) {
    try {
      if (v.action === 'reply') {
        replyVerdict(rev, v, plan.pr)
      } else if (v.action === 'defer') {
        console.error(`act: deferred ${v.thread_id} → ${deferThread(rev, v, repoForDefers(), plan.pr)}`)
      } else {
        resolveVerdict(rev, v, plan.pr)
      }
    } catch (err) {
      failed.push(v.thread_id)
      console.error(
        `act: ${v.thread_id} failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  if (failed.length > 0) {
    console.error(`act plan: ${failed.length} verdict(s) failed: ${failed.join(', ')}`)
    process.exitCode = 1
  }
}

export async function runActCommand(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  // zero-arg magic: bare `bro act` is the gate on the current branch's PR
  if (!cmd) {
    await cmdStatus([])
    return
  }
  if (cmd === '--help' || cmd === '-h') {
    usage()
  }
  const handler = COMMANDS[cmd]
  if (!handler) {
    console.error(`unknown command: ${cmd}`)
    usage()
  }
  await handler(rest)
}
