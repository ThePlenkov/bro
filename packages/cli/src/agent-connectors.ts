/**
 * Agent connector registry + the native backend.
 *
 * Spec: specs/sessions/bro-f4ot/spec.md. Resolution mirrors the facade
 * seam — explicit --connector → `connectors.agents` in bro.config.json →
 * matchRemote/matchDir → registry order (`native` is the designed
 * default; it registers first).
 *
 * The native backend is detached `sh -c` spawn: nohup-equivalent (own
 * process group, parent-unref'd, output to a log file), liveness via
 * kill(pid, 0) — the pgrep+kill -0 folklore as code — plus a `.work`
 * marker in the hooks state dir so parallel-session detection sees the
 * agent, and molStep claims pinned into the shared beads store.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  AgentNotFound,
  agentEntryBlocked,
  agentsSection,
  bdActor,
  claimStep,
  classifyExitCause,
  commandCliName,
  countDevinReservations,
  countDevinSessions,
  DEFAULT_CONFIG,
  devinSessionQuota,
  releaseDevinSession,
  reserveDevinSession,
  gitTry,
  isAgentCause,
  loadConfig,
  mintAgentId,
  patchAgentRegistry,
  pidAlive,
  probeStep,
  procStat,
  rebindStep,
  requireProviderSurface,
  SpawnError,
  stepParent,
  ProviderSurfaceError,
  readAgentRegistry,
  UnknownProviderError,
  withAgentRegistryLock,
  writeAgentRegistry,
  type AgentCause,
  type AgentConnector,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
  type ConnectorCtx,
  type FleetProfile,
  type ListResult,
  type ProviderEntry,
  type SpawnSpec,
  type SpawnWorker,
} from '@broject/core'
import { expandAgentCmd, loopSection, type LoopConfig } from '@broject/loop'

/** Everything a factory needs: the repo ctx + the resolved config
 *  (agents.<backend> knobs, connectors.agents pick, loop.agent fallback). */
export interface AgentConnectorEnv {
  agents: Record<string, Record<string, unknown>>
  /** Facade → connector precedence — `connectors.agents` selects here. */
  connectors: Record<string, string>
  loop?: LoopConfig
  /** Fleet section — `maxConcurrent` is the cap (fleetCapOf defaults it
   *  on hand-built envs); `profiles` holds the named spawn presets
   *  `--profile` resolves (spec bro-5hx1.1). */
  fleet?: { maxConcurrent: number; profiles?: Record<string, FleetProfile> }
  /** The named provider registry — spawn resolution reads entries by
   *  name (`agents.<backend>.provider`, `--provider`, profiles). Absent
   *  means provider behavior is off, never defaulted to a vendor. */
  providers?: Record<string, ProviderEntry>
}

export type AgentConnectorFactory = (
  ctx: ConnectorCtx,
  env: AgentConnectorEnv
) => AgentConnector

// --- registry ------------------------------------------------------------------

/** Probe matchers live on the registry entry, not the instance — a
 *  probe must not construct a connector it will never pick (bro-srhs). */
interface AgentConnectorMatchers {
  matchDir?: (dir: string, env: AgentConnectorEnv) => boolean
  matchRemote?: (url: string, env: AgentConnectorEnv) => boolean
}

const agentRegistry: ({
  name: string
  make: AgentConnectorFactory
} & AgentConnectorMatchers)[] = []

/** External backends (gascity, tmux, …) register here. Duplicate names
 *  are skipped — a plugin cannot shadow a built-in backend. Returns a
 *  disposer bound to THIS registration (undefined when skipped): fixture
 *  cleanup removes the entry it added, never whatever holds the name.
 *  `matchers` are factory-level probes — resolution runs them without
 *  constructing the connector. */
export function registerAgentConnector(
  name: string,
  make: AgentConnectorFactory,
  matchers: AgentConnectorMatchers = {}
): (() => void) | undefined {
  if (agentRegistry.some((x) => x.name === name)) {
    console.error(`warning: agent connector "${name}" already registered — skipped`)
    return undefined
  }
  const entry = { name, make, ...matchers }
  agentRegistry.push(entry)
  return () => {
    const i = agentRegistry.indexOf(entry)
    if (i >= 0) {
      agentRegistry.splice(i, 1)
    }
  }
}

/** Backends registered at module load — a fixture unregistering one of
 *  these (a misnamed cleanup, or a name whose register was skipped as a
 *  duplicate) would silently change which factory the name resolves to
 *  for the rest of the process. */
const BUILTIN_AGENT_BACKENDS = new Set(['native', 'tmux', 'gascity'])

/** Deliberate name-based removal — fixtures prefer the disposer
 *  registerAgentConnector returns, which can only drop the entry it
 *  added. Built-ins refuse with a warning (same visibility as
 *  registerAgentConnector's duplicate warning); unknown names are a
 *  no-op. */
export function unregisterAgentConnector(name: string): void {
  if (BUILTIN_AGENT_BACKENDS.has(name)) {
    console.error(`warning: agent connector "${name}" is built-in — unregister skipped`)
    return
  }
  const i = agentRegistry.findIndex((x) => x.name === name)
  if (i >= 0) {
    agentRegistry.splice(i, 1)
  }
}

export function agentConnectorNames(): string[] {
  return agentRegistry.map((x) => x.name)
}

/** Config sections the agents facade reads — the caller may already have
 *  a resolved config; this is the load path when it doesn't. */
export function loadAgentEnv(dir: string): AgentConnectorEnv {
  const cfg = loadConfig(dir, {
    agents: agentsSection,
    loop: loopSection,
  }) as {
    agents?: Record<string, Record<string, unknown>>
    connectors?: Record<string, string>
    loop?: LoopConfig
    // core sections — applySections always resolves them on a
    // successful load; the `?`s cover a loadConfig shape that predates
    // them and a section whose schema itself dropped
    fleet?: { maxConcurrent: number; profiles?: Record<string, FleetProfile> }
    providers?: Record<string, ProviderEntry>
  }
  return {
    agents: cfg.agents ?? {},
    connectors: cfg.connectors ?? {},
    loop: cfg.loop,
    fleet: cfg.fleet,
    providers: cfg.providers,
  }
}

/** The fleet ceiling a spawn must fit under — `fleet.maxConcurrent`
 *  from the resolved config, the DEFAULT_CONFIG value when the env was
 *  hand-built (tests, embedded callers). 0 disables the cap. */
export function fleetCapOf(env: AgentConnectorEnv): number {
  return env.fleet?.maxConcurrent ?? DEFAULT_CONFIG.fleet.maxConcurrent
}

// --- provider resolution (spec bro-5hx1.1) -------------------------------------
//
// One total order, resolved BEFORE conn.spawn — the backend receives an
// already-resolved spec and never learns what a provider is:
//   explicit spawn fields (--provider/--model/--profile/… or the
//     StepSpawnRequest fields) → fleet.profiles.<name> preset
//     (--provider/--model beat the preset's values piecewise, so the
//     caller merges before we run) → agents.<backend>.provider → the
//     legacy command template (agents.<backend>.command → loop.agent).
// No provider named anywhere = today's behavior, unchanged — bro never
// picks a vendor the user didn't name.

/** `fleet.profiles.<name>` lookup — a named-but-missing preset is a
 *  spawn error naming the key, never a silent no-op (ribc.1's
 *  no-silent-fallthrough rule). */
export function fleetProfileOf(env: AgentConnectorEnv, name: string): FleetProfile {
  const profiles = env.fleet?.profiles
  // hasOwn pins the lookup to configured keys — 'constructor' must not
  // resolve to an inherited member and skip the missing-profile error
  const profile =
    profiles !== undefined && Object.hasOwn(profiles, name) ? profiles[name] : undefined
  if (profile === undefined) {
    throw new SpawnError(
      `fleet.profiles.${name} is not configured — name a configured profile`,
      'input'
    )
  }
  return profile
}

/** `agents.<backend>.provider` — the backend's default provider. */
function backendProvider(env: AgentConnectorEnv, backend: string): string | undefined {
  const v = env.agents[backend]?.provider
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** The `bro` invocation for a provider driver — PATH-first, then the
 *  `npx -y @broject/bro@0` fallback, the same contract the hooks shim
 *  pins at install time (spec bro-5hx1.1). A spawned env that strips
 *  both is a startup error the driver itself reports. */
export function broSpawnArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = process.platform === 'win32' ? ['bro.cmd', 'bro.exe', 'bro'] : ['bro']
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') {
      continue
    }
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK)
        return ['bro']
      } catch {
        // not in this dir — keep walking PATH
      }
    }
  }
  return ['npx', '-y', '@broject/bro@0']
}

/** What resolution computed for a spawn — provenance labels plus the
 *  worker payload the backend runs. Opaque labels stay vendor-blind;
 *  `worker` is the only backend-visible piece. */
export interface SpawnProviderPick {
  provider?: string
  model?: string
  worker?: SpawnWorker
}

/** Resolve the spawn's provider into a worker payload. `sel` carries
 *  the explicit fields already merged over the profile's piecewise;
 *  `backend` is the RESOLVED connector name (a profile's `backend`
 *  redirect already applied) so `agents.<backend>.provider` binds the
 *  backend that will actually run it. Errors name the key —
 *  UnknownProviderError becomes 'input' when a flag named it, 'config'
 *  when config (profile/backend knob) did; a kind with no spawn
 *  surface is always 'config'. */
export async function resolveSpawnProvider(
  env: AgentConnectorEnv,
  backend: string,
  sel: { provider?: string; model?: string; autoApprove?: boolean },
  /** Where the provider name came from — a flag's typo is caller
   *  'input'; a name in config (profile preset, backend knob) is
   *  'config'. Used only for the SpawnError kind. */
  namedBy: 'flag' | 'profile' | 'backend' = 'backend'
): Promise<SpawnProviderPick> {
  const providerName = sel.provider ?? backendProvider(env, backend)
  const source = sel.provider === undefined ? 'backend' : namedBy
  if (providerName === undefined) {
    // legacy template path — an explicit model still pins provenance
    // env/registry labels without changing what runs
    return { model: sel.model }
  }
  let entry: ProviderEntry
  try {
    entry = requireProviderSurface(env.providers ?? {}, providerName, 'spawn')
  } catch (err) {
    if (err instanceof UnknownProviderError || err instanceof ProviderSurfaceError) {
      // a surface mismatch is the ENTRY's capability gap — always
      // config; an unknown name is caller input only when a flag wrote it
      const kind =
        err instanceof ProviderSurfaceError || source !== 'flag' ? 'config' : 'input'
      throw new SpawnError(err.message, kind)
    }
    throw err
  }
  const model = sel.model ?? entry.model
  switch (entry.type) {
    case 'cli':
      // the entry's command substitutes for the backend's template —
      // {promptFile} mechanics apply verbatim
      return { provider: providerName, model, worker: { kind: 'template', command: entry.command } }
    case 'acp': {
      // the providers package owns the argv render — a lazy import keeps
      // a providers-less checkout (and every non-acp spawn) from paying
      // for the SDK
      const { acpWorkerArgv } = await import('@broject/providers')
      const autoApprove = sel.autoApprove ?? entry.autoApprove
      return {
        provider: providerName,
        model,
        worker: {
          kind: 'argv',
          argv: acpWorkerArgv(broSpawnArgv(), entry, { model, autoApprove }),
          cliName: commandCliName(entry.command),
        },
      }
    }
    default:
      // spawn:false kinds already threw in requireProviderSurface — a
      // registry-table change must still never reach here silently
      throw new SpawnError(
        `providers.${providerName} (type '${entry.type}') has no spawn surface`,
        'config'
      )
  }
}

/** Pick the serving backend: explicit --connector → connectors.agents →
 *  matchRemote/matchDir → registry order. Provisional factories are
 *  cheap — a connector that must not be picked stays unconstructed
 *  until chosen. */
export function resolveAgentConnector(
  ctx: ConnectorCtx,
  opts: { connector?: string } = {},
  env: AgentConnectorEnv = loadAgentEnv(ctx.dir)
): AgentConnector {
  const prefer = opts.connector ?? env.connectors['agents']
  if (prefer !== undefined) {
    const hit = agentRegistry.find((x) => x.name === prefer)
    if (!hit) {
      throw new Error(
        `agent connector "${prefer}" is not registered (known: ${agentConnectorNames().join(', ') || 'none'})`
      )
    }
    return makeAgentConnector(hit, ctx, env)
  }
  const url = gitTry(['-C', ctx.dir, 'remote', 'get-url', 'origin'])
  const remote = url.code === 0 ? url.out.trim() : ''
  // matchers run on a probe instance — construction must be side-effect
  // free; a backend that can't even construct is skipped as no-match,
  // but the failure is collected and surfaced, not swallowed silently
  const probeFailures = new Map<string, string>()
  const chosen =
    probeAgentConnectors(ctx, env, remote, probeFailures) ?? firstAgentConnector(ctx, env)
  // a backend that failed to even construct is diagnosable config rot —
  // name it so silent failover doesn't hide a broken registration
  for (const [n, why] of probeFailures) {
    if (n !== chosen.name) {
      console.error(`warning: agent connector "${n}" skipped — failed to initialize: ${why}`)
    }
  }
  return chosen
}

