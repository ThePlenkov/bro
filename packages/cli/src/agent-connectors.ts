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
import { spawn } from 'node:child_process'
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
import { dirname, join } from 'node:path'
import {
  AgentNotFound,
  agentsSection,
  bdActor,
  claimStep,
  gitTry,
  loadConfig,
  mintAgentId,
  patchAgentRegistry,
  probeStep,
  rebindStep,
  SpawnError,
  readAgentRegistry,
  withAgentRegistryLock,
  type AgentConnector,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
  type ConnectorCtx,
  type SpawnSpec,
} from '@broject/core'
import { expandAgentCmd, loopSection, type LoopConfig } from '@broject/loop'
import { makeGascityConnector } from './agent-connectors-gascity.ts'

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
 *  are skipped — a plugin cannot shadow a built-in backend. */
export function registerAgentConnector(name: string, make: AgentConnectorFactory): void {
  if (agentRegistry.some((x) => x.name === name)) {
    console.error(`warning: agent connector "${name}" already registered — skipped`)
    return
  }
  agentRegistry.push({ name, make })
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
    return hit.make(ctx, env)
  }
  const url = gitTry(['-C', ctx.dir, 'remote', 'get-url', 'origin'])
  const remote = url.code === 0 ? url.out.trim() : ''
  // matchers run on a probe instance — construction must be side-effect free
  if (remote !== '') {
    for (const c of agentRegistry) {
      const probe = c.make(ctx, env)
      if (probe.matchRemote?.(remote)) {
        return probe
      }
    }
  }
  for (const c of agentRegistry) {
    const probe = c.make(ctx, env)
    if (probe.matchDir?.(ctx.dir)) {
      return probe
    }
  }
  const first = agentRegistry[0]
  if (!first) {
    throw new Error('no agent connector registered')
  }
  return first.make(ctx, env)
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

/** `<common>/bro/hooks/agent-<id>.work` — hooks markers are
 *  `<common>/bro/hooks/<session>.<aspect>`; the agent gets a synthetic
 *  session name so `otherLiveWork` (session-start parallel detection)
 *  reports it as live work on the molStep. Null outside a common dir. */
function workMarkerPath(dir: string, agentId: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'hooks', `agent-${agentId}.work`)
}

function writeWorkMarker(dir: string, agentId: string, molStep: string): void {
  try {
    const marker = workMarkerPath(dir, agentId)
    if (marker === null) {
      return
    }
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, `${Date.now()}\n${molStep}\n`)
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

/** pid alive = kill(pid, 0) doesn't throw. EPERM means the process
 *  exists but isn't ours — still alive. pid <= 0 is never a live agent
 *  (kill(0) would signal OUR OWN process group — not a probe). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
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

/** Live state for a registry entry under this backend — also lazily
 *  harvests the .exit file into the entry so `agents.json` keeps
 *  pid+exit-status alongside the handle (and the harvest is once). */
function nativeState(dir: string, home: string | null, molStep: string, entry: AgentRegistryEntry): AgentState {
  // liveness first: a 'stopped' marker on a pid that is still alive means
  // SIGTERM hasn't landed yet — the agent IS still running, and dedup
  // must keep refusing a respawn that would run alongside it
  const pid = typeof entry.pid === 'number' ? entry.pid : undefined
  if (pid !== undefined && pidAlive(pid)) {
    touchWorkMarker(dir, entry.agentId)
    return 'running'
  }
  // every terminal state also retires the .work marker — a dead agent
  // must not keep reporting as live work to parallel-session detection
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

  const findEntry = (id: string): [string, AgentRegistryEntry] | undefined => {
    for (const [molStep, e] of Object.entries(readAgentRegistry(dir))) {
      if (e.backend === 'native' && e.agentId === id) {
        return [molStep, e]
      }
    }
    return undefined
  }

  return {
    name: 'native',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      if (command === '') {
        throw new SpawnError(
          'no agent command configured — set agents.native.command or loop.agent in bro.config.json'
        )
      }
      if (!existsSync(spec.repoRoot)) {
        throw new SpawnError(`worktree ${spec.repoRoot} does not exist`)
      }
      const home = agentsHome(dir)
      if (!home) {
        throw new SpawnError(`no git common dir for ${spec.repoRoot}`)
      }
      // dedup → claim → spawn → pid-patch runs as ONE critical section:
      // without the lock a second bro process can pass the liveness
      // check between our read and our write and double-spawn (TOCTOU).
      // Everything inside is synchronous — the bd subprocesses are
      // spawnSync — so the hold is milliseconds in the common case.
      return withAgentRegistryLock(dir, () => {
        // dedup correlates both planes: a claim alone is not a conflict —
        // a crashed worker's stale in_progress must not block respawn —
        // and a live agent alone is not spawnable-over either.
        const registry = readAgentRegistry(dir)
        const existing = registry[spec.molStep]
        const live =
          existing !== undefined &&
          nativeState(dir, home, spec.molStep, existing) === 'running'
        if (live) {
          throw new SpawnError(
            `${spec.molStep} already has a live agent (${existing!.agentId}, pid ${String(existing!.pid)})`
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
        // a dead entry doesn't entitle us to whatever claim sits on the
        // step now — if another actor picked it up meanwhile, rebinding
        // would steal a live worker's (or a human's) step. The actor is
        // resolved in the pinned store's context — the same context the
        // claim itself was written under.
        const actor = claimed ? bdActor(spec.beadsDir) : undefined
        if (claimed && step?.assignee !== actor) {
          throw new SpawnError(
            `${spec.molStep} is claimed by ${step?.assignee ?? '?'} — rebind only takes our own claim`
          )
        }
        // Registry entry FIRST: every later failure (claim refused, spawn
        // error) leaves a respawn-able 'lost' entry instead of a foreign
        // claim that can never be rebound.
        const agentId = existing?.agentId ?? mintAgentId('native')
        mkdirSync(home, { recursive: true })
        const promptFile = join(home, `${agentId}.prompt.md`)
        const log = join(home, `${agentId}.log`)
        const exitFile = join(home, `${agentId}.exit`)
        rmSync(exitFile, { force: true })
        writeFileSync(promptFile, spec.prompt)
        // exitStatus: undefined clears a respawned entry's stale harvest —
        // the new run must not read as already-exited (undefined keys
        // drop out of the serialized registry)
        patchAgentRegistry(dir, spec.molStep, {
          agentId,
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          worktree: spec.repoRoot,
          log,
          stopped: false,
          exitStatus: undefined,
          // a respawn must not keep the dead worker's pid/spawnError —
          // a claim failure before the pid patch would leave a stale
          // pid that could alias an unrelated process later
          pid: undefined,
          spawnError: undefined,
        })
        if (claimed) {
          rebindStep(spec.beadsDir, spec.molStep, actor!)
        } else {
          claimStep(spec.beadsDir, spec.molStep)
        }
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
          spawned = patchAgentRegistry(dir, spec.molStep, { pid: child.pid ?? -1 })
          writeWorkMarker(dir, agentId, spec.molStep)
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
      if (pid !== undefined && pidAlive(pid)) {
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
        while (pidAlive(pid) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      try {
        patchAgentRegistry(dir, molStep, { stopped: true })
      } catch {
        // the marker removal below still records intent
      }
      dropWorkMarker(dir, id)
    },

    capabilities: () => ({ attach: false, respawn: true, supervisor: 'none' }),
  }
}

registerAgentConnector('native', makeNativeConnector)
registerAgentConnector('gascity', makeGascityConnector)
