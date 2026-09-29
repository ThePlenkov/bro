/**
 * `bro loop` — the autonomous backlog runner as a command, not a prompt
 * convention. bro owns the loop: claim the top ready bead (same rules as
 * `bro next`) → fresh sibling worktree → spawn the configured agent →
 * drive the act gate (merge on green, respawn the agent on review
 * threads up to loop.fixRounds) → bd close → repeat until the queue is
 * idle or gated.
 *
 *   bro loop                    run until idle/gated
 *   bro loop --max 3            at most 3 beads
 *   bro loop --dry-run          print the first item's plan, change nothing
 *   bro loop --agent 'claude -p "$(cat {promptFile})"'
 *
 * The agent contract: `{promptFile}` in `loop.agent` (bro.config) is
 * replaced with the work-order file path; without the placeholder the
 * path is appended as the last arg. Spawned in the worktree with
 * BRO_BEAD_ID / BRO_BEAD_TITLE / BRO_PROMPT_FILE in env. The agent's job
 * ends at an open PR — merging stays with the gate here.
 *
 * Human gates, epics, and molecule steps are never claimed (next's
 * rules). A bead whose agent fails without a PR is reopened with a
 * note; a bead whose PR stalls keeps its worktree for inspection.
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  checkBeads,
  gitTry,
  reviewHost,
  taskStore,
  type ReviewFacade,
} from '@bro/core'
import { evaluateExitGate, fetchPrActState, waitForGate } from '@bro/act'
import {
  buildFixPrompt,
  buildWorkPrompt,
  expandAgentCmd,
  planItem,
  type LoopConfig,
} from '@bro/loop'
import { loadBroConfig } from '../plugins.ts'
import { flag } from './args.ts'
import { runActCommand } from './act.ts'
import { runSyncCommand } from './sync.ts'
import { parseWorktreePorcelain } from './work.ts'
import {
  claimUpTo,
  classify,
  epicParentIds,
  nextScope,
  readyBeads,
  type ReadyBead,
} from './next.ts'

interface Ctx {
  /** Review facade bound to the main checkout — host calls follow the
   *  repo, not the caller's cwd. `repo` is its 'owner/name'. */
  rev: ReviewFacade
  repo: string
  root: string
  cfg: LoopConfig
  agent: string
  intervalS: number
  json: boolean
  /** Cleanup failures collected during the run — the end-of-run audit
   *  prints them again so a tail never dies in a scrollback line. */
  tails: string[]
}

/** Clickable PR ref for this repo — user-facing lines never print bare #N. */
const prRef = (ctx: Ctx, pr: number): string => ctx.rev.prLink(ctx.repo, pr)

function usage(): never {
  console.error(`Usage: bro loop [--max N] [--dry-run] [--json]
  --agent '<cmd {promptFile}>'   agent template (config: loop.agent)
  --agent-timeout MIN            per-spawn budget (loop.agentTimeoutMin, 45)
  --merge-timeout MIN            gate budget per round (loop.mergeTimeoutMin, 45)
  --interval SEC                 gate poll interval (60)`)
  process.exit(2)
}

const num = (v: string | undefined, dflt: number, min = 1): number => {
  if (v === undefined) return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < min) {
    console.error(`bro loop: invalid numeric value "${v}" (must be >= ${min})`)
    process.exit(2)
  }
  return n
}

/** Progress lines — stderr under --json so stdout stays a clean
 *  event stream. */
const say = (ctx: Ctx, msg: string): void => {
  if (ctx.json) {
    console.error(msg)
  } else {
    console.log(msg)
  }
}

/** Agent commands resolve through PATH by design — bro orchestrates the
 *  operator-configured agent; a sanitized PATH would break the very
 *  binary the config names. NOSONAR lives on the spawn helpers. */

/** Fresh sibling worktree on loop/<id> off origin/main (falls back to
 *  main/HEAD when no origin). An existing dir is reused as-is. */
