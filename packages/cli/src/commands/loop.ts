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
import { spawnSync, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { bd, bdJson, checkBeads, gitTry } from '@bro/core'
import { evaluateExitGate, fetchPrActState, waitForGate } from '@bro/act'
import { fetchReviewThreads } from '@bro/debt'
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
import { claimUpTo, classify, type ReadyBead } from './next.ts'

interface Ctx {
  owner: string
  repo: string
  root: string
  cfg: LoopConfig
  agent: string
  intervalS: number
}

function usage(): never {
  console.error(`Usage: bro loop [--max N] [--dry-run] [--json]
  --agent '<cmd {promptFile}>'   agent template (config: loop.agent)
  --agent-timeout MIN            per-spawn budget (loop.agentTimeoutMin, 45)
  --merge-timeout MIN            gate budget per round (loop.mergeTimeoutMin, 45)
  --interval SEC                 gate poll interval (60)`)
  process.exit(2)
}

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

function repoTarget(root: string): { owner: string; repo: string } {
  const out = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd: root, encoding: 'utf8' }
  ).trim() // NOSONAR — PATH lookup is the contract
  const [owner, repo] = out.split('/')
  if (!owner || !repo) {
    throw new Error(`gh repo view returned "${out}"`)
  }
  return { owner, repo }
}

/** Fresh sibling worktree on loop/<id> off origin/main (falls back to
 *  main/HEAD when no origin). An existing dir is reused as-is. */
function ensureWorktree(root: string, branch: string, dir: string): void {
  if (gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', dir]).code === 0) {
    return // path exists on disk — not a worktree check, cheap reuse
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

/** Spawn the agent synchronously in the worktree — inherit stdio so the
 *  run is observable; timeout kills the process group. */
function spawnAgent(ctx: Ctx, beadId: string, title: string, promptFile: string, dir: string): number | null {
  const res = spawnSync('sh', ['-c', expandAgentCmd(ctx.agent, promptFile)], {
    cwd: dir,
    env: {
      ...process.env,
      BRO_BEAD_ID: beadId,
      BRO_BEAD_TITLE: title,
      BRO_PROMPT_FILE: promptFile,
    },
    stdio: 'inherit',
    timeout: ctx.cfg.agentTimeoutMin * 60_000,
  })
  if (res.error) {
    console.error(`loop: agent spawn failed — ${res.error.message}`)
    return null
  }
  if (res.signal) {
    console.error(`loop: agent killed (${res.signal}) — timeout ${ctx.cfg.agentTimeoutMin}m`)
    return null
  }
  return res.status
}

/** PR number opened from this worktree's branch, or null. */
function findPr(dir: string, branch: string): number | null {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number // empty'],
      { cwd: dir, encoding: 'utf8' }
    ).trim()
    return out === '' ? null : Number(out)
  } catch {
    return null
  }
}

function noteBead(id: string, note: string): void {
  try {
    bd(['update', id, '--notes', note])
  } catch {
    console.error(`loop: could not note ${id} — ${note}`)
  }
}

