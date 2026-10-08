/**
 * `bro agents` — the supervisor surface over the agents facade.
 * Spec: specs/sessions/bro-f4ot/spec.md.
 *
 *   bro agents status [<id|step>] [--json] [--connector <name>]
 *                       agent plane: every backend × its agents; an arg
 *                       prints one agent's detail. Degraded backends
 *                       warn — never a hard failure of the view.
 *   bro agents up [<step>] [--connector <name>] [--worktree <path>]
 *                  [--prompt-file <file>] [--beads-dir <dir>]
 *                       no arg: the resolved backend's supervisor up —
 *                       `supervisor:'none'` backends (native) are
 *                       self-sufficient, so it's a reported no-op.
 *                       with <step>: spawn the step's agent — a lost /
 *                       exited agent is RESPAWNED on the same agentId
 *                       (the claim rebinds), a live one is a SpawnError.
 *                       A `blocked` one (rate_limited/quota cause with
 *                       the block still held) is refused with the
 *                       provider's reset — `down` clears it.
 *                       This is the action behind fleet's
 *                       `lost — respawn?` decision surface.
 *                       Provider vocabulary (spec bro-5hx1.1):
 *                       --provider/--model/--profile/--auto-approve
 *                       resolve through fleet.profiles →
 *                       agents.<backend>.provider → the legacy
 *                       command template, pinning BRO_AGENT_PROVIDER/
 *                       BRO_AGENT_MODEL provenance onto the worker.
 *                       --class names a fleet.routing lane (spec
 *                       bro-1x7p) — the routed chain supplies the
 *                       provider when no explicit lane was picked.
 *   bro agents down [<id|step>] [--connector <name>]
 *                       no arg: supervisor down. With a target: stop
 *                       that one agent — idempotent, a gone agent is
 *                       the desired end state, exit 0.
 *
 * The respawn semantics live in the connector (spawn dedup correlates
 * the beads claim with the registry's liveness); this command only
 * resolves the SpawnSpec — worktree (recorded → <repo>--<step>
 * convention → --worktree), prompt (--prompt-file → the dead agent's
 * stored prompt → the bead's own text), and the pinned shared store.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import {
  bdAt,
  countSessionReservations,
  readAgentRegistry,
  removeAgentRegistryEntries,
  routeStepClass,
  sessionPlanes,
  sessionQuotaConfig,
  sessionSlotsDir,
  stepClassInfo,
  type AgentConnector,
  type AgentInfo,
  type AgentState,
} from '@broject/core'
import type { AcpSeam, FetchFn } from '@broject/providers'
import { beadsDir } from '@broject/convoy'
import {
  agentPromptPath,
  applyFleetRouter,
  eachAgentConnector,
  fleetCapOf,
  fleetOccupancyFor,
  fleetProfileOf,
  loadAgentEnv,
  resolveAgentConnector,
  resolveSpawnProvider,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { flag, positionals } from './args.ts'
import { mainWorktree, worktreePathFor } from './work.ts'

function usage(): never {
  console.error(`usage:
  bro agents status [<id|step>] [--json] [--connector <name>]
  bro agents up [<step>] [--connector <name>] [--worktree <path>] [--prompt-file <file>] [--beads-dir <dir>]
                [--provider <name>] [--model <m>] [--profile <name>] [--class <name>] [--auto-approve]
  bro agents down [<id|step>] [--connector <name>]
  bro agents prune [--connector <name>] [--older-than <N>d] [--json]
                reap terminal registry entries (exited/lost/stopped —
                'blocked' is respawn-able debt, never litter)`)
  process.exit(2)
}

// a function declaration, not a const arrow — tsc only treats calls to
// never-returning function declarations as terminating the control flow,
// so the die() call sites below narrow correctly
function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

/** One backend's plane — the connector plus what its list() saw. */
export interface AgentBackendPlane {
  conn: AgentConnector
  agents: AgentInfo[]
  degraded?: string
}

/** All backends' agent planes — a throwing factory or list() is
 *  degrade-equivalent (one `degraded` note), never a hard failure.
 *  Throws (not exits) on an unregistered --connector so `bro serve`
 *  can map it to a 400; command callers render it via die. */