/** Probe-construct each registered backend in registry order and return
 *  the first satisfying a matcher — remote first, then dir. A backend
 *  that can't construct is a recorded no-match, not a resolution
 *  failure; its error lands in probeFailures for the caller's warning. */
function probeAgentConnectors(
  ctx: ConnectorCtx,
  env: AgentConnectorEnv,
  remote: string,
  probeFailures: Map<string, string>
): AgentConnector | undefined {
  const matchers: ((c: (typeof agentRegistry)[number]) => boolean | undefined)[] = [
    (c) => c.matchDir?.(ctx.dir, env),
  ]
  if (remote !== '') {
    matchers.unshift((c) => c.matchRemote?.(remote, env))
  }
  for (const match of matchers) {
    for (const c of agentRegistry) {
      const hit = probeOne(c, match, ctx, env, probeFailures)
      if (hit !== undefined) {
        return hit
      }
    }
  }
  return undefined
}

/** One connector's probe — the matcher's claim plus the construction it
 *  entitles. A throwing matcher or a claim that can't construct is a
 *  recorded failure, not a silent fallthrough; only a true claim that
 *  constructs returns the connector. */
function probeOne(
  c: (typeof agentRegistry)[number],
  match: (c: (typeof agentRegistry)[number]) => boolean | undefined,
  ctx: ConnectorCtx,
  env: AgentConnectorEnv,
  probeFailures: Map<string, string>
): AgentConnector | undefined {
  try {
    if (match(c) !== true) {
      return undefined
    }
    return c.make(ctx, env)
  } catch (err) {
    probeFailures.set(c.name, err instanceof Error ? err.message : String(err))
    return undefined
  }
}

/** Registry-order fallback — no matcher claimed the repo, so the first
 *  registered backend (the designed default `native`) wins. */
function firstAgentConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const first = agentRegistry[0]
  if (!first) {
    throw new Error('no agent connector registered')
  }
  return makeAgentConnector(first, ctx, env)
}

/** The chosen connector's constructor threw — a broken backend is a
 *  classified config failure, not an opaque crash for the client. */
function makeAgentConnector(
  c: (typeof agentRegistry)[number],
  ctx: ConnectorCtx,
  env: AgentConnectorEnv
): AgentConnector {
  try {
    return c.make(ctx, env)
  } catch (err) {
    throw new SpawnError(
      `agent connector "${c.name}" failed to initialize — ${err instanceof Error ? err.message : String(err)}`,
      'config'
    )
  }
}

/** Every registered backend, constructed — fleet reads across ALL of
 *  them (the view works regardless of which backend a fleet runs on);
 *  each connector's list() carries its own degraded flag. A throwing
 *  factory is degrade-equivalent: with `onFactoryError` it contributes a
 *  note and the other backends still construct — without it, the throw
 *  propagates as before. */
export function eachAgentConnector(
  ctx: ConnectorCtx,
  env: AgentConnectorEnv = loadAgentEnv(ctx.dir),
  onFactoryError?: (name: string, error: unknown) => void
): AgentConnector[] {
  const connectors: AgentConnector[] = []
  for (const x of agentRegistry) {
    try {
      connectors.push(x.make(ctx, env))
    } catch (error) {
      if (onFactoryError === undefined) {
        throw error
      }
      onFactoryError(x.name, error)
    }
  }
  return connectors
}

// --- native --------------------------------------------------------------------

/** `<git-common-dir>/bro/agents/` — per-agent artifacts (prompt, log,
 *  exit status) live in the shared dir, not the worktree: a prompt file
 *  in the tree would be a dirty file the agent might commit. */
function agentsHome(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'agents')
}

/** agentIds become filenames under shared dirs — a tampered registry
 *  entry's `../x` must not escape them. Minted ids are `<backend>-<hex>`;
 *  the pattern starts alnum so `.`/`..` segments can never form. */
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** `<common>/bro/agents/<agentId>.prompt.md` — the spawn-time rendered
 *  instructions. Respawn of a custom-prompt agent (a fixer round's
 *  thread context, say) reuses it — the agentId survives process death,
 *  so the file does too. Null for an unsafe or unanchorable id. */
export function agentPromptPath(dir: string, agentId: string): string | null {
  const home = agentsHome(dir)
  return home === null || !SAFE_AGENT_ID.test(agentId)
    ? null
    : join(home, `${agentId}.prompt.md`)
}

/** `<common>/bro/hooks/agent-<id>.work` — hooks markers are
 *  `<common>/bro/hooks/<session>.<aspect>`; the agent gets a synthetic
 *  session name so `otherLiveWork` (session-start parallel detection)
 *  reports it as live work on the molStep. Null outside a common dir. */
function workMarkerPath(dir: string, agentId: string): string | null {
  if (!SAFE_AGENT_ID.test(agentId)) {
    return null
  }
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'hooks', `agent-${agentId}.work`)
}

function writeWorkMarker(dir: string, agentId: string, molStep: string, pid?: number): void {
  try {
    const marker = workMarkerPath(dir, agentId)
    if (marker === null) {
      return
    }
    mkdirSync(dirname(marker), { recursive: true })
    // stamp the agent's real pid (+start identity) so a dead agent's
    // marker reads as residue immediately, not after the freshness
    // window — mtime-only markers from a killed session used to occupy
    // a worktree for a day (bro-b87b)
    const start =
      typeof pid === 'number' && pid > 0 ? procStat(pid)?.start : undefined
    // no starttime = no reuse identity — better an ownerless marker on
    // the mtime window than a tag a recycled pid can impersonate
    const tag = start ? ` ${pid} ${start}` : ''
    writeFileSync(marker, `${Date.now()}${tag}\n${molStep}\n`)
  } catch {
    // marker is advisory — never break a spawn over detection cosmetics
  }
}

/** Unlink the .work marker — but revalidate the registry first: a
 *  respawn reuses the agentId, so a caller working from a stale snapshot
 *  (nativeState/recordedDeath list entries outside the registry lock)
 *  would unlink the fresh marker the new run just wrote (bro-78qb).
 *  Drop only when the registry no longer points a NEWER same-agentId
 *  spawn at this marker. */
function dropWorkMarker(dir: string, molStep: string, entry: AgentRegistryEntry): void {
  try {
    // revalidate + unlink must not interleave with a respawn's registry
    // write + marker write — same lock the spawner holds (re-entrant)
    withAgentRegistryLock(dir, () => {
      const cur = readAgentRegistry(dir)[molStep]
      if (cur !== undefined && cur.agentId === entry.agentId && cur.spawnedAt !== entry.spawnedAt) {
        return // respawned — the live run owns the marker now
      }
      const marker = workMarkerPath(dir, entry.agentId)
      if (marker !== null) {
        rmSync(marker, { force: true })
      }
    })
  } catch {
    // best-effort
  }
}

/** Marker mtime IS the liveness signal detection reads — refresh it
 *  while the agent is verifiably alive or a long-running worker goes
 *  stale (and a dead one's leftover marker stops looking live). */
function touchWorkMarker(dir: string, agentId: string): void {
  try {
    const marker = workMarkerPath(dir, agentId)
    if (marker !== null && existsSync(marker)) {
      const now = new Date()
      utimesSync(marker, now, now)
    }
  } catch {
    // best-effort
  }
}

// liveness comes from @broject/core's shared probe — kill(0) plus the
// zombie and pid-reuse checks; re-exported so existing imports from
// this module keep resolving
export { pidAlive }

/** Identity-pin env keys the connector owns — a caller-supplied value
 *  would redirect the claim store or re-badge the worker, so every
 *  backend filters these out of ambient/spec env and injects its own
 *  values (agentEnvPins). One shared list: the pin set is a security
 *  boundary that must not drift between backends. */
const AGENT_PIN_KEYS = new Set([
  'BEADS_DIR',
  'BRO_BEAD_ID',
  'BRO_AGENT_ID',
  'BRO_PROMPT_FILE',
  'BRO_AGENT',
  'BRO_SESSION_ID',
  'BRO_MOL_ID',
  // provider provenance is connector-owned too — a caller-supplied
  // BRO_AGENT_PROVIDER would let a spawn forge which provider ran it
  'BRO_AGENT_PROVIDER',
  'BRO_AGENT_MODEL',
])

/** The real pin values a backend injects over/around caller env —
 *  BEADS_DIR/BRO_BEAD_ID bind the shared store + claim; BRO_AGENT_ID is
 *  the environ badge proc-owner reads to tell a bro-spawned worker from
 *  an ambient process; BRO_PROMPT_FILE points at the rendered prompt
 *  artifact prepareSpawn writes. BRO_AGENT/BRO_SESSION_ID/BRO_MOL_ID
 *  are the commit-provenance trailers (bro-fzot): the agent cli name
 *  (command's first token, like gcProviderName reads it), the spawn's
 *  stable agentId as session, and the step's molecule parent — `mol`
 *  is resolved by the caller BEFORE the registry lock; a bd show
 *  subprocess inside the critical section would let a slow beads
 *  store stall every spawn. */
const agentEnvPins = (
  spec: SpawnSpec,
  agentId: string,
  promptFile: string,
  agentCli?: string,
  mol?: string
): [string, string][] => {
  const pins: [string, string][] = [
    ['BEADS_DIR', spec.beadsDir],
    ['BRO_BEAD_ID', spec.molStep],
    ['BRO_AGENT_ID', agentId],
    ['BRO_PROMPT_FILE', promptFile],
    ['BRO_SESSION_ID', agentId],
  ]
  if (agentCli !== undefined && agentCli !== '') {
    pins.push(['BRO_AGENT', agentCli])
  }
  if (mol !== undefined) {
    pins.push(['BRO_MOL_ID', mol])
  }
  // provenance pins (spec bro-5hx1.1) — BRO_AGENT_MODEL doubles as
  // MODEL_ENV[0] so the Agent-Model: commit trailer lands the day a
  // provider is named
  if (spec.provider !== undefined) {
    pins.push(['BRO_AGENT_PROVIDER', spec.provider])
  }
  if (spec.model !== undefined) {
    pins.push(['BRO_AGENT_MODEL', spec.model])
  }
  return pins
}

/** Run `f` at most once — the batched probes a fleetOccupancy scan
 *  shares across registry entries (a per-entry subprocess under the
 *  spawn lock would let accumulated dead entries stall every spawn). */
const memo = <T>(f: () => T): (() => T) => {
  let state: { v: T } | undefined
  return () => (state ??= { v: f() }).v
}

/** The tmux occupancy input — one `list-sessions` for the whole scan,
 *  not a `has-session` per entry (each probe is a spawnSync with a 10s
 *  timeout under the spawn lock). `undefined` = inconclusive; a Set =
 *  the live session names, possibly empty — the dead-server error is
 *  proof every session is gone (same semantics tmux's list() applies). */
function tmuxLiveSessions(env: AgentConnectorEnv): Set<string> | undefined {
  const socket =
    typeof env.agents['tmux']?.socket === 'string' ? env.agents['tmux'].socket : 'bro'
  const ls = tmuxRun(socket, ['list-sessions', '-F', '#{session_name}'])
  if (ls.code === 0) {
    return new Set(ls.out.split('\n').filter((s) => s !== ''))
  }
  return TMUX_DEAD_ERR.test(ls.err) ? new Set() : undefined
}

/** tmux occupancy — a session absent from the live set (or with no
 *  legal name) frees the slot; an inconclusive probe occupies — the
 *  same honesty rule as the spawn dedup's 'unknown' verdict. */
function tmuxOccupies(entry: AgentRegistryEntry, live: Set<string> | undefined): boolean {
  const name = tmuxSessionName(entry)
  return name !== undefined && (live === undefined || live.has(name))
}

/** gascity occupancy — `sessions` is the memoized session list
 *  (undefined when the city can't answer → occupies); a session absent
 *  from it frees the slot only when the supervisor is verifiably up
 *  (same rule gascity's list() applies); `supervisor` is probed lazily
 *  since only the missing-session case needs it. */
function gcOccupies(
  molStep: string,
  entry: AgentRegistryEntry,
  sessions: GcSession[] | undefined,
  supervisor: () => boolean | undefined
): boolean {
  if (sessions === undefined) {
    return true
  }
  const s = gcSessionFor(entry, molStep, sessions)
  if (s === undefined) {
    return supervisor() !== true
  }
  return gcState(s) === 'running' || gcState(s) === 'spawned'
}

/** One registry entry's occupancy verdict — an entry occupies until it
 *  is proven dead; every unverifiable probe keeps the slot — a
 *  maybe-live agent is a maybe-burning worker, and the cap exists to
 *  not overshoot an invisible budget. */
