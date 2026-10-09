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
 * note — unless the spawn died inside loop.crashExitMs (default 10s):
 * gone that fast it crashed on the environment, not the bead, and
 * reopening is a respawn-burn, so it parks loud instead (bro-sovl3). A
 * bead whose PR stalls keeps its worktree for inspection.
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  bdTry,
  CLASS_LABEL_PREFIX,
  commandCliName,
  ensureTasksBackend,
  facade,
  gitTry,
  LockTimeout,
  reviewHost,
  routeStepClass,
  SpawnError,
  stepClassInfo,
  stepParent,
  withFileLock,
  type ResolvedClass,
  type ReviewFacade,
  type SpawnWorker,
  type TaskStore,
} from '@broject/core'
import {
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  gatePending,
  watchBegin,
  watchEnd,
} from '@broject/act'
import {
  buildFixPrompt,
  buildRebasePrompt,
  buildWorkPrompt,
  expandAgentCmd,
  memberAction,
  planItem,
  type GateSnapshot,
  type LoopConfig,
  type LoopItem,
} from '@broject/loop'
import { loadBroConfig } from '../plugins.ts'
import {
  applyFleetRouter,
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
  /** The act gate's own section — service passes share the one read. */
  act: ReturnType<typeof loadBroConfig>['act']
  /** The base template — `loop.agent`/`--agent`. The command a spawn
   *  actually expands is per-lane: a cli provider's `command`
   *  substitutes for it (`laneCommand`). For an acp (argv) worker the
   *  template is inert — the spawn never expands it. */
  agent: string
  /** The resolved spawn lane when routing is off (or the flag-tier pin
   *  when it's on) — `resolveBeadLane` re-resolves per bead. */
  lane: LoopLane
  /** The spawn env config — `fleet.routing`/`providers` for per-bead
   *  class resolution (spec bro-1x7p). */
  env: AgentConnectorEnv
  /** The invocation's lane picks — per-bead resolution merges them
   *  above the routed chain exactly like `bro agents up`. */
  sel: LoopLaneSel
  /** `fleet.routing` declared AND not bypassed by a template --agent —
   *  each claimed bead resolves `class:` label → `default` → chain
   *  head provider. Flag picks (`--provider`/`--profile`/`--agent
   *  <name>`) still outrank the table piecewise. */
  routing: boolean
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
  --class NAME                   pin every claimed bead to one
                                fleet.routing class (default: the bead's
                                class:<name> label, else 'default')
  --model M                      model override for the provider lane
  --auto-approve                 acp permission policy: allow, not deny
  --agent-timeout MIN            per-spawn kill budget, 0 = never (loop.agentTimeoutMin, 0)
  --merge-timeout MIN            gate budget per round (loop.mergeTimeoutMin, 45)
  --label a,b                    declared scope — only beads carrying one
                                of these labels are claimable
  --stack NAME                   chain claimed beads onto stack NAME —
                                each PR targets the member below
  --max-open N                   cap the gate stack's open PRs (loop.maxOpen, 3)
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
    'BRO_AGENT_CLASS',
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

/** The command the template arm expands for a lane — a cli provider's
 *  `command` substitutes for the configured template; argv workers never
 *  reach it. */
const laneCommand = (ctx: Ctx, lane: LoopLane): string =>
  lane.worker?.kind === 'template' ? lane.worker.command : ctx.agent

/** Commit-provenance pins for the loop's agent (bro-fzot) — the cli the
 *  effective command names (the acp worker's `cliName` on the argv lane),
 *  the provider/model lane labels, and the bead's molecule parent when
 *  the shared store can answer. */
function provenancePins(ctx: Ctx, beadId: string, lane: LoopLane): Record<string, string> {
  const w = lane.worker
  const pins: Record<string, string> = {
    BRO_AGENT:
      w?.kind === 'argv' ? (w.cliName ?? 'agent') : commandCliName(laneCommand(ctx, lane)),
  }
  if (lane.provider !== undefined) {
    pins.BRO_AGENT_PROVIDER = lane.provider
  }
  if (lane.model !== undefined) {
    pins.BRO_AGENT_MODEL = lane.model
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
  /** The routing lane the spawn resolved to (fleet.routing class — spec
   *  bro-1x7p). Provenance like provider/model; absent on unrouted
   *  spawns (no fleet.routing declared). */
  class?: string
}

/** Per-run lane picks — undefined means "not given" so config fields
 *  still apply piecewise, mirroring the facade's merge order. `class`
 *  is the `--class` pin — the fleet.routing lane every claimed bead
 *  takes (spec bro-1x7p's explicit-request tier). */
export interface LoopLaneSel {
  agent?: string
  provider?: string
  profile?: string
  model?: string
  autoApprove?: boolean
  class?: string
}

/** Resolve which lane `bro loop` spawns through. A `--agent` value that
 *  exactly names a configured `providers.<name>` IS a provider pick;
 *  any other value is the escape-hatch template and wins the whole lane
 *  (provider flags beside it are contradictory — SpawnError). The order
 *  is the facade's own — explicit flag pick → flag-named
 *  fleet.profiles preset → the routed chain head (spec bro-1x7p: a
 *  declared `fleet.routing` resolves the bead's class per spawn and its
 *  chain head supplies the provider) → config picks (`loop.profile`,
 *  `loop.provider`) → `agents.native.provider` → legacy template. A bad
 *  name throws SpawnError — the caller exits before a bead is claimed. */
export async function resolveLoopLane(
  env: AgentConnectorEnv,
  sel: LoopLaneSel,
  cfg: LoopConfig,
  route?: ResolvedClass
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
    return templateEscape(sel, cfg, env)
  }
  const profileName = sel.profile ?? (cfg.profile !== '' ? cfg.profile : undefined)
  const profile = profileName !== undefined ? fleetProfileOf(env, profileName) : undefined
  // a flag-named profile is an explicit pick — it outranks the table;
  // a config-named one is a standing default and sits below it (the
  // same tiers `spawnStepAgent` puts req.profile vs route.provider in)
  const flagProfile = sel.profile !== undefined ? profile : undefined
  const cfgProfile = sel.profile === undefined ? profile : undefined
  const provider =
    sel.provider ??
    (agentIsProvider ? sel.agent : undefined) ??
    flagProfile?.provider ??
    route?.provider ??
    cfgProfile?.provider ??
    (cfg.provider !== '' ? cfg.provider : undefined)
  const model =
    sel.model ??
    flagProfile?.model ??
    // the chain head's model pin pairs with ITS provider only — an
    // override provider never inherits chain[0]'s model
    (provider !== undefined && provider === route?.provider ? route.model : undefined) ??
    cfgProfile?.model ??
    (cfg.model !== '' ? cfg.model : undefined)
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
  const lane = providerLaneOrEmpty(pick, model, autoApprove)
  return route === undefined ? lane : { ...lane, class: route.class }
}

/** The escape hatch — a template --agent replaces the provider lane for
 *  this run, config picks and fleet.routing included; provider/routing
 *  flags beside it are contradictory input. */
function templateEscape(sel: LoopLaneSel, cfg: LoopConfig, env: AgentConnectorEnv): LoopLane {
  const extras = [
    sel.provider !== undefined ? '--provider' : undefined,
    sel.profile !== undefined ? '--profile' : undefined,
    sel.model !== undefined ? '--model' : undefined,
    sel.class !== undefined ? '--class' : undefined,
    sel.autoApprove === true ? '--auto-approve' : undefined,
  ].filter((f): f is string => f !== undefined)
  if (extras.length > 0) {
    throw new SpawnError(
      `${extras.join(', ')} pick a provider lane, but --agent '${sel.agent}' is a ` +
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
  if (env.fleet?.routing !== undefined && Object.keys(env.fleet.routing).length > 0) {
    console.error('loop: --agent template bypasses fleet.routing — every bead runs the template')
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

// --- per-bead class routing (spec bro-1x7p / bead bro-zmned) ---------------------

/** The bead's `class:` label — the lane pin `resolveStepClass` reads.
 *  ReadyBead.labels come from the claim read (`bd ready --json` rows
 *  carry them); the parse matches stepClassInfo's exactly. */
function classLabelOf(bead: ReadyBead): string | undefined {
  const hit = bead.labels?.find((l) => l.startsWith(CLASS_LABEL_PREFIX))
  const name = hit === undefined ? undefined : hit.slice(CLASS_LABEL_PREFIX.length).trim()
  return name === '' ? undefined : name
}

/** The routing inputs one bead carries — `class:` label, priority
 *  (the onWall default), and title/description for the judge router.
 *  The ready row already answers; a beads store pays one extra
 *  `bd show` only when the router could fire on an unclassed bead and
 *  needs the description the list row doesn't carry. */
function beadClassInfo(
  ctx: Ctx,
  bead: ReadyBead
): { label?: string; priority?: number; title?: string; description?: string } {
  const info = {
    label: classLabelOf(bead),
    priority: bead.priority,
    title: bead.title,
    description: bead.description,
  }
  const router = ctx.env.fleet?.router
  const routerMayFire =
    router !== undefined &&
    router.mode !== 'off' &&
    ctx.sel.class === undefined &&
    info.label === undefined &&
    ctx.beadsDir !== undefined
  return routerMayFire ? { ...info, ...stepClassInfo(ctx.beadsDir!, bead.id) } : info
}

/** One claimed bead's spawn lane — fleet.routing resolves its class
 *  (`--class` flag → `class:` label → `default`) and the chain head
 *  supplies the provider, exactly like `bro agents up`'s spawn path
 *  (routeStepClass → applyFleetRouter → resolveSpawnProvider). The
 *  flag-tier picks still outrank the table piecewise; `ctx.lane` is the
 *  run's fixed lane when routing is off or bypassed. Throws SpawnError —
 *  a bad `class:` label or broken chain is a config error the caller
 *  settles as a failed item, never a silent template drop. */
async function resolveBeadLane(ctx: Ctx, bead: ReadyBead): Promise<LoopLane> {
  if (!ctx.routing) {
    return ctx.lane
  }
  const info = beadClassInfo(ctx, bead)
  const routed = routeStepClass(
    ctx.env.fleet,
    ctx.env.providers ?? {},
    ctx.beadsDir,
    bead.id,
    ctx.sel.class,
    info
  )
  const route = await applyFleetRouter(ctx.root, ctx.env, bead.id, info, routed)
  return resolveLoopLane(ctx.env, ctx.sel, ctx.cfg, route)
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
 *  stays parseable. `lane` is the bead's resolved spawn lane — with
 *  fleet.routing declared it can differ bead to bead (spec bro-1x7p). */
function spawnAgent(ctx: Ctx, lane: LoopLane, beadId: string, title: string, promptFile: string, dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    const env = agentEnv(ctx, {
      BRO_BEAD_ID: beadId,
      BRO_BEAD_TITLE: title,
      BRO_PROMPT_FILE: promptFile,
      ...provenancePins(ctx, beadId, lane),
      ...(lane.class === undefined ? {} : { BRO_AGENT_CLASS: lane.class }),
    })
    const opts = {
      cwd: dir,
      env,
      stdio: ['inherit', ctx.json ? 2 : 'inherit', 'inherit'] as Array<'inherit' | number>,
      detached: true,
    }
    const w = lane.worker
    const child =
      w?.kind === 'argv'
        ? // the same `"$@"` positional exec the native backend builds —
          // argv workers are headless by construction (acp); sh resolves
          // argv[0] ('bro'/'npx') on PATH the way the backend does
          spawn('sh', ['-c', 'exec "$@"', 'loop-agent', ...w.argv, promptFile], opts) // NOSONAR — argv[0] resolves on PATH by design, same as the backend's spawn
        : spawn('sh', ['-c', expandAgentCmd(laneCommand(ctx, lane), promptFile)], opts) // NOSONAR — operator-configured agent command
    let timedOut = false
    const kill = () => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL') // detached → own group
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer =
      ctx.cfg.agentTimeoutMin > 0
        ? // Node clamps delays above 2^31-1ms to 1ms — cap so large budgets keep working.
          setTimeout(kill, Math.min(ctx.cfg.agentTimeoutMin * 60_000, 2_147_483_647))
        : undefined
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
  item: LoopItem,
  pr: number,
  alreadyMerged = false
): Promise<'landed' | 'parked'> {
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
  item: LoopItem,
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
  const lane = await resolveBeadLane(ctx, bead)
  const code = await spawnAgent(ctx, lane, bead.id, bead.title, item.promptFile, item.worktreeDir)
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
  item: LoopItem,
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
function runBootstrap(ctx: Ctx, bead: ReadyBead, item: LoopItem): boolean {
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
function writePrompt(item: LoopItem, text: string): void {
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
): { slot: StackSlot | undefined; item: LoopItem } {
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
const laneLabel = (lane: LoopLane): string =>
  `${lane.provider}` + (lane.model !== undefined ? ` · model ${lane.model}` : '')

/** Resolve the bead's stack slot and create its worktree under the same
 *  push lock `stack push` holds — without it a loop and a push racing
 *  one stack read the same tip and both mint position n. A live
 *  competing push can outlast one 20s wait, so transient contention is
 *  retried a few times before flunking the item (flunking parks the
 *  bead unreclaimed for the whole run). */
function planItemAndWorktree(
  ctx: Ctx,
  bead: ReadyBead
): { slot: StackSlot | undefined; item: LoopItem } {
  let slot: StackSlot | undefined
  let item!: LoopItem
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

// --- the gate stack: task-stack round-robin (spec bro-zsmwq) -----------------

/** A PR on the run's gate stack — bead + worktree + the per-member
 *  clock and its armed watch marker. Entry order is service priority:
 *  the oldest member gets serviced first. */
interface GateMember {
  bead: ReadyBead
  item: LoopItem
  pr: number
  /** watchBegin marker path — armed for the member's whole stack
   *  tenure: a dead loop leaves a dead marker `act rearm` resurrects
   *  as `act wait --merge --cleanup` in the member's worktree. */
  marker: string | null
  /** Gate (re-)entry ms — a fix/rebase round resets the budget. */
  since: number
  /** Agent respawns consumed — fix and rebase rounds share the
   *  loop.fixRounds bound. */
  rounds: number
  /** headSha an update-branch push last moved — the landing check. */
  updatedSha?: string
  /** Consecutive fetch failures — parks at the old wait's 3. */
  fetchErrors: number
}

/** The push half of the alternation: claim → worktree → agent → PR.
 *  The PR found joins the gate stack as the newest member; every
 *  no-PR outcome settles inline exactly as the serial loop did. */
type PushOutcome =
  | { kind: 'member'; member: GateMember }
  | { kind: 'done'; result: ItemResult }

async function pushItem(ctx: Ctx, bead: ReadyBead): Promise<PushOutcome> {
  // the bead's spawn lane resolves before any worktree exists — a
  // fleet.routing config error (an unknown `class:` label, a broken
  // chain) is deterministic: reopening would re-claim into the same
  // wall, so the bead parks claimed+noted like a spawn-environment
  // crash (bro-sovl3), and no worktree litter is created for it
  let lane: LoopLane
  try {
    lane = await resolveBeadLane(ctx, bead)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    noteBead(ctx.tasks, bead.id, `loop: route resolution failed — ${msg} — parked`)
    say(ctx, `loop: ${bead.id} route failed — ${msg} — parked`)
    return { kind: 'done', result: 'parked' }
  }
  // resolved here, not earlier — a member that landed since the last
  // push correctly yields the default branch as the next base.
  let slot: StackSlot | undefined
  let item!: LoopItem
  try {
    const planned = planItemAndWorktree(ctx, bead)
    slot = planned.slot
    item = planned.item
  } catch (err) {
    noteBead(ctx.tasks, bead.id, `loop: worktree failed — ${err instanceof Error ? err.message : String(err)}`)
    reopenBead(ctx.tasks, bead.id)
    return { kind: 'done', result: 'failed' }
  }
  if (!runBootstrap(ctx, bead, item)) {
    return { kind: 'done', result: 'failed' }
  }
  writePrompt(item, buildWorkPrompt(bead, item.branch, slot?.base, slot?.bottom, ctx.backend))
  const spawnAt = Date.now()
  const code = await spawnAgent(ctx, lane, bead.id, bead.title, item.promptFile, item.worktreeDir)
  // agent wall-time — measured before findPr's gh call; a slow lookup
  // must not inflate an instant crash past the crashExitMs threshold
  const elapsed = Date.now() - spawnAt
  const pr = findPr(ctx, item.branch)
  if (pr === 'lookup-error') {
    noteBead(ctx.tasks, bead.id, `loop: PR lookup failed for ${item.branch} — worktree ${item.worktreeDir}`)
    return { kind: 'done', result: 'parked' }
  }
  if (pr === null) {
    const verdict = agentVerdict(ctx, bead, item.worktreeDir)
    if (verdict !== undefined) {
      return { kind: 'done', result: verdict }
    }
    if (ctx.cfg.crashExitMs > 0 && elapsed < ctx.cfg.crashExitMs) {
      // gone in seconds, no PR, no verdict — the spawn died on the
      // environment (broken dist, bad argv), never on the bead. Reopen
      // and the next claim walks into the same wall: claim → crash →
      // reopen → reclaim is the respawn-burn from bro-sovl3. Park loud.
      noteBead(
        ctx.tasks,
        bead.id,
        `loop: agent gone in ${elapsed}ms (exit ${code ?? 'spawn failure'}) — environment crash, not a verdict; parked — worktree kept at ${item.worktreeDir}`
      )
      say(
        ctx,
        `loop: ${bead.id} agent exited ${code ?? 'spawn failure'} in ${elapsed}ms — parked (crash, not work)`
      )
      return { kind: 'done', result: 'parked' }
    }
    return { kind: 'done', result: failNoPr(ctx, bead, item, code) }
  }
  // the loop IS the watcher — arm the same marker `act wait` drops
  // (bro-z0k2u) for the member's whole stack tenure, not per poll:
  // a reboot-killed loop leaves a dead marker `bro act rearm`
  // resurrects instead of the PR sitting silently unwatched. `bead`
  // rides the marker so the resurrected wait can run the finalizeMerge
  // half the dead loop never reached — merge lands, claim closes
  // (bro-q6ppv).
  const member: GateMember = {
    bead,
    item,
    pr,
    marker: watchBegin(ctx.root, {
      pr,
      link: prRef(ctx, pr),
      merge: true,
      cleanup: true,
      workdir: item.worktreeDir,
      bead: bead.id,
      timeoutMin: ctx.cfg.mergeTimeoutMin,
    }),
    since: Date.now(),
    rounds: 0,
    fetchErrors: 0,
  }
  return { kind: 'member', member }
}

/** One member's settled snapshot → the mapped action. 'kept' parks the
 *  member until the next interval tick (a quiet wait); 'active' keeps
 *  it too but asks the scheduler for an immediate re-poll — a fix/
 *  rebase/update just moved the gate, exactly like the old serial
 *  waitForGate re-entry did. 'landed'/'parked' remove it. */
async function serviceMember(
  ctx: Ctx,
  m: GateMember
): Promise<'kept' | 'active' | 'landed' | 'parked'> {
  let snap: GateSnapshot
  try {
    const state = await fetchPrActState(
      ctx.rev,
      { repo: ctx.repo, pr: m.pr },
      {
        ignoreChecks: ctx.act.ignoreChecks,
        checkHistory: checkHistory(ctx.root),
        maxRounds: ctx.act.maxRounds,
        docsPaths: ctx.act.docsPaths,
        docsMaxRounds: ctx.act.docsMaxRounds,
      }
    )
    const gate = evaluateExitGate(state)
    console.error(
      `loop ${prRef(ctx, m.pr)}: threads=${gate.open_threads} ci=${gate.ci_pending}+${gate.ci_failing}f rev=${gate.reviewers_pending} sast=${gate.sast_pending}`
    )
    snap = {
      state: state.state,
      headSha: state.headSha,
      mergeable: state.mergeable,
      mergeState: state.mergeState,
      openThreads: state.openThreads,
      fixRounds: state.fixRounds,
      maxRounds: state.maxRounds,
      ok: gate.ok,
      blockers: gate.blockers,
      pending: gatePending(state),
    }
    m.fetchErrors = 0
  } catch (err) {
    m.fetchErrors += 1
    console.error(`loop ${prRef(ctx, m.pr)}: fetch failed (${m.fetchErrors}) — ${String(err)}`)
    // the old wait gave up on 3 consecutive failures OR its deadline —
    // a member whose fetch plane is down past mergeTimeoutMin settles
    // the same way rather than keeping a slot forever
    if (m.fetchErrors < 3 && Date.now() - m.since < ctx.cfg.mergeTimeoutMin * 60_000) {
      return 'kept'
    }
    noteBead(
      ctx.tasks,
      m.bead.id,
      `loop: gate fetch kept failing for PR ${prRef(ctx, m.pr)} — ${String(err)} — worktree ${m.item.worktreeDir}`
    )
    return leave(m, 'parked')
  }
  const act = memberAction(snap, m, {
    fixRounds: ctx.cfg.fixRounds,
    timeoutMs: ctx.cfg.mergeTimeoutMin * 60_000,
    now: Date.now(),
  })
  switch (act.kind) {
    case 'land':
      // landed externally while the member sat — close out, no merge call
      return leave(m, await finalizeMerge(ctx, m.bead, m.item, m.pr, true))
    case 'merge':
      return leave(m, await finalizeMerge(ctx, m.bead, m.item, m.pr))
    case 'closed':
      noteBead(ctx.tasks, m.bead.id, `loop: PR ${prRef(ctx, m.pr)} was closed unmerged — worktree ${m.item.worktreeDir}`)
      return leave(m, 'parked')
    case 'fix':
      return respawnRound(ctx, m, () => runFixRound(ctx, m.bead, m.item, m.pr, m.rounds))
    case 'rebase':
      return respawnRound(ctx, m, () => runRebaseRound(ctx, m.bead, m.item, m.pr, m.rounds))
    case 'update': {
      let ok: boolean
      try {
        ok = ctx.rev.updateBranch({ repo: ctx.repo, pr: m.pr }, snap.headSha)
      } catch (err) {
        // a throw must not take the stack down — quiet keep; the
        // member's own deadline still bounds the retries
        console.error(`loop ${prRef(ctx, m.pr)}: update-branch threw — ${String(err)}`)
        return 'kept'
      }
      console.error(`loop ${prRef(ctx, m.pr)}: update-branch ${ok ? 'pushed a new head' : 'refused'}`)
      if (!ok) {
        // an update refusal IS the settle — same park the wait produced
        noteBead(ctx.tasks, m.bead.id, `loop: PR ${prRef(ctx, m.pr)} blocked: ${snap.blockers.join('; ')} — worktree ${m.item.worktreeDir}`)
        return leave(m, 'parked')
      }
      m.updatedSha = snap.headSha
      return 'active'
    }
    case 'wait':
      return 'kept'
    case 'park':
      noteBead(ctx.tasks, m.bead.id, `loop: PR ${prRef(ctx, m.pr)} ${act.why} — worktree ${m.item.worktreeDir}`)
      return leave(m, 'parked')
  }
}

/** A member leaving the stack ends its watch — the promise is kept. */
function leave(m: GateMember, verdict: 'landed' | 'parked'): 'landed' | 'parked' {
  watchEnd(m.marker)
  return verdict
}

/** One respawn round (fix or rebase): consumes budget, resets the
 *  member clock on success, and degrades to a quiet keep when the round
 *  itself fails — a reviewThreads/prMeta fetch dying on ONE member must
 *  not abort the run and orphan every other gate's claim. The clock
 *  only resets on a round that actually ran. */
async function respawnRound(
  ctx: Ctx,
  m: GateMember,
  run: () => Promise<void>
): Promise<'kept' | 'active'> {
  m.rounds += 1
  try {
    await run()
  } catch (err) {
    console.error(`loop ${prRef(ctx, m.pr)}: respawn round ${m.rounds} failed — ${String(err)}`)
    return 'kept'
  }
  m.since = Date.now()
  return 'active'
}

/** The conflict round — the member's PR is CONFLICTING; the agent
 *  rebases onto the PR's declared base and pushes. A base that can't
 *  be looked up skips the spawn (the round still consumed the budget —
 *  a blind rebase order would be worse). */
async function runRebaseRound(
  ctx: Ctx,
  bead: ReadyBead,
  item: LoopItem,
  pr: number,
  round: number
): Promise<void> {
  let base: string
  try {
    base = ctx.rev.prMeta({ repo: ctx.repo, pr }).baseRef
  } catch (err) {
    console.error(`loop ${prRef(ctx, pr)}: base lookup for the rebase round failed — ${String(err)}`)
    return
  }
  writePrompt(item, buildRebasePrompt(bead, pr, base))
  say(ctx, `loop: ${prRef(ctx, pr)} conflicts — rebase round ${round} onto ${base}`)
  const lane = await resolveBeadLane(ctx, bead)
  const code = await spawnAgent(ctx, lane, bead.id, bead.title, item.promptFile, item.worktreeDir)
  if (code !== 0) {
    console.error(`loop: rebase agent exited ${code ?? 'timeout'} — the next gate poll decides`)
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
  '--max-open',
  '--interval',
  '--label',
  '--stack',
  '--provider',
  '--profile',
  '--class',
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
  const run = await resolveRunLane(root, argv, cfg)
  const ctx = buildCtx(root, argv, broCfg, cfg, run, backend)
  if (argv.includes('--dry-run')) {
    await dryRunPlan(ctx)
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

/** The lane picks resolve once, up front — a bad provider name (or a
 *  broken fleet.routing table) is a config error that must fail BEFORE
 *  a bead is claimed, not mid-run with claims held. Returns the flag
 *  sel, the fixed lane (the whole lane when routing is off or a flag
 *  pins it; `resolveBeadLane` re-resolves per bead otherwise), the
 *  effective template (a cli provider's `command` substitutes for
 *  `loop.agent`; a template --agent stays the literal value — provider
 *  names are never templates, resolveLoopLane consumed them), and
 *  whether per-bead fleet.routing is armed. */
async function resolveRunLane(
  root: string,
  argv: string[],
  cfg: LoopConfig
): Promise<{
  env: AgentConnectorEnv
  sel: LoopLaneSel
  lane: LoopLane
  agent: string
  routing: boolean
}> {
  const env = loadAgentEnv(root)
  const agentFlag = flag(argv, '--agent')
  const sel: LoopLaneSel = {
    agent: agentFlag,
    provider: flag(argv, '--provider'),
    profile: flag(argv, '--profile'),
    model: flag(argv, '--model'),
    autoApprove: argv.includes('--auto-approve') ? true : undefined,
    class: flag(argv, '--class'),
  }
  // a template --agent bypasses the registry entirely — routing can
  // only arm when the provider lane is in play (templateEscape already
  // warned about the bypass)
  const templateAgent =
    agentFlag !== undefined && !Object.hasOwn(env.providers ?? {}, agentFlag)
  const routing =
    !templateAgent &&
    env.fleet?.routing !== undefined &&
    Object.keys(env.fleet.routing).length > 0
  let lane: LoopLane
  try {
    lane = await resolveLoopLane(env, sel, cfg)
    if (routing) {
      // preflight the class every bead falls back to — a table whose
      // `default` (or the --class pin) doesn't resolve is a global
      // config error, detected before the first claim. Per-bead
      // `class:` labels still resolve per spawn inside pushItem.
      routeStepClass(env.fleet, env.providers ?? {}, undefined, '', sel.class, {})
    }
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
      : agentFlag !== undefined && !Object.hasOwn(env.providers ?? {}, agentFlag)
        ? agentFlag
        : cfg.agent
  if (lane.worker === undefined && agent === '' && !routing) {
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
  // check would only misfire on it. With fleet.routing armed and no
  // flag-tier worker the base template is inert — each bead's routed
  // lane carries its own command.
  if (
    !(routing && lane.worker === undefined) &&
    lane.worker?.kind !== 'argv' &&
    !agent.includes('{promptFile}')
  ) {
    // binary name only — the template may carry inline credentials
    const agentBin = agent.split(/\s+/, 1)[0]
    console.error(
      `bro loop: agent template has no {promptFile} — "${agentBin}". ` +
        'The prompt file appends as a positional arg; interactive CLIs ' +
        '(devin, claude) treat that as a TUI session, not a worker prompt. ' +
        'Intended for env-reading agents (BRO_PROMPT_FILE) only.'
    )
  }
  return { env, sel, lane, agent, routing }
}

function buildCtx(
  root: string,
  argv: string[],
  broCfg: ReturnType<typeof loadBroConfig>,
  cfg: LoopConfig,
  run: {
    env: AgentConnectorEnv
    sel: LoopLaneSel
    lane: LoopLane
    agent: string
    routing: boolean
  },
  backend: string
): Ctx {
  const { env, sel, lane, agent, routing } = run
  const rev = reviewHost(root, broCfg.connectors)
  const ctx: Ctx = {
    rev,
    tasks: facade('tasks', { dir: root }, { prefer: broCfg.connectors }),
    backend,
    repo: rev.resolveRepo([]),
    root,
    cfg: {
      ...cfg,
      agentTimeoutMin: num(flag(argv, '--agent-timeout'), cfg.agentTimeoutMin, 0),
      mergeTimeoutMin: num(flag(argv, '--merge-timeout'), cfg.mergeTimeoutMin),
      maxItems: num(flag(argv, '--max'), cfg.maxItems, 0),
      maxOpen: num(flag(argv, '--max-open'), cfg.maxOpen, 1),
    },
    act: broCfg.act,
    agent,
    lane,
    env,
    sel,
    routing,
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
  // the run must not be a silent behavior change for template users.
  // With routing armed but no flag-tier pin, the provider isn't known
  // until each bead resolves — say so instead of implying a fixed lane.
  if (ctx.routing && ctx.lane.provider === undefined) {
    say(
      ctx,
      'loop: fleet.routing — provider resolves per bead class' +
        (ctx.sel.class === undefined ? '' : ` (pinned: ${ctx.sel.class})`)
    )
  }
  if (ctx.lane.provider !== undefined) {
    say(
      ctx,
      `loop: provider ${laneLabel(ctx.lane)}` +
        (ctx.lane.worker?.kind === 'argv' ? ' (acp worker)' : '') +
        (ctx.routing ? ' (pinned — fleet.routing supplies classes only)' : '')
    )
  }
  return ctx
}

async function dryRunPlan(ctx: Ctx): Promise<void> {
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
  // the render resolves THIS bead's lane — with fleet.routing armed the
  // provider differs per bead; a broken route reports the same error a
  // claimed run would park on
  let lane = ctx.lane
  if (ctx.routing) {
    try {
      lane = await resolveBeadLane(ctx, top)
    } catch (err) {
      console.log(`  route: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  }
  const w = lane.worker
  if (lane.class !== undefined) {
    console.log(`  class: ${lane.class}`)
  }
  if (lane.provider !== undefined) {
    console.log(`  provider: ${laneLabel(lane)}`)
  }
  console.log(
    `  agent: ${
      w?.kind === 'argv'
        ? [...w.argv, item.promptFile].map(shRender).join(' ')
        : expandAgentCmd(laneCommand(ctx, lane), item.promptFile)
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The run's mutable queue state — the gate stack, the outcome tally,
 *  and the claim bookkeeping the tick helpers share. */
interface QueueState {
  /** Beads already attempted this run — never re-picked. */
  seen: Set<string>
  /** The ordered gate stack — entry order is service priority. */
  stack: GateMember[]
  tally: { landed: number; closed: number; parked: number; failed: number }
  /** Claims spent — --max bounds claims, not outcomes: a claimed bead's
   *  verdict arrives whenever its gate settles. */
  claimed: number
  /** claimNext returned nothing — no more pushes, only gate service. */
  drained: boolean
}

/** One service pass over the stack, oldest-first — a snapshot copy
 *  because leave() splices members out mid-iteration. True when any
 *  member moved (action, merge, park): the next tick polls immediately
 *  instead of paying the interval. */
async function servicePass(ctx: Ctx, q: QueueState): Promise<boolean> {
  let busy = false
  for (const m of [...q.stack]) {
    const verdict = await serviceMember(ctx, m)
    if (verdict === 'kept') {
      continue
    }
    busy = true
    if (verdict === 'active') {
      continue
    }
    q.stack.splice(q.stack.indexOf(m), 1)
    q.tally[verdict] += 1
    if (verdict === 'landed') {
      syncAfterLand(ctx)
    }
    if (ctx.json) {
      console.log(JSON.stringify({ bead: m.bead.id, result: verdict }))
    }
  }
  return busy
}

/** The push half of a tick — true when a bead was claimed (drained or
 *  not, the fresh member's first poll wants an immediate pass, not an
 *  idle interval). False when the push was skipped — queue drained,
 *  --max spent, or the gate stack full. */
async function tryClaim(
  ctx: Ctx,
  scope: NonNullable<ReturnType<typeof loopScope>>,
  q: QueueState
): Promise<boolean> {
  const maxed = ctx.cfg.maxItems > 0 && q.claimed >= ctx.cfg.maxItems
  if (q.drained || maxed || q.stack.length >= ctx.cfg.maxOpen) {
    return false
  }
  const bead = claimNext(ctx, scope, q.seen)
  if (bead === undefined) {
    q.drained = true
    return false
  }
  q.seen.add(bead.id)
  q.claimed += 1
  const out = await pushItem(ctx, bead)
  if (out.kind === 'member') {
    q.stack.push(out.member)
    say(
      ctx,
      `loop: ${bead.id} → PR ${prRef(ctx, out.member.pr)} (gate ${q.stack.length}/${ctx.cfg.maxOpen})`
    )
  } else {
    q.tally[out.result] += 1
    if (ctx.json) {
      console.log(JSON.stringify({ bead: bead.id, result: out.result }))
    }
  }
  return true
}

/** The round-robin: each tick services the gate stack oldest-first,
 *  then pushes the next bead while a slot is free (loop.maxOpen). The
 *  run ends when the queue is drained or --max claims are spent AND
 *  the stack is empty — pending members wait out their own budgets. */
async function runQueue(ctx: Ctx): Promise<void> {
  const q: QueueState = {
    seen: new Set(),
    stack: [],
    tally: { landed: 0, closed: 0, parked: 0, failed: 0 },
    claimed: 0,
    drained: false,
  }
  try {
    // inside the try: a failed scope lookup still owes the run an audit
    const scope = loopScope()
    if (!scope) {
      return
    }
    for (;;) {
      const busy = await servicePass(ctx, q)
      if (await tryClaim(ctx, scope, q)) {
        continue
      }
      const maxed = ctx.cfg.maxItems > 0 && q.claimed >= ctx.cfg.maxItems
      if (q.stack.length === 0 && (q.drained || maxed)) {
        break
      }
      if (!busy) {
        // cap the nap at the earliest member deadline — waitForGate's
        // own sleep was deadline-capped; a member at mergeTimeoutMin
        // must park on the next tick, not an interval late
        const deadline = Math.min(
          ...q.stack.map((m) => m.since + ctx.cfg.mergeTimeoutMin * 60_000)
        )
        await sleep(
          Math.min(ctx.intervalS * 1000, Math.max(0, deadline - Date.now()))
        )
      }
    }
    if (ctx.json) {
      console.log(JSON.stringify({ done: true, ...q.tally }))
    } else {
      console.log(
        `loop: done — ${q.tally.landed} landed, ${q.tally.closed} closed, ${q.tally.parked} parked, ${q.tally.failed} failed`
      )
    }
  } finally {
    // idle, gated, or error — the audit always runs; a tail the loop
    // left must surface in the summary, not be discovered later
    endAudit(ctx, q.seen)
  }
}
