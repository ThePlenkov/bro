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
 *   bro loop --batch 8          clump up to 8 same-affinity beads per
 *                               work item — one worker, one PR
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
 * rules). With `loop.batch`/`--batch` a claim is a CLUMP: the top bead
 * pulls same-affinity neighbors (spec/epic/area/path key) into one
 * worktree + one PR, per-bead commits as checkpoints, uncovered
 * members re-queue on merge (spec bro-nspj7). A bead whose agent fails
 * without a PR is reopened with a
 * note — unless the spawn died inside loop.crashExitMs (default 10s):
 * gone that fast it crashed on the environment, not the bead, and
 * reopening is a respawn-burn, so it parks loud instead (bro-sovl3). A
 * bead whose PR stalls keeps its worktree for inspection.
 */
import { spawnSync, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  AgentNotFound,
  agentRegistryPath,
  commandCliName,
  ensureTasksBackend,
  facade,
  gitBranchLog,
  gitTry,
  LockTimeout,
  procStat,
  reviewHost,
  SpawnError,
  stepParent,
  withFileLock,
  type AgentConnector,
  type AgentInfo,
  type AgentState,
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
  clumpMembers,
  coveredBeadIds,
  expandAgentCmd,
  memberAction,
  planItem,
  type GateSnapshot,
  type LoopConfig,
  type LoopItem,
} from '@broject/loop'
import { loadBroConfig } from '../plugins.ts'
import {
  fleetProfileOf,
  loadAgentEnv,
  resolveAgentConnector,
  resolveSpawnProvider,
  type AgentConnectorEnv,
  type SpawnProviderPick,
} from '../agent-connectors.ts'
import { flag, positionals } from './args.ts'
import { runActCommand } from './act.ts'
import { beginLoopRun, endLoopRun, loopRunLog, reapLoopRuns } from './loop-state.ts'
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
  /** The agents facade connector workers spawn through (spec
   *  bro-zpa93) — the `bro agents up` path: detached sh -c, claim under
   *  the registry lock, .exit record in <git-common>/bro/agents/.
   *  Undefined only when beadsDir is — the registry's claim plane needs
   *  a real store to pin against, so the legacy awaited spawn keeps the
   *  serial semantics there. */
  agents?: AgentConnector
  /** `bro loop --stack <name>` — each claimed bead becomes a member of
   *  the named stack: branch stack/<name>/<n>-<slug> based on the tip,
   *  PR targeting the member below. */
  stack?: string
  /** Cleanup failures collected during the run — the end-of-run audit
   *  prints them again so a tail never dies in a scrollback line. */
  tails: string[]
  /** Liveness — the stage the run is suspended on. The heartbeat names
   *  it every tick; the mid-run exit audit names it once (spec
   *  bro-snga4). A silent death becomes a named death either way. */
  stage: string
  /** The bead currently in play — undefined between items so a death
   *  outside an item notes nothing stale. */
  bead?: string
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
  --merge-timeout MIN            gate budget per round (loop.mergeTimeoutMin, 45)
  --label a,b                    declared scope — only beads carrying one
                                of these labels are claimable
  --stack NAME                   chain claimed beads onto stack NAME —
                                each PR targets the member below
  --max-open N                   cap the gate stack's open PRs (loop.maxOpen, 3)
  --batch N                      max beads per claim — a clump shares the
                                lead's affinity key (spec/epic/area/path),
                                one worktree, one worker, one PR
                                (loop.batch, 1 = solo)
  --interval SEC                 gate poll interval (60)`)
  process.exit(2)
}

const num = (v: string | undefined, dflt: number, min = 1, max?: number): number => {
  if (v === undefined) return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? `>= ${min}` : `${min}..${max}`
    console.error(`bro loop: invalid numeric value "${v}" (must be ${range})`)
    process.exit(2)
  }
  return n
}

/** Node clamps a timer delay over 2^31-1 ms to 1 ms — a flag that becomes
 *  a raw delay needs a ceiling or an absurd value hot-loops the
 *  heartbeat/gate poll (or fires the agent timeout instantly). */
const TIMER_MAX_MS = 2 ** 31 - 1

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

/** The store dir the loop's own taskStore calls resolve to — the
 *  backend's `dataDir` (`bd where` for beads). Pinned into spawned envs
 *  as BEADS_DIR — a worktree-local .beads (tracked copy, stale
 *  checkout) or a bd too old for common-dir discovery would otherwise
 *  fork bead state: the agent's close/update lands in a db that dies
 *  with the worktree and the bead re-surfaces phantom-open in main. */
export function resolveBeadsDir(root: string, warn?: (msg: string) => void): string | undefined {
  const fail = (why: string): undefined => {
    warn?.(`loop: store data-dir ${why} — agents run unpinned, BEADS_DIR not set`)
    return undefined
  }
  try {
    const store = facade('tasks', { dir: root }, { prefer: loadBroConfig(root).connectors })
    const dir = store.dataDir?.()
    return dir ?? fail('returned no path')
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
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

/** Spawn the agent in the worktree and await its exit — there is no
 *  timer and no kill path (spec bro-9lpn3): a worker's lifetime is the
 *  orchestrator's decision, taken at check-in from the run record, never
 *  by a wall clock inside the spawn. The child still runs `detached`
 *  (own process group) so a terminal interrupt of `bro loop` can't
 *  group-signal a mid-write worker — interrupting the loop is an
 *  accident, not an orchestration decision.
 *
 *  `beadIds` is the whole claimed clump — a solo claim is a
 *  one-element list (spec bro-nspj7); the run record, log slug, and
 *  provenance pins key off the lead (`beadIds[0]`).
 *
 *  stdout/stderr go straight to `<git-common>/bro/loop/<slug>.log`
 *  (append — fix rounds continue the same trail), and the spawn leaves a
 *  `<slug>.json` record beside it: pid/pidStart for liveness, the log's
 *  mtime as the last-progress signal `bro watch`/`bro status` report
 *  silence from. A file fd, not a pipe — a dead loop must not turn the
 *  worker's next write into a SIGPIPE kill, and the transcript survives
 *  the loop for audit either way. When no log can be opened the child
 *  inherits our streams (stdout → stderr under --json, so the event
 *  stream stays parseable) — a record-less spawn still works. */
function spawnAgent(
  ctx: Ctx,
  beadIds: string[],
  title: string,
  promptFile: string,
  dir: string
): Promise<number | null> {
  return new Promise((resolve) => {
    const leadId = beadIds[0]!
    const env = agentEnv(ctx, {
      // BRO_BEAD_ID stays the lead for compatibility — batch work orders
      // read the whole clump off BRO_BEAD_IDS
      BRO_BEAD_ID: leadId,
      BRO_BEAD_IDS: beadIds.join(','),
      BRO_BEAD_TITLE: title,
      BRO_PROMPT_FILE: promptFile,
      ...provenancePins(ctx, leadId),
    })
    const slug = loopSlug(leadId)
    const log = loopRunLog(ctx.root, slug)
    let logFd: number | null = null
    if (log !== null) {
      try {
        mkdirSync(dirname(log), { recursive: true })
        logFd = openSync(log, 'a')
      } catch {
        logFd = null
      }
    }
    const opts = {
      cwd: dir,
      env,
      stdio:
        logFd !== null
          ? (['inherit', logFd, logFd] as Array<'inherit' | number>)
          : (['inherit', ctx.json ? 2 : 'inherit', 'inherit'] as Array<'inherit' | number>),
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
    if (logFd !== null) {
      // the child holds its own dup — our copy is spent
      closeSync(logFd)
    }
    if (child.pid !== undefined) {
      beginLoopRun(ctx.root, {
        beadId: leadId,
        slug,
        pid: child.pid,
        pidStart: procStat(child.pid)?.start,
        startedAt: new Date().toISOString(),
        worktree: dir,
        log: log ?? '',
      })
      const logNote = log === null ? '' : ` — log ${log}`
      say(ctx, `loop: agent ${beadIds.join(', ')} on pid ${child.pid}${logNote}`)
    }
    ctx.stage = `worker pid=${child.pid ?? '?'}`
    const settle = (code: number | null): void => {
      endLoopRun(ctx.root, slug)
      resolve(code)
    }
    child.on('error', (err) => {
      console.error(`loop: agent spawn failed — ${err.message}`)
      settle(null)
    })
    child.on('exit', (code, signal) => {
      if (code === null) {
        console.error(`loop: agent died on signal ${signal ?? '?'}`)
        settle(null)
        return
      }
      settle(code)
    })
  })
}

/** spec.env for the registry spawn — the loop's ambient pins minus
 *  the keys the connector owns (it re-pins BEADS_DIR/BRO_BEAD_ID/
 *  provenance itself; the backend filters them out of caller env
 *  anyway). Only the clump extras are loop-private. */
function specEnv(ctx: Ctx, extra: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(agentEnv(ctx, extra)).filter(
      (e): e is [string, string] => e[1] !== undefined
    )
  )
}

/** The registry spawn (spec bro-zpa93) — `bro agents up` semantics on
 *  the loop's own work item: the lead bead's claim lands through the
 *  connector's claimStep under the agents-registry lock (a loop-side
 *  pre-claim would read as "claimed outside the registry" and refuse),
 *  the worker detaches `sh -c` in its own process group, and its exit
 *  lands in `<git-common>/bro/agents/<id>.exit` for serviceWorker to
 *  poll — the tick never awaits the run. Sets `m.worker`; a SpawnError
 *  is the caller's settle decision (cap → hold, conflict → park). */
async function spawnWorker(ctx: Ctx, m: GateMember, prompt: string): Promise<void> {
  const lead = m.beads[0]!
  const info = await ctx.agents!.spawn({
    molStep: lead.id,
    repoRoot: m.item.worktreeDir,
    beadsDir: ctx.beadsDir!,
    prompt,
    env: specEnv(ctx, {
      BRO_BEAD_IDS: m.beads.map((b) => b.id).join(','),
      BRO_BEAD_TITLE: clumpTitle(m.beads),
    }),
    provider: ctx.lane.provider,
    model: ctx.lane.model,
    // an explicit worker keeps the backend's own command fallback from
    // re-reading loop.agent config — a --agent flag override would
    // otherwise be silently ignored
    worker: ctx.lane.worker ?? { kind: 'template', command: ctx.agent },
  })
  m.worker = {
    agentId: info.id,
    spawnedAt: info.spawnedAt,
    spawnedMs: Date.now(),
    pid: info.pid,
  }
  say(
    ctx,
    `loop: agent ${m.beads.map((b) => b.id).join(', ')} → ${info.id} pid ${info.pid ?? '?'}`
  )
  ctx.stage = `worker ${info.id} pid=${info.pid ?? '?'}`
}

/** The pending worker's settled exit — the .exit record a detached
 *  `sh -c` leaves in `<git-common>/bro/agents/`. The file's mtime is the
 *  honest wall-clock for the crash window: a poll that lands an
 *  interval late must not inflate an instant crash past crashExitMs.
 *  A worker dead without a record (SIGKILL, spawn failure) falls back
 *  to the log's last write, then now. */
function workerExit(ctx: Ctx, w: WorkerRef): { code: number | null; at: number } {
  const reg = agentRegistryPath(ctx.root)
  const home =
    reg === null || basename(w.agentId) !== w.agentId
      ? null
      : join(dirname(reg), 'agents')
  if (home !== null) {
    try {
      const f = join(home, `${w.agentId}.exit`)
      const n = Number(readFileSync(f, 'utf8').trim())
      return { code: Number.isInteger(n) ? n : null, at: statSync(f).mtimeMs }
    } catch {
      // no exit record — the log clock is the next-best death stamp
    }
    try {
      return { code: null, at: statSync(join(home, `${w.agentId}.log`)).mtimeMs }
    } catch {
      // no log either — detection time is all that remains
    }
  }
  return { code: null, at: Date.now() }
}

/** A refused registry spawn settles the push without a worker. A full
 *  fleet ('cap') holds the claim for the next tick — fleet pressure is
 *  transient, and a hot re-pick would burn the interval against the
 *  same wall. A 'conflict' (live agent, foreign claim, respawn block)
 *  parks WITHOUT a note — the bead's owner is not this run. Anything
 *  else parks with the error named. Member claims release either way;
 *  on a conflict the LEAD's claim plane is contested, so only the
 *  clump members this run claimed are reopened. */
function settleSpawnRefusal(ctx: Ctx, m: GateMember, err: unknown): PushOutcome {
  const msg = err instanceof Error ? err.message : String(err)
  if (err instanceof SpawnError && err.kind === 'cap') {
    for (const b of openBeads(ctx, m.beads)) {
      reopenBead(ctx.tasks, b.id)
    }
    say(ctx, `loop: fleet full — ${msg}; pushes hold for the next pass`)
    return { kind: 'hold', why: msg }
  }
  const foreign = err instanceof SpawnError && err.kind === 'conflict'
  for (const b of openBeads(ctx, foreign ? m.beads.slice(1) : m.beads)) {
    reopenBead(ctx.tasks, b.id)
  }
  if (!foreign) {
    for (const b of openBeads(ctx, m.beads)) {
      noteBead(ctx.tasks, b.id, `loop: agent spawn refused — ${msg} — worktree ${m.item.worktreeDir}`)
    }
  }
  say(ctx, `loop: ${m.beads[0]!.id} spawn refused — ${msg}`)
  return { kind: 'done', result: 'parked' }
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

/** A bead's store status, or 'unknown' when the probe fails — callers
 *  treat 'unknown' as still-open so a blip never masks work. */
function beadStatus(ctx: Ctx, id: string): string {
  try {
    return ctx.tasks.get(id)?.status ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The members of a clump still open in the store — verdict closes the
 *  agent already landed stay closed. */
function openBeads(ctx: Ctx, beads: ReadyBead[]): ReadyBead[] {
  return beads.filter((b) => beadStatus(ctx, b.id) !== 'closed')
}

/** A note fanned out over the clump's still-open members — verdict
 *  closes the agent already landed don't get gate-failure notes. */
function noteOpen(ctx: Ctx, beads: ReadyBead[], msg: string): void {
  for (const b of openBeads(ctx, beads)) {
    noteBead(ctx.tasks, b.id, msg)
  }
}

/** The clump's own commit log — messages on the member branch since it
 *  forked from its PR base. Coverage is evidence: only beads a commit
 *  names count as resolved (spec bro-nspj7). Preferred head is the PR's
 *  pushed headSha — exactly what merged, so local-only commits can't
 *  over-cover; a remote-only head (update-branch merge) falls back to
 *  the worktree tip. Empty string when the log is unreadable — callers
 *  treat unknown coverage as "nothing covered", the fail-safe direction
 *  (a re-queue, never a false close). */
function clumpCommitLog(ctx: Ctx, item: LoopItem, pr: number): string {
  let base = defaultBranchName() ?? 'main'
  let headSha = ''
  try {
    const meta = ctx.rev.prMeta({ repo: ctx.repo, pr })
    base = meta.baseRef || base
    headSha = meta.headSha
  } catch { /* fall back to the default branch guess + local tip */ }
  return gitBranchLog(headSha, base, item.worktreeDir)
}

/** Settle the clump after its PR merged — every still-open member named
 *  in the branch's commits closes 'landed'; the rest reopen into the
 *  queue (the unfinished tail re-queues, never silently closes). A solo
 *  item keeps the unconditional close — its prompt never owed a naming
 *  contract. */
function settleClump(ctx: Ctx, beads: ReadyBead[], item: LoopItem, pr: number): void {
  const link = prRef(ctx, pr)
  if (beads.length === 1) {
    try {
      // the agent may have closed it already — a verdict plus a PR both
      // reaching the store is fine; a second close is a noisy error
      if (beadStatus(ctx, beads[0]!.id) !== 'closed') {
        ctx.tasks.close(beads[0]!.id, `landed via PR ${link}`)
      }
    } catch (err) {
      console.error(`loop: ${ctx.backend} close ${beads[0]!.id} failed — ${String(err)}`)
    }
    return
  }
  const covered = coveredBeadIds(
    clumpCommitLog(ctx, item, pr),
    beads.map((b) => b.id)
  )
  for (const b of beads) {
    if (beadStatus(ctx, b.id) === 'closed') {
      continue // the agent's own verdict stands
    }
    if (covered.has(b.id)) {
      try {
        ctx.tasks.close(b.id, `landed via PR ${link}`)
      } catch (err) {
        console.error(`loop: ${ctx.backend} close ${b.id} failed — ${String(err)}`)
      }
    } else {
      // merged without a commit naming it — unfinished tail re-queues
      noteBead(ctx.tasks, b.id, `loop: ${link} landed without a commit naming ${b.id} — re-queued`)
      reopenBead(ctx.tasks, b.id)
      say(ctx, `loop: ${b.id} not covered by ${link} — re-queued`)
    }
  }
}

/** Merge the PR, close the bead(s), drop the worktree. 'landed' only
 *  when the PR reports MERGED — a closed or still-open PR parks the
 *  bead. `alreadyMerged` skips the merge call for PRs that landed
 *  externally while the gate was polling. */
async function finalizeMerge(
  ctx: Ctx,
  beads: ReadyBead[],
  item: LoopItem,
  pr: number,
  alreadyMerged = false
): Promise<'landed' | 'parked'> {
  ctx.stage = `merge pr=${pr}`
  try {
    if (!alreadyMerged) {
      await runActCommand(['merge', String(pr)])
    }
    const state = ctx.rev.prMeta({ repo: ctx.repo, pr }).state
    if (state !== 'MERGED') {
      for (const b of openBeads(ctx, beads)) {
        noteBead(
          ctx.tasks,
          b.id,
          `loop: merge of ${prRef(ctx, pr)} did not land (state=${state}) — worktree ${item.worktreeDir}`
        )
      }
      return 'parked'
    }
  } catch (err) {
    // a merge/fetch failure must not abort the loop leaving the bead
    // claimed forever — note it and park
    for (const b of openBeads(ctx, beads)) {
      noteBead(
        ctx.tasks,
        b.id,
        `loop: finalizing ${prRef(ctx, pr)} failed — ${err instanceof Error ? err.message : String(err)} — worktree ${item.worktreeDir}`
      )
    }
    return 'parked'
  }
  settleClump(ctx, beads, item, pr)
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
  say(ctx, `loop: ${beads.map((b) => b.id).join(', ')} landed via ${prRef(ctx, pr)}`)
  return 'landed'
}

/** Collect unresolved thread text, write the fix prompt, respawn the
 *  agent. A dead fix agent is logged, not fatal — the next gate poll
 *  decides whether anything landed on the branch. */
async function runFixRound(
  ctx: Ctx,
  m: GateMember,
  pr: number,
  round: number
): Promise<void> {
  ctx.stage = `fix round ${round} pr=${pr}`
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
  const prompt = buildFixPrompt(m.beads, pr, threads)
  writePrompt(m.item, prompt)
  say(ctx, `loop: ${prRef(ctx, pr)} has open threads — fix round ${round}`)
  if (ctx.agents !== undefined) {
    await spawnWorker(ctx, m, prompt)
    return
  }
  const code = await spawnAgent(ctx, m.beads.map((b) => b.id), clumpTitle(m.beads), m.item.promptFile, m.item.worktreeDir)
  if (code !== 0) {
    console.error(`loop: fix agent exited ${code ?? 'abnormal'} — the next gate poll decides`)
  }
}

/** The spawned worker's env title — a clump names the lead plus its
 *  tail size so provenance still reads as one line. */
function clumpTitle(beads: ReadyBead[]): string {
  return beads.length > 1
    ? `${beads[0]!.title} (+${beads.length - 1} more)`
    : beads[0]!.title
}

/** An agent that exits without a PR may still have left verdicts — each
 *  `bd close` lands in the shared store (BEADS_DIR pin). Closed means
 *  "nothing to ship"; reopening it would resurrect the phantom. A failed
 *  status probe falls through to the failure path rather than masking
 *  it. ALL members closed → the whole clump is a verdict; a partial
 *  close still counts — the unclosed tail falls through to requeue. */
function agentVerdict(ctx: Ctx, beads: ReadyBead[], worktreeDir: string): ItemResult | undefined {
  const closed = beads.filter((b) => beadStatus(ctx, b.id) === 'closed')
  if (closed.length === 0) {
    return undefined
  }
  for (const b of closed) {
    say(ctx, `loop: ${b.id} closed by the agent — verdict, not a failure`)
    noteBead(ctx.tasks, b.id, `loop: closed by agent verdict — worktree ${worktreeDir} kept for audit`)
  }
  return closed.length === beads.length ? 'closed' : undefined
}

/** Agent exited without a PR — note + reopen every member still open,
 *  'failed'. A batch member's own `bd close` verdict stands. */
function failNoPr(
  ctx: Ctx,
  beads: ReadyBead[],
  item: LoopItem,
  code: number | null
): ItemResult {
  for (const b of openBeads(ctx, beads)) {
    noteBead(
      ctx.tasks,
      b.id,
      `loop: agent exited ${code ?? 'abnormal'} without a PR — worktree kept at ${item.worktreeDir}`
    )
    reopenBead(ctx.tasks, b.id)
  }
  return 'failed'
}

/** Optional bootstrap command — false (with the beads noted + reopened)
 *  when it fails; spawning the agent on a half-set-up worktree is worse
 *  than failing fast. */
function runBootstrap(ctx: Ctx, beads: ReadyBead[], item: LoopItem): boolean {
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
  for (const bead of openBeads(ctx, beads)) {
    noteBead(
      ctx.tasks,
      bead.id,
      `loop: bootstrap failed (${b.status ?? b.signal ?? 'spawn error'}) — worktree kept at ${item.worktreeDir}`
    )
    reopenBead(ctx.tasks, bead.id)
  }
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

/** A PR on the run's gate stack — claimed bead(s) + worktree + the
 *  per-member clock and its armed watch marker. `beads[0]` is the lead;
 *  a batch carries the whole clump (spec bro-nspj7). Entry order is
 *  service priority: the oldest member gets serviced first. */
interface GateMember {
  beads: ReadyBead[]
  item: LoopItem
  /** The PR this member gates on — undefined while its FIRST worker is
   *  still running (spec bro-zpa93): the member is pushed the moment
   *  the spawn registers and joins the gate when the .exit lands. */
  pr?: number
  /** The in-flight registry worker — set at push and again on every
   *  fix/rebase respawn; cleared when its exit record lands. */
  worker?: WorkerRef
  /** watchBegin marker path — armed for the member's whole stack
   *  tenure: a dead loop leaves a dead marker `act rearm` resurrects
   *  as `act wait --merge --cleanup` in the member's worktree. */
  marker: string | null
  /** Gate (re-)entry ms — a fix/rebase round resets the budget. */
  since: number
  /** When this member may be polled again — a 'kept' verdict stamps
   *  its stage's own cadence (worker: WORKER_POLL_MS; gate: intervalS),
   *  so a fast worker wake can't drag a PR gate into hot host polls. */
  nextPollAt?: number
  /** Agent respawns consumed — fix and rebase rounds share the
   *  loop.fixRounds bound. */
  rounds: number
  /** headSha an update-branch push last moved — the landing check. */
  updatedSha?: string
  /** Consecutive fetch failures — parks at the old wait's 3. */
  fetchErrors: number
}

/** The registry handle a pending member polls — `spawnedAt` is the
 *  generation stamp: a respawned same-id entry is a NEW worker, not the
 *  one the member is waiting on, and must not inherit this clock. */
interface WorkerRef {
  agentId: string
  spawnedAt?: string
  /** ms stamp at our spawn call — the crash window's start. */
  spawnedMs: number
  pid?: number
}

/** The push half of the alternation: claim → worktree → agent → PR.
 *  `beads` is the claimed clump — a solo claim is a one-element array.
 *  The PR found joins the gate stack as the newest member; every
 *  no-PR outcome settles inline exactly as the serial loop did. */
type PushOutcome =
  | { kind: 'member'; member: GateMember }
  | { kind: 'done'; result: ItemResult }
  | { kind: 'hold'; why: string }

async function pushItem(ctx: Ctx, beads: ReadyBead[]): Promise<PushOutcome> {
  const lead = beads[0]!
  // resolved here, not earlier — a member that landed since the last
  // push correctly yields the default branch as the next base.
  let slot: StackSlot | undefined
  let item!: LoopItem
  // the claims this run actually holds — claimUpTo owns the lead only
  // outside the registry path; there the lead is a PROBE until
  // claimStep lands it under the spawn lock, so a pre-spawn settle
  // that reopened it could steal a foreign loop's fresh claim
  const ours = ctx.agents === undefined ? beads : beads.slice(1)
  try {
    ctx.stage = 'worktree'
    const planned = planItemAndWorktree(ctx, lead)
    slot = planned.slot
    item = planned.item
  } catch (err) {
    for (const b of openBeads(ctx, ours)) {
      noteBead(ctx.tasks, b.id, `loop: worktree failed — ${err instanceof Error ? err.message : String(err)}`)
      reopenBead(ctx.tasks, b.id)
    }
    return { kind: 'done', result: 'failed' }
  }
  ctx.stage = 'bootstrap'
  if (!runBootstrap(ctx, ours, item)) {
    return { kind: 'done', result: 'failed' }
  }
  const prompt = buildWorkPrompt(beads, item.branch, slot?.base, slot?.bottom, ctx.backend)
  ctx.stage = 'prompt write'
  try {
    writePrompt(item, prompt)
  } catch (err) {
    // a dead fs must not strand this run's claims in_progress — same
    // settle as the worktree failure above
    for (const b of openBeads(ctx, ours)) {
      noteBead(ctx.tasks, b.id, `loop: prompt write failed — ${err instanceof Error ? err.message : String(err)}`)
      reopenBead(ctx.tasks, b.id)
    }
    return { kind: 'done', result: 'failed' }
  }
  ctx.stage = 'agent spawn'
  if (ctx.agents !== undefined) {
    // the registry path — the member comes back worker-pending and its
    // .exit poll rides the SAME service pass as every PR gate
    // (spec bro-zpa93): a worker that runs for hours starves nothing
    const member: GateMember = {
      beads,
      item,
      marker: null,
      since: Date.now(),
      rounds: 0,
      fetchErrors: 0,
    }
    try {
      await spawnWorker(ctx, member, prompt)
    } catch (err) {
      return settleSpawnRefusal(ctx, member, err)
    }
    return { kind: 'member', member }
  }
  // no shared store to pin a claim/exit record against — the awaited
  // spawn keeps the serial semantics (documented fallback)
  const spawnAt = Date.now()
  const code = await spawnAgent(ctx, beads.map((b) => b.id), clumpTitle(beads), item.promptFile, item.worktreeDir)
  // agent wall-time — measured before findPr's gh call; a slow lookup
  // must not inflate an instant crash past the crashExitMs threshold
  const elapsed = Date.now() - spawnAt
  ctx.stage = 'pr lookup'
  const pr = findPr(ctx, item.branch)
  if (pr === 'lookup-error') {
    for (const b of openBeads(ctx, beads)) {
      noteBead(ctx.tasks, b.id, `loop: PR lookup failed for ${item.branch} — worktree ${item.worktreeDir}`)
    }
    return { kind: 'done', result: 'parked' }
  }
  if (pr === null) {
    return { kind: 'done', result: settleNoPr(ctx, beads, item, code, elapsed) }
  }
  // the loop IS the watcher — arm the same marker `act wait` drops
  // (bro-z0k2u) for the member's whole stack tenure, not per poll:
  // a reboot-killed loop leaves a dead marker `bro act rearm`
  // resurrects instead of the PR sitting silently unwatched. `bead`
  // rides the marker so the resurrected wait can run the finalizeMerge
  // half the dead loop never reached — merge lands, claims close
  // (bro-q6ppv); a clump's whole id list rides comma-joined.
  const member: GateMember = {
    beads,
    item,
    pr,
    marker: watchBegin(ctx.root, {
      pr,
      link: prRef(ctx, pr),
      merge: true,
      cleanup: true,
      workdir: item.worktreeDir,
      bead: beads.map((b) => b.id).join(','),
      timeoutMin: ctx.cfg.mergeTimeoutMin,
    }),
    since: Date.now(),
    rounds: 0,
    fetchErrors: 0,
  }
  return { kind: 'member', member }
}

/** The agent exited without a PR — the settle order: a self-reported
 *  verdict (the worker closed its own bead) wins; an instant exit is
 *  an environment crash to park loud, never a bead failure; anything
 *  else fails the clump and re-queues the still-open members. */
function settleNoPr(
  ctx: Ctx,
  beads: ReadyBead[],
  item: LoopItem,
  code: number | null,
  elapsed: number
): ItemResult {
  const verdict = agentVerdict(ctx, beads, item.worktreeDir)
  if (verdict !== undefined) {
    return verdict
  }
  if (ctx.cfg.crashExitMs > 0 && elapsed < ctx.cfg.crashExitMs) {
    // gone in seconds, no PR, no verdict — the spawn died on the
    // environment (broken dist, bad argv), never on the bead. Reopen
    // and the next claim walks into the same wall: claim → crash →
    // reopen → reclaim is the respawn-burn from bro-sovl3. Park loud.
    for (const b of openBeads(ctx, beads)) {
      noteBead(
        ctx.tasks,
        b.id,
        `loop: agent gone in ${elapsed}ms (exit ${code ?? 'spawn failure'}) — environment crash, not a verdict; parked — worktree kept at ${item.worktreeDir}`
      )
    }
    say(
      ctx,
      `loop: ${beads[0]!.id} agent exited ${code ?? 'spawn failure'} in ${elapsed}ms — parked (crash, not work)`
    )
    return 'parked'
  }
  return failNoPr(ctx, beads, item, code)
}

/** A service verdict — 'kept' parks the member until its nextPollAt
 *  (a quiet wait, or a worker still running); 'active' keeps it too
 *  but asks the scheduler for an immediate re-poll — a fix/rebase/
 *  update just moved the gate, or a worker's exit record just landed.
 *  The rest are ItemResult settles that splice it out. */
type ServiceVerdict = 'kept' | 'active' | ItemResult

/** A pending worker's poll cadence — the registry/.exit probe is a
 *  LOCAL read, not a review-host fetch, so it polls far faster than
 *  the gate interval and a long worker still settles within a second
 *  of its exit landing (spec bro-zpa93). */
const WORKER_POLL_MS = 1_000

/** The worker stage — a spawned member's FIRST gate, before its PR
 *  gate is even meaningful (spec bro-zpa93). It polls the agents
 *  registry, never the review host: 'running'/'spawned' keeps the
 *  member pending and the tick moves on — the whole fairness fix. A
 *  terminal read clears `m.worker` and settles the way the old awaited
 *  spawn did: a PR joins the gate (same member lifecycle), no PR runs
 *  verdict → crash-window → reopen, and a blocked/stopped worker parks
 *  with its cause named. A respawned same-id entry (spawnedAt moved)
 *  is NOT this worker — 'lost' rather than inherit a foreign
 *  generation's clock. For a fix/rebase worker (`m.pr` already set)
 *  the terminal read is simply 'active': the gate re-polls. */
async function serviceWorker(ctx: Ctx, m: GateMember): Promise<ServiceVerdict> {
  const w = m.worker!
  ctx.stage = `worker ${w.agentId} pid=${w.pid ?? '?'}`
  ctx.bead = m.beads[0]!.id
  let info: AgentInfo | undefined
  try {
    info = await ctx.agents!.status(w.agentId)
    m.fetchErrors = 0
  } catch (err) {
    if (!(err instanceof AgentNotFound)) {
      m.fetchErrors += 1
      console.error(`loop: worker ${w.agentId} status failed (${m.fetchErrors}) — ${String(err)}`)
      if (m.fetchErrors < 3) {
        return 'kept'
      }
      noteOpen(
        ctx,
        m.beads,
        `loop: worker status kept failing for ${w.agentId} — ${String(err)} — worktree ${m.item.worktreeDir}`
      )
      return leave(m, 'parked')
    }
    // a reaped entry can't prove its death — 'lost' settles it below
  }
  const superseded =
    info?.spawnedAt !== undefined && w.spawnedAt !== undefined && info.spawnedAt !== w.spawnedAt
  const state: AgentState = superseded || info === undefined ? 'lost' : info.state
  if (state === 'running' || state === 'spawned') {
    return 'kept'
  }
  // a superseded entry's .exit belongs to the NEW generation — its
  // code/mtime would feed a foreign clock into the crash window
  const exit = superseded ? { code: null, at: Date.now() } : workerExit(ctx, w)
  say(
    ctx,
    `loop: worker ${w.agentId} ${exit.code === null ? `${state} — no exit record` : `exited ${exit.code}`}`
  )
  m.worker = undefined
  if (m.pr !== undefined) {
    // a fix/rebase worker's exit IS the gate re-entry — same contract
    // the awaited spawn's return had
    m.since = Date.now()
    return 'active'
  }
  ctx.stage = 'pr lookup'
  const pr = findPr(ctx, m.item.branch)
  if (pr === 'lookup-error') {
    noteOpen(
      ctx,
      m.beads,
      `loop: PR lookup failed for ${m.item.branch} — worktree ${m.item.worktreeDir}`
    )
    return leave(m, 'parked')
  }
  if (pr === null) {
    if (state === 'blocked' || state === 'stopped') {
      // the wall/stop is the verdict — reopening respawns into it
      const why =
        state === 'blocked'
          ? `blocked${info?.cause !== undefined ? ` (${info.cause})` : ''}`
          : 'stopped'
      noteOpen(
        ctx,
        m.beads,
        `loop: worker ${w.agentId} ${why} without a PR — worktree ${m.item.worktreeDir}`
      )
      return leave(m, 'parked')
    }
    return leave(m, settleNoPr(ctx, m.beads, m.item, exit.code, Math.max(0, exit.at - w.spawnedMs)))
  }
  // the worker opened a PR — the member joins its own gate: the loop IS
  // the watcher (bro-z0k2u), the marker arms for the member's whole
  // stack tenure so a dead loop leaves a resurface `act rearm` can
  // resurrect (bro-q6ppv), and `bead` rides comma-joined for the
  // finalizeMerge half the dead loop never reached
  m.pr = pr
  m.marker = watchBegin(ctx.root, {
    pr,
    link: prRef(ctx, pr),
    merge: true,
    cleanup: true,
    workdir: m.item.worktreeDir,
    bead: m.beads.map((b) => b.id).join(','),
    timeoutMin: ctx.cfg.mergeTimeoutMin,
  })
  m.since = Date.now()
  say(ctx, `loop: ${m.beads.map((b) => b.id).join(', ')} → PR ${prRef(ctx, pr)}`)
  return 'active'
}

/** One member's service tick — the per-member cadence gate. A 'kept'
 *  verdict stamps the stage's own poll interval (a pending worker's
 *  local .exit probe is cheap — WORKER_POLL_MS; a PR gate's fetch is
 *  the shared review host — intervalS), so the stack's wake set stays
 *  honest: worker exits land fast without dragging every gate into
 *  hot host polls, and a long worker never starves the stack. */
async function serviceMember(ctx: Ctx, m: GateMember): Promise<ServiceVerdict> {
  if (m.nextPollAt !== undefined && Date.now() < m.nextPollAt) {
    return 'kept'
  }
  m.nextPollAt = undefined
  const verdict =
    m.worker !== undefined ? await serviceWorker(ctx, m) : await serviceGate(ctx, m)
  if (verdict === 'kept') {
    m.nextPollAt =
      Date.now() + (m.worker !== undefined ? WORKER_POLL_MS : ctx.intervalS * 1000)
  }
  return verdict
}

/** One member's settled snapshot → the mapped action. 'kept' parks the
 *  member until the next interval tick (a quiet wait); 'active' keeps
 *  it too but asks the scheduler for an immediate re-poll — a fix/
 *  rebase/update just moved the gate, exactly like the old serial
 *  waitForGate re-entry did. 'landed'/'parked' remove it. */
async function serviceGate(ctx: Ctx, m: GateMember): Promise<ServiceVerdict> {
  const pr = m.pr!
  ctx.stage = `gate pr=${pr}`
  ctx.bead = m.beads[0]!.id
  let snap: GateSnapshot
  try {
    const state = await fetchPrActState(
      ctx.rev,
      { repo: ctx.repo, pr },
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
      `loop ${prRef(ctx, pr)}: threads=${gate.open_threads} ci=${gate.ci_pending}+${gate.ci_failing}f rev=${gate.reviewers_pending} sast=${gate.sast_pending}`
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
    console.error(`loop ${prRef(ctx, pr)}: fetch failed (${m.fetchErrors}) — ${String(err)}`)
    // the old wait gave up on 3 consecutive failures OR its deadline —
    // a member whose fetch plane is down past mergeTimeoutMin settles
    // the same way rather than keeping a slot forever
    if (m.fetchErrors < 3 && Date.now() - m.since < ctx.cfg.mergeTimeoutMin * 60_000) {
      return 'kept'
    }
    noteOpen(
      ctx,
      m.beads,
      `loop: gate fetch kept failing for PR ${prRef(ctx, pr)} — ${String(err)} — worktree ${m.item.worktreeDir}`
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
      return leave(m, await finalizeMerge(ctx, m.beads, m.item, pr, true))
    case 'merge':
      return leave(m, await finalizeMerge(ctx, m.beads, m.item, pr))
    case 'closed':
      noteOpen(ctx, m.beads, `loop: PR ${prRef(ctx, pr)} was closed unmerged — worktree ${m.item.worktreeDir}`)
      return leave(m, 'parked')
    case 'fix':
      return respawnRound(ctx, m, () => runFixRound(ctx, m, pr, m.rounds))
    case 'rebase':
      return respawnRound(ctx, m, () => runRebaseRound(ctx, m, pr, m.rounds))
    case 'update': {
      let ok: boolean
      try {
        ok = ctx.rev.updateBranch({ repo: ctx.repo, pr }, snap.headSha)
      } catch (err) {
        // a throw must not take the stack down — quiet keep; the
        // member's own deadline still bounds the retries
        console.error(`loop ${prRef(ctx, pr)}: update-branch threw — ${String(err)}`)
        return 'kept'
      }
      console.error(`loop ${prRef(ctx, pr)}: update-branch ${ok ? 'pushed a new head' : 'refused'}`)
      if (!ok) {
        // an update refusal IS the settle — same park the wait produced
        noteOpen(ctx, m.beads, `loop: PR ${prRef(ctx, pr)} blocked: ${snap.blockers.join('; ')} — worktree ${m.item.worktreeDir}`)
        return leave(m, 'parked')
      }
      m.updatedSha = snap.headSha
      return 'active'
    }
    case 'wait':
      return 'kept'
    case 'park':
      noteOpen(ctx, m.beads, `loop: PR ${prRef(ctx, pr)} ${act.why} — worktree ${m.item.worktreeDir}`)
      return leave(m, 'parked')
  }
}

/** A member leaving the stack ends its watch — the promise is kept. */
function leave(m: GateMember, verdict: ItemResult): ItemResult {
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
    // a fleet-cap refusal is transient pressure, not a repair attempt —
    // repeated refusals must not burn fixRounds into a park
    if (err instanceof SpawnError && err.kind === 'cap') {
      m.rounds -= 1
    }
    console.error(`loop ${prRef(ctx, m.pr!)}: respawn round ${m.rounds} failed — ${String(err)}`)
    return 'kept'
  }
  if (m.worker !== undefined) {
    // the respawn joined the worker lifecycle — its .exit landing IS
    // the gate re-entry now, not this return (spec bro-zpa93)
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
  m: GateMember,
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
  const prompt = buildRebasePrompt(m.beads, pr, base)
  writePrompt(m.item, prompt)
  say(ctx, `loop: ${prRef(ctx, pr)} conflicts — rebase round ${round} onto ${base}`)
  if (ctx.agents !== undefined) {
    await spawnWorker(ctx, m, prompt)
    return
  }
  const code = await spawnAgent(ctx, m.beads.map((b) => b.id), clumpTitle(m.beads), m.item.promptFile, m.item.worktreeDir)
  if (code !== 0) {
    console.error(`loop: rebase agent exited ${code ?? 'abnormal'} — the next gate poll decides`)
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
  '--merge-timeout',
  '--max',
  '--max-open',
  '--batch',
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
  await guardedRun(ctx)
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
      mergeTimeoutMin: num(flag(argv, '--merge-timeout'), cfg.mergeTimeoutMin),
      maxItems: num(flag(argv, '--max'), cfg.maxItems, 0),
      maxOpen: num(flag(argv, '--max-open'), cfg.maxOpen, 1),
      batch: num(flag(argv, '--batch'), cfg.batch, 1),
    },
    act: broCfg.act,
    agent,
    lane,
    intervalS: num(flag(argv, '--interval'), 60, 1, Math.floor(TIMER_MAX_MS / 1000)),
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
    stage: 'startup',
  }
  // the registry spawn engages when there's a shared store to pin the
  // claim/exit record against — without one the legacy awaited spawn
  // keeps the serial semantics (spec bro-zpa93). A connector that
  // can't even resolve degrades to that same fallback, not a dead loop.
  if (ctx.beadsDir !== undefined) {
    try {
      ctx.agents = resolveAgentConnector({ dir: root }, {}, loadAgentEnv(root))
    } catch (err) {
      console.error(
        `loop: agent connector failed to resolve — ${err instanceof Error ? err.message : String(err)} — falling back to the awaited spawn`
      )
    }
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
  const queue = classify(ready, ctx.selection, scope, epicParentIds(ready, ctx.root)).queue
  const top = queue[0]
  if (!top) {
    console.log('loop --dry-run: nothing claimable')
    return
  }
  // dry-run renders the clump the claim would pick — no claims made;
  // --max bounds it exactly as tryClaim's budget does
  const clump =
    ctx.cfg.batch > 1
      ? [
          top,
          ...clumpMembers(top, queue.slice(1), {
            size:
              ctx.cfg.maxItems > 0 ? Math.min(ctx.cfg.batch, ctx.cfg.maxItems) : ctx.cfg.batch,
            minPriority: ctx.cfg.batchMinPriority,
          }),
        ]
      : [top]
  console.log(`would claim ${clump.map((b) => b.id).join(', ')} — ${top.title}`)
  if (clump.length > 1) {
    for (const b of clump.slice(1)) {
      console.log(`  + ${b.id} — ${b.title}`)
    }
    console.log(`  batch: ${clump.length} beads, one worktree, one PR`)
  }
  const { slot, item } = stackPlan(ctx, top)
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
  ctx.stage = 'audit'
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

/** Claim the next work item — the top ready bead, plus its compatible
 *  tail when `loop.batch` > 1 (spec bro-nspj7: the clump binds on the
 *  lead's affinity key — spec/epic/area/path — and never reaches past
 *  the priority floor or the --max budget). Undefined when the queue
 *  drains. A foreign-only remainder must not look like a drained
 *  queue: 'done' would hide work a shared db still advertises. */
function claimClump(
  ctx: Ctx,
  scope: NonNullable<ReturnType<typeof nextScope>>,
  seen: Set<string>,
  budget: number
): ReadyBead[] | undefined {
  const ready = readyBeads(ctx.root)
  const c = classify(ready, ctx.selection, scope, epicParentIds(ready, ctx.root))
  const candidates = c.queue.filter((b) => !seen.has(b.id))
  // the registry's claimStep owns the lead's claim under the spawn
  // lock (spec bro-zpa93) — a loop-side pre-claim reads as "claimed
  // outside the agent registry" and the spawn refuses it. The pick
  // only re-probes the store so a raced-away bead still skips down the
  // candidate chain exactly as claimUpTo's claim loop did.
  const lead =
    ctx.agents === undefined
      ? claimUpTo(candidates, 1, ctx.root)[0]
      : candidates.find((b) => {
          const s = beadStatus(ctx, b.id)
          return s !== 'in_progress' && s !== 'closed'
        })
  if (!lead) {
    if (c.foreign > 0) {
      say(ctx, `loop: ${c.foreign} foreign-scope bead(s) remain — not claimable in this project`)
    }
    return undefined
  }
  // solo fast path — batch off, no budget for a second member, or a
  // lead that can't clump (urgent, keyless, or `solo`-labelled)
  if (ctx.cfg.batch < 2 || budget < 2) {
    return [lead]
  }
  const want = clumpMembers(
    lead,
    candidates.filter((b) => b.id !== lead.id),
    { size: Math.min(ctx.cfg.batch, budget), minPriority: ctx.cfg.batchMinPriority }
  )
  if (want.length === 0) {
    return [lead]
  }
  // members claim one at a time — a raced-away member skips, and a
  // mid-fill store failure must not sink the run with half the clump
  // claimed: the lead proceeds with whatever members did claim
  const members: ReadyBead[] = []
  for (const m of want) {
    try {
      const got = claimUpTo([m], 1, ctx.root)[0]
      if (got === undefined) {
        continue // raced away
      }
      members.push(got)
    } catch (err) {
      console.error(`loop: clump member claim failed — ${String(err)} — proceeding with a partial clump`)
      break
    }
  }
  if (members.length > 0) {
    say(
      ctx,
      `loop: batch of ${members.length + 1} — ${lead.id} + ${members.map((b) => b.id).join(', ')}`
    )
  }
  return [lead, ...members]
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
  /** claimClump returned nothing — no more pushes, only gate service. */
  drained: boolean
  /** A spawn refused on a full fleet holds pushes until now — a
   *  hot-loop through pick+probe+spawn would burn the tick against
   *  the same wall (spec bro-zpa93). */
  pushHoldUntil: number
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
      console.log(
        JSON.stringify({ bead: m.beads[0]!.id, beads: m.beads.map((b) => b.id), result: verdict })
      )
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
  if (q.drained || maxed || q.stack.length >= ctx.cfg.maxOpen || Date.now() < q.pushHoldUntil) {
    return false
  }
  ctx.stage = 'claim'
  ctx.bead = undefined
  // --max bounds BEADS, not items — a clump may only fill up to the
  // run's remaining claim budget
  const budget =
    ctx.cfg.maxItems > 0 ? ctx.cfg.maxItems - q.claimed : Number.MAX_SAFE_INTEGER
  const clump = claimClump(ctx, scope, q.seen, budget)
  if (clump === undefined) {
    q.drained = true
    return false
  }
  const ids = clump.map((b) => b.id)
  for (const b of clump) {
    q.seen.add(b.id)
  }
  q.claimed += clump.length
  ctx.bead = clump[0]!.id
  const out = await pushItem(ctx, clump)
  if (out.kind === 'hold') {
    // fleet cap refused the spawn — un-see the clump and hold pushes
    // for a beat so the next pick doesn't burn the tick re-probing the
    // same wall; the claims pushItem released are re-pickable
    for (const b of clump) {
      q.seen.delete(b.id)
    }
    q.claimed -= clump.length
    q.pushHoldUntil = Date.now() + ctx.intervalS * 1000
    return false
  }
  if (out.kind === 'member') {
    q.stack.push(out.member)
    // a worker-pending member reports its pending phase — its `→ PR`
    // line lands when the worker exits and the gate join happens
    say(
      ctx,
      out.member.pr === undefined
        ? `loop: ${ids.join(', ')} pushed — worker pending (gate ${q.stack.length}/${ctx.cfg.maxOpen})`
        : `loop: ${ids.join(', ')} → PR ${prRef(ctx, out.member.pr)} (gate ${q.stack.length}/${ctx.cfg.maxOpen})`
    )
  } else {
    q.tally[out.result] += 1
    if (ctx.json) {
      console.log(JSON.stringify({ bead: ids[0], beads: ids, result: out.result }))
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
    pushHoldUntil: 0,
  }
  try {
    // sweep a crashed run's records before the first claim — a dead-pid
    // record is residue, not a live worker; live pids are never touched
    reapLoopRuns(ctx.root)
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
        const pending = q.stack.find((m) => m.worker !== undefined)
        ctx.stage =
          pending === undefined
            ? 'idle'
            : `worker ${pending.worker!.agentId} pid=${pending.worker!.pid ?? '?'}`
        ctx.bead = pending === undefined ? undefined : pending.beads[0]!.id
        // the wake is the earliest member's own cadence — a worker's
        // WORKER_POLL_MS .exit probe, a gate's interval — still capped
        // by the merge deadline: a member at mergeTimeoutMin must park
        // on the next tick, not an interval late (waitForGate's own
        // sleep was deadline-capped). A worker-pending member has NO
        // merge deadline — its lifetime is unbounded (bro-9lpn3).
        const gated = q.stack.filter((m) => m.worker === undefined)
        const wake = Math.min(
          ...q.stack.map((m) => m.nextPollAt ?? Number.POSITIVE_INFINITY),
          ...gated.map((m) => m.since + ctx.cfg.mergeTimeoutMin * 60_000)
        )
        await sleep(
          Math.min(ctx.intervalS * 1000, Math.max(0, wake - Date.now()))
        )
      }
    }
    // the queue is idle — no bead names a settled item in the audit
    ctx.bead = undefined
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

/** Run the queue behind the liveness contract (spec bro-snga4). A
 *  `for(;;)` queue cannot end mid-item — the two silent-death shapes
 *  it must not take: an await that never settles while every live
 *  handle is unref'd (the event loop drains, Node exits 0 mid-run),
 *  and a signal/stray-exit death before the audit.
 *
 *  The heartbeat is the prevention: a ref'd interval holds the event
 *  loop open while a run is live, so a stuck await surfaces as
 *  repeating `loop: alive — <stage>` lines instead of a vanished
 *  process. The death audit is the diagnosis of last resort — any
 *  exit with a run still open prints stage + bead and notes the bead,
 *  exactly what the silent deaths denied. Two shapes it must cover:
 *  'exit' (process.exit / natural end) — where writeSync(2) is the
 *  only write guaranteed to outlive the process — and signals, which
 *  never emit 'exit' and need handlers that audit then re-raise so
 *  the parent still sees the true signal death. */
async function guardedRun(ctx: Ctx): Promise<void> {
  let open = true
  const heartbeat = setInterval(() => {
    console.error(`loop: alive — ${ctx.stage}${ctx.bead ? ` on ${ctx.bead}` : ''}`)
  }, ctx.intervalS * 1000)
  const auditDeath = (why: string): void => {
    try {
      writeSync(
        2,
        `loop: process exiting mid-run — ${ctx.stage}` +
          `${ctx.bead ? ` on ${ctx.bead}` : ''} (${why})\n`
      )
    } catch { /* stderr may be gone — the note below still lands */ }
    if (ctx.bead !== undefined) {
      noteBead(
        ctx.tasks,
        ctx.bead,
        `loop: process exited mid-run — ${ctx.stage} (${why})`
      )
    }
  }
  const onExit = (code: number): void => {
    if (open) {
      auditDeath(`exit code ${code}`)
    }
  }
  const onSigint = (): void => {
    if (open) {
      auditDeath('signal SIGINT')
    }
    // restore the default disposition, then re-raise — the parent sees
    // a real signal death, not a clean exit code
    process.removeListener('SIGINT', onSigint)
    process.kill(process.pid, 'SIGINT')
  }
  const onSigterm = (): void => {
    if (open) {
      auditDeath('signal SIGTERM')
    }
    process.removeListener('SIGTERM', onSigterm)
    process.kill(process.pid, 'SIGTERM')
  }
  process.on('exit', onExit)
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  try {
    await runQueue(ctx)
  } finally {
    open = false
    clearInterval(heartbeat)
    process.removeListener('exit', onExit)
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
}