function ensureWorktree(root: string, branch: string, dir: string): void {
  if (existsSync(dir)) {
    return // a previous run's worktree survived — reuse it
  }
  gitTry(['-C', root, 'fetch', 'origin', 'main', '--quiet'])
  const base = ['origin/main', 'main', 'HEAD'].find(
    (r) => gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', r]).code === 0
  )
  const add = gitTry(['-C', root, 'worktree', 'add', '-b', branch, dir, base ?? 'HEAD'])
  if (add.code !== 0) {
    // branch may already exist from a previous run — attach to it
    const retry = gitTry(['-C', root, 'worktree', 'add', dir, branch])
    if (retry.code !== 0) {
      throw new Error(`git worktree add failed: ${retry.err || add.err}`)
    }
  }
}

/** Spawn the agent detached in the worktree so the timeout can kill the
 *  whole process group — `spawnSync`'s timeout signals only the direct
 *  `sh` child, leaving a timed-out agent writing in the tree. Under
 *  --json the child's stdout is routed to stderr so the JSONL stream
 *  stays parseable. */
function spawnAgent(ctx: Ctx, beadId: string, title: string, promptFile: string, dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', expandAgentCmd(ctx.agent, promptFile)], { // NOSONAR — operator-configured agent command
      cwd: dir,
      env: {
        ...process.env,
        BRO_BEAD_ID: beadId,
        BRO_BEAD_TITLE: title,
        BRO_PROMPT_FILE: promptFile,
      },
      stdio: ['inherit', ctx.json ? 2 : 'inherit', 'inherit'],
      detached: true,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL') // detached → own group
      } catch {
        child.kill('SIGKILL')
      }
    }, ctx.cfg.agentTimeoutMin * 60_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      console.error(`loop: agent spawn failed — ${err.message}`)
      resolve(null)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (timedOut || signal) {
        console.error(`loop: agent killed (${signal ?? 'timeout'}) — budget ${ctx.cfg.agentTimeoutMin}m`)
        resolve(null)
        return
      }
      resolve(code)
    })
  })
}

/** PR number opened from this worktree's branch — null when none,
 *  'lookup-error' when gh itself failed (not the same thing: a failed
 *  lookup must not reopen a bead whose PR may still exist). */
function findPr(ctx: Ctx, branch: string): number | null | 'lookup-error' {
  try {
    return ctx.rev.prsForBranch(branch)[0] ?? null
  } catch {
    return 'lookup-error'
  }
}

function noteBead(id: string, note: string): void {
  try {
    taskStore().update(id, { notes: note })
  } catch {
    console.error(`loop: could not note ${id} — ${note}`)
  }
}

/** Best-effort return of a bead to the open queue. */
function reopenBead(id: string): void {
  try {
    taskStore().update(id, { status: 'open' })
  } catch { /* best-effort unclaim */ }
}

/** Merge the PR, close the bead, drop the worktree. 'landed' only when
 *  the PR reports MERGED — a closed or still-open PR parks the bead.
 *  `alreadyMerged` skips the merge call for PRs that landed externally
 *  while the gate was polling. */
