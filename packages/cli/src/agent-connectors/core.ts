/**
 * Agent connector registry + shared types/helpers.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  AgentNotFound,
  agentEntryBlocked,
  agentExitFileName,
  agentsSection,
  bdActor,
  admitSessionSlot,
  BATCH_MARKER_ENV,
  isBatchSpawn,
  claimStep,
  classifyExitCause,
  classifyExitCauseParts,
  appendPrivateFileSync,
  cliCommandModel,
  commandCliName,
  DEFAULT_CONFIG,
  deriveProviderWalls,
  emitLifecycle,
  entryRunId,
  ghHost,
  gitTry,
  isAgentCause,
  JudgeUnavailable,
  loadConfig,
  mintAgentId,
  mintRunId,
  mkdirPrivateSync,
  openPrivateAppendSync,
  patchAgentRegistry,
  pidAlive,
  probeStep,
  procStat,
  providerCallGrade,
  rebindStep,
  releaseSessionSlot,
  requireProviderSurface,
  resolveStepClass,
  SESSION_SLOT_TTL_MS,
  sessionPlane,
  sessionPlaneForCli,
  sessionQuotaConfig,
  sessionSlotsDir,
  SpawnError,
  stepParent,
  ProviderSurfaceError,
  readAgentRegistry,
  UnknownProviderError,
  withAgentRegistryLock,
  writeAgentRegistry,
  writePrivateFileSync,
  type AgentCause,
  type AgentConnector,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
  type ConnectorCtx,
  type DiscoveredSession,
  type FleetProfile,
  type FleetRouter,
  type ListResult,
  type ProviderEntry,
  type ProviderWall,
  type ResolvedClass,
  type RoutingTable,
  type SessionPlane,
  type SpawnSpec,
  type SpawnWorker,
} from '@broject/core'
import { otelEvent } from '@broject/providers'
import type { AcpSeam, FetchFn } from '@broject/providers'
import { expandAgentCmd, loopSection, type LoopConfig } from '@broject/loop'

export * from '@broject/core'
export { otelEvent } from '@broject/providers'
export type { AcpSeam, FetchFn } from '@broject/providers'
export { expandAgentCmd, loopSection, type LoopConfig } from '@broject/loop'
export { spawn, spawnSync } from 'node:child_process'
export { createHash } from 'node:crypto'
export {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
export { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

export {
  AgentNotFound,
  agentEntryBlocked,
  agentExitFileName,
  agentsSection,
  bdActor,
  admitSessionSlot,
  BATCH_MARKER_ENV,
  isBatchSpawn,
  claimStep,
  classifyExitCause,
  classifyExitCauseParts,
  appendPrivateFileSync,
  cliCommandModel,
  commandCliName,
  DEFAULT_CONFIG,
  deriveProviderWalls,
  emitLifecycle,
  entryRunId,
  ghHost,
  gitTry,
  isAgentCause,
  JudgeUnavailable,
  loadConfig,
  mintAgentId,
  mintRunId,
  mkdirPrivateSync,
  openPrivateAppendSync,
  patchAgentRegistry,
  pidAlive,
  probeStep,
  procStat,
  providerCallGrade,
  rebindStep,
  releaseSessionSlot,
  requireProviderSurface,
  resolveStepClass,
  SESSION_SLOT_TTL_MS,
  sessionPlane,
  sessionPlaneForCli,
  sessionQuotaConfig,
  sessionSlotsDir,
  SpawnError,
  stepParent,
  ProviderSurfaceError,
  readAgentRegistry,
  UnknownProviderError,
  withAgentRegistryLock,
  writeAgentRegistry,
  writePrivateFileSync,
}
export type {
  AgentCause,
  AgentConnector,
  AgentInfo,
  AgentRegistryEntry,
  AgentState,
  ConnectorCtx,
  DiscoveredSession,
  FleetProfile,
  FleetRouter,
  ListResult,
  ProviderEntry,
  ProviderWall,
  ResolvedClass,
  RoutingTable,
  SessionPlane,
  SpawnSpec,
  SpawnWorker,
}

/** Everything a factory needs: the repo ctx + the resolved config
 *  (agents.<backend> knobs, connectors.agents pick, loop.agent fallback). */
export interface AgentConnectorEnv {
  agents: Record<string, Record<string, unknown>>
  /** Facade → connector precedence — `connectors.agents` selects here. */
  connectors: Record<string, string>
  loop?: LoopConfig
  /** Fleet section — `maxConcurrent` is the cap (fleetCapOf defaults it
   *  on hand-built envs); `profiles` holds the named spawn presets
   *  `--profile` resolves (spec bro-5hx1.1); `routing` is the task-class
   *  → provider-chain table (spec bro-1x7p). */
  fleet?: {
    maxConcurrent: number
    profiles?: Record<string, FleetProfile>
    routing?: RoutingTable
    router?: FleetRouter
  }
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
  builtin?: boolean
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
  matchers: AgentConnectorMatchers = {},
  opts: { builtin?: boolean } = {}
): (() => void) | undefined {
  if (agentRegistry.some((x) => x.name === name)) {
    console.error(`warning: agent connector "${name}" already registered — skipped`)
    return undefined
  }
  const entry = { name, make, ...matchers, builtin: opts.builtin === true }
  agentRegistry.push(entry as any)
  return () => {
    const i = agentRegistry.indexOf(entry as any)
    if (i >= 0) {
      agentRegistry.splice(i, 1)
    }
  }
}

/** Deliberate name-based removal — fixtures prefer the disposer
 *  registerAgentConnector returns, which can only drop the entry it
 *  added. Built-ins refuse with a warning (same visibility as
 *  registerAgentConnector's duplicate warning); unknown names are a
 *  no-op. */
export function unregisterAgentConnector(name: string): void {
  const entry = agentRegistry.find((x: any) => x.name === name)
  if (entry && (entry as any).builtin === true) {
    console.error(`warning: agent connector "${name}" is built-in — unregister skipped`)
    return
  }
  const i = agentRegistry.findIndex((x: any) => x.name === name)
  if (i >= 0) {
    agentRegistry.splice(i, 1)
  }
}

export function agentConnectorNames(): string[] {
  return agentRegistry.map((x) => x.name)
}

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
    fleet?: {
      maxConcurrent: number
      profiles?: Record<string, FleetProfile>
      routing?: RoutingTable
      router?: FleetRouter
    }
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

/** The `bro` invocation for a provider driver — PATH-first, then an
 *  `npx -y` fallback pinned to the running plugin's own major, the same
 *  contract the hooks shim pins at install time (spec bro-5hx1.1). A
 *  spawned env that strips both is a startup error the driver itself
 *  reports. */
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
  return ['npx', '-y', `@broject/bro@${VERSION.split('.')[0] || '0'}`]
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
    case 'cli': {
      // the entry's command substitutes for the backend's template —
      // {promptFile} mechanics apply verbatim. `{model}` is the
      // template's only wire for an override; one it can't consume
      // would be provenance the worker never ran — refuse, don't
      // relabel the spawn.
      const { command } = cliCommandModel(
        entry.command,
        entry.model,
        sel.model,
        (m) =>
          new SpawnError(
            `providers.${providerName} (type 'cli') cannot honor model '${m}' — ` +
              'its command has no {model} placeholder',
            'input'
          ),
        () =>
          new SpawnError(
            `providers.${providerName} (type 'cli') uses {model} but pins no default model`,
            'config'
          )
      )
      return { provider: providerName, model, worker: { kind: 'template', command } }
    }
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
          argv: acpWorkerArgv(broSpawnArgv(), entry, {
            model,
            autoApprove,
            sessionRm: entry.sessionRm,
          }),
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

