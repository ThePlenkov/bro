/**
 * `bro act <sub>` — the open-PR review loop as mechanics, not prompts.
 *
 *   status [PR] [--json]   PR state + exit gate (open threads, CI, SAST)
 *   merge [PR]             merge only when the exit gate is green
 *   threads [PR]           unresolved review threads, TSV
 *   resolve --thread ID [--comment TEXT] [--unresolve]
 *   reply   --thread ID --comment TEXT | --file TSV
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  ensureAuth,
  gitTry,
  reviewHost,
  taskStore,
  type PrTarget,
  type ReviewFacade,
  type ReviewThread,
} from '@broject/core'
import { loadBroConfig } from '../plugins.ts'
import { isAncestor } from './cleanup.ts'
import { flag } from './args.ts'
import { gitDirOf, hasSubmodules, isLinkedGitDir, parseWorktreePorcelain } from './work.ts'
import type { WorktreeInfo } from './work.ts'
import {
  acquireMergeSlot,
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  listWatches,
  releaseMergeSlot,
  waitForGate,
  type ActPlan,
  type ActThreadVerdict,
  type ExitGate,
  type PrActState,
} from '@broject/act'
import {
  annotateThreads,
  judgeConfig,
  judgeFacade,
  recordDisposition,
} from '@broject/judge'

function usage(): never {
  console.error(`Usage: bro act <command> [args…]

Commands:
  status [PR] [--json]              PR state + exit gate JSON
  wait [PR] [--interval S] [--timeout M] [--merge] [--cleanup] [--json]
                                    Poll the gate until it settles; --merge lands on green,
                                    --cleanup retires the worktree + local branch after it
  threads [PR]                      Unresolved review threads (TSV)
  merge [PR] [--squash|--merge|--rebase] [--admin] [--cleanup]
                                    Merge only if the exit gate is green;
                                    --cleanup also retires the worktree + local branch
  resolve --thread ID [--comment T] Resolve a thread — a fix resolves silently
                                    (the push is the verdict); --comment is for
                                    reject/defer reasons
  reply --thread ID --comment T     Reply without resolving
        --file TSV                  Batch reply: <thread_id>\t<body> per line
        --unresolve                 resolve → unresolve instead`)
  process.exit(1)
}

const VALUE_FLAGS = new Set(['--pr', '--thread', '--comment', '--file', '--interval', '--timeout'])

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
    process.exitCode = res.timedOut || !res.gate.ok ? 1 : 0
    return
  }
  await mergeIfAsked(argv, t.pr)
}

/** Post-wait merge dispatch: `--merge` lands the PR (with `--cleanup`
 *  forwarded); `--cleanup` alone is an error — nothing was merged. */
async function mergeIfAsked(argv: string[], pr: number): Promise<void> {
  if (argv.includes('--merge')) {
    const mergeArgs = argv.filter((a) => ['--squash', '--rebase', '--admin', '--cleanup'].includes(a))
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
 *  without landing it, so only a MERGED state returns the head. */
function landPr(
  rev: ReviewFacade,
  t: PrTarget,
  opts: { method: 'squash' | 'merge' | 'rebase'; admin: boolean },
  head: { ref: string; sha: string }
): { ref: string; sha: string } | undefined {
  try {
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
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors })
  const rev = reviewHost(undefined, loadBroConfig().connectors)
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
    })
  } finally {
    if (slot.kind === 'acquired') {
      releaseMergeSlot()
    }
  }
  // local cleanup runs AFTER the merge slot is released — it is pure git
  // plumbing and must not extend the critical section
  if (mergedHead) {
    if (argv.includes('--cleanup')) {
      cleanupAfterMerge(mergedHead.ref, mergedHead.sha)
    } else {
      deleteMergedLocalBranch(mergedHead.ref, mergedHead.sha)
    }
  }
}