async function finalizeMerge(
  ctx: Ctx,
  bead: ReadyBead,
  item: ReturnType<typeof planItem>,
  pr: number,
  alreadyMerged = false
): Promise<string> {
  try {
    if (!alreadyMerged) {
      await runActCommand(['merge', String(pr)])
    }
    const state = ctx.rev.prMeta({ repo: ctx.repo, pr }).state
    if (state !== 'MERGED') {
      noteBead(
        bead.id,
        `loop: merge of ${prRef(ctx, pr)} did not land (state=${state}) — worktree ${item.worktreeDir}`
      )
      return 'parked'
    }
  } catch (err) {
    // a merge/fetch failure must not abort the loop leaving the bead
    // claimed forever — note it and park
    noteBead(
      bead.id,
      `loop: finalizing ${prRef(ctx, pr)} failed — ${err instanceof Error ? err.message : String(err)} — worktree ${item.worktreeDir}`
    )
    return 'parked'
  }
  try {
    taskStore().close(bead.id, `landed via PR ${prRef(ctx, pr)}`)
  } catch (err) {
    console.error(`loop: bd close ${bead.id} failed — ${String(err)}`)
  }
  // an agent-initialized submodule inside the worktree blocks removal —
  // deinit first; either way a failed cleanup is loud, never silent
  gitTry(['-C', item.worktreeDir, 'submodule', 'deinit', '-f', '--all'])
  const rm = gitTry(['-C', ctx.root, 'worktree', 'remove', '--force', item.worktreeDir])
  if (rm.code !== 0) {
    ctx.tails.push(`worktree ${item.worktreeDir} not removed — ${rm.err.trim()}`)
    console.error(`loop: ${ctx.tails.at(-1)}`)
  }
  const br = gitTry(['-C', ctx.root, 'branch', '-D', item.branch])
  if (br.code !== 0) {
    ctx.tails.push(`branch ${item.branch} not deleted — ${br.err.trim()}`)
    console.error(`loop: ${ctx.tails.at(-1)}`)
  }
  say(ctx, `loop: ${bead.id} landed via ${prRef(ctx, pr)}`)
  return 'landed'
}

/** Collect unresolved thread text, write the fix prompt, respawn the
 *  agent. A dead fix agent is logged, not fatal — the next gate poll
 *  decides whether anything landed on the branch. */
async function runFixRound(
  ctx: Ctx,
  bead: ReadyBead,
  item: ReturnType<typeof planItem>,
  pr: number,
  round: number
): Promise<void> {
  const threads = (await ctx.rev.reviewThreads({ repo: ctx.repo, pr }))
    .filter((t) => !t.resolved)
    .map((t) => {
      const c = t.comment
      return `- ${c?.path ?? ''}:${c?.line ?? ''} [${c?.author ?? '?'}] ${c?.body ?? ''}`
    })
    .join('\n')
  writePrompt(item, buildFixPrompt(bead, pr, threads))
  say(ctx, `loop: ${prRef(ctx, pr)} has open threads — fix round ${round}`)
  const code = await spawnAgent(ctx, bead.id, bead.title, item.promptFile, item.worktreeDir)
  if (code !== 0) {
    console.error(`loop: fix agent exited ${code ?? 'timeout'} — the next gate poll decides`)
  }
}

/** Agent exited without a PR — note + reopen, 'failed'. */
function failNoPr(
  bead: ReadyBead,
  item: ReturnType<typeof planItem>,
  code: number | null
): string {
  noteBead(
    bead.id,
    `loop: agent exited ${code ?? 'timeout'} without a PR — worktree kept at ${item.worktreeDir}`
  )
  reopenBead(bead.id)
  return 'failed'
}

/** Optional bootstrap command — false (with the bead noted + reopened)
 *  when it fails; spawning the agent on a half-set-up worktree is worse
 *  than failing fast. */
function runBootstrap(ctx: Ctx, bead: ReadyBead, item: ReturnType<typeof planItem>): boolean {
  if (!ctx.cfg.bootstrap) {
    return true
  }
  const b = spawnSync('sh', ['-c', ctx.cfg.bootstrap], { // NOSONAR — operator-configured bootstrap
    cwd: item.worktreeDir,
    stdio: ['inherit', ctx.json ? 2 : 'inherit', 'inherit'],
  })
  if (b.status === 0) {
    return true
  }
  noteBead(
    bead.id,
    `loop: bootstrap failed (${b.status ?? b.signal ?? 'spawn error'}) — worktree kept at ${item.worktreeDir}`
  )
  reopenBead(bead.id)
  return false
}

/** The work-order file lives outside the worktree (see planItem) —
 *  its parent dir may not exist yet. */
function writePrompt(item: ReturnType<typeof planItem>, text: string): void {
  mkdirSync(dirname(item.promptFile), { recursive: true })
  writeFileSync(item.promptFile, text)
}