/** The fleet router's spawn seam (spec bro-1x7p, M7) — fires only on
 *  an UNCLASSED step: `fleet.router` configured and not 'off', a
 *  resolved lane on the table, and the caller's `info` carrying no
 *  `class:` label (its `bd show` also fed the explicit --class check).
 *  `fleet.router.provider` binds on the call surface; `enforce` gates
 *  on a typed resolved grade — a prose-grade entry under enforce is a
 *  config error naming provider + mode, never a silent demotion;
 *  `shadow` accepts prose — it journals, picks nothing. The pick
 *  answers *which lane*: enforce re-resolves on the picked class so
 *  ITS chain head and onWall rule apply — the table still owns the
 *  chain. JudgeUnavailable is "no verdict" — warn and stand. */
export async function applyFleetRouter(
  dir: string,
  env: AgentConnectorEnv,
  molStep: string,
  info:
    | { label?: string; priority?: number; title?: string; description?: string }
    | undefined,
  routed: ResolvedClass | undefined,
  opts: { fetch?: FetchFn; acp?: AcpSeam } = {}
): Promise<ResolvedClass | undefined> {
  const router = env.fleet?.router
  if (
    router === undefined ||
    router.mode === 'off' ||
    routed === undefined ||
    info === undefined ||
    info.label !== undefined
  ) {
    return routed
  }
  const routing = env.fleet!.routing!
  const providers = env.providers ?? {}
  let entry: ProviderEntry
  try {
    entry = requireProviderSurface(providers, router.provider, 'call')
  } catch (err) {
    if (err instanceof UnknownProviderError || err instanceof ProviderSurfaceError) {
      throw new SpawnError(`fleet.router.provider — ${err.message}`, 'config')
    }
    throw err
  }
  if (router.mode === 'enforce') {
    requireTypedRouterGrade(router.provider, entry)
  }
  // the judge + providers stack is heavy (the acp binding pulls the
  // SDK) — lazy-import it only when a router actually fires, the same
  // trick the acp spawn path above uses for @broject/providers
  const { chainedJudge, judgeConfig, providerJudge, routeClass } = await import('@broject/judge')
  const jcfg = judgeConfig(dir).judge
  const judge = chainedJudge(
    providerJudge(router.provider, entry, jcfg, {
      fetch: opts.fetch,
      acp: opts.acp,
      keyField: `providers.${router.provider}.apiKeyEnv`,
    }),
    undefined,
    { confidence: jcfg.confidence, timeoutMs: jcfg.timeoutMs }
  )
  let pick: string | undefined
  try {
    pick = await routeClass({
      dir,
      judge,
      molStep,
      state: { molStep, title: info.title ?? '', description: info.description ?? '' },
      routing,
      resolved: routed.class,
      mode: router.mode,
    })
  } catch (err) {
    if (err instanceof JudgeUnavailable) {
      console.error(
        `warning: fleet.router.provider "${router.provider}" — ${err.message}; class "${routed.class}" stands`
      )
      return routed
    }
    throw err
  }
  return pick === undefined ? routed : resolveStepClass(routing, providers, { class: pick, priority: info.priority })
}

/** enforce's typed-grade gate — a prose-grade call surface under
 *  'enforce' is a config error naming provider + mode, never a silent
 *  demotion ('shadow' accepts prose: it journals, picks nothing). */
