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
 *   bro loop --agent kilo-cli   spawn through providers.kilo-cli (acp/cli)
 *
 * The agent contract: a `--agent` value that exactly names a configured
 * `providers.<name>` (or `--provider`/`--profile`/`loop.provider`)
 * resolves through the spawn facade — acp providers run `bro acp-worker`
 * headless, cli providers substitute their command for the template.
 * Any other `--agent` value is the raw shell template (the escape
 * hatch): `{promptFile}` in `loop.agent` (bro.config) is replaced with
 * the work-order file path; without the placeholder the path is appended
 * as the last arg. Spawned in the worktree with BRO_BEAD_ID /
 * BRO_BEAD_TITLE / BRO_PROMPT_FILE in env. The agent's job ends at an
 * open PR — merging stays with the gate here.
 *
 * Human gates, epics, and molecule steps are never claimed (next's
 * rules). A bead whose agent fails without a PR is reopened with a
 * note; a bead whose PR stalls keeps its worktree for inspection.
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  bdTry,
  commandCliName,
  ensureTasksBackend,
  facade,
  gitTry,
  LockTimeout,
  reviewHost,
  SpawnError,
  stepParent,
  withFileLock,
  type ReviewFacade,
  type SpawnWorker,
  type TaskStore,
} from '@broject/core'
import { checkHistory, evaluateExitGate, fetchPrActState, waitForGate } from '@broject/act'
import {
  buildFixPrompt,
  buildWorkPrompt,
  expandAgentCmd,
  planItem,
  type LoopConfig,
} from '@broject/loop'
import { loadBroConfig } from '../plugins.ts'
import {
  fleetProfileOf,
  loadAgentEnv,
  resolveSpawnProvider,
  type AgentConnectorEnv,
  type SpawnProviderPick,
} from '../agent-connectors.ts'
import { flag, positionals } from './args.ts'
import { runActCommand } from './act.ts'
import { runSyncCommand } from './sync.ts'
import { mergedBranches, stackMemberFor, stackTip, syncStack } from './stack.ts'
import { isStackName } from '@broject/stack'
import { loopSlug } from '@broject/loop'
import {
  defaultBranchName,
  parseWorktreePorcelain,
  reapLoopLitter,
  readStackEdges,
  recordStackEdge,
  stackPushLockPath,
  type LitterReap,
} from './work.ts'
import {
  claimUpTo,
  classify,
  epicParentIds,
  nextScope,
  readyBeads,
  type ReadyBead,
} from './next.ts'
import type { NextPlan } from './next-plan.ts'

interface Ctx {
  /** Review facade bound to the main checkout — host calls follow the
   *  repo, not the caller's cwd. `repo` is its 'owner/name'. */
  rev: ReviewFacade
  /** The serving tasks backend — beads by default, a pinned connector
   *  (`connectors.tasks`) otherwise. All bead mutations go through it. */
  tasks: TaskStore
  /** Resolved tasks connector name — beads-only tails (BEADS_DIR,
   *  molecule provenance) engage only on 'beads'. */
  backend: string
  repo: string
  root: string
  cfg: LoopConfig
  /** The template `expandAgentCmd` runs — `loop.agent`/`--agent`, or a
   *  cli provider's `command` when the provider lane resolved one. For an
   *  acp (argv) worker this field is inert — the spawn never expands it. */
  agent: string
  lane: LoopLane
  intervalS: number
  json: boolean
  /** Declared label scope — `bro loop --label debt,ui` only claims
   *  beads carrying one of these labels; the rest of the shared queue
   *  stays untouched. */
  selection: Pick<NextPlan, 'filters' | 'gates' | 'order'>
  /** The beads dir the loop's task store resolves to — pinned into
   *  agent and bootstrap env as BEADS_DIR so worktree `bd` writes reach
   *  it. Undefined on a non-beads backend: nothing to pin. */
  beadsDir?: string
  /** `bro loop --stack <name>` — each claimed bead becomes a member of
   *  the named stack: branch stack/<name>/<n>-<slug> based on the tip,
   *  PR targeting the member below. */
  stack?: string
  /** Cleanup failures collected during the run — the end-of-run audit
   *  prints them again so a tail never dies in a scrollback line. */
  tails: string[]
}

/** Clickable PR ref for this repo — user-facing lines never print bare #N. */
const prRef = (ctx: Ctx, pr: number): string => ctx.rev.prLink(ctx.repo, pr)