/** One bead end-to-end. Returns 'landed' | 'parked' | 'failed'. */
async function runItem(ctx: Ctx, bead: ReadyBead): Promise<string> {
  const item = planItem(bead, ctx.root)
  say(ctx, `\nloop: ${bead.id} → ${item.branch} @ ${item.worktreeDir}`)
  try {
    ensureWorktree(ctx.root, item.branch, item.worktreeDir)
  } catch (err) {
    noteBead(bead.id, `loop: worktree failed — ${err instanceof Error ? err.message : String(err)}`)
    reopenBead(bead.id)
    return 'failed'
  }
  if (!runBootstrap(ctx, bead, item)) {
    return 'failed'
  }
  writePrompt(item, buildWorkPrompt(bead, item.branch))
  const code = await spawnAgent(ctx, bead.id, bead.title, item.promptFile, item.worktreeDir)
  const pr = findPr(ctx, item.branch)
  if (pr === 'lookup-error') {
    noteBead(bead.id, `loop: PR lookup failed for ${item.branch} — worktree ${item.worktreeDir}`)
    return 'parked'
  }
  if (pr === null) {
    return failNoPr(bead, item, code)
  }
  say(ctx, `loop: ${bead.id} → PR ${prRef(ctx, pr)}`)
  return driveGate(ctx, bead, item, pr)
}

/** The PR gate loop — poll until the gate settles; merge on green,
 *  respawn the agent on open threads (up to loop.fixRounds), park on
 *  timeout/fetch-exhaustion/hard blocks. */
async function driveGate(
  ctx: Ctx,
  bead: ReadyBead,
  item: ReturnType<typeof planItem>,
  pr: number
): Promise<string> {
  const act = loadBroConfig(ctx.root).act
  const fetch = async () => {
    const state = await fetchPrActState(
      ctx.rev,
      { repo: ctx.repo, pr },
      { ignoreChecks: act.ignoreChecks, maxRounds: act.maxRounds }
    )
    return { state, gate: evaluateExitGate(state) }
  }
  for (let round = 0; ; round++) {
    let res
    try {
      res = await waitForGate(fetch, {
        intervalMs: ctx.intervalS * 1000,
        timeoutMs: ctx.cfg.mergeTimeoutMin * 60_000,
        onPoll: (s, g) =>
          console.error(
            `loop ${prRef(ctx, pr)}: threads=${g.open_threads} ci=${g.ci_pending}+${g.ci_failing}f rev=${g.reviewers_pending} sast=${g.sast_pending}`
          ),
        onError: (err, n) =>
          console.error(`loop ${prRef(ctx, pr)}: fetch failed (${n}) — ${String(err)}`),
        // same as `act wait`: BEHIND + mergeable is a state to fix, not
        // to park on — conflicts still settle for a human
        updateBranch: (s) => {
          const ok = ctx.rev.updateBranch({ repo: ctx.repo, pr }, s.headSha)
          console.error(
            `loop ${prRef(ctx, pr)}: update-branch ${ok ? 'pushed a new head' : 'refused'}`
          )
          return ok
        },
      })
    } catch (err) {
      noteBead(
        bead.id,
        `loop: gate fetch kept failing for PR ${prRef(ctx, pr)} — ${String(err)} — worktree ${item.worktreeDir}`
      )
      return 'parked'
    }
    if (res.state.state === 'MERGED') {
      // landed externally (reviewer/bot merge) while we polled — close out
      return finalizeMerge(ctx, bead, item, pr, true)
    }
    if (res.state.state === 'CLOSED') {
      noteBead(bead.id, `loop: PR ${prRef(ctx, pr)} was closed unmerged — worktree ${item.worktreeDir}`)
      return 'parked'
    }
    if (res.gate.ok) {
      return finalizeMerge(ctx, bead, item, pr)
    }
    if (res.state.openThreads > 0 && round < ctx.cfg.fixRounds) {
      await runFixRound(ctx, bead, item, pr, round + 1)
      continue
    }
    const why = res.timedOut
      ? `gate still pending after ${ctx.cfg.mergeTimeoutMin}m`
      : `blocked: ${res.gate.blockers.join('; ')}`
    noteBead(bead.id, `loop: PR ${prRef(ctx, pr)} ${why} — worktree ${item.worktreeDir}`)
    return 'parked'
  }
}