function entryOccupies(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry,
  probes: {
    tmuxLive: () => Set<string> | undefined
    gcSessions: () => GcSession[] | undefined
    gcSupervisor: () => boolean | undefined
  }
): boolean {
  switch (entry.backend) {
    case 'native':
      // nativeState also harvests recorded death and retires stale
      // markers — the same side effects list() has on a dead entry
      return nativeState(dir, home, molStep, entry) === 'running'
    case 'tmux':
      return tmuxOccupies(entry, probes.tmuxLive())
    case 'gascity':
      return gcOccupies(molStep, entry, probes.gcSessions(), probes.gcSupervisor)
    default:
      // a backend this build doesn't know — no probe exists, so the
      // .exit file is the only death record readable. Harvest before
      // the verdict: an unharvested .exit would occupy forever, and its
      // recorded cause would never reach the budget walk
      ensureExitCause(dir, home, molStep, entry)
      return entry.stopped !== true && entry.exitStatus === undefined
  }
}

/** The memoized probe set one registry walk shares across entries — N
 *  entries never pay N subprocesses, and a backend with no entries costs
 *  no round-trip at all. fleetOccupancy and budgetSnapshot share it. */
interface OccupancyProbes {
  tmuxLive: () => Set<string> | undefined
  gcSessions: () => GcSession[] | undefined
  gcSupervisor: () => boolean | undefined
}

function occupancyProbes(dir: string, env: AgentConnectorEnv): OccupancyProbes {
  return {
    tmuxLive: memo(() => tmuxLiveSessions(env)),
    gcSessions: memo(() => {
      const city = gcConfigDir(dir, env)
      return city === null ? undefined : listGcSessions(city).sessions
    }),
    gcSupervisor: memo(() => gcSupervisorRunning()),
  }
}

/** How many fleet slots a registry occupies — the cap counts ACROSS
 *  backends (the account's inference budget doesn't care which runtime
 *  burns it). Backend probes are memoized: N entries never pay N
 *  subprocesses inside the spawn lock, and a backend with no entries
 *  costs no round-trip at all. */
export function fleetOccupancy(
  dir: string,
  home: string | null,
  registry: Record<string, AgentRegistryEntry>,
  env: AgentConnectorEnv
): number {
  const probes = occupancyProbes(dir, env)
  let occupied = 0
  for (const [molStep, entry] of Object.entries(registry)) {
    if (entryOccupies(dir, home, molStep, entry, probes)) {
      occupied++
    }
  }
  return occupied
}

/** The display-side occupancy count — the same fail-closed registry
 *  view admission enforces, so `bro agents status`/`bro fleet` report
 *  the numerator the cap actually checks. Registry-wide (a
 *  --connector-scoped view still shows the fleet numerator) and
 *  unverifiable entries still occupy, so a degraded backend can't make
 *  the surface under-report the fleet. */
export function fleetOccupancyFor(dir: string, env: AgentConnectorEnv): number {
  return fleetOccupancy(dir, agentsHome(dir), readAgentRegistry(dir), env)
}

// --- budget observability -----------------------------------------------------
// specs/bro-7xgk.3.md — a local proxy for the provider's hourly budget:
// the wall is only actionable when it's visible before it lands. bro
// never reads provider quota internals; it counts what it causes —
// the registry's spawns, deaths, and observed resets.

/** One provider reset observed in an agent's log tail — `holding` is
 *  whether the respawn block still applies; a reset whose time passed
 *  is history, not a live block. */
export interface BudgetReset {
  step: string
  agent: string
  cause: AgentCause
  resetAt: string
  holding: boolean
}

/** The last known failure cause one registry entry carries — the
 *  registry keeps the latest run per step, so earlier failures are gone. */
export interface BudgetCause {
  step: string
  agent: string
  backend: string
  cause: AgentCause
}

/** The measurement limits every consumer must be able to repeat — the
 *  numbers are bro's own accounting, never provider quota data. Local
 *  accounting CAN be wrong (double-persisted spawns, rewritten history)
 *  which is why the snapshot says so in-band instead of relying on docs. */
export const BUDGET_LIMITS: readonly string[] = [
  'counts bro registry agents only — interactive sessions and foreign tools are invisible',
  'spawn history is bounded by janitor retention — reaped entries no longer count',
  "causes classify from log tails — a provider wall that prints nothing reads 'crash'",
  "the registry keeps the latest run per step — earlier failures' causes are gone",
]

/** The local-estimate budget picture (specs/bro-7xgk.3.md). `basis` is
 *  in-band so a consumer can't strip the disclaimer. */
export interface BudgetSnapshot {
  basis: 'local-estimate'
  /** The measurement limits, spelled out — BUDGET_LIMITS verbatim. */
  limits: string[]
  /** Registry rows read — the snapshot's whole evidence base. */
  entries: number
  /** Live agents — the same fail-closed occupancy verdict admission
   *  enforces; a maybe-live entry counts. */
  live: number
  /** Agents dead on a budget wall whose respawn block still holds. */
  blocked: number
  /** fleet.maxConcurrent — 0 = uncapped. */
  maxConcurrent: number
  /** Spawns in the trailing 60 minutes — a respawn re-stamps spawnedAt
   *  and counts again: a respawn IS a fresh burn. */
  spawnedLastHour: number
  /** Per-hour spawn histogram over the registry's retention window,
   *  ascending by truncated UTC hour. */
  spawnedPerHour: { hour: string; count: number }[]
  /** Provider resets observed in log tails, with the reported time. */
  resets: BudgetReset[]
  /** Last known failure cause per registry entry. */
  causes: BudgetCause[]
}

/** The per-entry tallies a walk accumulates into a BudgetSnapshot. */
interface BudgetWalk {
  live: number
  blocked: number
  spawnedLastHour: number
  perHour: Map<string, number>
  resets: BudgetReset[]
  causes: BudgetCause[]
}

/** One entry's contribution — fail-closed liveness, the lazy cause
 *  harvest (only native's liveness probe walks the death ladder, so
 *  this read is what classifies tmux/unknown/foreign entries), the
 *  spawnedAt hour bucket, and the reset/cause records. */
function budgetEntry(
  dir: string,
  home: string | null,
  probes: OccupancyProbes,
  molStep: string,
  entry: AgentRegistryEntry,
  now: number,
  acc: BudgetWalk
): void {
  // harvest BEFORE the liveness verdict — an unknown backend occupies
  // whenever exitStatus is absent, and an unharvested .exit file is a
  // proven death that frees the slot, not a maybe-live agent; running
  // the ladder first also lands the cause this section exists to show
  ensureExitCause(dir, home, molStep, entry)
  if (entryOccupies(dir, home, molStep, entry, probes)) {
    acc.live++
  }
  const spawned = Date.parse(entry.spawnedAt)
  if (!Number.isNaN(spawned)) {
    const hour = `${new Date(spawned).toISOString().slice(0, 13)}:00:00.000Z`
    acc.perHour.set(hour, (acc.perHour.get(hour) ?? 0) + 1)
    if (now - spawned < 3_600_000) {
      acc.spawnedLastHour++
    }
  }
  const holding = agentEntryBlocked(entry, now)
  if (holding) {
    acc.blocked++
  }
  if (isAgentCause(entry.cause)) {
    acc.causes.push({
      step: molStep,
      agent: entry.agentId,
      backend: entry.backend,
      cause: entry.cause,
    })
  }
  if (typeof entry.resetAt === 'string' && entry.resetAt !== '') {
    acc.resets.push({
      step: molStep,
      agent: entry.agentId,
      cause: isAgentCause(entry.cause) ? entry.cause : 'crash',
      resetAt: entry.resetAt,
      holding,
    })
  }
}

/** The local budget proxy — one registry walk: fail-closed liveness per
 *  entry (the same verdict admission enforces) plus the spawn/reset/
 *  cause tallies. Mutates the passed entries like every read path here:
 *  harvested fields land on the entry objects whether or not the
 *  advisory registry write does. */
export function budgetSnapshot(
  dir: string,
  home: string | null,
  registry: Record<string, AgentRegistryEntry>,
  env: AgentConnectorEnv,
  now = Date.now()
): BudgetSnapshot {
  const probes = occupancyProbes(dir, env)
  const rows = Object.entries(registry)
  const acc: BudgetWalk = {
    live: 0,
    blocked: 0,
    spawnedLastHour: 0,
    perHour: new Map(),
    resets: [],
    causes: [],
  }
  for (const [molStep, entry] of rows) {
    budgetEntry(dir, home, probes, molStep, entry, now, acc)
  }
  return {
    basis: 'local-estimate',
    limits: [...BUDGET_LIMITS],
    entries: rows.length,
    live: acc.live,
    blocked: acc.blocked,
    maxConcurrent: fleetCapOf(env),
    spawnedLastHour: acc.spawnedLastHour,
    spawnedPerHour: [...acc.perHour.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, count]) => ({ hour, count })),
    resets: acc.resets,
    causes: acc.causes,
  }
}

/** The display-side snapshot — reads the registry itself, same pattern
 *  as fleetOccupancyFor. */
export function budgetSnapshotFor(dir: string, env: AgentConnectorEnv): BudgetSnapshot {
  return budgetSnapshot(dir, agentsHome(dir), readAgentRegistry(dir), env)
}

/** The snapshot as section lines — `bro doctor` renders them under a
 *  `budget` heading. The limits line travels with the numbers so they
 *  can't read as provider truth. */
export function budgetLines(b: BudgetSnapshot): string[] {
  const cap = b.maxConcurrent > 0 ? `/${b.maxConcurrent}` : ' (uncapped)'
  const blocked = b.blocked > 0 ? ` · ${b.blocked} blocked` : ''
  const lines = [
    `  live    ${b.live}${cap} agent slots${blocked}`,
    `  spawned ${b.spawnedLastHour} in the last hour`,
  ]
  if (b.resets.length > 0) {
    const cells = b.resets.map((r) => {
      const holding = r.holding ? ' (holding)' : ''
      return `${r.step} ${r.cause} til ${r.resetAt}${holding}`
    })
    lines.push(`  resets  ${cells.join(' · ')}`)
  }
  if (b.causes.length > 0) {
    lines.push(`  causes  ${b.causes.map((c) => `${c.step}: ${c.cause}`).join(' · ')}`)
  }
  lines.push(`  limits  ${b.limits.join(' · ')}`)
  return lines
}

/** Fleet admission under the spawn lock — refuse while OTHER live
 *  entries fill the cap (a respawn's own dead entry holds no slot). The
 *  count rides the same critical section as the registry write, so two
 *  racing spawns can't both see headroom; a refusal names the cap and
 *  the occupancy, never fails silently. `cap.max <= 0` disables. */
function enforceFleetCap(
  dir: string,
  home: string | null,
  registry: Record<string, AgentRegistryEntry>,
  spec: SpawnSpec,
  cap: { max: number; env: AgentConnectorEnv } | undefined
): void {
  if (cap === undefined || cap.max <= 0) {
    return
  }
  const occupied = fleetOccupancy(dir, home, registry, cap.env)
  if (occupied >= cap.max) {
    throw new SpawnError(
      `fleet cap reached — ${occupied}/${cap.max} agent slots occupied ` +
        `(fleet.maxConcurrent in bro.config) — spawn of ${spec.molStep} refused`,
      'cap'
    )
  }
}

/** Session-kind admission — a devin-spawning backend refuses when the
 *  live session count already fills `agents.devin.maxSessions`. The
 *  count is host-wide (devin's own session_locks), not registry-scoped:
 *  interactive sessions and MCP-less spawns count too. 'cap', not
 *  'conflict' — callers wait for a slot, same as the fleet ceiling. */
function enforceSessionQuota(
  spec: SpawnSpec,
  quota:
    | { kind: 'devin'; max: number; lockDir?: string; reservationsDir?: string; invalid?: boolean }
    | undefined
): void {
  if (quota === undefined) {
    return
  }
  if (quota.invalid === true) {
    // a present-but-unparsable cap is a config bug — refuse loudly
    // rather than spawn past a quota the operator thinks is armed
    throw new SpawnError(
      `agents.devin.maxSessions must be a positive integer — spawn of ${spec.molStep} refused`,
      'config'
    )
  }
  if (quota.max <= 0) {
    return
  }
  // locks (live devin sessions, any repo) + reservations (admitted
  // spawns whose devin lock hasn't landed yet) — the union is what a
  // concurrent admission anywhere on this host must see
  const live = countDevinSessions(quota.lockDir) + countDevinReservations(quota.reservationsDir)
  if (live >= quota.max) {
    throw new SpawnError(
      `devin session quota reached — ${live}/${quota.max} live sessions ` +
        `(agents.devin.maxSessions in bro.config) — spawn of ${spec.molStep} refused`,
      'cap'
    )
  }
}

/** The session kind a spawn consumes — 'devin' when the backend declares
 *  `agents.<backend>.sessionKind` or the resolved command's CLI is the
 *  devin binary (worker argv0 / worker template / backend command). */
export function sessionKindOf(
  env: AgentConnectorEnv,
  backend: string,
  spec: SpawnSpec,
  command: string
): 'devin' | undefined {
  const declared = env.agents[backend]?.['sessionKind']
  if (declared === 'devin') {
    return 'devin'
  }
  // an argv worker's argv[0] is the DRIVER (bro acp-worker, npx) — the
  // wrapped agent's own cli rides cliName; argv0 is only the fallback
  const cli =
    spec.worker?.kind === 'argv'
      ? commandCliName(spec.worker.cliName ?? spec.worker.argv[0] ?? '')
      : commandCliName(spec.worker?.kind === 'template' ? spec.worker.command : command)
  return cli === 'devin' ? 'devin' : undefined
}