/** One bead end-to-end. Returns 'landed' | 'parked' | 'failed'. */
async function runItem(ctx: Ctx, bead: ReadyBead): Promise<string> {
  const item = planItem(bead, ctx.root)
  console.log(`\nloop: ${bead.id} → ${item.branch} @ ${item.worktreeDir}`)
  try {
    ensureWorktree(ctx.root, item.branch, item.worktreeDir)
  } catch (err) {
    noteBead(bead.id, `loop: worktree failed — ${err instanceof Error ? err.message : String(err)}`)
    return 'failed'
  }
  if (ctx.cfg.bootstrap) {
    spawnSync('sh', ['-c', ctx.cfg.bootstrap], { cwd: item.worktreeDir, stdio: 'inherit' })
  }
  writeFileSync(item.promptFile, buildWorkPrompt(bead, item.branch))
  const code = spawnAgent(ctx, bead.id, bead.title, item.promptFile, item.worktreeDir)
  const pr = findPr(item.worktreeDir, item.branch)
  if (pr === null) {
    noteBead(
      bead.id,
      `loop: agent exited ${code ?? 'timeout'} without a PR — worktree kept at ${item.worktreeDir}`
    )
    try {
      bd(['update', bead.id, '--status', 'open'])
    } catch { /* best-effort unclaim */ }
    return 'failed'
  }
  console.log(`loop: ${bead.id} → PR #${pr}`)

  const act = loadBroConfig(ctx.root).act
  const fetch = async () => {
    const state = await fetchPrActState(
      { owner: ctx.owner, repo: ctx.repo, pr },
      { ignoreChecks: act.ignoreChecks, maxRounds: act.maxRounds }
    )
    return { state, gate: evaluateExitGate(state) }
  }
  for (let round = 0; ; round++) {
    const res = await waitForGate(fetch, {
      intervalMs: ctx.intervalS * 1000,
      timeoutMs: ctx.cfg.mergeTimeoutMin * 60_000,
      onPoll: (s, g) =>
        console.error(
          `loop #${pr}: threads=${g.open_threads} ci=${g.ci_pending}+${g.ci_failing}f rev=${g.reviewers_pending} sast=${g.sast_pending}`
        ),
      onError: (err, n) =>
        console.error(`loop #${pr}: fetch failed (${n}) — ${String(err)}`),
    })
    if (res.gate.ok && res.state.state === 'OPEN') {
      await runActCommand(['merge', String(pr)])
      const merged = execFileSync(
        'gh',
        ['pr', 'view', String(pr), '--json', 'state', '--jq', '.state'],
        { cwd: ctx.root, encoding: 'utf8' }
      ).trim()
      if (merged === 'MERGED') {
        bd(['close', bead.id, '--reason', `landed via PR #${pr}`])
        gitTry(['-C', ctx.root, 'worktree', 'remove', '--force', item.worktreeDir])
        gitTry(['-C', ctx.root, 'branch', '-D', item.branch])
        console.log(`loop: ${bead.id} landed via #${pr}`)
        return 'landed'
      }
    }
    if (res.state.openThreads > 0 && round < ctx.cfg.fixRounds) {
      const threads = (await fetchReviewThreads({ owner: ctx.owner, repo: ctx.repo, pr }))
        .filter((t) => !t.isResolved)
        .map((t) => {
          const c = t.comments.nodes[0]
          return `- ${c?.path ?? ''}:${c?.line ?? ''} [${c?.author?.login ?? '?'}] ${c?.body ?? ''}`
        })
        .join('\n')
      writeFileSync(item.promptFile, buildFixPrompt(bead, pr, threads))
      console.log(`loop: #${pr} has ${res.state.openThreads} thread(s) — fix round ${round + 1}`)
      spawnAgent(ctx, bead.id, bead.title, item.promptFile, item.worktreeDir)
      continue
    }
    const why = res.timedOut
      ? `gate still pending after ${ctx.cfg.mergeTimeoutMin}m`
      : `blocked: ${res.gate.blockers.join('; ')}`
    noteBead(bead.id, `loop: PR #${pr} ${why} — worktree ${item.worktreeDir}`)
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
  const cfg = loadBroConfig(root).loop as LoopConfig
  const agent = flag(argv, '--agent') ?? cfg.agent
  if (!agent) {
    console.error(
      'bro loop: no agent configured — set loop.agent in bro.config ' +
        '(e.g. "devin --prompt-file {promptFile} -p") or pass --agent'
    )
    process.exit(2)
  }
  const ctx: Ctx = {
    ...repoTarget(root),
    root,
    cfg: {
      ...cfg,
      agentTimeoutMin: num(flag(argv, '--agent-timeout'), cfg.agentTimeoutMin),
      mergeTimeoutMin: num(flag(argv, '--merge-timeout'), cfg.mergeTimeoutMin),
      maxItems: num(flag(argv, '--max'), cfg.maxItems),
    },
    agent,
    intervalS: num(flag(argv, '--interval'), 60),
  }

  if (argv.includes('--dry-run')) {
    const ready = bdJson<ReadyBead[]>(['ready', '--json'])
    const top = classify(ready).queue[0]
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

  const seen = new Set<string>()
  const tally = { landed: 0, parked: 0, failed: 0 }
  for (;;) {
    if (ctx.cfg.maxItems > 0 && tally.landed + tally.parked + tally.failed >= ctx.cfg.maxItems) {
      break
    }
    const ready = bdJson<ReadyBead[]>(['ready', '--json'])
    const bead = claimUpTo(classify(ready).queue.filter((b) => !seen.has(b.id)), 1)[0]
    if (!bead) {
      break
    }
    seen.add(bead.id)
    tally[(await runItem(ctx, bead)) as 'landed' | 'parked' | 'failed'] += 1
  }
  console.log(
    `loop: done — ${tally.landed} landed, ${tally.parked} parked, ${tally.failed} failed`
  )
}