function usage(): never {
  console.error(`Usage: bro loop [--max N] [--dry-run] [--json] [--label a,b] [--stack NAME]
  --agent '<cmd {promptFile}>'   agent template (config: loop.agent) —
                                a value naming a configured providers.<name>
                                spawns through the provider registry instead
  --provider NAME                providers.<name> pick (acp → headless worker)
  --profile NAME                 fleet.profiles.<name> preset
  --model M                      model override for the provider lane
  --auto-approve                 acp permission policy: allow, not deny
  --agent-timeout MIN            per-spawn budget (loop.agentTimeoutMin, 45)
  --merge-timeout MIN            gate budget per round (loop.mergeTimeoutMin, 45)
  --label a,b                    declared scope — only beads carrying one
                                of these labels are claimable
  --stack NAME                   chain claimed beads onto stack NAME —
                                each PR targets the member below
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

type ItemResult = 'landed' | 'closed' | 'parked' | 'failed'

/** The beads dir the loop's own taskStore calls resolve to (`bd where`
 *  from the run root). Pinned into spawned envs as BEADS_DIR — a
 *  worktree-local .beads (tracked copy, stale checkout) or a bd too old
 *  for common-dir discovery would otherwise fork bead state: the agent's
 *  close/update lands in a db that dies with the worktree and the bead
 *  re-surfaces phantom-open in main. */
export function resolveBeadsDir(root: string, warn?: (msg: string) => void): string | undefined {
  const fail = (why: string): undefined => {
    warn?.(`loop: 'bd where' ${why} — agents run unpinned, BEADS_DIR not set`)
    return undefined
  }
  const res = bdTry(['where', '--json'], 15_000, root)
  if (res.code !== 0) {
    return fail(`exited ${res.code}${res.err ? `: ${res.err}` : ''}`)
  }
  try {
    const path = (JSON.parse(res.out) as { path?: string }).path
    return path ?? fail('returned no path')
  } catch {
    return fail('returned malformed JSON')
  }
}

/** Spawn env shared by agent and bootstrap — BEADS_DIR pins every bd
 *  the child runs to the loop's store. Provenance pins the ambient env
 *  can't spoof: BRO_AGENT/BRO_MOL_ID come from the connector (extra),
 *  and ambient copies are stripped so a parent worker's badge can't
 *  bleed into the child's commits (bro-fzot). */
function agentEnv(ctx: Ctx, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of [
    'BRO_AGENT',
    'BRO_AGENT_PROVIDER',
    'BRO_AGENT_MODEL',
    'BRO_SESSION_ID',
    'BRO_MOL_ID',
  ]) {
    delete env[k]
  }
  return {
    ...env,
    ...(ctx.beadsDir ? { BEADS_DIR: ctx.beadsDir } : {}),
    ...extra,
  }
}

/** Commit-provenance pins for the loop's agent (bro-fzot) — the cli the
 *  effective command names (the acp worker's `cliName` on the argv lane),
 *  the provider/model lane labels, and the bead's molecule parent when
 *  the shared store can answer. */
function provenancePins(ctx: Ctx, beadId: string): Record<string, string> {
  const w = ctx.lane.worker
  const pins: Record<string, string> = {
    BRO_AGENT: w?.kind === 'argv' ? (w.cliName ?? 'agent') : commandCliName(ctx.agent),
  }
  if (ctx.lane.provider !== undefined) {
    pins.BRO_AGENT_PROVIDER = ctx.lane.provider
  }
  if (ctx.lane.model !== undefined) {
    pins.BRO_AGENT_MODEL = ctx.lane.model
  }
  const mol = ctx.beadsDir !== undefined ? stepParent(ctx.beadsDir, beadId) : undefined
  if (mol !== undefined) {
    pins.BRO_MOL_ID = mol
  }
  return pins
}

// --- the agent lane: provider registry or raw template (spec bro-c3no8) -------

/** What a spawn runs — the provider-resolved worker when the provider
 *  lane engaged, undefined for the raw `loop.agent`/`--agent` template. */
export interface LoopLane {
  worker?: SpawnWorker
  /** Resolved provider name + model — provenance pins and reporting
   *  (`bro agents up` prints the same pair). */
  provider?: string
  model?: string
}

/** Per-run lane picks — undefined means "not given" so config fields
 *  still apply piecewise, mirroring the facade's merge order. */
export interface LoopLaneSel {
  agent?: string
  provider?: string
  profile?: string
  model?: string
  autoApprove?: boolean
}

/** Resolve which lane `bro loop` spawns through. A `--agent` value that
 *  exactly names a configured `providers.<name>` IS a provider pick;
 *  any other value is the escape-hatch template and wins the whole lane
 *  (provider flags beside it are contradictory — SpawnError). The order
 *  is the facade's own: explicit pick → fleet.profiles preset →
 *  `loop.provider` → `agents.native.provider` → legacy template. A bad
 *  name throws SpawnError — the caller exits before a bead is claimed. */
export async function resolveLoopLane(
  env: AgentConnectorEnv,
  sel: LoopLaneSel,
  cfg: LoopConfig
): Promise<LoopLane> {
  const agentIsProvider =
    sel.agent !== undefined && Object.hasOwn(env.providers ?? {}, sel.agent)
  if (agentIsProvider && sel.provider !== undefined && sel.provider !== sel.agent) {
    throw new SpawnError(
      `--agent '${sel.agent}' and --provider '${sel.provider}' name different providers`,
      'input'
    )
  }
  if (sel.agent !== undefined && !agentIsProvider) {
    return templateEscape(sel, cfg)
  }
  const profileName = sel.profile ?? (cfg.profile !== '' ? cfg.profile : undefined)
  const profile = profileName !== undefined ? fleetProfileOf(env, profileName) : undefined
  const provider =
    sel.provider ??
    (agentIsProvider ? sel.agent : undefined) ??
    profile?.provider ??
    (cfg.provider !== '' ? cfg.provider : undefined)
  const model = sel.model ?? profile?.model ?? (cfg.model !== '' ? cfg.model : undefined)
  const autoApprove = sel.autoApprove ?? profile?.autoApprove
  const pick = await resolveSpawnProvider(
    env,
    'native',
    { provider, model, autoApprove },
    sel.provider !== undefined || agentIsProvider
      ? 'flag'
      : profile?.provider !== undefined
        ? 'profile'
        : 'backend'
  )
  return providerLaneOrEmpty(pick, model, autoApprove)
}

/** The escape hatch — a template --agent replaces the provider lane for
 *  this run, config picks included; provider flags beside it are
 *  contradictory input. */
function templateEscape(sel: LoopLaneSel, cfg: LoopConfig): LoopLane {
  const extras = [
    sel.provider !== undefined ? '--provider' : undefined,
    sel.profile !== undefined ? '--profile' : undefined,
    sel.model !== undefined ? '--model' : undefined,
    sel.autoApprove === true ? '--auto-approve' : undefined,
  ].filter((f): f is string => f !== undefined)
  if (extras.length > 0) {
    throw new SpawnError(
      `${extras.join(', ')} pick a provider, but --agent '${sel.agent}' is a ` +
        'raw template — name the provider instead (--agent <name>)',
      'input'
    )
  }
  if (cfg.provider !== '' || cfg.profile !== '' || cfg.model !== '') {
    console.error(
      'loop: --agent template bypasses the configured provider lane ' +
        '(loop.provider/loop.profile/loop.model)'
    )
  }
  return {}
}

/** A pick without a worker is the raw template lane — but only when
 *  nothing provider-only was asked for: a dangling model/autoApprove
 *  (flag, profile preset, or loop.model) is a config error, not a
 *  silent drop onto the template. */
function providerLaneOrEmpty(
  pick: SpawnProviderPick,
  model: string | undefined,
  autoApprove: boolean | undefined
): LoopLane {
  if (pick.worker !== undefined) {
    return { worker: pick.worker, provider: pick.provider, model: pick.model }
  }
  if (model !== undefined || autoApprove === true) {
    throw new SpawnError(
      '--model/--auto-approve (or loop.model) ride the provider lane — name a ' +
        'provider via --provider, --agent <name>, or loop.provider',
      'config'
    )
  }
  return {}
}

/** Dry-run rendering for an argv worker — single-quotes only the args
 *  that need it, so the printed line stays readable. */
const shRender = (s: string): string =>
  /[\s'"\\]/.test(s) ? `'${s.replaceAll("'", String.raw`'\''`)}'` : s

/** Fresh sibling worktree on loop/<id> off origin/main (falls back to
 *  main/HEAD when no origin) — or off `base` when a stack already picked
 *  the fork point. An existing dir is reused as-is. */
function ensureWorktree(root: string, branch: string, dir: string, base?: string): void {
  if (existsSync(dir)) {
    return // a previous run's worktree survived — reuse it
  }
  if (base === undefined) {
    gitTry(['-C', root, 'fetch', 'origin', 'main', '--quiet'])
    base = ['origin/main', 'main', 'HEAD'].find(
      (r) => gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', r]).code === 0
    )
  }
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
    const env = agentEnv(ctx, {
      BRO_BEAD_ID: beadId,
      BRO_BEAD_TITLE: title,
      BRO_PROMPT_FILE: promptFile,
      ...provenancePins(ctx, beadId),
    })
    const opts = {
      cwd: dir,
      env,
      stdio: ['inherit', ctx.json ? 2 : 'inherit', 'inherit'] as Array<'inherit' | number>,
      detached: true,
    }
    const w = ctx.lane.worker
    const child =
      w?.kind === 'argv'
        ? // the same `"$@"` positional exec the native backend builds —
          // argv workers are headless by construction (acp); sh resolves
          // argv[0] ('bro'/'npx') on PATH the way the backend does
          spawn('sh', ['-c', 'exec "$@"', 'loop-agent', ...w.argv, promptFile], opts) // NOSONAR — argv[0] resolves on PATH by design, same as the backend's spawn
        : spawn('sh', ['-c', expandAgentCmd(ctx.agent, promptFile)], opts) // NOSONAR — operator-configured agent command
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

function noteBead(tasks: TaskStore, id: string, note: string): void {
  try {
    tasks.update(id, { notes: note })
  } catch {
    console.error(`loop: could not note ${id} — ${note}`)
  }
}

/** Best-effort return of a bead to the open queue. */
function reopenBead(tasks: TaskStore, id: string): void {
  try {
    tasks.reopen(id)
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
): Promise<ItemResult> {
  try {
    if (!alreadyMerged) {
      await runActCommand(['merge', String(pr)])
    }
    const state = ctx.rev.prMeta({ repo: ctx.repo, pr }).state
    if (state !== 'MERGED') {
      noteBead(
        ctx.tasks,
        bead.id,
        `loop: merge of ${prRef(ctx, pr)} did not land (state=${state}) — worktree ${item.worktreeDir}`
      )
      return 'parked'
    }
  } catch (err) {
    // a merge/fetch failure must not abort the loop leaving the bead
    // claimed forever — note it and park
    noteBead(
      ctx.tasks,
      bead.id,
      `loop: finalizing ${prRef(ctx, pr)} failed — ${err instanceof Error ? err.message : String(err)} — worktree ${item.worktreeDir}`
    )
    return 'parked'
  }
  try {
    // the agent may have closed it already — a verdict plus a PR both
    // reaching the store is fine; a second close is a noisy error
    if (ctx.tasks.get(bead.id)?.status !== 'closed') {
      ctx.tasks.close(bead.id, `landed via PR ${prRef(ctx, pr)}`)
    }
  } catch (err) {
    console.error(`loop: ${ctx.backend} close ${bead.id} failed — ${String(err)}`)
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
  // Threads may have been resolved between the gate snapshot and this
  // fetch — respawning the agent on an empty fix list wastes a round.
  if (threads === '') {
    say(ctx, `loop: ${prRef(ctx, pr)} threads resolved since the gate snapshot — skipping fix round`)
    return
  }
  writePrompt(item, buildFixPrompt(bead, pr, threads))
  say(ctx, `loop: ${prRef(ctx, pr)} has open threads — fix round ${round}`)
  const code = await spawnAgent(ctx, bead.id, bead.title, item.promptFile, item.worktreeDir)
  if (code !== 0) {
    console.error(`loop: fix agent exited ${code ?? 'timeout'} — the next gate poll decides`)
  }
}

/** An agent that exits without a PR may still have left a verdict — its
 *  `bd close` lands in the shared store (BEADS_DIR pin). Closed means
 *  "nothing to ship"; reopening it would resurrect the phantom. A failed
 *  status probe falls through to the failure path rather than masking
 *  it. */
function agentVerdict(ctx: Ctx, bead: ReadyBead, worktreeDir: string): ItemResult | undefined {
  try {
    if (ctx.tasks.get(bead.id)?.status === 'closed') {
      say(ctx, `loop: ${bead.id} closed by the agent — verdict, not a failure`)
      noteBead(ctx.tasks, bead.id, `loop: closed by agent verdict — worktree ${worktreeDir} kept for audit`)
      return 'closed'
    }
  } catch { /* store unreachable → normal failure accounting decides */ }
  return undefined
}

/** Agent exited without a PR — note + reopen, 'failed'. */
function failNoPr(
  ctx: Ctx,
  bead: ReadyBead,
  item: ReturnType<typeof planItem>,
  code: number | null
): ItemResult {
  noteBead(
    ctx.tasks,
    bead.id,
    `loop: agent exited ${code ?? 'timeout'} without a PR — worktree kept at ${item.worktreeDir}`
  )
  reopenBead(ctx.tasks, bead.id)
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
    env: agentEnv(ctx, {}),
    stdio: ['inherit', ctx.json ? 2 : 'inherit', 'inherit'],
  })
  if (b.status === 0) {
    return true
  }
  noteBead(
    ctx.tasks,
    bead.id,
    `loop: bootstrap failed (${b.status ?? b.signal ?? 'spawn error'}) — worktree kept at ${item.worktreeDir}`
  )
  reopenBead(ctx.tasks, bead.id)
  return false
}

/** The work-order file lives outside the worktree (see planItem) —
 *  its parent dir may not exist yet. */
function writePrompt(item: ReturnType<typeof planItem>, text: string): void {
  mkdirSync(dirname(item.promptFile), { recursive: true })
  writeFileSync(item.promptFile, text)
}

interface StackSlot {
  /** Position the bead occupies (or joins at). */
  n: number
  /** Creation/prompt base — the live tip's branch, the recorded edge,
   *  or the default branch for a bottom member. */
  base?: string
  /** The stack edge to record — set only for a fresh member whose base
   *  is another stack branch. */
  edge?: string
  /** True when the member sits directly on the default branch. */
  bottom: boolean
}

/** The stack slot a claimed bead takes. A bead already in the stack
 *  (failed/parked retry, parked member) re-enters ITS member branch —
 *  re-deriving `n` from the tip would plan a phantom `stack/<name>/<n'>-`
 *  branch while the surviving worktree sits on the old one. A new bead
 *  joins at the live tip — merged members are skipped so the chain
 *  never forks from a dead (already-merged) branch. */
function resolveStackSlot(ctx: Ctx, bead: ReadyBead): StackSlot | undefined {
  if (ctx.stack === undefined) {
    return undefined
  }
  const dflt = defaultBranchName() ?? 'main'
  const existing = stackMemberFor(ctx.root, ctx.stack, loopSlug(bead.id))
  if (existing !== undefined) {
    const edge = readStackEdges().get(existing.branch)
    return { n: existing.n, base: edge ?? dflt, bottom: edge === undefined }
  }
  const dead = mergedBranches(ctx.root, ctx.stack, { repo: ctx.repo, facade: ctx.rev })
  const tip = stackTip(ctx.root, ctx.stack, dead)
  return { n: tip.n, base: tip.base ?? dflt, edge: tip.base, bottom: tip.base === undefined }
}

/** slot + planItem for a bead — the dry-run render and the real
 *  worktree plan share the member-number/shape wiring. */
function stackPlan(
  ctx: Ctx,
  bead: ReadyBead
): { slot: StackSlot | undefined; item: ReturnType<typeof planItem> } {
  const slot = resolveStackSlot(ctx, bead)
  const item = planItem(
    bead,
    ctx.root,
    slot === undefined ? undefined : { stack: { name: ctx.stack!, n: slot.n } }
  )
  return { slot, item }
}

/** `P · model M` provenance label — the lane announce and the dry-run
 *  render print the same pair. */
const laneLabel = (ctx: Ctx): string =>
  `${ctx.lane.provider}` +
  (ctx.lane.model !== undefined ? ` · model ${ctx.lane.model}` : '')

/** Resolve the bead's stack slot and create its worktree under the same
 *  push lock `stack push` holds — without it a loop and a push racing
 *  one stack read the same tip and both mint position n. A live
 *  competing push can outlast one 20s wait, so transient contention is
 *  retried a few times before flunking the item (flunking parks the
 *  bead unreclaimed for the whole run). */
function planItemAndWorktree(
  ctx: Ctx,
  bead: ReadyBead
): { slot: StackSlot | undefined; item: ReturnType<typeof planItem> } {
  let slot: StackSlot | undefined
  let item!: ReturnType<typeof planItem>
  const planAndCreate = (): void => {
    const plan = stackPlan(ctx, bead)
    slot = plan.slot
    item = plan.item
    say(ctx, `\nloop: ${bead.id} → ${item.branch} @ ${item.worktreeDir}`)
    // a surviving worktree dir is reused as-is — its branch kept its
    // original base, so the stack edge only records on fresh creation
    const fresh = !existsSync(item.worktreeDir)
    ensureWorktree(ctx.root, item.branch, item.worktreeDir, slot?.base)
    if (fresh && slot?.edge !== undefined) {
      // same edge `work enter --stack` records — merge order travels
      recordStackEdge(item.branch, slot.edge)
    }
  }
  const lockPath = ctx.stack === undefined ? null : stackPushLockPath(ctx.stack)
  if (ctx.stack !== undefined && lockPath === null) {
    say(ctx, 'loop: could not resolve the git common dir — running without the stack lock')
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (lockPath === null) {
        planAndCreate()
      } else {
        withFileLock(lockPath, planAndCreate, { label: `stack ${ctx.stack} push lock` })
      }
      break
    } catch (err) {
      if (!(err instanceof LockTimeout) || attempt >= 2) {
        throw err
      }
    }
  }
  return { slot, item }
}

/** One bead end-to-end. */
async function runItem(ctx: Ctx, bead: ReadyBead): Promise<ItemResult> {
  // resolved here, not earlier — a member that landed since the last
  // item correctly yields the default branch as the next base.
  let slot: StackSlot | undefined
  let item!: ReturnType<typeof planItem>
  try {
    const planned = planItemAndWorktree(ctx, bead)
    slot = planned.slot
    item = planned.item
  } catch (err) {
    noteBead(ctx.tasks, bead.id, `loop: worktree failed — ${err instanceof Error ? err.message : String(err)}`)
    reopenBead(ctx.tasks, bead.id)
    return 'failed'
  }
  if (!runBootstrap(ctx, bead, item)) {
    return 'failed'
  }
  writePrompt(item, buildWorkPrompt(bead, item.branch, slot?.base, slot?.bottom, ctx.backend))
  const code = await spawnAgent(ctx, bead.id, bead.title, item.promptFile, item.worktreeDir)
  const pr = findPr(ctx, item.branch)
  if (pr === 'lookup-error') {
    noteBead(ctx.tasks, bead.id, `loop: PR lookup failed for ${item.branch} — worktree ${item.worktreeDir}`)
    return 'parked'
  }
  if (pr === null) {
    return agentVerdict(ctx, bead, item.worktreeDir) ?? failNoPr(ctx, bead, item, code)
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
): Promise<ItemResult> {
  const act = loadBroConfig(ctx.root).act
  const fetch = async () => {
    const state = await fetchPrActState(
      ctx.rev,
      { repo: ctx.repo, pr },
      {
        ignoreChecks: act.ignoreChecks,
        checkHistory: checkHistory(ctx.root),
        maxRounds: act.maxRounds,
        docsPaths: act.docsPaths,
        docsMaxRounds: act.docsMaxRounds,
      }
    )
    return { state, gate: evaluateExitGate(state) }
  }
  for (let round = 0; ; round++) {
    let res
    try {
      res = await waitForGate(fetch, {
        intervalMs: ctx.intervalS * 1000,
        timeoutMs: ctx.cfg.mergeTimeoutMin * 60_000,
        // the loop IS the watcher — drop the same marker `act wait` does
        // (bro-z0k2u): a reboot-killed loop leaves a dead marker `bro act
        // rearm` resurrects as `act wait --merge --cleanup` rooted in the
        // item's worktree, instead of the PR sitting silently unwatched
        watch: {
          dir: ctx.root,
          pr,
          link: prRef(ctx, pr),
          merge: true,
          cleanup: true,
          workdir: item.worktreeDir,
          timeoutMin: ctx.cfg.mergeTimeoutMin,
        },
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
        ctx.tasks,
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
      noteBead(ctx.tasks, bead.id, `loop: PR ${prRef(ctx, pr)} was closed unmerged — worktree ${item.worktreeDir}`)
      return 'parked'
    }
    if (res.gate.ok) {
      return finalizeMerge(ctx, bead, item, pr)
    }
    // the gate's effective cap (docs-tightened on docs-only PRs) is the
    // respawn limit's peer — once it mandates debt-defer, another inline
    // fix round is exactly what the cap exists to prevent
    const capHit =
      res.state.maxRounds > 0 && res.state.fixRounds > res.state.maxRounds
    if (res.state.openThreads > 0 && !capHit && round < ctx.cfg.fixRounds) {
      await runFixRound(ctx, bead, item, pr, round + 1)
      continue
    }
    const why = res.timedOut
      ? `gate still pending after ${ctx.cfg.mergeTimeoutMin}m`
      : `blocked: ${res.gate.blockers.join('; ')}`
    noteBead(ctx.tasks, bead.id, `loop: PR ${prRef(ctx, pr)} ${why} — worktree ${item.worktreeDir}`)
    return 'parked'
  }
}

/** `--label a,b` → selection filters — flag() covers both spellings; a
 *  declared-but-empty value fails closed (silently widening to the
 *  whole queue is exactly what --label prevents). */
function labelSelection(argv: string[]): { labels?: string[] } {
  const raw = flag(argv, '--label')
  if (raw === undefined) {
    return {}
  }
  const labels = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (labels.length === 0) {
    console.error('error: --label requires a comma-separated value, e.g. --label debt,ui')
    process.exit(2)
  }
  return { labels }
}

/** `--stack NAME` — must form a git-ref-safe component or the member
 *  branches it plans would fail on creation mid-run. */
function stackNameFlag(argv: string[]): string | undefined {
  const name = flag(argv, '--stack')
  if (name !== undefined && !isStackName(name)) {
    console.error(`bro loop: invalid stack name "${name}" ([a-z0-9_.-])`)
    process.exit(2)
  }
  return name
}

const LOOP_VALUE_FLAGS = new Set([
  '--agent',
  '--agent-timeout',
  '--merge-timeout',
  '--max',
  '--interval',
  '--label',
  '--stack',
  '--provider',
  '--profile',
  '--model',
])
const LOOP_BOOL_FLAGS = new Set(['--json', '--dry-run', '--help', '--auto-approve'])

export async function runLoopCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  rejectStrayArgs(argv)
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim()
  if (!root) {
    console.error('bro loop: not inside a git worktree')
    process.exit(1)
  }
  const broCfg = loadBroConfig(root)
  const backend = ensureTasksBackend(root, broCfg.connectors)
  const cfg = broCfg.loop as LoopConfig
  const { lane, agent } = await resolveRunLane(root, argv, broCfg, cfg)
  const ctx = buildCtx(root, argv, broCfg, cfg, agent, lane, backend)
  if (argv.includes('--dry-run')) {
    dryRunPlan(ctx)
    return
  }
  await runQueue(ctx)
}

/** Strict flag parse — an unquoted `--agent devin -p --prompt-file
 *  {promptFile}` reads as agent='devin' plus a tail of unknown flags,
 *  silently spawning a bare `devin <file>` TUI per bead instead of a
 *  headless worker. */
function rejectStrayArgs(argv: string[]): void {
  const stray = positionals(argv, LOOP_VALUE_FLAGS, {
    boolFlags: LOOP_BOOL_FLAGS,
    strict: true,
  })
  if (stray.length > 0) {
    console.error(
      `bro loop: unexpected argument '${stray[0]}' — quote the agent template ` +
        "as one arg: --agent 'devin -p --prompt-file {promptFile}'"
    )
    process.exit(2)
  }
}

/** The lane resolves once, up front — a bad provider name is a config
 *  error that must fail BEFORE a bead is claimed, not mid-run with
 *  claims held. Returns the lane plus the effective template (a cli
 *  provider's `command` substitutes for `loop.agent`; a template
 *  --agent stays the literal value — provider names are never
 *  templates, resolveLoopLane consumed them). */
async function resolveRunLane(
  root: string,
  argv: string[],
  broCfg: ReturnType<typeof loadBroConfig>,
  cfg: LoopConfig
): Promise<{ lane: LoopLane; agent: string }> {
  const agentFlag = flag(argv, '--agent')
  let lane: LoopLane
  try {
    lane = await resolveLoopLane(
      loadAgentEnv(root),
      {
        agent: agentFlag,
        provider: flag(argv, '--provider'),
        profile: flag(argv, '--profile'),
        model: flag(argv, '--model'),
        autoApprove: argv.includes('--auto-approve') ? true : undefined,
      },
      cfg
    )
  } catch (err) {
    if (err instanceof SpawnError) {
      console.error(`bro loop: ${err.message}`)
      process.exit(2)
    }
    throw err
  }
  const agent =
    lane.worker?.kind === 'template'
      ? lane.worker.command
      : agentFlag !== undefined && !Object.hasOwn(broCfg.providers ?? {}, agentFlag)
        ? agentFlag
        : cfg.agent
  if (lane.worker === undefined && agent === '') {
    console.error(
      'bro loop: no agent configured — set loop.agent or loop.provider in bro.config ' +
        '(e.g. "devin --prompt-file {promptFile} -p") or pass --agent/--provider'
    )
    process.exit(2)
  }
  // {promptFile} isn't strictly required — an agent may read
  // BRO_PROMPT_FILE from env instead — but a TUI-capable CLI spawned
  // without it opens an interactive session per bead (the file path
  // lands positionally = the prompt). Warn loudly, don't refuse. An
  // argv worker takes the file as a positional arg by contract — the
  // check would only misfire on it.
  if (lane.worker?.kind !== 'argv' && !agent.includes('{promptFile}')) {
    // binary name only — the template may carry inline credentials
    const agentBin = agent.split(/\s+/, 1)[0]
    console.error(
      `bro loop: agent template has no {promptFile} — "${agentBin}". ` +
        'The prompt file appends as a positional arg; interactive CLIs ' +
        '(devin, claude) treat that as a TUI session, not a worker prompt. ' +
        'Intended for env-reading agents (BRO_PROMPT_FILE) only.'
    )
  }
  return { lane, agent }
}

function buildCtx(
  root: string,
  argv: string[],
  broCfg: ReturnType<typeof loadBroConfig>,
  cfg: LoopConfig,
  agent: string,
  lane: LoopLane,
  backend: string
): Ctx {
  const rev = reviewHost(root, broCfg.connectors)
  const ctx: Ctx = {
    rev,
    tasks: facade('tasks', { dir: root }, { prefer: broCfg.connectors }),
    backend,
    repo: rev.resolveRepo([]),
    root,
    cfg: {
      ...cfg,
      agentTimeoutMin: num(flag(argv, '--agent-timeout'), cfg.agentTimeoutMin),
      mergeTimeoutMin: num(flag(argv, '--merge-timeout'), cfg.mergeTimeoutMin),
      maxItems: num(flag(argv, '--max'), cfg.maxItems, 0),
    },
    agent,
    lane,
    intervalS: num(flag(argv, '--interval'), 60),
    json: argv.includes('--json'),
    selection: {
      filters: labelSelection(argv),
      gates: 'forbid' as const,
      order: 'priority' as const,
    },
    // BEADS_DIR pinning is a beads tail — a non-beads store has no bd
    // to pin and no db that could fork inside the worktree
    beadsDir: backend === 'beads' ? resolveBeadsDir(root, (m) => console.error(m)) : undefined,
    stack: stackNameFlag(argv),
    tails: [],
  }
  // announce the resolved lane once — agents.native.provider picking up
  // the run must not be a silent behavior change for template users
  if (ctx.lane.provider !== undefined) {
    say(
      ctx,
      `loop: provider ${laneLabel(ctx)}` +
        (ctx.lane.worker?.kind === 'argv' ? ' (acp worker)' : '')
    )
  }
  return ctx
}

function dryRunPlan(ctx: Ctx): void {
  const scope = loopScope()
  if (!scope) {
    return
  }
  const ready = readyBeads(ctx.root)
  const top = classify(ready, ctx.selection, scope, epicParentIds(ready, ctx.root)).queue[0]
  if (!top) {
    console.log('loop --dry-run: nothing claimable')
    return
  }
  const { slot, item } = stackPlan(ctx, top)
  console.log(`would claim ${top.id} — ${top.title}`)
  console.log(`  worktree ${item.worktreeDir} on ${item.branch}`)
  if (slot !== undefined) {
    console.log(`  stack ${ctx.stack} member ${slot.n} — PR base ${slot.base}`)
  }
  const w = ctx.lane.worker
  if (ctx.lane.provider !== undefined) {
    console.log(`  provider: ${laneLabel(ctx)}`)
  }
  console.log(
    `  agent: ${
      w?.kind === 'argv'
        ? [...w.argv, item.promptFile].map(shRender).join(' ')
        : expandAgentCmd(ctx.agent, item.promptFile)
    }`
  )
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
  /** branch names riding a loop/* worktree — disjoint from `branches`,
   *  needed so the open-PR audit sees PRs on worktree'd branches too */
  worktreeBranches: string[]
  branches: string[]
  errors: string[]
}

/** loop/* worktrees still checked out + loop/* branches with no
 *  worktree — both are run tails; a `--stack` run owns its `stack/<name>/*`
 *  branches the same way. A failed git probe reports as an error line,
 *  never as a false "clean". */
export function loopRefTails(root: string, prefixes: string[] = ['loop/']): RefTails {
  const errors: string[] = []
  const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain'])
  if (wt.code !== 0) {
    errors.push(`worktree list failed — ${wt.err || 'git error'}`)
  }
  const trees = parseWorktreePorcelain(wt.out).filter((w) =>
    prefixes.some((p) => w.branch?.startsWith(p))
  )
  const onTree = new Set(trees.map((w) => w.branch!))
  const bare: string[] = []
  for (const prefix of prefixes) {
    const bl = gitTry(['-C', root, 'branch', '--list', `${prefix}*`, '--format=%(refname:short)'])
    if (bl.code !== 0) {
      errors.push(`branch list failed — ${bl.err || 'git error'}`)
      continue
    }
    bare.push(...bl.out.split('\n').filter((b) => b && !onTree.has(b)))
  }
  return {
    worktrees: trees.map((w) => `${w.path} [${w.branch}]`),
    worktreeBranches: trees.map((w) => w.branch!),
    branches: bare,
    errors,
  }
}

/** Beads left in_progress, split by this run's claims vs pre-existing —
 *  a shared store holds other sessions' claims too. */
function claimedTails(tasks: TaskStore, seen: Set<string>): { own: string[]; other: string[] } {
  try {
    const rows = tasks.list({ status: 'in_progress' })
    const fmt = (r: { id: string; title?: string }) =>
      `${r.id} ${(r.title ?? '').replace(/\s+/g, ' ').slice(0, 60)}`.trim()
    return {
      own: rows.filter((r) => seen.has(r.id)).map(fmt),
      other: rows.filter((r) => !seen.has(r.id)).map(fmt),
    }
  } catch {
    return { own: [], other: ['warning: claimed-task audit failed — store unavailable'] }
  }
}

/** The close-out litter sweep — reap the provably-done leftovers before
 *  the audit names what survived. A sweep failure is a warning line,
 *  never a crash. */
function sweepLoopLitter(ctx: Ctx): LitterReap | undefined {
  try {
    return reapLoopLitter({
      root: ctx.root,
      tasks: ctx.tasks,
      rev: { repo: ctx.repo, facade: ctx.rev },
      stackPrefix: ctx.stack === undefined ? undefined : `stack/${ctx.stack}/`,
    })
  } catch (err) {
    say(ctx, `  warning: litter sweep failed — ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/** The audit's printed report: what the sweep reaped, then every tail
 *  that survived it — 'clean' only when no section has anything left. */
function sayLoopAudit(ctx: Ctx, reap: LitterReap | undefined, sections: [string, string[]][]): void {
  say(ctx, 'loop audit:')
  for (const r of reap?.reaped ?? []) {
    say(ctx, `  reaped: ${r}`)
  }
  for (const b of reap?.branches ?? []) {
    say(ctx, `  deleted branch: ${b}`)
  }
  for (const e of reap?.errors ?? []) {
    say(ctx, `  reap error: ${e}`)
  }
  if (sections.every(([, items]) => items.length === 0)) {
    say(ctx, '  clean — no loop tails')
    return
  }
  for (const [label, items] of sections) {
    for (const item of items) {
      say(ctx, `  ${label}: ${item}`)
    }
  }
}

/** End-of-run sweep: first reap the provably-done litter (closed-bead or
 *  merged-PR worktrees that are still clean, plus their bare branches —
 *  `bro work prune --loop` runs the same sweep by hand), then name every
 *  tail that survived in the run summary — open loop PRs, kept
 *  worktrees/branches, claimed beads, and cleanup failures collected
 *  during the run. Finished with `bro sync` so artifacts and bead state
 *  travel. Never throws — an audit failure is reported, not raised. */
function endAudit(ctx: Ctx, seen: Set<string>): void {
  // the sweep's git helpers and runSyncCommand narrate via console.log —
  // under --json that corrupts the event stream, so route the whole
  // audit's helper output to stderr (say() already routes its own lines)
  const log = console.log
  if (ctx.json) {
    console.log = console.error
  }
  try {
    // reap before the report — a landed bead's leftover tree is not a
    // tail; the audit describes what survived the sweep
    const reap = sweepLoopLitter(ctx)
    const { worktrees, worktreeBranches, branches, errors } = loopRefTails(
      ctx.root,
      ctx.stack === undefined ? ['loop/'] : ['loop/', `stack/${ctx.stack}/`]
    )
    const claimed = claimedTails(ctx.tasks, seen)
    sayLoopAudit(ctx, reap, [
      // PRs live on branches — worktree'd ones (a parked bead keeps both)
      // are just as much a tail as the bare branches
      ['open PRs', openLoopPrs(ctx, [...branches, ...worktreeBranches])],
      ['worktrees', worktrees],
      ['branches', branches],
      ['claimed beads', claimed.own],
      ['in_progress elsewhere', claimed.other],
      ['audit errors', errors],
      ['cleanup errors', ctx.tails],
    ])
    try {
      runSyncCommand([])
    } catch (err) {
      say(ctx, `  warning: bro sync failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  } catch (err) {
    say(ctx, `  warning: audit failed — ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    console.log = log
  }
}

/** Claim the next ready bead — undefined when the queue drains. A
 *  foreign-only remainder must not look like a drained queue: 'done'
 *  would hide work a shared db still advertises. */
function claimNext(
  ctx: Ctx,
  scope: NonNullable<ReturnType<typeof nextScope>>,
  seen: Set<string>
): ReadyBead | undefined {
  const ready = readyBeads(ctx.root)
  const c = classify(ready, ctx.selection, scope, epicParentIds(ready, ctx.root))
  const bead = claimUpTo(c.queue.filter((b) => !seen.has(b.id)), 1, ctx.root)[0]
  if (!bead && c.foreign > 0) {
    say(ctx, `loop: ${c.foreign} foreign-scope bead(s) remain — not claimable in this project`)
  }
  return bead
}

/** Post-merge cascade after a landed stack member — retarget + rebase
 *  whatever stacked on top of it before the next item runs. */
function syncAfterLand(ctx: Ctx): void {
  if (ctx.stack === undefined) {
    return
  }
  try {
    for (const line of syncStack(ctx.root, ctx.stack)) {
      say(ctx, `loop stack sync:${line}`)
    }
  } catch (err) {
    say(ctx, `loop: stack sync failed — ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The claim→run→repeat cycle until the queue drains or --max hits. */
async function runQueue(ctx: Ctx): Promise<void> {
  const seen = new Set<string>()
  const tally = { landed: 0, closed: 0, parked: 0, failed: 0 }
  try {
    // inside the try: a failed scope lookup still owes the run an audit
    const scope = loopScope()
    if (!scope) {
      return
    }
    for (;;) {
      const done = tally.landed + tally.closed + tally.parked + tally.failed
      if (ctx.cfg.maxItems > 0 && done >= ctx.cfg.maxItems) {
        break
      }
      const bead = claimNext(ctx, scope, seen)
      if (!bead) {
        break
      }
      seen.add(bead.id)
      const result = await runItem(ctx, bead)
      tally[result] += 1
      if (result === 'landed') {
        syncAfterLand(ctx)
      }
      if (ctx.json) {
        console.log(JSON.stringify({ bead: bead.id, result }))
      }
    }
    if (ctx.json) {
      console.log(JSON.stringify({ done: true, ...tally }))
    } else {
      console.log(
        `loop: done — ${tally.landed} landed, ${tally.closed} closed, ${tally.parked} parked, ${tally.failed} failed`
      )
    }
  } finally {
    // idle, gated, or error — the audit always runs; a tail the loop
    // left must surface in the summary, not be discovered later
    endAudit(ctx, seen)
  }
}