/** The session quota this spawn must fit under — undefined for
 *  non-devin kinds and uncapped `agents.devin`, so the lock scan only
 *  runs where it can refuse. */
export function sessionQuotaOf(
  env: AgentConnectorEnv,
  backend: string,
  spec: SpawnSpec,
  command: string
):
  | { kind: 'devin'; max: number; lockDir?: string; reservationsDir?: string; invalid?: boolean }
  | undefined {
  const kind = sessionKindOf(env, backend, spec, command)
  if (kind !== 'devin') {
    return undefined
  }
  const quota = devinSessionQuota(env.agents)
  if (quota === undefined) {
    return undefined
  }
  const out: {
    kind: 'devin'
    max: number
    lockDir?: string
    reservationsDir?: string
    invalid?: boolean
  } = { kind, max: quota.maxSessions }
  if (quota.lockDir !== undefined) {
    out.lockDir = quota.lockDir
  }
  if (quota.reservationsDir !== undefined) {
    out.reservationsDir = quota.reservationsDir
  }
  if (quota.invalid === true) {
    out.invalid = true
  }
  return out
}

/** The shared spawn prologue every built-in backend runs under the
 *  registry lock — dedup across the two state planes (registry liveness
 *  + beads claim), the claim/rebind, and the shared-dir artifacts
 *  (prompt/log/exit). Returns the paths the backend tail needs. */
/** Why a dead entry still refuses a respawn — the recorded cause. */
function blockedRespawnDetail(existing: AgentRegistryEntry): string {
  if (existing.cause !== 'rate_limited') {
    return 'quota exhausted'
  }
  const reset = typeof existing.resetAt === 'string' ? existing.resetAt : undefined
  return reset !== undefined
    ? `rate_limited until ${reset}`
    : 'rate_limited — provider reported no reset'
}

/** Guard the registry entry the spawn would reuse or replace: one
 *  backend never adopts another's entry, a live agent is never
 *  double-spawned, an exhausted-budget death is never respawned into. */
function guardExistingEntry(
  dir: string,
  home: string,
  backend: string,
  spec: SpawnSpec,
  existing: AgentRegistryEntry | undefined,
  opts: {
    isLive: (existing: AgentRegistryEntry) => boolean
    liveDetail?: (existing: AgentRegistryEntry) => string
  }
): void {
  if (existing === undefined) {
    return
  }
  if (existing.backend !== backend) {
    throw new SpawnError(
      `${spec.molStep} is registered to backend "${existing.backend}" — respawn belongs to it`
    )
  }
  if (opts.isLive(existing)) {
    const detail = opts.liveDetail?.(existing) ?? `pid ${String(existing.pid)}`
    throw new SpawnError(
      `${spec.molStep} already has a live agent (${existing.agentId}, ${detail})`
    )
  }
  // a recorded death can carry a respawn-blocking cause — classify now
  // (backends whose isLive doesn't walk the death ladder never saw it)
  // and refuse respawn into the same exhausted budget (bro-7xgk.2)
  ensureExitCause(dir, home, spec.molStep, existing)
  if (agentEntryBlocked(existing)) {
    throw new SpawnError(
      `respawn of ${spec.molStep} refused — ${blockedRespawnDetail(existing)}; \`bro agents down ${spec.molStep}\` clears the block`
    )
  }
}

/** Guard the beads claim — a spawn must own (or create) the claim it
 *  will pin, never steal a live worker's or a human's step. Returns the
 *  claim state the write phase needs for claim-vs-rebind. */
function guardClaim(
  spec: SpawnSpec,
  hasEntry: boolean,
  claimAs: string | undefined
): { claimed: boolean; actor: string | undefined } {
  const step = probeStep(spec.beadsDir, spec.molStep)
  if (step?.status !== 'in_progress') {
    return { claimed: false, actor: undefined }
  }
  if (!hasEntry) {
    // claimed with no registry entry — an interactive session or a
    // foreign backend owns it; spawning would double-claim
    throw new SpawnError(
      `${spec.molStep} is claimed outside the agent registry (assignee ${step.assignee ?? '?'})`
    )
  }
  // a dead entry doesn't entitle us to whatever claim sits on the step
  // now — if another actor picked it up meanwhile, rebinding would steal
  // a live worker's (or a human's) step. The actor resolves in the
  // pinned store's context — the same context the claim was written under.
  const actor = bdActor(spec.beadsDir)
  if (step.assignee !== actor && step.assignee !== claimAs) {
    throw new SpawnError(
      `${spec.molStep} is claimed by ${step.assignee ?? '?'} — rebind only takes our own claim`
    )
  }
  return { claimed: true, actor }
}

/* Dedup correlates both planes: a claim alone is not a conflict — a
 *  crashed worker's stale in_progress must not block respawn — and a
 *  live agent alone is not spawnable-over either. The registry entry
 *  goes in FIRST: every later failure (claim refused, spawn error)
 *  leaves a respawn-able 'lost' entry instead of a foreign claim that
 *  can never be rebound. `opts.isLive` is the backend's liveness probe
 *  on an existing entry; `opts.entry` merges backend-private fields
 *  (tmux's session name) into the patch. */
function prepareSpawn(
  dir: string,
  home: string,
  backend: string,
  spec: SpawnSpec,
  opts: {
    isLive: (existing: AgentRegistryEntry) => boolean
    liveDetail?: (existing: AgentRegistryEntry) => string
    entry?: (agentId: string) => Record<string, unknown>
    /** Rehome the claim onto the backend's worker identity after
     *  claim/rebind (gascity: the session alias, so gc's default
     *  work_query picks up in_progress work assigned to the session).
     *  Also counts as "our own claim" in the rebind guard. */
    claimAs?: string
    /** Fleet admission — `max` is fleetCapOf(env) (0 disables the
     *  check). Counted under the registry lock, after dedup and the
     *  claim guards, before any write: a spawn that would overshoot
     *  the cap refuses while OTHER live entries fill it (a respawn's
     *  own dead entry holds no slot). */
    cap?: { max: number; env: AgentConnectorEnv }
    /** Session-kind admission — the spawn consumes a `kind` session
     *  ('devin') and refuses when live sessions already hit `max`.
     *  Checked after the fleet cap, still before any write. A passing
     *  check immediately writes a host-shared reservation so the next
     *  admission anywhere on this host sees the claimed slot. */
    sessionQuota?:
      | { kind: 'devin'; max: number; lockDir?: string; reservationsDir?: string; invalid?: boolean }
      | undefined
  }
): { agentId: string; promptFile: string; log: string; exitFile: string; reservation?: string } {
  const registry = readAgentRegistry(dir)
  const existing = registry[spec.molStep]
  guardExistingEntry(dir, home, backend, spec, existing, opts)
  const { claimed, actor } = guardClaim(spec, existing !== undefined, opts.claimAs)
  // fleet admission — before the registry write + claim land, so a
  // refusal leaves no half-spawned state
  enforceFleetCap(dir, home, registry, spec, opts.cap)
  // session-kind admission — same ordering argument: refuse before the
  // registry write, while OTHER live sessions fill the quota
  enforceSessionQuota(spec, opts.sessionQuota)
  // a reused id must stay filename-safe — a tampered entry gets a fresh
  // mint, not a path escape into <home>/
  const agentId =
    existing !== undefined && SAFE_AGENT_ID.test(existing.agentId)
      ? existing.agentId
      : mintAgentId(backend)
  // the slot is OURS now — claim it host-wide before any write, so a
  // concurrent spawn in another repo can't see phantom headroom; the
  // backend releases it on failure, the TTL retires it behind the
  // devin child's own lock on success
  const reservation =
    opts.sessionQuota !== undefined
      ? reserveDevinSession(opts.sessionQuota.reservationsDir, agentId)
      : undefined
  try {
  mkdirSync(home, { recursive: true })
  const promptFile = join(home, `${agentId}.prompt.md`)
  const log = join(home, `${agentId}.log`)
  const exitFile = join(home, `${agentId}.exit`)
  rmSync(exitFile, { force: true })
  writeFileSync(promptFile, spec.prompt)
  // the log is append-mode across respawns — pin where THIS run's output
  // starts so a later exit classifies on new text only, not the old run's
  // rate-limit wall (which would re-block the fresh run forever)
  let logFrom = 0
  try {
    logFrom = statSync(log).size
  } catch {
    // no log yet — the run starts at byte 0
  }
  // exitStatus: undefined clears a respawned entry's stale harvest — the
  // new run must not read as already-exited (undefined keys drop out of
  // the serialized registry). pid/pidStart/spawnError likewise — a claim
  // failure before the backend patches its handle would leave a stale
  // value that could alias an unrelated process/session later
  patchAgentRegistry(dir, spec.molStep, {
    agentId,
    backend,
    spawnedAt: new Date().toISOString(),
    // absolute — a relative repoRoot breaks branch/PR lookup when the
    // reader's cwd differs from the spawner's (bro-qoqt)
    worktree: resolve(spec.repoRoot),
    log,
    logFrom,
    stopped: false,
    exitStatus: undefined,
    // a respawned entry's cause/resetAt belonged to the PREVIOUS run —
    // the new agent must not inherit a 'blocked' it didn't earn
    cause: undefined,
    resetAt: undefined,
    pid: undefined,
    pidStart: undefined,
    spawnError: undefined,
    // provenance — the resolution verdict rides the same write
    // (spec bro-5hx1.1), even if the child never starts; a respawn
    // re-stamps it, so a legacy respawn clears a stale pin instead of
    // keeping the previous run's provider
    provider: spec.provider,
    model: spec.model,
    // the acp driver patches the real session id after session/new —
    // clear the previous run's so it never masquerades as this run's
    acpSessionId: undefined,
    // the session kind this run consumed — the quota lane it was
    // admitted under; absent for non-kind spawns
    sessionKind: opts.sessionQuota?.kind,
    ...opts.entry?.(agentId),
  })
  if (claimed) {
    rebindStep(spec.beadsDir, spec.molStep, actor!)
  } else {
    claimStep(spec.beadsDir, spec.molStep)
  }
  if (opts.claimAs !== undefined) {
    rebindStep(spec.beadsDir, spec.molStep, opts.claimAs)
  }
  return { agentId, promptFile, log, exitFile, reservation }
  } catch (err) {
    // a write/claim failure after the reservation — the caller never saw
    // the key, so this is the only place that can hand the slot back
    if (reservation !== undefined) {
      releaseDevinSession(reservation)
    }
    throw err
  }
}

/** Exit status the wrapper dropped at `<agentId>.exit` — absent when the
 *  process is still running or died by SIGKILL (nothing to write with). */
function readExitFile(home: string, agentId: string): number | undefined {
  try {
    const v = readFileSync(join(home, `${agentId}.exit`), 'utf8').trim()
    const n = Number(v)
    return Number.isInteger(n) ? n : undefined
  } catch {
    return undefined
  }
}

/** The tail of the agent's log — budget/auth walls print at the end of
 *  the output, so a bounded tail read classifies them and a huge log
 *  costs nothing. '' on any read failure — the classifier then falls
 *  through to 'crash' on a non-zero exit. */
const LOG_TAIL_BYTES = 64 * 1024

