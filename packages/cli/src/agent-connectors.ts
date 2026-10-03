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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  AgentNotFound,
  agentsSection,
  bdActor,
  claimStep,
  gitTry,
  loadConfig,
  mintAgentId,
  patchAgentRegistry,
  pidAlive,
  probeStep,
  procStat,
  rebindStep,
  SpawnError,
  readAgentRegistry,
  withAgentRegistryLock,
  type AgentConnector,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
  type ConnectorCtx,
  type ListResult,
  type SpawnSpec,
} from '@broject/core'
import { expandAgentCmd, loopSection, type LoopConfig } from '@broject/loop'

/** Everything a factory needs: the repo ctx + the resolved config
 *  (agents.<backend> knobs, connectors.agents pick, loop.agent fallback). */
export interface AgentConnectorEnv {
  agents: Record<string, Record<string, unknown>>
  /** Facade → connector precedence — `connectors.agents` selects here. */
  connectors: Record<string, string>
  loop?: LoopConfig
}

export type AgentConnectorFactory = (
  ctx: ConnectorCtx,
  env: AgentConnectorEnv
) => AgentConnector

// --- registry ------------------------------------------------------------------

const agentRegistry: { name: string; make: AgentConnectorFactory }[] = []

/** External backends (gascity, tmux, …) register here. Duplicate names
 *  are skipped — a plugin cannot shadow a built-in backend. Returns a
 *  disposer bound to THIS registration (undefined when skipped): fixture
 *  cleanup removes the entry it added, never whatever holds the name. */
export function registerAgentConnector(
  name: string,
  make: AgentConnectorFactory
): (() => void) | undefined {
  if (agentRegistry.some((x) => x.name === name)) {
    console.error(`warning: agent connector "${name}" already registered — skipped`)
    return undefined
  }
  const entry = { name, make }
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
  }
  return { agents: cfg.agents ?? {}, connectors: cfg.connectors ?? {}, loop: cfg.loop }
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
  const matchers: ((conn: AgentConnector) => boolean | undefined)[] = [
    (conn) => conn.matchDir?.(ctx.dir),
  ]
  if (remote !== '') {
    matchers.unshift((conn) => conn.matchRemote?.(remote))
  }
  for (const match of matchers) {
    for (const c of agentRegistry) {
      let conn: AgentConnector | undefined
      try {
        conn = c.make(ctx, env)
      } catch (err) {
        probeFailures.set(c.name, err instanceof Error ? err.message : String(err))
        continue
      }
      if (match(conn) === true) {
        return conn
      }
    }
  }
  return undefined
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