export async function collectAgentBackends(
  dir: string,
  env: AgentConnectorEnv,
  connectorName?: string
): Promise<{ backends: AgentBackendPlane[] }> {
  const backends: AgentBackendPlane[] = []
  for (const conn of eachAgentConnector({ dir }, env, (name, err) => {
    // --connector scopes failures too — an unrelated backend's throwing
    // factory must not leak a degraded stub into the selected view
    if (connectorName === undefined || name === connectorName) {
      backends.push({
        conn: { name, capabilities: () => ({ supervisor: 'none' as const }) } as AgentConnector,
        agents: [],
        degraded: `factory: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  })) {
    if (connectorName !== undefined && conn.name !== connectorName) {
      continue
    }
    try {
      const res = await conn.list()
      backends.push({ conn, agents: res.agents, degraded: res.degraded })
    } catch (err) {
      backends.push({
        conn,
        agents: [],
        degraded: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (connectorName !== undefined && !backends.some((b) => b.conn.name === connectorName)) {
    throw new Error(`agent connector "${connectorName}" is not registered`)
  }
  return { backends }
}

/** Target → agent + its backend, matched on agentId OR molStep.
 *  `degraded` names backends whose list() failed — a miss next to a
 *  degraded backend is "couldn't verify", not "gone". */
export function findInBackends(
  backends: AgentBackendPlane[],
  target: string
): { hit?: { conn: AgentConnector; agent: AgentInfo }; degraded: string[] } {
  const degraded = backends
    .filter((b) => b.degraded !== undefined)
    .map((b) => `${b.conn.name}: ${b.degraded}`)
  for (const { conn, agents } of backends) {
    const hit = agents.find((a) => a.id === target || a.molStep === target)
    if (hit) {
      return { hit: { conn, agent: hit }, degraded }
    }
  }
  return { degraded }
}

export async function findAgent(
  dir: string,
  env: AgentConnectorEnv,
  target: string,
  connectorName?: string
): Promise<{ hit?: { conn: AgentConnector; agent: AgentInfo }; degraded: string[] }> {
  const { backends } = await collectAgentBackends(dir, env, connectorName)
  return findInBackends(backends, target)
}

// --- status -------------------------------------------------------------------

/** Fleet slot accounting the table and --json both surface — the cap
 *  (0 = uncapped) plus the registry-based, fail-closed occupancy the
 *  admission check enforces. Counted across every backend: a
 *  --connector-scoped view still shows the fleet numerator, and an
 *  unverifiable entry keeps its slot, so a degraded backend can't make
 *  the line under-report what a spawn would count. */
export interface FleetOccupancy {
  occupied: number
  maxConcurrent: number
}

function occupancyOf(dir: string, env: AgentConnectorEnv): FleetOccupancy {
  return {
    occupied: fleetOccupancyFor(dir, env),
    maxConcurrent: fleetCapOf(env),
  }
}

/** Session-kind quotas the status surfaces — each registered plane
 *  counts its own live sessions host-wide (the plane owns how), plus
 *  admitted reservations whose session mark hasn't landed yet. A plane
 *  whose `agents.<kind>` lane is unconfigured shows nothing — the
 *  scans don't run. A present-but-broken cap shows `invalid`; an
 *  unverifiable count shows `live: -1` rather than pretending zero. */
export interface SessionQuotaView {
  kind: string
  live: number
  max: number
  invalid?: boolean
}

function sessionQuotaViewsOf(env: AgentConnectorEnv): SessionQuotaView[] {
  const out: SessionQuotaView[] = []
  for (const plane of sessionPlanes()) {
    const q = sessionQuotaConfig(env.agents, plane.kind)
    if (q === undefined) {
      continue
    }
    if (q.invalid === true) {
      out.push({ kind: plane.kind, live: -1, max: 0, invalid: true })
      continue
    }
    let live = -1
    try {
      live =
        plane.countLive(env.agents[plane.kind] ?? {}) +
        countSessionReservations(sessionSlotsDir(plane.kind, q.reservationsDir))
    } catch {
      // unverifiable — the -1 renders as `?`, a scan failure must not
      // take down the status view
    }
    out.push({ kind: plane.kind, live, max: q.maxSessions })
  }
  return out
}

/** `fleet: 2/3 slots occupied` — `uncapped` instead of the ceiling when
 *  the config disables it. */
export function occupancyLine(o: FleetOccupancy): string {
  const cap = o.maxConcurrent > 0 ? `/${o.maxConcurrent}` : ''
  return `fleet: ${o.occupied}${cap} agent slots occupied${o.maxConcurrent > 0 ? '' : ' (uncapped)'}`
}

function printStatusTable(
  backends: AgentBackendPlane[],
  occupancy: FleetOccupancy,
  sessions: SessionQuotaView[]
): void {
  console.log(occupancyLine(occupancy))
  for (const s of sessions) {
    if (s.invalid === true) {
      console.log(`${s.kind} sessions: invalid agents.${s.kind}.maxSessions — must be a positive integer`)
    } else {
      console.log(`${s.kind} sessions: ${s.live >= 0 ? `${s.live}/${s.max}` : `?/${s.max}`} live`)
    }
  }
  const cols = ['backend', 'supervisor', 'agent', 'step', 'state', 'cause', 'pid', 'worktree']
  const rows = backends.flatMap(({ conn, agents }) => {
    const sup = conn.capabilities().supervisor
    if (agents.length === 0) {
      return [[conn.name, sup, '—', '—', '—', '—', '—', '—']]
    }
    return agents.map((a) => [
      conn.name,
      sup,
      a.id,
      a.molStep,
      a.state,
      a.cause === undefined ? '—' : a.cause,
      a.pid === undefined ? '—' : String(a.pid),
      a.worktree === undefined ? '—' : basename(a.worktree),
    ])
  })
  const widths = cols.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd()
  console.log(line(cols))
  for (const r of rows) {
    console.log(line(r))
  }
  for (const { conn, degraded } of backends) {
    if (degraded) {
      console.error(`warning: backend degraded — ${conn.name}: ${degraded}`)
    }
  }
}

/** Targeted `status <id|step>`: detail on a hit; a miss dies naming the
 *  checked backends. Degraded backends warn on the targeted read too — a
 *  found agent doesn't mean the fleet view is complete (stderr, so
 *  --json stays parseable). */
function statusDetail(
  backends: AgentBackendPlane[],
  target: string,
  json: boolean
): void {
  const { hit, degraded } = findInBackends(backends, target)
  if (!hit) {
    const blind = degraded.length > 0 ? ` (degraded: ${degraded.join('; ')})` : ''
    die(
      `no agent "${target}"${blind} — checked ${backends.map((b) => b.conn.name).join(', ') || 'no backends'}`
    )
  }
  for (const d of degraded) {
    console.error(`warning: backend degraded — ${d}`)
  }
  const a = hit.agent
  if (json) {
    console.log(JSON.stringify(a, null, 2))
    return
  }
  console.log(`agent     ${a.id}`)
  console.log(`backend   ${a.backend} (supervisor: ${hit.conn.capabilities().supervisor})`)
  console.log(`step      ${a.molStep}`)
  console.log(`state     ${a.state}`)
  if (a.provider !== undefined) console.log(`provider  ${a.provider}`)
  if (a.model !== undefined) console.log(`model     ${a.model}`)
  if (a.class !== undefined) console.log(`class     ${a.class}`)
  if (a.cause !== undefined) console.log(`cause     ${a.cause}`)
  if (a.resetAt !== undefined) console.log(`resetAt   ${a.resetAt}`)
  if (a.pid !== undefined) console.log(`pid       ${a.pid}`)
  if (a.worktree !== undefined) console.log(`worktree  ${a.worktree}`)
  if (a.log !== undefined) console.log(`log       ${a.log}`)
}

async function cmdStatus(dir: string, env: AgentConnectorEnv, argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--connector']))
  if (pos.length > 1) {
    usage()
  }
  const target = pos[0]
  const json = argv.includes('--json')
  const connectorName = flag(argv, '--connector')
  const { backends } = await collectAgentBackends(dir, env, connectorName).catch((err: unknown) =>
    die(err instanceof Error ? err.message : String(err))
  )

  if (target !== undefined) {
    // the fleet read already collected — search it, don't list() twice
    statusDetail(backends, target, json)
    return
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          occupancy: occupancyOf(dir, env),
          sessions: sessionQuotaViewsOf(env),
          backends: backends.map(({ conn, agents, degraded }) => ({
            name: conn.name,
            capabilities: conn.capabilities(),
            agents,
            ...(degraded !== undefined ? { degraded } : {}),
          })),
        },
        null,
        2
      )
    )
    return
  }
  printStatusTable(backends, occupancyOf(dir, env), sessionQuotaViewsOf(env))
}

// --- up / down ------------------------------------------------------------------

/** Supervisor lifecycle on the resolved backend. `none` backends are
 *  self-sufficient — the verb is a reported no-op, not an error. A
 *  supervised backend without the method is a real gap: name it. */
async function supervisorVerb(conn: AgentConnector, verb: 'up' | 'down'): Promise<void> {
  const sup = conn.capabilities().supervisor
  if (sup === 'none') {
    console.log(`${conn.name}: supervisor 'none' — detached agents are self-sufficient, nothing to ${verb}`)
    return
  }
  const fn = verb === 'up' ? conn.up : conn.down
  if (fn === undefined) {
    die(`${conn.name} declares supervisor '${sup}' but implements no ${verb}() — connector gap`)
  }
  await fn!.call(conn)
  console.log(`${conn.name}: supervisor ${verb}`)
}

/** The step's worktree: explicit --worktree → the registry's recorded
 *  path (a respawn reuses the dead agent's checkout) → the
 *  `<repo>--<step>` sibling convention. Missing = the caller never
 *  entered one — the error names the command, not a guess. Throws so
 *  `bro serve` can map it to a 4xx; the command layer renders via die. */
function resolveWorktree(
  dir: string,
  molStep: string,
  explicit: string | undefined,
  backend: string
): string {
  if (explicit !== undefined) {
    return explicit
  }
  // recorded state is the resolving backend's — `--connector x` must not
  // inherit backend-y's worktree/prompt for the same step
  const entry = readAgentRegistry(dir)[molStep]
  const recorded = entry?.backend === backend ? entry.worktree : undefined
  if (typeof recorded === 'string' && existsSync(recorded)) {
    return recorded
  }
  const conventional = worktreePathFor(mainWorktree().path, molStep)
  if (existsSync(conventional)) {
    return conventional
  }
  throw new SpawnInputError(
    `no worktree for ${molStep} — run \`bro work enter ${molStep}\` first ` +
      `(or pass --worktree <path>)`
  )
}

/** The spawn prompt: --prompt-file → the previous run's stored prompt
 *  (respawn keeps a custom-prompt agent's real instructions — the
 *  agentId outlives the process, so its prompt file does too) → the
 *  bead's own text, the convoy formula's rendered instructions. Throws —
 *  the command layer renders via die, the serve host maps to 4xx. */
function resolvePrompt(
  dir: string,
  beads: string,
  molStep: string,
  promptFile: string | undefined,
  backend: string
): string {
  if (promptFile !== undefined) {
    if (!existsSync(promptFile)) {
      throw new SpawnInputError(`prompt file ${promptFile} does not exist`)
    }
    return readFileSync(promptFile, 'utf8')
  }
  const entry = readAgentRegistry(dir)[molStep]
  const agentId = entry?.backend === backend ? entry.agentId : undefined
  const stored = agentId === undefined ? null : agentPromptPath(dir, agentId)
  if (stored !== null && existsSync(stored)) {
    return readFileSync(stored, 'utf8')
  }
  const r = bdAt(beads, ['show', molStep, '--json'])
  if (r.code !== 0) {
    throw new SpawnInputError(
      `cannot render a prompt — bead ${molStep} unreadable (${r.err}); pass --prompt-file`
    )
  }
  let row: { title?: string; description?: string } | undefined
  try {
    row = (JSON.parse(r.out) as { title?: string; description?: string }[])[0]
  } catch {
    // exit-0 garbage (non-JSON diagnostics, truncated output) falls
    // through to the same throw as an empty row
    row = undefined
  }
  const prompt = `# ${row?.title ?? molStep}\n\n${row?.description ?? ''}`.trim()
  if (row === undefined || prompt === `# ${molStep}`) {
    throw new SpawnInputError(
      `bead ${molStep} has no title/description to prompt with — pass --prompt-file`
    )
  }
  return prompt
}

/** Bad spawn input (missing worktree/prompt file, exclusive fields) —
 *  400 territory, distinct from SpawnError's conflict/refusal (409). */
export class SpawnInputError extends Error {
  override name = 'SpawnInputError'
}

/** A spawn request — `bro agents up <step>` flags and `bro serve`'s
 *  POST body share this shape. `prompt` is literal text (serve);
 *  `promptFile` is a path (both). The provider vocabulary (spec
 *  bro-5hx1.1) resolves in one order everywhere: these explicit
 *  fields → the named fleet.profiles preset (piecewise — an explicit
 *  provider/model beats the preset's) → agents.<backend>.provider →
 *  the legacy command template. */
export interface StepSpawnRequest {
  molStep: string
  connector?: string
  worktree?: string
  promptFile?: string
  prompt?: string
  beadsDir?: string
  /** Extra env for the spawned process — identity pins (BEADS_DIR,
   *  BRO_BEAD_ID, BRO_AGENT_ID, BRO_AGENT_PROVIDER/MODEL) still win,
   *  so a caller can't redirect the claim store, re-badge the worker,
   *  or forge which provider ran it. */
  env?: Record<string, string>
  /** A `providers.<name>` entry — the spawn must honor it (spawn-
   *  surface required) or refuse. */
  provider?: string
  /** Model override — beats the profile's and the entry's pin. */
  model?: string
  /** A `fleet.profiles.<name>` preset — expands provider/model/backend
   *  piecewise; `backend` redirects connector resolution only when no
   *  explicit connector was named. */
  profile?: string
  /** acp permission policy override — the driver's
   *  session/request_permission allow answer. */
  autoApprove?: boolean
  /** The routing lane — wins over the step bead's `class:<name>` label
   *  (spec bro-1x7p). Read only when `fleet.routing` is declared; a
   *  resolved class with no routing entry is a config error. */
  class?: string
}

/** The spawn behind `up <step>` and POST /api/v1/agents — resolve the
 *  connector, provider, worktree, prompt, and shared store, then
 *  conn.spawn. Throws on every failure (SpawnError on conflict/
 *  refusal) — callers render; nothing exits here. Validation before
 *  the async resolution chain throws SYNCHRONOUSLY (callers/tests
 *  rely on it); provider errors arrive as a rejected promise. */
export function spawnStepAgent(
  dir: string,
  env: AgentConnectorEnv,
  req: StepSpawnRequest,
  /** Test seams — the fleet router's provider call takes a scripted
   *  transport or an in-process acp peer. */
  opts: { fetch?: FetchFn; acp?: AcpSeam } = {}
): Promise<AgentInfo> {
  if (req.prompt !== undefined && req.promptFile !== undefined) {
    throw new SpawnInputError('prompt and promptFile are mutually exclusive')
  }
  // '' would slip past `??` below and spawn an agent with no instructions
  if (req.prompt?.trim() === '') {
    throw new SpawnInputError('prompt must not be empty')
  }
  // --profile expands piecewise BEFORE connector resolution — the
  // preset's `backend` picks the connector only when --connector was
  // not named, and its provider/model lose to explicit fields
  const profile = req.profile === undefined ? undefined : fleetProfileOf(env, req.profile)
  const conn = resolveAgentConnector(
    { dir },
    { connector: req.connector ?? profile?.backend },
    env
  )
  const beads = req.beadsDir ?? beadsDir()
  const repoRoot = resolveWorktree(dir, req.molStep, req.worktree, conn.name)
  if (!existsSync(repoRoot)) {
    throw new SpawnInputError(`worktree ${repoRoot} does not exist`)
  }
  const prompt = req.prompt ?? resolvePrompt(dir, beads, req.molStep, req.promptFile, conn.name)
  // class resolution (spec bro-1x7p): runs whenever fleet.routing is
  // declared — the lane pins provenance regardless of who named the
  // provider. The routed chain head supplies the provider only when no
  // explicit lane was picked (--provider/--profile outrank the table).
  // M7 fleet.router: fires only on an UNCLASSED step (no --class, no
  // class: label) with a table declared and the router armed — its one
  // `bd show` carries both the label check and the title/description
  // the judge sees.
  const info =
    env.fleet?.router !== undefined &&
    env.fleet.router.mode !== 'off' &&
    req.class === undefined &&
    env.fleet.routing !== undefined &&
    Object.keys(env.fleet.routing).length > 0
      ? stepClassInfo(beads, req.molStep)
      : undefined
  const routed = routeStepClass(env.fleet, env.providers ?? {}, beads, req.molStep, req.class, info)
  return applyFleetRouter(dir, env, req.molStep, info, routed, opts).then((route) => {
    const provider = req.provider ?? profile?.provider ?? route?.provider
    return resolveSpawnProvider(
      env,
      conn.name,
      {
        provider,
        // the routed model pin pairs with the routed provider — an
        // explicit provider override must not inherit chain[0]'s model
        model:
          req.model ??
          profile?.model ??
          (provider !== undefined && provider === route?.provider ? route.model : undefined),
        autoApprove: req.autoApprove ?? profile?.autoApprove,
      },
      req.provider !== undefined ? 'flag' : profile === undefined ? 'backend' : 'profile'
    ).then((pick) =>
      conn.spawn({
        molStep: req.molStep,
        repoRoot,
        beadsDir: beads,
        prompt,
        env: req.env,
        provider: pick.provider,
        model: pick.model,
        class: route?.class,
        worker: pick.worker,
      })
    )
  })
}

/** The stop behind `down <target>` and DELETE /api/v1/agents/<ref>. */
export interface StopOutcome {
  found: boolean
  degraded: string[]
  /** live state at stop time — can differ from the list() snapshot */
  agent?: AgentInfo
  backend?: string
  /** true when stop() ran — always true on a found agent; the connector
   *  binds to the CURRENT registry entry, so the call also stops a
   *  respawn that landed between our status read and here */
  stopped: boolean
  /** the agent already read terminal when we looked — stop() still ran
   *  (idempotent), the flag just says there was nothing live to kill */
  terminal?: boolean
  /** the agent read `blocked` — stop() still ran and lifted the block,
   *  so callers confirm the manual clear instead of reporting
   *  "nothing to stop" */
  cleared?: boolean
  /** pid changed between list() and status() — a respawn raced us */
  respawned?: { from?: number; to?: number }
}

/** Stop one agent by agentId or molStep. Idempotent by contract — a
 *  gone agent is the desired end state (`found:false`), not an error;
 *  `degraded` tells the caller the miss is unverified, not confirmed.
 *  stop() is called unconditionally on a hit: skipping it on a terminal
 *  read would leave a racing respawn running while the caller believes
 *  the step is dead. */
export async function stopAgent(
  dir: string,
  env: AgentConnectorEnv,
  target: string,
  connectorName?: string
): Promise<StopOutcome> {
  const { hit, degraded } = await findAgent(dir, env, target, connectorName)
  if (!hit) {
    return { found: false, degraded, stopped: false }
  }
  // bind the stop to what the backend reports NOW, not the list()
  // snapshot — a respawn between the two reuses the agentId with a new
  // pid, and a dead agent is already the desired end state
  let current = hit.agent
  try {
    current = await hit.conn.status(hit.agent.id)
  } catch {
    // the read failed — stop() still binds to the observed id
  }
  const terminal =
    current.state === 'exited' ||
    current.state === 'stopped' ||
    current.state === 'lost' ||
    current.state === 'blocked'
  const respawned =
    current.pid !== hit.agent.pid ? { from: hit.agent.pid, to: current.pid } : undefined
  await hit.conn.stop(hit.agent.id)
  return {
    found: true,
    degraded,
    agent: current,
    backend: hit.conn.name,
    stopped: true,
    terminal,
    cleared: current.state === 'blocked' ? true : undefined,
    respawned,
  }
}

async function cmdUp(dir: string, env: AgentConnectorEnv, argv: string[]): Promise<void> {
  const pos = positionals(
    argv,
    new Set([
      '--connector',
      '--worktree',
      '--prompt-file',
      '--beads-dir',
      '--provider',
      '--model',
      '--profile',
      '--class',
    ])
  )
  const connectorName = flag(argv, '--connector')
  if (pos.length > 1) {
    usage()
  }
  const molStep = pos[0]
  if (molStep === undefined) {
    // spawn-only flags have no step to land on — 'up --provider x'
    // riding the supervisor branch would read as a spawn that happened
    const stray = ['--worktree', '--prompt-file', '--beads-dir', '--provider', '--model', '--profile', '--class', '--auto-approve'].find(
      (f) => argv.includes(f) || argv.some((a) => a.startsWith(`${f}=`))
    )
    if (stray !== undefined) {
      die(`${stray} requires a molStep`)
    }
    await supervisorVerb(resolveAgentConnector({ dir }, { connector: connectorName }, env), 'up')
    return
  }
  let info: AgentInfo
  try {
    info = await spawnStepAgent(dir, env, {
      molStep,
      connector: connectorName,
      worktree: flag(argv, '--worktree'),
      promptFile: flag(argv, '--prompt-file'),
      beadsDir: flag(argv, '--beads-dir'),
      provider: flag(argv, '--provider'),
      model: flag(argv, '--model'),
      profile: flag(argv, '--profile'),
      class: flag(argv, '--class'),
      autoApprove: argv.includes('--auto-approve') ? true : undefined,
    })
  } catch (err) {
    die(err instanceof Error ? err.message : String(err))
  }
  const pid = info.pid === undefined ? '' : ` pid ${info.pid}`
  console.log(`agent ${info.id} ${info.state} for ${molStep} (${info.backend}${pid})`)
  if (info.provider !== undefined) {
    console.log(`  provider: ${info.provider}${info.model === undefined ? '' : ` · model ${info.model}`}`)
  }
  if (info.log !== undefined) {
    console.log(`  log: ${info.log}`)
  }
  if (info.worktree !== undefined) {
    console.log(`  worktree: ${info.worktree}`)
  }
}

async function cmdDown(dir: string, env: AgentConnectorEnv, argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--connector']))
  const connectorName = flag(argv, '--connector')
  if (pos.length > 1) {
    usage()
  }
  const target = pos[0]
  if (target === undefined) {
    await supervisorVerb(resolveAgentConnector({ dir }, { connector: connectorName }, env), 'down')
    return
  }
  const outcome = await stopAgent(dir, env, target, connectorName).catch((err: unknown) =>
    die(err instanceof Error ? err.message : String(err))
  )
  if (!outcome.found) {
    // a degraded read can't confirm "gone" — report unverified, don't
    // claim the desired end state was reached
    if (outcome.degraded.length > 0) {
      die(
        `down: no agent "${target}" found — backend(s) degraded: ${outcome.degraded.join('; ')}`
      )
    }
    // stop() is idempotent — a gone agent is the desired end state
    console.log(`down: no agent "${target}" — nothing to stop`)
    return
  }
  const agent = outcome.agent!
  if (outcome.terminal) {
    // a blocked entry is terminal BUT the stop was the manual clear —
    // confirm that, don't report "nothing to stop"
    console.log(
      outcome.cleared === true
        ? `down: ${agent.id} was blocked (${agent.cause ?? '?'}) — cleared`
        : `down: ${agent.id} is ${agent.state} — nothing to stop`
    )
    return
  }
  if (outcome.respawned) {
    const fmt = (p: number | undefined) => (p === undefined ? 'unknown' : String(p))
    console.error(
      `note: ${agent.id} respawned since lookup (pid ${fmt(outcome.respawned.from)} → ${fmt(outcome.respawned.to)}) — stopping current instance`
    )
  }
  console.log(`stopped ${agent.id} (${agent.molStep}, ${outcome.backend})`)
}

/** States prune reaps — 'blocked' stays: a wall-parked worker is
 *  respawn-able debt, not litter. */
const REAP_STATES = new Set<AgentState>(['exited', 'lost', 'stopped'])

/** Which collected entries prune may reap. `expected` pins the observed
 *  identity per molStep — removeAgentRegistryEntries re-checks it under
 *  the lock so a respawn between snapshot and removal can't be reaped
 *  as the terminal agent it replaced. Age counts from spawnedAt — the
 *  registry records no exit timestamp; an entry with none can't
 *  age-verify and stays. */
function selectReapable(
  backends: Array<{ conn: { name: string }; agents: AgentInfo[]; degraded?: string }>,
  cutoff: number | undefined
): {
  reapable: string[]
  skipped: string[]
  expected: Map<string, { agentId?: string; spawnedAt?: string; pid?: number }>
} {
  const reapable: string[] = []
  const skipped: string[] = []
  const expected = new Map<string, { agentId: string; spawnedAt?: string; pid?: number }>()
  for (const b of backends) {
    // a degraded backend's states are unproven — its entries stay
    if (b.degraded !== undefined) {
      skipped.push(`${b.conn.name}: ${b.degraded}`)
      continue
    }
    for (const a of b.agents) {
      const t = a.spawnedAt === undefined ? Number.NaN : Date.parse(a.spawnedAt)
      if (!REAP_STATES.has(a.state) || (cutoff !== undefined && (Number.isNaN(t) || t >= cutoff))) {
        continue
      }
      reapable.push(a.molStep)
      expected.set(a.molStep, { agentId: a.id, spawnedAt: a.spawnedAt, pid: a.pid })
    }
  }
  return { reapable, skipped, expected }
}

async function cmdPrune(dir: string, env: AgentConnectorEnv, argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--connector', '--older-than']))
  const connectorName = flag(argv, '--connector')
  const olderThan = flag(argv, '--older-than')
  const json = argv.includes('--json')
  if (pos.length > 0) {
    usage()
  }
  let cutoff: number | undefined
  if (olderThan !== undefined) {
    const m = /^(\d+)d$/.exec(olderThan)
    if (m === null) {
      die(`--older-than takes <N>d days, got "${olderThan}"`)
    }
    cutoff = Date.now() - Number(m[1]) * 86_400_000
  }
  const { backends } = await collectAgentBackends(dir, env, connectorName)
  const { reapable, skipped, expected } = selectReapable(backends, cutoff)
  const removed =
    reapable.length === 0 ? [] : removeAgentRegistryEntries(dir, reapable, expected)
  if (json) {
    console.log(JSON.stringify({ pruned: removed, skippedDegraded: skipped }, null, 2))
    return
  }
  console.log(
    removed.length === 0
      ? 'prune: nothing terminal to reap'
      : `prune: reaped ${removed.length} — ${removed.join(', ')}`
  )
  for (const s of skipped) {
    console.error(`note: ${s} — entries not verified, left in place`)
  }
}

export async function runAgentsCommand(argv: string[]): Promise<void> {
  const dir = process.cwd()
  const env = loadAgentEnv(dir)
  const sub = argv[0]
  switch (sub) {
    case 'status':
      await cmdStatus(dir, env, argv.slice(1))
      return
    case 'up':
      await cmdUp(dir, env, argv.slice(1))
      return
    case 'down':
      await cmdDown(dir, env, argv.slice(1))
      return
    case 'prune':
      await cmdPrune(dir, env, argv.slice(1))
      return
    case undefined:
    case '--help':
    case '-h':
      usage()
      return
    default:
      console.error(`error: unknown agents subcommand "${sub}"`)
      usage()
  }
}