function readLogTail(log: unknown, from?: unknown): string {
  if (typeof log !== 'string' || log === '') {
    return ''
  }
  try {
    const fd = openSync(log, 'r')
    try {
      const size = fstatSync(fd).size
      // classification reads only THIS run's segment — a respawned entry
      // carries logFrom so the previous run's output can't re-classify
      const base = typeof from === 'number' && from > 0 ? Math.min(from, size) : 0
      const len = Math.min(size - base, LOG_TAIL_BYTES)
      if (len <= 0) {
        return ''
      }
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, size - len)
      return buf.toString('utf8', 0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** Cause a recorded exit onto the entry — classified from the log tail,
 *  never the rc (the same rc=1 covers a crash and a rate-limit wall).
 *  Runs once: at .exit harvest (one patch writes exitStatus+cause
 *  together) and lazily on entries carrying an exitStatus but no cause
 *  (pre-taxonomy runs, or a harvested entry whose patch failed). The
 *  registry write is advisory — the entry object is updated either way
 *  so callers decide on THIS read's verdict, not the store's health. */
function ensureExitCause(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry
): void {
  if (entry.exitStatus === undefined && home !== null) {
    const code = readExitFile(home, entry.agentId)
    if (code !== undefined) {
      entry.exitStatus = code
    }
  }
  if (typeof entry.exitStatus !== 'number' || isAgentCause(entry.cause)) {
    return
  }
  const c = classifyExitCause(readLogTail(entry.log, entry.logFrom), entry.exitStatus)
  entry.cause = c.cause
  entry.resetAt = c.resetAt
  try {
    // the merge must bind to the SAME generation we classified — a
    // respawn between our snapshot read and this patch owns the entry
    // now, and the old run's exit fields would mislabel it
    withAgentRegistryLock(dir, () => {
      const reg = readAgentRegistry(dir)
      const cur = reg[molStep]
      if (cur === undefined || cur.agentId !== entry.agentId || cur.spawnedAt !== entry.spawnedAt) {
        return
      }
      reg[molStep] = {
        ...cur,
        exitStatus: entry.exitStatus,
        cause: c.cause,
        resetAt: c.resetAt,
      }
      writeAgentRegistry(dir, reg)
    })
  } catch {
    // the registry write is advisory — .exit still proves the exit
  }
}

/** The recorded-death ladder both backends walk once liveness fails —
 *  stopped flag → harvested exitStatus → the .exit file (lazily
 *  harvested into the registry so `agents.json` keeps pid+exit-status
 *  alongside the handle, and the harvest is once). A recorded exit whose
 *  cause is a budget wall reads 'blocked' while the block holds — a
 *  waiting worker is not a missing one ('lost' stays dead-without-a-
 *  record). Terminal states also retire the .work marker: a dead agent
 *  must not keep reporting as live work to parallel-session detection.
 *  Returns undefined when nothing recorded a death — the caller decides
 *  what unproven means ('lost' for a confirmed-dead backend, 'spawned'
 *  for a failed probe). */
function recordedDeath(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry
): AgentState | undefined {
  if (entry.stopped === true) {
    dropWorkMarker(dir, molStep, entry)
    return 'stopped'
  }
  ensureExitCause(dir, home, molStep, entry)
  if (entry.exitStatus === undefined) {
    return undefined
  }
  dropWorkMarker(dir, molStep, entry)
  return agentEntryBlocked(entry) ? 'blocked' : 'exited'
}

/** Registry scan by agentId within one backend — status()/stop()
 *  resolve through it. */
function findAgentEntry(
  dir: string,
  backend: string,
  id: string
): [string, AgentRegistryEntry] | undefined {
  for (const [molStep, e] of Object.entries(readAgentRegistry(dir))) {
    if (e.backend === backend && e.agentId === id) {
      return [molStep, e]
    }
  }
  return undefined
}

/** Spawn guards shared by the built-in backends — they refuse before a
 *  claim or registry write lands: an unconfigured agent command, a
 *  nonexistent worktree, or an unanchorable agents home. Returns the
 *  shared artifacts dir on success. */
function spawnHome(dir: string, backend: string, command: string, spec: SpawnSpec): string {
  if (command === '' && spec.worker === undefined) {
    throw new SpawnError(
      `no agent command configured — set agents.${backend}.command, agents.${backend}.provider, or loop.agent in bro.config.json`,
      'config'
    )
  }
  if (!existsSync(spec.repoRoot)) {
    throw new SpawnError(`worktree ${spec.repoRoot} does not exist`, 'input')
  }
  const home = agentsHome(dir)
  if (!home) {
    throw new SpawnError(`no git common dir for ${spec.repoRoot}`, 'config')
  }
  return home
}

/** The registry's recorded starttime for entry.pid — undefined when
 *  the entry predates identity recording or the read failed; pidAlive
 *  then skips the reuse check rather than guess. */
const entryPidStart = (entry: AgentRegistryEntry): string | undefined =>
  typeof entry.pidStart === 'string' && entry.pidStart !== ''
    ? entry.pidStart
    : undefined

/** Live state for a registry entry under this backend. */
function nativeState(dir: string, home: string | null, molStep: string, entry: AgentRegistryEntry): AgentState {
  // liveness first: a 'stopped' marker on a pid that is still alive means
  // SIGTERM hasn't landed yet — the agent IS still running, and dedup
  // must keep refusing a respawn that would run alongside it
  const pid = typeof entry.pid === 'number' ? entry.pid : undefined
  if (pid !== undefined && pidAlive(pid, entryPidStart(entry))) {
    touchWorkMarker(dir, entry.agentId)
    return 'running'
  }
  const dead = recordedDeath(dir, home, molStep, entry)
  if (dead !== undefined) {
    return dead
  }
  dropWorkMarker(dir, molStep, entry)
  return 'lost'
}

/** cause/resetAt ride from the registry entry to AgentInfo — the
 *  recorded-death ladder may have just classified them. */
const infoCause = (entry: AgentRegistryEntry): Pick<AgentInfo, 'cause' | 'resetAt'> => ({
  cause: isAgentCause(entry.cause) ? entry.cause : undefined,
  resetAt: typeof entry.resetAt === 'string' ? entry.resetAt : undefined,
})

/** provider/model provenance — absent fields read as a legacy spawn
 *  (the row says so by omission, honestly). */
const infoProvenance = (
  entry: AgentRegistryEntry
): Pick<AgentInfo, 'provider' | 'model'> => ({
  provider: typeof entry.provider === 'string' ? entry.provider : undefined,
  model: typeof entry.model === 'string' ? entry.model : undefined,
})

function toInfo(dir: string, home: string | null, molStep: string, entry: AgentRegistryEntry): AgentInfo {
  return {
    id: entry.agentId,
    spawnedAt: typeof entry.spawnedAt === 'string' ? entry.spawnedAt : undefined,
    pid: typeof entry.pid === 'number' ? entry.pid : undefined,
    molStep,
    backend: entry.backend,
    state: nativeState(dir, home, molStep, entry),
    ...infoCause(entry),
    ...infoProvenance(entry),
    worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
    log: typeof entry.log === 'string' ? entry.log : undefined,
  }
}

/** The native backend — detached process, self-sufficient
 *  (supervisor:'none'). Agent command template resolves as
 *  agents.native.command → loop.agent; `{promptFile}` expands like the
 *  loop's agent template. */
export function makeNativeConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir
  const knobs = env.agents['native'] ?? {}
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ?? env.loop?.agent ?? ''

  const findEntry = (id: string) => findAgentEntry(dir, 'native', id)

  return {
    name: 'native',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      const home = spawnHome(dir, 'native', command, spec)
      // dedup → claim → spawn → pid-patch runs as ONE critical section:
      // without the lock a second bro process can pass the liveness
      // check between our read and our write and double-spawn (TOCTOU).
      // Everything inside is synchronous — the bd subprocesses are
      // spawnSync — so the hold is milliseconds in the common case.
      // stepParent's bd show runs OUTSIDE it for the same reason the
      // fleet memo exists: a slow beads store must not hold the lock.
      const mol = stepParent(spec.beadsDir, spec.molStep)
      return withAgentRegistryLock(dir, () => {
        const { agentId, promptFile, log, exitFile, reservation } = prepareSpawn(
          dir,
          home,
          'native',
          spec,
          {
            isLive: (e) => nativeState(dir, home, spec.molStep, e) === 'running',
            cap: { max: fleetCapOf(env), env },
            sessionQuota: sessionQuotaOf(env, 'native', spec, command),
          }
        )
        const fd = openSync(log, 'a')
        let spawned: AgentRegistryEntry
        try {
          // the wrapper captures $? into the .exit file — the only exit
          // record a detached process can leave once the parent is gone.
          // Worker payloads (spec bro-5hx1.1): a 'template' worker's
          // command substitutes for the backend's own template; an
          // 'argv' worker execs verbatim through the wrapper's "$@"
          // positional passthrough — the provider argv (a `model` value
          // could carry shell metachars) is never string-concatenated.
          const worker = spec.worker
          const args =
            worker?.kind === 'argv'
              ? [
                  '-c',
                  'out=$1; shift; "$@"; s=$?; printf %s "$s" > "$out"',
                  'bro-agent',
                  exitFile,
                  ...worker.argv,
                  promptFile,
                ]
              : [
                  '-c',
                  `${expandAgentCmd(worker?.kind === 'template' ? worker.command : command, promptFile)}; s=$?; printf %s "$s" > "$1"`,
                  'bro-agent',
                  exitFile,
                ]
          const cliBadge =
            worker === undefined
              ? commandCliName(command)
              : worker.kind === 'argv'
                ? worker.cliName
                : commandCliName(worker.command)
          const child = spawn(
            'sh', // NOSONAR — PATH lookup is the contract (same as git/bd everywhere)
            args,
            { // NOSONAR — operator-configured agent command (same contract as loop)
              cwd: spec.repoRoot,
              env: {
                ...process.env,
                ...spec.env,
                // identity pins last — spec.env must never redirect the
                // claim store or re-badge the worker as another bead/agent
                ...Object.fromEntries(
                  agentEnvPins(spec, agentId, promptFile, cliBadge, mol)
                ),
              },
              stdio: ['ignore', fd, fd],
              detached: true,
            }
          )
          // an unhandled 'error' event would take the whole CLI down —
          // a failed exec records itself on the entry and reads 'lost'
          const spawnStamp = readAgentRegistry(dir)[spec.molStep]?.spawnedAt
          child.on('error', (err) => {
            try {
              // stamp only our own run — a respawn that reused this
              // molStep/agentId owns the entry now; an old child's error
              // must not mislabel a live respawn (bro-ooud)
              const cur = readAgentRegistry(dir)[spec.molStep]
              if (cur?.agentId !== agentId || cur?.spawnedAt !== spawnStamp) {
                return
              }
              patchAgentRegistry(dir, spec.molStep, { spawnError: err.message })
              // the devin session never started — hand the slot back now
              // rather than block peers for the reservation's whole TTL
              if (reservation !== undefined) {
                releaseDevinSession(reservation)
              }
            } catch {
              // the entry may not have landed yet — nothing else to do
            }
          })
          child.unref()
          spawned = patchAgentRegistry(dir, spec.molStep, {
            pid: child.pid ?? -1,
            // the starttime pins identity against pid reuse — without it
            // a recycled pid keeps a dead agent 'running' in every
            // dedup/stop decision the registry drives
            pidStart:
              typeof child.pid === 'number'
                ? (procStat(child.pid)?.start ?? null)
                : null,
          })
          writeWorkMarker(dir, agentId, spec.molStep, child.pid)
        } catch (err) {
          // sync failure after the reservation — hand the slot back
          if (reservation !== undefined) {
            releaseDevinSession(reservation)
          }
          throw err
        } finally {
          closeSync(fd)
        }
        return toInfo(dir, home, spec.molStep, spawned)
      })
    },

    async list() {
      try {
        const home = agentsHome(dir)
        const agents = Object.entries(readAgentRegistry(dir))
          .filter(([, e]) => e.backend === 'native')
          .map(([molStep, e]) => toInfo(dir, home, molStep, e))
        return { agents }
      } catch (err) {
        return {
          agents: [],
          degraded: err instanceof Error ? err.message : String(err),
        }
      }
    },

    async status(id: string): Promise<AgentInfo> {
      const hit = findEntry(id)
      if (!hit) {
        throw new AgentNotFound(`no native agent ${id}`)
      }
      return toInfo(dir, agentsHome(dir), hit[0], hit[1])
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id)
      if (!hit) {
        return // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit
      const pid = typeof entry.pid === 'number' ? entry.pid : undefined
      if (pid !== undefined && pidAlive(pid, entryPidStart(entry))) {
        try {
          process.kill(-pid, 'SIGTERM') // detached → own process group
        } catch {
          // No fallback to kill(pid): a native child is always its own
          // group leader, so a failed group signal means the pid was
          // recycled by a non-leader — signaling it would hit an
          // unrelated process.
        }
        // let the signal land before recording the stop — `stopped` on a
        // still-living pid would let a respawn run alongside the dying
        // agent (nativeState reports live pids as running regardless)
        const deadline = Date.now() + 2_000
        while (pidAlive(pid, entryPidStart(entry)) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      // a respawn during the kill wait re-probes and re-pins the entry
      // under the registry lock — re-verify under the SAME lock or
      // 'stopped' + the marker drop land on a live, respawned entry
      withAgentRegistryLock(dir, () => {
        const cur = readAgentRegistry(dir)[molStep]
        if (
          cur === undefined ||
          cur.agentId !== entry.agentId ||
          cur.spawnedAt !== entry.spawnedAt ||
          (pid !== undefined && pidAlive(pid, entryPidStart(entry)))
        ) {
          return // respawned or still alive — the live run owns the entry
        }
        try {
          patchAgentRegistry(dir, molStep, { stopped: true })
        } catch {
          // the marker removal below still records intent
        }
        dropWorkMarker(dir, molStep, entry)
      })
    },

    capabilities: () => ({ attach: false, respawn: true, supervisor: 'none' }),
  }
}

registerAgentConnector('native', makeNativeConnector)

// --- tmux ----------------------------------------------------------------------

/** tmux runs the pane command through sh — single-quote a path the same
 *  way expandAgentCmd quotes {promptFile}. */
const SH_SQUOTE = String.raw`'\''` // ' → '\'' : close, escaped quote, reopen
const shQuote = (s: string): string => `'${s.replaceAll("'", SH_SQUOTE)}'`

/** tmux session names can't hold `.`/`:` (target syntax) — minted ids
 *  (`tmux-<hex>` → `bro-tmux-<hex>`) always pass; a tampered registry
 *  entry's name must still be proven safe before it becomes a -t arg. */
const TMUX_SESSION_NAME = /^[A-Za-z0-9_-]+$/

interface TmuxResult {
  code: number
  out: string
  err: string
  /** ENOENT — the binary isn't there at all (degrade, don't probe). */
  missing: boolean
}

/** One tmux call on a socket. `socket === ''` targets the user's default
 *  server (no -L); the default 'bro' socket keeps the fleet off it. */
function tmuxRun(socket: string, args: string[]): TmuxResult {
  const proc = spawnSync('tmux', socket === '' ? args : ['-L', socket, ...args], { // NOSONAR — PATH lookup is the contract (same as git/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10_000,
  })
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
    missing: (proc.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
  }
}

/** The registry entry's tmux session name — the recorded one, or derived
 *  from a safe agentId for entries written before `session` existed.
 *  Undefined when neither is a legal tmux name. */
function tmuxSessionName(entry: AgentRegistryEntry): string | undefined {
  if (typeof entry.session === 'string' && TMUX_SESSION_NAME.test(entry.session)) {
    return entry.session
  }
  const derived = `bro-${entry.agentId}`
  return TMUX_SESSION_NAME.test(derived) ? derived : undefined
}

/** Tri-state liveness from has-session: exit 0 proves the session lives;
 *  TMUX_DEAD_ERR shapes prove it dead — sessions live inside the
 *  server, so a missing session, a downed server, or a socket file
 *  that isn't there are all corpses, not mysteries. Anything else
 *  (timeout, refused connection, permissions) is 'unknown': the probe
 *  failed and must not read as 'lost'. */
type TmuxLiveness = 'running' | 'dead' | 'unknown'

const TMUX_DEAD_ERR = /can't find session|no server running|no such file or directory/i

function tmuxProbe(socket: string, name: string): { live: TmuxLiveness; err: string } {
  const r = tmuxRun(socket, ['has-session', '-t', name])
  if (r.code === 0) {
    return { live: 'running', err: '' }
  }
  return {
    live: TMUX_DEAD_ERR.test(r.err) ? 'dead' : 'unknown',
    err: r.err !== '' ? r.err : `tmux exited ${r.code}`,
  }
}

/** Live state for a tmux entry: `probe` is the session liveness verdict
 *  (tmuxProbe for one entry, list()'s batched list-sessions for the
 *  fleet — the pane dying takes the session with it), then the shared
 *  recorded-death ladder. An 'unknown' probe still honors recorded
 *  death but never reports 'lost' — a failed probe didn't find a
 *  corpse, so 'spawned' (registered, unverified) is the honest read. */
function tmuxState(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry,
  probe: TmuxLiveness
): AgentState {
  // liveness first — 'stopped' on a session that still exists means
  // kill-session hasn't landed; the agent IS still running
  if (probe === 'running') {
    touchWorkMarker(dir, entry.agentId)
    return 'running'
  }
  const dead = recordedDeath(dir, home, molStep, entry)
  if (dead !== undefined) {
    return dead
  }
  if (probe === 'unknown') {
    // the marker stays — an unverifiable agent may still be live work
    return 'spawned'
  }
  dropWorkMarker(dir, molStep, entry)
  return 'lost'
}

function toTmuxInfo(
  socket: string,
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry,
  live?: Set<string>
): AgentInfo {
  const name = tmuxSessionName(entry)
  // a batch `live` set decides outright; without one, probe the server
  let probe: TmuxLiveness
  if (name === undefined) {
    probe = 'dead' // no legal session name → nothing to find
  } else if (live !== undefined) {
    probe = live.has(name) ? 'running' : 'dead'
  } else {
    probe = tmuxProbe(socket, name).live
  }
  return {
    id: entry.agentId,
    spawnedAt: typeof entry.spawnedAt === 'string' ? entry.spawnedAt : undefined,
    pid: typeof entry.pid === 'number' ? entry.pid : undefined,
    molStep,
    backend: entry.backend,
    state: tmuxState(dir, home, molStep, entry, probe),
    ...infoCause(entry),
    ...infoProvenance(entry),
    worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
    log: typeof entry.log === 'string' ? entry.log : undefined,
  }
}

/** The tmux backend — each agent is a detached tmux session on a
 *  dedicated socket (`agents.tmux.socket`, default 'bro'; '' = the
 *  user's default server). Interactive: `tmux -L bro attach -t
 *  bro-<agentId>` is the attach the capability flag promises. The tmux
 *  server self-starts on new-session, so supervisor stays 'none'.
 *
 *  Dedup/claim/registry semantics are the native one's — the beads
 *  claim in the shared store is the single source of truth, the
 *  agentId survives respawn, and a foreign backend's entry is never
 *  adopted. Knobs: `agents.tmux.command` → `loop.agent` (same agent
 *  command template as native, `{promptFile}` expanded). */
export function makeTmuxConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir
  const knobs = env.agents['tmux'] ?? {}
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ?? env.loop?.agent ?? ''
  const socket = typeof knobs.socket === 'string' ? knobs.socket : 'bro'

  const findEntry = (id: string) => findAgentEntry(dir, 'tmux', id)

  return {
    name: 'tmux',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> { // NOSONAR — connector contract is async; the critical section is sync
      const home = spawnHome(dir, 'tmux', command, spec)
      const ver = tmuxRun(socket, ['-V'])
      if (ver.missing || ver.code !== 0) {
        throw new SpawnError(`tmux unavailable — ${ver.missing ? 'not on PATH' : ver.err}`, 'unavailable')
      }
      // same critical section as native: dedup → claim → session →
      // pid-patch under the registry lock, all synchronous shell-outs;
      // the molecule pin's bd show resolves before the lock is taken
      const mol = stepParent(spec.beadsDir, spec.molStep)
      return withAgentRegistryLock(dir, () => {
        // the session name derives from the agentId prepareSpawn
        // resolves — entry callback, not a precomputed name, because a
        // tampered entry's unsafe id is reminted inside
        const { agentId, promptFile, log, exitFile, reservation } = prepareSpawn(
          dir,
          home,
          'tmux',
          spec,
          {
            isLive: (e) => {
              const n = tmuxSessionName(e)
              if (n === undefined) {
                return false
              }
              const p = tmuxProbe(socket, n)
              if (p.live === 'unknown') {
                // an unverifiable liveness probe must not let a duplicate
                // spawn kill-session a worker that may still be alive
                throw new SpawnError(`cannot verify ${spec.molStep}'s tmux session — ${p.err}`, 'unavailable')
              }
              if (p.live === 'running') {
                touchWorkMarker(dir, e.agentId)
              }
              return p.live === 'running'
            },
            liveDetail: (e) => `session ${tmuxSessionName(e) ?? '?'}`,
            entry: (id) => ({ session: `bro-${id}` }),
            cap: { max: fleetCapOf(env), env },
            sessionQuota: sessionQuotaOf(env, 'tmux', spec, command),
          }
        )
        const session = `bro-${agentId}`
        // a leftover session with our name (crash between entry and
        // kill, a respawn over a zombie) would make new-session fail
        // 'duplicate' — clear it; kill-session on a missing target is
        // a no-op error we ignore
        tmuxRun(socket, ['kill-session', '-t', session])
        // ambient env (process.env + spec.env) rides a 0600 file the
        // pane sources, not argv — -e KEY=VALUE would expose secrets on
        // the tmux client's world-readable cmdline, a regression vs
        // native's spawn env. Identity pins are non-secret and stay on
        // -e; they're also filtered OUT of the file so sourcing can
        // never redirect the claim store or re-badge the worker
        const envFile = join(home, `${agentId}.env`)
        const ambient = Object.entries({ ...process.env, ...spec.env })
          .filter(
            (e): e is [string, string] =>
              e[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e[0]) && !AGENT_PIN_KEYS.has(e[0])
          )
          .map(([k, v]) => `export ${k}=${shQuote(v)}`)
          .join('\n')
        writeFileSync(envFile, `${ambient}\n`, { mode: 0o600 })
        const worker = spec.worker
        const cliBadge =
          worker === undefined
            ? commandCliName(command)
            : worker.kind === 'argv'
              ? worker.cliName
              : commandCliName(worker.command)
        const envArgs = agentEnvPins(spec, agentId, promptFile, cliBadge, mol).flatMap(
          ([k, v]) => ['-e', `${k}=${v}`]
        )
        // the pane sources the ambient env and drops the file, then runs
        // the agent; $? lands in the .exit file before the pipeline
        // drains, tee keeps a log the way native's fd redirect does.
        // Session dies with the pane → has-session IS liveness. tmux
        // runs the command through the user's default-shell — a
        // non-POSIX one (fish) would eat the braces, so sh -c pins the
        // dialect the same way native's spawn does.
        // Worker payloads (spec bro-5hx1.1): a 'template' command
        // substitutes wholesale; an 'argv' worker becomes an exec line
        // with every element single-quoted — the provider argv never
        // re-parses into a different program.
        const runLine =
          worker === undefined
            ? expandAgentCmd(command, promptFile)
            : worker.kind === 'argv'
              ? [...worker.argv, promptFile].map(shQuote).join(' ')
              : expandAgentCmd(worker.command, promptFile)
        const paneScript = `. ${shQuote(envFile)}; rm -f ${shQuote(envFile)}; { ${runLine}; s=$?; printf %s "$s" > ${shQuote(exitFile)}; } 2>&1 | tee -a ${shQuote(log)}`
        const paneCmd = `sh -c ${shQuote(paneScript)}` // NOSONAR — operator-configured agent command (same contract as native/loop)
        const res = tmuxRun(socket, [
          'new-session',
          '-d',
          '-s',
          session,
          '-c',
          spec.repoRoot,
          ...envArgs,
          paneCmd,
        ])
        if (res.code !== 0) {
          rmSync(envFile, { force: true }) // a failed spawn must not leave ambient env on disk
          if (reservation !== undefined) {
            releaseDevinSession(reservation)
          }
          try {
            patchAgentRegistry(dir, spec.molStep, { spawnError: res.err })
          } catch {
            // the entry landed already — the SpawnError still reports
          }
          throw new SpawnError(`tmux new-session failed — ${res.err}`, 'unavailable')
        }
        // pane pid — a display handle like native's child pid, not the
        // liveness signal (has-session is); pidStart pins its identity
        // anyway so registry-side pidAlive probes (drive's cheap
        // occupancy plane runs no backend list()) can tell a recycled
        // pid from the live pane (bro-i5oq)
        const pp = tmuxRun(socket, ['list-panes', '-t', session, '-F', '#{pane_pid}'])
        const panePid = pp.code === 0 ? Number(pp.out.trim().split('\n')[0]) : Number.NaN
        const hasPanePid = Number.isInteger(panePid) && panePid > 0
        const spawned = patchAgentRegistry(
          dir,
          spec.molStep,
          hasPanePid ? { pid: panePid, pidStart: procStat(panePid)?.start ?? null } : {}
        )
        writeWorkMarker(dir, agentId, spec.molStep, hasPanePid ? panePid : undefined)
        return toTmuxInfo(socket, dir, home, spec.molStep, spawned)
      })
    },

    async list() { // NOSONAR — connector contract is async; the body is sync
      try {
        const ver = tmuxRun(socket, ['-V'])
        if (ver.missing || ver.code !== 0) {
          return { agents: [], degraded: ver.missing ? 'tmux not on PATH' : ver.err }
        }
        const home = agentsHome(dir)
        const entries = Object.entries(readAgentRegistry(dir)).filter(
          ([, e]) => e.backend === 'tmux'
        )
        // one server round-trip for the whole fleet instead of a
        // has-session per entry — a name absent from a SUCCESSFUL
        // listing is proof of dead, and so is a dead-server error (the
        // server holds its sessions). Any other failure degrades the
        // list rather than reporting live agents as corpses
        const ls = tmuxRun(socket, ['list-sessions', '-F', '#{session_name}'])
        if (ls.code !== 0 && !TMUX_DEAD_ERR.test(ls.err)) {
          return { agents: [], degraded: ls.err !== '' ? ls.err : `tmux exited ${ls.code}` }
        }
        const live = new Set(ls.out.split('\n').filter((s) => s !== ''))
        return {
          agents: entries.map(([molStep, e]) => toTmuxInfo(socket, dir, home, molStep, e, live)),
        }
      } catch (err) {
        return {
          agents: [],
          degraded: err instanceof Error ? err.message : String(err),
        }
      }
    },

    async status(id: string): Promise<AgentInfo> { // NOSONAR — connector contract is async; the body is sync
      const hit = findEntry(id)
      if (!hit) {
        throw new AgentNotFound(`no tmux agent ${id}`)
      }
      return toTmuxInfo(socket, dir, agentsHome(dir), hit[0], hit[1])
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id)
      if (!hit) {
        return // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit
      const name = tmuxSessionName(entry)
      if (name !== undefined) {
        tmuxRun(socket, ['kill-session', '-t', name])
        // let the kill land before recording the stop — 'stopped' on a
        // still-live session would let a respawn run alongside it
        const deadline = Date.now() + 2_000
        while (
          tmuxProbe(socket, name).live === 'running' &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 25)) // NOSONAR — bounded kill-wait poll
        }
      }
      // a respawn during the kill wait re-probes and re-pins the entry
      // under the registry lock — re-verify under the SAME lock or
      // 'stopped' + the marker drop land on a live, respawned entry
      withAgentRegistryLock(dir, () => {
        const cur = readAgentRegistry(dir)[molStep]
        if (
          cur === undefined ||
          cur.agentId !== entry.agentId ||
          cur.spawnedAt !== entry.spawnedAt
        ) {
          return // respawned — the live run owns the entry
        }
        if (name !== undefined) {
          const p = tmuxProbe(socket, name)
          if (p.live === 'running') {
            return // still alive — the live run owns the entry
          }
          if (p.live === 'unknown') {
            // an unverifiable probe must not record 'stopped' on a
            // session that may still be live — fail loudly instead
            throw new Error(`cannot verify ${id}'s tmux session stopped — ${p.err}`)
          }
        }
        try {
          patchAgentRegistry(dir, molStep, { stopped: true })
        } catch {
          // the marker removal below still records intent
        }
        dropWorkMarker(dir, molStep, entry)
      })
    },

    capabilities: () => ({ attach: true, respawn: true, supervisor: 'none' }),
  }
}