function requireTypedRouterGrade(provider: string, entry: ProviderEntry): void {
  let grade: 'typed' | 'prose'
  try {
    grade = providerCallGrade(entry)
  } catch (err) {
    throw new SpawnError(
      `fleet.router.provider "${provider}" — ${err instanceof Error ? err.message : String(err)}`,
      'config'
    )
  }
  if (grade !== 'typed') {
    throw new SpawnError(
      `fleet.router.provider "${provider}" resolves to a prose-grade call surface — ` +
        `mode 'enforce' requires a typed judgment (a systemone-wire api model or a jev-family acp pin)`,
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
  'BRO_AGENT_CLASS',
  // delegation provenance is connector-owned too — a caller-supplied
  // BRO_DELEGATED_BY would let a spawn forge which agent asked for it
  'BRO_DELEGATED_BY',
])

/** Repo-retarget env keys — same triple core's git.ts strips for
 *  `git -C`. A spawn targets spec.worktree on argv alone; an inherited
 *  GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR silently points the agent's git
 *  calls at whatever checkout spawned bro (dogfood's scratch repo is
 *  exactly this failure shape). GIT_INDEX_FILE stays: data-ref writes
 *  use it as a private index. */
const GIT_REPOSITORY_ENV_KEYS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'])

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
  if (spec.class !== undefined) {
    pins.push(['BRO_AGENT_CLASS', spec.class])
  }
  if (spec.delegatedBy !== undefined) {
    pins.push(['BRO_DELEGATED_BY', spec.delegatedBy])
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

/** docker occupancy — a recorded death frees the slot regardless of
 *  the probe (a stopped entry was rm'd; an exitStatus means --rm
 *  already cleaned — neither can hold a live container). A name absent
 *  from the daemon's live list also frees; an inconclusive probe
 *  occupies (the daemon may hold a running worker we can't see — same
 *  honesty rule as tmux). */
function dockerOccupies(entry: AgentRegistryEntry, live: Set<string> | undefined): boolean {
  if (entry.stopped === true || entry.exitStatus !== undefined) {
    return false
  }
  const name = dockerContainerName(entry)
  return name !== undefined && (live === undefined || live.has(name))
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
    dockerLive: () => Set<string> | undefined
    copilotLive: () => Set<string> | undefined
  }
): boolean {
  switch (entry.backend) {
    case 'native': {
      // nativeState also harvests recorded death and retires stale
      // markers — the same side effects list() has on a dead entry.
      // 'spawned' occupies too: an unproven handoff is never a free
      // step (spec bro-l8c4f.5)
      const s = nativeState(dir, home, molStep, entry)
      return s === 'running' || s === 'spawned'
    }
    case 'tmux':
      return tmuxOccupies(entry, probes.tmuxLive())
    case 'gascity':
      return gcOccupies(molStep, entry, probes.gcSessions(), probes.gcSupervisor)
    case 'docker':
      // the .exit harvest first — a container that exited between the
      // ps snapshot and this read still lands its recorded cause; the
      // verdict itself only needs the live-name probe (a dead
      // container holds no slot either way)
      ensureExitCause(dir, home, molStep, entry)
      return dockerOccupies(entry, probes.dockerLive())
    case 'copilot':
      return copilotOccupies(entry, probes.copilotLive())
    case 'devin':
      // the devin connector never spawns — a registry row naming it is
      // hand-edited or migrated debris, and the session quota lives in
      // the devin plane, not the fleet cap. Holding a slot here would
      // stall legitimate spawns on a phantom forever
      return false
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
  dockerLive: () => Set<string> | undefined
  copilotLive: () => Set<string> | undefined
}

function occupancyProbes(dir: string, env: AgentConnectorEnv): OccupancyProbes {
  return {
    tmuxLive: memo(() => tmuxLiveSessions(env)),
    gcSessions: memo(() => {
      const city = gcConfigDir(dir, env)
      return city === null ? undefined : listGcSessions(city).sessions
    }),
    gcSupervisor: memo(() => gcSupervisorRunning()),
    dockerLive: memo(() => dockerLiveContainers()),
    copilotLive: memo(() => copilotLiveTaskIds()),
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

/** Provider walls — derived from the registry per spec bro-1x7p. The
 *  same lazy cause harvest the budget walk runs fires first, so an
 *  unharvested .exit still counts as a death (the harvest is a no-op
 *  on already-classified entries). One registry read per call, the
 *  per-plane convention. */
export function providerWallsFor(dir: string): ProviderWall[] {
  const registry = readAgentRegistry(dir)
  const home = agentsHome(dir)
  for (const [molStep, entry] of Object.entries(registry)) {
    ensureExitCause(dir, home, molStep, entry)
  }
  return deriveProviderWalls(registry)
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

/** The session-quota lane prepareSpawn admits through — the resolved
 *  plane plus the agents bag it reads its `agents.<kind>` knobs from.
 *  The plane owns how a live session is counted; core owns the
 *  serialized admit under the host-wide mutex. */
export interface SessionQuotaLane {
  plane: SessionPlane
  agents: Record<string, Record<string, unknown>>
}

/** The session kind a spawn consumes — `agents.<backend>.sessionKind`
 *  when declared (sessionQuotaOf then demands a registered plane),
 *  else the first registered plane that detects the resolved command's
 *  CLI (worker cliName / worker template / backend command). */
export function sessionKindOf(
  env: AgentConnectorEnv,
  backend: string,
  spec: SpawnSpec,
  command: string
): string | undefined {
  const declared = env.agents[backend]?.['sessionKind']
  if (typeof declared === 'string' && declared !== '') {
    return declared
  }
  // an argv worker's argv[0] is the DRIVER (bro acp-worker, npx) — the
  // wrapped agent's own cli rides cliName; argv0 is only the fallback
  const cli =
    spec.worker?.kind === 'argv'
      ? commandCliName(spec.worker.cliName ?? spec.worker.argv[0] ?? '')
      : commandCliName(spec.worker?.kind === 'template' ? spec.worker.command : command)
  return sessionPlaneForCli(cli)?.kind
}

/** The session quota this spawn must fit under — undefined when no
 *  plane claims the spawn or its `agents.<kind>` lane is uncapped, so
 *  the host scan only runs where it can refuse. */
export function sessionQuotaOf(
  env: AgentConnectorEnv,
  backend: string,
  spec: SpawnSpec,
  command: string
): SessionQuotaLane | undefined {
  const kind = sessionKindOf(env, backend, spec, command)
  if (kind === undefined) {
    return undefined
  }
  const quota = sessionQuotaConfig(env.agents, kind)
  if (quota === undefined) {
    return undefined
  }
  const plane = sessionPlane(kind)
  if (plane === undefined) {
    // a capped kind with no registered plane is a config bug — refuse
    // loudly rather than spawn past a quota the operator armed
    throw new SpawnError(
      `agents.${backend}.sessionKind '${kind}' has no registered session plane — ` +
        `cannot enforce agents.${kind}.maxSessions/maxWorkers`,
      'config'
    )
  }
  return { plane, agents: env.agents }
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
 *  claim state the write phase needs for claim-vs-rebind. `phantom`
 *  marks the agents-run `adhoc-` namespace (spec bro-fqen0): a minted
 *  `adhoc-<hex>` id is never a bead — no claim, the registry row is
 *  the only record. The prefix alone is not the predicate: a store
 *  CAN use `adhoc` as its issue prefix, minting real `adhoc-*` beads
 *  (codeant #583) — so an `adhoc-*` id that probes as a live bead
 *  takes the normal claim path. A probe miss stays phantom: minted
 *  ids are random (a real bead can't collide), and when the store is
 *  down no claim could land anyway — probeStep can't tell "missing"
 *  from "store down" (its catch is silent), so for every OTHER step
 *  the claim write still fails loud. `spec.claimRequired` (`run --for`,
 *  spec bro-7dila) disables the shortcut entirely: the caller promised
 *  a real bead, so a probe miss falls through to the claim write and
 *  fails on the missing id instead of minting unclaimed work. */
function guardClaim(
  spec: SpawnSpec,
  hasEntry: boolean,
  claimAs: string | undefined
): { claimed: boolean; actor: string | undefined; phantom: boolean } {
  const step = probeStep(spec.beadsDir, spec.molStep)
  if (spec.claimRequired !== true && spec.molStep.startsWith('adhoc-') && step === undefined) {
    return { claimed: false, actor: undefined, phantom: true }
  }
  if (step?.status !== 'in_progress') {
    return { claimed: false, actor: undefined, phantom: false }
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
  return { claimed: true, actor, phantom: false }
}

/* Dedup correlates both planes: a claim alone is not a conflict — a
 *  crashed worker's stale in_progress must not block respawn — and a
 *  live agent alone is not spawnable-over either. The registry entry
 *  goes in FIRST: every later failure (claim refused, spawn error)
 *  leaves a respawn-able 'lost' entry instead of a foreign claim that
 *  can never be rebound. `opts.isLive` is the backend's liveness probe
 *  on an existing entry; `opts.entry` merges backend-private fields
 *  (tmux's session name) into the patch. */
/** The refusal a BATCH spawn gets when its provider is walled.
 *
 * A rate-limited death is a fact about the ACCOUNT, not about the agent
 * that died: the per-agent respawn guard only covers that molStep, so
 * the next fleet spawn walks into the same wall (observed 2026-10-20 —
 * five fixers died `rate_limited` in a row, each a fresh step). The wall
 * is DERIVED from the registry (spec bro-1x7p: walls derived, not
 * stored) and it is the fleet's problem: the interactive lane is not
 * blocked (spec bro-9h86l).
 *
 * Returns undefined when the spawn may proceed. */
export function batchWallRefusal(
  registry: Record<string, AgentRegistryEntry>,
  spec: { provider?: string; env?: Record<string, string>; molStep?: string },
  now: number = Date.now()
): SpawnError | undefined {
  if (spec.provider === undefined || !isBatchSpawn(spec.env)) {
    return undefined
  }
  const wall = deriveProviderWalls(registry, now).find((w) => w.provider === spec.provider)
  if (wall === undefined) {
    return undefined
  }
  const til = wall.until !== undefined ? ` til ${wall.until}` : ''
  return new SpawnError(
    `${wall.provider} walled — ${wall.cause}${til} ` +
      `(the batch lane waits; an interactive spawn is not blocked)` +
      (spec.molStep !== undefined ? ` — spawn of ${spec.molStep} refused` : ''),
    'cap'
  )
}

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
    /** Session-kind admission — the spawn consumes one of the lane
     *  plane's sessions and refuses when live ones already hit
     *  `agents.<kind>.maxSessions`. The count+claim runs under ONE
     *  host-wide mutex (the repo's registry lock can't serialize
     *  cross-repo), still before any write — a refused spawn leaves no
     *  half-state. */
    sessionQuota?: SessionQuotaLane | undefined
  }
): {
  agentId: string
  promptFile: string
  log: string
  stderrLog: string
  exitFile: string
  /** The attempt token — scopes this run's handle/go/exit artifacts. */
  runId: string
  reservation?: string
} {
  // spawn is the authoritative mutation the audit gates on — invalid
  // committed (policy) config refuses before registry/claim writes,
  // ahead of even the exit-cause harvest (spec: bro-d9dmx)
  assertMutableConfig(dir)
  const registry = readAgentRegistry(dir)
  const existing = registry[spec.molStep]
  // A batch spawn must not walk into a provider wall the fleet already
  // hit. The wall is DERIVED from the registry (spec bro-1x7p: walls
  // derived, not stored) and it is an ACCOUNT fact: one rate-limited
  // death walls the provider for every fleet spawn, not just the agent
  // that died. The interactive lane is not blocked — a wall the fleet hit
  // is the fleet's problem (spec bro-9h86l).
  guardExistingEntry(dir, home, backend, spec, existing, opts)
  // The wall is derived from the registry — so the registry must carry
  // the CAUSE: an agent that died with a rate limit but whose .exit
  // was not harvested yet reads as cause-less, and the fleet walks into
  // the wall it just hit. Harvest first, then derive.
  for (const [step, entry] of Object.entries(registry)) {
    ensureExitCause(dir, home, step, entry)
  }
  // the wall refusal comes AFTER the live-agent and claim guards: a
  // respawn of an agent that is already running is a CONFLICT, and so is
  // a step another owner already claimed — the caller reads those kinds,
  // and a 'cap' here would say "the provider is walled" about a spawn
  // that never needed a provider slot
  const { claimed, actor, phantom } = guardClaim(spec, existing !== undefined, opts.claimAs)
  const wallRefusal = batchWallRefusal(registry, spec)
  if (wallRefusal !== undefined) {
    throw wallRefusal
  }
  // fleet admission — before the registry write + claim land, so a
  // refusal leaves no half-spawned state
  enforceFleetCap(dir, home, registry, spec, opts.cap)
  // a reused id must stay filename-safe — a tampered entry gets a fresh
  // mint, not a path escape into <home>/
  const agentId =
    existing !== undefined && SAFE_AGENT_ID.test(existing.agentId)
      ? existing.agentId
      : mintAgentId(backend)
  // session-kind admission — count + slot claim under ONE host-wide
  // mutex: the registry lock above is per-repo and cannot serialize a
  // cross-repo check-then-reserve. A refusal leaves no half-spawned
  // state; an admit means the next spawn anywhere sees the slot taken.
  const reservation =
    opts.sessionQuota === undefined
      ? undefined
      : admitSessionSlot(opts.sessionQuota.plane, opts.sessionQuota.agents, {
          key: agentId,
          molStep: spec.molStep,
          workerEnv: spec.env,
        })
  try {
    // enter half of the rig transition — inside the try so an enter
    // failure also hands the session-quota reservation back via the
    // catch below
    enterSpawnTree(spec)
    return {
      agentId,
      ...commitSpawn(dir, home, backend, spec, opts, agentId, {
        claimed,
        actor,
        phantom,
      }),
      reservation,
    }
  } catch (err) {
    // a write/claim failure after the reservation — the caller never saw
    // the key, so this is the only place that can hand the slot back
    if (reservation !== undefined) {
      releaseSessionSlot(reservation)
    }
    throw err
  }
}

/** The write phase of a spawn — prompt/log/exit files, the registry
 *  row, then claim bookkeeping. Split from the guard/admission phase
 *  so a refused spawn leaves no half-state and a caller-side
 *  reservation can be handed back on failure. */
function commitSpawn(
  dir: string,
  home: string,
  backend: string,
  spec: SpawnSpec,
  opts: {
    entry?: (agentId: string) => Record<string, unknown>
    claimAs?: string
    sessionQuota?: SessionQuotaLane | undefined
  },
  agentId: string,
  guard: { claimed: boolean; actor: string | undefined; phantom: boolean }
): {
  promptFile: string
  log: string
  stderrLog: string
  exitFile: string
  runId: string
} {
  mkdirPrivateSync(home)
  const promptFile = join(home, `${agentId}.prompt.md`)
  const log = join(home, `${agentId}.log`)
  const stderrLog = join(home, `${agentId}.stderr`)
  // every attempt mints its own runId — respawns reuse the agentId but
  // never the attempt artifacts: an old wrapper's late writes land in
  // its own runId's files, never the live run's (spec bro-l8c4f.5)
  const runId = mintRunId()
  const exitFile = join(home, agentExitFileName(agentId, runId))
  rmSync(exitFile, { force: true })
  // a pre-handshake run's legacy exit file would alias nothing the new
  // run reads — still drop it so old readers can't resurrect it
  rmSync(join(home, `${agentId}.exit`), { force: true })
  // owner-only artifacts (spec bro-l8c4f.4): the prompt carries secrets
  // and thread context; the streams get pre-created pinned so every
  // later append — native's inherited fd, tmux's tee/2>>, docker's
  // >>/2>> — lands on an already-0600 file. The .exit file can't be
  // pre-created (readExitFile parses empty as exit 0); the wrapper's
  // `umask 077` subshell pins it at write time instead.
  writePrivateFileSync(promptFile, spec.prompt)
  appendPrivateFileSync(log, '')
  appendPrivateFileSync(stderrLog, '')
  const logFrom = logSizeOrZero(log)
  const stderrFrom = logSizeOrZero(stderrLog)
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
    // the worker's stderr lands in a sibling capture, never the .log —
    // the .log stays the agent-updates stream; the classifier still
    // reads this tail so provider walls classify (spec bro-e2ec0)
    stderrLog,
    stderrFrom,
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
    // the routing lane the spawn resolved to (fleet.routing class) —
    // same provenance write as provider/model; a respawn re-stamps it
    class: spec.class,
    // which agent asked for this spawn — same provenance write; a
    // respawn re-stamps (clears when the respawn wasn't delegated)
    delegatedBy: spec.delegatedBy,
    // the acp driver patches the real session id after session/new —
    // clear the previous run's so it never masquerades as this run's
    acpSessionId: undefined,
    // the session kind this run consumed — the quota lane it was
    // admitted under; absent for non-kind spawns
    sessionKind: opts.sessionQuota?.plane.kind,
    // the attempt token — scopes handle/go/exit artifacts (spec
    // bro-l8c4f.5); a respawn stamps a fresh one over the dead run's
    runId,
    ...opts.entry?.(agentId),
  })
  recordSpawnClaim(dir, spec, agentId, backend, guard, opts.claimAs)
  return { promptFile, log, stderrLog, exitFile, runId }
}

/** The byte offset a fresh run's log starts at — the log is append-mode
 *  across respawns, so a later exit must classify on THIS run's text
 *  only, not the old run's rate-limit wall (which would re-block the
 *  fresh run forever). No log yet → byte 0. */
function logSizeOrZero(log: string): number {
  try {
    return statSync(log).size
  } catch {
    return 0
  }
}

/** Post-write claim bookkeeping — claim or rebind the step, then emit
 *  the lifecycle events (specs/telemetry/bro-ub91h.md); fail-open, so a
 *  wedged journal never stalls a spawn. A phantom step records the
 *  spawn only — there is no bead whose status a 'claim' event could
 *  truthfully report. */
function recordSpawnClaim(
  dir: string,
  spec: SpawnSpec,
  agentId: string,
  backend: string,
  guard: { claimed: boolean; actor: string | undefined; phantom: boolean },
  claimAs: string | undefined
): void {
  if (guard.claimed) {
    rebindStep(spec.beadsDir, spec.molStep, guard.actor!)
  } else if (!guard.phantom) {
    claimStep(spec.beadsDir, spec.molStep)
  }
  if (claimAs !== undefined && !guard.phantom) {
    rebindStep(spec.beadsDir, spec.molStep, claimAs)
  }
  if (!guard.phantom) {
    emitLifecycle(dir, {
      kind: 'claim',
      bead: spec.molStep,
      from: guard.claimed || claimAs !== undefined ? 'in_progress' : 'open',
      to: 'in_progress',
      detail: { via: 'agents', agent: agentId, backend },
    })
  }
  emitLifecycle(dir, {
    kind: 'spawn',
    bead: spec.molStep,
    to: 'spawned',
    detail: {
      via: 'agents',
      agent: agentId,
      backend,
      worktree: resolve(spec.repoRoot),
      ...(spec.provider !== undefined ? { provider: spec.provider } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.class !== undefined ? { class: spec.class } : {}),
    },
  })
}

/** The enter half of the rig transition (bro-oy3k1.4): spec.enter is
 *  set when no worktree resolved — mint the conventional sibling under
 *  the registry lock this caller already holds, before the registry
 *  write and claimStep land. Runs AFTER every refuse path so a refusal
 *  never mints a tree; a retire waits on this same lock. The bead
 *  claim stays with claimStep — the worker's, never the session's. */
function enterSpawnTree(spec: SpawnSpec): void {
  if (spec.enter === undefined || existsSync(spec.repoRoot)) {
    return
  }
  let entered
  try {
    entered = enterWorktree({
      slug: spec.molStep,
      branch: spec.enter.branch,
      base: spec.enter.base,
      main: {
        path: spec.enter.mainPath,
        branch: spec.enter.mainBranch,
        head: spec.enter.mainHead ?? '',
        bare: false,
        detached: spec.enter.mainBranch === undefined,
      },
      throws: true,
      beadClaim: false,
      preLocked: true,
      reusePath: true,
    })
  } catch (err) {
    throw new SpawnError(
      `worktree enter failed — ${err instanceof Error ? err.message : String(err)}`,
      'conflict'
    )
  }
  if (entered.gone === true) {
    throw new SpawnError(`${spec.repoRoot} was retired mid-enter — retry the spawn`, 'conflict')
  }
  if (entered.claimLockTimedOut === true) {
    throw new SpawnError(
      `claim lock for ${spec.repoRoot} timed out — a driver may still be mid-retire; retry`,
      'conflict'
    )
  }
}

/** Exit status the wrapper dropped — at the attempt-scoped
 *  `<agentId>.<runId>.exit` for runId'd entries, the legacy
 *  `<agentId>.exit` otherwise (spec bro-l8c4f.5). Absent when the
 *  process is still running or died by SIGKILL (nothing to write with). */
function readExitFile(home: string, agentId: string, runId?: string): number | undefined {
  try {
    const v = readFileSync(join(home, agentExitFileName(agentId, runId)), 'utf8').trim()
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
/** The provider's wall — an ACCOUNT fact, not this agent's: every lane
 *  member shares the budget, so the fleet must see it (spec bro-g0izo).
 *  Only the devin lane — another provider's wall is not this lane's. */
function emitProviderWall(
  entry: AgentRegistryEntry,
  molStep: string,
  cause: string,
  resetAt: string | undefined
): void {
  if (cause !== 'rate_limited' && cause !== 'quota') {
    return
  }
  if (entry.sessionKind !== 'devin') {
    return
  }
  try {
    otelEvent('lane.devin.wall', {
      provider: typeof entry.provider === 'string' ? entry.provider : 'unknown',
      cause,
      until: resetAt ?? '',
      agent: entry.agentId,
      step: molStep,
    })
  } catch {
    // telemetry must not stall the harvest
  }
}

function ensureExitCause(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry
): void {
  if (entry.exitStatus === undefined && home !== null) {
    const code = readExitFile(home, entry.agentId, entryRunId(entry))
    if (code !== undefined) {
      entry.exitStatus = code
    }
  }
  if (typeof entry.exitStatus !== 'number' || isAgentCause(entry.cause)) {
    return
  }
  // classification input = this run's .log tail + .stderr tail (spec
  // bro-e2ec0) — provider walls the child prints on stderr classify from
  // the capture, the event stream no longer carries them. The tails
  // classify INDEPENDENTLY — a joined read could fabricate a wall token
  // across the boundary ('…4' + '29…' → '429')
  const c = classifyExitCauseParts(
    [readLogTail(entry.log, entry.logFrom), readLogTail(entry.stderrLog, entry.stderrFrom)],
    entry.exitStatus
  )
  // the tails were read off-lock — a respawn stamping the entry between
  // the two reads feeds the old run new-run bytes; a DIFFERENT
  // generation owning the step now suppresses classify + emit. A
  // missing row (reaped, or a caller's synthesized snapshot) can't
  // inject new bytes — classify anyway
  const cur = readAgentRegistry(dir)[molStep]
  if (
    cur !== undefined &&
    (cur.agentId !== entry.agentId || cur.spawnedAt !== entry.spawnedAt)
  ) {
    return
  }
  entry.cause = c.cause
  entry.resetAt = c.resetAt
  emitProviderWall(entry, molStep, c.cause, c.resetAt)
  // lifecycle — the agent-exit transition, emitted once per run at the
  // harvest (the early return above skips re-emit on a carried cause).
  // The .exit file's mtime is the honest wall-clock; the harvest's own
  // clock can land a poll late (specs/telemetry/bro-ub91h.md)
  let exitAt: number | undefined
  if (home !== null) {
    try {
      exitAt = statSync(join(home, agentExitFileName(entry.agentId, entryRunId(entry)))).mtimeMs
    } catch {
      // the file rotated between read and stat — fall back to now
    }
  }
  emitLifecycle(dir, {
    kind: 'agent-exit',
    bead: molStep,
    actor: entry.agentId,
    session: entry.agentId,
    from: 'running',
    to: agentEntryBlocked(entry) ? 'blocked' : 'exited',
    ts: exitAt,
    detail: {
      via: 'agents',
      agent: entry.agentId,
      backend: entry.backend,
      code: entry.exitStatus,
      cause: c.cause,
    },
  })
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
  // spec.enter means prepareSpawn mints repoRoot inside the lock — the
  // tree legitimately doesn't exist yet; the post-create state is the
  // check that matters (it throws conflict on gone/lock-timeout)
  if (spec.enter === undefined && !existsSync(spec.repoRoot)) {
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

/** The wrapper's death is not its unit's death: a TERM-resistant
 *  descendant survives the group signal, so the stop may only record
 *  `stopped` when the WHOLE execution unit is gone, not the sh-wrapper
 *  alone (bro-l8c4f.3). kill(-pgid, 0) gates — ESRCH is a group that
 *  no longer exists (ESRCH-or-hard-failure reads dead, the rule
 *  pidAlive applies; EPERM is a live group we cannot signal) — but it
 *  also counts the unreaped wrapper's own zombie, so live members are
 *  read from /proc the way procStat reads one process: state 'Z' is
 *  nobody. `minStart` (the wrapper's recorded pidStart) bounds a
 *  member's /proc starttime from below — our descendants forked after
 *  the wrapper, so a member older than it belongs to a pgid the kernel
 *  recycled after our group died, not to this unit.
 *
 *  Two edges where the probe cannot answer, and the answer differs by
 *  platform: on Linux a vanished /proc, or a member stat that fails
 *  for any reason but ENOENT, stays fail-open (pidAlive's rule: never
 *  a false "the unit is dead"); off Linux /proc never exists at all,
 *  so the group probe cannot tell the wrapper's zombie from a live
 *  member — there the caller's pid check is the probe, and a
 *  descendant that outlives its wrapper is a documented blind spot
 *  (failing open would spin the whole kill-wait on EVERY stop and the
 *  `stopped` marker would never land). */
/** One parsed row of /proc/<pid>/stat — post-comm fields split the way
 *  procStat does (index 0 = state/field 3). */
interface ProcEntry {
  pid: number
  state: string
  ppid: number
  pgrp: number
  start: string
}

/** One shared scan of /proc for the group and tree probes — `null`
 *  when /proc itself is unreadable; `unverified` marks at least one
 *  non-ENOENT stat failure (a process we could not inspect). */
function scanProc(): { entries: ProcEntry[]; unverified: boolean } | null {
  let names: string[]
  try {
    names = readdirSync('/proc')
  } catch {
    return null
  }
  const entries: ProcEntry[] = []
  let unverified = false
  for (const name of names) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid <= 0) {
      continue
    }
    let stat: string
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch (e) {
      // ENOENT/ENOTDIR is the process vanishing mid-scan — anything
      // else (EACCES under hidepid, …) is a process we could not inspect
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        unverified = true
      }
      continue
    }
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // rest: state, ppid, pgrp, … — the same split procStat uses
    entries.push({
      pid,
      state: rest[0] ?? '',
      ppid: Number(rest[1]),
      pgrp: Number(rest[2]),
      start: rest[19] ?? '',
    })
  }
  return { entries, unverified }
}

function groupMemberAlive(pgid: number, minStart?: string): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return false
  }
  try {
    process.kill(-pgid, 0)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') {
      return false
    }
  }
  const scan = scanProc()
  if (scan === null) {
    return process.platform === 'linux'
  }
  const min = minStart === undefined ? Number.NaN : Number(minStart)
  for (const e of scan.entries) {
    if (e.state === 'Z' || e.pgrp !== pgid) {
      continue
    }
    const start = Number(e.start)
    if (!Number.isFinite(min) || !(start > 0) || start >= min) {
      return true
    }
  }
  // no confirmed member — but a process we could not inspect might be
  // one: fail open, never a false "the unit is dead"
  return scan.unverified
}

/** The wrapper's process-TREE snapshot — every descendant pid plus its
 *  /proc starttime, walked over ppid links. A descendant that escaped
 *  the process GROUP (setsid, its own session) is invisible to
 *  groupMemberAlive but stays in this list: the tree link breaks when
 *  the wrapper dies and the survivor reparents to init, so the
 *  snapshot must be taken while the parentage is still intact, and
 *  pid+starttime identity is what keeps a recycled pid from faking
 *  death. Empty where /proc is absent (non-Linux). */
function descendantsOf(root: number): Array<{ pid: number; start?: string }> {
  const scan = scanProc()
  if (scan === null) {
    return []
  }
  const children = new Map<number, number[]>()
  const starts = new Map<number, string>()
  for (const e of scan.entries) {
    const list = children.get(e.ppid)
    if (list === undefined) {
      children.set(e.ppid, [e.pid])
    } else {
      list.push(e.pid)
    }
    if (e.start !== '') {
      starts.set(e.pid, e.start)
    }
  }
  const out: Array<{ pid: number; start?: string }> = []
  const seen = new Set<number>([root])
  const queue = [root]
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    for (const c of children.get(cur) ?? []) {
      if (seen.has(c)) {
        continue
      }
      seen.add(c)
      out.push({ pid: c, start: starts.get(c) })
      queue.push(c)
    }
  }
  return out
}

/** Live state for a registry entry under this backend. */
function nativeState(dir: string, home: string | null, molStep: string, entry: AgentRegistryEntry): AgentState {
  // liveness first: a 'stopped' marker on a pid that is still alive means
  // SIGTERM hasn't landed yet — the agent IS still running, and dedup
  // must keep refusing a respawn that would run alongside it. The unit,
  // not the wrapper: a dead wrapper's group can still hold a
  // TERM-resistant descendant, and reporting lost/exited over it would
  // admit a respawn beside a live writer (bro-l8c4f.3). kill(-pgid,0)
  // short-circuits before any /proc scan, so dead-group entries — the
  // common stale row — cost one syscall; the wrapper's pidStart bounds
  // members so a recycled pgid can't fake liveness.
  const pid = typeof entry.pid === 'number' ? entry.pid : undefined
  if (
    pid !== undefined &&
    (pidAlive(pid, entryPidStart(entry)) || groupMemberAlive(pid, entryPidStart(entry)))
  ) {
    touchWorkMarker(dir, entry.agentId)
    return 'running'
  }
  const dead = recordedDeath(dir, home, molStep, entry)
  if (dead !== undefined) {
    return dead
  }
  // no pid ≠ lost: inside the spawn handoff the worker may be
  // mid-handshake. A live self-published handle adopts the survivor
  // outright (spec bro-l8c4f.5); a missing one inside the window is
  // 'spawned' — reserved/starting, and unknown is never a free step.
  if (adoptNativeHandle(dir, home, molStep, entry) !== undefined) {
    touchWorkMarker(dir, entry.agentId)
    return 'running'
  }
  if (
    pid === undefined &&
    // only handshake-era rows get the handoff grace — a pre-runId
    // pid-less row could never be mid-handshake and stays 'lost'
    entryRunId(entry) !== undefined &&
    Date.now() - Date.parse(entry.spawnedAt) < SESSION_SLOT_TTL_MS
  ) {
    return 'spawned'
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

/** provider/model/class provenance — absent fields read as a legacy
 *  (or unrouted) spawn (the row says so by omission, honestly). */
const infoProvenance = (
  entry: AgentRegistryEntry
): Pick<AgentInfo, 'provider' | 'model' | 'class' | 'delegatedBy'> => ({
  provider: typeof entry.provider === 'string' ? entry.provider : undefined,
  model: typeof entry.model === 'string' ? entry.model : undefined,
  class: typeof entry.class === 'string' ? entry.class : undefined,
  delegatedBy: typeof entry.delegatedBy === 'string' ? entry.delegatedBy : undefined,
})

function toInfo(dir: string, home: string | null, molStep: string, entry: AgentRegistryEntry): AgentInfo {
  // state first — the handshake adoption stamps entry.pid on the way
  // through (spec bro-l8c4f.5); reading pid before it would report the
  // pre-adoption row
  const state = nativeState(dir, home, molStep, entry)
  return {
    id: entry.agentId,
    spawnedAt: typeof entry.spawnedAt === 'string' ? entry.spawnedAt : undefined,
    runId: entryRunId(entry),
    pid: typeof entry.pid === 'number' ? entry.pid : undefined,
    molStep,
    backend: entry.backend,
    state,
    ...infoCause(entry),
    ...infoProvenance(entry),
    worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
    log: typeof entry.log === 'string' ? entry.log : undefined,
    stderrLog: typeof entry.stderrLog === 'string' ? entry.stderrLog : undefined,
  }
}

/** Positional append is the documented contract for file-arg agent CLIs,
 *  but a TUI-capable CLI (devin, claude) spawned without the placeholder
 *  opens an interactive session carrying the file PATH as its prompt —
 *  surface the likely config typo instead of silently spawning TUIs.
 *  argv workers are exempt: they append the file as an argv slot, never
 *  string-append it. */
function warnNoPromptFile(worker: SpawnWorker | undefined, command: string): void {
  if (worker?.kind === 'argv') {
    return
  }
  const cmd = worker?.kind === 'template' ? worker.command : command
  if (!cmd.includes('{promptFile}')) {
    console.error(
      'bro agents: configured command has no {promptFile} placeholder — ' +
        'the prompt file appends as a positional arg; interactive CLIs ' +
        '(devin, claude) treat that as a TUI session, not a worker prompt'
    )
  }
}

/** The cli a worker carries for provenance — the configured command's
 *  name, an argv worker's own cliName, or a template worker's. */
function workerCliBadge(worker: SpawnWorker | undefined, command: string): string | undefined {
  if (worker === undefined) {
    return commandCliName(command)
  }
  return worker.kind === 'argv' ? worker.cliName : commandCliName(worker.command)
}

/** The shell line a worker runs — a template expansion, an argv worker
 *  single-quoted slot by slot (the provider argv never re-parses into
 *  a different program), or the configured command's expansion. */
function workerRunLine(
  worker: SpawnWorker | undefined,
  command: string,
  promptFile: string
): string {
  if (worker === undefined) {
    return expandAgentCmd(command, promptFile)
  }
  return worker.kind === 'argv'
    ? [...worker.argv, promptFile].map(shQuote).join(' ')
    : expandAgentCmd(worker.command, promptFile)
}

/** The durable spawn handshake (spec bro-l8c4f.5). A launcher killed
 *  between `spawn()` and the pid patch used to leave a live worker the
 *  registry could not name — a 'lost' step and a respawn running beside
 *  it. The worker now self-publishes its handle and the launcher
 *  answers with an admission stamp:
 *
 *  - `<agentId>.<runId>.handle` — the wrapper's first act: `$$` (the
 *    detached group-leader pid — the same value `child.pid` reports). A
 *    parent that dies post-spawn leaves a findable survivor.
 *  - `<agentId>.<runId>.go` — the launcher's stamp, written only after
 *    pid+marker are durable. The worker polls for it through the
 *    spawn-handoff window; absent past the window means the launcher
 *    died mid-publish, so the payload must never run (exit 75). */
const GO_WAIT_TICK_MS = 50
const GO_WAIT_TICKS = SESSION_SLOT_TTL_MS / GO_WAIT_TICK_MS

/** The wrapper's half of the handshake — positional args
 *  `$1` exit · `$2` handle · `$3` go · `$4` go-wait tick budget. Handle
 *  publish is tmp+rename so a reader never sees a half-written pid. */
const HANDSHAKE_SCRIPT =
  'out=$1; h=$2; g=$3; t=$4; ' +
  '( umask 077; printf %s "$$" > "$h.tmp" ) && mv "$h.tmp" "$h" ' +
  '|| { ( umask 077; printf %s 74 > "$out" ); exit 74; }; ' +
  'i=0; until [ -f "$g" ]; do ' +
  'i=$((i+1)); [ "$i" -gt "$t" ] && { ( umask 077; printf %s 75 > "$out" ); exit 75; }; ' +
  `sleep ${GO_WAIT_TICK_MS / 1000}; ` +
  'done;'

/** Where a launcher crash would stop — the seam leaves exactly the
 *  half-state a dead parent leaves: registry+claim only (`reservation`),
 *  plus a live self-publishing child (`os-spawn`), plus the pid patch
 *  and work marker (`publication`). Production never arms this. */
export type SpawnAbandonAt = 'reservation' | 'os-spawn' | 'publication'

/** Thrown at the armed point — the test's signal that the parent would
 *  have died there; the spawned child and registry state are what a
 *  real crash leaves behind. */
export class SpawnAbandoned extends Error {
  override name = 'SpawnAbandoned'
  constructor(readonly at: SpawnAbandonAt) {
    super(`spawn abandoned at ${at} (test seam)`)
  }
}

const spawnTestSeam: { abandonAt?: SpawnAbandonAt; goWaitTicks?: number } = {}

/** Arm the crash-window failpoints (spec bro-l8c4f.5) — tests only:
 *  `abandonAt` throws SpawnAbandoned mid-section exactly where a
 *  launcher crash would cut it, `goWaitTicks` shrinks the worker's
 *  admission wait so the timeout path runs inside a test budget. */
export function armNativeSpawnTestSeam(seam: {
  abandonAt?: SpawnAbandonAt
  goWaitTicks?: number
}): void {
  spawnTestSeam.abandonAt = seam.abandonAt
  spawnTestSeam.goWaitTicks = seam.goWaitTicks
}

const maybeAbandonSpawn = (at: SpawnAbandonAt): void => {
  if (spawnTestSeam.abandonAt === at) {
    throw new SpawnAbandoned(at)
  }
}

/** The `<agentId>.<runId>.{handle,go}` paths for one attempt — the
 *  handle is the worker's durable self-registration, the go stamp the
 *  launcher's admission answer. */
function attemptHandles(
  home: string,
  agentId: string,
  runId: string
): { handleFile: string; goFile: string } {
  return {
    handleFile: join(home, `${agentId}.${runId}.handle`),
    goFile: join(home, `${agentId}.${runId}.go`),
  }
}

/** Adopt a survivor: the entry's pid patch never landed, but the
 *  worker published its own handle before the launcher died. A live
 *  handle stamps pid+pidStart into the entry — under the same
 *  generation guard the exit harvest uses, so a respawned entry is
 *  never adopted into — and returns the pid so status/down reach the
 *  worker and dedup keeps refusing beside it. */
function adoptNativeHandle(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry
): { pid: number; start: string | null } | undefined {
  const runId = entryRunId(entry)
  if (
    home === null ||
    runId === undefined ||
    entry.backend !== 'native' ||
    basename(entry.agentId) !== entry.agentId // '../' must never escape the agents home
  ) {
    return undefined
  }
  let pid: number
  try {
    pid = Number(
      readFileSync(attemptHandles(home, entry.agentId, runId).handleFile, 'utf8').trim()
    )
  } catch {
    return undefined
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined
  }
  const start = procStat(pid)?.start ?? null
  if (!pidAlive(pid, start ?? undefined)) {
    return undefined
  }
  // the handle file is runId-scoped — its pid IS this attempt's, so the
  // in-memory row adopts it unconditionally (the AgentInfo built from
  // it carries the pid to status/down)
  entry.pid = pid
  entry.pidStart = start
  try {
    withAgentRegistryLock(dir, () => {
      const reg = readAgentRegistry(dir)
      const cur = reg[molStep]
      // a respawn owns the entry now — the handle belongs to a dead
      // generation and must not stamp the new run's fields
      if (
        cur === undefined ||
        cur.agentId !== entry.agentId ||
        cur.spawnedAt !== entry.spawnedAt ||
        cur.runId !== entry.runId
      ) {
        return
      }
      reg[molStep] = { ...cur, pid, pidStart: start }
      writeAgentRegistry(dir, reg)
    })
  } catch {
    // the registry stamp is advisory — the handle still proves liveness
  }
  return { pid, start }
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
      // policy before preflight — a refused spawn must not run even the
      // harmless probes (prepareSpawn re-checks inside the lock for the
      // claim/registry writes)
      assertMutableConfig(dir)
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
        const { agentId, promptFile, log, stderrLog, exitFile, runId, reservation } =
          prepareSpawn(dir, home, 'native', spec, {
            // 'spawned' counts as live for dedup: inside the handoff
            // window a pid-less entry may still be a worker about to
            // publish its handle — a respawn beside it is the
            // crash-window bug (spec bro-l8c4f.5)
            isLive: (e) => {
              const s = nativeState(dir, home, spec.molStep, e)
              return s === 'running' || s === 'spawned'
            },
            liveDetail: (e) =>
              typeof e.pid === 'number' ? `pid ${e.pid}` : 'spawn handoff in flight',
            cap: { max: fleetCapOf(env), env },
            sessionQuota: sessionQuotaOf(env, 'native', spec, command),
          })
        // the launcher crashed after the reservation — registry+claim
        // landed, no OS child ever ran (spec bro-l8c4f.5 failpoint)
        maybeAbandonSpawn('reservation')
        const { handleFile, goFile } = attemptHandles(home, agentId, runId)
        // the worker's stderr gets its own append fd — the .log stays
        // the agent-updates stream; the child/agent noise (and every
        // template worker's diagnostics) lands in .stderr (bro-e2ec0).
        // Both open INSIDE the guard — a throw must hand the session
        // reservation back like any other spawn failure, not strand it.
        let fd: number | undefined
        let errFd: number | undefined
        let spawned: AgentRegistryEntry
        try {
          fd = openPrivateAppendSync(log)
          errFd = openPrivateAppendSync(stderrLog)
          // the wrapper captures $? into the .exit file — the only exit
          // record a detached process can leave once the parent is gone.
          // The write targets the literal quoted path, never $out: a
          // 'template' payload runs in this shell's scope and assigning
          // `out` would retarget the exit write (the shape tmux/docker
          // already use).
          // Worker payloads (spec bro-5hx1.1): a 'template' worker's
          // command substitutes for the backend's own template; an
          // 'argv' worker execs verbatim through the wrapper's "$@"
          // positional passthrough — the provider argv (a `model` value
          // could carry shell metachars) is never string-concatenated.
          const worker = spec.worker
          warnNoPromptFile(worker, command)
          // the handshake runs before the payload: the worker publishes
          // its own handle, then holds on the launcher's go stamp — a
          // launcher that died mid-publish never admits it (75), so a
          // survivor can never silently double a respawn (spec
          // bro-l8c4f.5)
          const goTicks = String(spawnTestSeam.goWaitTicks ?? GO_WAIT_TICKS)
          const args =
            worker?.kind === 'argv'
              ? [
                  '-c',
                  `${HANDSHAKE_SCRIPT} shift 4; "$@"; s=$?; ( umask 077; printf %s "$s" > ${shQuote(exitFile)} )`,
                  'bro-agent',
                  exitFile,
                  handleFile,
                  goFile,
                  goTicks,
                  ...worker.argv,
                  promptFile,
                ]
              : [
                  '-c',
                  `${HANDSHAKE_SCRIPT} ${expandAgentCmd(worker?.kind === 'template' ? worker.command : command, promptFile)}; s=$?; ( umask 077; printf %s "$s" > ${shQuote(exitFile)} )`,
                  'bro-agent',
                  exitFile,
                  handleFile,
                  goFile,
                  goTicks,
                ]
          const cliBadge = workerCliBadge(worker, command)
          const child = spawn(
            'sh', // NOSONAR — PATH lookup is the contract (same as git/bd everywhere)
            args,
            { // NOSONAR — operator-configured agent command (same contract as loop)
              cwd: spec.repoRoot,
              env: {
                // ambient env minus the connector-owned pins — every
                // other backend filters AGENT_PIN_KEYS out of
                // ambient/spec env already (tmux's 0600 env file,
                // gascity's args); without it a worker-spawned `bro
                // agents up`/`bro loop` would bleed the parent's
                // BRO_AGENT_*/BRO_MOL_ID provenance into the child's
                // commit trailers (bro-fzot's exact bug shape)
                // The ambient env and the caller's env are filtered
                // SEPARATELY: the fleet's marker may only come from the
                // caller (spec.env). Inherited from the ambient env it
                // would charge a worker's own children — an interactive
                // session — to the fleet's budget.
                ...Object.fromEntries(
                  Object.entries(process.env).filter(
                    (e): e is [string, string] =>
                      e[1] !== undefined &&
                      !AGENT_PIN_KEYS.has(e[0]) &&
                      !GIT_REPOSITORY_ENV_KEYS.has(e[0]) &&
                      e[0] !== BATCH_MARKER_ENV
                  )
                ),
                ...Object.fromEntries(
                  Object.entries(spec.env ?? {}).filter(
                    (e): e is [string, string] =>
                      e[1] !== undefined &&
                      !AGENT_PIN_KEYS.has(e[0]) &&
                      !GIT_REPOSITORY_ENV_KEYS.has(e[0])
                  )
                ),
                // identity pins last — spec.env must never redirect the
                // claim store or re-badge the worker as another bead/agent
                ...Object.fromEntries(
                  agentEnvPins(spec, agentId, promptFile, cliBadge, mol)
                ),
              },
              stdio: ['ignore', fd, errFd],
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
                releaseSessionSlot(reservation)
              }
            } catch {
              // the entry may not have landed yet — nothing else to do
            }
          })
          child.unref()
          // the launcher died between OS spawn and pid publication —
          // a live detached child the registry cannot yet name (spec
          // bro-l8c4f.5 failpoint)
          maybeAbandonSpawn('os-spawn')
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
          // died after publishing the handle — pid+marker are durable,
          // the worker's admission stamp never lands
          maybeAbandonSpawn('publication')
          // the admission stamp — durable only after pid+marker, so a
          // crash earlier can never admit a worker the registry cannot
          // reach. Existence is the signal; the pid inside is forensic.
          writePrivateFileSync(goFile, `${child.pid ?? -1}\n`)
        } catch (err) {
          // sync failure after the reservation — hand the slot back
          if (reservation !== undefined) {
            releaseSessionSlot(reservation)
          }
          throw err
        } finally {
          if (fd !== undefined) {
            closeSync(fd)
          }
          if (errFd !== undefined) {
            closeSync(errFd)
          }
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
      // a crashed launcher's survivor self-published its handle — adopt
      // it here too so `down` reaches the worker the registry never got
      // a pid for (spec bro-l8c4f.5)
      const adopted =
        typeof entry.pid === 'number'
          ? undefined
          : adoptNativeHandle(dir, agentsHome(dir), molStep, entry)
      const pid = typeof entry.pid === 'number' ? entry.pid : adopted?.pid
      const start =
        typeof entry.pid === 'number'
          ? entryPidStart(entry)
          : (adopted?.start ?? undefined)
      // The unit check lives outside the signal block: a repeated `down`
      // can find the wrapper already dead while a descendant still holds
      // the group — the lock guard below must see it even when no signal
      // was sent. `unit` stays empty without a live wrapper (the tree
      // link is already broken by then — the snapshot only works
      // pre-death).
      let unit: Array<{ pid: number; start?: string }> = []
      const unitAlive = () =>
        pid !== undefined &&
        (pidAlive(pid, start) ||
          groupMemberAlive(pid, start) ||
          unit.some((d) => pidAlive(d.pid, d.start)))
      if (pid !== undefined && pidAlive(pid, start)) {
        // the tree snapshot rides BEFORE the signal: a descendant that
        // escaped the group (setsid) is invisible to groupMemberAlive,
        // and once the wrapper dies it reparents to init — the
        // pre-signal pid+starttime pin is the only handle left on it
        unit = descendantsOf(pid)
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
        // agent (nativeState reports live pids as running regardless).
        // The unit, not the wrapper, is the wait: a TERM-resistant
        // descendant outlives the sh-wrapper it was spawned under, and
        // `stopped` over it would free a respawn onto a live writer
        // (bro-l8c4f.3)
        const deadline = Date.now() + 2_000
        while (unitAlive() && Date.now() < deadline) {
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
          unitAlive()
        ) {
          return // respawned, or the unit (wrapper/descendant) lives — the live run owns the entry
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