function dropWorkMarker(dir: string, agentId: string): void {
  try {
    const marker = workMarkerPath(dir, agentId)
    if (marker !== null) {
      rmSync(marker, { force: true })
    }
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

/** The shared spawn prologue every built-in backend runs under the
 *  registry lock — dedup across the two state planes (registry liveness
 *  + beads claim), the claim/rebind, and the shared-dir artifacts
 *  (prompt/log/exit). Returns the paths the backend tail needs.
 *
 *  Dedup correlates both planes: a claim alone is not a conflict — a
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
  }
): { agentId: string; promptFile: string; log: string; exitFile: string } {
  const registry = readAgentRegistry(dir)
  const existing = registry[spec.molStep]
  // a registry entry belongs to the backend that wrote it — the respawn
  // contract (same agentId, same claim rebind) is per-runtime; one
  // backend must not adopt another's entry
  if (existing !== undefined && existing.backend !== backend) {
    throw new SpawnError(
      `${spec.molStep} is registered to backend "${existing.backend}" — respawn belongs to it`
    )
  }
  if (existing !== undefined && opts.isLive(existing)) {
    const detail = opts.liveDetail?.(existing) ?? `pid ${String(existing.pid)}`
    throw new SpawnError(
      `${spec.molStep} already has a live agent (${existing.agentId}, ${detail})`
    )
  }
  const step = probeStep(spec.beadsDir, spec.molStep)
  const claimed = step?.status === 'in_progress'
  if (claimed && existing === undefined) {
    // claimed with no registry entry — an interactive session or a
    // foreign backend owns it; spawning would double-claim
    throw new SpawnError(
      `${spec.molStep} is claimed outside the agent registry (assignee ${step?.assignee ?? '?'})`
    )
  }
  // a dead entry doesn't entitle us to whatever claim sits on the step
  // now — if another actor picked it up meanwhile, rebinding would steal
  // a live worker's (or a human's) step. The actor resolves in the
  // pinned store's context — the same context the claim was written under.
  const actor = claimed ? bdActor(spec.beadsDir) : undefined
  if (claimed && step?.assignee !== actor && step?.assignee !== opts.claimAs) {
    throw new SpawnError(
      `${spec.molStep} is claimed by ${step?.assignee ?? '?'} — rebind only takes our own claim`
    )
  }
  // a reused id must stay filename-safe — a tampered entry gets a fresh
  // mint, not a path escape into <home>/
  const agentId =
    existing !== undefined && SAFE_AGENT_ID.test(existing.agentId)
      ? existing.agentId
      : mintAgentId(backend)
  mkdirSync(home, { recursive: true })
  const promptFile = join(home, `${agentId}.prompt.md`)
  const log = join(home, `${agentId}.log`)
  const exitFile = join(home, `${agentId}.exit`)
  rmSync(exitFile, { force: true })
  writeFileSync(promptFile, spec.prompt)
  // exitStatus: undefined clears a respawned entry's stale harvest — the
  // new run must not read as already-exited (undefined keys drop out of
  // the serialized registry). pid/spawnError likewise — a claim failure
  // before the backend patches its handle would leave a stale value that
  // could alias an unrelated process/session later
  patchAgentRegistry(dir, spec.molStep, {
    agentId,
    backend,
    spawnedAt: new Date().toISOString(),
    worktree: spec.repoRoot,
    log,
    stopped: false,
    exitStatus: undefined,
    pid: undefined,
    spawnError: undefined,
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
  return { agentId, promptFile, log, exitFile }
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

/** The recorded-death ladder both backends walk once liveness fails —
 *  stopped flag → harvested exitStatus → the .exit file (lazily
 *  harvested into the registry so `agents.json` keeps pid+exit-status
 *  alongside the handle, and the harvest is once). Terminal states
 *  also retire the .work marker: a dead agent must not keep reporting
 *  as live work to parallel-session detection. Returns undefined when
 *  nothing recorded a death — the caller decides what unproven means
 *  ('lost' for a confirmed-dead backend, 'spawned' for a failed probe). */
function recordedDeath(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry
): AgentState | undefined {
  if (entry.stopped === true) {
    dropWorkMarker(dir, entry.agentId)
    return 'stopped'
  }
  if (entry.exitStatus !== undefined) {
    dropWorkMarker(dir, entry.agentId)
    return 'exited'
  }
  if (home) {
    const code = readExitFile(home, entry.agentId)
    if (code !== undefined) {
      try {
        patchAgentRegistry(dir, molStep, { exitStatus: code })
      } catch {
        // harvest is advisory — the .exit file still proves the exit
      }
      dropWorkMarker(dir, entry.agentId)
      return 'exited'
    }
  }
  return undefined
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
  if (command === '') {
    throw new SpawnError(
      `no agent command configured — set agents.${backend}.command or loop.agent in bro.config.json`,
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
  dropWorkMarker(dir, entry.agentId)
  return 'lost'
}

function toInfo(dir: string, home: string | null, molStep: string, entry: AgentRegistryEntry): AgentInfo {
  return {
    id: entry.agentId,
    pid: typeof entry.pid === 'number' ? entry.pid : undefined,
    molStep,
    backend: entry.backend,
    state: nativeState(dir, home, molStep, entry),
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
      return withAgentRegistryLock(dir, () => {
        const { agentId, promptFile, log, exitFile } = prepareSpawn(dir, home, 'native', spec, {
          isLive: (e) => nativeState(dir, home, spec.molStep, e) === 'running',
        })
        const fd = openSync(log, 'a')
        let spawned: AgentRegistryEntry
        try {
          // the wrapper captures $? into the .exit file — the only exit
          // record a detached process can leave once the parent is gone
          const child = spawn(
            'sh', // NOSONAR — PATH lookup is the contract (same as git/bd everywhere)
            ['-c', `${expandAgentCmd(command, promptFile)}; s=$?; printf %s "$s" > "$1"`, 'bro-agent', exitFile],
            { // NOSONAR — operator-configured agent command (same contract as loop)
              cwd: spec.repoRoot,
              env: {
                ...process.env,
                ...spec.env,
                // identity pins last — spec.env must never redirect the
                // claim store or re-badge the worker as another bead/agent
                BEADS_DIR: spec.beadsDir,
                BRO_BEAD_ID: spec.molStep,
                BRO_AGENT_ID: agentId,
                BRO_PROMPT_FILE: promptFile,
              },
              stdio: ['ignore', fd, fd],
              detached: true,
            }
          )
          // an unhandled 'error' event would take the whole CLI down —
          // a failed exec records itself on the entry and reads 'lost'
          child.on('error', (err) => {
            try {
              patchAgentRegistry(dir, spec.molStep, { spawnError: err.message })
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
        dropWorkMarker(dir, id)
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
  dropWorkMarker(dir, entry.agentId)
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
    pid: typeof entry.pid === 'number' ? entry.pid : undefined,
    molStep,
    backend: entry.backend,
    state: tmuxState(dir, home, molStep, entry, probe),
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
      // pid-patch under the registry lock, all synchronous shell-outs
      return withAgentRegistryLock(dir, () => {
        // the session name derives from the agentId prepareSpawn
        // resolves — entry callback, not a precomputed name, because a
        // tampered entry's unsafe id is reminted inside
        const { agentId, promptFile, log, exitFile } = prepareSpawn(dir, home, 'tmux', spec, {
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
        })
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
        const PIN_KEYS = ['BEADS_DIR', 'BRO_BEAD_ID', 'BRO_AGENT_ID', 'BRO_PROMPT_FILE']
        const ambient = Object.entries({ ...process.env, ...spec.env })
          .filter(
            (e): e is [string, string] =>
              e[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e[0]) && !PIN_KEYS.includes(e[0])
          )
          .map(([k, v]) => `export ${k}=${shQuote(v)}`)
          .join('\n')
        writeFileSync(envFile, `${ambient}\n`, { mode: 0o600 })
        const envArgs = Object.entries({
          BEADS_DIR: spec.beadsDir,
          BRO_BEAD_ID: spec.molStep,
          BRO_AGENT_ID: agentId,
          BRO_PROMPT_FILE: promptFile,
        }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
        // the pane sources the ambient env and drops the file, then runs
        // the agent; $? lands in the .exit file before the pipeline
        // drains, tee keeps a log the way native's fd redirect does.
        // Session dies with the pane → has-session IS liveness. tmux
        // runs the command through the user's default-shell — a
        // non-POSIX one (fish) would eat the braces, so sh -c pins the
        // dialect the same way native's spawn does
        const paneScript = `. ${shQuote(envFile)}; rm -f ${shQuote(envFile)}; { ${expandAgentCmd(command, promptFile)}; s=$?; printf %s "$s" > ${shQuote(exitFile)}; } 2>&1 | tee -a ${shQuote(log)}`
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
          try {
            patchAgentRegistry(dir, spec.molStep, { spawnError: res.err })
          } catch {
            // the entry landed already — the SpawnError still reports
          }
          throw new SpawnError(`tmux new-session failed — ${res.err}`, 'unavailable')
        }
        // pane pid — a display handle like native's child pid, not the
        // liveness signal (has-session is)
        const pp = tmuxRun(socket, ['list-panes', '-t', session, '-F', '#{pane_pid}'])
        const panePid = pp.code === 0 ? Number(pp.out.trim().split('\n')[0]) : Number.NaN
        const spawned = patchAgentRegistry(
          dir,
          spec.molStep,
          Number.isInteger(panePid) && panePid > 0 ? { pid: panePid } : {}
        )
        writeWorkMarker(
          dir,
          agentId,
          spec.molStep,
          Number.isInteger(panePid) && panePid > 0 ? panePid : undefined
        )
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
        dropWorkMarker(dir, id)
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

/** Caller-provided env keys that would hijack worker identity —
 *  filtered from the agent.toml env table; the connector injects its
 *  own values instead (gcEnvPins). */
const GC_PINNED_ENV = new Set(['BEADS_DIR', 'BRO_BEAD_ID', 'BRO_AGENT_ID', 'BRO_PROMPT_FILE'])

/** Identity pins the connector owns — the env table always carries the
 *  shared store + the real bead id regardless of what spec.env says. */
const gcEnvPins = (spec: SpawnSpec): [string, string][] => [
  ['BEADS_DIR', spec.beadsDir],
  ['BRO_BEAD_ID', spec.molStep],
]

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

/** Provider label for city.toml — the command's first token, sanitized;
 *  'agent' when nothing usable resolves. */
function gcProviderName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split('/').pop() ?? ''
  return /^[a-zA-Z][\w-]*$/.test(base) ? base : 'agent'
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

  /** City root — explicit `agents.gascity.configDir`, else the shared
   *  `<git-common-dir>/bro/gascity` (out of every worktree). */
  const configDir = (): string | null => {
    const k = knobs.configDir
    if (typeof k === 'string' && k.trim() !== '') {
      return isAbsolute(k) ? k : resolve(dir, k)
    }
    const home = agentsHome(dir)
    return home === null ? null : dirname(home) + '/gascity'
  }

  const findEntry = (id: string) => findAgentEntry(dir, 'gascity', id)

  /** Author city.toml + the worker template once, then `gc init --file
   *  … --no-start` — files-only bootstrap, no supervisor side effects. */
  const initCity = (city: string): void => {
    mkdirSync(city, { recursive: true })
    const toml = join(city, 'city.toml')
    if (existsSync(toml)) {
      return
    }
    writeFileSync(toml, GC_CITY_TOML(gcProviderName(command), command))
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
  const writeStepAgent = (spec: SpawnSpec, city: string): void => {
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
      ([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !GC_PINNED_ENV.has(k)
    )
    // caller env plus the connector-owned identity pins — pins always
    // render so the table exists even when spec.env is empty
    const allEnv = [...envEntries, ...gcEnvPins(spec)]
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
      molStep,
      backend: entry.backend,
      state: sessions === undefined || s === undefined ? missing : gcState(s),
      worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
      log: typeof entry.log === 'string' ? entry.log : undefined,
    }
  }

  /** Bring the city up and return the session id — `session reset` a
   *  surviving session in place (preserves alias+bead), else `session
   *  new` the per-step agent. A `session new` whose id can't be learned
   *  is closed by alias first so no orphan runs beside the retry. */
  const ensureGcSession = (spec: SpawnSpec, city: string, prior: unknown): string => {
    initCity(city)
    writeStepAgent(spec, city)
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

    // gascity claims a configDir layout — an authored city.toml at the
    // resolved configDir is the marker (spec: agents.gascity.configDir).
    matchDir: () => {
      const city = configDir()
      return city !== null && existsSync(join(city, 'city.toml'))
    },

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
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
      // spawn → registry patch, all under the agents.json lock.
      return withAgentRegistryLock(dir, () => {
        const existing = readAgentRegistry(dir)[spec.molStep]
        const { agentId } = prepareSpawn(dir, home, 'gascity', spec, {
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
        })
        let sessionId: string | undefined
        try {
          sessionId = ensureGcSession(spec, city, existing?.sessionId)
          dispatchStep(spec, city)
        } catch (err) {
          // leave the entry respawn-able: close the orphan session so a
          // retry can't run alongside a zombie, then record the failure.
          if (sessionId !== undefined) {
            gcRun(['session', 'close', sessionId, '--city', city])
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
registerAgentConnector('gascity', makeGascityConnector)