// --- gascity -------------------------------------------------------------------

/** The gascity backend — `gc` as code. Spec: specs/sessions/bro-f4ot/
 *  spec.md + spike-gascity.md (bro-4bkv verdict: viable connector, the
 *  model mismatch is absorbed here, not in the facade).
 *
 *  Contract mapping (spike-probed on gc 1.4.2):
 *   - spawn   = lazy city bootstrap → author a per-step agent
 *               `agents/<molStep>/` (work_dir = spec.repoRoot — gc
 *               derives the session's working dir from agent config,
 *               and `gc sling`'s first operand must resolve to a
 *               configured agent, so the agent IS named <molStep>) →
 *               `gc session new <molStep> --alias <molStep> --no-attach
 *               --json` → `gc sling <molStep> <molStep>` → `gc session
 *               submit` the rendered prompt; the claim is rehomed to
 *               the session alias so gc's default work_query (tier 1:
 *               in_progress assigned to the session/alias) picks the
 *               bead up; respawn reuses the registry id and `gc session
 *               reset` the surviving session instead of colliding on
 *               --alias;
 *   - list    = `gc session list --json --state all`; a supervisor
 *               not-verifiably-running probe degrades the read — an
 *               unverifiable session is omitted (fleet renders
 *               `unknown`), never reported `lost`;
 *   - stop    = `gc session close` — the terminal op; `kill` would race
 *               the reconciler's restart;
 *   - up/down = `gc start`/`gc stop <city>` — city-scoped lifecycle; the
 *               machine-wide supervisor is NEVER stopped from here
 *               (other cities ride it);
 *   - claims  = the shared beads store, exactly like native — the repo
 *               is adopted as a rig (`gc rig add --adopt`), so the rig's
 *               beads DB IS the repo store. `sling --force` is never
 *               used: a dispatch with no shared-store claim would
 *               double workers.
 *
 *  Knobs: `agents.gascity.configDir` (default `<git-common-dir>/bro/
 *  gascity`), `agents.gascity.template` (default `bro-worker`),
 *  `agents.gascity.command` (provider command; falls back to
 *  loop.agent). */