export async function runLoopCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  checkBeads()
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim()
  if (!root) {
    console.error('bro loop: not inside a git worktree')
    process.exit(1)
  }
  const broCfg = loadBroConfig(root)
  const cfg = broCfg.loop as LoopConfig
  const agent = flag(argv, '--agent') ?? cfg.agent
  if (!agent) {
    console.error(
      'bro loop: no agent configured — set loop.agent in bro.config ' +
        '(e.g. "devin --prompt-file {promptFile} -p") or pass --agent'
    )
    process.exit(2)
  }
  const rev = reviewHost(root, broCfg.connectors)
  const ctx: Ctx = {
    rev,
    repo: rev.resolveRepo([]),
    root,
    cfg: {
      ...cfg,
      agentTimeoutMin: num(flag(argv, '--agent-timeout'), cfg.agentTimeoutMin),
      mergeTimeoutMin: num(flag(argv, '--merge-timeout'), cfg.mergeTimeoutMin),
      maxItems: num(flag(argv, '--max'), cfg.maxItems, 0),
    },
    agent,
    intervalS: num(flag(argv, '--interval'), 60),
    json: argv.includes('--json'),
    tails: [],
  }

  if (argv.includes('--dry-run')) {
    const scope = loopScope()
    if (!scope) {
      return
    }
    const ready = readyBeads()
    const top = classify(ready, undefined, scope, epicParentIds(ready)).queue[0]
    if (!top) {
      console.log('loop --dry-run: nothing claimable')
      return
    }
    const item = planItem(top, root)
    console.log(`would claim ${top.id} — ${top.title}`)
    console.log(`  worktree ${item.worktreeDir} on ${item.branch}`)
    console.log(`  agent: ${expandAgentCmd(ctx.agent, item.promptFile)}`)
    return
  }
  await runQueue(ctx)
}

/** Project scope for the queue — a failed prefix lookup is reported
 *  once, not thrown into the claim loop. */