/** Best-effort local-side cleanup after a merge — the remote branch is
 * already gone via --delete-branch, but the local ref lingers. Never
 * fails the merge: a branch checked out in ANY worktree simply reports
 * (a checkout cannot delete its own branch). Deletes only when the local
 * tip IS the merged head (or its ancestor) — a same-named branch with
 * extra commits is kept, which also covers the fork-PR case where
 * headRef names a branch we never had. Exported for `bro drive`'s
 * post-merge retirement — same guards, different caller. */
export function deleteMergedLocalBranch(headRef: string, headSha: string): void {
  // a prunable entry (directory already gone) still lists its branch —
  // it must not count as checked out or the branch is never deleted
  const checkedOut = parseWorktreePorcelain(gitTry(['worktree', 'list', '--porcelain']).out).some(
    (w) => w.branch === headRef && w.prunable === undefined && existsSync(w.path)
  )
  if (checkedOut) {
    console.error(`cleanup: ${headRef} is checked out — delete it after switching`)
    return
  }
  const tipRes = gitTry(['rev-parse', '--verify', `refs/heads/${headRef}`])
  if (tipRes.code !== 0) {
    return // no local branch — nothing to do
  }
  const tip = tipRes.out.trim()
  if (tip !== headSha && !isAncestor(tip, headSha)) {
    console.error(`cleanup: ${headRef} has commits beyond the merged head — kept`)
    return
  }
  // `update-ref -d <ref> <tip>` deletes only if the ref still points at the
  // tip we verified — a compare-and-delete, so commits landing between the
  // check and the delete can't be silently dropped
  const res = gitTry(['update-ref', '-d', `refs/heads/${headRef}`, tip])
  if (res.code === 0) {
    console.log(`cleanup: deleted local branch ${headRef}`)
  } else if (/checked out/i.test(res.err)) {
    console.error(`cleanup: ${headRef} is checked out — delete it after switching`)
  } else if (/cannot lock ref/i.test(res.err)) {
    console.error(`cleanup: ${headRef} moved past the verified tip — kept`)
  } else {
    console.error(`cleanup: local branch ${headRef} not deleted (${res.err})`)
  }
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

/** Remove the linked worktree the merged branch was checked out in,
 *  via the main checkout. Returns false when the tree must be kept —
 *  locked (explicit human intent; `work leave` holds the same line even
 *  under --force), dirty/unverifiable, or the removal itself failed.
 *  `worktree remove` refuses trees with ANY extra files (even ignored
 *  ones like node_modules), so a clean porcelain status — no tracked
 *  modifications, no untracked files — is the guard for --force being
 *  safe: only ignored debris remains. The check is config-independent
 *  (`-c status.showUntrackedFiles=all` overrides a user config that
 *  would hide untracked files) and fail-closed. Exported for `bro
 *  drive`'s post-merge retirement — same guards, different caller. */
export function removeMergedWorktree(root: string, here: WorktreeInfo, main: WorktreeInfo): boolean {
  if (here.locked !== undefined) {
    const why = here.locked ? ` (${here.locked})` : ''
    console.error(`cleanup: ${root} is locked${why} — worktree kept; unlock with \`git worktree unlock\``)
    return false
  }
  const status = gitTry(['-c', 'status.showUntrackedFiles=all', '-C', root, 'status', '--porcelain'])
  if (status.code !== 0 || status.out.trim() !== '') {
    console.error(
      status.code !== 0
        ? `cleanup: cannot verify ${root} is clean (${status.err}) — worktree kept`
        : `cleanup: ${root} has uncommitted changes — worktree kept`
    )
    return false
  }
  // initialized submodules need a second --force to override
  const force = hasSubmodules(root) ? ['--force', '--force'] : ['--force']
  const res = gitTry(['-C', main.path, 'worktree', 'remove', ...force, root])
  if (res.code !== 0) {
    console.error(`cleanup: worktree ${root} not removed (${res.err})`)
    return false
  }
  process.chdir(main.path) // cwd is gone — git ops below need a live dir
  console.log(`cleanup: removed worktree ${root}`)
  console.log(`cleanup: cd ${main.path}`)
  return true
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