/** One gc call — PATH lookup is the same contract as git/gh/bd. */
function gcRun(args: string[], timeoutMs = 30_000): { code: number; out: string; err: string } {
  const proc = spawnSync('gc', args, { // NOSONAR — PATH lookup is the contract (same as gh/git/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
  }
}

/** `gc session list` row — only the fields this connector reads; the
 *  schema carries more (`gc session list --json-schema result`). */
interface GcSession {
  id: string
  alias?: string
  state: string
  closed?: boolean
  work_dir?: string
}

/** session list → (sessions, err). A parse failure IS a failed read. */
function listGcSessions(city: string): { sessions?: GcSession[]; err?: string } {
  const r = gcRun(['session', 'list', '--json', '--state', 'all', '--city', city])
  if (r.code !== 0) {
    return { err: r.err !== '' ? r.err : `gc session list exited ${r.code}` }
  }
  try {
    const v = JSON.parse(r.out) as { ok?: boolean; sessions?: GcSession[]; error?: string }
    if (v.ok === false) {
      return { err: v.error ?? 'gc session list returned ok: false' }
    }
    return { sessions: Array.isArray(v.sessions) ? v.sessions : [] }
  } catch {
    return { err: 'gc session list returned unparseable JSON' }
  }
}

/** The session owned by a registry entry — the stored sessionId first,
 *  the molStep alias as the pre-patch fallback. */
function gcSessionFor(
  entry: AgentRegistryEntry,
  molStep: string,
  sessions: GcSession[]
): GcSession | undefined {
  const sid = typeof entry.sessionId === 'string' ? entry.sessionId : undefined
  return sessions.find((s) => s.id === sid) ?? sessions.find((s) => s.alias === molStep)
}

/** gc session state → AgentState. `closed` rows map regardless of the
 *  state string; unstarted-but-durable sessions are 'spawned'. */
function gcState(s: GcSession): AgentState {
  if (s.closed === true || s.state === 'closed') {
    return 'exited'
  }
  switch (s.state) {
    case 'active':
      return 'running'
    case 'suspended':
      return 'stopped'
    default:
      return 'spawned'
  }
}

/** Supervisor reachability — the liveness oracle. Only `true` is proof
 *  of life: the probe failing, an `ok:false` payload, a missing field,
 *  or a verified-stopped supervisor all mean a missing session cannot be
 *  called `lost` — callers degrade on anything but `true`. */
function gcSupervisorRunning(): boolean | undefined {
  const r = gcRun(['supervisor', 'status', '--json'])
  if (r.code !== 0) {
    return undefined
  }
  try {
    const v = JSON.parse(r.out) as { ok?: boolean; running?: boolean }
    return v.ok !== false && v.running === true ? true : undefined
  } catch {
    return undefined
  }
}

/** Directory that owns the shared store — the rig root. `beadsDir` is
 *  the resolved `.beads`, so its parent is the project gc must adopt. */
function gcRigDirOf(spec: SpawnSpec): string {
  return dirname(spec.beadsDir)
}

/** TOML basic-string escapes that have a short form. */
const TOML_SHORT_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
  '\b': '\\b',
  '\f': '\\f',
}

/** TOML basic-string escape — quotes, backslashes, and EVERY control
 *  char (U+0000–U+001F, U+007F) — a raw CR or other control byte makes
 *  the generated config unparsable. */
const tomlStr = (s: string): string =>
  s.replace(
    /[\x00-\x1f\x7f"\\]/g,
    (ch) => TOML_SHORT_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  )

/** gc session submit carries the prompt as a single argv element —
 *  Linux caps it at 128KiB (MAX_ARG_STRLEN); leave headroom for the
 *  rest of argv. */
const GC_SUBMIT_PROMPT_MAX = 120_000

const GC_CITY_TOML = (provider: string, command: string): string =>
  `# authored by bro's gascity connector (bro-cduq) — regenerate by deleting
[workspace]
provider = "${provider}"

[providers.${provider}]
command = "${tomlStr(command)}"
prompt_mode = "none"
`

const GC_AGENT_TOML = `scope = "city"
wake_mode = "resume"
`

const GC_PROMPT_TEMPLATE = `You are a bro-managed worker in a Gas City session.

Work arrives as a bead routed to this session — its description is the
work order — plus a submitted message carrying the rendered prompt. Follow
it exactly: work in this session's work_dir, verify like CI, push, open
the PR. The beads store is the shared store (this rig is adopted) —
verdicts go through \`bd update\`/\`bd close\` on the routed bead.
`

/** City root — explicit `agents.gascity.configDir`, else the shared
 *  `<git-common-dir>/bro/gascity` (out of every worktree). */
function gcConfigDir(dir: string, env: AgentConnectorEnv): string | null {
  const k = env.agents['gascity']?.configDir
  if (typeof k === 'string' && k.trim() !== '') {
    return isAbsolute(k) ? k : resolve(dir, k)
  }
  const home = agentsHome(dir)
  return home === null ? null : dirname(home) + '/gascity'
}

/** The command a Gas City actually runs — `initCity` writes city.toml
 *  once and never rewrites, so for an existing city the EFFECTIVE
 *  provider command is the stored one, not today's config. Falls back
 *  to the configured command when no toml exists or it can't be read. */
function gcEffectiveCommand(city: string | null, configured: string): string {
  if (city === null) {
    return configured
  }
  try {
    const toml = readFileSync(join(city, 'city.toml'), 'utf8')
    const m = toml.match(/^command\s*=\s*"((?:[^"\\]|\\.)*)"/m)
    if (m?.[1] !== undefined) {
      // tomlStr wrote it — the same escape contract reads it back
      return JSON.parse(`"${m[1]}"`) as string
    }
  } catch {
    // unreadable/malformed toml → admit against the configured command
  }
  return configured
}

/** gascity claims a configDir layout — an authored city.toml at the
 *  resolved configDir is the marker (spec: agents.gascity.configDir).
 *  Factory-level: resolution probes this without constructing. */
function gcMatchDir(dir: string, env: AgentConnectorEnv): boolean {
  const city = gcConfigDir(dir, env)
  return city !== null && existsSync(join(city, 'city.toml'))
}