function loopScope(): ReturnType<typeof nextScope> | null {
  try {
    return nextScope('project') // prefix is stable for the run
  } catch (err) {
    console.error(`loop: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Open PRs on local loop/* branches — exact per-branch lookup, so the
 *  audit is bounded by the repo's own tail set, not a global PR cap. */
function openLoopPrs(ctx: Ctx, branches: string[]): string[] {
  const out: string[] = []
  for (const b of branches) {
    try {
      for (const pr of ctx.rev.prsForBranch(b)) {
        out.push(`${prRef(ctx, pr)} (${b})`)
      }
    } catch {
      out.push(`warning: PR lookup failed for ${b} — host unreachable`)
    }
  }
  return out
}

interface RefTails {
  worktrees: string[]
  branches: string[]
  errors: string[]
}

/** loop/* worktrees still checked out + loop/* branches with no
 *  worktree — both are run tails. A failed git probe reports as an
 *  error line, never as a false "clean". */
export function loopRefTails(root: string): RefTails {
  const errors: string[] = []
  const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain'])
  if (wt.code !== 0) {
    errors.push(`worktree list failed — ${wt.err || 'git error'}`)
  }
  const trees = parseWorktreePorcelain(wt.out).filter((w) => w.branch?.startsWith('loop/'))
  const onTree = new Set(trees.map((w) => w.branch!))
  const bl = gitTry(['-C', root, 'branch', '--list', 'loop/*', '--format=%(refname:short)'])
  if (bl.code !== 0) {
    errors.push(`branch list failed — ${bl.err || 'git error'}`)
  }
  const bare = bl.out.split('\n').filter((b) => b && !onTree.has(b))
  return {
    worktrees: trees.map((w) => `${w.path} [${w.branch}]`),
    branches: bare,
    errors,
  }
}

/** Beads left in_progress, split by this run's claims vs pre-existing —
 *  a shared store holds other sessions' claims too. */
function claimedTails(seen: Set<string>): { own: string[]; other: string[] } {
  try {
    const rows = taskStore().list({ status: 'in_progress' })
    const fmt = (r: { id: string; title?: string }) =>
      `${r.id} ${(r.title ?? '').replace(/\s+/g, ' ').slice(0, 60)}`.trim()
    return {
      own: rows.filter((r) => seen.has(r.id)).map(fmt),
      other: rows.filter((r) => !seen.has(r.id)).map(fmt),
    }
  } catch {
    return { own: [], other: ['warning: claimed-bead audit failed — bd unavailable'] }
  }
}

/** End-of-run sweep: every tail the loop left must be named in the run
 *  summary — open loop PRs, surviving loop worktrees/branches, claimed
 *  beads, and cleanup failures collected during the run. Finished with
 *  `bro sync` so artifacts and bead state travel. Never throws — an
 *  audit failure is reported, not raised. */
function endAudit(ctx: Ctx, seen: Set<string>): void {
  const { worktrees, branches, errors } = loopRefTails(ctx.root)
  const claimed = claimedTails(seen)
  const sections: [string, string[]][] = [
    ['open PRs', openLoopPrs(ctx, branches)],
    ['worktrees', worktrees],
    ['branches', branches],
    ['claimed beads', claimed.own],
    ['in_progress elsewhere', claimed.other],
    ['audit errors', errors],
    ['cleanup errors', ctx.tails],
  ]
  const empty = sections.every(([, items]) => items.length === 0)
  say(ctx, 'loop audit:')
  if (empty) {
    say(ctx, '  clean — no loop tails')
  } else {
    for (const [label, items] of sections) {
      for (const item of items) {
        say(ctx, `  ${label}: ${item}`)
      }
    }
  }
  // runSyncCommand narrates to stdout — in --json mode that would
  // corrupt the event stream, so route its output to stderr instead
  const log = console.log
  if (ctx.json) {
    console.log = console.error
  }
  try {
    runSyncCommand([])
  } catch (err) {
    say(ctx, `  warning: bro sync failed — ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    console.log = log
  }
}

/** The claim→run→repeat cycle until the queue drains or --max hits. */
async function runQueue(ctx: Ctx): Promise<void> {
  const seen = new Set<string>()
  const tally = { landed: 0, parked: 0, failed: 0 }
  try {
    // inside the try: a failed scope lookup still owes the run an audit
    const scope = loopScope()
    if (!scope) {
      return
    }
    for (;;) {
      if (ctx.cfg.maxItems > 0 && tally.landed + tally.parked + tally.failed >= ctx.cfg.maxItems) {
        break
      }
      const ready = readyBeads()
      const c = classify(ready, undefined, scope, epicParentIds(ready))
      const bead = claimUpTo(c.queue.filter((b) => !seen.has(b.id)), 1)[0]
      if (!bead) {
        // a foreign-only remainder must not look like a drained queue —
        // 'done' would hide work a shared db still advertises
        if (c.foreign > 0) {
          say(ctx, `loop: ${c.foreign} foreign-scope bead(s) remain — not claimable in this project`)
        }
        break
      }
      seen.add(bead.id)
      const result = (await runItem(ctx, bead)) as 'landed' | 'parked' | 'failed'
      tally[result] += 1
      if (ctx.json) {
        console.log(JSON.stringify({ bead: bead.id, result }))
      }
    }
    if (ctx.json) {
      console.log(JSON.stringify({ done: true, ...tally }))
    } else {
      console.log(
        `loop: done — ${tally.landed} landed, ${tally.parked} parked, ${tally.failed} failed`
      )
    }
  } finally {
    // idle, gated, or error — the audit always runs; a tail the loop
    // left must surface in the summary, not be discovered later
    endAudit(ctx, seen)
  }
}