export function makeGascityConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir
  const knobs = env.agents['gascity'] ?? {}
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ?? env.loop?.agent ?? ''
  const template =
    typeof knobs.template === 'string' && knobs.template.trim() !== ''
      ? knobs.template.trim()
      : 'bro-worker'

  const configDir = (): string | null => gcConfigDir(dir, env)

  const findEntry = (id: string) => findAgentEntry(dir, 'gascity', id)

  /** Author city.toml + the worker template once, then `gc init --file
   *  … --no-start` — files-only bootstrap, no supervisor side effects. */
  const initCity = (city: string): void => {
    mkdirSync(city, { recursive: true })
    const toml = join(city, 'city.toml')
    if (existsSync(toml)) {
      return
    }
    writeFileSync(toml, GC_CITY_TOML(commandCliName(command), command))
    const agentDir = join(city, 'agents', template)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'prompt.template.md'), GC_PROMPT_TEMPLATE)
    writeFileSync(join(agentDir, 'agent.toml'), GC_AGENT_TOML)
    const init = gcRun(
      ['init', '--file', toml, '--preserve-existing', '--no-start', '--skip-provider-readiness', '--yes', city],
      120_000
    )
    if (init.code !== 0) {
      // a failed init must not leave the marker standing — otherwise the
      // next spawn sees city.toml and skips init on a half-built city
      rmSync(toml, { force: true })
      throw new SpawnError(`gc init failed — ${init.err !== '' ? init.err : `exited ${init.code}`}`, 'unavailable')
    }
  }

  /** Per-step agent — `gc sling <target> <bead>` resolves <target> as a
   *  configured agent (never a session alias), and a session's working
   *  dir comes from its agent's work_dir — so each step gets its own
   *  agent named after the molStep, pinned to spec.repoRoot. Written on
   *  every spawn; gc reads config per command. */
  const writeStepAgent = (spec: SpawnSpec, city: string, agentId: string, promptFile: string, mol?: string): void => {
    // leading-alnum guard: '.'/'..' would escape the per-step dir and a
    // template-named step would overwrite the shared template
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.molStep)) {
      throw new SpawnError(`molStep ${spec.molStep} is not a safe gascity agent name`, 'input')
    }
    // inherit a customized agents.gascity.template — its prompt and
    // agent.toml carry over; only the work_dir pin is asserted
    const tplDir = join(city, 'agents', template)
    const read = (f: string, fallback: string): string => {
      try {
        return readFileSync(join(tplDir, f), 'utf8')
      } catch {
        return fallback
      }
    }
    const wd = `work_dir = "${tomlStr(spec.repoRoot)}"`
    // spec.env rides the agent's env table — the only channel a gc
    // session has for caller env (gc re-injects it after its `env -u`
    // strip, so the spawned provider process actually sees the vars)
    const envEntries = Object.entries(spec.env ?? {}).filter(
      // identity pins are connector-owned — a caller value for
      // BEADS_DIR/BRO_BEAD_ID/... would redirect bead ops or re-badge
      // the worker, so the env table filters them out and re-injects
      // the connector's own below
      ([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !AGENT_PIN_KEYS.has(k)
    )
    // caller env plus the connector-owned identity pins — pins always
    // render so the table exists even when spec.env is empty
    const allEnv = [
      ...envEntries,
      ...agentEnvPins(spec, agentId, promptFile, commandCliName(command), mol),
    ]
    const envToml = `env = { ${allEnv.map(([k, v]) => `${k} = "${tomlStr(v)}"`).join(', ')} }\n`
    // work_dir (+ env) are top-level — they must precede any [table] in
    // the file; the template's own copies are dropped so ours win
    const agentToml =
      `${wd}\n${envToml}` +
      read('agent.toml', GC_AGENT_TOML)
        .replace(/^work_dir\s*=.*$/gm, '')
        .replace(/^env\s*=.*$/gm, '')
    const agentDir = join(city, 'agents', spec.molStep)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'prompt.template.md'), read('prompt.template.md', GC_PROMPT_TEMPLATE))
    writeFileSync(join(agentDir, 'agent.toml'), agentToml)
  }

  /** Adopt the repo as a rig — the rig's beads DB IS the shared store,
   *  so claims land where `bro fleet` reads. Idempotent. */
  const ensureRig = (spec: SpawnSpec, city: string): void => {
    const rigDir = gcRigDirOf(spec)
    const rigs = gcRun(['rig', 'list', '--json', '--city', city])
    let registered = false
    if (rigs.code === 0) {
      try {
        const v = JSON.parse(rigs.out) as { rigs?: { path?: string }[] }
        registered = (v.rigs ?? []).some((r) => r.path === rigDir)
      } catch {
        registered = false
      }
    }
    if (!registered) {
      const add = gcRun(['rig', 'add', rigDir, '--adopt', '--city', city], 60_000)
      if (add.code !== 0) {
        throw new SpawnError(`gc rig add ${rigDir} failed — ${add.err !== '' ? add.err : `exited ${add.code}`}`, 'unavailable')
      }
    }
  }

  /** City-scoped supervisor ensure — `gc start` registers the city and
   *  brings up the shared supervisor. */
  const ensureStarted = (city: string): void => {
    if (gcSupervisorRunning() !== true) {
      const start = gcRun(['start', city], 120_000)
      if (start.code !== 0) {
        throw new SpawnError(`gc start failed — ${start.err !== '' ? start.err : `exited ${start.code}`}`, 'unavailable')
      }
    }
  }

  const toInfo = (
    molStep: string,
    entry: AgentRegistryEntry,
    sessions: GcSession[] | undefined,
    missing: AgentState
  ): AgentInfo => {
    const s = sessions === undefined ? undefined : gcSessionFor(entry, molStep, sessions)
    return {
      id: entry.agentId,
      spawnedAt: typeof entry.spawnedAt === 'string' ? entry.spawnedAt : undefined,
      molStep,
      backend: entry.backend,
      state: sessions === undefined || s === undefined ? missing : gcState(s),
      ...infoCause(entry),
      ...infoProvenance(entry),
      worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
      log: typeof entry.log === 'string' ? entry.log : undefined,
    }
  }

  /** Bring the city up and return the session id — `session reset` a
   *  surviving session in place (preserves alias+bead), else `session
   *  new` the per-step agent. A `session new` whose id can't be learned
   *  is closed by alias first so no orphan runs beside the retry. */
  const ensureGcSession = (
    spec: SpawnSpec,
    city: string,
    prior: unknown,
    agentId: string,
    promptFile: string,
    mol?: string
  ): string => {
    initCity(city)
    writeStepAgent(spec, city, agentId, promptFile, mol)
    ensureRig(spec, city)
    ensureStarted(city)
    const priorId = typeof prior === 'string' ? prior : undefined
    const { sessions } = listGcSessions(city)
    const alive = sessions?.find((s) => s.id === priorId || s.alias === spec.molStep)
    if (alive !== undefined) {
      const reset = gcRun(['session', 'reset', alive.id, '--city', city])
      if (reset.code !== 0) {
        throw new Error(`gc session reset ${alive.id} — ${reset.err !== '' ? reset.err : `exited ${reset.code}`}`)
      }
      return alive.id
    }
    const created = gcRun(
      ['session', 'new', spec.molStep, '--alias', spec.molStep, '--no-attach', '--json', '--city', city],
      120_000
    )
    if (created.code !== 0) {
      throw new Error(
        `gc session new ${spec.molStep} — ${created.err !== '' ? created.err : `exited ${created.code}`}`
      )
    }
    let v: { session_id?: string; ok?: boolean }
    try {
      v = JSON.parse(created.out) as { session_id?: string; ok?: boolean }
    } catch {
      // exit-0 garbage still created a session under the alias —
      // close it so the orphan can't run alongside a retry
      gcRun(['session', 'close', spec.molStep, '--city', city])
      throw new Error('gc session new returned unparseable JSON')
    }
    if (v.ok === false) {
      throw new Error('gc session new returned ok: false')
    }
    if (v.session_id === undefined) {
      gcRun(['session', 'close', spec.molStep, '--city', city])
      throw new Error('gc session new returned no session_id')
    }
    return v.session_id
  }

  /** Route + deliver: sling the bead (the routed work order), then
   *  submit the rendered prompt. Never --force — a bead that doesn't
   *  resolve in the rig store is a claimless dispatch. */
  const dispatchStep = (spec: SpawnSpec, city: string): void => {
    const sling = gcRun(['sling', spec.molStep, spec.molStep, '--city', city])
    if (sling.code !== 0) {
      throw new Error(`gc sling ${spec.molStep} — ${sling.err !== '' ? sling.err : `exited ${sling.code}`}`)
    }
    const submit = gcRun(['session', 'submit', spec.molStep, spec.prompt, '--city', city])
    if (submit.code !== 0) {
      throw new Error(
        `gc session submit ${spec.molStep} — ${submit.err !== '' ? submit.err : `exited ${submit.code}`}`
      )
    }
  }

  /** `close` is the terminal op — `kill` races the reconciler's restart.
   *  A failed close is tolerated only when the session is verifiably
   *  gone — marking stopped while it still runs would leave a live
   *  worker that respawns refuse as a duplicate. */
  const closeGcSession = (city: string, target: string, molStep: string): void => {
    const close = gcRun(['session', 'close', target, '--city', city])
    if (close.code === 0) {
      return
    }
    const { sessions } = listGcSessions(city)
    const s = sessions?.find((x) => x.id === target || x.alias === molStep)
    if (s === undefined ? sessions === undefined : gcState(s) !== 'exited') {
      throw new Error(
        `gc session close ${target} — ${close.err !== '' ? close.err : `exited ${close.code}`}`
      )
    }
  }

  return {
    name: 'gascity',

    // instance-level view of the registered factory matcher
    matchDir: () => gcMatchDir(dir, env),

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      // a provider-resolved worker can't ride gc — the city's provider
      // command is written once in city.toml at init, so recording
      // provenance while gc runs its own configured provider would be
      // laundering. Model labels alone still pin (env table).
      if (spec.worker !== undefined) {
        throw new SpawnError(
          `providers.${spec.provider ?? '?'} resolved a spawn worker, but the gascity backend runs its own provider sessions (city.toml owns the command) — run it on native/tmux or drop the provider`,
          'config'
        )
      }
      // gc session submit has no --file/stdin mode (v1.4.2), so the
      // prompt rides argv — Linux caps a single element at 128KiB
      // (MAX_ARG_STRLEN) and E2BIG there reads as an opaque spawn
      // failure. Bound it as bad input before claiming or touching gc.
      const promptBytes = Buffer.byteLength(spec.prompt)
      if (promptBytes > GC_SUBMIT_PROMPT_MAX) {
        throw new SpawnError(
          `prompt is ${promptBytes} bytes — gc session submit passes it as one argv element (cap ${GC_SUBMIT_PROMPT_MAX}); shorten the prompt or file it`,
          'input'
        )
      }
      const home = spawnHome(dir, 'gascity', command, spec)
      const city = configDir()
      if (city === null) {
        throw new SpawnError(`no git common dir for ${spec.repoRoot}`, 'config')
      }
      // same TOCTOU critical section as native: dedup → claim → backend
      // spawn → registry patch, all under the agents.json lock — and the
      // molecule pin's bd show resolves before it, off the critical path
      const mol = stepParent(spec.beadsDir, spec.molStep)
      return withAgentRegistryLock(dir, () => {
        const existing = readAgentRegistry(dir)[spec.molStep]
        const { agentId, promptFile, reservation } = prepareSpawn(dir, home, 'gascity', spec, {
          isLive: (e) => {
            const { sessions, err } = listGcSessions(city)
            if (sessions === undefined) {
              // an unverifiable liveness probe must not let a duplicate
              // spawn run alongside a worker that may still be alive
              throw new SpawnError(`gascity unreachable — cannot verify existing agent: ${err}`, 'unavailable')
            }
            const s = gcSessionFor(e, spec.molStep, sessions)
            const st = s === undefined ? 'lost' : gcState(s)
            return st === 'running' || st === 'spawned'
          },
          liveDetail: (e) =>
            `session ${typeof e.sessionId === 'string' ? e.sessionId : spec.molStep}`,
          entry: () => ({ sessionId: undefined }),
          claimAs: spec.molStep,
          cap: { max: fleetCapOf(env), env },
          // the quota admits against what gc will actually RUN — the
          // command pinned in city.toml at init, not today's config
          sessionQuota: sessionQuotaOf(env, 'gascity', spec, gcEffectiveCommand(city, command)),
        })
        let sessionId: string | undefined
        try {
          sessionId = ensureGcSession(spec, city, existing?.sessionId, agentId, promptFile, mol)
          dispatchStep(spec, city)
        } catch (err) {
          // leave the entry respawn-able: close the orphan session so a
          // retry can't run alongside a zombie, then record the failure.
          if (sessionId !== undefined) {
            gcRun(['session', 'close', sessionId, '--city', city])
          }
          if (reservation !== undefined) {
            releaseDevinSession(reservation)
          }
          patchAgentRegistry(dir, spec.molStep, {
            sessionId,
            spawnError: err instanceof Error ? err.message : String(err),
          })
          throw err instanceof SpawnError
            ? err
            : new SpawnError(err instanceof Error ? err.message : String(err), 'unavailable')
        }
        const spawned = patchAgentRegistry(dir, spec.molStep, { sessionId })
        const { sessions } = listGcSessions(city)
        return toInfo(spec.molStep, spawned, sessions ?? [], 'spawned')
      })
    },

    async list(): Promise<ListResult> {
      try {
        const city = configDir()
        const entries = Object.entries(readAgentRegistry(dir)).filter(
          ([, e]) => e.backend === 'gascity'
        )
        if (entries.length === 0) {
          return { agents: [] }
        }
        if (city === null || !existsSync(join(city, 'city.toml'))) {
          // never initialized — every gascity entry is unverifiable
          return { agents: [], degraded: 'gascity city not initialized' }
        }
        const { sessions, err } = listGcSessions(city)
        if (sessions === undefined) {
          return { agents: [], degraded: err }
        }
        // absent sessions are 'lost' only when the supervisor can verify;
        // not verifiably running → degrade and omit them: an unlisted
        // agent renders 'unknown' in fleet, a 'lost' one would look like
        // a dead fleet.
        const missing = entries.some(
          ([molStep, e]) => gcSessionFor(e, molStep, sessions) === undefined
        )
        if (missing && gcSupervisorRunning() !== true) {
          return {
            agents: entries
              .filter(([molStep, e]) => gcSessionFor(e, molStep, sessions) !== undefined)
              .map(([molStep, e]) => toInfo(molStep, e, sessions, 'lost')),
            degraded: 'gc supervisor not running — agent liveness unknown',
          }
        }
        return { agents: entries.map(([molStep, e]) => toInfo(molStep, e, sessions, 'lost')) }
      } catch (err) {
        return { agents: [], degraded: err instanceof Error ? err.message : String(err) }
      }
    },

    async status(id: string): Promise<AgentInfo> {
      const hit = findEntry(id)
      if (!hit) {
        throw new AgentNotFound(`no gascity agent ${id}`)
      }
      const [molStep, entry] = hit
      const city = configDir()
      if (city === null) {
        throw new Error('no git common dir — cannot reach gascity')
      }
      const { sessions, err } = listGcSessions(city)
      if (sessions === undefined) {
        throw new Error(`gascity unreachable — ${err}`)
      }
      if (gcSessionFor(entry, molStep, sessions) === undefined && gcSupervisorRunning() !== true) {
        throw new Error('gc supervisor not running — agent liveness unknown')
      }
      return toInfo(molStep, entry, sessions, 'lost')
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id)
      if (!hit) {
        return // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit
      const city = configDir()
      if (city !== null && entry.stopped !== true) {
        closeGcSession(
          city,
          typeof entry.sessionId === 'string' ? entry.sessionId : molStep,
          molStep
        )
      }
      try {
        patchAgentRegistry(dir, molStep, { stopped: true })
      } catch {
        // stop intent is recorded best-effort, same as native
      }
    },

    /** supervisor:'required' ⇒ up/down are `gc start`/`gc stop <city>`
     *  — city-scoped lifecycle; the machine-wide supervisor itself is
     *  never touched (other cities ride it). */
    async up(): Promise<void> {
      const city = configDir()
      if (city === null) {
        throw new SpawnError('no git common dir — cannot locate the gascity city', 'config')
      }
      if (command === '') {
        throw new SpawnError(
          'no agent command configured — set agents.gascity.command or loop.agent in bro.config.json',
          'config'
        )
      }
      initCity(city)
      ensureStarted(city)
    },

    async down(): Promise<void> {
      const city = configDir()
      // an uninitialized city has nothing to stop — idempotent down
      if (city === null || !existsSync(join(city, 'city.toml'))) {
        return
      }
      const r = gcRun(['stop', city], 120_000)
      if (r.code !== 0) {
        throw new SpawnError(`gc stop failed — ${r.err !== '' ? r.err : `exited ${r.code}`}`, 'unavailable')
      }
    },

    capabilities: () => ({ attach: true, respawn: true, supervisor: 'required' }),
  }
}

registerAgentConnector('tmux', makeTmuxConnector)
registerAgentConnector('gascity', makeGascityConnector, { matchDir: gcMatchDir })
